use crate::*;

// ---- Push notifications ----------------------------------------------------
//
// The mobile app can only run JavaScript (and therefore keep its WebSocket
// open) while it is foregrounded. The moment it is backgrounded or killed the
// socket closes, so the *phone* can never observe a turn completing. The bridge
// is the only component reliably alive at that moment, so it is the sender:
// devices register an Expo push token, and the bridge POSTs a minimal,
// content-free payload to the Expo push service when a turn completes or an
// approval is requested. Expo relays to APNs/FCM, which wakes the app.

pub(super) const EXPO_PUSH_SEND_ENDPOINT: &str = "https://exp.host/--/api/v2/push/send";
pub(super) const EXPO_PUSH_RECEIPTS_ENDPOINT: &str = "https://exp.host/--/api/v2/push/getReceipts";
pub(super) const EXPO_PUSH_BATCH_SIZE: usize = 100;
// Reply-preview tuning: cap how much streamed text we buffer per thread, and how
// many characters of the first line we surface in the notification body.
pub(super) const PUSH_PREVIEW_ACCUMULATE_CAP: usize = PUSH_PREVIEW_MAX_BYTES;
pub(super) const PUSH_PREVIEW_MAX_CHARS: usize = 140;
pub(super) const EXPO_RECEIPT_BATCH_SIZE: usize = 1000;
// Expo asks senders to wait at least ~15 minutes before fetching delivery receipts.
pub(super) const RECEIPT_CHECK_DELAY_SECS: u64 = 900;
pub(super) const PUSH_SEND_MAX_ATTEMPTS: u32 = 4;
pub(super) const QUEUE_COMPLETION_DISPOSITION_WAIT_MS: u64 = 2_000;
pub(super) const QUEUE_COMPLETION_DISPOSITION_LIMIT: usize = 1_024;
pub(super) const SUBMISSION_DEDUPE_LIMIT: usize = 1_024;
pub(super) const APPROVAL_RESOLUTION_DEDUPE_LIMIT: usize = 1_024;
pub(super) const QUEUE_STATUS_DISPATCH_FALLBACK_MS: u64 = 250;

pub(super) struct PushService {
    pub(super) registry: PushRegistryStore,
    pub(super) project_label: String,
    pub(super) http: reqwest::Client,
    pub(super) access_token: Option<String>,
    // Accumulates the in-flight agent reply text per thread (keyed by threadId),
    // so a turn/completed push can include a short preview of what the agent said.
    pub(super) recent_replies: RwLock<HashMap<String, String>>,
    pub(super) metrics: Arc<OperationalMetrics>,
}

impl PushService {
    pub(super) async fn load(
        workdir: &Path,
        project_label: String,
        metrics: Arc<OperationalMetrics>,
    ) -> Arc<Self> {
        let registry = PushRegistryStore::load(workdir).await;
        let access_token = env::var("EXPO_ACCESS_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Arc::new(Self {
            registry,
            project_label,
            http: reqwest::Client::new(),
            access_token,
            recent_replies: RwLock::new(HashMap::new()),
            metrics,
        })
    }

    pub(super) fn spawn_event_loop_with_queue(
        self: &Arc<Self>,
        hub: &Arc<ClientHub>,
        backend: Arc<RuntimeBackend>,
        queue: Option<Arc<BridgeQueueService>>,
    ) {
        let this = Arc::clone(self);
        let mut receiver = hub.subscribe_notifications();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(notification) => {
                        this.handle_notification(
                            &notification.method,
                            &notification.params,
                            Some(&backend),
                            queue.as_deref(),
                            Some(notification.event_id),
                        )
                        .await;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub(super) async fn register(
        &self,
        profile_id: String,
        registration_id: String,
        token: String,
        platform: String,
        device_name: String,
        events: PushEventPreferences,
    ) -> Result<usize, BridgeError> {
        self.registry
            .register(
                profile_id,
                registration_id,
                token,
                platform,
                device_name,
                events,
            )
            .await
    }

    pub(super) async fn unregister(
        &self,
        profile_id: &str,
        registration_id: &str,
    ) -> Result<bool, BridgeError> {
        self.registry.unregister(profile_id, registration_id).await
    }

    pub(super) async fn unregister_stale_token(&self, token: &str) -> bool {
        match self.registry.unregister_token(token).await {
            Ok(removed) => removed,
            Err(error) => {
                eprintln!("failed to unregister push device: {}", error.message);
                false
            }
        }
    }

    pub(super) async fn list(&self) -> Vec<Value> {
        let registry = self.registry.snapshot().await;
        registry
            .devices
            .iter()
            .map(|device| {
                json!({
                    "platform": device.platform,
                    "profileId": device.profile_id,
                    "registrationId": device.registration_id,
                    "deviceName": device.device_name,
                    "events": device.events,
                    "createdAt": device.created_at,
                    "updatedAt": device.updated_at,
                    // Never echo full tokens back to clients; expose only a short suffix.
                    "tokenSuffix": token_suffix(&device.token),
                })
            })
            .collect()
    }

    /// Pull params.threadId (or thread_id), trimmed and non-empty.
    pub(super) fn read_thread_id(params: &Value) -> Option<String> {
        read_string(params.get("threadId"))
            .or_else(|| read_string(params.get("thread_id")))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    /// Accumulate streamed agent reply text per thread so a completed turn can
    /// include a short preview. Handles the app-server delta method and the
    /// codex-event variant; only text deltas are captured. Returns true if the
    /// notification was a reply delta (and thus fully handled here).
    pub(super) async fn accumulate_reply(&self, method: &str, params: &Value) -> bool {
        let is_delta = matches!(
            method,
            "item/agentMessage/delta" | "codex/event/agent_message_delta"
        );
        if !is_delta {
            return false;
        }
        let field_is_text = read_string(params.get("field"))
            .map(|value| value == "text")
            .unwrap_or(true);
        let delta = read_string(params.get("delta"))
            .or_else(|| read_string(params.get("text")))
            .unwrap_or_default();
        if !field_is_text || delta.is_empty() {
            return true;
        }
        if let Some(thread_id) = Self::read_thread_id(params) {
            let mut replies = self.recent_replies.write().await;
            if !replies.contains_key(&thread_id) && replies.len() >= PUSH_PREVIEW_MAX_THREADS {
                if let Some(oldest_key) = replies.keys().next().cloned() {
                    replies.remove(&oldest_key);
                }
            }
            let entry = replies.entry(thread_id).or_default();
            // Cap accumulation so a long turn cannot grow this unbounded.
            if entry.len() < PUSH_PREVIEW_ACCUMULATE_CAP {
                let remaining = PUSH_PREVIEW_ACCUMULATE_CAP - entry.len();
                let (bounded, _) = resource_limits::truncate_utf8_bytes(&delta, remaining);
                entry.push_str(&bounded);
            }
        }
        true
    }

    /// Remove and format the accumulated reply for a thread into a one-line
    /// preview: last non-empty line (agents usually end with the conclusion),
    /// whitespace-collapsed, length-capped.
    pub(super) async fn take_reply_preview(&self, thread_id: &str) -> Option<String> {
        let raw = {
            let mut replies = self.recent_replies.write().await;
            replies.remove(thread_id)?
        };
        let last_line = raw
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .next_back()?;
        let collapsed = last_line.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            return None;
        }
        Some(truncate_chars(&collapsed, PUSH_PREVIEW_MAX_CHARS))
    }

    pub(super) async fn handle_notification(
        self: &Arc<Self>,
        method: &str,
        params: &Value,
        backend: Option<&RuntimeBackend>,
        queue: Option<&BridgeQueueService>,
        event_id: Option<u64>,
    ) {
        if self.accumulate_reply(method, params).await {
            return;
        }
        let event = match method {
            "turn/completed" => PushEvent::TurnCompleted,
            "bridge/approval.requested" => PushEvent::ApprovalRequested,
            _ => return,
        };

        let thread_id = read_string(params.get("threadId"))
            .or_else(|| read_string(params.get("thread_id")))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        // For approval events, carry the approval id so a notification action can
        // resolve exactly this approval without opening the conversation first.
        let approval_id = match event {
            PushEvent::ApprovalRequested => read_string(params.get("id"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            PushEvent::TurnCompleted => None,
        };

        // Drain the accumulated reply buffer on completion regardless of whether
        // any device is registered, otherwise threads streamed while no device
        // is subscribed would leak their buffers indefinitely.
        let reply_preview = match event {
            PushEvent::TurnCompleted => match thread_id.as_deref() {
                Some(tid) => self.take_reply_preview(tid).await,
                None => None,
            },
            PushEvent::ApprovalRequested => None,
        };

        if matches!(event, PushEvent::TurnCompleted) {
            let (Some(queue), Some(event_id)) = (queue, event_id) else {
                return;
            };
            match queue.wait_for_completion_disposition(event_id).await {
                Some(QueueCompletionDisposition::Final) => {}
                Some(QueueCompletionDisposition::Continued) | None => return,
            }
        }

        let targets: Vec<(String, String, String)> = {
            let registry = self.registry.snapshot().await;
            registry
                .devices
                .iter()
                .filter(|device| match event {
                    PushEvent::TurnCompleted => device.events.turn_completed,
                    PushEvent::ApprovalRequested => device.events.approval_requested,
                })
                .map(|device| {
                    (
                        device.token.clone(),
                        device.profile_id.clone(),
                        device.registration_id.clone(),
                    )
                })
                .collect()
        };
        if targets.is_empty() {
            return;
        }
        if matches!(event, PushEvent::TurnCompleted) {
            let Some(thread_id) = thread_id.as_deref() else {
                return;
            };
            let Some(backend) = backend else {
                return;
            };
            let thread = match backend
                .request_internal(
                    "thread/read",
                    Some(json!({
                        "threadId": thread_id,
                        "includeTurns": false,
                    })),
                )
                .await
            {
                Ok(result) => result,
                Err(error) => {
                    eprintln!(
                        "skipping turn-completed push because thread lineage could not be read for {thread_id}: {error}"
                    );
                    return;
                }
            };
            if !push_thread_is_top_level(&thread) {
                return;
            }
        }
        let (title, body) = match event {
            PushEvent::TurnCompleted => (
                "Turn finished".to_string(),
                reply_preview.unwrap_or_else(|| {
                    format!("The agent finished working in {}", self.project_label)
                }),
            ),
            PushEvent::ApprovalRequested => (
                "Approval needed".to_string(),
                format!(
                    "The agent is waiting for your approval in {}",
                    self.project_label
                ),
            ),
        };
        let data = json!({
            "type": event.as_str(),
            "notificationId": Uuid::new_v4().to_string(),
            "threadId": thread_id,
            "approvalId": approval_id,
        });
        // Only approval pushes get the actionable category; turn-complete pushes
        // have nothing to act on.
        let category_id = match event {
            PushEvent::ApprovalRequested if approval_id.is_some() => Some("approval"),
            _ => None,
        };

        self.send(&title, &body, &data, category_id, targets).await;
    }

    pub(super) async fn send(
        self: &Arc<Self>,
        title: &str,
        body: &str,
        data: &Value,
        category_id: Option<&str>,
        targets: Vec<(String, String, String)>,
    ) {
        for chunk in targets.chunks(EXPO_PUSH_BATCH_SIZE) {
            self.metrics.push_attempted(chunk.len());
            let messages: Vec<Value> = chunk
                .iter()
                .map(|(token, profile_id, registration_id)| {
                    let mut target_data = data.clone();
                    target_data["profileId"] = json!(profile_id);
                    target_data["registrationId"] = json!(registration_id);
                    let mut message = json!({
                        "to": token,
                        "title": title,
                        "body": body,
                        "data": target_data,
                        "sound": "default",
                        "priority": "high",
                    });
                    // iOS action buttons are driven by a registered category; the
                    // app maps this id to its Approve/Deny actions.
                    if let Some(category) = category_id {
                        message["categoryId"] = json!(category);
                    }
                    message
                })
                .collect();

            let Some(payload) = self
                .post_with_retry(EXPO_PUSH_SEND_ENDPOINT, &Value::Array(messages))
                .await
            else {
                self.metrics.push_transport_failure(chunk.len());
                continue;
            };

            // Expo returns one ticket per message, in request order. status="error"
            // is an immediate failure; status="ok" carries a receipt id that we
            // re-check later, because DeviceNotRegistered (and APNs/FCM delivery
            // failures) frequently only surface in the receipt, not the ticket.
            let Some(tickets) = payload.get("data").and_then(Value::as_array) else {
                self.metrics.push_transport_failure(chunk.len());
                continue;
            };
            let mut stale: Vec<String> = Vec::new();
            let mut pending_receipts: Vec<(String, String)> = Vec::new();
            let mut accepted = 0usize;
            let mut failed = chunk.len().saturating_sub(tickets.len());
            for (index, ticket) in tickets.iter().enumerate() {
                let Some((token, _, _)) = chunk.get(index).cloned() else {
                    continue;
                };
                match read_string(ticket.get("status")).as_deref() {
                    Some("ok") => {
                        accepted += 1;
                        if let Some(receipt_id) = read_string(ticket.get("id")) {
                            pending_receipts.push((receipt_id, token));
                        }
                    }
                    Some("error") => {
                        failed += 1;
                        let error_kind = ticket
                            .get("details")
                            .and_then(|details| read_string(details.get("error")));
                        if error_kind.as_deref() == Some("DeviceNotRegistered") {
                            stale.push(token);
                        }
                    }
                    _ => failed += 1,
                }
            }
            self.metrics.push_outcome(accepted, failed);
            for token in stale {
                self.unregister_stale_token(&token).await;
            }
            if !pending_receipts.is_empty() {
                self.spawn_receipt_check(pending_receipts);
            }
        }
    }

    /// POST JSON to Expo, retrying on 429 / 5xx / transport errors with
    /// exponential backoff (honoring Retry-After). Returns the parsed body, or
    /// None once attempts are exhausted.
    pub(super) async fn post_with_retry(&self, url: &str, body: &Value) -> Option<Value> {
        let mut delay_ms: u64 = 500;
        for attempt in 1..=PUSH_SEND_MAX_ATTEMPTS {
            let mut request = self.http.post(url).json(body);
            if let Some(token) = &self.access_token {
                request = request.bearer_auth(token);
            }
            match request.send().await {
                Ok(response) => {
                    let status = response.status();
                    if status.as_u16() == 429 || status.is_server_error() {
                        if attempt >= PUSH_SEND_MAX_ATTEMPTS {
                            eprintln!(
                                "push request to {url} gave up after {attempt} attempts (status {status})"
                            );
                            return None;
                        }
                        let wait_ms = response
                            .headers()
                            .get("retry-after")
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.parse::<u64>().ok())
                            .map(|secs| secs.saturating_mul(1000))
                            .unwrap_or(delay_ms);
                        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
                        delay_ms = (delay_ms * 2).min(8000);
                        continue;
                    }
                    match response.json::<Value>().await {
                        Ok(value) => return Some(value),
                        Err(error) => {
                            eprintln!("push response parse failed: {error}");
                            return None;
                        }
                    }
                }
                Err(error) => {
                    if attempt >= PUSH_SEND_MAX_ATTEMPTS {
                        eprintln!("push request to {url} failed after {attempt} attempts: {error}");
                        return None;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    delay_ms = (delay_ms * 2).min(8000);
                }
            }
        }
        None
    }

    /// After Expo's recommended delay, fetch delivery receipts for the given
    /// (receiptId, token) pairs and prune tokens reported DeviceNotRegistered.
    pub(super) fn spawn_receipt_check(self: &Arc<Self>, receipts: Vec<(String, String)>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(RECEIPT_CHECK_DELAY_SECS)).await;
            this.check_receipts(receipts).await;
        });
    }

    pub(super) async fn check_receipts(&self, receipts: Vec<(String, String)>) {
        for chunk in receipts.chunks(EXPO_RECEIPT_BATCH_SIZE) {
            let ids: Vec<&str> = chunk.iter().map(|(id, _)| id.as_str()).collect();
            let Some(payload) = self
                .post_with_retry(EXPO_PUSH_RECEIPTS_ENDPOINT, &json!({ "ids": ids }))
                .await
            else {
                continue;
            };
            let Some(map) = payload.get("data").and_then(Value::as_object) else {
                continue;
            };
            let mut stale: Vec<String> = Vec::new();
            for (receipt_id, receipt) in map {
                if read_string(receipt.get("status")).as_deref() != Some("error") {
                    continue;
                }
                self.metrics.push_receipt_error();
                let error_kind = receipt
                    .get("details")
                    .and_then(|details| read_string(details.get("error")));
                if error_kind.as_deref() == Some("DeviceNotRegistered") {
                    if let Some((_, token)) = chunk.iter().find(|(id, _)| id == receipt_id) {
                        stale.push(token.clone());
                    }
                }
            }
            for token in stale {
                self.unregister_stale_token(&token).await;
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum PushEvent {
    TurnCompleted,
    ApprovalRequested,
}

impl PushEvent {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            PushEvent::TurnCompleted => "turn_completed",
            PushEvent::ApprovalRequested => "approval_requested",
        }
    }
}
