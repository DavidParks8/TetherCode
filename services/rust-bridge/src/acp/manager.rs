use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    ElicitationContentValue, ListSessionsRequest, LoadSessionRequest, NewSessionRequest,
    PromptRequest, ResumeSessionRequest, SessionId,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::storage::atomic_write_private;

use super::config::ResolvedAgentManifest;
#[cfg(test)]
use super::events::CanonicalEvent;
use super::events::{canonical_event_channel, CanonicalEventReceiver, CanonicalEventSender};
use super::identity::AgentSessionId;
use super::interactions::{PendingElicitationSummary, PendingPermissionSummary};
use super::runtime::{
    AcpConnection, AcpRuntimeError, NegotiatedInitialize, PromptAdmission, RequestCancellation,
    SteerRequest,
};
use super::snapshot::{SessionSnapshot, SnapshotPage};

const MAX_AGENTS: usize = 128;
const MAX_SESSIONS: usize = 2_048;
const MAX_PAGE_SIZE: usize = 100;
const MAX_SESSION_LIST_PAGES: usize = 32;
const MAX_ERROR_BYTES: usize = 2_048;
const SESSION_INDEX_VERSION: u64 = 2;
const MAX_SESSION_INDEX_BYTES: usize = 256 * 1024;
const MAX_SESSION_CWD_BYTES: usize = 4_096;
const SESSION_INDEX_FILE: &str = "session-index.json";

pub type AgentId = String;
type AgentStartResult = (
    LocalAgentManifest,
    Result<(AcpConnection, NegotiatedInitialize), AcpRuntimeError>,
);

#[derive(Debug, thiserror::Error)]
pub enum AgentManagerError {
    #[error("invalid local ACP manifest set: {0}")]
    InvalidManifestSet(String),
    #[error("failed to read local ACP manifest set: {0}")]
    ManifestRead(String),
    #[error("preferred ACP agent failed to start: {0}")]
    PreferredStart(String),
    #[error("ACP agent is unavailable: {0}")]
    AgentUnavailable(String),
    #[error("unknown ACP agent: {0}")]
    UnknownAgent(String),
    #[error("invalid opaque ACP thread ID")]
    InvalidThreadId,
    #[error("invalid opaque ACP pagination cursor")]
    InvalidCursor,
    #[error("failed to persist ACP session index: {0}")]
    SessionIndex(String),
    #[error(transparent)]
    Runtime(#[from] AcpRuntimeError),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAgentManifest {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub display_name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(flatten)]
    pub resolved: ResolvedAgentManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalAgentManifestSet {
    pub preferred_agent_id: AgentId,
    pub agents: Vec<LocalAgentManifest>,
}

impl LocalAgentManifestSet {
    pub fn parse(input: &str, approved_roots: &[PathBuf]) -> Result<Self, AgentManagerError> {
        let value: Self = serde_json::from_str(input)
            .map_err(|error| AgentManagerError::InvalidManifestSet(error.to_string()))?;
        value.validate(approved_roots)?;
        Ok(value)
    }

    pub fn load(path: &Path, approved_roots: &[PathBuf]) -> Result<Self, AgentManagerError> {
        let input = std::fs::read_to_string(path)
            .map_err(|error| AgentManagerError::ManifestRead(error.to_string()))?;
        Self::parse(&input, approved_roots)
    }

    fn validate(&self, approved_roots: &[PathBuf]) -> Result<(), AgentManagerError> {
        if self.agents.is_empty() || self.agents.len() > MAX_AGENTS {
            return Err(AgentManagerError::InvalidManifestSet(
                "agent count is outside the supported range".to_string(),
            ));
        }
        let mut ids = HashSet::new();
        let mut enabled = 0usize;
        for agent in &self.agents {
            if !ids.insert(agent.resolved.agent_id.clone()) {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "duplicate agent ID: {}",
                    agent.resolved.agent_id
                )));
            }
            if agent.enabled {
                enabled += 1;
                agent.resolved.validate(approved_roots).map_err(|error| {
                    AgentManagerError::InvalidManifestSet(format!(
                        "{}: {error}",
                        agent.resolved.agent_id
                    ))
                })?;
            }
            if agent.display_name.trim().is_empty() || agent.display_name.len() > 256 {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "invalid display name for {}",
                    agent.resolved.agent_id
                )));
            }
            if !valid_agent_icon(agent.icon.as_deref())
                || agent.resolved.resolved_version.len() > 2_048
                || agent.resolved.provenance.len() > 2_048
            {
                return Err(AgentManagerError::InvalidManifestSet(format!(
                    "descriptor metadata is too large for {}",
                    agent.resolved.agent_id
                )));
            }
        }
        if enabled == 0 {
            return Err(AgentManagerError::InvalidManifestSet(
                "at least one agent must be enabled".to_string(),
            ));
        }
        if !self
            .agents
            .iter()
            .any(|agent| agent.enabled && agent.resolved.agent_id == self.preferred_agent_id)
        {
            return Err(AgentManagerError::InvalidManifestSet(
                "preferred agent is missing or disabled".to_string(),
            ));
        }
        Ok(())
    }
}

fn valid_agent_icon(icon: Option<&str>) -> bool {
    let Some(icon) = icon else { return true };
    if icon.is_empty() || icon.len() > 2_048 {
        return false;
    }
    Url::parse(icon).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentLifecycle {
    Ready,
    Unavailable,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub session_list: bool,
    pub session_load: bool,
    pub session_resume: bool,
    pub session_steer: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub agent_id: AgentId,
    pub display_name: String,
    pub icon: Option<String>,
    pub version: String,
    pub provenance: String,
    pub lifecycle: AgentLifecycle,
    pub last_error: Option<String>,
    pub capabilities: Option<AgentCapabilities>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSession {
    pub thread_id: String,
    pub agent_id: AgentId,
    pub cwd: PathBuf,
    pub snapshot: SessionSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionPage {
    pub sessions: Vec<ManagedSession>,
    pub next_cursor: Option<String>,
    pub partial: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub diagnostics: Vec<SessionListDiagnostic>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionListDiagnostic {
    PageBudgetExhausted,
    MaxSessionsReached,
    NativeListFailed,
    EmptyPage,
    DuplicateOnlyPage,
    RepeatedCursor,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIndexEntry {
    agent_id: AgentId,
    acp_session_id: String,
    cwd: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionIndexFile {
    version: u64,
    sessions: Vec<SessionIndexEntry>,
}

struct DurableSessionIndex {
    path: Option<PathBuf>,
    entries: Vec<SessionIndexEntry>,
    #[cfg(test)]
    fail_writes: bool,
}

impl DurableSessionIndex {
    async fn load(path: Option<PathBuf>) -> Self {
        let Some(path) = path else {
            return Self {
                path: None,
                entries: Vec::new(),
                #[cfg(test)]
                fail_writes: false,
            };
        };
        let entries = match tokio::fs::read(&path).await {
            Ok(bytes) if bytes.len() <= MAX_SESSION_INDEX_BYTES => {
                serde_json::from_slice::<SessionIndexFile>(&bytes)
                    .ok()
                    .filter(|index| index.version == SESSION_INDEX_VERSION)
                    .map(|index| sanitize_index_entries(index.sessions))
                    .unwrap_or_default()
            }
            Ok(_) => {
                eprintln!("ACP session index exceeded its size limit; ignoring it");
                Vec::new()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                eprintln!("failed to load ACP session index: {error}");
                Vec::new()
            }
        };
        Self {
            path: Some(path),
            entries,
            #[cfg(test)]
            fail_writes: false,
        }
    }

    async fn insert_all(
        &mut self,
        entries: impl IntoIterator<Item = SessionIndexEntry>,
    ) -> Result<(), AgentManagerError> {
        let mut staged = self.entries.clone();
        let mut changed = false;
        for entry in entries {
            if let Some(existing) = staged.iter_mut().find(|existing| {
                existing.agent_id == entry.agent_id
                    && existing.acp_session_id == entry.acp_session_id
            }) {
                if *existing != entry {
                    *existing = entry;
                    changed = true;
                }
            } else {
                staged.push(entry);
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        staged.sort();
        if staged.len() > MAX_SESSIONS {
            staged.drain(0..staged.len() - MAX_SESSIONS);
        }
        let Some(path) = &self.path else {
            self.entries = staged;
            return Ok(());
        };
        let bytes = serde_json::to_vec(&SessionIndexFile {
            version: SESSION_INDEX_VERSION,
            sessions: staged.clone(),
        })
        .map_err(|error| AgentManagerError::SessionIndex(error.to_string()))?;
        #[cfg(test)]
        if self.fail_writes {
            return Err(AgentManagerError::SessionIndex(
                "injected session index write failure".to_string(),
            ));
        }
        atomic_write_private(path, &bytes)
            .await
            .map_err(|error| AgentManagerError::SessionIndex(error.to_string()))?;
        self.entries = staged;
        Ok(())
    }
}

fn sanitize_index_entries(entries: Vec<SessionIndexEntry>) -> Vec<SessionIndexEntry> {
    let mut entries = entries
        .into_iter()
        .filter(|entry| {
            AgentSessionId::new(&entry.agent_id, &entry.acp_session_id).is_ok()
                && entry.cwd.is_absolute()
                && entry.cwd.as_os_str().len() <= MAX_SESSION_CWD_BYTES
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries.dedup_by(|left, right| {
        left.agent_id == right.agent_id && left.acp_session_id == right.acp_session_id
    });
    entries.truncate(MAX_SESSIONS);
    entries
}

fn index_entry(identity: AgentSessionId, cwd: PathBuf) -> SessionIndexEntry {
    SessionIndexEntry {
        agent_id: identity.agent_id,
        acp_session_id: identity.acp_session_id,
        cwd,
    }
}

fn empty_managed_session(identity: &AgentSessionId, cwd: PathBuf) -> ManagedSession {
    let thread_id = identity.encode();
    ManagedSession {
        thread_id: thread_id.clone(),
        agent_id: identity.agent_id.clone(),
        cwd,
        snapshot: SessionSnapshot::new(identity.agent_id.clone(), thread_id),
    }
}

fn add_durable_sessions(
    sessions: &mut BTreeMap<String, ManagedSession>,
    durable: &[SessionIndexEntry],
    agent_id: &str,
) {
    for entry in durable.iter().filter(|entry| entry.agent_id == agent_id) {
        if let Ok(identity) = AgentSessionId::new(&entry.agent_id, &entry.acp_session_id) {
            sessions
                .entry(identity.encode())
                .or_insert_with(|| empty_managed_session(&identity, entry.cwd.clone()));
        }
    }
}

struct AgentRuntime {
    manifest: LocalAgentManifest,
    connection: Option<AcpConnection>,
    negotiated: Option<NegotiatedInitialize>,
    lifecycle: AgentLifecycle,
    last_error: Option<String>,
}

pub struct AgentManager {
    agents: HashMap<AgentId, AgentRuntime>,
    preferred_agent_id: AgentId,
    tracked_sessions: Arc<Mutex<HashMap<String, Uuid>>>,
    session_index: Arc<Mutex<DurableSessionIndex>>,
    pending_durable_sessions: Mutex<HashMap<String, SessionIndexEntry>>,
    reconstruction_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    workspace_root: PathBuf,
    allow_outside_root_cwd: bool,
    events: CanonicalEventSender,
    event_receiver: Mutex<Option<CanonicalEventReceiver>>,
    stopped: AtomicBool,
}

impl AgentManager {
    pub async fn start(
        manifests: LocalAgentManifestSet,
        approved_roots: &[PathBuf],
        host_environment: &BTreeMap<String, String>,
        initialize_timeout: Duration,
        storage_root: &Path,
        allow_outside_root_cwd: bool,
    ) -> Result<Self, AgentManagerError> {
        manifests.validate(approved_roots)?;
        let preferred_agent_id = manifests.preferred_agent_id.clone();
        let mut results = Vec::new();
        for manifest in manifests.agents.into_iter().filter(|agent| agent.enabled) {
            let result = AcpConnection::start(
                &manifest.resolved,
                approved_roots,
                host_environment,
                initialize_timeout,
            )
            .await;
            results.push((manifest, result));
        }
        let storage_dir = storage_root.join(".tethercode");
        tokio::fs::create_dir_all(&storage_dir)
            .await
            .map_err(|error| AgentManagerError::SessionIndex(error.to_string()))?;
        Self::from_start_results_with_index(
            preferred_agent_id,
            results,
            Some(storage_dir.join(SESSION_INDEX_FILE)),
            storage_root.to_path_buf(),
            allow_outside_root_cwd,
        )
        .await
    }

    #[cfg(test)]
    async fn from_start_results(
        preferred_agent_id: AgentId,
        results: Vec<AgentStartResult>,
    ) -> Result<Self, AgentManagerError> {
        Self::from_start_results_with_index(
            preferred_agent_id,
            results,
            None,
            std::env::temp_dir(),
            true,
        )
        .await
    }

    async fn from_start_results_with_index(
        preferred_agent_id: AgentId,
        results: Vec<AgentStartResult>,
        session_index_path: Option<PathBuf>,
        workspace_root: PathBuf,
        allow_outside_root_cwd: bool,
    ) -> Result<Self, AgentManagerError> {
        let workspace_root = std::fs::canonicalize(&workspace_root).map_err(|error| {
            AgentManagerError::SessionIndex(format!(
                "session workspace root is invalid or inaccessible ({}): {error}",
                workspace_root.to_string_lossy()
            ))
        })?;
        if let Some((_, Err(error))) = results
            .iter()
            .find(|(manifest, _)| manifest.resolved.agent_id == preferred_agent_id)
        {
            for (_, result) in &results {
                if let Ok((connection, _)) = result {
                    let _ = connection.shutdown().await;
                }
            }
            return Err(AgentManagerError::PreferredStart(redact_error(error)));
        }
        let mut agents = HashMap::new();
        for (manifest, result) in results {
            let agent_id = manifest.resolved.agent_id.clone();
            match result {
                Ok((connection, negotiated)) => {
                    agents.insert(
                        agent_id,
                        AgentRuntime {
                            manifest,
                            connection: Some(connection),
                            negotiated: Some(negotiated),
                            lifecycle: AgentLifecycle::Ready,
                            last_error: None,
                        },
                    );
                }
                Err(error) => {
                    agents.insert(
                        agent_id,
                        AgentRuntime {
                            manifest,
                            connection: None,
                            negotiated: None,
                            lifecycle: AgentLifecycle::Unavailable,
                            last_error: Some(redact_error(&error)),
                        },
                    );
                }
            }
        }
        let (events, event_receiver) = canonical_event_channel(1_024);
        Ok(Self {
            agents,
            preferred_agent_id,
            tracked_sessions: Arc::new(Mutex::new(HashMap::new())),
            session_index: Arc::new(Mutex::new(
                DurableSessionIndex::load(session_index_path).await,
            )),
            pending_durable_sessions: Mutex::new(HashMap::new()),
            reconstruction_locks: Mutex::new(HashMap::new()),
            workspace_root,
            allow_outside_root_cwd,
            events,
            event_receiver: Mutex::new(Some(event_receiver)),
            stopped: AtomicBool::new(false),
        })
    }

    pub fn preferred_agent_id(&self) -> &str {
        &self.preferred_agent_id
    }

    pub fn list_agents(&self) -> Vec<AgentDescriptor> {
        let mut descriptors = self
            .agents
            .values()
            .map(|runtime| {
                let failed = runtime
                    .connection
                    .as_ref()
                    .and_then(AcpConnection::failure_message)
                    .is_some();
                AgentDescriptor {
                    agent_id: runtime.manifest.resolved.agent_id.clone(),
                    display_name: runtime.manifest.display_name.clone(),
                    icon: runtime.manifest.icon.clone(),
                    version: runtime.manifest.resolved.resolved_version.clone(),
                    provenance: runtime.manifest.resolved.provenance.clone(),
                    lifecycle: if self.stopped.load(Ordering::SeqCst) {
                        AgentLifecycle::Stopped
                    } else if failed {
                        AgentLifecycle::Unavailable
                    } else {
                        runtime.lifecycle.clone()
                    },
                    last_error: if failed {
                        Some("ACP agent connection failed (details redacted)".to_string())
                    } else {
                        runtime.last_error.clone()
                    },
                    capabilities: runtime.negotiated.as_ref().map(capabilities),
                }
            })
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.agent_id.cmp(&right.agent_id));
        descriptors
    }

    pub async fn take_events(&self) -> Option<CanonicalEventReceiver> {
        self.event_receiver.lock().await.take()
    }

    pub async fn new_session(
        &self,
        agent_id: &str,
        request: NewSessionRequest,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.new_session_with_cancellation(agent_id, request, RequestCancellation::default())
            .await
    }

    pub async fn new_session_with_cancellation(
        &self,
        agent_id: &str,
        mut request: NewSessionRequest,
        cancellation: RequestCancellation,
    ) -> Result<ManagedSession, AgentManagerError> {
        let cwd = self.validate_cwd(&request.cwd)?;
        request.cwd = cwd.clone();
        let connection = self.connection(agent_id)?;
        let response = connection
            .new_session_with_cancellation(request, cancellation)
            .await?;
        self.track_session(
            AgentSessionId::new(agent_id, response.session_id.to_string())
                .map_err(|_| AgentManagerError::InvalidThreadId)?,
            cwd,
        )
        .await?;
        self.read_known_session(agent_id, &response.session_id)
            .await
    }

    #[cfg(test)]
    pub async fn list_sessions(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ManagedSessionPage, AgentManagerError> {
        self.list_sessions_for(cursor, limit, None).await
    }

    pub async fn list_sessions_for(
        &self,
        cursor: Option<&str>,
        limit: usize,
        agent_filter: Option<&str>,
    ) -> Result<ManagedSessionPage, AgentManagerError> {
        self.flush_pending_durable_sessions().await?;
        let offset = decode_cursor(cursor)?;
        let limit = limit.clamp(1, MAX_PAGE_SIZE);
        let durable = self.session_index.lock().await.entries.clone();
        let mut sessions = BTreeMap::new();
        let mut discovered = Vec::new();
        let mut diagnostics = Vec::new();
        let mut agent_ids = self.agents.keys().cloned().collect::<Vec<_>>();
        agent_ids.sort();
        for agent_id in agent_ids {
            if agent_filter.is_some_and(|filter| filter != agent_id) {
                continue;
            }
            let runtime = &self.agents[&agent_id];
            let Some(connection) = &runtime.connection else {
                add_durable_sessions(&mut sessions, &durable, &agent_id);
                continue;
            };
            if runtime
                .negotiated
                .as_ref()
                .is_some_and(NegotiatedInitialize::supports_session_list)
            {
                let mut remote_cursor = None;
                let mut seen_cursors = HashSet::new();
                for page_index in 0..MAX_SESSION_LIST_PAGES {
                    let response = match connection
                        .list_sessions(ListSessionsRequest::new().cursor(remote_cursor.clone()))
                        .await
                    {
                        Ok(response) => response,
                        Err(_) => {
                            diagnostics.push(SessionListDiagnostic::NativeListFailed);
                            break;
                        }
                    };
                    let sessions_before = sessions.len();
                    let page_was_empty = response.sessions.is_empty();
                    for remote in response.sessions {
                        if let Ok(identity) =
                            AgentSessionId::new(&agent_id, remote.session_id.to_string())
                        {
                            if let Ok(cwd) = self.validate_cwd(&remote.cwd) {
                                discovered.push(index_entry(identity.clone(), cwd.clone()));
                                sessions
                                    .entry(identity.encode())
                                    .or_insert_with(|| empty_managed_session(&identity, cwd));
                            }
                        }
                    }
                    let made_progress = sessions.len() > sessions_before;
                    let Some(next_cursor) = response.next_cursor else {
                        break;
                    };
                    if page_was_empty {
                        diagnostics.push(SessionListDiagnostic::EmptyPage);
                        break;
                    }
                    if !made_progress {
                        diagnostics.push(SessionListDiagnostic::DuplicateOnlyPage);
                        break;
                    }
                    if !seen_cursors.insert(next_cursor.clone()) {
                        diagnostics.push(SessionListDiagnostic::RepeatedCursor);
                        break;
                    }
                    if sessions.len() >= MAX_SESSIONS {
                        diagnostics.push(SessionListDiagnostic::MaxSessionsReached);
                        break;
                    }
                    if page_index + 1 == MAX_SESSION_LIST_PAGES {
                        diagnostics.push(SessionListDiagnostic::PageBudgetExhausted);
                        break;
                    }
                    remote_cursor = Some(next_cursor);
                }
            }
            for session in connection.loaded_sessions().await {
                let snapshot = session.snapshot().await;
                if let Some(entry) = durable.iter().find(|entry| {
                    AgentSessionId::new(&entry.agent_id, &entry.acp_session_id)
                        .is_ok_and(|identity| identity.encode() == snapshot.thread_id)
                }) {
                    sessions.insert(
                        snapshot.thread_id.clone(),
                        ManagedSession {
                            thread_id: snapshot.thread_id.clone(),
                            agent_id: snapshot.agent_id.clone(),
                            cwd: entry.cwd.clone(),
                            snapshot,
                        },
                    );
                }
            }
            add_durable_sessions(&mut sessions, &durable, &agent_id);
        }
        self.session_index
            .lock()
            .await
            .insert_all(discovered)
            .await?;
        let durable_thread_ids = durable
            .iter()
            .filter(|entry| agent_filter.is_none_or(|filter| filter == entry.agent_id))
            .filter_map(|entry| AgentSessionId::new(&entry.agent_id, &entry.acp_session_id).ok())
            .map(|identity| identity.encode())
            .collect::<HashSet<_>>();
        let mut sessions = sessions.into_values().collect::<Vec<_>>();
        if sessions.len() > MAX_SESSIONS {
            diagnostics.push(SessionListDiagnostic::MaxSessionsReached);
            sessions.sort_by(|left, right| {
                let left_durable = durable_thread_ids.contains(&left.thread_id);
                let right_durable = durable_thread_ids.contains(&right.thread_id);
                right_durable
                    .cmp(&left_durable)
                    .then_with(|| left.thread_id.cmp(&right.thread_id))
            });
            sessions.truncate(MAX_SESSIONS);
        }
        sessions.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        let total = sessions.len();
        let sessions = sessions
            .into_iter()
            .skip(offset)
            .take(limit)
            .collect::<Vec<_>>();
        let next_offset = offset.saturating_add(sessions.len());
        diagnostics.dedup();
        Ok(ManagedSessionPage {
            sessions,
            next_cursor: (next_offset < total).then(|| encode_cursor(next_offset)),
            partial: !diagnostics.is_empty(),
            diagnostics,
        })
    }

    pub async fn loaded_session_ids(&self) -> Vec<String> {
        let mut loaded = Vec::new();
        for runtime in self.agents.values() {
            let Some(connection) = &runtime.connection else {
                continue;
            };
            for session in connection.loaded_sessions().await {
                loaded.push(session.snapshot().await.thread_id);
                if loaded.len() == MAX_SESSIONS {
                    break;
                }
            }
            if loaded.len() == MAX_SESSIONS {
                break;
            }
        }
        loaded.sort();
        loaded.dedup();
        loaded
    }

    pub async fn resume_session(
        &self,
        thread_id: &str,
        cwd: impl Into<PathBuf>,
    ) -> Result<ManagedSession, AgentManagerError> {
        let (identity, session_id, connection) = self.route_thread(thread_id)?;
        let cwd = self.validate_cwd(&cwd.into())?;
        if connection.negotiated().supports_session_resume() {
            connection
                .resume_session(ResumeSessionRequest::new(session_id.clone(), cwd.clone()))
                .await?;
        } else if connection.negotiated().supports_session_load() {
            connection
                .load_session(LoadSessionRequest::new(session_id.clone(), cwd.clone()))
                .await?;
        } else {
            return Err(AcpRuntimeError::Unsupported("session/resume or session/load").into());
        }
        self.track_session(identity, cwd).await?;
        self.read_known_session_from(connection, &session_id).await
    }

    pub async fn read_session(&self, thread_id: &str) -> Result<ManagedSession, AgentManagerError> {
        let (identity, session_id, connection) = self.route_thread(thread_id)?;
        let requires_reconstruction = match connection.session(&session_id).await {
            Some(session) => session.snapshot().await.history_reconstruction,
            None => true,
        };
        if requires_reconstruction {
            let entry = self
                .session_index
                .lock()
                .await
                .entries
                .iter()
                .find(|entry| {
                    entry.agent_id == identity.agent_id
                        && entry.acp_session_id == identity.acp_session_id
                })
                .cloned()
                .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
            let operation_lock = {
                let mut locks = self.reconstruction_locks.lock().await;
                locks
                    .entry(thread_id.to_string())
                    .or_insert_with(|| Arc::new(Mutex::new(())))
                    .clone()
            };
            let _operation = operation_lock.lock().await;
            let requires_reconstruction = match connection.session(&session_id).await {
                Some(session) => session.snapshot().await.history_reconstruction,
                None => true,
            };
            if requires_reconstruction {
                let cwd = self.validate_cwd(&entry.cwd)?;
                if connection.negotiated().supports_session_resume() {
                    connection
                        .resume_session(ResumeSessionRequest::new(session_id.clone(), cwd))
                        .await?;
                } else if connection.negotiated().supports_session_load() {
                    connection
                        .load_session(LoadSessionRequest::new(session_id.clone(), cwd))
                        .await?;
                } else {
                    return Err(
                        AcpRuntimeError::Unsupported("session/resume or session/load").into(),
                    );
                }
                self.register_session_events(&identity).await;
            }
        }
        self.read_known_session_from(connection, &session_id).await
    }

    pub async fn snapshot_page(
        &self,
        thread_id: &str,
        before: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<SnapshotPage, AgentManagerError> {
        let session = self.read_session(thread_id).await?;
        session
            .snapshot
            .page(before, after, limit)
            .map_err(|_| AgentManagerError::InvalidCursor)
    }

    pub async fn prompt(
        &self,
        thread_id: &str,
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
        run_id: String,
        source_turn_id: String,
    ) -> Result<PromptAdmission, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        Ok(connection
            .prompt(
                PromptRequest::new(session_id, prompt),
                run_id,
                source_turn_id,
            )
            .await?)
    }

    #[allow(dead_code)]
    pub async fn cancel(&self, thread_id: &str) -> Result<(), AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        connection.cancel(session_id).await?;
        Ok(())
    }

    pub async fn cancel_turn(
        &self,
        thread_id: &str,
        expected_source_turn_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        connection
            .cancel_turn(session_id, expected_source_turn_id)
            .await?;
        Ok(())
    }

    pub async fn prepare_steer(&self, thread_id: &str) -> Result<u64, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        Ok(connection.prepare_steer(&session_id).await?)
    }

    pub async fn verify_steer_epoch(
        &self,
        thread_id: &str,
        epoch: u64,
    ) -> Result<bool, AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        Ok(connection.verify_steer_epoch(&session_id, epoch).await?)
    }

    pub fn supports_steer(&self, thread_id: &str) -> Result<bool, AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        Ok(connection.negotiated().supports_session_steer())
    }

    pub async fn steer(
        &self,
        thread_id: &str,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        interaction_epoch: u64,
        prompt: Vec<agent_client_protocol::schema::v1::ContentBlock>,
    ) -> Result<(), AgentManagerError> {
        let (_, session_id, connection) = self.route_thread(thread_id)?;
        connection
            .steer(
                SteerRequest {
                    session_id,
                    expected_run_id,
                    expected_source_turn_id,
                    prompt_generation,
                    prompt,
                },
                interaction_epoch,
            )
            .await?;
        Ok(())
    }

    pub async fn resolve_permission(
        &self,
        thread_id: &str,
        request_id: &str,
        option_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection
            .resolve_permission(thread_id, request_id, option_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_permission(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection.cancel_permission(thread_id, request_id).await?;
        Ok(())
    }

    pub async fn pending_permissions(&self) -> Vec<PendingPermissionSummary> {
        let mut pending = Vec::new();
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                pending.extend(connection.pending_permissions().await);
            }
        }
        pending.sort_by_key(|request| request.requested_order);
        pending.truncate(MAX_SESSIONS);
        pending
    }

    pub async fn pending_elicitations(&self) -> Vec<PendingElicitationSummary> {
        let mut pending = Vec::new();
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                pending.extend(connection.pending_elicitations().await);
            }
        }
        pending.sort_by_key(|request| request.requested_order);
        pending.truncate(MAX_SESSIONS);
        pending
    }

    pub async fn accept_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
        values: BTreeMap<String, ElicitationContentValue>,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection
            .accept_elicitation(thread_id, request_id, values)
            .await?;
        Ok(())
    }

    pub async fn decline_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection
            .decline_elicitation(thread_id, request_id)
            .await?;
        Ok(())
    }

    pub async fn cancel_elicitation(
        &self,
        thread_id: &str,
        request_id: &str,
    ) -> Result<(), AgentManagerError> {
        let (_, _, connection) = self.route_thread(thread_id)?;
        connection.cancel_elicitation(thread_id, request_id).await?;
        Ok(())
    }

    pub async fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        for runtime in self.agents.values() {
            if let Some(connection) = &runtime.connection {
                let _ = connection.shutdown().await;
            }
        }
    }

    pub async fn flush_events(&self) {
        if let Err(error) = self.flush_pending_durable_sessions().await {
            eprintln!("{error}");
        }
        let tracked = self.tracked_sessions.lock().await.clone();
        for thread_id in tracked.keys() {
            let Ok((_, session_id, connection)) = self.route_thread(thread_id) else {
                continue;
            };
            if let Some(session) = connection.session(&session_id).await {
                session.flush_events().await;
            }
        }
        let _ = self.events.flush().await;
    }

    fn connection(&self, agent_id: &str) -> Result<&AcpConnection, AgentManagerError> {
        let runtime = self
            .agents
            .get(agent_id)
            .ok_or_else(|| AgentManagerError::UnknownAgent(agent_id.to_string()))?;
        runtime
            .connection
            .as_ref()
            .ok_or_else(|| AgentManagerError::AgentUnavailable(agent_id.to_string()))
    }

    fn route_thread(
        &self,
        thread_id: &str,
    ) -> Result<(AgentSessionId, SessionId, &AcpConnection), AgentManagerError> {
        let identity =
            AgentSessionId::decode(thread_id).map_err(|_| AgentManagerError::InvalidThreadId)?;
        let connection = self.connection(&identity.agent_id)?;
        let session_id = SessionId::new(identity.acp_session_id.clone());
        Ok((identity, session_id, connection))
    }

    async fn track_session(
        &self,
        identity: AgentSessionId,
        cwd: PathBuf,
    ) -> Result<(), AgentManagerError> {
        self.register_session_events(&identity).await;
        let thread_id = identity.encode();
        let entry = index_entry(identity, cwd);
        self.pending_durable_sessions
            .lock()
            .await
            .insert(thread_id.clone(), entry.clone());
        self.session_index
            .lock()
            .await
            .insert_all(std::iter::once(entry.clone()))
            .await?;
        let mut pending = self.pending_durable_sessions.lock().await;
        if pending.get(&thread_id) == Some(&entry) {
            pending.remove(&thread_id);
        }
        Ok(())
    }

    async fn flush_pending_durable_sessions(&self) -> Result<(), AgentManagerError> {
        let pending = self
            .pending_durable_sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(());
        }
        self.session_index
            .lock()
            .await
            .insert_all(pending.clone())
            .await?;
        self.pending_durable_sessions
            .lock()
            .await
            .retain(|_, entry| !pending.contains(entry));
        Ok(())
    }

    async fn register_session_events(&self, identity: &AgentSessionId) {
        let thread_id = identity.encode();
        let Ok(connection) = self.connection(&identity.agent_id) else {
            return;
        };
        let session_id = SessionId::new(identity.acp_session_id.clone());
        let Some(session) = connection.session(&session_id).await else {
            return;
        };
        let instance_id = session.instance_id();
        let Some(receiver) = session.take_events().await else {
            return;
        };
        self.tracked_sessions
            .lock()
            .await
            .insert(thread_id.clone(), instance_id);
        let events = self.events.clone();
        let tracked_sessions = self.tracked_sessions.clone();
        tokio::spawn(forward_session_events(
            receiver,
            events,
            tracked_sessions,
            thread_id,
            instance_id,
        ));
    }

    fn validate_cwd(&self, cwd: &Path) -> Result<PathBuf, AgentManagerError> {
        let candidate = if cwd.is_absolute() {
            cwd.to_path_buf()
        } else {
            self.workspace_root.join(cwd)
        };
        let canonical = std::fs::canonicalize(&candidate).map_err(|error| {
            AgentManagerError::SessionIndex(format!(
                "session workspace is invalid or inaccessible ({}): {error}",
                candidate.to_string_lossy()
            ))
        })?;
        if !canonical.is_dir()
            || (!self.allow_outside_root_cwd && !canonical.starts_with(&self.workspace_root))
        {
            return Err(AgentManagerError::SessionIndex(
                "session workspace is outside the allowed root or is not a directory".to_string(),
            ));
        }
        if canonical.as_os_str().len() > MAX_SESSION_CWD_BYTES {
            return Err(AgentManagerError::SessionIndex(
                "session workspace path exceeds the durable index limit".to_string(),
            ));
        }
        Ok(canonical)
    }

    async fn read_known_session(
        &self,
        agent_id: &str,
        session_id: &SessionId,
    ) -> Result<ManagedSession, AgentManagerError> {
        self.read_known_session_from(self.connection(agent_id)?, session_id)
            .await
    }

    async fn read_known_session_from(
        &self,
        connection: &AcpConnection,
        session_id: &SessionId,
    ) -> Result<ManagedSession, AgentManagerError> {
        let session = connection
            .session(session_id)
            .await
            .ok_or_else(|| AcpRuntimeError::UnknownSession(session_id.to_string()))?;
        let snapshot = session.snapshot().await;
        let identity = AgentSessionId::decode(&snapshot.thread_id)
            .map_err(|_| AgentManagerError::InvalidThreadId)?;
        let cwd = self
            .session_index
            .lock()
            .await
            .entries
            .iter()
            .find(|entry| {
                entry.agent_id == identity.agent_id
                    && entry.acp_session_id == identity.acp_session_id
            })
            .map(|entry| entry.cwd.clone())
            .ok_or_else(|| {
                AgentManagerError::SessionIndex(
                    "session has no durable canonical workspace path".to_string(),
                )
            })?;
        Ok(ManagedSession {
            thread_id: snapshot.thread_id.clone(),
            agent_id: snapshot.agent_id.clone(),
            cwd,
            snapshot,
        })
    }
}

fn remove_session_event_registration(
    tracked: &mut HashMap<String, Uuid>,
    thread_id: &str,
    instance_id: Uuid,
) -> bool {
    if tracked.get(thread_id) != Some(&instance_id) {
        return false;
    }
    tracked.remove(thread_id);
    true
}

async fn forward_session_events(
    mut receiver: CanonicalEventReceiver,
    events: CanonicalEventSender,
    tracked_sessions: Arc<Mutex<HashMap<String, Uuid>>>,
    thread_id: String,
    instance_id: Uuid,
) {
    while let Some(event) = receiver.recv().await {
        if events.send(event).await.is_err() {
            eprintln!("ACP manager canonical event mailbox closed during session forwarding");
            break;
        }
    }
    let mut tracked = tracked_sessions.lock().await;
    remove_session_event_registration(&mut tracked, &thread_id, instance_id);
}

fn capabilities(negotiated: &NegotiatedInitialize) -> AgentCapabilities {
    AgentCapabilities {
        session_list: negotiated.supports_session_list(),
        session_load: negotiated.supports_session_load(),
        session_resume: negotiated.supports_session_resume(),
        session_steer: negotiated.supports_session_steer(),
    }
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize, AgentManagerError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    cursor
        .strip_prefix("v1.")
        .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
        .filter(|value| value.len() == std::mem::size_of::<u64>())
        .map(|value| u64::from_be_bytes(value.try_into().expect("cursor length checked")) as usize)
        .filter(|value| *value <= MAX_SESSIONS)
        .ok_or(AgentManagerError::InvalidCursor)
}

fn encode_cursor(offset: usize) -> String {
    format!(
        "v1.{}",
        URL_SAFE_NO_PAD.encode((offset as u64).to_be_bytes())
    )
}

fn redact_error(error: &AcpRuntimeError) -> String {
    let _ = (error, MAX_ERROR_BYTES);
    "ACP agent startup failed (details redacted)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    use agent_client_protocol::schema::v1::{
        AgentCapabilities, CancelNotification, InitializeRequest, InitializeResponse,
        ListSessionsRequest, ListSessionsResponse, LoadSessionResponse, NewSessionResponse,
        PromptResponse, ResumeSessionResponse, SessionCapabilities, SessionInfo,
        SessionListCapabilities, SessionResumeCapabilities, StopReason,
    };
    use agent_client_protocol::Agent;
    use sha2::{Digest, Sha256};
    use tokio::sync::mpsc;

    fn echo_digest() -> String {
        let bytes = std::fs::read("/bin/echo").expect("read /bin/echo");
        format!("sha256:{:x}", Sha256::digest(bytes))
    }

    fn manifest(agent_id: &str, display_name: &str) -> LocalAgentManifest {
        LocalAgentManifest {
            enabled: true,
            display_name: display_name.to_string(),
            icon: Some(format!("https://cdn.example.test/{agent_id}.png")),
            resolved: ResolvedAgentManifest {
                agent_id: agent_id.to_string(),
                executable: PathBuf::from("/bin/echo"),
                argv: vec![],
                environment: BTreeMap::new(),
                resolved_version: "1.2.3".to_string(),
                provenance: "local registry snapshot".to_string(),
                verified_digest: echo_digest(),
                integrity: crate::acp::config::RuntimeIntegrity::Executable,
            },
        }
    }

    #[test]
    fn agent_icons_match_shared_policy_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/agent-icon-policy.json"))
                .expect("parse icon policy fixture");
        for policy_case in fixture["cases"].as_array().expect("icon cases") {
            let value = policy_case["value"].as_str();
            let expected = policy_case["valid"].as_bool().expect("valid flag");
            assert_eq!(
                valid_agent_icon(value),
                expected,
                "{}",
                policy_case["name"].as_str().expect("case name")
            );
        }
        assert!(!valid_agent_icon(Some(&format!(
            "https://example.test/{}",
            "x".repeat(2_048)
        ))));
    }

    async fn connection(
        agent_id: &str,
        supports_list: bool,
        listed_session: &str,
        observed: mpsc::UnboundedSender<String>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let listed_session = listed_session.to_string();
        let new_session = format!("{agent_id}-new");
        let prompt_agent = agent_id.to_string();
        let cancel_agent = agent_id.to_string();
        let capabilities = if supports_list {
            AgentCapabilities::new().session_capabilities(
                SessionCapabilities::new().list(SessionListCapabilities::new()),
            )
        } else {
            AgentCapabilities::new()
        };
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: NewSessionRequest, responder, _| {
                    responder.respond(NewSessionResponse::new(new_session.clone()))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    responder.respond(ListSessionsResponse::new(vec![SessionInfo::new(
                        listed_session.clone(),
                        "/tmp",
                    )]))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let observed = observed.clone();
                    async move |_request: PromptRequest, responder, _| {
                        let _ = observed.send(format!("prompt:{prompt_agent}"));
                        responder.respond(PromptResponse::new(StopReason::EndTurn))
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_notification(
                async move |_request: CancelNotification, _| {
                    let _ = observed.send(format!("cancel:{cancel_agent}"));
                    Ok(())
                },
                agent_client_protocol::on_receive_notification!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("test agent starts")
    }

    async fn connection_with_capabilities(
        agent_id: &str,
        capabilities: AgentCapabilities,
        observed: mpsc::UnboundedSender<String>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let load_agent = agent_id.to_string();
        let resume_agent = agent_id.to_string();
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let observed = observed.clone();
                    async move |_request: LoadSessionRequest, responder, _| {
                        let _ = observed.send(format!("load:{load_agent}"));
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ResumeSessionRequest, responder, _| {
                    let _ = observed.send(format!("resume:{resume_agent}"));
                    responder.respond(ResumeSessionResponse::new())
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("capability agent starts")
    }

    async fn reconstructing_connection(
        agent_id: &str,
        capabilities: AgentCapabilities,
        requests: Arc<std::sync::atomic::AtomicUsize>,
        fail: bool,
        response_barrier: Option<Arc<(tokio::sync::Notify, tokio::sync::Notify)>>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(capabilities.clone()),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let requests = requests.clone();
                    let response_barrier = response_barrier.clone();
                    async move |request: LoadSessionRequest, responder, connection| {
                        requests.fetch_add(1, Ordering::SeqCst);
                        if let Some(barrier) = &response_barrier {
                            barrier.0.notify_one();
                            barrier.1.notified().await;
                        }
                        if fail {
                            return responder.respond_with_error(
                                agent_client_protocol::Error::internal_error(),
                            );
                        }
                        let update = serde_json::from_value(serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "restored"},
                            "messageId": "restored-message"
                        }))
                        .expect("typed update");
                        connection.send_notification(
                            agent_client_protocol::schema::v1::SessionNotification::new(
                                request.session_id,
                                update,
                            ),
                        )?;
                        responder.respond(LoadSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let requests = requests.clone();
                    let response_barrier = response_barrier.clone();
                    async move |request: ResumeSessionRequest, responder, connection| {
                        requests.fetch_add(1, Ordering::SeqCst);
                        if let Some(barrier) = &response_barrier {
                            barrier.0.notify_one();
                            barrier.1.notified().await;
                        }
                        if fail {
                            return responder.respond_with_error(
                                agent_client_protocol::Error::internal_error(),
                            );
                        }
                        let update = serde_json::from_value(serde_json::json!({
                            "sessionUpdate": "agent_message_chunk",
                            "content": {"type": "text", "text": "restored"},
                            "messageId": "restored-message"
                        }))
                        .expect("typed update");
                        connection.send_notification(
                            agent_client_protocol::schema::v1::SessionNotification::new(
                                request.session_id,
                                update,
                            ),
                        )?;
                        responder.respond(ResumeSessionResponse::new())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("reconstructing agent starts")
    }

    async fn paginated_connection(agent_id: &str) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().list(SessionListCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |request: ListSessionsRequest, responder, _| {
                    let response = if request.cursor.as_deref() == Some("page-2") {
                        ListSessionsResponse::new(vec![
                            SessionInfo::new("alpha", "/tmp"),
                            SessionInfo::new("duplicate", "/tmp"),
                        ])
                        .next_cursor("page-2")
                    } else {
                        ListSessionsResponse::new(vec![
                            SessionInfo::new("zulu", "/tmp"),
                            SessionInfo::new("duplicate", "/tmp"),
                            SessionInfo::new("", "/tmp"),
                            SessionInfo::new(
                                "invalid-cwd",
                                "/definitely/missing/tethercode-remote-workspace",
                            ),
                        ])
                        .next_cursor("page-2")
                    };
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("paginated agent starts")
    }

    #[derive(Clone, Copy)]
    enum PaginationFixture {
        Endless,
        Empty,
        DuplicateOnly,
        MaxSessions,
        Failure,
    }

    async fn adversarial_paginated_connection(
        agent_id: &str,
        fixture: PaginationFixture,
        requests: Arc<std::sync::atomic::AtomicUsize>,
    ) -> (AcpConnection, NegotiatedInitialize) {
        let agent = Agent
            .builder()
            .on_receive_request(
                async move |request: InitializeRequest, responder, _| {
                    responder.respond(
                        InitializeResponse::new(request.protocol_version).agent_capabilities(
                            AgentCapabilities::new().session_capabilities(
                                SessionCapabilities::new().list(SessionListCapabilities::new()),
                            ),
                        ),
                    )
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: ListSessionsRequest, responder, _| {
                    let request = requests.fetch_add(1, Ordering::SeqCst);
                    let response = match fixture {
                        PaginationFixture::Endless => {
                            ListSessionsResponse::new(vec![SessionInfo::new(
                                format!("session-{request}"),
                                "/tmp",
                            )])
                            .next_cursor(format!("cursor-{request}"))
                        }
                        PaginationFixture::Empty => ListSessionsResponse::new(Vec::new())
                            .next_cursor(format!("cursor-{request}")),
                        PaginationFixture::DuplicateOnly => {
                            ListSessionsResponse::new(vec![SessionInfo::new("duplicate", "/tmp")])
                                .next_cursor(format!("cursor-{request}"))
                        }
                        PaginationFixture::MaxSessions => ListSessionsResponse::new(
                            (0..MAX_SESSIONS)
                                .map(|index| SessionInfo::new(format!("session-{index}"), "/tmp"))
                                .collect(),
                        ),
                        PaginationFixture::Failure => {
                            return responder
                                .respond_with_error(agent_client_protocol::Error::internal_error())
                        }
                    };
                    responder.respond(response)
                },
                agent_client_protocol::on_receive_request!(),
            );
        AcpConnection::start_transport(agent_id.to_string(), agent, Duration::from_secs(1))
            .await
            .expect("adversarial paginated agent starts")
    }

    #[test]
    fn local_manifest_set_rejects_duplicates_missing_preferred_and_empty_enabled_set() {
        let alpha = manifest("alpha-orbit", "Alpha Orbit");
        let roots = [PathBuf::from("/bin")];
        let duplicate = LocalAgentManifestSet {
            preferred_agent_id: "alpha-orbit".into(),
            agents: vec![alpha.clone(), alpha.clone()],
        };
        assert!(duplicate.validate(&roots).is_err());
        let missing = LocalAgentManifestSet {
            preferred_agent_id: "missing".into(),
            agents: vec![alpha.clone()],
        };
        assert!(missing.validate(&roots).is_err());
        let mut disabled = alpha;
        disabled.enabled = false;
        let empty = LocalAgentManifestSet {
            preferred_agent_id: "alpha-orbit".into(),
            agents: vec![disabled],
        };
        assert!(empty.validate(&roots).is_err());
    }

    #[test]
    fn local_manifest_requires_executable_digest_and_typed_integrity() {
        let value = serde_json::to_value(LocalAgentManifestSet {
            preferred_agent_id: "alpha-orbit".into(),
            agents: vec![manifest("alpha-orbit", "Alpha Orbit")],
        })
        .expect("serialize manifest");
        let mut missing = value.clone();
        missing["agents"][0]
            .as_object_mut()
            .expect("agent object")
            .remove("verifiedDigest");
        assert!(LocalAgentManifestSet::parse(
            &serde_json::to_string(&missing).expect("serialize missing digest"),
            &[PathBuf::from("/bin")]
        )
        .is_err());

        let mut missing_integrity = value;
        missing_integrity["agents"][0]
            .as_object_mut()
            .expect("agent object")
            .remove("integrity");
        assert!(LocalAgentManifestSet::parse(
            &serde_json::to_string(&missing_integrity).expect("serialize missing integrity"),
            &[PathBuf::from("/bin")]
        )
        .is_err());
    }

    #[tokio::test]
    async fn preferred_failure_is_fatal_and_nonpreferred_failure_is_visible_and_redacted() {
        let preferred = manifest("alpha-orbit", "Alpha Orbit");
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let sibling = connection("beta-lab", false, "unused", observed_tx).await;
        let result = AgentManager::from_start_results(
            "alpha-orbit".into(),
            vec![
                (manifest("beta-lab", "Beta Lab"), Ok(sibling)),
                (
                    preferred,
                    Err(AcpRuntimeError::Connection("/secret/token=value".into())),
                ),
            ],
        )
        .await;
        assert!(matches!(result, Err(AgentManagerError::PreferredStart(_))));

        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("alpha-orbit", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha-orbit".into(),
            vec![
                (manifest("alpha-orbit", "Alpha Orbit"), Ok(ready)),
                (
                    manifest("beta-lab", "Beta Lab"),
                    Err(AcpRuntimeError::Connection("/secret/token=value".into())),
                ),
            ],
        )
        .await
        .expect("nonpreferred failure is nonfatal");
        let beta = manager
            .list_agents()
            .into_iter()
            .find(|agent| agent.agent_id == "beta-lab")
            .unwrap();
        assert_eq!(beta.lifecycle, AgentLifecycle::Unavailable);
        assert_eq!(
            beta.last_error.as_deref(),
            Some("ACP agent startup failed (details redacted)")
        );
        assert!(!serde_json::to_string(&beta).unwrap().contains("secret"));
    }

    #[tokio::test]
    async fn generic_routing_opaque_pagination_fallback_interactions_and_shutdown() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let alpha = connection("alpha-orbit", true, "alpha-history", observed_tx.clone()).await;
        let beta = connection("beta-lab", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "alpha-orbit".into(),
            vec![
                (manifest("alpha-orbit", "Alpha Orbit"), Ok(alpha)),
                (manifest("beta-lab", "Beta Lab"), Ok(beta)),
            ],
        )
        .await
        .expect("manager starts");
        assert_eq!(manager.preferred_agent_id(), "alpha-orbit");
        assert_eq!(manager.list_agents().len(), 2);

        let beta_session = manager
            .new_session("beta-lab", NewSessionRequest::new("/tmp"))
            .await
            .expect("explicit beta session");
        let decoded = AgentSessionId::decode(&beta_session.thread_id).unwrap();
        assert_eq!(decoded.agent_id, "beta-lab");
        assert_eq!(decoded.acp_session_id, "beta-lab-new");

        assert_eq!(
            manager.loaded_session_ids().await,
            vec![beta_session.thread_id.clone()]
        );

        let first_page = manager.list_sessions(None, 1).await.unwrap();
        assert_eq!(first_page.sessions.len(), 1);
        assert_eq!(first_page.next_cursor, Some(encode_cursor(1)));
        let second_page = manager
            .list_sessions(Some(&encode_cursor(1)), 100)
            .await
            .unwrap();
        assert_eq!(second_page.sessions.len(), 1);
        let listed = [
            first_page.sessions[0].clone(),
            second_page.sessions[0].clone(),
        ];
        assert!(listed.iter().any(|session| {
            AgentSessionId::decode(&session.thread_id)
                .is_ok_and(|identity| identity.acp_session_id == "alpha-history")
        }));
        assert!(listed
            .iter()
            .any(|session| session.thread_id == beta_session.thread_id));
        assert_eq!(
            manager.loaded_session_ids().await,
            vec![beta_session.thread_id.clone()]
        );

        let fallback_id = AgentSessionId::new("beta-lab", "opaque/unknown:session")
            .unwrap()
            .encode();
        assert!(matches!(
            manager.read_session(&fallback_id).await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::UnknownSession(
                _
            )))
        ));
        assert_eq!(
            manager.loaded_session_ids().await,
            vec![beta_session.thread_id.clone()]
        );
        assert!(matches!(
            manager.resume_session(&fallback_id, "/tmp").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/resume or session/load"
            )))
        ));

        let mut events = manager.take_events().await.expect("manager event receiver");
        manager
            .prompt(
                &beta_session.thread_id,
                vec!["hello".into()],
                "run-beta".into(),
                "turn-beta".into(),
            )
            .await
            .unwrap();
        assert_eq!(observed_rx.recv().await.as_deref(), Some("prompt:beta-lab"));
        let started = events.recv().await.unwrap();
        assert!(
            matches!(started, CanonicalEvent::RunStarted { agent_id, .. } if agent_id == "beta-lab")
        );
        assert!(matches!(
            manager.cancel_turn("invalid-thread", "turn-beta").await,
            Err(AgentManagerError::InvalidThreadId)
        ));
        let unavailable = AgentSessionId::new("offline-agent", "session")
            .unwrap()
            .encode();
        assert!(matches!(
            manager.cancel_turn(&unavailable, "turn-beta").await,
            Err(AgentManagerError::UnknownAgent(_))
        ));
        manager.cancel(&beta_session.thread_id).await.unwrap();
        assert_eq!(observed_rx.recv().await.as_deref(), Some("cancel:beta-lab"));
        manager
            .prepare_steer(&beta_session.thread_id)
            .await
            .unwrap();
        assert!(manager.pending_permissions().await.is_empty());
        assert!(manager.pending_elicitations().await.is_empty());
        let _ = manager.read_session("invalid-thread").await;
        let _ = manager.read_session(&unavailable).await;

        manager.shutdown().await;
        assert!(manager
            .list_agents()
            .iter()
            .all(|agent| agent.lifecycle == AgentLifecycle::Stopped));
        manager.shutdown().await;
    }

    #[test]
    fn local_manifest_set_validates_counts_descriptors_and_enabled_agents() {
        let roots = [PathBuf::from("/bin")];
        let empty = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: Vec::new(),
        };
        assert!(empty.validate(&roots).is_err());

        let oversized = LocalAgentManifestSet {
            preferred_agent_id: "agent-0".to_string(),
            agents: (0..=MAX_AGENTS)
                .map(|index| manifest(&format!("agent-{index}"), "Agent"))
                .collect(),
        };
        assert!(oversized.validate(&roots).is_err());

        let mut invalid_enabled = manifest("alpha", "Alpha");
        invalid_enabled.resolved.executable = PathBuf::from("/does/not/exist");
        let invalid_enabled = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![invalid_enabled],
        };
        assert!(invalid_enabled.validate(&roots).is_err());

        let mut disabled_invalid = manifest("disabled", "Disabled");
        disabled_invalid.enabled = false;
        disabled_invalid.resolved.executable = PathBuf::from("/does/not/exist");
        let disabled_invalid = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![manifest("alpha", "Alpha"), disabled_invalid],
        };
        assert!(disabled_invalid.validate(&roots).is_ok());

        let blank_name_agent = manifest("alpha", " ");
        let blank_name = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![blank_name_agent],
        };
        assert!(blank_name.validate(&roots).is_err());
        let long_name_agent = manifest("alpha", &"x".repeat(257));
        let long_name = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_name_agent],
        };
        assert!(long_name.validate(&roots).is_err());

        let mut bad_icon = manifest("alpha", "Alpha");
        bad_icon.icon = Some("bad\0icon".to_string());
        let bad_icon = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![bad_icon],
        };
        assert!(bad_icon.validate(&roots).is_err());
        let mut long_icon = manifest("alpha", "Alpha");
        long_icon.icon = Some("x".repeat(2_049));
        let long_icon = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_icon],
        };
        assert!(long_icon.validate(&roots).is_err());

        let mut long_version = manifest("alpha", "Alpha");
        long_version.resolved.resolved_version = "x".repeat(2_049);
        let long_version = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_version],
        };
        assert!(long_version.validate(&roots).is_err());
        let mut long_provenance = manifest("alpha", "Alpha");
        long_provenance.resolved.provenance = "x".repeat(2_049);
        let long_provenance = LocalAgentManifestSet {
            preferred_agent_id: "alpha".to_string(),
            agents: vec![long_provenance],
        };
        assert!(long_provenance.validate(&roots).is_err());
    }

    #[test]
    fn local_manifest_parse_load_and_cursor_validation_are_strict() {
        let roots = [PathBuf::from("/bin")];
        assert!(LocalAgentManifestSet::parse("not json", &roots).is_err());
        assert!(LocalAgentManifestSet::load(Path::new("/does/not/exist"), &roots).is_err());
        assert_eq!(decode_cursor(None).unwrap(), 0);
        assert_eq!(decode_cursor(Some(&encode_cursor(42))).unwrap(), 42);
        assert!(decode_cursor(Some("v0.invalid")).is_err());
        assert!(decode_cursor(Some("v1.invalid")).is_err());
        assert!(decode_cursor(Some(&encode_cursor(MAX_SESSIONS + 1))).is_err());
        assert_eq!(
            redact_error(&AcpRuntimeError::Connection("secret".to_string())),
            "ACP agent startup failed (details redacted)"
        );
    }

    #[tokio::test]
    async fn manager_reports_unknown_unavailable_and_invalid_routes() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let manager = AgentManager::from_start_results(
            "alpha".to_string(),
            vec![
                (manifest("alpha", "Alpha"), Ok(ready)),
                (
                    manifest("beta", "Beta"),
                    Err(AcpRuntimeError::Connection("failed".to_string())),
                ),
            ],
        )
        .await
        .unwrap();
        assert!(matches!(
            manager
                .new_session("missing", NewSessionRequest::new("/tmp"))
                .await,
            Err(AgentManagerError::UnknownAgent(_))
        ));
        assert!(matches!(
            manager
                .new_session("beta", NewSessionRequest::new("/tmp"))
                .await,
            Err(AgentManagerError::AgentUnavailable(_))
        ));
        assert!(matches!(
            manager.read_session("invalid").await,
            Err(AgentManagerError::InvalidThreadId)
        ));
        assert!(matches!(
            manager.list_sessions(Some("invalid"), 0).await,
            Err(AgentManagerError::InvalidCursor)
        ));
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_merges_remote_history_but_loaded_list_remains_live_only() {
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", true, "remote-history", observed).await;
        let manager = AgentManager::from_start_results(
            "alpha".to_string(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let remote = manager.list_sessions(None, 100).await.unwrap().sessions;
        assert_eq!(remote.len(), 1);
        assert_eq!(
            AgentSessionId::decode(&remote[0].thread_id)
                .unwrap()
                .acp_session_id,
            "remote-history"
        );
        assert!(manager.loaded_session_ids().await.is_empty());
        assert_eq!(
            manager
                .list_sessions_for(None, 100, Some("alpha"))
                .await
                .unwrap()
                .sessions
                .len(),
            1
        );
        assert!(manager
            .list_sessions_for(None, 100, Some("missing"))
            .await
            .unwrap()
            .sessions
            .is_empty());
        let created = manager
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        let created_again = manager.read_session(&created.thread_id).await.unwrap();
        assert_eq!(created_again.thread_id, created.thread_id);
        let sessions = manager.list_sessions(None, 100).await.unwrap().sessions;
        assert_eq!(sessions.len(), 2);
        assert_eq!(
            sessions
                .iter()
                .filter(|session| session.thread_id == created.thread_id)
                .count(),
            1
        );
        assert_eq!(manager.loaded_session_ids().await, vec![created.thread_id]);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_consumes_remote_pages_and_dedupes_repeated_cursor_results() {
        let ready = paginated_connection("alpha").await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let sessions = manager.list_sessions(None, 100).await.unwrap().sessions;
        let session_ids = sessions
            .iter()
            .map(|session| {
                AgentSessionId::decode(&session.thread_id)
                    .unwrap()
                    .acp_session_id
            })
            .collect::<Vec<_>>();
        assert_eq!(session_ids, vec!["alpha", "duplicate", "zulu"]);
        let page = manager.list_sessions(None, 100).await.unwrap();
        assert_eq!(
            page.diagnostics,
            vec![SessionListDiagnostic::RepeatedCursor]
        );
        assert!(manager.loaded_session_ids().await.is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_bounds_endless_empty_and_duplicate_only_remote_pagination() {
        for (fixture, expected_requests, expected_diagnostic, expected_sessions) in [
            (
                PaginationFixture::Endless,
                MAX_SESSION_LIST_PAGES,
                SessionListDiagnostic::PageBudgetExhausted,
                MAX_SESSION_LIST_PAGES + 1,
            ),
            (
                PaginationFixture::Empty,
                1,
                SessionListDiagnostic::EmptyPage,
                1,
            ),
            (
                PaginationFixture::DuplicateOnly,
                2,
                SessionListDiagnostic::DuplicateOnlyPage,
                2,
            ),
            (
                PaginationFixture::MaxSessions,
                1,
                SessionListDiagnostic::MaxSessionsReached,
                MAX_SESSIONS,
            ),
            (
                PaginationFixture::Failure,
                1,
                SessionListDiagnostic::NativeListFailed,
                1,
            ),
        ] {
            let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let ready = adversarial_paginated_connection("alpha", fixture, requests.clone()).await;
            let manager = AgentManager::from_start_results(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
            )
            .await
            .unwrap();
            manager
                .session_index
                .lock()
                .await
                .insert_all([index_entry(
                    AgentSessionId::new("alpha", "durable-only").unwrap(),
                    PathBuf::from("/tmp"),
                )])
                .await
                .unwrap();
            let page = manager.list_sessions(None, 100).await.unwrap();
            assert_eq!(requests.load(Ordering::SeqCst), expected_requests);
            assert_eq!(page.sessions.len(), expected_sessions.min(MAX_PAGE_SIZE));
            assert!(page.sessions.iter().any(|session| {
                AgentSessionId::decode(&session.thread_id)
                    .is_ok_and(|identity| identity.acp_session_id == "durable-only")
            }));
            assert_eq!(page.diagnostics, vec![expected_diagnostic]);
            assert!(page.partial);
            manager.shutdown().await;
        }
    }

    #[tokio::test]
    async fn durable_index_survives_restart_for_agent_without_list_capability() {
        let directory =
            std::env::temp_dir().join(format!("tethercode-session-index-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let (observed, _) = mpsc::unbounded_channel();
        let first_connection = connection("alpha", false, "unused", observed).await;
        let first = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(first_connection))],
            Some(index_path.clone()),
            PathBuf::from("/tmp"),
            true,
        )
        .await
        .unwrap();
        let created = first
            .new_session("alpha", NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        first.shutdown().await;

        let (observed, _) = mpsc::unbounded_channel();
        let restarted_connection = connection("alpha", false, "unused", observed).await;
        let restarted = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(restarted_connection))],
            Some(index_path),
            PathBuf::from("/tmp"),
            true,
        )
        .await
        .unwrap();
        let history = restarted.list_sessions(None, 1).await.unwrap();
        assert_eq!(history.sessions.len(), 1);
        assert_eq!(history.sessions[0].thread_id, created.thread_id);
        assert_eq!(
            history.sessions[0].cwd,
            std::fs::canonicalize("/tmp").unwrap()
        );
        assert!(history.next_cursor.is_none());
        assert!(restarted.loaded_session_ids().await.is_empty());
        restarted.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_reads_lazy_reconstruct_typed_history_once_for_read_and_page() {
        let directory = std::env::temp_dir().join(format!(
            "tethercode-session-lazy-read-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let identity = AgentSessionId::new("alpha", "durable").unwrap();
        let mut index = DurableSessionIndex::load(Some(index_path.clone())).await;
        index
            .insert_all([index_entry(identity.clone(), directory.clone())])
            .await
            .unwrap();

        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let capabilities = AgentCapabilities::new().session_capabilities(
            SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
        );
        let response_barrier = Arc::new((tokio::sync::Notify::new(), tokio::sync::Notify::new()));
        let ready = reconstructing_connection(
            "alpha",
            capabilities,
            requests.clone(),
            false,
            Some(response_barrier.clone()),
        )
        .await;
        let manager = Arc::new(
            AgentManager::from_start_results_with_index(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
                Some(index_path),
                directory.clone(),
                false,
            )
            .await
            .unwrap(),
        );
        let thread_id = identity.encode();
        let first = {
            let manager = manager.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move { manager.read_session(&thread_id).await })
        };
        response_barrier.0.notified().await;
        assert!(manager.loaded_session_ids().await.is_empty());
        let second = {
            let manager = manager.clone();
            let thread_id = thread_id.clone();
            tokio::spawn(async move { manager.read_session(&thread_id).await })
        };
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        response_barrier.1.notify_one();
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        for session in [first.unwrap(), second.unwrap()] {
            assert_eq!(session.snapshot.messages.len(), 1);
            assert_eq!(session.snapshot.messages[0].parts[0]["text"], "restored");
        }
        let page = manager
            .snapshot_page(&thread_id, None, None, 10)
            .await
            .unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        manager.shutdown().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_read_falls_back_to_load_and_rejects_unsupported_or_invalid_cwd() {
        for (capabilities, expected_requests) in [
            (AgentCapabilities::new().load_session(true), 1),
            (AgentCapabilities::new(), 0),
        ] {
            let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let ready =
                reconstructing_connection("alpha", capabilities, requests.clone(), false, None)
                    .await;
            let manager = AgentManager::from_start_results(
                "alpha".into(),
                vec![(manifest("alpha", "Alpha"), Ok(ready))],
            )
            .await
            .unwrap();
            let identity = AgentSessionId::new("alpha", "durable").unwrap();
            manager
                .session_index
                .lock()
                .await
                .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
                .await
                .unwrap();
            let result = manager.read_session(&identity.encode()).await;
            if expected_requests == 1 {
                assert_eq!(result.unwrap().snapshot.messages.len(), 1);
            } else {
                assert!(matches!(
                    result,
                    Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                        "session/resume or session/load"
                    )))
                ));
            }
            assert_eq!(requests.load(Ordering::SeqCst), expected_requests);
            manager.shutdown().await;
        }

        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ready = reconstructing_connection(
            "alpha",
            AgentCapabilities::new().load_session(true),
            requests.clone(),
            false,
            None,
        )
        .await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("alpha", "stale").unwrap();
        manager.session_index.lock().await.entries.push(index_entry(
            identity.clone(),
            PathBuf::from("/definitely/missing/tethercode-workspace"),
        ));
        assert!(matches!(
            manager.read_session(&identity.encode()).await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn failed_lazy_reconstruction_does_not_register_empty_live_session() {
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let ready = reconstructing_connection(
            "alpha",
            AgentCapabilities::new().load_session(true),
            requests.clone(),
            true,
            None,
        )
        .await;
        let manager = AgentManager::from_start_results(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
        )
        .await
        .unwrap();
        let identity = AgentSessionId::new("alpha", "fails").unwrap();
        manager
            .session_index
            .lock()
            .await
            .insert_all([index_entry(identity.clone(), PathBuf::from("/tmp"))])
            .await
            .unwrap();
        assert!(manager.read_session(&identity.encode()).await.is_err());
        assert!(manager.loaded_session_ids().await.is_empty());
        assert!(manager.read_session(&identity.encode()).await.is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn durable_index_rejects_invalid_storage_and_bounds_valid_entries() {
        let directory = std::env::temp_dir().join(format!(
            "tethercode-session-index-validation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(SESSION_INDEX_FILE);

        for contents in [
            br#"{"version":2,"sessions":[]}"#.as_slice(),
            br#"{"version":1,"sessions":[],"extra":true}"#.as_slice(),
            b"not json".as_slice(),
        ] {
            std::fs::write(&path, contents).unwrap();
            assert!(DurableSessionIndex::load(Some(path.clone()))
                .await
                .entries
                .is_empty());
        }
        std::fs::write(&path, vec![b'x'; MAX_SESSION_INDEX_BYTES + 1]).unwrap();
        assert!(DurableSessionIndex::load(Some(path.clone()))
            .await
            .entries
            .is_empty());

        let valid = SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "valid".into(),
            cwd: PathBuf::from("/tmp"),
        };
        let other_session = SessionIndexEntry {
            agent_id: "alpha".into(),
            acp_session_id: "valid-two".into(),
            cwd: PathBuf::from("/tmp"),
        };
        let other_agent = SessionIndexEntry {
            agent_id: "beta".into(),
            acp_session_id: "valid".into(),
            cwd: PathBuf::from("/tmp"),
        };
        let entries = sanitize_index_entries(vec![
            valid.clone(),
            valid.clone(),
            other_session.clone(),
            other_agent.clone(),
            SessionIndexEntry {
                agent_id: "bad/agent".into(),
                acp_session_id: "invalid".into(),
                cwd: PathBuf::from("/tmp"),
            },
            SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "relative".into(),
                cwd: PathBuf::from("relative"),
            },
            SessionIndexEntry {
                agent_id: "alpha".into(),
                acp_session_id: "oversized-cwd".into(),
                cwd: PathBuf::from(format!("/{}", "x".repeat(MAX_SESSION_CWD_BYTES))),
            },
        ]);
        assert_eq!(entries, vec![valid, other_session, other_agent]);

        let mut memory_only = DurableSessionIndex::load(None).await;
        memory_only
            .insert_all([index_entry(
                AgentSessionId::new("alpha", "memory").unwrap(),
                PathBuf::from("/tmp"),
            )])
            .await
            .unwrap();
        memory_only
            .insert_all([index_entry(
                AgentSessionId::new("alpha", "memory").unwrap(),
                PathBuf::from("/tmp"),
            )])
            .await
            .unwrap();
        assert_eq!(memory_only.entries.len(), 1);
        memory_only
            .insert_all((0..=MAX_SESSIONS).map(|index| {
                index_entry(
                    AgentSessionId::new("alpha", format!("bounded-{index:04}")).unwrap(),
                    PathBuf::from("/tmp"),
                )
            }))
            .await
            .unwrap();
        assert_eq!(memory_only.entries.len(), MAX_SESSIONS);
        assert!(!memory_only
            .entries
            .iter()
            .any(|entry| entry.acp_session_id == "bounded-0000"));

        let missing_parent = directory.join("missing").join(SESSION_INDEX_FILE);
        let mut unwritable = DurableSessionIndex::load(Some(missing_parent)).await;
        let before = unwritable.entries.clone();
        assert!(matches!(
            unwritable
                .insert_all([index_entry(
                    AgentSessionId::new("alpha", "failed-write").unwrap(),
                    PathBuf::from("/tmp"),
                )])
                .await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(unwritable.entries, before);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn durable_index_write_failure_rolls_back_and_retry_survives_restart() {
        let directory = std::env::temp_dir().join(format!(
            "tethercode-session-index-transaction-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(SESSION_INDEX_FILE);
        let original = index_entry(
            AgentSessionId::new("alpha", "original").unwrap(),
            directory.clone(),
        );
        let retry = index_entry(
            AgentSessionId::new("alpha", "retry").unwrap(),
            directory.clone(),
        );
        let mut index = DurableSessionIndex::load(Some(path.clone())).await;
        index.insert_all([original.clone()]).await.unwrap();
        let old_bytes = std::fs::read(&path).unwrap();
        index.fail_writes = true;
        assert!(matches!(
            index.insert_all([retry.clone()]).await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(index.entries, vec![original.clone()]);
        assert_eq!(std::fs::read(&path).unwrap(), old_bytes);

        index.fail_writes = false;
        index
            .insert_all([retry.clone(), retry.clone()])
            .await
            .unwrap();
        assert_eq!(index.entries, vec![original.clone(), retry.clone()]);
        let restarted = DurableSessionIndex::load(Some(path)).await;
        assert_eq!(restarted.entries, vec![original, retry]);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn create_durability_failure_is_explicit_and_pending_list_flush_retries() {
        let directory = std::env::temp_dir().join(format!(
            "tethercode-session-create-durability-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection("alpha", false, "unused", observed).await;
        let manager = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
            Some(index_path.clone()),
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        manager.session_index.lock().await.fail_writes = true;
        assert!(matches!(
            manager
                .new_session("alpha", NewSessionRequest::new(directory.clone()))
                .await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(manager.loaded_session_ids().await.len(), 1);
        assert_eq!(manager.pending_durable_sessions.lock().await.len(), 1);
        assert!(manager.session_index.lock().await.entries.is_empty());

        manager.session_index.lock().await.fail_writes = false;
        let listed = manager.list_sessions(None, 10).await.unwrap();
        assert_eq!(listed.sessions.len(), 1);
        assert!(manager.pending_durable_sessions.lock().await.is_empty());
        assert_eq!(manager.session_index.lock().await.entries.len(), 1);
        manager.shutdown().await;

        let restarted = DurableSessionIndex::load(Some(index_path)).await;
        assert_eq!(restarted.entries.len(), 1);
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn resume_durability_failure_retains_live_session_and_flushes_on_retry() {
        let directory = std::env::temp_dir().join(format!(
            "tethercode-session-resume-durability-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let index_path = directory.join(SESSION_INDEX_FILE);
        let (observed, _) = mpsc::unbounded_channel();
        let ready = connection_with_capabilities(
            "alpha",
            AgentCapabilities::new().load_session(true),
            observed,
        )
        .await;
        let manager = AgentManager::from_start_results_with_index(
            "alpha".into(),
            vec![(manifest("alpha", "Alpha"), Ok(ready))],
            Some(index_path.clone()),
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        manager.session_index.lock().await.fail_writes = true;
        let identity = AgentSessionId::new("alpha", "resume-pending").unwrap();
        assert!(matches!(
            manager
                .resume_session(&identity.encode(), directory.clone())
                .await,
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert_eq!(manager.loaded_session_ids().await, vec![identity.encode()]);
        assert_eq!(manager.pending_durable_sessions.lock().await.len(), 1);

        manager.session_index.lock().await.fail_writes = false;
        let listed = manager.list_sessions(None, 10).await.unwrap();
        assert_eq!(listed.sessions.len(), 1);
        assert!(manager.pending_durable_sessions.lock().await.is_empty());
        manager.shutdown().await;
        assert_eq!(
            DurableSessionIndex::load(Some(index_path))
                .await
                .entries
                .len(),
            1
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn workspace_policy_canonicalizes_relative_paths_and_rejects_outside_root() {
        let directory = std::env::temp_dir().join(format!(
            "tethercode-session-workspace-policy-{}",
            uuid::Uuid::new_v4()
        ));
        let nested = directory.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let file = directory.join("file");
        std::fs::write(&file, "not a directory").unwrap();
        let manager = AgentManager::from_start_results_with_index(
            "alpha".into(),
            Vec::new(),
            None,
            directory.clone(),
            false,
        )
        .await
        .unwrap();
        assert_eq!(
            manager.validate_cwd(Path::new("nested")).unwrap(),
            std::fs::canonicalize(&nested).unwrap()
        );
        assert!(matches!(
            manager.validate_cwd(Path::new("/tmp")),
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert!(matches!(
            manager.validate_cwd(&file),
            Err(AgentManagerError::SessionIndex(_))
        ));
        assert!(manager.flush_pending_durable_sessions().await.is_ok());
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn manager_resume_prefers_resume_and_falls_back_to_load() {
        let (observed_tx, mut observed_rx) = mpsc::unbounded_channel();
        let resume_capabilities = AgentCapabilities::new().session_capabilities(
            SessionCapabilities::new().resume(SessionResumeCapabilities::new()),
        );
        let load_capabilities = AgentCapabilities::new().load_session(true);
        let resume =
            connection_with_capabilities("resume-agent", resume_capabilities, observed_tx.clone())
                .await;
        let load = connection_with_capabilities("load-agent", load_capabilities, observed_tx).await;
        let manager = AgentManager::from_start_results(
            "resume-agent".to_string(),
            vec![
                (manifest("resume-agent", "Resume"), Ok(resume)),
                (manifest("load-agent", "Load"), Ok(load)),
            ],
        )
        .await
        .unwrap();
        let resume_thread = AgentSessionId::new("resume-agent", "resume-session")
            .unwrap()
            .encode();
        manager
            .resume_session(&resume_thread, "/tmp")
            .await
            .unwrap();
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("resume:resume-agent")
        );
        let load_thread = AgentSessionId::new("load-agent", "load-session")
            .unwrap()
            .encode();
        manager.resume_session(&load_thread, "/tmp").await.unwrap();
        assert_eq!(observed_rx.recv().await.as_deref(), Some("load:load-agent"));
        manager
            .resume_session(&resume_thread, "/tmp")
            .await
            .unwrap();
        assert_eq!(
            observed_rx.recv().await.as_deref(),
            Some("resume:resume-agent")
        );
        let listed = manager.list_sessions(None, 100).await.unwrap().sessions;
        assert_eq!(listed.len(), 2);
        assert_eq!(
            listed
                .iter()
                .filter(|session| session.thread_id == resume_thread)
                .count(),
            1
        );
        assert_eq!(
            listed
                .iter()
                .filter(|session| session.thread_id == load_thread)
                .count(),
            1
        );
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_resume_without_restoration_capability_leaves_registry_unchanged() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection =
            connection_with_capabilities("plain-agent", AgentCapabilities::new(), observed_tx)
                .await;
        let manager = AgentManager::from_start_results(
            "plain-agent".to_string(),
            vec![(manifest("plain-agent", "Plain"), Ok(connection))],
        )
        .await
        .unwrap();
        let thread_id = AgentSessionId::new("plain-agent", "missing-session")
            .unwrap()
            .encode();
        assert!(matches!(
            manager.resume_session(&thread_id, "/tmp").await,
            Err(AgentManagerError::Runtime(AcpRuntimeError::Unsupported(
                "session/resume or session/load"
            )))
        ));
        assert!(manager.loaded_session_ids().await.is_empty());
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn manager_mailbox_backpressures_and_preserves_terminal_interaction_order() {
        let manager = AgentManager::from_start_results("agent".into(), Vec::new())
            .await
            .expect("manager starts");
        let mut events = manager.take_events().await.expect("manager event receiver");
        for index in 0..1_024 {
            manager
                .events
                .send(CanonicalEvent::Ignored {
                    agent_id: "agent".into(),
                    thread_id: Some("thread".into()),
                    kind: format!("filler-{index}"),
                })
                .await
                .expect("mailbox open");
        }
        let producer = {
            let sender = manager.events.clone();
            tokio::spawn(async move {
                sender
                    .send(CanonicalEvent::PermissionResolved {
                        agent_id: "agent".into(),
                        thread_id: "thread".into(),
                        request_id: "request".into(),
                        outcome: "cancelled".into(),
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        for index in 0..1_024 {
            assert!(matches!(
                events.recv().await,
                Some(CanonicalEvent::Ignored { kind, .. }) if kind == format!("filler-{index}")
            ));
        }
        producer
            .await
            .expect("producer task")
            .expect("mailbox open");
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::PermissionResolved { request_id, .. }) if request_id == "request"
        ));
    }

    #[tokio::test]
    async fn manager_state_paths_cover_stopped_pagination_and_invalid_tracking() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let ready = connection("ready-agent", false, "unused", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "ready-agent".into(),
            vec![
                (manifest("ready-agent", "Ready"), Ok(ready)),
                (
                    manifest("offline-agent", "Offline"),
                    Err(AcpRuntimeError::Connection("offline".into())),
                ),
            ],
        )
        .await
        .expect("manager starts");
        assert!(manager.take_events().await.is_some());
        assert!(manager.take_events().await.is_none());

        let page = manager
            .list_sessions(Some(&encode_cursor(1)), 1)
            .await
            .expect("nonzero page");
        assert!(page.sessions.is_empty());
        assert!(page.next_cursor.is_none());
        assert!(manager.pending_permissions().await.is_empty());
        assert!(manager.pending_elicitations().await.is_empty());

        let loaded = manager
            .new_session("ready-agent", NewSessionRequest::new("/tmp"))
            .await
            .unwrap();
        manager.session_index.lock().await.fail_writes = true;
        manager.pending_durable_sessions.lock().await.insert(
            loaded.thread_id.clone(),
            index_entry(
                AgentSessionId::decode(&loaded.thread_id).unwrap(),
                PathBuf::from("/tmp"),
            ),
        );

        let unknown = AgentSessionId::new("unknown-agent", "session").unwrap();
        let _ = manager
            .track_session(unknown.clone(), PathBuf::from("/tmp"))
            .await;
        let _ = manager.track_session(unknown, PathBuf::from("/tmp")).await;
        let _ = manager
            .track_session(
                AgentSessionId::new("ready-agent", "missing").unwrap(),
                PathBuf::from("/tmp"),
            )
            .await;
        manager
            .tracked_sessions
            .lock()
            .await
            .insert("not-a-thread-id".to_string(), Uuid::new_v4());
        manager.flush_events().await;

        manager.shutdown().await;
        let _ = manager.list_agents();
        manager.shutdown().await;
    }

    #[tokio::test]
    async fn session_forwarder_stops_on_upstream_and_downstream_closure() {
        let thread_id = "thread".to_string();
        let instance_id = Uuid::new_v4();
        let tracked = Arc::new(Mutex::new(HashMap::from([(
            thread_id.clone(),
            instance_id,
        )])));
        let (upstream, receiver) = canonical_event_channel(1);
        let (downstream, _events) = canonical_event_channel(1);
        drop(upstream);
        forward_session_events(
            receiver,
            downstream,
            tracked.clone(),
            thread_id.clone(),
            instance_id,
        )
        .await;
        assert!(!tracked.lock().await.contains_key(&thread_id));

        let stale_instance_id = Uuid::new_v4();
        let current_instance_id = Uuid::new_v4();
        tracked
            .lock()
            .await
            .insert(thread_id.clone(), current_instance_id);
        let (upstream, receiver) = canonical_event_channel(1);
        let (downstream, events) = canonical_event_channel(1);
        drop(events);
        upstream
            .send(CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: None,
                kind: "closed".into(),
            })
            .await
            .expect("upstream open");
        forward_session_events(
            receiver,
            downstream,
            tracked.clone(),
            thread_id.clone(),
            stale_instance_id,
        )
        .await;
        assert_eq!(
            tracked.lock().await.get(&thread_id),
            Some(&current_instance_id)
        );
    }

    #[tokio::test]
    async fn evicted_session_replacement_forwards_once_and_survives_old_task_cleanup() {
        let (observed_tx, _observed_rx) = mpsc::unbounded_channel();
        let connection = connection("agent", true, "history", observed_tx).await;
        let manager = AgentManager::from_start_results(
            "agent".into(),
            vec![(manifest("agent", "Agent"), Ok(connection))],
        )
        .await
        .expect("manager starts");
        let created = manager
            .new_session("agent", NewSessionRequest::new("/tmp"))
            .await
            .expect("session created");
        let identity = AgentSessionId::decode(&created.thread_id).unwrap();
        let session_id = SessionId::new(identity.acp_session_id.clone());
        let connection = manager.connection("agent").unwrap();
        let old_session = connection.session(&session_id).await.unwrap();
        let old_instance_id = old_session.instance_id();
        let mut events = manager.take_events().await.expect("manager event receiver");

        connection.evict_session(&session_id).await;
        let replacement = connection.ensure_session(session_id).await.unwrap();
        let replacement_instance_id = replacement.instance_id();
        assert_ne!(old_instance_id, replacement_instance_id);
        manager.register_session_events(&identity).await;
        assert_eq!(
            manager
                .tracked_sessions
                .lock()
                .await
                .get(&created.thread_id),
            Some(&replacement_instance_id)
        );

        replacement
            .emit(CanonicalEvent::Ignored {
                agent_id: "agent".into(),
                thread_id: Some(created.thread_id.clone()),
                kind: "replacement".into(),
            })
            .await;
        replacement.flush_events().await;
        assert!(matches!(
            events.recv().await,
            Some(CanonicalEvent::Ignored { kind, .. }) if kind == "replacement"
        ));
        assert!(matches!(
            events.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ));

        drop(old_session);
        tokio::task::yield_now().await;
        assert_eq!(
            manager
                .tracked_sessions
                .lock()
                .await
                .get(&created.thread_id),
            Some(&replacement_instance_id)
        );
    }
}
