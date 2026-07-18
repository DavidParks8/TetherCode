use crate::*;

impl BridgeQueuedMessageEntry {
    pub(super) fn to_public(&self) -> BridgeQueuedMessage {
        BridgeQueuedMessage {
            id: self.id.clone(),
            created_at: self.created_at.clone(),
            content: self.content.clone(),
        }
    }
}

impl BridgeQueueService {
    pub(super) fn new(backend: Arc<RuntimeBackend>, hub: Arc<ClientHub>) -> Arc<Self> {
        let service = Arc::new(Self {
            backend,
            hub,
            threads: Arc::new(RwLock::new(HashMap::new())),
            thread_actors: Arc::new(RwLock::new(HashMap::new())),
            completion_dispositions: Arc::new(Mutex::new(HashMap::new())),
            completion_disposition_notify: Arc::new(Notify::new()),
            submission_results: Arc::new(Mutex::new(HashMap::new())),
            submission_order: Arc::new(Mutex::new(VecDeque::new())),
            next_queue_item_id: AtomicU64::new(1),
        });
        service.spawn_notification_loop();
        service
    }

    pub(super) fn next_queued_message_id(&self) -> String {
        format!(
            "queue-{}",
            self.next_queue_item_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    pub(super) async fn thread_actor(&self, thread_id: &str) -> Arc<Mutex<()>> {
        if let Some(actor) = self.thread_actors.read().await.get(thread_id).cloned() {
            return actor;
        }
        let mut actors = self.thread_actors.write().await;
        actors
            .entry(thread_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub(super) fn spawn_notification_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        let mut receiver = this.hub.subscribe_notifications();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(notification) => this.handle_notification(notification).await,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        this.reconcile_all_threads().await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    pub(super) async fn read_queue(&self, thread_id: &str) -> BridgeThreadQueueState {
        let normalized_thread_id = thread_id.trim();
        if normalized_thread_id.is_empty() {
            return BridgeThreadQueueState {
                thread_id: String::new(),
                items: Vec::new(),
                last_error: None,
            };
        }

        let threads = self.threads.read().await;
        let runtime = threads.get(normalized_thread_id);
        Self::snapshot_for_thread(normalized_thread_id, runtime)
    }

    pub(super) async fn status(&self) -> QueueStatus {
        let threads = self.threads.read().await;
        QueueStatus {
            tracked_threads: threads.len(),
            depth: threads.values().map(|runtime| runtime.items.len()).sum(),
            busy_threads: threads
                .values()
                .filter(|runtime| Self::runtime_is_blocked_or_occupied(runtime))
                .count(),
        }
    }

    pub(super) async fn record_completion_disposition(
        &self,
        event_id: u64,
        disposition: QueueCompletionDisposition,
    ) {
        let mut dispositions = self.completion_dispositions.lock().await;
        if dispositions.len() >= QUEUE_COMPLETION_DISPOSITION_LIMIT {
            if let Some(oldest_event_id) = dispositions.keys().min().copied() {
                dispositions.remove(&oldest_event_id);
            }
        }
        dispositions.insert(event_id, disposition);
        drop(dispositions);
        self.completion_disposition_notify.notify_waiters();
    }

    pub(super) async fn wait_for_completion_disposition(
        &self,
        event_id: u64,
    ) -> Option<QueueCompletionDisposition> {
        let deadline = Instant::now() + Duration::from_millis(QUEUE_COMPLETION_DISPOSITION_WAIT_MS);
        loop {
            let notified = self.completion_disposition_notify.notified();
            if let Some(disposition) = self.completion_dispositions.lock().await.remove(&event_id) {
                return Some(disposition);
            }

            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            if timeout(deadline.saturating_duration_since(now), notified)
                .await
                .is_err()
            {
                return None;
            }
        }
    }

    pub(super) async fn send_message(
        &self,
        request: BridgeThreadQueueSendRequest,
    ) -> Result<BridgeThreadQueueSendResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let submission_id = request.submission_id.trim().to_string();
        let content = request.content.trim().to_string();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }
        if content.is_empty() {
            return Err("content must not be empty".to_string());
        }
        if submission_id.is_empty() {
            return Err("submissionId must not be empty".to_string());
        }
        if content.len() > QUEUE_MAX_CONTENT_BYTES {
            return Err(format!(
                "queue content exceeds {QUEUE_MAX_CONTENT_BYTES} bytes (actual {})",
                content.len()
            ));
        }
        let item_bytes = serde_json::to_vec(&request.turn_start)
            .map(|value| value.len())
            .unwrap_or(usize::MAX)
            .saturating_add(content.len());
        if item_bytes > QUEUE_MAX_ITEM_BYTES {
            return Err(format!(
                "queue item exceeds {QUEUE_MAX_ITEM_BYTES} bytes (actual {item_bytes})"
            ));
        }

        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;
        if let Some(result) = self
            .submission_results
            .lock()
            .await
            .get(&submission_id)
            .cloned()
        {
            if result.queue.thread_id != normalized_thread_id {
                return Err("submissionId is already bound to another thread".to_string());
            }
            return Ok(result);
        }

        self.ensure_thread_runtime(&normalized_thread_id).await?;

        let queued_item = BridgeQueuedMessageEntry {
            id: self.next_queued_message_id(),
            created_at: now_iso(),
            content,
            turn_start: request.turn_start,
        };

        let should_queue = {
            let threads = self.threads.read().await;
            let runtime = threads.get(&normalized_thread_id);
            runtime.is_some_and(Self::runtime_is_blocked_or_occupied)
        };

        if should_queue {
            let snapshot = {
                let mut threads = self.threads.write().await;
                let runtime = threads
                    .entry(normalized_thread_id.clone())
                    .or_insert_with(BridgeThreadQueueRuntime::default);
                if runtime.items.len() >= QUEUE_MAX_ITEMS_PER_THREAD {
                    return Err(format!(
                        "queue limit reached for thread (max {QUEUE_MAX_ITEMS_PER_THREAD})"
                    ));
                }
                let queued_bytes = runtime
                    .items
                    .iter()
                    .map(|item| {
                        item.content.len()
                            + serde_json::to_vec(&item.turn_start)
                                .map(|value| value.len())
                                .unwrap_or(usize::MAX)
                    })
                    .sum::<usize>();
                if queued_bytes.saturating_add(item_bytes) > QUEUE_MAX_BYTES_PER_THREAD {
                    return Err(format!(
                        "resource_limit:queue_thread_bytes:{QUEUE_MAX_BYTES_PER_THREAD}:{}",
                        queued_bytes.saturating_add(item_bytes)
                    ));
                }
                runtime.items.push_back(queued_item);
                runtime.last_error = None;
                Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
            };
            self.broadcast_snapshot(&snapshot).await;
            let result = BridgeThreadQueueSendResponse {
                submission_id,
                disposition: BridgeThreadQueueDisposition::Queued,
                queue: snapshot,
                turn_id: None,
            };
            self.remember_submission_result(result.clone()).await;
            return Ok(result);
        }

        {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .entry(normalized_thread_id.clone())
                .or_insert_with(BridgeThreadQueueRuntime::default);
            runtime.turn_start_in_flight = true;
            runtime.last_error = None;
        }

        match self
            .dispatch_turn_start(&normalized_thread_id, &queued_item.turn_start)
            .await
        {
            Ok(turn_id) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    runtime.turn_start_in_flight = false;
                    runtime.thread_running = true;
                    runtime.active_turn_id = Some(turn_id.clone());
                    runtime.last_error = None;
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                let result = BridgeThreadQueueSendResponse {
                    submission_id,
                    disposition: BridgeThreadQueueDisposition::Sent,
                    queue: snapshot,
                    turn_id: Some(turn_id),
                };
                self.remember_submission_result(result.clone()).await;
                Ok(result)
            }
            Err(error) => {
                let mut threads = self.threads.write().await;
                if let Some(runtime) = threads.get_mut(&normalized_thread_id) {
                    runtime.turn_start_in_flight = false;
                }
                Err(error)
            }
        }
    }

    pub(super) async fn remember_submission_result(&self, result: BridgeThreadQueueSendResponse) {
        let submission_id = result.submission_id.clone();
        let mut results = self.submission_results.lock().await;
        let mut order = self.submission_order.lock().await;
        if results.insert(submission_id.clone(), result).is_none() {
            order.push_back(submission_id);
        }
        while order.len() > SUBMISSION_DEDUPE_LIMIT {
            if let Some(oldest) = order.pop_front() {
                results.remove(&oldest);
            }
        }
    }

    pub(super) async fn steer_message(
        &self,
        request: BridgeThreadQueueSteerRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }
        if normalized_item_id.is_empty() {
            return Err("itemId must not be empty".to_string());
        }

        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;

        self.ensure_thread_runtime(&normalized_thread_id).await?;

        let (turn_id, removed_item, removed_index, snapshot) = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;

            if runtime.turn_start_in_flight || runtime.action_in_flight_item_id.is_some() {
                return Err("queue is busy processing another action".to_string());
            }
            if !runtime.pending_approval_ids.is_empty() {
                return Err("cannot steer while an approval is pending".to_string());
            }
            if !runtime.pending_user_input_ids.is_empty() {
                return Err("cannot steer while user input is pending".to_string());
            }

            let active_turn_id = runtime
                .active_turn_id
                .clone()
                .ok_or_else(|| "no active turn available to steer".to_string())?;
            let item_index = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            let removed_item = runtime
                .items
                .remove(item_index)
                .ok_or_else(|| "queued message not found".to_string())?;
            runtime.action_in_flight_item_id = Some(normalized_item_id.clone());
            runtime.last_error = None;
            let snapshot = Self::snapshot_for_thread(&normalized_thread_id, Some(runtime));
            (active_turn_id, removed_item, item_index, snapshot)
        };

        self.broadcast_snapshot(&snapshot).await;

        match self
            .dispatch_turn_steer(&normalized_thread_id, &turn_id, &removed_item.turn_start)
            .await
        {
            Ok(()) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    if runtime.action_in_flight_item_id.as_deref()
                        == Some(normalized_item_id.as_str())
                    {
                        runtime.action_in_flight_item_id = None;
                    }
                    runtime.last_error = None;
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                Ok(BridgeThreadQueueActionResponse {
                    ok: true,
                    queue: snapshot,
                })
            }
            Err(error) => {
                let snapshot = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads
                        .entry(normalized_thread_id.clone())
                        .or_insert_with(BridgeThreadQueueRuntime::default);
                    if runtime.action_in_flight_item_id.as_deref()
                        == Some(normalized_item_id.as_str())
                    {
                        runtime.action_in_flight_item_id = None;
                    }
                    let insert_index = removed_index.min(runtime.items.len());
                    runtime.items.insert(insert_index, removed_item);
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: error.clone(),
                        operation: "steer".to_string(),
                        at: now_iso(),
                        item_id: Some(normalized_item_id.clone()),
                    });
                    Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
                };
                self.broadcast_snapshot(&snapshot).await;
                Err(error)
            }
        }
    }

    pub(super) async fn cancel_message(
        &self,
        request: BridgeThreadQueueCancelRequest,
    ) -> Result<BridgeThreadQueueActionResponse, String> {
        let normalized_thread_id = request.thread_id.trim().to_string();
        let normalized_item_id = request.item_id.trim().to_string();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }
        if normalized_item_id.is_empty() {
            return Err("itemId must not be empty".to_string());
        }

        let actor = self.thread_actor(&normalized_thread_id).await;
        let _actor_guard = actor.lock().await;

        let snapshot = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .entry(normalized_thread_id.clone())
                .or_insert_with(BridgeThreadQueueRuntime::default);
            if runtime.action_in_flight_item_id.as_deref() == Some(normalized_item_id.as_str()) {
                return Err(
                    "cannot cancel a queued message while it is being processed".to_string()
                );
            }
            let Some(item_index) = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
            else {
                return Err("queued message not found".to_string());
            };
            runtime.items.remove(item_index);
            runtime.last_error = None;
            Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
        };

        self.broadcast_snapshot(&snapshot).await;

        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
    }

    pub(super) async fn ensure_thread_runtime(&self, thread_id: &str) -> Result<(), String> {
        let normalized_thread_id = thread_id.trim();
        if normalized_thread_id.is_empty() {
            return Err("threadId must not be empty".to_string());
        }

        {
            let threads = self.threads.read().await;
            if threads.contains_key(normalized_thread_id) {
                return Ok(());
            }
        }

        let hydrated = self.hydrate_thread_runtime(normalized_thread_id).await?;
        let mut threads = self.threads.write().await;
        threads
            .entry(normalized_thread_id.to_string())
            .or_insert(hydrated);
        Ok(())
    }

    pub(super) async fn hydrate_thread_runtime(
        &self,
        thread_id: &str,
    ) -> Result<BridgeThreadQueueRuntime, String> {
        let thread_result = self
            .backend
            .request_internal("thread/read", Some(json!({ "threadId": thread_id })))
            .await?;
        let thread = thread_result
            .get("thread")
            .ok_or_else(|| "thread/read did not return thread".to_string())?;

        let approvals = self.backend.list_pending_approvals().await;
        let user_inputs = self.backend.list_pending_user_inputs().await;

        let mut runtime = BridgeThreadQueueRuntime::default();
        runtime.active_turn_id = read_active_turn_id_from_thread(thread);
        runtime.thread_running = thread_has_running_turn(thread);
        runtime.pending_approval_ids = approvals
            .into_iter()
            .filter(|entry| entry.thread_id == thread_id)
            .map(|entry| entry.id)
            .collect();
        runtime.pending_user_input_ids = user_inputs
            .into_iter()
            .filter(|entry| entry.thread_id == thread_id)
            .map(|entry| entry.id)
            .collect();
        Ok(runtime)
    }

    pub(super) async fn reconcile_all_threads(&self) {
        let thread_ids = self
            .threads
            .read()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for thread_id in thread_ids {
            let actor = self.thread_actor(&thread_id).await;
            let _actor_guard = actor.lock().await;
            match self.hydrate_thread_runtime(&thread_id).await {
                Ok(hydrated) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                        runtime.active_turn_id = hydrated.active_turn_id;
                        runtime.thread_running = hydrated.thread_running;
                        runtime.pending_approval_ids = hydrated.pending_approval_ids;
                        runtime.pending_user_input_ids = hydrated.pending_user_input_ids;
                    }
                }
                Err(error) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                        runtime.thread_running = true;
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error,
                            operation: "reconcile".to_string(),
                            at: now_iso(),
                            item_id: None,
                        });
                    }
                }
            }
        }
    }

    pub(super) async fn dispatch_turn_start(
        &self,
        thread_id: &str,
        turn_start: &Value,
    ) -> Result<String, String> {
        Self::dispatch_turn_start_with_backend(&self.backend, thread_id, turn_start).await
    }

    pub(super) async fn dispatch_turn_start_with_backend(
        backend: &Arc<RuntimeBackend>,
        thread_id: &str,
        turn_start: &Value,
    ) -> Result<String, String> {
        let mut params = turn_start.clone();
        let params_object = params
            .as_object_mut()
            .ok_or_else(|| "turnStart payload must be an object".to_string())?;
        params_object.insert("threadId".to_string(), Value::String(thread_id.to_string()));

        let response = backend
            .request_internal("turn/start", Some(Value::Object(params_object.clone())))
            .await?;
        read_string(
            response
                .as_object()
                .and_then(|object| object.get("turn"))
                .and_then(Value::as_object)
                .and_then(|turn| turn.get("id")),
        )
        .ok_or_else(|| "turn/start did not return turn id".to_string())
    }

    pub(super) async fn dispatch_turn_steer(
        &self,
        thread_id: &str,
        turn_id: &str,
        turn_start: &Value,
    ) -> Result<(), String> {
        let input = turn_start
            .as_object()
            .and_then(|object| object.get("input"))
            .cloned()
            .ok_or_else(|| "turnStart payload missing input".to_string())?;

        self.backend
            .request_internal(
                "turn/steer",
                Some(json!({
                    "threadId": thread_id,
                    "expectedTurnId": turn_id,
                    "input": input,
                })),
            )
            .await?;
        Ok(())
    }

    pub(super) async fn broadcast_snapshot(&self, snapshot: &BridgeThreadQueueState) {
        if let Ok(value) = serde_json::to_value(snapshot) {
            self.hub
                .broadcast_notification("bridge/thread/queue/updated", value)
                .await;
        }
    }

    pub(super) fn snapshot_for_thread(
        thread_id: &str,
        runtime: Option<&BridgeThreadQueueRuntime>,
    ) -> BridgeThreadQueueState {
        let (items, last_error) = runtime.map_or((Vec::new(), None), |runtime| {
            (
                runtime
                    .items
                    .iter()
                    .map(BridgeQueuedMessageEntry::to_public)
                    .collect::<Vec<_>>(),
                runtime.last_error.clone(),
            )
        });

        BridgeThreadQueueState {
            thread_id: thread_id.to_string(),
            items,
            last_error,
        }
    }

    pub(super) fn runtime_has_blockers(runtime: &BridgeThreadQueueRuntime) -> bool {
        runtime.thread_running
            || runtime.turn_start_in_flight
            || runtime.action_in_flight_item_id.is_some()
            || !runtime.pending_approval_ids.is_empty()
            || !runtime.pending_user_input_ids.is_empty()
    }

    pub(super) fn runtime_is_blocked_or_occupied(runtime: &BridgeThreadQueueRuntime) -> bool {
        Self::runtime_has_blockers(runtime) || !runtime.items.is_empty()
    }

    pub(super) async fn handle_notification(self: &Arc<Self>, notification: HubNotification) {
        match notification.method.as_str() {
            "turn/started" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let turn_id = read_string(notification.params.get("turnId"));
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.thread_running = true;
                runtime.turn_start_in_flight = false;
                if let Some(turn_id) = turn_id {
                    runtime.active_turn_id = Some(turn_id);
                }
                runtime.last_error = None;
            }
            "turn/completed" => {
                let completion_event_id = notification.event_id;
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let (should_dispatch, is_final) = {
                    let mut threads = self.threads.write().await;
                    match threads.get_mut(&thread_id) {
                        Some(runtime) => {
                            let completed_turn_id = read_notification_turn_id(&notification.params);
                            if runtime.active_turn_id.is_some()
                                && completed_turn_id.as_deref() != runtime.active_turn_id.as_deref()
                            {
                                return;
                            }
                            let continuation_already_in_flight = runtime.turn_start_in_flight;
                            runtime.thread_running = false;
                            if !continuation_already_in_flight {
                                runtime.active_turn_id = None;
                            }
                            runtime.pending_approval_ids.clear();
                            runtime.pending_user_input_ids.clear();
                            runtime.action_in_flight_item_id = None;
                            let should_dispatch =
                                !continuation_already_in_flight && !runtime.items.is_empty();
                            let wait_for_continuation =
                                continuation_already_in_flight || should_dispatch;
                            if wait_for_continuation {
                                runtime
                                    .pending_completion_event_ids
                                    .push(completion_event_id);
                            }
                            (should_dispatch, !wait_for_continuation)
                        }
                        None => (false, true),
                    }
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
                if is_final {
                    self.record_completion_disposition(
                        completion_event_id,
                        QueueCompletionDisposition::Final,
                    )
                    .await;
                }
            }
            "thread/status/changed" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(status) = read_string(notification.params.get("status"))
                    .map(|value| value.trim().to_lowercase())
                else {
                    return;
                };
                {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    if matches!(status.as_str(), "running" | "pending" | "queued") {
                        runtime.thread_running = true;
                    } else if !runtime.turn_start_in_flight {
                        runtime.thread_running = false;
                        runtime.active_turn_id = None;
                    }
                }
                if !matches!(status.as_str(), "running" | "pending" | "queued") {
                    self.spawn_status_dispatch_fallback(thread_id);
                }
            }
            "bridge/approval.requested" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(approval_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.pending_approval_ids.insert(approval_id);
            }
            "bridge/approval.resolved" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(approval_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let should_dispatch = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.pending_approval_ids.remove(&approval_id);
                    !Self::runtime_has_blockers(runtime) && !runtime.items.is_empty()
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
            }
            "bridge/userInput.requested" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(request_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                runtime.pending_user_input_ids.insert(request_id);
            }
            "bridge/userInput.resolved" => {
                let Some(thread_id) = read_string(notification.params.get("threadId"))
                    .map(|value| value.trim().to_string())
                else {
                    return;
                };
                let Some(request_id) = read_string(notification.params.get("id")) else {
                    return;
                };
                let should_dispatch = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.pending_user_input_ids.remove(&request_id);
                    !Self::runtime_has_blockers(runtime) && !runtime.items.is_empty()
                };
                if should_dispatch {
                    self.spawn_auto_dispatch(thread_id);
                }
            }
            _ => {}
        }
    }

    pub(super) fn spawn_auto_dispatch(self: &Arc<Self>, thread_id: String) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.drain_thread_queue(thread_id).await;
        });
    }

    pub(super) fn spawn_status_dispatch_fallback(self: &Arc<Self>, thread_id: String) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            sleep(Duration::from_millis(QUEUE_STATUS_DISPATCH_FALLBACK_MS)).await;
            this.drain_thread_queue(thread_id).await;
        });
    }

    pub(super) async fn drain_thread_queue(&self, thread_id: String) {
        let actor = self.thread_actor(&thread_id).await;
        let _actor_guard = actor.lock().await;
        let (queued_item, snapshot) = {
            let mut threads = self.threads.write().await;
            let Some(runtime) = threads.get_mut(&thread_id) else {
                return;
            };
            if runtime.thread_running
                || runtime.turn_start_in_flight
                || runtime.action_in_flight_item_id.is_some()
                || !runtime.pending_approval_ids.is_empty()
                || !runtime.pending_user_input_ids.is_empty()
            {
                return;
            }
            let Some(queued_item) = runtime.items.pop_front() else {
                let completion_event_ids =
                    std::mem::take(&mut runtime.pending_completion_event_ids);
                drop(threads);
                for event_id in completion_event_ids {
                    self.record_completion_disposition(event_id, QueueCompletionDisposition::Final)
                        .await;
                }
                return;
            };
            runtime.turn_start_in_flight = true;
            runtime.last_error = None;
            let snapshot = BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime));
            (queued_item, snapshot)
        };

        if let Ok(value) = serde_json::to_value(&snapshot) {
            self.hub
                .broadcast_notification("bridge/thread/queue/updated", value)
                .await;
        }

        match BridgeQueueService::dispatch_turn_start_with_backend(
            &self.backend,
            &thread_id,
            &queued_item.turn_start,
        )
        .await
        {
            Ok(turn_id) => {
                let completion_event_ids = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.turn_start_in_flight = false;
                    runtime.thread_running = true;
                    runtime.active_turn_id = Some(turn_id);
                    runtime.last_error = None;
                    std::mem::take(&mut runtime.pending_completion_event_ids)
                };
                for event_id in completion_event_ids {
                    self.record_completion_disposition(
                        event_id,
                        QueueCompletionDisposition::Continued,
                    )
                    .await;
                }
            }
            Err(error) => {
                let (snapshot, completion_event_ids) = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.turn_start_in_flight = false;
                    runtime.items.push_front(queued_item);
                    runtime.last_error = Some(BridgeThreadQueueError {
                        message: error.clone(),
                        operation: "dispatch".to_string(),
                        at: now_iso(),
                        item_id: runtime.items.front().map(|item| item.id.clone()),
                    });
                    (
                        BridgeQueueService::snapshot_for_thread(&thread_id, Some(runtime)),
                        std::mem::take(&mut runtime.pending_completion_event_ids),
                    )
                };
                if let Ok(value) = serde_json::to_value(&snapshot) {
                    self.hub
                        .broadcast_notification("bridge/thread/queue/updated", value)
                        .await;
                }
                for event_id in completion_event_ids {
                    self.record_completion_disposition(event_id, QueueCompletionDisposition::Final)
                        .await;
                }
            }
        }
    }
}
