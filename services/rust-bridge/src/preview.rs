use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Utc};
use futures_util::{stream, StreamExt};
use getrandom::fill as fill_random;
use reqwest::{Client as HttpClient, Url};
use serde::Serialize;
use tokio::{process::Command, sync::RwLock, time::timeout};

use crate::{config::constant_time_eq, now_iso, BridgeError};

pub(crate) const BROWSER_PREVIEW_SESSION_TTL: Duration = Duration::from_secs(60 * 30);
const BROWSER_PREVIEW_MAX_SESSIONS: usize = 12;
const BROWSER_PREVIEW_DISCOVERY_HTTP_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPreviewSessionResponse {
    session_id: String,
    target_url: String,
    preview_port: u16,
    preview_base_url: Option<String>,
    bootstrap_path: String,
    created_at: String,
    last_accessed_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPreviewDiscoverySuggestion {
    target_url: String,
    port: u16,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserPreviewDiscoveryResponse {
    scanned_at: String,
    suggestions: Vec<BrowserPreviewDiscoverySuggestion>,
}

#[derive(Debug, Clone)]
struct BrowserPreviewSessionEntry {
    id: String,
    owner_client_id: u64,
    target_url: Url,
    bootstrap_token: String,
    created_at: String,
    last_accessed_at: String,
    expires_at: SystemTime,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserPreviewResolvedSession {
    pub(crate) session_id: String,
    pub(crate) target_url: Url,
}

pub(crate) struct BrowserPreviewService {
    bridge_port: u16,
    preview_port: u16,
    preview_base_url: Option<String>,
    secure_cookie: bool,
    available: AtomicBool,
    pub(crate) http: HttpClient,
    sessions: RwLock<HashMap<String, BrowserPreviewSessionEntry>>,
}

impl BrowserPreviewService {
    pub(crate) fn new(
        bridge_port: u16,
        preview_port: u16,
        preview_base_url: Option<String>,
        fallback_connect_url: Option<String>,
    ) -> Self {
        let secure_cookie = preview_base_url
            .as_deref()
            .or(fallback_connect_url.as_deref())
            .and_then(|value| Url::parse(value).ok())
            .is_some_and(|url| url.scheme() == "https");
        Self {
            bridge_port,
            preview_port,
            preview_base_url,
            secure_cookie,
            available: AtomicBool::new(false),
            http: HttpClient::builder()
                .danger_accept_invalid_certs(true)
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("build browser preview client"),
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub(crate) fn is_available(&self) -> bool {
        self.available.load(Ordering::Relaxed)
    }

    pub(crate) fn set_available(&self, available: bool) {
        self.available.store(available, Ordering::Relaxed);
    }

    pub(crate) async fn create_session(
        &self,
        owner_client_id: u64,
        target_url: &str,
    ) -> Result<BrowserPreviewSessionResponse, BridgeError> {
        if !self.is_available() {
            return Err(BridgeError::server("browser preview server is unavailable"));
        }

        let target_url = normalize_browser_preview_target_url(target_url)?;
        let created_at_time = SystemTime::now();
        let expires_at = created_at_time
            .checked_add(BROWSER_PREVIEW_SESSION_TTL)
            .ok_or_else(|| BridgeError::server("could not calculate preview session expiry"))?;
        let created_at = DateTime::<Utc>::from(created_at_time).to_rfc3339();
        let session_id = random_preview_credential(24)?;
        let bootstrap_token = random_preview_credential(32)?;
        let entry = BrowserPreviewSessionEntry {
            id: session_id.clone(),
            owner_client_id,
            target_url,
            bootstrap_token,
            created_at: created_at.clone(),
            last_accessed_at: created_at,
            expires_at,
        };

        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        sessions.retain(|_, existing| existing.owner_client_id != owner_client_id);
        evict_excess_preview_sessions(&mut sessions);
        sessions.insert(session_id, entry.clone());
        Ok(self.to_session_response(&entry))
    }

    pub(crate) async fn list_sessions(
        &self,
        owner_client_id: u64,
    ) -> Vec<BrowserPreviewSessionResponse> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let mut entries = sessions
            .values()
            .filter(|entry| entry.owner_client_id == owner_client_id)
            .cloned()
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| right.last_accessed_at.cmp(&left.last_accessed_at));
        entries
            .iter()
            .map(|entry| self.to_session_response(entry))
            .collect()
    }

    pub(crate) async fn close_session(&self, owner_client_id: u64, session_id: &str) -> bool {
        let mut sessions = self.sessions.write().await;
        let owned = sessions
            .get(session_id)
            .is_some_and(|entry| entry.owner_client_id == owner_client_id);
        owned && sessions.remove(session_id).is_some()
    }

    pub(crate) async fn revoke_owner(&self, owner_client_id: u64) -> usize {
        let mut sessions = self.sessions.write().await;
        let before = sessions.len();
        sessions.retain(|_, entry| entry.owner_client_id != owner_client_id);
        before.saturating_sub(sessions.len())
    }

    pub(crate) fn secure_cookie(&self) -> bool {
        self.secure_cookie
    }

    pub(crate) async fn resolve_bootstrap(
        &self,
        session_id: &str,
        bootstrap_token: &str,
    ) -> Option<BrowserPreviewResolvedSession> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let entry = sessions.get_mut(session_id)?;
        if !constant_time_eq(&entry.bootstrap_token, bootstrap_token) {
            return None;
        }
        entry.last_accessed_at = now_iso();
        Some(BrowserPreviewResolvedSession {
            session_id: entry.id.clone(),
            target_url: entry.target_url.clone(),
        })
    }

    pub(crate) async fn resolve_cookie(
        &self,
        bootstrap_token: &str,
    ) -> Option<BrowserPreviewResolvedSession> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let now = now_iso();
        for entry in sessions.values_mut() {
            if constant_time_eq(&entry.bootstrap_token, bootstrap_token) {
                entry.last_accessed_at = now.clone();
                return Some(BrowserPreviewResolvedSession {
                    session_id: entry.id.clone(),
                    target_url: entry.target_url.clone(),
                });
            }
        }
        None
    }

    pub(crate) async fn discover_targets(&self) -> BrowserPreviewDiscoveryResponse {
        let candidate_ports =
            discover_loopback_listening_ports(&[self.bridge_port, self.preview_port]).await;
        let http = self.http.clone();
        let suggestions = stream::iter(candidate_ports.into_iter())
            .map(|port| {
                let http = http.clone();
                async move {
                    if is_loopback_http_port_reachable(&http, port).await {
                        Some(BrowserPreviewDiscoverySuggestion {
                            target_url: format!("http://127.0.0.1:{port}"),
                            port,
                            label: browser_preview_label_for_port(port),
                        })
                    } else {
                        None
                    }
                }
            })
            .buffer_unordered(24)
            .collect::<Vec<Option<BrowserPreviewDiscoverySuggestion>>>()
            .await;
        let mut suggestions = suggestions.into_iter().flatten().collect::<Vec<_>>();
        suggestions.sort_by_key(|suggestion| suggestion.port);
        BrowserPreviewDiscoveryResponse {
            scanned_at: now_iso(),
            suggestions,
        }
    }

    fn to_session_response(
        &self,
        entry: &BrowserPreviewSessionEntry,
    ) -> BrowserPreviewSessionResponse {
        BrowserPreviewSessionResponse {
            session_id: entry.id.clone(),
            target_url: entry.target_url.to_string(),
            preview_port: self.preview_port,
            preview_base_url: self.preview_base_url.clone(),
            bootstrap_path: build_preview_bootstrap_path(
                &entry.target_url,
                &entry.id,
                &entry.bootstrap_token,
            ),
            created_at: entry.created_at.clone(),
            last_accessed_at: entry.last_accessed_at.clone(),
            expires_at: DateTime::<Utc>::from(entry.expires_at).to_rfc3339(),
        }
    }
}

fn random_preview_credential(byte_len: usize) -> Result<String, BridgeError> {
    let mut bytes = vec![0_u8; byte_len];
    fill_random(&mut bytes).map_err(|error| {
        BridgeError::server(&format!("failed to generate preview credential: {error}"))
    })?;
    Ok(general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn normalize_browser_preview_target_url(raw: &str) -> Result<Url, BridgeError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(BridgeError::invalid_params("targetUrl must not be empty"));
    }
    let mut parsed = Url::parse(trimmed)
        .map_err(|error| BridgeError::invalid_params(&format!("invalid targetUrl: {error}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(BridgeError::invalid_params(
            "targetUrl must use http:// or https://",
        ));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(BridgeError::invalid_params(
            "targetUrl must not include username or password",
        ));
    }
    let Some(host) = parsed.host_str() else {
        return Err(BridgeError::invalid_params("targetUrl host is required"));
    };
    let normalized_host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if !matches!(normalized_host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err(BridgeError::invalid_params(
            "browser preview only supports localhost, 127.0.0.1, or ::1 targets",
        ));
    }
    parsed.set_fragment(None);
    Ok(parsed)
}

fn build_preview_bootstrap_path(
    target_url: &Url,
    session_id: &str,
    bootstrap_token: &str,
) -> String {
    let mut bootstrap_url = target_url.clone();
    bootstrap_url.set_fragment(None);
    let mut query_pairs = bootstrap_url
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect::<Vec<_>>();
    query_pairs.push(("sid".to_string(), session_id.to_string()));
    query_pairs.push(("st".to_string(), bootstrap_token.to_string()));
    bootstrap_url.set_query(None);
    let mut serializer = bootstrap_url.query_pairs_mut();
    for (key, value) in &query_pairs {
        serializer.append_pair(key, value);
    }
    drop(serializer);
    format!(
        "{}{}",
        bootstrap_url.path(),
        bootstrap_url
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default()
    )
}

async fn discover_loopback_listening_ports(excluded_ports: &[u16]) -> Vec<u16> {
    let mut ports = HashSet::new();
    let excluded: HashSet<u16> = excluded_ports.iter().copied().collect();
    if let Some(output) = read_command_stdout("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN"]).await {
        collect_ports_from_lsof(&output, &mut ports);
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(contents) = tokio::fs::read_to_string("/proc/net/tcp").await {
            collect_ports_from_linux_proc_net(&contents, false, &mut ports);
        }
        if let Ok(contents) = tokio::fs::read_to_string("/proc/net/tcp6").await {
            collect_ports_from_linux_proc_net(&contents, true, &mut ports);
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(output) = read_command_stdout("netstat", &["-ano", "-p", "tcp"]).await {
        collect_ports_from_netstat(&output, &mut ports);
    }
    let mut result = ports
        .into_iter()
        .filter(|port| !excluded.contains(port))
        .collect::<Vec<_>>();
    result.sort_unstable();
    result.dedup();
    result
}

async fn read_command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn collect_ports_from_lsof(output: &str, ports: &mut HashSet<u16>) {
    for line in output.lines().filter(|line| line.contains("(LISTEN)")) {
        if let Some(port) = line
            .split(" TCP ")
            .nth(1)
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(parse_listening_socket_port)
        {
            ports.insert(port);
        }
    }
}

#[cfg(target_os = "linux")]
fn collect_ports_from_linux_proc_net(output: &str, is_ipv6: bool, ports: &mut HashSet<u16>) {
    for line in output.lines().skip(1) {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() < 4 || columns[3] != "0A" {
            continue;
        }
        let Some((address_hex, port_hex)) = columns[1].split_once(':') else {
            continue;
        };
        if linux_proc_address_is_loopback_or_any(address_hex, is_ipv6) {
            if let Ok(port) = u16::from_str_radix(port_hex, 16) {
                ports.insert(port);
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_proc_address_is_loopback_or_any(value: &str, is_ipv6: bool) -> bool {
    if !is_ipv6 {
        return matches!(value, "00000000" | "0100007F");
    }
    matches!(
        value,
        "00000000000000000000000000000000"
            | "00000000000000000000000000000001"
            | "00000000000000000000000001000000"
    )
}

#[cfg(target_os = "windows")]
fn collect_ports_from_netstat(output: &str, ports: &mut HashSet<u16>) {
    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if columns.len() >= 4 && columns[0] == "TCP" && columns[3] == "LISTENING" {
            if let Some(port) = parse_listening_socket_port(columns[1]) {
                ports.insert(port);
            }
        }
    }
}

pub(crate) fn parse_listening_socket_port(value: &str) -> Option<u16> {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix('[') {
        let (host, remainder) = rest.split_once(']')?;
        return is_loopback_listen_host(host)
            .then_some(remainder.strip_prefix(':')?.parse::<u16>().ok())?;
    }
    let (host, port) = value.rsplit_once(':')?;
    is_loopback_listen_host(host).then_some(port.parse::<u16>().ok())?
}

fn is_loopback_listen_host(host: &str) -> bool {
    matches!(
        host,
        "*" | "127.0.0.1" | "0.0.0.0" | "::1" | "::" | "localhost"
    )
}

async fn is_loopback_http_port_reachable(http: &HttpClient, port: u16) -> bool {
    let request = http
        .get(format!("http://127.0.0.1:{port}/"))
        .header("accept", "text/html,application/json,*/*");
    timeout(BROWSER_PREVIEW_DISCOVERY_HTTP_TIMEOUT, request.send())
        .await
        .map(|result| result.is_ok())
        .unwrap_or(false)
}

pub(crate) fn browser_preview_label_for_port(port: u16) -> String {
    match port {
        3000..=3005 => format!("Local dev server on :{port}"),
        4173 => "Vite preview on :4173".to_string(),
        4200 => "Angular dev server on :4200".to_string(),
        4321 => "Metro / Expo web on :4321".to_string(),
        5000 => "Local dev server on :5000".to_string(),
        5173 => "Vite dev server on :5173".to_string(),
        5500 => "Live Server on :5500".to_string(),
        8000 => "Local dev server on :8000".to_string(),
        8080 => "Local dev server on :8080".to_string(),
        8081 => "Metro bundler on :8081".to_string(),
        _ => format!("Local dev server on :{port}"),
    }
}

fn prune_expired_preview_sessions(sessions: &mut HashMap<String, BrowserPreviewSessionEntry>) {
    let now = SystemTime::now();
    sessions.retain(|_, entry| entry.expires_at > now);
}

fn evict_excess_preview_sessions(sessions: &mut HashMap<String, BrowserPreviewSessionEntry>) {
    while sessions.len() + 1 > BROWSER_PREVIEW_MAX_SESSIONS {
        let Some(oldest_id) = sessions
            .values()
            .min_by(|left, right| left.last_accessed_at.cmp(&right.last_accessed_at))
            .map(|entry| entry.id.clone())
        else {
            break;
        };
        sessions.remove(&oldest_id);
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn test_service() -> BrowserPreviewService {
        let service = BrowserPreviewService::new(8787, 8788, None, None);
        service.set_available(true);
        service
    }

    #[tokio::test]
    async fn credentials_are_random_and_owner_replacement_is_immediate() {
        let service = test_service();
        let first = service
            .create_session(7, "http://127.0.0.1:3000")
            .await
            .unwrap();
        let second = service
            .create_session(7, "http://127.0.0.1:5173")
            .await
            .unwrap();

        assert_ne!(first.session_id, second.session_id);
        assert!(first.session_id.len() >= 32);
        assert!(second.bootstrap_path.contains("st="));
        assert!(service
            .resolve_bootstrap(&first.session_id, "irrelevant")
            .await
            .is_none());
        assert_eq!(service.list_sessions(7).await.len(), 1);
        assert!(service.list_sessions(8).await.is_empty());
    }

    #[tokio::test]
    async fn unavailable_service_rejects_new_sessions() {
        let service = BrowserPreviewService::new(8787, 8788, None, None);
        assert!(!service.is_available());
        let error = service
            .create_session(7, "http://127.0.0.1:3000")
            .await
            .unwrap_err();
        assert_eq!(error.message, "browser preview server is unavailable");
    }

    #[tokio::test]
    async fn close_and_disconnect_revocation_are_owner_scoped() {
        let service = test_service();
        let session = service
            .create_session(7, "http://127.0.0.1:3000")
            .await
            .unwrap();

        assert!(!service.close_session(8, &session.session_id).await);
        assert_eq!(service.revoke_owner(8).await, 0);
        assert_eq!(service.revoke_owner(7).await, 1);
        assert!(service.list_sessions(7).await.is_empty());
    }

    #[tokio::test]
    async fn bootstrap_and_cookie_resolution_require_the_generated_token() {
        let service = test_service();
        let session = service
            .create_session(7, "http://localhost:3000/path?mode=dev#ignored")
            .await
            .unwrap();
        let token = Url::parse(&format!("http://preview{}", session.bootstrap_path))
            .unwrap()
            .query_pairs()
            .find_map(|(key, value)| (key == "st").then(|| value.into_owned()))
            .unwrap();

        assert!(service.resolve_bootstrap("missing", &token).await.is_none());
        assert!(service
            .resolve_bootstrap(&session.session_id, "wrong")
            .await
            .is_none());
        let resolved = service
            .resolve_bootstrap(&session.session_id, &token)
            .await
            .unwrap();
        assert_eq!(resolved.session_id, session.session_id);
        assert_eq!(
            resolved.target_url.as_str(),
            "http://localhost:3000/path?mode=dev"
        );
        assert!(service.resolve_cookie("wrong").await.is_none());
        assert_eq!(
            service.resolve_cookie(&token).await.unwrap().session_id,
            session.session_id
        );
        assert!(service.close_session(7, &session.session_id).await);
        assert!(service.close_session(7, &session.session_id).await == false);
    }

    #[tokio::test]
    async fn expired_sessions_are_removed_without_access_extending_them() {
        let service = test_service();
        let session = service
            .create_session(7, "http://127.0.0.1:3000")
            .await
            .unwrap();
        service
            .sessions
            .write()
            .await
            .get_mut(&session.session_id)
            .unwrap()
            .expires_at = SystemTime::UNIX_EPOCH;

        assert!(service.list_sessions(7).await.is_empty());
    }

    #[test]
    fn secure_cookie_follows_https_preview_origin() {
        assert!(BrowserPreviewService::new(
            8787,
            8788,
            Some("https://preview.example.com".to_string()),
            None,
        )
        .secure_cookie());
        assert!(BrowserPreviewService::new(
            8787,
            8788,
            None,
            Some("https://bridge.example.com".to_string()),
        )
        .secure_cookie());
        assert!(!BrowserPreviewService::new(8787, 8788, None, None).secure_cookie());
        assert!(
            !BrowserPreviewService::new(8787, 8788, Some("not a URL".to_string()), None,)
                .secure_cookie()
        );
        assert!(!BrowserPreviewService::new(
            8787,
            8788,
            Some("http://preview.example.com".to_string()),
            Some("https://bridge.example.com".to_string()),
        )
        .secure_cookie());
    }

    #[test]
    fn target_url_normalization_accepts_only_safe_loopback_http_urls() {
        assert!(normalize_browser_preview_target_url(" ").is_err());
        assert!(normalize_browser_preview_target_url("not a url").is_err());
        assert!(normalize_browser_preview_target_url("ftp://localhost/file").is_err());
        assert!(normalize_browser_preview_target_url("http://user@localhost/").is_err());
        assert!(normalize_browser_preview_target_url("http://user:pass@localhost/").is_err());
        assert!(normalize_browser_preview_target_url("http://:pass@localhost/").is_err());
        assert!(normalize_browser_preview_target_url("http:///missing").is_err());
        assert!(normalize_browser_preview_target_url("http://example.com/").is_err());

        assert_eq!(
            normalize_browser_preview_target_url(" http://LOCALHOST:3000#fragment ")
                .unwrap()
                .as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_browser_preview_target_url("https://127.0.0.1/path?q=1")
                .unwrap()
                .as_str(),
            "https://127.0.0.1/path?q=1"
        );
        assert_eq!(
            normalize_browser_preview_target_url("http://[::1]:8080")
                .unwrap()
                .as_str(),
            "http://[::1]:8080/"
        );
    }

    #[test]
    fn bootstrap_path_preserves_existing_query_and_encodes_credentials() {
        let target = Url::parse("http://localhost:3000/a%20b?mode=one#fragment").unwrap();
        assert_eq!(
            build_preview_bootstrap_path(&target, "session/id", "token value"),
            "/a%20b?mode=one&sid=session%2Fid&st=token+value"
        );
        let target = Url::parse("http://localhost:3000/").unwrap();
        assert_eq!(
            build_preview_bootstrap_path(&target, "sid", "token"),
            "/?sid=sid&st=token"
        );
    }

    #[test]
    fn socket_parser_rejects_non_loopback_and_malformed_addresses() {
        for (value, expected) in [
            ("*:3000", Some(3000)),
            ("127.0.0.1:5173", Some(5173)),
            ("0.0.0.0:8080", Some(8080)),
            ("localhost:4200", Some(4200)),
            ("[::1]:4321", Some(4321)),
            ("[::]:8000", Some(8000)),
            ("10.0.0.1:3000", None),
            ("[2001:db8::1]:3000", None),
            ("[::1]3000", None),
            ("localhost:not-a-port", None),
            ("missing-port", None),
        ] {
            assert_eq!(parse_listening_socket_port(value), expected, "{value}");
        }
    }

    #[test]
    fn lsof_parser_collects_only_loopback_listeners() {
        let mut ports = HashSet::new();
        collect_ports_from_lsof(
            "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n\
             node 1 user 1u IPv4 0 0t0 TCP 127.0.0.1:3000 (LISTEN)\n\
             node 2 user 1u IPv4 0 0t0 UDP 127.0.0.1:4000\n\
             node 3 user 1u IPv4 0 0t0 TCP 10.0.0.1:5000 (LISTEN)\n\
             malformed TCP missing (LISTEN)",
            &mut ports,
        );
        assert_eq!(ports, HashSet::from([3000]));
    }

    #[tokio::test]
    async fn command_reader_distinguishes_success_failure_and_missing_program() {
        assert_eq!(
            read_command_stdout("/bin/sh", &["-c", "printf success"])
                .await
                .as_deref(),
            Some("success")
        );
        assert!(read_command_stdout("/bin/sh", &["-c", "exit 1"])
            .await
            .is_none());
        assert!(read_command_stdout("/definitely/missing/program", &[])
            .await
            .is_none());
    }

    async fn local_http_server(response: &'static [u8]) -> (u16, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).await;
            socket.write_all(response).await.unwrap();
        });
        (port, task)
    }

    #[tokio::test]
    async fn reachability_accepts_http_errors_but_rejects_closed_ports() {
        let (port, task) = local_http_server(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )
        .await;
        let http = HttpClient::new();
        assert!(is_loopback_http_port_reachable(&http, port).await);
        task.await.unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!is_loopback_http_port_reachable(&http, closed_port).await);
    }

    #[tokio::test]
    async fn discovery_probes_local_listener_and_excludes_bridge_ports() {
        let (port, task) = local_http_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
        )
        .await;
        let service = Arc::new(BrowserPreviewService::new(1, 2, None, None));
        let response = service.discover_targets().await;
        task.await.unwrap();
        assert!(response.suggestions.iter().any(|item| item.port == port));
        assert!(!response
            .suggestions
            .iter()
            .any(|item| item.port == 1 || item.port == 2));
    }

    #[test]
    fn labels_cover_known_and_fallback_ports() {
        for (port, label) in [
            (3000, "Local dev server on :3000"),
            (3005, "Local dev server on :3005"),
            (4173, "Vite preview on :4173"),
            (4200, "Angular dev server on :4200"),
            (4321, "Metro / Expo web on :4321"),
            (5000, "Local dev server on :5000"),
            (5173, "Vite dev server on :5173"),
            (5500, "Live Server on :5500"),
            (8000, "Local dev server on :8000"),
            (8080, "Local dev server on :8080"),
            (8081, "Metro bundler on :8081"),
            (9999, "Local dev server on :9999"),
        ] {
            assert_eq!(browser_preview_label_for_port(port), label);
        }
    }

    #[tokio::test]
    async fn session_capacity_evicts_the_oldest_entry() {
        let service = test_service();
        let mut oldest_id = String::new();
        for owner in 0..=BROWSER_PREVIEW_MAX_SESSIONS {
            let response = service
                .create_session(owner as u64, "http://localhost:3000")
                .await
                .unwrap();
            if owner == 0 {
                oldest_id = response.session_id.clone();
            }
            if let Some(entry) = service.sessions.write().await.get_mut(&response.session_id) {
                entry.last_accessed_at = format!("{owner:04}");
            }
        }
        assert_eq!(
            service.sessions.read().await.len(),
            BROWSER_PREVIEW_MAX_SESSIONS
        );
        assert!(!service.sessions.read().await.contains_key(&oldest_id));
    }
}
