use std::{
    env,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BridgeInstallKind {
    PublishedCli,
    SourceCheckout,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeUpdaterStatus {
    pub(crate) state: String,
    pub(crate) job_id: String,
    pub(crate) target_version: String,
    pub(crate) message: String,
    pub(crate) updated_at: String,
    pub(crate) started_at: Option<String>,
    pub(crate) completed_at: Option<String>,
    pub(crate) log_path: Option<String>,
    pub(crate) previous_version: Option<String>,
    pub(crate) running_version: Option<String>,
    pub(crate) recoverable: Option<bool>,
    pub(crate) recovery_command: Option<String>,
    pub(crate) failure: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeRuntimeInfo {
    pub(crate) version: String,
    pub(crate) install_kind: BridgeInstallKind,
    pub(crate) self_update_supported: bool,
    pub(crate) safe_restart_supported: bool,
    pub(crate) latest_version: Option<String>,
    pub(crate) updater_status: Option<BridgeUpdaterStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeUpdateStartResponse {
    pub(crate) ok: bool,
    pub(crate) job_id: String,
    pub(crate) target_version: String,
    pub(crate) message: String,
    pub(crate) log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeRestartStartResponse {
    pub(crate) ok: bool,
    pub(crate) job_id: String,
    pub(crate) message: String,
    pub(crate) log_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BridgeMaintenanceAction {
    Update,
    Restart,
}

impl BridgeMaintenanceAction {
    fn as_arg(self) -> &'static str {
        match self {
            Self::Update => "update",
            Self::Restart => "restart",
        }
    }

    fn job_prefix(self) -> &'static str {
        match self {
            Self::Update => "bridge-update",
            Self::Restart => "bridge-restart",
        }
    }
}

#[derive(Debug, Clone)]
struct BridgeMaintenanceJobStart {
    job_id: String,
    target_version: String,
    log_path: Option<String>,
}

#[derive(Clone)]
pub(crate) struct UpdateService {
    package_root: Option<PathBuf>,
    workspace_root: Option<PathBuf>,
    install_kind: BridgeInstallKind,
    status_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
    script_path: Option<PathBuf>,
    launcher_path: Option<PathBuf>,
    secure_env_path: Option<PathBuf>,
}

impl UpdateService {
    pub(crate) fn discover() -> Self {
        let package_root = explicit_root("CLAWDEX_PACKAGE_ROOT", looks_like_package_root);
        let workspace_root = explicit_root("CLAWDEX_WORKSPACE_ROOT", |root| root.is_dir());
        Self::from_roots(package_root, workspace_root)
    }

    fn from_roots(package_root: Option<PathBuf>, workspace_root: Option<PathBuf>) -> Self {
        let install_kind = package_root
            .as_ref()
            .map(|root| detect_install_kind(root))
            .unwrap_or(BridgeInstallKind::Unknown);
        let status_path = workspace_root
            .as_ref()
            .map(|root| root.join(".bridge-update-status.json"));
        let log_path = workspace_root
            .as_ref()
            .map(|root| root.join(".bridge-updater.log"));
        let script_path = package_root
            .as_ref()
            .map(|root| root.join("scripts").join("bridge-self-update.js"));
        let launcher_path = package_root
            .as_ref()
            .map(|root| root.join("scripts").join("start-bridge-secure.js"));
        let secure_env_path = workspace_root.as_ref().map(|root| root.join(".env.secure"));

        Self {
            package_root,
            workspace_root,
            install_kind,
            status_path,
            log_path,
            script_path,
            launcher_path,
            secure_env_path,
        }
    }

    pub(crate) fn is_safe_restart_supported(&self) -> bool {
        self.package_root.is_some()
            && self.workspace_root.is_some()
            && self.script_path.as_ref().is_some_and(|path| path.is_file())
            && self
                .launcher_path
                .as_ref()
                .is_some_and(|path| path.is_file())
            && self
                .secure_env_path
                .as_ref()
                .is_some_and(|path| path.is_file())
    }

    pub(crate) fn is_self_update_supported(&self) -> bool {
        self.install_kind == BridgeInstallKind::PublishedCli && self.is_safe_restart_supported()
    }

    pub(crate) async fn runtime_info(&self) -> BridgeRuntimeInfo {
        BridgeRuntimeInfo {
            version: env!("CARGO_PKG_VERSION").to_string(),
            install_kind: self.install_kind,
            self_update_supported: self.is_self_update_supported(),
            safe_restart_supported: self.is_safe_restart_supported(),
            latest_version: fetch_latest_npm_version().await,
            updater_status: self.read_status(),
        }
    }

    pub(crate) fn start_update(
        &self,
        version: &str,
        bridge_pid: u32,
        now_iso: &str,
    ) -> Result<BridgeUpdateStartResponse, String> {
        let job = self.start_job(
            BridgeMaintenanceAction::Update,
            version,
            bridge_pid,
            now_iso,
        )?;

        Ok(BridgeUpdateStartResponse {
            ok: true,
            job_id: job.job_id,
            target_version: job.target_version.clone(),
            message: format!(
                "Bridge update scheduled for {}. The bridge will disconnect briefly and should restart automatically.",
                job.target_version
            ),
            log_path: job.log_path,
        })
    }

    pub(crate) fn start_restart(
        &self,
        bridge_pid: u32,
        now_iso: &str,
    ) -> Result<BridgeRestartStartResponse, String> {
        let job = self.start_job(
            BridgeMaintenanceAction::Restart,
            env!("CARGO_PKG_VERSION"),
            bridge_pid,
            now_iso,
        )?;

        Ok(BridgeRestartStartResponse {
            ok: true,
            job_id: job.job_id,
            message:
                "Bridge restart scheduled. The bridge will disconnect briefly and should restart automatically."
                    .to_string(),
            log_path: job.log_path,
        })
    }

    fn start_job(
        &self,
        action: BridgeMaintenanceAction,
        version: &str,
        bridge_pid: u32,
        now_iso: &str,
    ) -> Result<BridgeMaintenanceJobStart, String> {
        if bridge_pid == 0 {
            return Err("bridge pid must be greater than zero".to_string());
        }
        if now_iso.trim().is_empty() {
            return Err("job start time must not be empty".to_string());
        }
        match action {
            BridgeMaintenanceAction::Update if !self.is_self_update_supported() => {
                return Err(
                    "Bridge self-update is only supported for published clawdex-mobile CLI installs."
                        .to_string(),
                );
            }
            BridgeMaintenanceAction::Restart if !self.is_safe_restart_supported() => {
                return Err(
                    "Bridge safe restart requires a detected clawdex-mobile install with .env.secure and launcher scripts available."
                        .to_string(),
                );
            }
            _ => {}
        }

        let package_root = self
            .package_root
            .as_ref()
            .ok_or_else(|| "unable to resolve bridge package root".to_string())?;
        let script_path = self
            .script_path
            .as_ref()
            .ok_or_else(|| "bridge updater script is missing".to_string())?;
        let status_path = self
            .status_path
            .as_ref()
            .ok_or_else(|| "bridge updater status path is missing".to_string())?;
        let log_path = self
            .log_path
            .as_ref()
            .ok_or_else(|| "bridge updater log path is missing".to_string())?;
        let workspace_root = self
            .workspace_root
            .as_ref()
            .ok_or_else(|| "unable to resolve bridge workspace root".to_string())?;

        let target_version = normalize_target_version(version)?;
        let job_id = create_job_id(action.job_prefix());

        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .map_err(|error| format!("failed to open updater log: {error}"))?;
        let log_file_err = log_file
            .try_clone()
            .map_err(|error| format!("failed to clone updater log handle: {error}"))?;

        let mut command = std::process::Command::new(node_command());
        command
            .arg(script_path)
            .arg("--action")
            .arg(action.as_arg())
            .arg("--job-id")
            .arg(&job_id)
            .arg("--bridge-pid")
            .arg(bridge_pid.to_string())
            .arg("--version")
            .arg(&target_version)
            .arg("--status-path")
            .arg(status_path)
            .arg("--log-path")
            .arg(log_path)
            .arg("--started-at")
            .arg(now_iso)
            .arg("--package-root")
            .arg(package_root)
            .arg("--workspace-root")
            .arg(workspace_root)
            .current_dir(workspace_root)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log_file))
            .stderr(Stdio::from(log_file_err));

        configure_detached_command(&mut command);

        let child = command
            .spawn()
            .map_err(|error| format!("failed to spawn updater: {error}"))?;
        let _ = child.id();

        Ok(BridgeMaintenanceJobStart {
            job_id,
            target_version,
            log_path: Some(log_path.to_string_lossy().to_string()),
        })
    }

    fn read_status(&self) -> Option<BridgeUpdaterStatus> {
        let status_path = self.status_path.as_ref()?;
        let raw = fs::read_to_string(status_path).ok()?;
        serde_json::from_str::<BridgeUpdaterStatus>(&raw).ok()
    }
}

#[derive(Debug, Deserialize)]
struct NpmDistTagsResponse {
    latest: String,
}

async fn fetch_latest_npm_version() -> Option<String> {
    fetch_latest_npm_version_from("https://registry.npmjs.org/-/package/clawdex-mobile/dist-tags")
        .await
}

async fn fetch_latest_npm_version_from(url: &str) -> Option<String> {
    let client = HttpClient::builder()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(4))
        .build()
        .expect("fixed HTTP client settings must be valid");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }

    let payload = response.json::<NpmDistTagsResponse>().await.ok()?;
    let latest = payload.latest.trim();
    if latest.is_empty() {
        return None;
    }

    Some(latest.to_string())
}

fn explicit_root(name: &str, validate: impl FnOnce(&Path) -> bool) -> Option<PathBuf> {
    let root = env::var_os(name).map(PathBuf::from)?;
    if validate(&root) {
        Some(root)
    } else {
        None
    }
}

fn looks_like_package_root(path: &Path) -> bool {
    path.join("package.json").is_file()
        && path
            .join("scripts")
            .join("start-bridge-secure.js")
            .is_file()
}

fn detect_install_kind(path: &Path) -> BridgeInstallKind {
    if path
        .join("services")
        .join("rust-bridge")
        .join("src")
        .is_dir()
        && path.join("apps").join("mobile").is_dir()
    {
        return BridgeInstallKind::SourceCheckout;
    }

    if path.join("bin").join("clawdex.js").is_file()
        && path.join("scripts").join("bridge-self-update.js").is_file()
    {
        return BridgeInstallKind::PublishedCli;
    }

    BridgeInstallKind::Unknown
}

fn normalize_target_version(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok("latest".to_string());
    }

    if trimmed == "latest"
        || (trimmed
            .chars()
            .next()
            .is_some_and(|char| char.is_ascii_alphanumeric())
            && trimmed
                .chars()
                .all(|char| char.is_ascii_alphanumeric() || matches!(char, '.' | '-' | '_')))
    {
        return Ok(trimmed.to_string());
    }

    Err("version must be 'latest' or a simple npm package version".to_string())
}

fn create_job_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        std::process::id(),
        uuid::Uuid::new_v4()
    )
}

fn node_command() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

#[cfg(unix)]
fn configure_detached_command(command: &mut std::process::Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(windows)]
fn configure_detached_command(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn configure_detached_command(_command: &mut std::process::Command) {}

#[allow(dead_code)]
fn _ensure_send_sync(_: &UpdateService) {}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::{
        net::SocketAddr,
        sync::{Mutex, OnceLock},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        time::{sleep, Instant},
    };

    fn test_dir(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "clawdex-update-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ))
    }

    struct TestRoots {
        package: PathBuf,
        workspace: PathBuf,
    }

    impl TestRoots {
        fn published(label: &str) -> Self {
            let package = test_dir(&format!("{label}-package"));
            let workspace = test_dir(&format!("{label}-workspace"));
            fs::create_dir_all(package.join("bin")).expect("create package bin");
            fs::create_dir_all(package.join("scripts")).expect("create package scripts");
            fs::write(package.join("package.json"), "{}").expect("write manifest");
            fs::write(package.join("bin/clawdex.js"), "").expect("write cli");
            fs::write(package.join("scripts/start-bridge-secure.js"), "").expect("write launcher");
            fs::write(package.join("scripts/bridge-self-update.js"), "").expect("write updater");
            fs::create_dir_all(&workspace).expect("create workspace");
            fs::write(workspace.join(".env.secure"), "BRIDGE_HOST=127.0.0.1\n")
                .expect("write secure env");
            Self { package, workspace }
        }

        fn service(&self) -> UpdateService {
            UpdateService::from_roots(Some(self.package.clone()), Some(self.workspace.clone()))
        }
    }

    impl Drop for TestRoots {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.package);
            let _ = fs::remove_dir_all(&self.workspace);
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    async fn serve_once(status: &str, body: &str) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("server address");
        let status = status.to_string();
        let body = body.to_string();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accept request");
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request).await.expect("read request");
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write response");
        });
        address
    }

    #[test]
    fn package_scripts_and_workspace_state_use_distinct_roots() {
        let package_root = test_dir("package");
        let workspace_root = test_dir("workspace");
        fs::create_dir_all(package_root.join("bin")).expect("create package bin");
        fs::create_dir_all(package_root.join("scripts")).expect("create package scripts");
        fs::write(package_root.join("package.json"), "{}").expect("write package manifest");
        fs::write(package_root.join("bin/clawdex.js"), "").expect("write cli");
        fs::write(package_root.join("scripts/start-bridge-secure.js"), "").expect("write launcher");
        fs::write(package_root.join("scripts/bridge-self-update.js"), "").expect("write updater");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        fs::write(
            workspace_root.join(".env.secure"),
            "BRIDGE_HOST=127.0.0.1\n",
        )
        .expect("write secure env");

        let service =
            UpdateService::from_roots(Some(package_root.clone()), Some(workspace_root.clone()));

        assert_eq!(service.install_kind, BridgeInstallKind::PublishedCli);
        assert_eq!(
            service.script_path,
            Some(package_root.join("scripts/bridge-self-update.js"))
        );
        assert_eq!(
            service.secure_env_path,
            Some(workspace_root.join(".env.secure"))
        );
        assert_eq!(
            service.status_path,
            Some(workspace_root.join(".bridge-update-status.json"))
        );
        assert!(service.is_safe_restart_supported());
        assert!(service.is_self_update_supported());

        fs::remove_dir_all(package_root).expect("remove package root");
        fs::remove_dir_all(workspace_root).expect("remove workspace root");
    }

    #[test]
    fn reads_recoverable_stopped_updater_status() {
        let workspace_root = test_dir("status");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        fs::write(
            workspace_root.join(".bridge-update-status.json"),
            r#"{
                "state":"stopped",
                "jobId":"bridge-update-1",
                "targetVersion":"6.0.0",
                "previousVersion":"5.2.3",
                "message":"Automatic rollback failed.",
                "updatedAt":"2026-07-18T00:00:00Z",
                "startedAt":"2026-07-18T00:00:00Z",
                "completedAt":"2026-07-18T00:01:00Z",
                "logPath":"/tmp/updater.log",
                "runningVersion":null,
                "recoverable":true,
                "recoveryCommand":"npm install -g clawdex-mobile@5.2.3 && clawdex init",
                "failure":"startup failed; rollback: npm failed"
            }"#,
        )
        .expect("write status");

        let service = UpdateService::from_roots(None, Some(workspace_root.clone()));
        let status = service.read_status().expect("read status");

        assert_eq!(status.state, "stopped");
        assert_eq!(status.previous_version.as_deref(), Some("5.2.3"));
        assert_eq!(status.running_version, None);
        assert_eq!(status.recoverable, Some(true));
        assert_eq!(
            status.recovery_command.as_deref(),
            Some("npm install -g clawdex-mobile@5.2.3 && clawdex init")
        );

        fs::remove_dir_all(workspace_root).expect("remove workspace root");
    }

    #[test]
    fn discovers_explicit_valid_roots_and_rejects_invalid_roots() {
        let _guard = env_lock().lock().expect("lock environment");
        let roots = TestRoots::published("discover");
        env::set_var("CLAWDEX_PACKAGE_ROOT", &roots.package);
        env::set_var("CLAWDEX_WORKSPACE_ROOT", &roots.workspace);
        let discovered = UpdateService::discover();
        assert_eq!(
            discovered.package_root.as_deref(),
            Some(roots.package.as_path())
        );
        assert_eq!(
            discovered.workspace_root.as_deref(),
            Some(roots.workspace.as_path())
        );
        assert_eq!(discovered.install_kind, BridgeInstallKind::PublishedCli);

        env::set_var("CLAWDEX_PACKAGE_ROOT", roots.workspace.join("missing"));
        env::set_var("CLAWDEX_WORKSPACE_ROOT", roots.workspace.join("missing"));
        let invalid = UpdateService::discover();
        assert!(invalid.package_root.is_none());
        assert!(invalid.workspace_root.is_none());

        env::remove_var("CLAWDEX_PACKAGE_ROOT");
        env::remove_var("CLAWDEX_WORKSPACE_ROOT");
        let absent = UpdateService::discover();
        assert!(absent.package_root.is_none());
        assert!(absent.workspace_root.is_none());
    }

    #[test]
    fn detects_install_kinds_and_support_requirements() {
        let roots = TestRoots::published("kinds");
        assert_eq!(
            detect_install_kind(&roots.package),
            BridgeInstallKind::PublishedCli
        );

        let source = test_dir("source");
        fs::create_dir_all(source.join("services/rust-bridge/src")).expect("create source service");
        fs::create_dir_all(source.join("apps/mobile")).expect("create source app");
        assert_eq!(
            detect_install_kind(&source),
            BridgeInstallKind::SourceCheckout
        );
        assert_eq!(
            detect_install_kind(&roots.workspace),
            BridgeInstallKind::Unknown
        );

        let service = roots.service();
        assert!(service.is_safe_restart_supported());
        assert!(service.is_self_update_supported());
        fs::remove_file(roots.package.join("scripts/bridge-self-update.js"))
            .expect("remove updater");
        assert!(!service.is_safe_restart_supported());
        fs::write(roots.package.join("scripts/bridge-self-update.js"), "")
            .expect("restore updater");
        fs::remove_file(roots.package.join("scripts/start-bridge-secure.js"))
            .expect("remove launcher");
        assert!(!service.is_safe_restart_supported());
        fs::write(roots.package.join("scripts/start-bridge-secure.js"), "")
            .expect("restore launcher");
        fs::remove_file(roots.workspace.join(".env.secure")).expect("remove env");
        assert!(!service.is_safe_restart_supported());

        assert!(
            !UpdateService::from_roots(None, Some(roots.workspace.clone()))
                .is_safe_restart_supported()
        );
        assert!(
            !UpdateService::from_roots(Some(roots.package.clone()), None)
                .is_safe_restart_supported()
        );
        assert!(!UpdateService::from_roots(None, None).is_self_update_supported());
        fs::remove_dir_all(source).expect("remove source root");
    }

    #[test]
    fn status_reading_handles_missing_invalid_and_valid_documents() {
        let workspace = test_dir("status-branches");
        fs::create_dir_all(&workspace).expect("create workspace");
        let service = UpdateService::from_roots(None, Some(workspace.clone()));
        assert!(service.read_status().is_none());
        fs::write(workspace.join(".bridge-update-status.json"), "not json")
            .expect("write invalid status");
        assert!(service.read_status().is_none());
        fs::write(
            workspace.join(".bridge-update-status.json"),
            r#"{"state":"scheduled","jobId":"job","targetVersion":"latest","message":"queued","updatedAt":"now","startedAt":null,"completedAt":null,"logPath":null,"previousVersion":null,"runningVersion":null,"recoverable":null,"recoveryCommand":null,"failure":null}"#,
        )
        .expect("write valid status");
        assert_eq!(service.read_status().unwrap().job_id, "job");
        assert!(UpdateService::from_roots(None, None)
            .read_status()
            .is_none());
        fs::remove_dir_all(workspace).expect("remove workspace");
    }

    #[test]
    fn validates_versions_actions_and_job_metadata_before_spawn() {
        assert_eq!(normalize_target_version("").unwrap(), "latest");
        assert_eq!(normalize_target_version(" latest ").unwrap(), "latest");
        assert_eq!(
            normalize_target_version("v6.0.0-rc_1").unwrap(),
            "v6.0.0-rc_1"
        );
        for version in ["-bad", "_bad", ".", "6/0", "6 0", "6@next"] {
            assert!(
                normalize_target_version(version).is_err(),
                "accepted {version:?}"
            );
        }

        assert_eq!(BridgeMaintenanceAction::Update.as_arg(), "update");
        assert_eq!(BridgeMaintenanceAction::Restart.as_arg(), "restart");
        assert_eq!(
            BridgeMaintenanceAction::Update.job_prefix(),
            "bridge-update"
        );
        assert_eq!(
            BridgeMaintenanceAction::Restart.job_prefix(),
            "bridge-restart"
        );
        assert_eq!(
            node_command(),
            if cfg!(windows) { "node.exe" } else { "node" }
        );
        assert_ne!(create_job_id("job"), create_job_id("job"));

        let unsupported = UpdateService::from_roots(None, None);
        assert!(unsupported.start_update("latest", 1, "now").is_err());
        assert!(unsupported.start_restart(1, "now").is_err());

        let roots = TestRoots::published("validation");
        let service = roots.service();
        assert!(service.start_update("latest", 0, "now").is_err());
        assert!(service.start_update("latest", 1, " ").is_err());
        assert!(service.start_update("bad/version", 1, "now").is_err());

        fs::remove_file(roots.workspace.join(".bridge-updater.log")).ok();
        fs::create_dir(roots.workspace.join(".bridge-updater.log"))
            .expect("create invalid log path");
        assert!(service
            .start_update("latest", 1, "now")
            .unwrap_err()
            .contains("open updater log"));
    }

    #[tokio::test]
    async fn starts_update_and_restart_jobs_with_validated_arguments() {
        let roots = TestRoots::published("jobs");
        fs::write(
            roots.package.join("scripts/bridge-self-update.js"),
            r#"const fs = require('node:fs');
const args = Object.fromEntries(Array.from({length: process.argv.length - 2}, (_, i) => i).filter(i => i % 2 === 0).map(i => [process.argv[i + 2], process.argv[i + 3]]));
fs.writeFileSync(args['--status-path'], JSON.stringify({state:'scheduled',jobId:args['--job-id'],targetVersion:args['--version'],message:args['--action'],updatedAt:args['--started-at'],startedAt:null,completedAt:null,logPath:args['--log-path'],previousVersion:null,runningVersion:null,recoverable:null,recoveryCommand:null,failure:null}));"#,
        )
        .expect("write updater fixture");
        let service = roots.service();

        let update = service
            .start_update(" 6.1.0 ", 42, "2026-07-18T00:00:00Z")
            .expect("start update");
        assert!(update.ok);
        assert_eq!(update.target_version, "6.1.0");
        assert!(update.job_id.starts_with("bridge-update-"));
        assert!(update.log_path.is_some());

        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = service.read_status() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "updater fixture did not write status"
            );
            sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(status.job_id, update.job_id);
        assert_eq!(status.target_version, "6.1.0");
        assert_eq!(status.message, "update");

        fs::remove_file(roots.workspace.join(".bridge-update-status.json")).expect("remove status");
        let restart = service
            .start_restart(42, "2026-07-18T00:01:00Z")
            .expect("start restart");
        assert!(restart.ok);
        assert!(restart.job_id.starts_with("bridge-restart-"));
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = service.read_status() {
                break status;
            }
            assert!(
                Instant::now() < deadline,
                "restart fixture did not write status"
            );
            sleep(Duration::from_millis(10)).await;
        };
        assert_eq!(status.job_id, restart.job_id);
        assert_eq!(status.message, "restart");
        assert_eq!(status.target_version, env!("CARGO_PKG_VERSION"));
    }

    #[tokio::test]
    async fn fetches_latest_version_and_rejects_http_and_payload_failures() {
        let address = serve_once("200 OK", r#"{"latest":" 6.2.0 "}"#).await;
        assert_eq!(
            fetch_latest_npm_version_from(&format!("http://{address}/tags")).await,
            Some("6.2.0".to_string())
        );

        let address = serve_once("503 Service Unavailable", "{}").await;
        assert!(
            fetch_latest_npm_version_from(&format!("http://{address}/tags"))
                .await
                .is_none()
        );
        let address = serve_once("200 OK", "not json").await;
        assert!(
            fetch_latest_npm_version_from(&format!("http://{address}/tags"))
                .await
                .is_none()
        );
        let address = serve_once("200 OK", r#"{"latest":"  "}"#).await;
        assert!(
            fetch_latest_npm_version_from(&format!("http://{address}/tags"))
                .await
                .is_none()
        );
        assert!(fetch_latest_npm_version_from("http://127.0.0.1:0/tags")
            .await
            .is_none());
    }
}
