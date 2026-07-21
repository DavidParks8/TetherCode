use std::{
    collections::VecDeque,
    sync::atomic::{AtomicU64, Ordering},
};

use serde::Serialize;
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
    dropped_oversize: AtomicU64,
    evicted: AtomicU64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayStatus {
    pub(crate) capacity: usize,
    pub(crate) max_bytes: usize,
    pub(crate) entries: usize,
    pub(crate) bytes: usize,
    pub(crate) earliest_event_id: Option<u64>,
    pub(crate) latest_event_id: Option<u64>,
    pub(crate) dropped_oversize: u64,
    pub(crate) evicted: u64,
    pub(crate) client_queue_drops: u64,
}

impl NotificationReplay {
    pub(crate) fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            capacity,
            max_bytes,
            entries: RwLock::new(VecDeque::new()),
            dropped_oversize: AtomicU64::new(0),
            evicted: AtomicU64::new(0),
        }
    }

    pub(crate) async fn push(&self, event_id: u64, payload: Value, bytes: usize) {
        if self.capacity == 0 || bytes > self.max_bytes {
            self.dropped_oversize.fetch_add(1, Ordering::Relaxed);
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
            let removed = entries
                .pop_front()
                .expect("replay eviction requires a non-empty buffer");
            total_bytes = total_bytes.saturating_sub(removed.bytes);
            self.evicted.fetch_add(1, Ordering::Relaxed);
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

    pub(crate) async fn status(&self, client_queue_drops: u64) -> ReplayStatus {
        let entries = self.entries.read().await;
        ReplayStatus {
            capacity: self.capacity,
            max_bytes: self.max_bytes,
            entries: entries.len(),
            bytes: entries.iter().map(|entry| entry.bytes).sum(),
            earliest_event_id: entries.front().map(|entry| entry.event_id),
            latest_event_id: entries.back().map(|entry| entry.event_id),
            dropped_oversize: self.dropped_oversize.load(Ordering::Relaxed),
            evicted: self.evicted.load(Ordering::Relaxed),
            client_queue_drops,
        }
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
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
        assert_eq!(replay.status(0).await.dropped_oversize, 1);
    }

    #[tokio::test]
    async fn zero_capacity_drops_and_since_skips_the_cursor() {
        let disabled = NotificationReplay::new(0, 100);
        disabled.push(1, json!({ "id": 1 }), 1).await;
        assert_eq!(disabled.status(7).await.dropped_oversize, 1);
        assert_eq!(disabled.status(7).await.client_queue_drops, 7);

        let replay = NotificationReplay::new(3, 100);
        replay.push(1, json!({ "id": 1 }), 2).await;
        replay.push(2, json!({ "id": 2 }), 2).await;
        replay.push(3, json!({ "id": 3 }), 2).await;
        let (events, has_more, bytes) = replay.since(Some(1), 1, 100).await;
        assert_eq!(events, vec![json!({ "id": 2 })]);
        assert!(has_more);
        assert_eq!(bytes, 2);

        let count_bounded = NotificationReplay::new(1, 100);
        count_bounded.push(1, json!({ "id": 1 }), 1).await;
        count_bounded.push(2, json!({ "id": 2 }), 1).await;
        assert_eq!(count_bounded.earliest_event_id().await, Some(2));
        assert_eq!(count_bounded.status(0).await.evicted, 1);

        let status = replay.status(0).await;
        assert_eq!(status.latest_event_id, Some(3));
        assert_eq!(status.bytes, 6);

        let (remaining, has_more, bytes) = replay.since(Some(2), 10, 100).await;
        assert_eq!(remaining, vec![json!({ "id": 3 })]);
        assert!(!has_more);
        assert_eq!(bytes, 2);
    }
}
