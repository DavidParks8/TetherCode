use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, bail, Context, Result};

#[derive(Clone, Debug)]
pub struct RuntimePaths {
    pub package_root: PathBuf,
}

impl RuntimePaths {
    pub fn discover() -> Result<Self> {
        let mut candidates = Vec::new();
        if let Ok(executable) = std::env::current_exe() {
            candidates.extend(platform_runtime_candidates(&executable));
        }

        #[cfg(debug_assertions)]
        {
            if let Some(package_root) = std::env::var_os("TETHERCODE_PACKAGE_ROOT") {
                candidates.push(PathBuf::from(package_root));
            }
            candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."));
            if let Ok(current_dir) = std::env::current_dir() {
                candidates.push(current_dir);
            }
        }

        for candidate in candidates {
            let Ok(package_root) = candidate.canonicalize() else {
                continue;
            };
            let contains_bridge = package_root.join("bin/tethercode-bridge").is_file()
                || cfg!(debug_assertions)
                    && package_root
                        .join("services/rust-bridge/Cargo.toml")
                        .is_file();
            if !contains_bridge {
                continue;
            }
            return Ok(Self { package_root });
        }

        bail!("TetherCode runtime resources were not found; reinstall the desktop app")
    }

    #[cfg(not(debug_assertions))]
    pub fn bridge_binary_candidates(&self) -> Vec<PathBuf> {
        let binary_name = if cfg!(windows) {
            "tethercode-bridge.exe"
        } else {
            "tethercode-bridge"
        };
        vec![self.package_root.join("bin").join(binary_name)]
    }

    #[cfg(debug_assertions)]
    pub fn bridge_binary_candidates(&self) -> Vec<PathBuf> {
        let binary_name = if cfg!(windows) {
            "tethercode-bridge.exe"
        } else {
            "tethercode-bridge"
        };
        let mut candidates = vec![self.package_root.join("bin").join(binary_name)];
        if let Some(target) = runtime_target() {
            candidates.push(
                self.package_root
                    .join("vendor/bridge-binaries")
                    .join(target)
                    .join(binary_name),
            );
        }
        candidates.push(
            self.package_root
                .join("services/rust-bridge/target/release")
                .join(binary_name),
        );
        candidates
    }
}

#[cfg(target_os = "macos")]
fn platform_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    executable
        .parent()
        .and_then(Path::parent)
        .map(|resources| vec![resources.to_path_buf()])
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn platform_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    executable
        .parent()
        .map(|directory| vec![directory.join("runtime")])
        .unwrap_or_default()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_runtime_candidates(executable: &Path) -> Vec<PathBuf> {
    executable
        .parent()
        .map(|directory| {
            vec![
                directory.join("../share/tethercode/runtime"),
                directory.join("runtime"),
            ]
        })
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn runtime_target() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct BridgeRuntimeConfig {
    pub values: BTreeMap<String, String>,
    pub host: String,
    pub port: u16,
    pub connect_url: String,
    pub auth_token: String,
}

impl BridgeRuntimeConfig {
    pub fn load(workspace: &Path) -> Result<Self> {
        let env_path = workspace.join(".env.secure");
        let values = read_env_file(&env_path)
            .with_context(|| format!("failed to read {}", env_path.display()))?;
        let host = value_or(&values, "BRIDGE_HOST", "127.0.0.1");
        let port = value_or(&values, "BRIDGE_PORT", "8787")
            .parse::<u16>()
            .context("BRIDGE_PORT must be between 1 and 65535")?;
        if port == 0 {
            bail!("BRIDGE_PORT must be between 1 and 65535");
        }
        let auth_token = required_value(&values, "BRIDGE_AUTH_TOKEN")?;
        let connect_url = values
            .get("BRIDGE_CONNECT_URL")
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("http://{}:{port}", format_host(&host)));

        let manifest = PathBuf::from(required_value(&values, "ACP_AGENT_MANIFEST")?);
        if !manifest.is_absolute() || !manifest.is_file() {
            bail!("ACP_AGENT_MANIFEST does not name an installed agent manifest");
        }
        let roots: Vec<PathBuf> =
            std::env::split_paths(&required_value(&values, "ACP_AGENT_ROOTS")?).collect();
        if roots.is_empty()
            || roots
                .iter()
                .any(|root| !root.is_absolute() || !root.is_dir())
        {
            bail!("ACP_AGENT_ROOTS does not contain an installed agent root");
        }

        Ok(Self {
            values,
            host,
            port,
            connect_url: connect_url.trim_end_matches('/').to_string(),
            auth_token,
        })
    }

    pub fn local_base_url(&self) -> String {
        let host = match self.host.as_str() {
            "0.0.0.0" | "::" | "[::]" => "127.0.0.1",
            host => host,
        };
        format!("http://{}:{}", format_host(host), self.port)
    }

    pub fn pairing_payload(&self) -> Result<String> {
        Ok(serde_json::to_string(&serde_json::json!({
            "type": "tethercode-bridge-pair",
            "bridgeUrl": self.connect_url,
            "bridgeToken": self.auth_token,
        }))?)
    }
}

pub fn read_env_file(path: &Path) -> Result<BTreeMap<String, String>> {
    let contents = fs::read_to_string(path)?;
    let mut values = BTreeMap::new();
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        if !valid_env_key(key) {
            continue;
        }
        let mut value = raw_value.to_string();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_string();
        }
        values.insert(key.to_string(), value);
    }
    Ok(values)
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    matches!(chars.next(), Some('A'..='Z' | 'a'..='z' | '_'))
        && chars.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn required_value(values: &BTreeMap<String, String>, key: &str) -> Result<String> {
    values
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .ok_or_else(|| anyhow!("{key} is missing from secure bridge configuration"))
}

fn value_or(values: &BTreeMap<String, String>, key: &str, fallback: &str) -> String {
    values
        .get(key)
        .filter(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

fn format_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

pub fn validate_workspace(path: &Path) -> Result<PathBuf> {
    let canonical = path
        .canonicalize()
        .with_context(|| format!("workspace does not exist: {}", path.display()))?;
    if !canonical.is_dir() {
        bail!("workspace must be a directory");
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parses_secure_env_without_interpreting_values() {
        let temp = tempdir().unwrap();
        let env_file = temp.path().join(".env.secure");
        fs::write(
            &env_file,
            "# comment\nexport BRIDGE_HOST='127.0.0.1'\nBRIDGE_AUTH_TOKEN=a=b=c\ninvalid key=no\n",
        )
        .unwrap();

        let values = read_env_file(&env_file).unwrap();
        assert_eq!(values["BRIDGE_HOST"], "127.0.0.1");
        assert_eq!(values["BRIDGE_AUTH_TOKEN"], "a=b=c");
        assert!(!values.contains_key("invalid key"));
    }

    #[test]
    fn builds_ipv6_local_url_and_pairing_payload() {
        let config = BridgeRuntimeConfig {
            values: BTreeMap::new(),
            host: "::1".to_string(),
            port: 8787,
            connect_url: "http://[::1]:8787".to_string(),
            auth_token: "secret".to_string(),
        };

        assert_eq!(config.local_base_url(), "http://[::1]:8787");
        let payload: serde_json::Value =
            serde_json::from_str(&config.pairing_payload().unwrap()).unwrap();
        assert_eq!(payload["type"], "tethercode-bridge-pair");
        assert_eq!(payload["bridgeToken"], "secret");
    }

    #[test]
    fn rejects_missing_agent_roots() {
        let temp = tempdir().unwrap();
        let manifest = temp.path().join("agents.json");
        fs::write(&manifest, "{}").unwrap();
        fs::write(
            temp.path().join(".env.secure"),
            format!(
                "BRIDGE_AUTH_TOKEN=secret\nACP_AGENT_MANIFEST={}\nACP_AGENT_ROOTS={}\n",
                manifest.display(),
                temp.path().join("missing").display()
            ),
        )
        .unwrap();

        assert!(BridgeRuntimeConfig::load(temp.path())
            .unwrap_err()
            .to_string()
            .contains("ACP_AGENT_ROOTS"));
    }
}
