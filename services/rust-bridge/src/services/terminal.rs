use std::{
    collections::HashSet,
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

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
        "protocol.ext.allow=never".to_string(),
        "-c".to_string(),
        "protocol.file.allow=never".to_string(),
        "-c".to_string(),
        "credential.helper=".to_string(),
        "-c".to_string(),
        "credential.useHttpPath=true".to_string(),
    ];
    if let Some(helper) = trusted_credential_helper() {
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
}

impl TerminalService {
    pub(crate) fn new(path_policy: Arc<PathPolicy>, policies: HashSet<TerminalExecPolicy>) -> Self {
        Self {
            path_policy,
            policies,
            concurrency_limiter: Arc::new(Semaphore::new(DEFAULT_TERMINAL_MAX_CONCURRENT)),
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
            request.timeout_ms,
            DEFAULT_TERMINAL_MAX_OUTPUT_BYTES,
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
            timeout_ms,
            GIT_COMMAND_MAX_OUTPUT_BYTES,
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
        timeout_ms: Option<u64>,
        max_output_bytes: usize,
    ) -> Result<TerminalExecResponse, BridgeError> {
        let _permit = self
            .concurrency_limiter
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| BridgeError::server("terminal concurrency limiter is closed"))?;
        let timeout_ms = timeout_ms.unwrap_or(30_000).clamp(100, 120_000);
        let started_at = Instant::now();

        let mut command = Command::new(binary);
        command
            .args(args)
            .current_dir(&cwd)
            .env_clear()
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
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

        let stdout_task =
            tokio::spawn(async move { read_stream_limited(stdout, max_output_bytes).await });

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
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let (stdout_bytes, stdout_truncated) = stdout_task.await.unwrap_or_default();
        let (stderr_bytes, stderr_truncated) = stderr_task.await.unwrap_or_default();

        let stdout_text = finalize_output(stdout_bytes, stdout_truncated);
        let mut stderr_text = finalize_output(stderr_bytes, stderr_truncated);
        if let Some(wait_error) = wait_error {
            if !stderr_text.is_empty() {
                stderr_text.push('\n');
            }
            stderr_text.push_str(&wait_error);
        }

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
}

fn trusted_credential_helper() -> Option<String> {
    let path = PathBuf::from(std::env::var_os("HOME")?).join(TRUSTED_GITHUB_CREDENTIALS_PATH);
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
mod tests {
    use super::{finalize_output, hardened_git_args, TerminalExecPolicy, TerminalService};
    use crate::{path_policy::PathPolicy, TerminalExecRequest};
    use std::{collections::HashSet, fs, path::PathBuf, sync::Arc};
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
