use std::{collections::HashMap, time::Instant};

use serde::Serialize;

use crate::{now_iso, BackendLifecycleState, BridgeRuntimeEngine};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeDeviceConnection {
    pub(crate) client_id: u64,
    pub(crate) client_type: String,
    pub(crate) client_name: String,
    pub(crate) connected_at: String,
    pub(crate) last_seen_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeStatus {
    pub(crate) status: String,
    at: String,
    uptime_sec: u64,
    connected_clients: usize,
    devices: Vec<BridgeDeviceConnection>,
    pub(crate) engines: HashMap<BridgeRuntimeEngine, BridgeEngineStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeEngineStatus {
    pub(crate) configured: bool,
    pub(crate) lifecycle: BackendLifecycleState,
    pub(crate) available: bool,
    pub(crate) restart_count: u32,
    pub(crate) pending_requests: usize,
    pub(crate) last_error: Option<String>,
}

pub(crate) fn bridge_status(
    started_at: Instant,
    devices: Vec<BridgeDeviceConnection>,
    engines: HashMap<BridgeRuntimeEngine, BridgeEngineStatus>,
) -> BridgeStatus {
    let available = engines.values().filter(|engine| engine.available).count();
    let status = if available == 0 {
        "unhealthy"
    } else if engines.values().all(|engine| engine.available) {
        "ok"
    } else {
        "degraded"
    };
    BridgeStatus {
        status: status.to_string(),
        at: now_iso(),
        uptime_sec: started_at.elapsed().as_secs(),
        connected_clients: devices.len(),
        devices,
        engines,
    }
}
