use std::time::Duration;

use serde::Serialize;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum BackendLifecycleState {
    Starting,
    Ready,
    Degraded,
    Restarting,
    Dead,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackendRuntimeSnapshot {
    pub(crate) state: BackendLifecycleState,
    pub(crate) restart_count: u32,
    pub(crate) last_error: Option<String>,
}

pub(crate) struct BackendRuntimeStatus {
    snapshot: RwLock<BackendRuntimeSnapshot>,
}

impl BackendRuntimeStatus {
    pub(crate) fn starting() -> Self {
        Self {
            snapshot: RwLock::new(BackendRuntimeSnapshot {
                state: BackendLifecycleState::Starting,
                restart_count: 0,
                last_error: None,
            }),
        }
    }

    pub(crate) async fn transition(&self, state: BackendLifecycleState, error: Option<String>) {
        let mut snapshot = self.snapshot.write().await;
        if state == BackendLifecycleState::Restarting {
            snapshot.restart_count = snapshot.restart_count.saturating_add(1);
        }
        snapshot.state = state;
        snapshot.last_error = error;
    }

    #[allow(dead_code)]
    pub(crate) async fn snapshot(&self) -> BackendRuntimeSnapshot {
        self.snapshot.read().await.clone()
    }
}

#[allow(dead_code)]
pub(crate) fn restart_backoff(restart_count: u32) -> Duration {
    Duration::from_millis(
        (500_u64.saturating_mul(2_u64.saturating_pow(restart_count.min(4)))).min(8_000),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lifecycle_tracks_restart_and_terminal_failure() {
        let status = BackendRuntimeStatus::starting();
        status.transition(BackendLifecycleState::Ready, None).await;
        status
            .transition(BackendLifecycleState::Restarting, Some("exited".into()))
            .await;
        status
            .transition(
                BackendLifecycleState::Dead,
                Some("restart exhausted".into()),
            )
            .await;
        let snapshot = status.snapshot().await;
        assert_eq!(snapshot.state, BackendLifecycleState::Dead);
        assert_eq!(snapshot.restart_count, 1);
        assert_eq!(restart_backoff(0), Duration::from_millis(500));
        assert_eq!(restart_backoff(99), Duration::from_millis(8_000));
    }
}
