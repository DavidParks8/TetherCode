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
            if outcome == "timeout" {
                self.requests_timed_out.fetch_add(1, Ordering::Relaxed);
                self.record_error(
                    Some(&trace.request_id),
                    Some(&trace.method),
                    Some(&trace.backend),
                    "request_timeout",
                );
            }
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
#[cfg_attr(coverage_nightly, coverage(off))]
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
        metrics.finish_request(&timed_out, "timeout");
        let snapshot = metrics.request_snapshot();
        assert_eq!(snapshot.total, 2);
        assert_eq!(snapshot.completed, 1);
        assert_eq!(snapshot.failed, 1);
        assert_eq!(snapshot.timed_out, 1);
        assert_eq!(snapshot.pending, 0);
    }

    #[test]
    fn request_failure_and_pending_snapshots_are_distinct() {
        let metrics = OperationalMetrics::new();
        let pending = metrics.start_request("thread/read", "codex");
        let failed = metrics.start_request("turn/start", "codex");
        metrics.finish_request(&failed, "backend_error");

        let snapshot = metrics.request_snapshot();
        assert_eq!(snapshot.total, 2);
        assert_eq!(snapshot.completed, 0);
        assert_eq!(snapshot.failed, 1);
        assert_eq!(snapshot.pending, 1);
        assert!(!pending.request_id.is_empty());
    }

    #[test]
    fn push_metrics_cover_accepted_partial_and_transport_failures() {
        let metrics = OperationalMetrics::new();
        let empty = metrics.push_snapshot();
        assert!(empty.last_outcome.is_none());
        assert!(empty.last_outcome_at.is_none());

        metrics.push_attempted(5);
        metrics.push_outcome(2, 0);
        assert_eq!(
            metrics.push_snapshot().last_outcome.as_deref(),
            Some("accepted")
        );
        metrics.push_outcome(1, 1);
        assert_eq!(
            metrics.push_snapshot().last_outcome.as_deref(),
            Some("partial_failure")
        );
        metrics.push_transport_failure(2);
        metrics.push_receipt_error();

        let snapshot = metrics.push_snapshot();
        assert_eq!(snapshot.attempted, 5);
        assert_eq!(snapshot.accepted, 3);
        assert_eq!(snapshot.failed, 3);
        assert_eq!(snapshot.receipt_errors, 1);
        assert_eq!(snapshot.last_outcome.as_deref(), Some("transport_failure"));
        assert!(snapshot.last_outcome_at.is_some());
        assert_eq!(metrics.recent_errors().len(), 1);
    }
}
