use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, bail, Context, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System};

use crate::config::{BridgeRuntimeConfig, RuntimePaths};

const STATUS_BODY_LIMIT_BYTES: u64 = 2 * 1024 * 1024;
const START_TIMEOUT: Duration = Duration::from_secs(60);
const STOP_TIMEOUT: Duration = Duration::from_secs(12);
const OWNERSHIP_RECORD_VERSION: u32 = 1;

#[derive(Clone, Debug)]
pub struct BridgeSupervisor {
    workspace: PathBuf,
    runtime: RuntimePaths,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BridgeState {
    NeedsSetup,
    Stopped,
    Running,
    Degraded,
    Unhealthy,
    Inaccessible,
    Error,
}

#[derive(Clone, Debug)]
pub struct BridgeSnapshot {
    pub state: BridgeState,
    pub headline: String,
    pub detail: String,
    pub url: Option<String>,
    pub uptime_sec: Option<u64>,
    pub connected_clients: usize,
    pub ready_agents: usize,
    pub total_agents: usize,
    pub recent_error_count: usize,
    pub managed_process: bool,
}

impl BridgeSnapshot {
    pub fn needs_setup(workspace: &Path) -> Self {
        Self {
            state: BridgeState::NeedsSetup,
            headline: "Setup required".to_string(),
            detail: format!(
                "Install an ACP agent and create secure bridge settings for {}.",
                workspace.display()
            ),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    pub fn stopped(config: &BridgeRuntimeConfig) -> Self {
        Self {
            state: BridgeState::Stopped,
            headline: "Bridge stopped".to_string(),
            detail: "Start the bridge to connect your phone.".to_string(),
            url: Some(config.connect_url.clone()),
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    pub fn stopped_with_config_error(error: &anyhow::Error) -> Self {
        Self {
            state: BridgeState::Stopped,
            headline: "Bridge stopped".to_string(),
            detail: format!("Bridge stopped, but secure configuration needs repair: {error}"),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            state: BridgeState::Error,
            headline: "Bridge needs attention".to_string(),
            detail: message.into(),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: false,
        }
    }

    fn owned_config_error(error: &anyhow::Error) -> Self {
        Self {
            state: BridgeState::Inaccessible,
            headline: "Bridge configuration unavailable".to_string(),
            detail: format!(
                "The owned bridge is still running, but secure configuration needs repair: {error}"
            ),
            url: None,
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process: true,
        }
    }

    fn inaccessible(config: &BridgeRuntimeConfig, detail: String, managed_process: bool) -> Self {
        Self {
            state: BridgeState::Inaccessible,
            headline: "Bridge access failed".to_string(),
            detail,
            url: Some(config.connect_url.clone()),
            uptime_sec: None,
            connected_clients: 0,
            ready_agents: 0,
            total_agents: 0,
            recent_error_count: 0,
            managed_process,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusResponse {
    status: String,
    uptime_sec: u64,
    connected_clients: usize,
    #[serde(default)]
    agents: Vec<AgentStatus>,
    #[serde(default)]
    operational: OperationalStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentStatus {
    lifecycle: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationalStatus {
    #[serde(default)]
    recent_errors: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessOwnershipRecord {
    version: u32,
    pid: u32,
    started_at_epoch_sec: u64,
    executable: PathBuf,
    workspace: PathBuf,
    config_sha256: String,
}

struct TransitionLease {
    _file: File,
}

impl BridgeSupervisor {
    pub fn new(workspace: PathBuf, runtime: RuntimePaths) -> Self {
        Self { workspace, runtime }
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn runtime_config(&self) -> Result<BridgeRuntimeConfig> {
        BridgeRuntimeConfig::load(&self.workspace)
    }

    pub fn snapshot(&self) -> BridgeSnapshot {
        let config = match self.runtime_config() {
            Ok(config) => config,
            Err(error) if self.owns_running_process() => {
                return BridgeSnapshot::owned_config_error(&error);
            }
            Err(_) if !self.workspace.join(".env.secure").is_file() => {
                return BridgeSnapshot::needs_setup(&self.workspace);
            }
            Err(error) => return BridgeSnapshot::error(error.to_string()),
        };

        let managed_process = self.owns_running_process();
        if !self.probe_health(&config) && managed_process {
            return BridgeSnapshot::inaccessible(
                &config,
                "The owned bridge process is running, but its health endpoint is temporarily unavailable."
                    .to_string(),
                true,
            );
        }
        if !self.probe_health(&config) {
            return BridgeSnapshot::stopped(&config);
        }

        match self.fetch_status(&config) {
            Ok(status) => self.project_status(&config, status),
            Err(error) => BridgeSnapshot::inaccessible(
                &config,
                format!("A bridge is listening, but authenticated status failed: {error}"),
                self.owns_running_process(),
            ),
        }
    }

    pub fn start(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        self.start_locked()
    }

    fn start_locked(&self) -> Result<BridgeSnapshot> {
        let config = self.runtime_config()?;
        if self.owns_running_process() {
            return Ok(BridgeSnapshot::inaccessible(
                &config,
                "The owned bridge process is already running; wait for health to recover or stop/restart it."
                    .to_string(),
                true,
            ));
        }
        if self.fetch_status(&config).is_ok() {
            return Ok(self.snapshot());
        }
        if self.probe_health(&config) {
            bail!("a bridge is already listening, but authenticated status is unavailable");
        }

        let bridge_binary = self.resolve_bridge_binary(&config)?;
        self.clean_stale_ownership(&bridge_binary)?;
        let log_path = self.workspace.join(".bridge.log");
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .with_context(|| format!("failed to open {}", log_path.display()))?;
        let stderr = stdout.try_clone()?;

        let mut command = Command::new(&bridge_binary);
        command
            .current_dir(&self.workspace)
            .envs(config.values.iter())
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        detach_process(&mut command);
        let mut child = command.spawn().with_context(|| {
            format!("failed to start bridge binary {}", bridge_binary.display())
        })?;
        let pid = child.id();
        let ownership =
            match process_identity(pid, &bridge_binary, &self.workspace, &self.config_path()) {
                Ok(ownership) => ownership,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error).context("failed to establish bridge process ownership");
                }
            };
        if let Err(error) = write_ownership_record(&self.ownership_path(), &ownership)
            .and_then(|_| write_compatibility_pid_file(&self.pid_path(), pid))
        {
            let _ = child.kill();
            let _ = child.wait();
            let _ = self.remove_ownership_if_matches(&ownership);
            return Err(error).context("failed to publish bridge process ownership");
        }
        thread::spawn(move || {
            let _ = child.wait();
        });

        let started_at = Instant::now();
        while started_at.elapsed() < START_TIMEOUT {
            if let Ok(status) = self.fetch_status(&config) {
                return Ok(self.project_status(&config, status));
            }
            if !process_matches_ownership(&ownership) {
                let _ = self.remove_ownership_if_matches(&ownership);
                bail!(
                    "bridge exited before becoming healthy; inspect {}",
                    log_path.display()
                );
            }
            thread::sleep(Duration::from_millis(350));
        }

        let _ = self.stop_owned_process(&ownership);
        bail!(
            "bridge did not become healthy within {} seconds; inspect {}",
            START_TIMEOUT.as_secs(),
            log_path.display()
        )
    }

    pub fn stop(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        self.stop_locked()
    }

    fn stop_locked(&self) -> Result<BridgeSnapshot> {
        let Some(ownership) = read_ownership_record(&self.ownership_path())? else {
            let config = self.runtime_config()?;
            if self.fetch_status(&config).is_ok() {
                bail!("a bridge is running at the configured address but is not owned by this app");
            }
            return Ok(BridgeSnapshot::stopped(&config));
        };
        if ownership.workspace != self.workspace.canonicalize()? {
            bail!("bridge ownership record belongs to a different workspace");
        }
        if !process_matches_ownership(&ownership) {
            self.remove_ownership_if_matches(&ownership)?;
            if let Ok(config) = self.runtime_config() {
                if self.fetch_status(&config).is_ok() {
                    bail!("a bridge is running at the configured address but its process identity does not match this app");
                }
                return Ok(BridgeSnapshot::stopped(&config));
            }
            return Ok(BridgeSnapshot::error(
                "The recorded bridge process is no longer running, and secure configuration needs repair.",
            ));
        }

        self.stop_owned_process(&ownership)?;
        match self.runtime_config() {
            Ok(config) => Ok(BridgeSnapshot::stopped(&config)),
            Err(error) => Ok(BridgeSnapshot::stopped_with_config_error(&error)),
        }
    }

    pub fn restart(&self) -> Result<BridgeSnapshot> {
        let _lease = self.acquire_transition_lease()?;
        if read_ownership_record(&self.ownership_path())?.is_some() {
            self.stop_locked()?;
        }
        self.start_locked()
    }

    pub fn owns_running_process(&self) -> bool {
        let Ok(Some(ownership)) = read_ownership_record(&self.ownership_path()) else {
            return false;
        };
        self.workspace
            .canonicalize()
            .is_ok_and(|workspace| ownership.workspace == workspace)
            && process_matches_ownership(&ownership)
    }

    pub fn log_path(&self) -> PathBuf {
        self.workspace.join(".bridge.log")
    }

    fn fetch_status(&self, config: &BridgeRuntimeConfig) -> Result<BridgeStatusResponse> {
        let agent = http_agent();
        let url = format!("{}/status", config.local_base_url());
        let mut response = agent
            .get(&url)
            .header("Authorization", &format!("Bearer {}", config.auth_token))
            .call()
            .with_context(|| format!("bridge status unavailable at {url}"))?;
        let body = response
            .body_mut()
            .with_config()
            .limit(STATUS_BODY_LIMIT_BYTES)
            .read_to_string()
            .context("bridge status response was invalid or too large")?;
        serde_json::from_str(&body).context("bridge returned malformed status JSON")
    }

    fn probe_health(&self, config: &BridgeRuntimeConfig) -> bool {
        let url = format!("{}/health", config.local_base_url());
        match http_agent().get(&url).call() {
            Ok(_) => true,
            Err(ureq::Error::StatusCode(503)) => true,
            Err(_) => false,
        }
    }

    fn project_status(
        &self,
        config: &BridgeRuntimeConfig,
        status: BridgeStatusResponse,
    ) -> BridgeSnapshot {
        let ready_agents = status
            .agents
            .iter()
            .filter(|agent| agent.lifecycle == "ready")
            .count();
        let state = match status.status.as_str() {
            "ok" => BridgeState::Running,
            "degraded" => BridgeState::Degraded,
            "unhealthy" => BridgeState::Unhealthy,
            _ => BridgeState::Error,
        };
        let headline = match state {
            BridgeState::Running => "Bridge running",
            BridgeState::Degraded => "Bridge degraded",
            BridgeState::Unhealthy => "Bridge unhealthy",
            _ => "Unknown bridge status",
        }
        .to_string();
        let detail = format!(
            "{} connected device{} · {}/{} agent{} ready",
            status.connected_clients,
            plural(status.connected_clients),
            ready_agents,
            status.agents.len(),
            plural(status.agents.len())
        );
        BridgeSnapshot {
            state,
            headline,
            detail,
            url: Some(config.connect_url.clone()),
            uptime_sec: Some(status.uptime_sec),
            connected_clients: status.connected_clients,
            ready_agents,
            total_agents: status.agents.len(),
            recent_error_count: status.operational.recent_errors.len(),
            managed_process: self.owns_running_process(),
        }
    }

    fn resolve_bridge_binary(&self, _config: &BridgeRuntimeConfig) -> Result<PathBuf> {
        let candidates = self.runtime.bridge_binary_candidates();
        resolve_existing_executable(&candidates).ok_or_else(|| {
            anyhow!(
                "bridge binary is not installed; build it with 'cargo build --locked --release --manifest-path services/rust-bridge/Cargo.toml' or reinstall TetherCode"
            )
        })
    }

    fn pid_path(&self) -> PathBuf {
        self.workspace.join(".bridge.pid")
    }

    fn ownership_path(&self) -> PathBuf {
        self.workspace
            .join(".tethercode")
            .join("desktop-bridge-process.json")
    }

    fn transition_lock_path(&self) -> PathBuf {
        self.workspace
            .join(".tethercode")
            .join("desktop-bridge-transition.lock")
    }

    fn config_path(&self) -> PathBuf {
        self.workspace.join(".env.secure")
    }

    fn acquire_transition_lease(&self) -> Result<TransitionLease> {
        let lock_path = self.transition_lock_path();
        let parent = lock_path
            .parent()
            .context("transition lock has no parent")?;
        fs::create_dir_all(parent)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(&lock_path)
            .with_context(|| format!("failed to open {}", lock_path.display()))?;
        file.lock_exclusive()
            .with_context(|| format!("failed to lock {}", lock_path.display()))?;
        Ok(TransitionLease { _file: file })
    }

    fn clean_stale_ownership(&self, bridge_binary: &Path) -> Result<()> {
        let Some(ownership) = read_ownership_record(&self.ownership_path())? else {
            remove_compatibility_pid_file(&self.pid_path(), None)?;
            return Ok(());
        };
        if !process_matches_ownership(&ownership) {
            self.remove_ownership_if_matches(&ownership)?;
            return Ok(());
        }
        if !ownership_matches_expected(
            &ownership,
            bridge_binary,
            &self.workspace,
            &self.config_path(),
        )? {
            bail!("bridge configuration changed while the managed process was running; restore the original configuration before starting another bridge");
        }
        Ok(())
    }

    fn remove_ownership_if_matches(&self, expected: &ProcessOwnershipRecord) -> Result<()> {
        if read_ownership_record(&self.ownership_path())?.as_ref() == Some(expected) {
            remove_file_if_exists(&self.ownership_path())?;
        }
        remove_compatibility_pid_file(&self.pid_path(), Some(expected.pid))
    }

    fn stop_owned_process(&self, ownership: &ProcessOwnershipRecord) -> Result<()> {
        if !process_matches_ownership(ownership) {
            bail!(
                "refusing to stop PID {} because its process identity changed",
                ownership.pid
            );
        }
        signal_process(ownership.pid, Signal::Term)?;
        let started_at = Instant::now();
        while started_at.elapsed() < STOP_TIMEOUT {
            if !process_matches_ownership(ownership) {
                self.remove_ownership_if_matches(ownership)?;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(200));
        }
        if process_matches_ownership(ownership) {
            signal_process(ownership.pid, Signal::Kill)?;
        }
        let forced_at = Instant::now();
        while forced_at.elapsed() < Duration::from_secs(3) {
            if !process_matches_ownership(ownership) {
                self.remove_ownership_if_matches(ownership)?;
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        bail!("bridge process {} did not stop", ownership.pid)
    }
}

impl Drop for TransitionLease {
    fn drop(&mut self) {
        let _ = self._file.unlock();
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 {
        ""
    } else {
        "s"
    }
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(1)))
        .build()
        .into()
}

fn resolve_existing_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
}

fn read_ownership_record(path: &Path) -> Result<Option<ProcessOwnershipRecord>> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let record: ProcessOwnershipRecord = serde_json::from_slice(&contents).with_context(|| {
        format!(
            "invalid desktop bridge process record at {}",
            path.display()
        )
    })?;
    if record.version != OWNERSHIP_RECORD_VERSION
        || record.pid == 0
        || !valid_sha256_digest(&record.config_sha256)
    {
        bail!(
            "unsupported desktop bridge process record at {}",
            path.display()
        );
    }
    Ok(Some(record))
}

fn write_ownership_record(path: &Path, record: &ProcessOwnershipRecord) -> Result<()> {
    let contents = serde_json::to_vec_pretty(record)?;
    atomic_private_write(path, &contents)
}

fn write_compatibility_pid_file(path: &Path, pid: u32) -> Result<()> {
    atomic_private_write(path, format!("{pid}\n").as_bytes())
}

fn atomic_private_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("atomic path has no parent")?;
    fs::create_dir_all(parent)?;
    let temporary_path = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let write_result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary_path)?;
        file.write_all(contents)?;
        if !contents.ends_with(b"\n") {
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        fs::rename(&temporary_path, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

fn remove_compatibility_pid_file(path: &Path, expected_pid: Option<u32>) -> Result<()> {
    if let Some(expected_pid) = expected_pid {
        let actual = fs::read_to_string(path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        if actual != Some(expected_pid) {
            return Ok(());
        }
    }
    remove_file_if_exists(path)
}

fn remove_file_if_exists(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn process_identity(
    pid: u32,
    expected_binary: &Path,
    workspace: &Path,
    config_path: &Path,
) -> Result<ProcessOwnershipRecord> {
    let mut system = System::new();
    let sysinfo_pid = Pid::from_u32(pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo_pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    let process = system
        .process(sysinfo_pid)
        .ok_or_else(|| anyhow!("bridge process {pid} no longer exists"))?;
    let executable = process
        .exe()
        .context("bridge executable identity is unavailable")?
        .canonicalize()?;
    let expected_binary = expected_binary.canonicalize()?;
    if executable != expected_binary {
        bail!("bridge executable identity did not match the launched binary");
    }
    let process_workspace = process
        .cwd()
        .context("bridge working directory identity is unavailable")?
        .canonicalize()?;
    let workspace = workspace.canonicalize()?;
    if process_workspace != workspace {
        bail!("bridge working directory identity did not match the selected workspace");
    }
    let started_at_epoch_sec = process.start_time();
    if started_at_epoch_sec == 0 {
        bail!("bridge process start time is unavailable");
    }
    Ok(ProcessOwnershipRecord {
        version: OWNERSHIP_RECORD_VERSION,
        pid,
        started_at_epoch_sec,
        executable,
        workspace,
        config_sha256: file_sha256(config_path)?,
    })
}

fn ownership_matches_expected(
    record: &ProcessOwnershipRecord,
    expected_binary: &Path,
    workspace: &Path,
    config_path: &Path,
) -> Result<bool> {
    Ok(record.version == OWNERSHIP_RECORD_VERSION
        && record.executable == expected_binary.canonicalize()?
        && record.workspace == workspace.canonicalize()?
        && record.config_sha256 == file_sha256(config_path)?)
}

fn process_matches_ownership(record: &ProcessOwnershipRecord) -> bool {
    let mut system = System::new();
    let sysinfo_pid = Pid::from_u32(record.pid);
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[sysinfo_pid]),
        true,
        ProcessRefreshKind::everything(),
    );
    let Some(process) = system.process(sysinfo_pid) else {
        return false;
    };
    let Some(executable) = process.exe().and_then(|path| path.canonicalize().ok()) else {
        return false;
    };
    let Some(workspace) = process.cwd().and_then(|path| path.canonicalize().ok()) else {
        return false;
    };
    process.start_time() == record.started_at_epoch_sec
        && executable == record.executable
        && workspace == record.workspace
}

fn file_sha256(path: &Path) -> Result<String> {
    let bytes = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn valid_sha256_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn signal_process(pid: u32, signal: Signal) -> Result<()> {
    let mut system = System::new();
    let sysinfo_pid = Pid::from_u32(pid);
    system.refresh_processes(ProcessesToUpdate::Some(&[sysinfo_pid]), true);
    let process = system
        .process(sysinfo_pid)
        .ok_or_else(|| anyhow!("bridge process {pid} no longer exists"))?;
    match process.kill_with(signal) {
        Some(true) => Ok(()),
        Some(false) => bail!("operating system refused to signal bridge process {pid}"),
        None => bail!("requested process signal is not supported on this platform"),
    }
}

#[cfg(unix)]
fn detach_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;
    command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
}

#[cfg(not(any(unix, windows)))]
fn detach_process(_command: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use tempfile::tempdir;

    #[test]
    fn selects_the_first_existing_bridge_binary() {
        let temp = tempdir().unwrap();
        let missing = temp.path().join("missing");
        let existing = temp.path().join("bridge");
        fs::write(&existing, "binary").unwrap();

        assert_eq!(
            resolve_existing_executable(&[missing, existing.clone()]),
            Some(existing.canonicalize().unwrap())
        );
    }

    #[test]
    fn ownership_record_round_trips_privately() {
        let temp = tempdir().unwrap();
        let record_path = temp.path().join("process.json");
        let record = ProcessOwnershipRecord {
            version: OWNERSHIP_RECORD_VERSION,
            pid: 42,
            started_at_epoch_sec: 1234,
            executable: PathBuf::from("/bin/echo"),
            workspace: temp.path().to_path_buf(),
            config_sha256: format!("sha256:{}", "a".repeat(64)),
        };

        write_ownership_record(&record_path, &record).unwrap();
        assert_eq!(read_ownership_record(&record_path).unwrap(), Some(record));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(record_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn ownership_requires_matching_workspace_binary_and_config() {
        let temp = tempdir().unwrap();
        let config_path = temp.path().join(".env.secure");
        fs::write(&config_path, "BRIDGE_PORT=8787\n").unwrap();
        let binary = PathBuf::from("/bin/echo").canonicalize().unwrap();
        let record = ProcessOwnershipRecord {
            version: OWNERSHIP_RECORD_VERSION,
            pid: 42,
            started_at_epoch_sec: 1234,
            executable: binary.clone(),
            workspace: temp.path().canonicalize().unwrap(),
            config_sha256: file_sha256(&config_path).unwrap(),
        };

        assert!(ownership_matches_expected(&record, &binary, temp.path(), &config_path).unwrap());
        fs::write(&config_path, "BRIDGE_PORT=9999\n").unwrap();
        assert!(!ownership_matches_expected(&record, &binary, temp.path(), &config_path).unwrap());

        let mut wrong_start = record;
        wrong_start.started_at_epoch_sec += 1;
        assert!(!process_matches_ownership(&wrong_start));
    }

    #[test]
    fn transition_lease_serializes_workspace_mutations() {
        let temp = tempdir().unwrap();
        let lock_path = temp.path().join("transition.lock");
        let first = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .unwrap();
        first.lock_exclusive().unwrap();

        let (acquired_tx, acquired_rx) = mpsc::channel();
        let contender_path = lock_path.clone();
        let contender = thread::spawn(move || {
            let second = OpenOptions::new()
                .read(true)
                .write(true)
                .open(contender_path)
                .unwrap();
            second.lock_exclusive().unwrap();
            acquired_tx.send(()).unwrap();
            FileExt::unlock(&second).unwrap();
        });

        assert!(acquired_rx
            .recv_timeout(Duration::from_millis(100))
            .is_err());
        FileExt::unlock(&first).unwrap();
        acquired_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        contender.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_owned_process_with_failed_health_cannot_start_again() {
        let temp = tempdir().unwrap();
        let agents_root = temp.path().join(".tethercode/agents");
        fs::create_dir_all(&agents_root).unwrap();
        let manifest = temp.path().join(".tethercode/agents.json");
        fs::write(&manifest, "{}\n").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let config_path = temp.path().join(".env.secure");
        fs::write(
            &config_path,
            format!(
                "BRIDGE_HOST=127.0.0.1\nBRIDGE_PORT={port}\nBRIDGE_AUTH_TOKEN=test\nACP_AGENT_MANIFEST={}\nACP_AGENT_ROOTS={}\n",
                manifest.display(),
                agents_root.display()
            ),
        )
        .unwrap();

        let sleep_binary = PathBuf::from("/bin/sleep").canonicalize().unwrap();
        let mut child = Command::new(&sleep_binary)
            .arg("30")
            .current_dir(temp.path())
            .spawn()
            .unwrap();
        let ownership = (0..20)
            .find_map(|_| {
                let identity =
                    process_identity(child.id(), &sleep_binary, temp.path(), &config_path).ok();
                if identity.is_none() {
                    thread::sleep(Duration::from_millis(25));
                }
                identity
            })
            .expect("sleep process identity");
        let ownership_path = temp.path().join(".tethercode/desktop-bridge-process.json");
        let pid_path = temp.path().join(".bridge.pid");
        write_ownership_record(&ownership_path, &ownership).unwrap();
        write_compatibility_pid_file(&pid_path, ownership.pid).unwrap();
        let before = fs::read(&ownership_path).unwrap();

        let runtime = RuntimePaths {
            package_root: temp.path().to_path_buf(),
        };
        let supervisor = BridgeSupervisor::new(temp.path().to_path_buf(), runtime);
        let snapshot = supervisor.snapshot();
        assert_eq!(snapshot.state, BridgeState::Inaccessible);
        assert!(snapshot.managed_process);

        let start_result = supervisor.start().unwrap();
        assert_eq!(start_result.state, BridgeState::Inaccessible);
        assert!(start_result.managed_process);
        assert_eq!(fs::read(&ownership_path).unwrap(), before);
        assert_eq!(
            fs::read_to_string(&pid_path).unwrap().trim(),
            child.id().to_string()
        );
        assert!(child.try_wait().unwrap().is_none());

        let stopped = supervisor.stop().unwrap();
        assert_eq!(stopped.state, BridgeState::Stopped);
        let _ = child.wait();
        assert!(!ownership_path.exists());
        assert!(!pid_path.exists());
        drop(listener);
    }

    #[test]
    fn parses_the_bounded_status_contract() {
        let status: BridgeStatusResponse = serde_json::from_str(
            r#"{
                "status":"degraded",
                "uptimeSec":61,
                "connectedClients":2,
                "agents":[{"lifecycle":"ready"},{"lifecycle":"unavailable"}],
                "operational":{"recentErrors":[{}]}
            }"#,
        )
        .unwrap();

        assert_eq!(status.status, "degraded");
        assert_eq!(status.connected_clients, 2);
        assert_eq!(status.agents.len(), 2);
        assert_eq!(status.operational.recent_errors.len(), 1);
    }
}
