use std::{collections::HashSet, env, net::IpAddr, path::PathBuf, time::Duration};

use axum::http::{header::ORIGIN, HeaderMap};
use reqwest::Url;

use crate::{path_policy::PathPolicy, services::TerminalExecPolicy};

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
    pub(crate) acp_manifest_path: PathBuf,
    pub(crate) acp_approved_executable_roots: Vec<PathBuf>,
    pub(crate) acp_initialize_timeout: Duration,
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

        let acp_manifest_path = env::var("ACP_AGENT_MANIFEST")
            .map(PathBuf::from)
            .unwrap_or_else(|_| workdir.join(".tethercode/agents.json"));
        let acp_approved_executable_roots =
            parse_path_list_env("ACP_AGENT_ROOTS", &[workdir.join(".tethercode/agents")])?;
        let acp_initialize_timeout =
            Duration::from_millis(parse_positive_u64_env("ACP_INITIALIZE_TIMEOUT_MS", 15_000)?);
        let auth_token = env::var("BRIDGE_AUTH_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
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
            acp_manifest_path,
            acp_approved_executable_roots,
            acp_initialize_timeout,
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

fn parse_positive_u64_env(name: &str, default: u64) -> Result<u64, String> {
    let Some(raw) = env::var(name).ok() else {
        return Ok(default);
    };
    raw.trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("{name} must be a positive integer"))
}

fn parse_path_list_env(name: &str, defaults: &[PathBuf]) -> Result<Vec<PathBuf>, String> {
    let paths = env::var(name)
        .ok()
        .map(|raw| {
            env::split_paths(&raw)
                .filter(|entry| !entry.as_os_str().is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| defaults.to_vec());
    if paths.is_empty() || paths.iter().any(|path| !path.is_absolute()) {
        return Err(format!("{name} must contain absolute paths"));
    }
    Ok(paths)
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

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
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
            acp_manifest_path: PathBuf::from("/tmp/workdir/.tethercode/agents.json"),
            acp_approved_executable_roots: vec![PathBuf::from("/bin")],
            acp_initialize_timeout: Duration::from_secs(15),
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

    #[test]
    fn authorization_covers_bearer_and_query_token_variants() {
        let mut config = no_auth_config("127.0.0.1");
        assert!(config.is_authorized(&HeaderMap::new(), None));

        config.auth_enabled = true;
        assert!(!config.is_authorized(&HeaderMap::new(), None));
        config.auth_token = Some("secret".to_string());

        for raw in [
            "Basic secret",
            "Bearer",
            "Bearer secret extra",
            "Bearer wrong",
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", raw.parse().unwrap());
            assert!(!config.is_authorized(&headers, None), "accepted {raw}");
        }

        let mut headers = HeaderMap::new();
        headers.insert("authorization", "bEaReR secret".parse().unwrap());
        assert!(config.is_authorized(&headers, None));

        config.allow_query_token_auth = true;
        assert!(!config.is_authorized(&HeaderMap::new(), Some("   ")));
        assert!(!config.is_authorized(&HeaderMap::new(), Some("wrong")));
        assert!(config.is_authorized(&HeaderMap::new(), Some(" secret ")));
    }

    #[test]
    fn connect_url_normalization_rejects_unsafe_values_and_strips_suffixes() {
        assert_eq!(normalize_connect_url("   "), None);
        assert_eq!(normalize_connect_url("not a url"), None);
        assert_eq!(normalize_connect_url("ftp://example.com"), None);
        assert_eq!(normalize_connect_url("https://user@example.com"), None);
        assert_eq!(
            normalize_connect_url("https://example.com/"),
            Some("https://example.com".into())
        );
        assert_eq!(
            normalize_connect_url(" https://example.com/base///?query=1#fragment "),
            Some("https://example.com/base".into())
        );
    }

    #[test]
    fn websocket_limits_validate_both_relationships() {
        assert!(WebSocketResourceLimits {
            max_frame_bytes: 2,
            max_message_bytes: 1,
            per_client_in_flight: 1,
            global_in_flight: 1,
        }
        .validate()
        .is_err());
        assert!(WebSocketResourceLimits {
            max_frame_bytes: 1,
            max_message_bytes: 1,
            per_client_in_flight: 2,
            global_in_flight: 1,
        }
        .validate()
        .is_err());
        assert!(WebSocketResourceLimits {
            max_frame_bytes: 1,
            max_message_bytes: 1,
            per_client_in_flight: 1,
            global_in_flight: 1,
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn environment_parsers_cover_missing_valid_and_invalid_values() {
        let suffix = uuid::Uuid::new_v4();
        let bool_name = format!("TETHERCODE_TEST_BOOL_{suffix}");
        let default_bool_name = format!("TETHERCODE_TEST_DEFAULT_BOOL_{suffix}");
        let usize_name = format!("TETHERCODE_TEST_USIZE_{suffix}");
        let url_name = format!("TETHERCODE_TEST_URL_{suffix}");
        let origin_name = format!("TETHERCODE_TEST_ORIGIN_{suffix}");

        assert!(!parse_bool_env(&bool_name));
        unsafe { env::set_var(&bool_name, " TRUE ") };
        assert!(parse_bool_env(&bool_name));
        unsafe { env::set_var(&bool_name, "false") };
        assert!(!parse_bool_env(&bool_name));

        assert!(parse_bool_env_with_default(&default_bool_name, true));
        unsafe { env::set_var(&default_bool_name, "true") };
        assert!(parse_bool_env_with_default(&default_bool_name, false));
        unsafe { env::set_var(&default_bool_name, "false") };
        assert!(!parse_bool_env_with_default(&default_bool_name, true));
        unsafe { env::set_var(&default_bool_name, "invalid") };
        assert!(parse_bool_env_with_default(&default_bool_name, true));

        assert_eq!(parse_positive_usize_env(&usize_name, 7).unwrap(), 7);
        unsafe { env::set_var(&usize_name, "9") };
        assert_eq!(parse_positive_usize_env(&usize_name, 7).unwrap(), 9);
        unsafe { env::set_var(&usize_name, "0") };
        assert!(parse_positive_usize_env(&usize_name, 7).is_err());
        unsafe { env::set_var(&usize_name, "invalid") };
        assert!(parse_positive_usize_env(&usize_name, 7).is_err());

        assert_eq!(parse_connect_url_env(&url_name).unwrap(), None);
        unsafe { env::set_var(&url_name, "  ") };
        assert_eq!(parse_connect_url_env(&url_name).unwrap(), None);
        unsafe { env::set_var(&url_name, "https://example.com/path/") };
        assert_eq!(
            parse_connect_url_env(&url_name).unwrap(),
            Some("https://example.com/path".into())
        );
        unsafe { env::set_var(&url_name, "ftp://example.com") };
        assert!(parse_connect_url_env(&url_name).is_err());

        assert!(parse_origin_csv_env(&origin_name).unwrap().is_empty());
        unsafe { env::set_var(&origin_name, "https://one.example, https://two.example") };
        assert_eq!(parse_origin_csv_env(&origin_name).unwrap().len(), 2);
        unsafe { env::set_var(&origin_name, "https://example.com/path") };
        assert!(parse_origin_csv_env(&origin_name).is_err());

        for name in [
            bool_name,
            default_bool_name,
            usize_name,
            url_name,
            origin_name,
        ] {
            unsafe { env::remove_var(name) };
        }
    }

    #[test]
    fn bridge_config_loads_a_fully_configured_environment() {
        const NAMES: &[&str] = &[
            "BRIDGE_HOST",
            "BRIDGE_PORT",
            "BRIDGE_PREVIEW_HOST",
            "BRIDGE_PREVIEW_PORT",
            "BRIDGE_CONNECT_URL",
            "BRIDGE_PREVIEW_CONNECT_URL",
            "BRIDGE_WORKDIR",
            "ACP_AGENT_MANIFEST",
            "ACP_AGENT_ROOTS",
            "ACP_INITIALIZE_TIMEOUT_MS",
            "BRIDGE_AUTH_TOKEN",
            "BRIDGE_ALLOW_INSECURE_NO_AUTH",
            "BRIDGE_NO_AUTH_ALLOWED_ORIGINS",
            "BRIDGE_ALLOW_QUERY_TOKEN_AUTH",
            "BRIDGE_ALLOW_OUTSIDE_ROOT_CWD",
            "BRIDGE_SHOW_PAIRING_QR",
            "BRIDGE_WS_MAX_FRAME_BYTES",
            "BRIDGE_WS_MAX_MESSAGE_BYTES",
            "BRIDGE_WS_PER_CLIENT_IN_FLIGHT",
            "BRIDGE_WS_GLOBAL_IN_FLIGHT",
            "BRIDGE_TERMINAL_EXEC_POLICIES",
        ];

        struct RestoreEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                for (name, value) in self.0.drain(..) {
                    if let Some(value) = value {
                        unsafe { env::set_var(name, value) };
                    } else {
                        unsafe { env::remove_var(name) };
                    }
                }
            }
        }

        let _restore = RestoreEnv(
            NAMES
                .iter()
                .map(|name| (*name, env::var_os(name)))
                .collect(),
        );
        let root = std::env::temp_dir().join(format!("tethercode-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let values = [
            ("BRIDGE_HOST", "127.0.0.1"),
            ("BRIDGE_PORT", "9000"),
            ("BRIDGE_PREVIEW_HOST", "127.0.0.1"),
            ("BRIDGE_PREVIEW_PORT", "9001"),
            ("BRIDGE_CONNECT_URL", "https://bridge.example/base/"),
            ("BRIDGE_PREVIEW_CONNECT_URL", "https://preview.example/"),
            ("BRIDGE_WORKDIR", root.to_str().unwrap()),
            ("ACP_AGENT_MANIFEST", "/tmp/agents.json"),
            ("ACP_AGENT_ROOTS", "/bin:/usr/bin"),
            ("ACP_INITIALIZE_TIMEOUT_MS", "2500"),
            ("BRIDGE_AUTH_TOKEN", "secret"),
            ("BRIDGE_ALLOW_INSECURE_NO_AUTH", "false"),
            ("BRIDGE_NO_AUTH_ALLOWED_ORIGINS", "https://trusted.example"),
            ("BRIDGE_ALLOW_QUERY_TOKEN_AUTH", "true"),
            ("BRIDGE_ALLOW_OUTSIDE_ROOT_CWD", "false"),
            ("BRIDGE_SHOW_PAIRING_QR", "false"),
            ("BRIDGE_WS_MAX_FRAME_BYTES", "1024"),
            ("BRIDGE_WS_MAX_MESSAGE_BYTES", "2048"),
            ("BRIDGE_WS_PER_CLIENT_IN_FLIGHT", "2"),
            ("BRIDGE_WS_GLOBAL_IN_FLIGHT", "4"),
            ("BRIDGE_TERMINAL_EXEC_POLICIES", "pwd,ls,cat"),
        ];
        for (name, value) in values {
            unsafe { env::set_var(name, value) };
        }

        let config = BridgeConfig::from_env().unwrap();
        assert_eq!(config.port, 9000);
        assert_eq!(config.preview_port, 9001);
        assert_eq!(
            config.connect_url.as_deref(),
            Some("https://bridge.example/base")
        );
        assert_eq!(config.acp_manifest_path, PathBuf::from("/tmp/agents.json"));
        assert_eq!(config.acp_approved_executable_roots.len(), 2);
        assert_eq!(config.acp_initialize_timeout, Duration::from_millis(2500));
        assert!(config.auth_enabled);
        assert!(config.allow_query_token_auth);
        assert!(!config.allow_outside_root_cwd);
        assert_eq!(config.ws_limits.global_in_flight, 4);
        assert_eq!(config.terminal_exec_policies.len(), 3);

        unsafe { env::set_var("BRIDGE_PREVIEW_PORT", "9000") };
        assert!(BridgeConfig::from_env().is_err());
        unsafe {
            env::set_var("BRIDGE_PREVIEW_PORT", "9001");
        }
        assert!(BridgeConfig::from_env().is_ok());

        unsafe {
            env::remove_var("BRIDGE_AUTH_TOKEN");
            env::set_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "false");
        }
        assert!(BridgeConfig::from_env().is_err());
        unsafe {
            env::set_var("BRIDGE_ALLOW_INSECURE_NO_AUTH", "true");
            env::set_var("BRIDGE_HOST", "0.0.0.0");
        }
        assert!(BridgeConfig::from_env().is_err());
        unsafe { env::set_var("BRIDGE_HOST", "127.0.0.1") };
        assert!(!BridgeConfig::from_env().unwrap().auth_enabled);

        assert_eq!(normalize_connect_url("https://user:pass@example.com"), None);
        assert_eq!(normalize_connect_url("https://:pass@example.com"), None);
        assert_eq!(normalize_browser_origin(""), None);
        assert_eq!(
            normalize_browser_origin("https://user:pass@example.com"),
            None
        );
        assert_eq!(
            normalize_browser_origin("https://example.com/#fragment"),
            None
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
