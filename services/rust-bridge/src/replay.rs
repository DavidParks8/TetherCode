use std::collections::VecDeque;

use serde_json::Value;
use tokio::sync::RwLock;

#[derive(Clone)]
struct ReplayableNotification {
    event_id: u64,
    payload: Value,
    bytes: usize,
}

pub(crate) struct NotificationReplay {
    capacity: usize,
    max_bytes: usize,
    entries: RwLock<VecDeque<ReplayableNotification>>,
}

impl NotificationReplay {
    pub(crate) fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            entries: RwLock::new(VecDeque::new()),
        }
    }

    pub(crate) async fn push(&self, event_id: u64, payload: Value, bytes: usize) {
        if self.capacity == 0 || bytes > self.max_bytes {
            return;
        }

        let mut entries = self.entries.write().await;
        entries.push_back(ReplayableNotification {
            event_id,
            payload,
            bytes,
        });
        let mut total_bytes = entries.iter().map(|entry| entry.bytes).sum::<usize>();
        while entries.len() > self.capacity || total_bytes > self.max_bytes {
            if let Some(removed) = entries.pop_front() {
                total_bytes = total_bytes.saturating_sub(removed.bytes);
            }
        }
    }

    pub(crate) async fn since(
        &self,
        after_event_id: Option<u64>,
        limit: usize,
        max_bytes: usize,
    ) -> (Vec<Value>, bool, usize) {
        let after = after_event_id.unwrap_or(0);
        let entries = self.entries.read().await;
        let mut events = Vec::new();
        let mut has_more = false;
        let mut response_bytes = 0usize;

        for entry in entries.iter() {
            if entry.event_id <= after {
                continue;
            }

            if events.len() >= limit || response_bytes.saturating_add(entry.bytes) > max_bytes {
                has_more = true;
                break;
            }

            events.push(entry.payload.clone());
            response_bytes += entry.bytes;
        }

        (events, has_more, response_bytes)
    }

    pub(crate) async fn earliest_event_id(&self) -> Option<u64> {
        self.entries
            .read()
            .await
            .front()
            .map(|entry| entry.event_id)
    }
}

#[cfg(test)]
mod tests {
    use super::NotificationReplay;
    use serde_json::json;

    #[tokio::test]
    async fn evicts_by_total_bytes_and_bounds_response_bytes() {
        let replay = NotificationReplay::new(10, 10);
        replay.push(1, json!({ "id": 1 }), 6).await;
        replay.push(2, json!({ "id": 2 }), 4).await;
        assert_eq!(replay.earliest_event_id().await, Some(1));

        replay.push(3, json!({ "id": 3 }), 1).await;
        assert_eq!(replay.earliest_event_id().await, Some(2));

        let (events, has_more, bytes) = replay.since(None, 10, 4).await;
        assert_eq!(events, vec![json!({ "id": 2 })]);
        assert!(has_more);
        assert_eq!(bytes, 4);
    }

    #[tokio::test]
    async fn drops_single_entry_larger_than_storage_budget() {
        let replay = NotificationReplay::new(10, 4);
        replay.push(1, json!({ "id": 1 }), 5).await;
        assert_eq!(replay.earliest_event_id().await, None);
    }
}
