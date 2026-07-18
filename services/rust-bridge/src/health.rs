use std::{collections::HashMap, time::Instant};

use serde::Serialize;

use crate::{
    now_iso,
    observability::{LiveSyncMetrics, OperationalError, PushMetrics, RequestMetrics},
    replay::ReplayStatus,
    services::terminal::TerminalStatus,
    BackendLifecycleState, BridgeRuntimeEngine,
};

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
    pub(crate) operational: BridgeOperationalStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeEngineStatus {
    pub(crate) configured: bool,
    pub(crate) lifecycle: BackendLifecycleState,
    pub(crate) available: bool,
    pub(crate) restart_count: u32,
    pub(crate) pending_requests: usize,
    pub(crate) timed_out_requests: u64,
    pub(crate) last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeOperationalStatus {
    pub(crate) requests: RequestMetrics,
    pub(crate) live_sync: LiveSyncMetrics,
    pub(crate) replay: ReplayStatus,
    pub(crate) queue: QueueStatus,
    pub(crate) push: PushMetrics,
    pub(crate) terminal: TerminalStatus,
    pub(crate) recent_errors: Vec<OperationalError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueStatus {
    pub(crate) tracked_threads: usize,
    pub(crate) depth: usize,
    pub(crate) busy_threads: usize,
}

pub(crate) fn bridge_status(
    started_at: Instant,
    devices: Vec<BridgeDeviceConnection>,
    engines: HashMap<BridgeRuntimeEngine, BridgeEngineStatus>,
    operational: BridgeOperationalStatus,
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
        operational,
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::backend_runtime::BackendLifecycleState;
    use crate::observability::OperationalMetrics;

    fn engine(available: bool) -> BridgeEngineStatus {
        BridgeEngineStatus {
            configured: true,
            lifecycle: if available {
                BackendLifecycleState::Ready
            } else {
                BackendLifecycleState::Degraded
            },
            available,
            restart_count: 0,
            pending_requests: 0,
            timed_out_requests: 0,
            last_error: None,
        }
    }

    async fn operational() -> BridgeOperationalStatus {
        let metrics = OperationalMetrics::new();
        BridgeOperationalStatus {
            requests: metrics.request_snapshot(),
            live_sync: metrics.live_sync_snapshot(),
            replay: crate::replay::NotificationReplay::new(4, 1024)
                .status(0)
                .await,
            queue: QueueStatus {
                tracked_threads: 0,
                depth: 0,
                busy_threads: 0,
            },
            push: metrics.push_snapshot(),
            terminal: TerminalStatus {
                max_concurrent: 4,
                running: 0,
                waiting: 0,
                saturation_count: 0,
                timed_out: 0,
            },
            recent_errors: Vec::new(),
        }
    }

    #[tokio::test]
    async fn status_is_unhealthy_without_available_engines() {
        let status = bridge_status(
            Instant::now(),
            Vec::new(),
            HashMap::new(),
            operational().await,
        );
        assert_eq!(status.status, "unhealthy");
        assert_eq!(status.connected_clients, 0);
    }

    #[tokio::test]
    async fn status_is_ok_when_every_engine_is_available() {
        let devices = vec![BridgeDeviceConnection {
            client_id: 1,
            client_type: "mobile".to_string(),
            client_name: "phone".to_string(),
            connected_at: "then".to_string(),
            last_seen_at: "now".to_string(),
        }];
        let engines = HashMap::from([
            (BridgeRuntimeEngine::Codex, engine(true)),
            (BridgeRuntimeEngine::Opencode, engine(true)),
        ]);
        let status = bridge_status(Instant::now(), devices, engines, operational().await);
        assert_eq!(status.status, "ok");
        assert_eq!(status.connected_clients, 1);
        assert_eq!(status.devices[0].client_id, 1);
    }

    #[tokio::test]
    async fn status_is_degraded_for_mixed_engine_availability() {
        let engines = HashMap::from([
            (BridgeRuntimeEngine::Codex, engine(true)),
            (BridgeRuntimeEngine::Cursor, engine(false)),
        ]);
        let status = bridge_status(Instant::now(), Vec::new(), engines, operational().await);
        assert_eq!(status.status, "degraded");
    }
}
