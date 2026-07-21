use std::{
    collections::HashSet,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    sync::Semaphore,
    time::timeout,
};

use crate::{
    contains_disallowed_control_chars,
    path_policy::{PathKind, PathPolicy},
    resource_limits::GIT_COMMAND_MAX_OUTPUT_BYTES,
    BridgeError, TerminalExecRequest, TerminalExecResponse,
};

const DEFAULT_TERMINAL_MAX_CONCURRENT: usize = 4;
const DEFAULT_TERMINAL_MAX_OUTPUT_BYTES: usize = 256 * 1024;
const OUTPUT_READ_CHUNK_SIZE: usize = 8 * 1024;
const TRUSTED_GITHUB_CREDENTIALS_PATH: &str = ".clawdex/github-credentials";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum TerminalExecPolicy {
    Pwd,
    List,
    Read,
}

impl TerminalExecPolicy {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "pwd" => Some(Self::Pwd),
            "ls" => Some(Self::List),
            "cat" => Some(Self::Read),
            _ => None,
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::Pwd => "pwd",
            Self::List => "ls",
            Self::Read => "cat",
        }
    }
}

fn hardened_git_args(args: &[String]) -> Vec<String> {
    hardened_git_args_with_helper(args, trusted_credential_helper())
}

fn hardened_git_args_with_helper(args: &[String], helper: Option<String>) -> Vec<String> {
    let mut hardened_args = vec![
        "--no-pager".to_string(),
        "-c".to_string(),
        "core.hooksPath=/dev/null".to_string(),
        "-c".to_string(),
        "core.fsmonitor=false".to_string(),
        "-c".to_string(),
        "commit.gpgSign=false".to_string(),
        "-c".to_string(),
        "diff.external=".to_string(),
        "-c".to_string(),
        "http.sslVerify=true".to_string(),
        "-c".to_string(),
        "http.proxy=".to_string(),
        "-c".to_string(),
        "https.proxy=".to_string(),
        "-c".to_string(),
        "core.gitProxy=".to_string(),
        "-c".to_string(),
        "protocol.allow=never".to_string(),
        "-c".to_string(),
        "protocol.https.allow=always".to_string(),
        "-c".to_string(),
        "protocol.ext.allow=never".to_string(),
        "-c".to_string(),
        "protocol.file.allow=never".to_string(),
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        "credential.useHttpPath=true".to_string(),
    ];
    if let Some(helper) = helper {
        hardened_args.push("-c".to_string());
        hardened_args.push(format!("credential.helper={helper}"));
    }
    hardened_args.extend_from_slice(args);
    hardened_args
}

#[derive(Clone)]
pub(crate) struct TerminalService {
    path_policy: Arc<PathPolicy>,
    policies: HashSet<TerminalExecPolicy>,
    concurrency_limiter: Arc<Semaphore>,
    running: Arc<AtomicU64>,
    waiting: Arc<AtomicU64>,
    saturated: Arc<AtomicU64>,
    timed_out: Arc<AtomicU64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalStatus {
    pub(crate) max_concurrent: usize,
    pub(crate) running: u64,
    pub(crate) waiting: u64,
    pub(crate) saturation_count: u64,
    pub(crate) timed_out: u64,
}

struct BinaryExecutionOptions {
    timeout_ms: Option<u64>,
    max_output_bytes: usize,
    preserve_git_config: bool,
}

impl TerminalService {
    pub(crate) fn new(path_policy: Arc<PathPolicy>, policies: HashSet<TerminalExecPolicy>) -> Self {
        Self {
            path_policy,
            policies,
            concurrency_limiter: Arc::new(Semaphore::new(DEFAULT_TERMINAL_MAX_CONCURRENT)),
            running: Arc::new(AtomicU64::new(0)),
            waiting: Arc::new(AtomicU64::new(0)),
            saturated: Arc::new(AtomicU64::new(0)),
            timed_out: Arc::new(AtomicU64::new(0)),
        }
    }

    pub(crate) async fn execute_shell(
        &self,
        request: TerminalExecRequest,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let command = request.command.trim();
        if command.is_empty() {
            return Err(BridgeError::invalid_params("command must not be empty"));
        }

        if contains_disallowed_control_chars(command) {
            return Err(BridgeError::invalid_params(
                "command contains disallowed control characters",
            ));
        }

        let tokens = shlex::split(command)
            .ok_or_else(|| BridgeError::invalid_params("invalid command quoting"))?;
        if tokens.is_empty() {
            return Err(BridgeError::invalid_params("command must not be empty"));
        }

        let binary = tokens[0].clone();
        if binary == "git" {
            return Err(BridgeError::forbidden(
                "generic_git_forbidden",
                "Git is only available through bridge/git RPC methods.",
            ));
        }
        if self.policies.is_empty() {
            return Err(BridgeError::forbidden(
                "terminal_exec_disabled",
                "Terminal execution has no enabled policies on this bridge.",
            ));
        }

        let cwd = self.path_policy.resolve_cwd(request.cwd.as_deref())?;
        let policy = self
            .policies
            .iter()
            .copied()
            .find(|policy| policy.binary() == binary)
            .ok_or_else(|| {
                let mut allowed = self
                    .policies
                    .iter()
                    .map(|policy| policy.binary())
                    .collect::<Vec<_>>();
                allowed.sort_unstable();
                BridgeError::forbidden(
                    "terminal_policy_denied",
                    &format!(
                        "Command \"{binary}\" has no enabled execution policy. Enabled policies: {}",
                        allowed.join(", ")
                    ),
                )
            })?;
        let args = self.validate_policy_args(policy, &tokens[1..], &cwd)?;

        self.execute_binary_internal(
            binary.as_str(),
            &args,
            command.to_string(),
            cwd,
            BinaryExecutionOptions {
                timeout_ms: request.timeout_ms,
                max_output_bytes: DEFAULT_TERMINAL_MAX_OUTPUT_BYTES,
                preserve_git_config: false,
            },
        )
        .await
    }

    pub(crate) async fn execute_git(
        &self,
        args: &[String],
        cwd: PathBuf,
        timeout_ms: Option<u64>,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let cwd = self
            .path_policy
            .resolve_existing(cwd.to_string_lossy().as_ref(), PathKind::Directory)?;

        let display = std::iter::once("git".to_string())
            .chain(args.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ");

        let hardened_args = hardened_git_args(args);

        self.execute_binary_internal(
            "git",
            &hardened_args,
            display,
            cwd,
            BinaryExecutionOptions {
                timeout_ms,
                max_output_bytes: GIT_COMMAND_MAX_OUTPUT_BYTES,
                preserve_git_config: false,
            },
        )
        .await
    }

    pub(crate) async fn inspect_git_config(
        &self,
        args: &[String],
        cwd: PathBuf,
        preserve_standard_config: bool,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let cwd = self
            .path_policy
            .resolve_existing(cwd.to_string_lossy().as_ref(), PathKind::Directory)?;
        let hardened_args = hardened_git_args(args);

        self.execute_binary_internal(
            "git",
            &hardened_args,
            "git config inspection".to_string(),
            cwd,
            BinaryExecutionOptions {
                timeout_ms: None,
                max_output_bytes: GIT_COMMAND_MAX_OUTPUT_BYTES,
                preserve_git_config: preserve_standard_config,
            },
        )
        .await
    }

    fn validate_policy_args(
        &self,
        policy: TerminalExecPolicy,
        args: &[String],
        cwd: &std::path::Path,
    ) -> Result<Vec<String>, BridgeError> {
        match policy {
            TerminalExecPolicy::Pwd => {
                if !args.is_empty() {
                    return Err(BridgeError::invalid_params("pwd does not accept arguments"));
                }
                Ok(Vec::new())
            }
            TerminalExecPolicy::List => {
                let mut options = Vec::new();
                let mut paths = Vec::new();
                let mut options_ended = false;
                for arg in args {
                    if !options_ended && arg == "--" {
                        options_ended = true;
                    } else if !options_ended && arg.starts_with('-') {
                        if arg.len() == 1
                            || !arg[1..]
                                .chars()
                                .all(|value| matches!(value, 'a' | 'A' | 'l' | 'h' | '1'))
                        {
                            return Err(BridgeError::invalid_params(
                                "ls only permits the short options -a, -A, -l, -h, and -1",
                            ));
                        }
                        options.push(arg.clone());
                    } else {
                        paths.push(
                            self.path_policy
                                .resolve_existing_from(cwd, arg, PathKind::Any)?
                                .to_string_lossy()
                                .to_string(),
                        );
                    }
                }
                if !paths.is_empty() {
                    options.push("--".to_string());
                    options.extend(paths);
                }
                Ok(options)
            }
            TerminalExecPolicy::Read => {
                let options_ended = args.first().map(String::as_str) == Some("--");
                let args = if options_ended { &args[1..] } else { args };
                if args.is_empty() {
                    return Err(BridgeError::invalid_params(
                        "cat requires one or more file paths",
                    ));
                }
                let mut validated = vec!["--".to_string()];
                for arg in args {
                    if !options_ended && arg.starts_with('-') {
                        return Err(BridgeError::invalid_params(
                            "cat options are not permitted; use -- before paths beginning with a dash",
                        ));
                    }
                    validated.push(
                        self.path_policy
                            .resolve_existing_from(cwd, arg, PathKind::File)?
                            .to_string_lossy()
                            .to_string(),
                    );
                }
                Ok(validated)
            }
        }
    }

    async fn execute_binary_internal(
        &self,
        binary: &str,
        args: &[String],
        display_command: String,
        cwd: PathBuf,
        options: BinaryExecutionOptions,
    ) -> Result<TerminalExecResponse, BridgeError> {
        if self.concurrency_limiter.available_permits() == 0 {
            self.saturated.fetch_add(1, Ordering::Relaxed);
        }
        self.waiting.fetch_add(1, Ordering::Relaxed);
        let waiting = TerminalWaitingGuard {
            waiting: self.waiting.clone(),
        };
        let permit = self
            .concurrency_limiter
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| BridgeError::server("terminal concurrency limiter is closed"))?;
        drop(waiting);
        self.running.fetch_add(1, Ordering::Relaxed);
        let _activity = TerminalActivityGuard {
            running: self.running.clone(),
            _permit: permit,
        };
        let timeout_ms = options.timeout_ms.unwrap_or(30_000).clamp(100, 120_000);
        let started_at = Instant::now();

        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(&cwd)
            .env_clear()
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !options.preserve_git_config {
            command
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null");
        }
        #[cfg(unix)]
        command.process_group(0);
        for name in ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SystemRoot"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command
            .spawn()
            .map_err(|error| BridgeError::server(&format!("failed to spawn command: {error}")))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| BridgeError::server("failed to capture stderr"))?;

        let max_output_bytes = options.max_output_bytes;
        let stdout_task =
            tokio::spawn(async move { read_stream_limited(stdout, max_output_bytes).await });

        let max_output_bytes = options.max_output_bytes;
        let stderr_task =
            tokio::spawn(async move { read_stream_limited(stderr, max_output_bytes).await });

        let mut timed_out = false;
        let mut exit_code = None;
        let mut wait_error: Option<String> = None;

        match timeout(Duration::from_millis(timeout_ms), child.wait()).await {
            Ok(Ok(status)) => {
                exit_code = status.code();
            }
            Ok(Err(error)) => {
                wait_error = Some(error.to_string());
                exit_code = Some(-1);
            }
            Err(_) => {
                timed_out = true;
                self.timed_out.fetch_add(1, Ordering::Relaxed);
                #[cfg(unix)]
                if let Some(pid) = child.id() {
                    let pid = pid as i32;
                    // Only signal the group after verifying it is the isolated child group.
                    if unsafe { libc::getpgid(pid) } == pid {
                        unsafe {
                            libc::kill(-pid, libc::SIGKILL);
                        }
                    }
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let (stdout_bytes, stdout_truncated) = stdout_task.await.unwrap_or_default();
        let (stderr_bytes, stderr_truncated) = stderr_task.await.unwrap_or_default();

        let stdout_text = finalize_output(stdout_bytes, stdout_truncated);
        let mut stderr_text = finalize_output(stderr_bytes, stderr_truncated);
        append_wait_error(&mut stderr_text, wait_error.as_deref());

        Ok(TerminalExecResponse {
            command: display_command,
            cwd: cwd.to_string_lossy().to_string(),
            code: exit_code,
            stdout: stdout_text,
            stderr: stderr_text,
            timed_out,
            duration_ms: started_at.elapsed().as_millis() as u64,
        })
    }

    pub(crate) fn status(&self) -> TerminalStatus {
        TerminalStatus {
            max_concurrent: DEFAULT_TERMINAL_MAX_CONCURRENT,
            running: self.running.load(Ordering::Relaxed),
            waiting: self.waiting.load(Ordering::Relaxed),
            saturation_count: self.saturated.load(Ordering::Relaxed),
            timed_out: self.timed_out.load(Ordering::Relaxed),
        }
    }
}

fn append_wait_error(stderr: &mut String, wait_error: Option<&str>) {
    if let Some(wait_error) = wait_error {
        if !stderr.is_empty() {
            stderr.push('\n');
        }
        stderr.push_str(wait_error);
    }
}

struct TerminalWaitingGuard {
    waiting: Arc<AtomicU64>,
}

impl Drop for TerminalWaitingGuard {
    fn drop(&mut self) {
        self.waiting.fetch_sub(1, Ordering::Relaxed);
    }
}

struct TerminalActivityGuard {
    running: Arc<AtomicU64>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for TerminalActivityGuard {
    fn drop(&mut self) {
        self.running.fetch_sub(1, Ordering::Relaxed);
    }
}

fn trusted_credential_helper() -> Option<String> {
    trusted_credential_helper_from_home(std::env::var_os("HOME").map(PathBuf::from))
}

fn trusted_credential_helper_from_home(home: Option<PathBuf>) -> Option<String> {
    let path = home?.join(TRUSTED_GITHUB_CREDENTIALS_PATH);
    if !path.is_file() {
        return None;
    }
    let escaped = path.to_string_lossy().replace('\'', "'\\''");
    Some(format!("store --file='{escaped}'"))
}

async fn read_stream_limited<R>(mut reader: R, max_bytes: usize) -> (Vec<u8>, bool)
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; OUTPUT_READ_CHUNK_SIZE];
    let mut truncated = false;

    loop {
        let read = match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => read,
            Err(_) => break,
        };

        if bytes.len() < max_bytes {
            let remaining = max_bytes - bytes.len();
            let to_take = remaining.min(read);
            bytes.extend_from_slice(&buffer[..to_take]);
            if to_take < read {
                truncated = true;
            }
        } else {
            truncated = true;
        }
    }

    (bytes, truncated)
}

fn finalize_output(bytes: Vec<u8>, truncated: bool) -> String {
    let mut output = String::from_utf8_lossy(&bytes).trim_end().to_string();
    if truncated {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str("[output truncated]");
    }
    output
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::{
        append_wait_error, finalize_output, hardened_git_args, hardened_git_args_with_helper,
        read_stream_limited, trusted_credential_helper_from_home, BinaryExecutionOptions,
        TerminalExecPolicy, TerminalService, DEFAULT_TERMINAL_MAX_CONCURRENT,
    };
    use crate::{path_policy::PathPolicy, TerminalExecRequest};
    use std::{
        collections::HashSet,
        fs,
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };
    use uuid::Uuid;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("clawdex-terminal-{}", Uuid::new_v4()));
            fs::create_dir(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn service(root: &Path, policies: &[TerminalExecPolicy]) -> TerminalService {
        let policy = Arc::new(PathPolicy::new(root.to_path_buf(), false).expect("create policy"));
        TerminalService::new(policy, policies.iter().copied().collect())
    }

    fn request(command: &str) -> TerminalExecRequest {
        TerminalExecRequest {
            command: command.to_string(),
            cwd: None,
            timeout_ms: None,
        }
    }

    async fn wait_for_status(service: &TerminalService, running: u64, waiting: u64) {
        for _ in 0..200 {
            let status = service.status();
            if status.running == running && status.waiting == waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let status = service.status();
        panic!(
            "terminal status did not reach running={running}, waiting={waiting}: running={}, waiting={}",
            status.running, status.waiting
        );
    }

    #[test]
    fn terminal_policy_names_are_explicit() {
        assert_eq!(
            TerminalExecPolicy::parse("pwd"),
            Some(TerminalExecPolicy::Pwd)
        );
        assert_eq!(
            TerminalExecPolicy::parse("ls"),
            Some(TerminalExecPolicy::List)
        );
        assert_eq!(
            TerminalExecPolicy::parse("cat"),
            Some(TerminalExecPolicy::Read)
        );
        assert_eq!(TerminalExecPolicy::parse("PWD"), None);
    }

    #[tokio::test]
    async fn shell_rejects_malformed_and_denied_commands() {
        let temp = TestDir::new();
        let service = service(
            &temp.0,
            &[TerminalExecPolicy::Pwd, TerminalExecPolicy::Read],
        );

        for (command, expected) in [
            ("   ", "command must not be empty"),
            ("pwd; cat safe.txt", "disallowed control characters"),
            ("cat 'unterminated", "invalid command quoting"),
            ("ls", "Enabled policies: cat, pwd"),
            ("pwd extra", "pwd does not accept arguments"),
        ] {
            let error = service
                .execute_shell(request(command))
                .await
                .expect_err("reject command");
            assert!(
                error.message.contains(expected),
                "{command}: {}",
                error.message
            );
        }
    }

    #[tokio::test]
    async fn pwd_policy_executes_in_resolved_cwd() {
        let temp = TestDir::new();
        let nested = temp.0.join("nested");
        fs::create_dir(&nested).expect("create nested directory");
        let service = service(&temp.0, &[TerminalExecPolicy::Pwd]);
        let response = service
            .execute_shell(TerminalExecRequest {
                command: "  pwd  ".to_string(),
                cwd: Some("nested".to_string()),
                timeout_ms: Some(1),
            })
            .await
            .expect("execute pwd");

        let canonical = fs::canonicalize(nested).expect("canonical nested directory");
        assert_eq!(response.command, "pwd");
        assert_eq!(response.cwd, canonical.to_string_lossy());
        assert_eq!(response.stdout, canonical.to_string_lossy());
        assert_eq!(response.code, Some(0));
        assert!(!response.timed_out);
        assert_eq!(service.status().running, 0);
    }

    #[tokio::test]
    async fn list_policy_accepts_safe_options_and_paths() {
        let temp = TestDir::new();
        fs::write(temp.0.join("-dash"), "dash").expect("write dash file");
        fs::write(temp.0.join("ordinary"), "ordinary").expect("write ordinary file");
        let service = service(&temp.0, &[TerminalExecPolicy::List]);

        for command in ["ls -", "ls -z"] {
            assert!(service.execute_shell(request(command)).await.is_err());
        }
        assert!(service.execute_shell(request("ls missing")).await.is_err());

        let options_only = service
            .execute_shell(request("ls -aAlh1"))
            .await
            .expect("list with options");
        assert_eq!(options_only.code, Some(0));
        assert!(options_only.stdout.contains("ordinary"));

        let dash_path = service
            .execute_shell(request("ls -1 -- -dash"))
            .await
            .expect("list dash path");
        assert_eq!(
            dash_path.stdout,
            fs::canonicalize(temp.0.join("-dash"))
                .unwrap()
                .to_string_lossy()
        );
    }

    #[tokio::test]
    async fn read_policy_requires_scoped_files_and_reads_multiple_paths() {
        let temp = TestDir::new();
        fs::write(temp.0.join("one.txt"), "one\n").expect("write first file");
        fs::write(temp.0.join("-two.txt"), "two\n").expect("write dash file");
        fs::create_dir(temp.0.join("directory")).expect("create directory");
        let outside = TestDir::new();
        fs::write(outside.0.join("outside.txt"), "outside").expect("write outside file");
        let service = service(&temp.0, &[TerminalExecPolicy::Read]);

        for command in ["cat", "cat --", "cat -two.txt", "cat directory"] {
            assert!(
                service.execute_shell(request(command)).await.is_err(),
                "{command}"
            );
        }
        assert!(service
            .execute_shell(request(&format!(
                "cat {}",
                outside.0.join("outside.txt").to_string_lossy()
            )))
            .await
            .is_err());

        let response = service
            .execute_shell(request("cat one.txt -- -two.txt"))
            .await
            .expect_err("a later -- is a path, not an option terminator");
        assert!(response.message.contains("cat options are not permitted"));

        let response = service
            .execute_shell(request("cat -- one.txt -two.txt"))
            .await
            .expect("read files");
        assert_eq!(response.stdout, "one\ntwo");
        assert_eq!(response.stderr, "");
        assert_eq!(response.code, Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn binary_runner_reports_success_failure_and_spawn_errors() {
        let temp = TestDir::new();
        let service = service(&temp.0, &[]);
        let args = [
            "-c".to_string(),
            "printf 'out\\n'; printf 'err\\n' >&2; exit 7".to_string(),
        ];
        let response = service
            .execute_binary_internal(
                "/bin/sh",
                &args,
                "fixture command".to_string(),
                temp.0.clone(),
                BinaryExecutionOptions {
                    timeout_ms: None,
                    max_output_bytes: 1024,
                    preserve_git_config: false,
                },
            )
            .await
            .expect("execute shell fixture");
        assert_eq!(response.command, "fixture command");
        assert_eq!(response.code, Some(7));
        assert_eq!(response.stdout, "out");
        assert_eq!(response.stderr, "err");

        let error = service
            .execute_binary_internal(
                temp.0.join("missing-command").to_string_lossy().as_ref(),
                &[],
                "missing".to_string(),
                temp.0.clone(),
                BinaryExecutionOptions {
                    timeout_ms: None,
                    max_output_bytes: 1024,
                    preserve_git_config: false,
                },
            )
            .await
            .expect_err("report spawn error");
        assert!(error.message.contains("failed to spawn command"));
        assert_eq!(service.status().running, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn binary_runner_truncates_stdout_and_stderr_independently() {
        let temp = TestDir::new();
        let service = service(&temp.0, &[]);
        let response = service
            .execute_binary_internal(
                "/bin/sh",
                &[
                    "-c".to_string(),
                    "printf 123456789; printf abcdefghi >&2".to_string(),
                ],
                "large output".to_string(),
                temp.0.clone(),
                BinaryExecutionOptions {
                    timeout_ms: None,
                    max_output_bytes: 5,
                    preserve_git_config: false,
                },
            )
            .await
            .expect("execute output fixture");

        assert_eq!(response.stdout, "12345\n[output truncated]");
        assert_eq!(response.stderr, "abcde\n[output truncated]");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_command_process_group_and_updates_status() {
        let temp = TestDir::new();
        let service = service(&temp.0, &[]);
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            service.execute_binary_internal(
                "/bin/sh",
                &["-c".to_string(), "sleep 10 & wait".to_string()],
                "slow command".to_string(),
                temp.0.clone(),
                BinaryExecutionOptions {
                    timeout_ms: Some(100),
                    max_output_bytes: 1024,
                    preserve_git_config: false,
                },
            ),
        )
        .await
        .expect("timeout cleanup must not wait for descendants")
        .expect("execute timeout fixture");

        assert!(result.timed_out);
        assert_eq!(result.code, None);
        assert_eq!(service.status().timed_out, 1);
        assert_eq!(service.status().running, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn concurrency_status_tracks_saturation_and_cancelled_waiters() {
        let temp = TestDir::new();
        let hold = temp.0.join("hold");
        fs::write(&hold, "hold").expect("write hold marker");
        let service = service(&temp.0, &[]);
        let mut running = Vec::new();

        for index in 0..DEFAULT_TERMINAL_MAX_CONCURRENT {
            let service = service.clone();
            let cwd = temp.0.clone();
            let hold = hold.clone();
            running.push(tokio::spawn(async move {
                service
                    .execute_binary_internal(
                        "/bin/sh",
                        &[
                            "-c".to_string(),
                            format!("while test -e '{}'; do sleep .02; done", hold.display()),
                        ],
                        format!("holder {index}"),
                        cwd,
                        BinaryExecutionOptions {
                            timeout_ms: Some(5_000),
                            max_output_bytes: 1024,
                            preserve_git_config: false,
                        },
                    )
                    .await
            }));
        }
        wait_for_status(&service, DEFAULT_TERMINAL_MAX_CONCURRENT as u64, 0).await;

        let waiting_service = service.clone();
        let waiting_cwd = temp.0.clone();
        let waiter = tokio::spawn(async move {
            waiting_service
                .execute_binary_internal(
                    "/bin/sh",
                    &["-c".to_string(), "printf never".to_string()],
                    "waiter".to_string(),
                    waiting_cwd,
                    BinaryExecutionOptions {
                        timeout_ms: None,
                        max_output_bytes: 1024,
                        preserve_git_config: false,
                    },
                )
                .await
        });
        wait_for_status(&service, DEFAULT_TERMINAL_MAX_CONCURRENT as u64, 1).await;
        waiter.abort();
        assert!(waiter
            .await
            .expect_err("waiter was cancelled")
            .is_cancelled());
        wait_for_status(&service, DEFAULT_TERMINAL_MAX_CONCURRENT as u64, 0).await;
        assert_eq!(service.status().saturation_count, 1);

        fs::remove_file(hold).expect("release commands");
        for task in running {
            assert_eq!(
                task.await
                    .expect("holder task")
                    .expect("holder command")
                    .code,
                Some(0)
            );
        }
        assert_eq!(service.status().running, 0);
    }

    #[tokio::test]
    async fn git_runner_uses_real_git_and_validates_cwd() {
        let temp = TestDir::new();
        let service = service(&temp.0, &[]);
        let success = service
            .execute_git(&["--version".to_string()], temp.0.clone(), None)
            .await
            .expect("run git");
        assert_eq!(success.command, "git --version");
        assert_eq!(success.code, Some(0));
        assert!(success.stdout.starts_with("git version"));

        let failure = service
            .execute_git(
                &["rev-parse".to_string(), "--is-inside-work-tree".to_string()],
                temp.0.clone(),
                None,
            )
            .await
            .expect("git process errors are responses");
        assert_ne!(failure.code, Some(0));
        assert!(!failure.stderr.is_empty());

        let file = temp.0.join("file");
        fs::write(&file, "not a directory").expect("write cwd fixture");
        assert!(service.execute_git(&[], file, None).await.is_err());
    }

    #[tokio::test]
    async fn stream_reader_handles_limits_and_eof() {
        let (bytes, truncated) = read_stream_limited(&b"short"[..], 10).await;
        assert_eq!(bytes, b"short");
        assert!(!truncated);

        let (bytes, truncated) = read_stream_limited(&b"long"[..], 0).await;
        assert!(bytes.is_empty());
        assert!(truncated);
    }

    #[test]
    fn credential_helper_requires_a_file_and_escapes_its_path() {
        let temp = TestDir::new();
        assert_eq!(trusted_credential_helper_from_home(None), None);
        assert_eq!(
            trusted_credential_helper_from_home(Some(temp.0.clone())),
            None
        );

        let quoted_home = temp.0.join("user's-home");
        let credentials = quoted_home.join(".clawdex/github-credentials");
        fs::create_dir_all(credentials.parent().unwrap()).expect("create credentials directory");
        fs::write(&credentials, "fixture").expect("write credentials");
        let helper = trusted_credential_helper_from_home(Some(quoted_home)).expect("build helper");
        assert!(helper.contains("user'\\''s-home"));

        let args = hardened_git_args_with_helper(&["status".to_string()], Some(helper.clone()));
        assert!(args.contains(&format!("credential.helper={helper}")));
        let args = hardened_git_args_with_helper(&["status".to_string()], None);
        assert!(!args
            .iter()
            .any(|arg| arg.starts_with("credential.helper=store")));
    }

    #[test]
    fn wait_errors_are_appended_without_spurious_newlines() {
        let mut stderr = String::new();
        append_wait_error(&mut stderr, None);
        assert_eq!(stderr, "");

        append_wait_error(&mut stderr, Some("wait failed"));
        assert_eq!(stderr, "wait failed");

        append_wait_error(&mut stderr, Some("again"));
        assert_eq!(stderr, "wait failed\nagain");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn terminal_rejects_symlink_cwd_escape_before_execution() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new();
        let root = temp.0.join("root");
        let outside = temp.0.join("outside");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(&outside).expect("create outside");
        symlink(&outside, root.join("escape")).expect("create escape symlink");
        let policy = Arc::new(PathPolicy::new(root, false).expect("create policy"));
        let service = TerminalService::new(policy, HashSet::from([TerminalExecPolicy::Pwd]));

        let error = service
            .execute_shell(TerminalExecRequest {
                command: "pwd".to_string(),
                cwd: Some("escape".to_string()),
                timeout_ms: None,
            })
            .await
            .expect_err("reject terminal symlink escape");
        assert_eq!(error.code, -32602);
    }

    #[tokio::test]
    async fn empty_policy_denies_every_generic_command() {
        let temp = TestDir::new();
        let policy = Arc::new(PathPolicy::new(temp.0.clone(), false).expect("create policy"));
        let service = TerminalService::new(policy, HashSet::new());
        let error = service
            .execute_shell(TerminalExecRequest {
                command: "pwd".to_string(),
                cwd: None,
                timeout_ms: None,
            })
            .await
            .expect_err("deny empty policy");
        assert_eq!(error.code, -32003);
    }

    #[tokio::test]
    async fn generic_git_is_forbidden_even_with_enabled_policies() {
        let temp = TestDir::new();
        let policy = Arc::new(PathPolicy::new(temp.0.clone(), false).expect("create policy"));
        let service = TerminalService::new(policy, HashSet::from([TerminalExecPolicy::Pwd]));
        let error = service
            .execute_shell(TerminalExecRequest {
                command: "git status".to_string(),
                cwd: None,
                timeout_ms: None,
            })
            .await
            .expect_err("forbid generic git");
        assert_eq!(error.code, -32003);
        assert_eq!(error.data.unwrap()["error"], "generic_git_forbidden");
    }

    #[test]
    fn bridge_git_arguments_apply_fixed_hardening_before_operation() {
        let args = hardened_git_args(&["status".to_string()]);
        assert_eq!(args.last().map(String::as_str), Some("status"));
        for setting in [
            "core.hooksPath=/dev/null",
            "core.fsmonitor=false",
            "commit.gpgSign=false",
            "diff.external=",
            "http.sslVerify=true",
            "http.proxy=",
            "https.proxy=",
            "core.gitProxy=",
            "protocol.allow=never",
            "protocol.https.allow=always",
            "protocol.ext.allow=never",
            "protocol.file.allow=never",
            "credential.helper=",
            "credential.useHttpPath=true",
        ] {
            assert!(args.iter().any(|arg| arg == setting), "missing {setting}");
        }
    }

    #[test]
    fn read_policy_resolves_files_and_rejects_options() {
        let temp = TestDir::new();
        let file = temp.0.join("safe.txt");
        fs::write(&file, "safe").expect("write fixture");
        let policy = Arc::new(PathPolicy::new(temp.0.clone(), false).expect("create policy"));
        let canonical_file = fs::canonicalize(&file).expect("canonical fixture");
        let service = TerminalService::new(policy, HashSet::from([TerminalExecPolicy::Read]));

        assert_eq!(
            service
                .validate_policy_args(TerminalExecPolicy::Read, &["safe.txt".to_string()], &temp.0)
                .expect("validate file"),
            vec![
                "--".to_string(),
                canonical_file.to_string_lossy().to_string()
            ]
        );
        assert!(service
            .validate_policy_args(TerminalExecPolicy::Read, &["-n".to_string()], &temp.0)
            .is_err());
    }

    #[test]
    fn finalize_output_marks_truncated_streams() {
        assert_eq!(
            finalize_output(b"hello\n".to_vec(), true),
            "hello\n[output truncated]"
        );
    }
}
