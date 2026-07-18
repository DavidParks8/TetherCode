use std::collections::VecDeque;

use serde_json::Value;
use tokio::sync::RwLock;

#[derive(Clone)]
struct ReplayableNotification {
    event_id: u64,
    payload: Value,
}

pub(crate) struct NotificationReplay {
    capacity: usize,
    entries: RwLock<VecDeque<ReplayableNotification>>,
}

impl NotificationReplay {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entries: RwLock::new(VecDeque::new()),
        }
    }

    pub(crate) async fn push(&self, event_id: u64, payload: Value) {
        if self.capacity == 0 {
            return;
        }

        let mut entries = self.entries.write().await;
        entries.push_back(ReplayableNotification { event_id, payload });
        while entries.len() > self.capacity {
            entries.pop_front();
        }
    }

    pub(crate) async fn since(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
    ) -> (Vec<Value>, bool) {
        let after = after_event_id.unwrap_or(0);
        let entries = self.entries.read().await;
        let mut events = Vec::new();
        let mut has_more = false;

        for entry in entries.iter() {
            if entry.event_id <= after {
                continue;
            }

            if events.len() >= limit {
                has_more = true;
                break;
            }

            events.push(entry.payload.clone());
        }

        (events, has_more)
    }

    pub(crate) async fn earliest_event_id(&self) -> Option<u64> {
        self.entries
            .read()
            .await
            .front()
            .map(|entry| entry.event_id)
    }
}
