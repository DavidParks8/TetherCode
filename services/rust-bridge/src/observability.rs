use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};

use serde::Serialize;
use serde_json::json;
use uuid::Uuid;

use crate::now_iso;

const RECENT_ERROR_LIMIT: usize = 32;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationalError {
    at: String,
    request_id: Option<String>,
    method: Option<String>,
    backend: Option<String>,
    kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestMetrics {
    pub(crate) total: u64,
    pub(crate) completed: u64,
    pub(crate) failed: u64,
    pub(crate) timed_out: u64,
    pub(crate) pending: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LiveSyncMetrics {
    pub(crate) discovery_runs: u64,
    pub(crate) poll_runs: u64,
    pub(crate) tracked_files: u64,
    pub(crate) emitted_events: u64,
    pub(crate) deduplicated_lines: u64,
    pub(crate) errors: u64,
    pub(crate) last_event_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PushMetrics {
    pub(crate) attempted: u64,
    pub(crate) accepted: u64,
    pub(crate) failed: u64,
    pub(crate) receipt_errors: u64,
    pub(crate) last_outcome_at: Option<String>,
    pub(crate) last_outcome: Option<String>,
}

pub(crate) struct RequestTrace {
    pub(crate) request_id: String,
    pub(crate) method: String,
    pub(crate) backend: String,
    pub(crate) started_at: Instant,
}

pub(crate) struct OperationalMetrics {
    requests_total: AtomicU64,
    requests_completed: AtomicU64,
    requests_failed: AtomicU64,
    requests_timed_out: AtomicU64,
    live_sync_discovery_runs: AtomicU64,
    live_sync_poll_runs: AtomicU64,
    live_sync_tracked_files: AtomicU64,
    live_sync_emitted_events: AtomicU64,
    live_sync_deduplicated_lines: AtomicU64,
    live_sync_errors: AtomicU64,
    live_sync_last_event_at: Mutex<Option<String>>,
    push_attempted: AtomicU64,
    push_accepted: AtomicU64,
    push_failed: AtomicU64,
    push_receipt_errors: AtomicU64,
    push_last_outcome: Mutex<Option<(String, String)>>,
    recent_errors: Mutex<VecDeque<OperationalError>>,
}

impl OperationalMetrics {
    pub(crate) fn new() -> Self {
        Self {
            requests_total: AtomicU64::new(0),
            requests_completed: AtomicU64::new(0),
            requests_failed: AtomicU64::new(0),
            requests_timed_out: AtomicU64::new(0),
            live_sync_discovery_runs: AtomicU64::new(0),
            live_sync_poll_runs: AtomicU64::new(0),
            live_sync_tracked_files: AtomicU64::new(0),
            live_sync_emitted_events: AtomicU64::new(0),
            live_sync_deduplicated_lines: AtomicU64::new(0),
            live_sync_errors: AtomicU64::new(0),
            live_sync_last_event_at: Mutex::new(None),
            push_attempted: AtomicU64::new(0),
            push_accepted: AtomicU64::new(0),
            push_failed: AtomicU64::new(0),
            push_receipt_errors: AtomicU64::new(0),
            push_last_outcome: Mutex::new(None),
            recent_errors: Mutex::new(VecDeque::with_capacity(RECENT_ERROR_LIMIT)),
        }
    }

    pub(crate) fn start_request(&self, method: &str, backend: &str) -> RequestTrace {
        self.requests_total.fetch_add(1, Ordering::Relaxed);
        let trace = RequestTrace {
            request_id: Uuid::new_v4().to_string(),
            method: method.to_string(),
            backend: backend.to_string(),
            started_at: Instant::now(),
        };
        structured_log(
            "info",
            "request_started",
            Some(&trace.request_id),
            Some(method),
            Some(backend),
            None,
            None,
        );
        trace
    }

    pub(crate) fn finish_request(&self, trace: &RequestTrace, outcome: &str) {
        if outcome == "ok" {
            self.requests_completed.fetch_add(1, Ordering::Relaxed);
        } else {
            self.requests_failed.fetch_add(1, Ordering::Relaxed);
        }
        structured_log(
            if outcome == "ok" { "info" } else { "warn" },
            "request_finished",
            Some(&trace.request_id),
            Some(&trace.method),
            Some(&trace.backend),
            Some(trace.started_at.elapsed().as_millis() as u64),
            Some(outcome),
        );
    }

    pub(crate) fn time_out_request(&self, trace: &RequestTrace) {
        self.requests_failed.fetch_add(1, Ordering::Relaxed);
        self.requests_timed_out.fetch_add(1, Ordering::Relaxed);
        self.record_error(
            Some(&trace.request_id),
            Some(&trace.method),
            Some(&trace.backend),
            "request_timeout",
        );
        structured_log(
            "warn",
            "request_finished",
            Some(&trace.request_id),
            Some(&trace.method),
            Some(&trace.backend),
            Some(trace.started_at.elapsed().as_millis() as u64),
            Some("timeout"),
        );
    }

    pub(crate) fn record_error(
        &self,
        request_id: Option<&str>,
        method: Option<&str>,
        backend: Option<&str>,
        kind: &str,
    ) {
        let error = OperationalError {
            at: now_iso(),
            request_id: request_id.map(str::to_string),
            method: method.map(str::to_string),
            backend: backend.map(str::to_string),
            kind: kind.to_string(),
        };
        let mut recent = self
            .recent_errors
            .lock()
            .unwrap_or_else(|entry| entry.into_inner());
        if recent.len() == RECENT_ERROR_LIMIT {
            recent.pop_front();
        }
        recent.push_back(error);
    }

    pub(crate) fn request_snapshot(&self) -> RequestMetrics {
        let total = self.requests_total.load(Ordering::Relaxed);
        let completed = self.requests_completed.load(Ordering::Relaxed);
        let failed = self.requests_failed.load(Ordering::Relaxed);
        RequestMetrics {
            total,
            completed,
            failed,
            timed_out: self.requests_timed_out.load(Ordering::Relaxed),
            pending: total.saturating_sub(completed).saturating_sub(failed),
        }
    }

    pub(crate) fn recent_errors(&self) -> Vec<OperationalError> {
        self.recent_errors
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub(crate) fn live_sync_discovery(&self, tracked_files: usize) {
        self.live_sync_discovery_runs
            .fetch_add(1, Ordering::Relaxed);
        self.live_sync_tracked_files
            .store(tracked_files as u64, Ordering::Relaxed);
    }

    pub(crate) fn live_sync_poll(&self) {
        self.live_sync_poll_runs.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn live_sync_event(&self) {
        self.live_sync_emitted_events
            .fetch_add(1, Ordering::Relaxed);
        *self
            .live_sync_last_event_at
            .lock()
            .unwrap_or_else(|entry| entry.into_inner()) = Some(now_iso());
    }

    pub(crate) fn live_sync_deduplicated(&self) {
        self.live_sync_deduplicated_lines
            .fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn live_sync_error(&self, kind: &str) {
        self.live_sync_errors.fetch_add(1, Ordering::Relaxed);
        self.record_error(None, None, Some("codex"), kind);
    }

    pub(crate) fn live_sync_snapshot(&self) -> LiveSyncMetrics {
        LiveSyncMetrics {
            discovery_runs: self.live_sync_discovery_runs.load(Ordering::Relaxed),
            poll_runs: self.live_sync_poll_runs.load(Ordering::Relaxed),
            tracked_files: self.live_sync_tracked_files.load(Ordering::Relaxed),
            emitted_events: self.live_sync_emitted_events.load(Ordering::Relaxed),
            deduplicated_lines: self.live_sync_deduplicated_lines.load(Ordering::Relaxed),
            errors: self.live_sync_errors.load(Ordering::Relaxed),
            last_event_at: self
                .live_sync_last_event_at
                .lock()
                .unwrap_or_else(|entry| entry.into_inner())
                .clone(),
        }
    }

    pub(crate) fn push_attempted(&self, count: usize) {
        self.push_attempted
            .fetch_add(count as u64, Ordering::Relaxed);
    }

    pub(crate) fn push_outcome(&self, accepted: usize, failed: usize) {
        self.push_accepted
            .fetch_add(accepted as u64, Ordering::Relaxed);
        self.push_failed.fetch_add(failed as u64, Ordering::Relaxed);
        let outcome = if failed == 0 {
            "accepted"
        } else {
            "partial_failure"
        };
        *self
            .push_last_outcome
            .lock()
            .unwrap_or_else(|entry| entry.into_inner()) = Some((now_iso(), outcome.to_string()));
    }

    pub(crate) fn push_transport_failure(&self, count: usize) {
        self.push_failed.fetch_add(count as u64, Ordering::Relaxed);
        *self
            .push_last_outcome
            .lock()
            .unwrap_or_else(|entry| entry.into_inner()) =
            Some((now_iso(), "transport_failure".to_string()));
        self.record_error(
            None,
            Some("push/send"),
            Some("expo"),
            "push_transport_failure",
        );
    }

    pub(crate) fn push_receipt_error(&self) {
        self.push_receipt_errors.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn push_snapshot(&self) -> PushMetrics {
        let outcome = self
            .push_last_outcome
            .lock()
            .unwrap_or_else(|entry| entry.into_inner())
            .clone();
        PushMetrics {
            attempted: self.push_attempted.load(Ordering::Relaxed),
            accepted: self.push_accepted.load(Ordering::Relaxed),
            failed: self.push_failed.load(Ordering::Relaxed),
            receipt_errors: self.push_receipt_errors.load(Ordering::Relaxed),
            last_outcome_at: outcome.as_ref().map(|entry| entry.0.clone()),
            last_outcome: outcome.map(|entry| entry.1),
        }
    }
}

fn structured_log(
    level: &str,
    event: &str,
    request_id: Option<&str>,
    method: Option<&str>,
    backend: Option<&str>,
    duration_ms: Option<u64>,
    outcome: Option<&str>,
) {
    eprintln!(
        "{}",
        json!({
            "timestamp": now_iso(),
            "level": level,
            "event": event,
            "requestId": request_id,
            "method": method,
            "backend": backend,
            "durationMs": duration_ms,
            "outcome": outcome,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_errors_are_bounded_and_payload_free() {
        let metrics = OperationalMetrics::new();
        for index in 0..40 {
            metrics.record_error(
                None,
                Some("turn/start"),
                Some("codex"),
                &format!("kind_{index}"),
            );
        }
        let errors = metrics.recent_errors();
        assert_eq!(errors.len(), RECENT_ERROR_LIMIT);
        assert_eq!(
            errors.first().map(|entry| entry.kind.as_str()),
            Some("kind_8")
        );
    }

    #[test]
    fn request_counts_track_terminal_outcomes() {
        let metrics = OperationalMetrics::new();
        let completed = metrics.start_request("bridge/status/read", "bridge");
        metrics.finish_request(&completed, "ok");
        let timed_out = metrics.start_request("thread/read", "codex");
        metrics.time_out_request(&timed_out);
        let snapshot = metrics.request_snapshot();
        assert_eq!(snapshot.total, 2);
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.failed, 1);
        assert_eq!(snapshot.timed_out, 1);
        assert_eq!(snapshot.pending, 0);
    }
}
