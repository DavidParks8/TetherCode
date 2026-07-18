use std::{
    collections::{HashMap, HashSet},
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    time::{Duration, SystemTime},
};

use base64::{engine::general_purpose, Engine as _};
use futures_util::{stream, StreamExt};
use reqwest::{Client as HttpClient, Url};
use serde::Serialize;
use tokio::{process::Command, sync::RwLock, time::timeout};

use crate::{config::constant_time_eq, now_iso, BridgeError};

pub(crate) const BROWSER_PREVIEW_SESSION_TTL: Duration = Duration::from_secs(60 * 60 * 12);
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
    target_url: Url,
    bootstrap_token: String,
    created_at: String,
    last_accessed_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserPreviewResolvedSession {
    pub(crate) target_url: Url,
}

pub(crate) struct BrowserPreviewService {
    bridge_port: u16,
    preview_port: u16,
    preview_base_url: Option<String>,
    available: AtomicBool,
    next_session_counter: AtomicU64,
    pub(crate) http: HttpClient,
    sessions: RwLock<HashMap<String, BrowserPreviewSessionEntry>>,
}

impl BrowserPreviewService {
    pub(crate) fn new(
        bridge_port: u16,
        preview_port: u16,
        preview_base_url: Option<String>,
    ) -> Self {
        Self {
            bridge_port,
            preview_port,
            preview_base_url,
            available: AtomicBool::new(false),
            next_session_counter: AtomicU64::new(1),
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
        target_url: &str,
    ) -> Result<BrowserPreviewSessionResponse, BridgeError> {
        if !self.is_available() {
            return Err(BridgeError::server("browser preview server is unavailable"));
        }

        let target_url = normalize_browser_preview_target_url(target_url)?;
        let created_at = now_iso();
        let session_id = self.next_id("preview-session");
        let bootstrap_token = self.next_id("preview-token");
        let entry = BrowserPreviewSessionEntry {
            id: session_id.clone(),
            target_url,
            bootstrap_token,
            created_at: created_at.clone(),
            last_accessed_at: created_at,
        };

        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        evict_excess_preview_sessions(&mut sessions);
        sessions.insert(session_id, entry.clone());
        Ok(self.to_session_response(&entry))
    }

    pub(crate) async fn list_sessions(&self) -> Vec<BrowserPreviewSessionResponse> {
        let mut sessions = self.sessions.write().await;
        prune_expired_preview_sessions(&mut sessions);
        let mut entries = sessions.values().cloned().collect::<Vec<_>>();
        entries.sort_by(|left, right| right.last_accessed_at.cmp(&left.last_accessed_at));
        entries
            .iter()
            .map(|entry| self.to_session_response(entry))
            .collect()
    }

    pub(crate) async fn close_session(&self, session_id: &str) -> bool {
        self.sessions.write().await.remove(session_id).is_some()
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
        let mut suggestions = stream::iter(candidate_ports.into_iter())
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
            .filter_map(async move |suggestion| suggestion)
            .collect::<Vec<_>>()
            .await;
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
        }
    }

    fn next_id(&self, prefix: &str) -> String {
        let nonce = self.next_session_counter.fetch_add(1, Ordering::Relaxed);
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let raw = format!("{prefix}:{stamp:x}:{nonce:x}");
        general_purpose::URL_SAFE_NO_PAD.encode(raw.as_bytes())
    }
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
    if !matches!(
        host.trim().to_ascii_lowercase().as_str(),
        "localhost" | "127.0.0.1" | "::1"
    ) {
        return Err(BridgeError::invalid_params(
            "browser preview only supports localhost, 127.0.0.1, or ::1 targets",
        ));
    }
    parsed.set_fragment(None);
    if parsed.path().trim().is_empty() {
        parsed.set_path("/");
    }
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
    let cutoff = SystemTime::now()
        .checked_sub(BROWSER_PREVIEW_SESSION_TTL)
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);
    let Some(cutoff_secs) = cutoff else {
        return;
    };
    sessions.retain(|_, entry| {
        chrono::DateTime::parse_from_rfc3339(&entry.last_accessed_at)
            .map(|value| value.timestamp() >= cutoff_secs)
            .unwrap_or(true)
    });
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
