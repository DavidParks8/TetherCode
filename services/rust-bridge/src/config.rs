use std::{collections::HashSet, env, net::IpAddr, path::PathBuf};

use axum::http::{header::ORIGIN, HeaderMap};
use reqwest::Url;

use crate::{path_policy::PathPolicy, services::TerminalExecPolicy, BridgeRuntimeEngine};

pub(crate) const DEFAULT_WS_MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const DEFAULT_WS_PER_CLIENT_IN_FLIGHT: usize = 16;
pub(crate) const DEFAULT_WS_GLOBAL_IN_FLIGHT: usize = 128;

#[derive(Clone)]
pub(crate) struct BridgeConfig {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) preview_host: String,
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
    pub(crate) no_auth_allowed_origins: HashSet<String>,
    pub(crate) allow_query_token_auth: bool,
    pub(crate) allow_outside_root_cwd: bool,
    pub(crate) terminal_exec_policies: HashSet<TerminalExecPolicy>,
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
        let preview_host =
            env::var("BRIDGE_PREVIEW_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
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
        if auth_token.is_none() {
            validate_no_auth_listener(&host)?;
        }

        let auth_enabled = auth_token.is_some();
        let no_auth_allowed_origins = parse_origin_csv_env("BRIDGE_NO_AUTH_ALLOWED_ORIGINS")?;
        let allow_query_token_auth = parse_bool_env("BRIDGE_ALLOW_QUERY_TOKEN_AUTH");
        let allow_outside_root_cwd =
            parse_bool_env_with_default("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", true);
        let show_pairing_qr = parse_bool_env_with_default("BRIDGE_SHOW_PAIRING_QR", true);
        let ws_limits = WebSocketResourceLimits::from_env()?;

        let terminal_exec_policies = parse_terminal_exec_policies_env()?;

        Ok(Self {
            host,
            port,
            preview_host,
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
            no_auth_allowed_origins,
            allow_query_token_auth,
            allow_outside_root_cwd,
            terminal_exec_policies,
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

    pub(crate) fn is_browser_origin_allowed(&self, headers: &HeaderMap) -> bool {
        if self.auth_enabled {
            return true;
        }

        let mut origins = headers.get_all(ORIGIN).iter();
        let Some(raw_origin) = origins.next() else {
            return true;
        };
        if origins.next().is_some() {
            return false;
        }
        let Ok(raw_origin) = raw_origin.to_str() else {
            return false;
        };
        let Some(origin) = normalize_browser_origin(raw_origin) else {
            return false;
        };

        origin == listener_origin(&self.host, self.port)
            || self.no_auth_allowed_origins.contains(&origin)
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
    PathPolicy::new(raw_workdir, false).map(|policy| policy.root().to_path_buf())
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

fn parse_terminal_exec_policies_env() -> Result<HashSet<TerminalExecPolicy>, String> {
    let raw = env::var("BRIDGE_TERMINAL_EXEC_POLICIES").unwrap_or_default();
    parse_terminal_exec_policies(&raw)
}

fn parse_terminal_exec_policies(raw: &str) -> Result<HashSet<TerminalExecPolicy>, String> {
    let mut policies = HashSet::new();
    for entry in raw
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let policy = TerminalExecPolicy::parse(entry).ok_or_else(|| {
            format!(
                "unsupported BRIDGE_TERMINAL_EXEC_POLICIES entry: {entry}; supported policies: pwd, ls, cat"
            )
        })?;
        policies.insert(policy);
    }
    Ok(policies)
}

fn parse_origin_csv_env(name: &str) -> Result<HashSet<String>, String> {
    let Some(raw) = env::var(name).ok() else {
        return Ok(HashSet::new());
    };

    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            normalize_browser_origin(entry).ok_or_else(|| {
                format!(
                    "{name} entries must be exact http:// or https:// origins without paths, credentials, queries, fragments, or wildcards: {entry}"
                )
            })
        })
        .collect()
}

fn normalize_browser_origin(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") || trimmed.contains('*') {
        return None;
    }

    let parsed = Url::parse(trimmed).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }

    Some(parsed.origin().ascii_serialization())
}

fn listener_origin(host: &str, port: u16) -> String {
    let host = host.trim();
    let raw = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("http://[{host}]:{port}")
    } else {
        format!("http://{host}:{port}")
    };
    normalize_browser_origin(&raw).expect("validated listener origin")
}

fn is_strict_loopback_listener(host: &str) -> bool {
    host.trim()
        .parse::<IpAddr>()
        .map(|address| address.is_loopback())
        .unwrap_or(false)
}

fn validate_no_auth_listener(host: &str) -> Result<(), String> {
    if is_strict_loopback_listener(host) {
        Ok(())
    } else {
        Err(
            "BRIDGE_ALLOW_INSECURE_NO_AUTH=true requires BRIDGE_HOST to be a literal loopback IP address (for example 127.0.0.1 or ::1)"
                .to_string(),
        )
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

#[cfg(test)]
mod tests {
    use super::*;

    fn no_auth_config(host: &str) -> BridgeConfig {
        BridgeConfig {
            host: host.to_string(),
            port: 8787,
            preview_host: "127.0.0.1".to_string(),
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: PathBuf::from("/tmp/workdir"),
            cli_bin: "codex".to_string(),
            opencode_cli_bin: "opencode".to_string(),
            cursor_app_server_bin: "cursor-app-server".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: None,
            auth_token: None,
            auth_enabled: false,
            allow_insecure_no_auth: true,
            no_auth_allowed_origins: HashSet::new(),
            allow_query_token_auth: false,
            allow_outside_root_cwd: false,
            terminal_exec_policies: HashSet::new(),
            show_pairing_qr: false,
            ws_limits: WebSocketResourceLimits {
                max_frame_bytes: DEFAULT_WS_MAX_FRAME_BYTES,
                max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
                per_client_in_flight: DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
                global_in_flight: DEFAULT_WS_GLOBAL_IN_FLIGHT,
            },
        }
    }

    fn headers_with_origin(origin: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(ORIGIN, origin.parse().expect("valid test header"));
        headers
    }

    #[test]
    fn no_auth_listener_requires_literal_loopback_ip() {
        for host in ["127.0.0.1", "127.42.0.9", "::1"] {
            assert!(
                validate_no_auth_listener(host).is_ok(),
                "expected {host} to pass"
            );
        }
        for host in ["0.0.0.0", "::", "192.168.1.20", "10.0.0.4", "localhost"] {
            assert!(
                validate_no_auth_listener(host).is_err(),
                "expected {host} to fail"
            );
        }
    }

    #[test]
    fn no_auth_allows_originless_operator_and_native_clients() {
        assert!(no_auth_config("127.0.0.1").is_browser_origin_allowed(&HeaderMap::new()));
    }

    #[test]
    fn no_auth_allows_only_same_or_explicit_exact_browser_origins() {
        let mut config = no_auth_config("127.0.0.1");
        config
            .no_auth_allowed_origins
            .insert("https://trusted.example".to_string());

        assert!(config.is_browser_origin_allowed(&headers_with_origin("http://127.0.0.1:8787")));
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example")));
        assert!(
            !config.is_browser_origin_allowed(&headers_with_origin("https://trusted.example:444"))
        );
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("http://192.168.1.20:8787")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("*")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("null")));

        let mut malformed_origin = HeaderMap::new();
        malformed_origin.insert(
            ORIGIN,
            axum::http::HeaderValue::from_bytes(b"\xff").unwrap(),
        );
        assert!(!config.is_browser_origin_allowed(&malformed_origin));

        let mut duplicate_origins = headers_with_origin("http://127.0.0.1:8787");
        duplicate_origins.append(ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!config.is_browser_origin_allowed(&duplicate_origins));
    }

    #[test]
    fn no_auth_recognizes_ipv6_listener_origin() {
        let config = no_auth_config("::1");
        assert!(config.is_browser_origin_allowed(&headers_with_origin("http://[::1]:8787")));
        assert!(!config.is_browser_origin_allowed(&headers_with_origin("http://127.0.0.1:8787")));
    }

    #[test]
    fn configured_origins_reject_wildcards_null_and_non_origins() {
        assert_eq!(
            normalize_browser_origin("https://trusted.example/"),
            Some("https://trusted.example".to_string())
        );
        for origin in [
            "*",
            "null",
            "https://*.example.com",
            "https://user@example.com",
            "https://example.com/path",
            "https://example.com?query=1",
            "file:///tmp/index.html",
        ] {
            assert!(
                normalize_browser_origin(origin).is_none(),
                "expected {origin} to fail"
            );
        }
    }

    #[test]
    fn authenticated_mode_does_not_apply_no_auth_origin_policy() {
        let mut config = no_auth_config("127.0.0.1");
        config.auth_enabled = true;
        config.auth_token = Some("secret".to_string());
        assert!(config.is_browser_origin_allowed(&headers_with_origin("https://evil.example")));
    }

    #[test]
    fn terminal_policy_parser_is_explicit_and_deny_by_default() {
        assert!(parse_terminal_exec_policies("").unwrap().is_empty());
        assert_eq!(
            parse_terminal_exec_policies(" pwd, cat ").unwrap(),
            HashSet::from([TerminalExecPolicy::Pwd, TerminalExecPolicy::Read])
        );
        assert!(parse_terminal_exec_policies("git").is_err());
    }
}
