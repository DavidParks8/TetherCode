use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Context, Result};
use getrandom::fill as fill_random;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::config::{read_env_file, validate_workspace};

#[derive(Clone, Debug)]
pub struct SetupRequest {
    pub workspace: PathBuf,
    pub network_mode: String,
    pub bridge_host: String,
    pub bridge_port: u16,
    pub agent_id: String,
    pub display_name: String,
    pub executable: PathBuf,
    pub argv: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub workspace: PathBuf,
    pub bridge_url: String,
    pub agent_id: String,
    pub agent_version: String,
    pub executable: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentManifestSet {
    preferred_agent_id: String,
    agents: Vec<AgentManifest>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentManifest {
    enabled: bool,
    display_name: String,
    icon: Option<String>,
    agent_id: String,
    executable: PathBuf,
    argv: Vec<String>,
    environment: BTreeMap<String, serde_json::Value>,
    resolved_version: String,
    provenance: String,
    verified_digest: String,
    integrity: ExecutableIntegrity,
}

#[derive(Serialize)]
struct ExecutableIntegrity {
    kind: &'static str,
}

pub fn setup_workspace(request: SetupRequest) -> Result<SetupResult> {
    if !valid_agent_id(&request.agent_id) {
        bail!("agent ID may contain only letters, numbers, dots, underscores, and dashes");
    }
    if request.display_name.trim().is_empty() {
        bail!("agent display name must not be empty");
    }
    if !matches!(request.network_mode.as_str(), "local" | "tailscale") {
        bail!("network mode must be local or tailscale");
    }
    if request.bridge_port == 0 || request.bridge_port == u16::MAX {
        bail!("bridge port must leave room for the adjacent preview port");
    }
    let normalized_host = normalize_host(&request.bridge_host)?;
    for argument in &request.argv {
        if argument.contains(['\n', '\r', '\0']) {
            bail!("agent arguments must not contain control characters");
        }
    }

    let workspace = validate_workspace(&request.workspace)?;
    let executable = request.executable.canonicalize().with_context(|| {
        format!(
            "agent executable not found: {}",
            request.executable.display()
        )
    })?;
    if !executable.is_file() {
        bail!("agent executable must be a regular file");
    }
    let executable_root = executable
        .parent()
        .context("agent executable has no parent directory")?
        .to_path_buf();
    let digest = file_digest(&executable)?;
    let version = executable_version(&executable);

    let tethercode_root = workspace.join(".tethercode");
    fs::create_dir_all(&tethercode_root)?;
    let manifest_path = tethercode_root.join("agents.json");
    let manifest = AgentManifestSet {
        preferred_agent_id: request.agent_id.clone(),
        agents: vec![AgentManifest {
            enabled: true,
            display_name: request.display_name.trim().to_string(),
            icon: None,
            agent_id: request.agent_id.clone(),
            executable: executable.clone(),
            argv: request.argv,
            environment: BTreeMap::new(),
            resolved_version: version.clone(),
            provenance: "registered by TetherCode desktop operator".to_string(),
            verified_digest: digest,
            integrity: ExecutableIntegrity { kind: "executable" },
        }],
    };
    atomic_private_write(&manifest_path, &serde_json::to_vec_pretty(&manifest)?)?;

    let env_path = workspace.join(".env.secure");
    let token = existing_token(&env_path).unwrap_or_else(generate_token);
    let preview_port = request.bridge_port + 1;
    let host = normalized_host;
    let authority_host = format_authority_host(&host);
    let bridge_url = format!("http://{authority_host}:{}", request.bridge_port);
    let preview_url = format!("http://{authority_host}:{preview_port}");
    let env = [
        ("BRIDGE_NETWORK_MODE", request.network_mode),
        ("BRIDGE_HOST", host.clone()),
        ("BRIDGE_PORT", request.bridge_port.to_string()),
        ("BRIDGE_PREVIEW_HOST", host),
        ("BRIDGE_PREVIEW_PORT", preview_port.to_string()),
        ("BRIDGE_CONNECT_URL", bridge_url.clone()),
        ("BRIDGE_PREVIEW_CONNECT_URL", preview_url),
        ("BRIDGE_AUTH_TOKEN", token),
        ("BRIDGE_ALLOW_QUERY_TOKEN_AUTH", "true".to_string()),
        (
            "ACP_AGENT_MANIFEST",
            manifest_path.to_string_lossy().to_string(),
        ),
        (
            "ACP_AGENT_ROOTS",
            executable_root.to_string_lossy().to_string(),
        ),
        ("ACP_INITIALIZE_TIMEOUT_MS", "15000".to_string()),
        ("BRIDGE_WORKDIR", workspace.to_string_lossy().to_string()),
    ];
    let mut env_contents = String::new();
    for (key, value) in env {
        validate_env_value(&value)?;
        env_contents.push_str(key);
        env_contents.push('=');
        env_contents.push_str(&value);
        env_contents.push('\n');
    }
    atomic_private_write(&env_path, env_contents.as_bytes())?;

    Ok(SetupResult {
        workspace,
        bridge_url,
        agent_id: request.agent_id,
        agent_version: version,
        executable,
    })
}

pub fn discover_agent_executable(agent_id: &str) -> Option<PathBuf> {
    let executable_name = if cfg!(windows) {
        format!("{agent_id}.exe")
    } else {
        agent_id.to_string()
    };
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        directories.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ]);
    }
    directories
        .into_iter()
        .map(|directory| directory.join(&executable_name))
        .find(|candidate| candidate.is_file())
        .and_then(|candidate| candidate.canonicalize().ok())
}

fn format_authority_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn normalize_host(host: &str) -> Result<String> {
    let host = host.trim();
    if host.trim().is_empty()
        || host.contains(['\n', '\r', '\0', '/', '@'])
        || host.chars().any(char::is_whitespace)
    {
        bail!("bridge host must be a concrete IP address or hostname");
    }
    if host.starts_with('[') || host.ends_with(']') {
        if !(host.starts_with('[') && host.ends_with(']')) {
            bail!("bridge host has malformed IPv6 brackets");
        }
        let inner = &host[1..host.len() - 1];
        if inner.parse::<std::net::Ipv6Addr>().is_err() {
            bail!("bracketed bridge host must be a valid IPv6 address");
        }
        return Ok(inner.to_string());
    }
    Ok(host.to_string())
}

fn validate_env_value(value: &str) -> Result<()> {
    if value.contains(['\n', '\r', '\0']) {
        bail!("generated configuration value contains a control character");
    }
    Ok(())
}

fn valid_agent_id(agent_id: &str) -> bool {
    !agent_id.is_empty()
        && agent_id.len() <= 128
        && agent_id != "."
        && agent_id != ".."
        && agent_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn existing_token(path: &Path) -> Option<String> {
    read_env_file(path)
        .ok()?
        .get("BRIDGE_AUTH_TOKEN")
        .filter(|value| !value.is_empty())
        .cloned()
}

fn generate_token() -> String {
    let mut bytes = [0u8; 24];
    fill_random(&mut bytes).expect("operating system random source is unavailable");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn file_digest(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

fn executable_version(executable: &Path) -> String {
    Command::new(executable)
        .arg("--version")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let value = String::from_utf8_lossy(&output.stdout)
                .lines()
                .next()
                .unwrap_or_default()
                .trim()
                .to_string();
            (!value.is_empty() && value.len() <= 2048).then_some(value)
        })
        .unwrap_or_else(|| "local".to_string())
}

fn atomic_private_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path.parent().context("generated file has no parent")?;
    fs::create_dir_all(parent)?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("state"),
        std::process::id(),
        nonce
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(contents)?;
        if !contents.ends_with(b"\n") {
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_typed_manifest_and_reuses_token() {
        let temp = tempdir().unwrap();
        let executable = PathBuf::from("/bin/echo");
        let request = || SetupRequest {
            workspace: temp.path().to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "192.168.1.20".to_string(),
            bridge_port: 18787,
            agent_id: "echo-agent".to_string(),
            display_name: "Echo Agent".to_string(),
            executable: executable.clone(),
            argv: vec!["acp".to_string()],
        };

        setup_workspace(request()).unwrap();
        let first = read_env_file(&temp.path().join(".env.secure")).unwrap();
        setup_workspace(request()).unwrap();
        let second = read_env_file(&temp.path().join(".env.secure")).unwrap();
        assert_eq!(first["BRIDGE_AUTH_TOKEN"], second["BRIDGE_AUTH_TOKEN"]);
        assert_eq!(first["BRIDGE_HOST"], "192.168.1.20");

        let manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(temp.path().join(".tethercode/agents.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["preferredAgentId"], "echo-agent");
        assert_eq!(manifest["agents"][0]["integrity"]["kind"], "executable");
        assert!(manifest["agents"][0]["verifiedDigest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }

    #[test]
    fn brackets_ipv6_connection_urls_without_changing_bind_host() {
        let temp = tempdir().unwrap();
        setup_workspace(SetupRequest {
            workspace: temp.path().to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "fd00::1".to_string(),
            bridge_port: 18787,
            agent_id: "echo-agent".to_string(),
            display_name: "Echo Agent".to_string(),
            executable: PathBuf::from("/bin/echo"),
            argv: Vec::new(),
        })
        .unwrap();

        let config = read_env_file(&temp.path().join(".env.secure")).unwrap();
        assert_eq!(config["BRIDGE_HOST"], "fd00::1");
        assert_eq!(config["BRIDGE_PREVIEW_HOST"], "fd00::1");
        assert_eq!(config["BRIDGE_CONNECT_URL"], "http://[fd00::1]:18787");
        assert_eq!(
            config["BRIDGE_PREVIEW_CONNECT_URL"],
            "http://[fd00::1]:18788"
        );
    }

    #[test]
    fn normalizes_bracketed_ipv6_before_persisting_bind_hosts() {
        let temp = tempdir().unwrap();
        setup_workspace(SetupRequest {
            workspace: temp.path().to_path_buf(),
            network_mode: "local".to_string(),
            bridge_host: "[::1]".to_string(),
            bridge_port: 18787,
            agent_id: "echo-agent".to_string(),
            display_name: "Echo Agent".to_string(),
            executable: PathBuf::from("/bin/echo"),
            argv: Vec::new(),
        })
        .unwrap();

        let config = read_env_file(&temp.path().join(".env.secure")).unwrap();
        assert_eq!(config["BRIDGE_HOST"], "::1");
        assert_eq!(config["BRIDGE_PREVIEW_HOST"], "::1");
        assert_eq!(config["BRIDGE_CONNECT_URL"], "http://[::1]:18787");
        assert_eq!(config["BRIDGE_PREVIEW_CONNECT_URL"], "http://[::1]:18788");
        assert!(normalize_host("[::1").is_err());
        assert!(normalize_host("::1]").is_err());
    }
}
