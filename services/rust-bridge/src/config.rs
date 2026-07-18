use std::{collections::HashSet, env, path::PathBuf};

use axum::http::HeaderMap;
use reqwest::Url;

use crate::{normalize_path, BridgeRuntimeEngine};

pub(crate) const DEFAULT_WS_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_PER_CLIENT_IN_FLIGHT: usize = 16;
pub(crate) const DEFAULT_WS_GLOBAL_IN_FLIGHT: usize = 128;

#[derive(Clone)]
pub(crate) struct BridgeConfig {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) preview_port: u16,
    pub(crate) connect_url: Option<String>,
    pub(crate) preview_connect_url: Option<String>,
    pub(crate) workdir: PathBuf,
    pub(crate) cli_bin: String,
    pub(crate) opencode_cli_bin: String,
    pub(crate) cursor_app_server_bin: String,
    pub(crate) active_engine: BridgeRuntimeEngine,
    pub(crate) enabled_engines: Vec<BridgeRuntimeEngine>,
    pub(crate) opencode_host: String,
    pub(crate) opencode_port: u16,
    pub(crate) opencode_server_username: String,
    pub(crate) opencode_server_password: Option<String>,
    pub(crate) auth_token: Option<String>,
    pub(crate) auth_enabled: bool,
    pub(crate) allow_insecure_no_auth: bool,
    pub(crate) allow_query_token_auth: bool,
    pub(crate) allow_outside_root_cwd: bool,
    pub(crate) disable_terminal_exec: bool,
    pub(crate) terminal_allowed_commands: HashSet<String>,
    pub(crate) show_pairing_qr: bool,
    pub(crate) ws_limits: WebSocketResourceLimits,
}

#[derive(Debug, Clone)]
pub(crate) struct WebSocketResourceLimits {
    pub(crate) max_frame_bytes: usize,
    pub(crate) max_message_bytes: usize,
    pub(crate) per_client_in_flight: usize,
    pub(crate) global_in_flight: usize,
}

impl BridgeConfig {
    pub(crate) fn from_env() -> Result<Self, String> {
        let host = env::var("BRIDGE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("BRIDGE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8787);
        let preview_port = env::var("BRIDGE_PREVIEW_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or_else(|| port.checked_add(1).unwrap_or(8788));
        if preview_port == port {
            return Err("BRIDGE_PREVIEW_PORT must differ from BRIDGE_PORT".to_string());
        }
        let connect_url = parse_connect_url_env("BRIDGE_CONNECT_URL")?;
        let preview_connect_url = parse_connect_url_env("BRIDGE_PREVIEW_CONNECT_URL")?;

        let configured_workdir = env::var("BRIDGE_WORKDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let workdir = resolve_bridge_workdir(configured_workdir)?;

        let cli_bin = env::var("CODEX_CLI_BIN").unwrap_or_else(|_| "codex".to_string());
        let opencode_cli_bin =
            env::var("OPENCODE_CLI_BIN").unwrap_or_else(|_| "opencode".to_string());
        let cursor_app_server_bin =
            env::var("CURSOR_APP_SERVER_BIN").unwrap_or_else(|_| "cursor-app-server".to_string());
        let requested_active_engine = match env::var("BRIDGE_ACTIVE_ENGINE") {
            Ok(raw) => parse_bridge_runtime_engine(raw.trim())
                .ok_or_else(|| format!("unsupported BRIDGE_ACTIVE_ENGINE value: {raw}"))?,
            Err(_) => BridgeRuntimeEngine::Codex,
        };
        let enabled_engines = parse_enabled_bridge_engines_env()?
            .unwrap_or_else(|| legacy_default_enabled_engines(requested_active_engine));
        let active_engine = if enabled_engines.contains(&requested_active_engine) {
            requested_active_engine
        } else {
            enabled_engines[0]
        };
        let opencode_host =
            env::var("BRIDGE_OPENCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let opencode_port = env::var("BRIDGE_OPENCODE_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(4090);
        let auth_token = env::var("BRIDGE_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let opencode_server_username = env::var("BRIDGE_OPENCODE_SERVER_USERNAME")
            .or_else(|_| env::var("OPENCODE_SERVER_USERNAME"))
            .unwrap_or_else(|_| "opencode".to_string())
            .trim()
            .to_string();
        let opencode_server_password = env::var("BRIDGE_OPENCODE_SERVER_PASSWORD")
            .or_else(|_| env::var("OPENCODE_SERVER_PASSWORD"))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or_else(|| auth_token.clone());

        let allow_insecure_no_auth = parse_bool_env("BRIDGE_ALLOW_INSECURE_NO_AUTH");
        if auth_token.is_none() && !allow_insecure_no_auth {
            return Err(
                "BRIDGE_AUTH_TOKEN is required. Set BRIDGE_ALLOW_INSECURE_NO_AUTH=true only for local development."
                    .to_string(),
            );
        }

        let auth_enabled = auth_token.is_some();
        let allow_query_token_auth = parse_bool_env("BRIDGE_ALLOW_QUERY_TOKEN_AUTH");
        let allow_outside_root_cwd =
            parse_bool_env_with_default("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", true);
        let disable_terminal_exec = parse_bool_env("BRIDGE_DISABLE_TERMINAL_EXEC");
        let show_pairing_qr = parse_bool_env_with_default("BRIDGE_SHOW_PAIRING_QR", true);
        let ws_limits = WebSocketResourceLimits::from_env()?;

        let terminal_allowed_commands = parse_csv_env(
            "BRIDGE_TERMINAL_ALLOWED_COMMANDS",
            &["pwd", "ls", "cat", "git"],
        );

        Ok(Self {
            host,
            port,
            preview_port,
            connect_url,
            preview_connect_url,
            workdir,
            cli_bin,
            opencode_cli_bin,
            cursor_app_server_bin,
            active_engine,
            enabled_engines,
            opencode_host,
            opencode_port,
            opencode_server_username,
            opencode_server_password,
            auth_token,
            auth_enabled,
            allow_insecure_no_auth,
            allow_query_token_auth,
            allow_outside_root_cwd,
            disable_terminal_exec,
            terminal_allowed_commands,
            show_pairing_qr,
            ws_limits,
        })
    }

    pub(crate) fn is_authorized(&self, headers: &HeaderMap, query_token: Option<&str>) -> bool {
        if !self.auth_enabled {
            return true;
        }

        self.is_authorized_with_bridge_token(headers, query_token)
    }

    pub(crate) fn is_authorized_with_bridge_token(
        &self,
        headers: &HeaderMap,
        query_token: Option<&str>,
    ) -> bool {
        let expected = match &self.auth_token {
            Some(token) => token,
            None => return false,
        };

        if let Some(token) = extract_bearer_token(headers) {
            if constant_time_eq(token, expected) {
                return true;
            }
        }

        if self.allow_query_token_auth {
            if let Some(token) = query_token.map(str::trim).filter(|token| !token.is_empty()) {
                if constant_time_eq(token, expected) {
                    return true;
                }
            }
        }

        false
    }
}

impl WebSocketResourceLimits {
    pub(crate) fn from_env() -> Result<Self, String> {
        let limits = Self {
            max_frame_bytes: parse_positive_usize_env(
                "BRIDGE_WS_MAX_FRAME_BYTES",
                DEFAULT_WS_MAX_FRAME_BYTES,
            )?,
            max_message_bytes: parse_positive_usize_env(
                "BRIDGE_WS_MAX_MESSAGE_BYTES",
                DEFAULT_WS_MAX_MESSAGE_BYTES,
            )?,
            per_client_in_flight: parse_positive_usize_env(
                "BRIDGE_WS_PER_CLIENT_IN_FLIGHT",
                DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
            )?,
            global_in_flight: parse_positive_usize_env(
                "BRIDGE_WS_GLOBAL_IN_FLIGHT",
                DEFAULT_WS_GLOBAL_IN_FLIGHT,
            )?,
        };
        limits.validate()?;
        Ok(limits)
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.max_frame_bytes > self.max_message_bytes {
            return Err(
                "BRIDGE_WS_MAX_FRAME_BYTES must not exceed BRIDGE_WS_MAX_MESSAGE_BYTES".to_string(),
            );
        }
        if self.per_client_in_flight > self.global_in_flight {
            return Err(
                "BRIDGE_WS_PER_CLIENT_IN_FLIGHT must not exceed BRIDGE_WS_GLOBAL_IN_FLIGHT"
                    .to_string(),
            );
        }
        Ok(())
    }
}

fn extract_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let raw = headers.get("authorization")?.to_str().ok()?;
    let mut parts = raw.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if !scheme.eq_ignore_ascii_case("bearer") || parts.next().is_some() {
        return None;
    }
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

pub(crate) fn constant_time_eq(left: &str, right: &str) -> bool {
    let left_bytes = left.as_bytes();
    let right_bytes = right.as_bytes();
    let max_len = left_bytes.len().max(right_bytes.len());

    let mut diff = left_bytes.len() ^ right_bytes.len();
    for index in 0..max_len {
        let left_byte = *left_bytes.get(index).unwrap_or(&0);
        let right_byte = *right_bytes.get(index).unwrap_or(&0);
        diff |= (left_byte ^ right_byte) as usize;
    }

    diff == 0
}

pub(crate) fn resolve_bridge_workdir(raw_workdir: PathBuf) -> Result<PathBuf, String> {
    if !raw_workdir.is_absolute() {
        return Err(format!(
            "BRIDGE_WORKDIR must be an absolute path (got: {})",
            raw_workdir.to_string_lossy()
        ));
    }

    let canonical = std::fs::canonicalize(&raw_workdir).map_err(|error| {
        format!(
            "BRIDGE_WORKDIR is invalid or inaccessible ({}): {error}",
            raw_workdir.to_string_lossy()
        )
    })?;

    Ok(normalize_path(&canonical))
}

pub(crate) fn parse_bool_env(name: &str) -> bool {
    env::var(name)
        .map(|v| v.trim().eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub(crate) fn parse_bool_env_with_default(name: &str, default: bool) -> bool {
    env::var(name)
        .map(|raw| {
            let value = raw.trim();
            if value.eq_ignore_ascii_case("true") {
                true
            } else if value.eq_ignore_ascii_case("false") {
                false
            } else {
                default
            }
        })
        .unwrap_or(default)
}

pub(crate) fn parse_positive_usize_env(name: &str, default: usize) -> Result<usize, String> {
    let Some(raw) = env::var(name).ok() else {
        return Ok(default);
    };
    let value = raw
        .trim()
        .parse::<usize>()
        .map_err(|_| format!("{name} must be a positive integer"))?;
    if value == 0 {
        return Err(format!("{name} must be greater than zero"));
    }
    Ok(value)
}

pub(crate) fn normalize_connect_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parsed = Url::parse(trimmed).ok()?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return None,
    }
    if parsed.host_str().is_none() || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }

    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    let final_path = if normalized_path.is_empty() {
        ""
    } else {
        normalized_path.as_str()
    };
    parsed.set_path(final_path);
    parsed.set_query(None);
    parsed.set_fragment(None);

    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn parse_connect_url_env(name: &str) -> Result<Option<String>, String> {
    let Some(raw) = env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };

    normalize_connect_url(&raw)
        .ok_or_else(|| format!("{name} must be a valid http:// or https:// base URL"))
        .map(Some)
}

fn parse_csv_env(name: &str, fallback: &[&str]) -> HashSet<String> {
    match env::var(name) {
        Ok(raw) => raw
            .split(',')
            .map(|entry| entry.trim())
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect(),
        Err(_) => fallback.iter().map(|entry| entry.to_string()).collect(),
    }
}

pub(crate) fn parse_enabled_bridge_engines_csv(
    raw: &str,
) -> Result<Vec<BridgeRuntimeEngine>, String> {
    let mut parsed = Vec::new();
    let mut seen = HashSet::new();
    for entry in raw.split(',') {
        let normalized = entry.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        let Some(engine) = parse_bridge_runtime_engine(&normalized) else {
            continue;
        };
        if seen.insert(engine) {
            parsed.push(engine);
        }
    }

    if parsed.is_empty() {
        return Err(
            "BRIDGE_ENABLED_ENGINES must include one or more of: codex, opencode, cursor"
                .to_string(),
        );
    }

    Ok(parsed)
}

fn parse_enabled_bridge_engines_env() -> Result<Option<Vec<BridgeRuntimeEngine>>, String> {
    let raw = match env::var("BRIDGE_ENABLED_ENGINES") {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };

    Ok(Some(parse_enabled_bridge_engines_csv(&raw)?))
}

pub(crate) fn legacy_default_enabled_engines(
    requested_active_engine: BridgeRuntimeEngine,
) -> Vec<BridgeRuntimeEngine> {
    vec![requested_active_engine]
}

pub(crate) fn parse_bridge_runtime_engine(value: &str) -> Option<BridgeRuntimeEngine> {
    match value.trim().to_ascii_lowercase().as_str() {
        "codex" => Some(BridgeRuntimeEngine::Codex),
        "opencode" => Some(BridgeRuntimeEngine::Opencode),
        "cursor" => Some(BridgeRuntimeEngine::Cursor),
        _ => None,
    }
}
