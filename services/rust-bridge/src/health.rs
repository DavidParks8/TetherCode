use std::time::Instant;

use serde::Serialize;

use crate::{
    acp::manager::{AgentDescriptor, AgentLifecycle},
    now_iso,
    observability::{OperationalError, PushMetrics, RequestMetrics},
    replay::ReplayStatus,
    services::terminal::TerminalStatus,
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
    pub(crate) agents: Vec<AgentDescriptor>,
    pub(crate) operational: BridgeOperationalStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeOperationalStatus {
    pub(crate) requests: RequestMetrics,
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
    agents: Vec<AgentDescriptor>,
    operational: BridgeOperationalStatus,
) -> BridgeStatus {
    let available = agents
        .iter()
        .filter(|agent| agent.lifecycle == AgentLifecycle::Ready)
        .count();
    let status = if available == 0 {
        "unhealthy"
    } else if agents
        .iter()
        .all(|agent| agent.lifecycle == AgentLifecycle::Ready)
    {
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
        agents,
        operational,
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::acp::manager::{AgentCapabilities, AgentDescriptor};
    use crate::observability::OperationalMetrics;

    fn agent(id: &str, lifecycle: AgentLifecycle) -> AgentDescriptor {
        AgentDescriptor {
            agent_id: id.to_string(),
            display_name: id.to_string(),
            icon: None,
            version: "1.0.0".to_string(),
            provenance: "test".to_string(),
            lifecycle,
            last_error: None,
            capabilities: Some(AgentCapabilities {
                session_list: true,
                session_load: true,
                session_resume: true,
                session_steer: false,
            }),
        }
    }

    async fn operational() -> BridgeOperationalStatus {
        let metrics = OperationalMetrics::new();
        BridgeOperationalStatus {
            requests: metrics.request_snapshot(),
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
        let status = bridge_status(Instant::now(), Vec::new(), Vec::new(), operational().await);
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
        let agents = vec![
            agent("alpha", AgentLifecycle::Ready),
            agent("beta", AgentLifecycle::Ready),
        ];
        let status = bridge_status(Instant::now(), devices, agents, operational().await);
        assert_eq!(status.status, "ok");
        assert_eq!(status.connected_clients, 1);
        assert_eq!(status.devices[0].client_id, 1);
    }

    #[tokio::test]
    async fn status_is_degraded_for_mixed_engine_availability() {
        let agents = vec![
            agent("alpha", AgentLifecycle::Ready),
            agent("beta", AgentLifecycle::Unavailable),
        ];
        let status = bridge_status(Instant::now(), Vec::new(), agents, operational().await);
        assert_eq!(status.status, "degraded");
    }
}
