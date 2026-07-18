use crate::*;

#[derive(Clone)]
pub(super) struct AppState {
    pub(super) config: Arc<BridgeConfig>,
    pub(super) path_policy: Arc<PathPolicy>,
    pub(super) started_at: Instant,
    pub(super) hub: Arc<ClientHub>,
    pub(super) backend: Arc<RuntimeBackend>,
    pub(super) queue: Arc<BridgeQueueService>,
    pub(super) thread_create_results: Arc<Mutex<HashMap<String, BridgeThreadCreateResponse>>>,
    pub(super) thread_create_order: Arc<Mutex<VecDeque<String>>>,
    pub(super) thread_create_actor: Arc<Mutex<()>>,
    pub(super) approval_resolution_results: Arc<Mutex<HashMap<String, Value>>>,
    pub(super) approval_resolution_order: Arc<Mutex<VecDeque<String>>>,
    pub(super) approval_resolution_actor: Arc<Mutex<()>>,
    pub(super) thread_list_streams: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub(super) terminal: Arc<TerminalService>,
    pub(super) git: Arc<GitService>,
    pub(super) updater: Arc<UpdateService>,
    pub(super) preview: Arc<BrowserPreviewService>,
    pub(super) push: Arc<PushService>,
    pub(super) ws_global_in_flight: Arc<Semaphore>,
    pub(super) metrics: Arc<OperationalMetrics>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub(super) enum BridgeRuntimeEngine {
    Codex,
    Opencode,
    Cursor,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeCapabilities {
    pub(super) protocol_version: u32,
    pub(super) stream_id: String,
    pub(super) active_engine: BridgeRuntimeEngine,
    pub(super) preferred_engine: BridgeRuntimeEngine,
    pub(super) configured_engines: Vec<BridgeRuntimeEngine>,
    pub(super) available_engines: Vec<BridgeRuntimeEngine>,
    pub(super) unified_chat_list: bool,
    pub(super) supports: BridgeCapabilitySupport,
    pub(super) supports_by_engine: HashMap<BridgeRuntimeEngine, BridgeCapabilitySupport>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BridgeCapabilitySupport {
    pub(super) review_start: bool,
    pub(super) compact_start: bool,
    pub(super) goal_slash: bool,
    pub(super) plan_mode: bool,
    pub(super) agent_list: bool,
    pub(super) turn_steer: bool,
    pub(super) command_output_delta: bool,
    pub(super) fast_mode: bool,
    pub(super) account: bool,
    pub(super) account_rate_limits: bool,
    pub(super) self_update: bool,
    pub(super) browser_preview: bool,
    pub(super) generic_ui_surface: bool,
}

impl AppState {
    pub(super) fn bridge_capabilities(&self) -> BridgeCapabilities {
        let mut capabilities = self.backend.capabilities(self.hub.stream_id());
        capabilities.configured_engines = self.config.enabled_engines.clone();
        capabilities.supports.self_update = self.updater.is_self_update_supported();
        capabilities.supports.browser_preview = self.preview.is_available();
        capabilities.supports.generic_ui_surface = true;
        for supports in capabilities.supports_by_engine.values_mut() {
            supports.self_update = capabilities.supports.self_update;
            supports.browser_preview = capabilities.supports.browser_preview;
            supports.generic_ui_surface = true;
        }
        capabilities
    }

    pub(super) async fn bridge_status(&self) -> BridgeStatus {
        let devices = self.hub.client_connections().await;
        let engines = self
            .backend
            .engine_statuses(&self.config.enabled_engines)
            .await;
        let operational = BridgeOperationalStatus {
            requests: self.metrics.request_snapshot(),
            live_sync: self.metrics.live_sync_snapshot(),
            replay: self.hub.replay_status().await,
            queue: self.queue.status().await,
            push: self.metrics.push_snapshot(),
            terminal: self.terminal.status(),
            recent_errors: self.metrics.recent_errors(),
        };
        bridge_status(self.started_at, devices, engines, operational)
    }
}

pub(super) fn sanitize_client_metadata(
    value: Option<&str>,
    fallback: &str,
    max_chars: usize,
) -> String {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return fallback.to_string();
    };

    let sanitized = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>()
        .trim()
        .to_string();

    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}
