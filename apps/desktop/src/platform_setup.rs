use std::fmt;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetworkMode {
    Tailscale,
    Local,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetupPreflightError {
    MissingTailscale,
    TailscaleDisconnected,
    LanHostRequired,
    InvalidLanHost(String),
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    UnsupportedPlatform(&'static str),
    ProbeFailed(String),
}

impl fmt::Display for SetupPreflightError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingTailscale => write!(formatter, "Tailscale is not installed"),
            Self::TailscaleDisconnected => {
                write!(formatter, "Tailscale is installed but not connected")
            }
            Self::LanHostRequired => write!(formatter, "A local network IPv4 address is required"),
            Self::InvalidLanHost(value) => write!(formatter, "Invalid local IPv4 address: {value}"),
            Self::UnsupportedPlatform(platform) => {
                write!(
                    formatter,
                    "Graphical bridge setup is not yet available on {platform}"
                )
            }
            Self::ProbeFailed(message) => write!(formatter, "Network preflight failed: {message}"),
        }
    }
}

impl std::error::Error for SetupPreflightError {}

pub fn resolve_bridge_host(
    mode: NetworkMode,
    manual_lan_host: Option<&str>,
) -> Result<String, SetupPreflightError> {
    platform::resolve_bridge_host(mode, manual_lan_host)
}

pub fn valid_non_loopback_ipv4(value: &str) -> bool {
    value
        .parse::<std::net::Ipv4Addr>()
        .is_ok_and(|address| !address.is_loopback() && !address.is_unspecified())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;

    use super::{valid_non_loopback_ipv4, NetworkMode, SetupPreflightError};

    pub fn resolve_bridge_host(
        mode: NetworkMode,
        manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError> {
        match mode {
            NetworkMode::Tailscale => resolve_tailscale_host(),
            NetworkMode::Local => resolve_lan_host(manual_lan_host),
        }
    }

    fn resolve_tailscale_host() -> Result<String, SetupPreflightError> {
        let tailscale = command_path("tailscale").ok_or(SetupPreflightError::MissingTailscale)?;
        let output = Command::new(tailscale)
            .args(["ip", "-4"])
            .output()
            .map_err(|error| SetupPreflightError::ProbeFailed(error.to_string()))?;
        if !output.status.success() {
            return Err(SetupPreflightError::TailscaleDisconnected);
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|value| valid_non_loopback_ipv4(value))
            .map(str::to_string)
            .ok_or(SetupPreflightError::TailscaleDisconnected)
    }

    fn resolve_lan_host(manual_lan_host: Option<&str>) -> Result<String, SetupPreflightError> {
        if let Some(manual) = manual_lan_host
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return if valid_non_loopback_ipv4(manual) {
                Ok(manual.to_string())
            } else {
                Err(SetupPreflightError::InvalidLanHost(manual.to_string()))
            };
        }

        for interface in ["en0", "en1"] {
            let output = Command::new("/usr/sbin/ipconfig")
                .args(["getifaddr", interface])
                .output();
            let Ok(output) = output else { continue };
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if output.status.success() && valid_non_loopback_ipv4(&value) {
                return Ok(value);
            }
        }
        Err(SetupPreflightError::LanHostRequired)
    }

    fn command_path(command: &str) -> Option<String> {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Some(path) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&path));
        }
        candidates.extend([
            "/opt/homebrew/bin".into(),
            "/usr/local/bin".into(),
            "/usr/bin".into(),
        ]);
        if command == "tailscale" {
            candidates.push("/Applications/Tailscale.app/Contents/MacOS".into());
        }
        candidates
            .into_iter()
            .map(|directory| directory.join(command))
            .find(|candidate| candidate.is_file())
            .map(|candidate| candidate.display().to_string())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::{NetworkMode, SetupPreflightError};

    pub fn resolve_bridge_host(
        _mode: NetworkMode,
        _manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError> {
        Err(SetupPreflightError::UnsupportedPlatform("Windows"))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use super::{NetworkMode, SetupPreflightError};

    pub fn resolve_bridge_host(
        _mode: NetworkMode,
        _manual_lan_host: Option<&str>,
    ) -> Result<String, SetupPreflightError> {
        Err(SetupPreflightError::UnsupportedPlatform("Linux"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_manual_lan_addresses() {
        assert!(valid_non_loopback_ipv4("192.168.1.20"));
        assert!(valid_non_loopback_ipv4("100.64.0.1"));
        assert!(!valid_non_loopback_ipv4("127.0.0.1"));
        assert!(!valid_non_loopback_ipv4("0.0.0.0"));
        assert!(!valid_non_loopback_ipv4("example.test"));
    }
}
