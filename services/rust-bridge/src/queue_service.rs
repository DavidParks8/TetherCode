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
    pub(super) fn new<B>(backend: Arc<B>, hub: Arc<ClientHub>) -> Arc<Self>
    where
        B: QueueRuntimeDispatcher + 'static,
    {
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
        let mut receiver = this.hub.subscribe_canonical_events();
        tokio::spawn(async move {
            while let Some(event) = receiver.recv().await {
                this.handle_canonical_event(event).await;
            }
        });
    }

    pub(super) async fn read_queue(&self, thread_id: &str) -> BridgeThreadQueueState {
        let normalized_thread_id = thread_id.trim();
        if normalized_thread_id.is_empty() {
            return BridgeThreadQueueState {
                thread_id: String::new(),
                items: Vec::new(),
                pending_steers: Vec::new(),
                pending_steer_count: 0,
                waiting_for_tool_calls: false,
                steering_in_flight: false,
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
        self: &Arc<Self>,
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
        if !self.backend.supports_steer(&normalized_thread_id)? {
            return Err("ACP steering extension is not negotiated for this agent".to_string());
        }

        let snapshot = {
            let mut threads = self.threads.write().await;
            let runtime = threads
                .get_mut(&normalized_thread_id)
                .ok_or_else(|| "queue state unavailable".to_string())?;

            if runtime.turn_start_in_flight || runtime.action_in_flight_item_id.is_some() {
                return Err("queue is busy processing another action".to_string());
            }
            if !runtime.thread_running
                || runtime.active_turn_id.is_none()
                || runtime.active_run_id.is_none()
                || runtime.active_prompt_generation.is_none()
                || !runtime.live_generation_known
            {
                return Err("no live ACP prompt generation available to steer".to_string());
            }
            let item_index = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
                .ok_or_else(|| "queued message not found".to_string())?;
            let removed_item = runtime
                .items
                .remove(item_index)
                .expect("index came from position");
            runtime.pending_steers.push_back(removed_item);
            runtime.last_error = None;
            Self::snapshot_for_thread(&normalized_thread_id, Some(runtime))
        };

        self.broadcast_snapshot(&snapshot).await;
        drop(_actor_guard);
        self.spawn_steer_dispatch(normalized_thread_id);
        Ok(BridgeThreadQueueActionResponse {
            ok: true,
            queue: snapshot,
        })
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
            if let Some(item_index) = runtime
                .items
                .iter()
                .position(|item| item.id == normalized_item_id)
            {
                runtime.items.remove(item_index);
            } else if let Some(item_index) = runtime
                .pending_steers
                .iter()
                .position(|item| item.id == normalized_item_id)
            {
                runtime.pending_steers.remove(item_index);
            } else if runtime
                .steer_dispatch_in_flight
                .as_ref()
                .is_some_and(|pending| pending.entry.id == normalized_item_id)
            {
                return Err("cannot cancel a steer already dispatched to the agent".to_string());
            } else {
                return Err("queued message not found".to_string());
            }
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
        let snapshot = self.backend.read_snapshot(thread_id).await?;
        let session = snapshot.session;
        let live_generation_known =
            session.active_generation.is_some() && !session.history_reconstruction;

        Ok(BridgeThreadQueueRuntime {
            active_turn_id: session.active_source_turn_id,
            active_run_id: session.active_run_id,
            active_prompt_generation: session.active_generation,
            active_tool_call_ids: session.active_tool_ids,
            live_generation_known,
            thread_running: live_generation_known,
            pending_approval_ids: snapshot.pending_approval_ids,
            pending_user_input_ids: snapshot.pending_user_input_ids,
            ..BridgeThreadQueueRuntime::default()
        })
    }

    #[cfg(test)]
    pub(super) async fn reconcile_all_threads(self: &Arc<Self>) {
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
            let mut should_drain_steers = false;
            match self.hydrate_thread_runtime(&thread_id).await {
                Ok(hydrated) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                        runtime.active_turn_id = hydrated.active_turn_id;
                        runtime.active_run_id = hydrated.active_run_id;
                        runtime.active_prompt_generation = hydrated.active_prompt_generation;
                        runtime.active_tool_call_ids = hydrated.active_tool_call_ids;
                        runtime.live_generation_known = hydrated.live_generation_known;
                        runtime.thread_running = hydrated.thread_running;
                        runtime.pending_approval_ids = hydrated.pending_approval_ids;
                        runtime.pending_user_input_ids = hydrated.pending_user_input_ids;
                        should_drain_steers = !runtime.pending_steers.is_empty()
                            && runtime.active_tool_call_ids.is_empty()
                            && runtime.live_generation_known;
                    }
                }
                Err(error) => {
                    if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                        runtime.thread_running = true;
                        runtime.live_generation_known = false;
                        runtime.active_tool_call_ids.clear();
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error,
                            operation: "reconcile".to_string(),
                            at: now_iso(),
                            item_id: None,
                        });
                    }
                }
            }
            drop(_actor_guard);
            if should_drain_steers {
                self.spawn_steer_dispatch(thread_id);
            }
        }
    }

    pub(super) async fn dispatch_turn_start(
        &self,
        thread_id: &str,
        turn_start: &Value,
    ) -> Result<String, String> {
        self.backend.turn_start(thread_id, turn_start).await
    }

    pub(super) fn spawn_steer_dispatch(self: &Arc<Self>, thread_id: String) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            this.drain_pending_steers(thread_id).await;
        });
    }

    pub(super) async fn drain_pending_steers(self: &Arc<Self>, thread_id: String) {
        loop {
            let actor = self.thread_actor(&thread_id).await;
            let actor_guard = actor.lock().await;
            let should_prepare = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                if runtime.pending_steers.is_empty()
                    || runtime.steer_prepare_in_flight
                    || runtime.steer_dispatch_in_flight.is_some()
                    || runtime.turn_start_in_flight
                    || runtime.action_in_flight_item_id.is_some()
                    || !runtime.active_tool_call_ids.is_empty()
                    || !runtime.live_generation_known
                    || !runtime.thread_running
                {
                    return;
                }
                let should_prepare = true;
                if should_prepare {
                    runtime.steer_prepare_in_flight = true;
                }
                should_prepare
            };

            let interaction_epoch = if should_prepare {
                drop(actor_guard);
                let result = self.backend.prepare_steer(&thread_id).await;
                let actor_guard = actor.lock().await;
                let (snapshot, should_auto_dispatch) = {
                    let mut threads = self.threads.write().await;
                    let Some(runtime) = threads.get_mut(&thread_id) else {
                        return;
                    };
                    runtime.steer_prepare_in_flight = false;
                    if let Err(error) = &result {
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error.clone(),
                            operation: "steer".to_string(),
                            at: now_iso(),
                            item_id: runtime.pending_steers.front().map(|entry| entry.id.clone()),
                        });
                    }
                    (
                        Self::snapshot_for_thread(&thread_id, Some(runtime)),
                        result.is_err()
                            && runtime.pending_steers.is_empty()
                            && !runtime.thread_running
                            && !runtime.items.is_empty(),
                    )
                };
                drop(actor_guard);
                if snapshot.last_error.is_some() {
                    self.broadcast_snapshot(&snapshot).await;
                    return;
                }
                if should_auto_dispatch {
                    self.spawn_auto_dispatch(thread_id.clone());
                }
                let epoch = result.expect("error returned above");
                match self.backend.verify_steer_epoch(&thread_id, epoch).await {
                    Ok(true) => epoch,
                    Ok(false) => continue,
                    Err(error) => {
                        self.fail_steer_dispatch(&thread_id, "prepare", error).await;
                        return;
                    }
                }
            } else {
                continue;
            };

            let actor_guard = actor.lock().await;
            let dispatch = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                if runtime.steer_dispatch_in_flight.is_some()
                    || runtime.turn_start_in_flight
                    || runtime.action_in_flight_item_id.is_some()
                    || !runtime.active_tool_call_ids.is_empty()
                    || !runtime.live_generation_known
                    || !runtime.thread_running
                    || !runtime.pending_approval_ids.is_empty()
                    || !runtime.pending_user_input_ids.is_empty()
                {
                    return;
                }
                let (Some(expected_turn_id), Some(expected_run_id), Some(prompt_generation)) = (
                    runtime.active_turn_id.clone(),
                    runtime.active_run_id.clone(),
                    runtime.active_prompt_generation,
                ) else {
                    return;
                };
                let Some(entry) = runtime.pending_steers.pop_front() else {
                    return;
                };
                let dispatch = PendingSteerDispatch {
                    entry,
                    expected_turn_id,
                    expected_run_id,
                    prompt_generation,
                    crossed_completion_boundary: false,
                };
                runtime.steer_dispatch_in_flight = Some(dispatch.clone());
                dispatch
            };
            drop(actor_guard);

            let prompt = match crate::runtime_backend::bridge_prompt(&dispatch.entry.turn_start) {
                Ok(prompt) => prompt,
                Err(error) => {
                    self.fail_steer_dispatch(&thread_id, &dispatch.entry.id, error)
                        .await;
                    return;
                }
            };
            let result = self
                .backend
                .steer(
                    &thread_id,
                    dispatch.expected_run_id.clone(),
                    dispatch.expected_turn_id.clone(),
                    dispatch.prompt_generation,
                    interaction_epoch,
                    prompt,
                )
                .await;
            let dispatch_failed = result.is_err();
            let actor_guard = actor.lock().await;
            let snapshot = {
                let mut threads = self.threads.write().await;
                let Some(runtime) = threads.get_mut(&thread_id) else {
                    return;
                };
                let Some(owned) = runtime.steer_dispatch_in_flight.take() else {
                    return;
                };
                if owned.entry.id != dispatch.entry.id {
                    runtime.steer_dispatch_in_flight = Some(owned);
                    return;
                }
                match result {
                    Ok(()) => runtime.last_error = None,
                    Err(error) => {
                        if owned.crossed_completion_boundary {
                            runtime.items.push_front(owned.entry.clone());
                        } else {
                            runtime.pending_steers.push_front(owned.entry.clone());
                        }
                        runtime.last_error = Some(BridgeThreadQueueError {
                            message: error,
                            operation: "steer".to_string(),
                            at: now_iso(),
                            item_id: Some(owned.entry.id),
                        });
                    }
                }
                Self::snapshot_for_thread(&thread_id, Some(runtime))
            };
            drop(actor_guard);
            self.broadcast_snapshot(&snapshot).await;
            if dispatch_failed {
                self.spawn_auto_dispatch(thread_id.clone());
                return;
            }
        }
    }

    async fn fail_steer_dispatch(&self, thread_id: &str, item_id: &str, error: String) {
        let snapshot = {
            let mut threads = self.threads.write().await;
            let Some(runtime) = threads.get_mut(thread_id) else {
                return;
            };
            if let Some(owned) = runtime.steer_dispatch_in_flight.take() {
                runtime.pending_steers.push_front(owned.entry);
            }
            runtime.last_error = Some(BridgeThreadQueueError {
                message: error,
                operation: "steer".to_string(),
                at: now_iso(),
                item_id: Some(item_id.to_string()),
            });
            Self::snapshot_for_thread(thread_id, Some(runtime))
        };
        self.broadcast_snapshot(&snapshot).await;
    }

    pub(super) async fn broadcast_snapshot(&self, snapshot: &BridgeThreadQueueState) {
        let value = serde_json::to_value(snapshot).expect("queue snapshot serializes");
        self.hub
            .broadcast_notification("bridge/thread/queue/updated", value)
            .await;
    }

    pub(super) fn snapshot_for_thread(
        thread_id: &str,
        runtime: Option<&BridgeThreadQueueRuntime>,
    ) -> BridgeThreadQueueState {
        let (items, pending_steers, waiting_for_tool_calls, steering_in_flight, last_error) =
            runtime.map_or((Vec::new(), Vec::new(), false, false, None), |runtime| {
                (
                    runtime
                        .items
                        .iter()
                        .map(BridgeQueuedMessageEntry::to_public)
                        .collect::<Vec<_>>(),
                    runtime
                        .steer_dispatch_in_flight
                        .iter()
                        .map(|dispatch| &dispatch.entry)
                        .chain(runtime.pending_steers.iter())
                        .map(BridgeQueuedMessageEntry::to_public)
                        .collect::<Vec<_>>(),
                    !runtime.pending_steers.is_empty() && !runtime.active_tool_call_ids.is_empty(),
                    runtime.steer_dispatch_in_flight.is_some(),
                    runtime.last_error.clone(),
                )
            });
        let pending_steer_count = pending_steers.len();

        BridgeThreadQueueState {
            thread_id: thread_id.to_string(),
            items,
            pending_steers,
            pending_steer_count,
            waiting_for_tool_calls,
            steering_in_flight,
            last_error,
        }
    }

    pub(super) fn runtime_has_blockers(runtime: &BridgeThreadQueueRuntime) -> bool {
        runtime.thread_running
            || runtime.turn_start_in_flight
            || runtime.action_in_flight_item_id.is_some()
            || runtime.steer_prepare_in_flight
            || runtime.steer_dispatch_in_flight.is_some()
            || !runtime.pending_steers.is_empty()
            || !runtime.pending_approval_ids.is_empty()
            || !runtime.pending_user_input_ids.is_empty()
    }

    pub(super) fn runtime_is_blocked_or_occupied(runtime: &BridgeThreadQueueRuntime) -> bool {
        Self::runtime_has_blockers(runtime) || !runtime.items.is_empty()
    }

    pub(super) async fn handle_canonical_event(self: &Arc<Self>, received: CanonicalHubEvent) {
        let Some(thread_id) = received.event.thread_id().map(str::to_string) else {
            return;
        };
        let actor = self.thread_actor(&thread_id).await;
        let _actor_guard = actor.lock().await;
        match received.event {
            crate::acp::events::CanonicalEvent::RunStarted {
                thread_id,
                run_id,
                source_turn_id,
                generation,
                ..
            } => {
                let mut threads = self.threads.write().await;
                let runtime = threads.entry(thread_id).or_default();
                runtime.thread_running = true;
                runtime.turn_start_in_flight = false;
                runtime.active_turn_id = Some(source_turn_id);
                runtime.active_run_id = Some(run_id);
                runtime.active_prompt_generation = Some(generation);
                runtime.active_tool_call_ids.clear();
                runtime.live_generation_known = true;
                runtime.last_error = None;
            }
            crate::acp::events::CanonicalEvent::RunFinished {
                thread_id,
                source_turn_id,
                generation,
                ..
            }
            | crate::acp::events::CanonicalEvent::RunFailed {
                thread_id,
                source_turn_id,
                generation,
                ..
            } => {
                let (should_dispatch, should_wait_for_steer) = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads.entry(thread_id.clone()).or_default();
                    if runtime.active_turn_id.as_deref() != Some(source_turn_id.as_str())
                        || runtime.active_prompt_generation != Some(generation)
                    {
                        return;
                    }
                    runtime.thread_running = false;
                    runtime.active_turn_id = None;
                    runtime.active_run_id = None;
                    runtime.active_prompt_generation = None;
                    runtime.active_tool_call_ids.clear();
                    runtime.live_generation_known = false;
                    runtime.pending_approval_ids.clear();
                    runtime.pending_user_input_ids.clear();
                    while let Some(entry) = runtime.pending_steers.pop_back() {
                        runtime.items.push_front(entry);
                    }
                    if let Some(in_flight) = runtime.steer_dispatch_in_flight.as_mut() {
                        in_flight.crossed_completion_boundary = true;
                    }
                    (
                        runtime.steer_dispatch_in_flight.is_none() && !runtime.items.is_empty(),
                        runtime.steer_dispatch_in_flight.is_some(),
                    )
                };
                if should_dispatch {
                    {
                        let mut threads = self.threads.write().await;
                        if let Some(runtime) = threads.get_mut(&thread_id) {
                            runtime.pending_completion_event_ids.push(received.event_id);
                        }
                    }
                    self.spawn_auto_dispatch(thread_id);
                } else if !should_wait_for_steer {
                    self.record_completion_disposition(
                        received.event_id,
                        QueueCompletionDisposition::Final,
                    )
                    .await;
                }
            }
            crate::acp::events::CanonicalEvent::Tool {
                thread_id,
                run_id,
                source_turn_id,
                generation,
                tool_call_id,
                status,
                ..
            } => {
                let should_drain = {
                    let mut threads = self.threads.write().await;
                    let runtime = threads.entry(thread_id.clone()).or_default();
                    if generation != runtime.active_prompt_generation
                        || run_id.as_deref() != runtime.active_run_id.as_deref()
                        || source_turn_id.as_deref() != runtime.active_turn_id.as_deref()
                    {
                        return;
                    }
                    match status {
                        agent_client_protocol::schema::v1::ToolCallStatus::Pending
                        | agent_client_protocol::schema::v1::ToolCallStatus::InProgress => {
                            runtime.active_tool_call_ids.insert(tool_call_id);
                        }
                        agent_client_protocol::schema::v1::ToolCallStatus::Completed
                        | agent_client_protocol::schema::v1::ToolCallStatus::Failed => {
                            runtime.active_tool_call_ids.remove(&tool_call_id);
                        }
                        _ => {
                            runtime.live_generation_known = false;
                            return;
                        }
                    }
                    runtime.active_tool_call_ids.is_empty()
                        && !runtime.pending_steers.is_empty()
                        && runtime.steer_dispatch_in_flight.is_none()
                };
                if should_drain {
                    self.spawn_steer_dispatch(thread_id);
                }
            }
            crate::acp::events::CanonicalEvent::PermissionRequested { approval } => {
                self.threads
                    .write()
                    .await
                    .entry(approval.thread_id)
                    .or_default()
                    .pending_approval_ids
                    .insert(approval.request_id);
            }
            crate::acp::events::CanonicalEvent::PermissionResolved {
                thread_id,
                request_id,
                ..
            } => {
                let mut should_drain = false;
                if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                    runtime.pending_approval_ids.remove(&request_id);
                    should_drain = runtime.pending_approval_ids.is_empty()
                        && runtime.pending_user_input_ids.is_empty()
                        && runtime.active_tool_call_ids.is_empty()
                        && !runtime.pending_steers.is_empty();
                }
                if should_drain {
                    self.spawn_steer_dispatch(thread_id);
                }
            }
            crate::acp::events::CanonicalEvent::ElicitationRequested { request } => {
                self.threads
                    .write()
                    .await
                    .entry(request.thread_id)
                    .or_default()
                    .pending_user_input_ids
                    .insert(request.request_id);
            }
            crate::acp::events::CanonicalEvent::ElicitationResolved {
                thread_id,
                request_id,
                ..
            } => {
                let mut should_drain = false;
                if let Some(runtime) = self.threads.write().await.get_mut(&thread_id) {
                    runtime.pending_user_input_ids.remove(&request_id);
                    should_drain = runtime.pending_approval_ids.is_empty()
                        && runtime.pending_user_input_ids.is_empty()
                        && runtime.active_tool_call_ids.is_empty()
                        && !runtime.pending_steers.is_empty();
                }
                if should_drain {
                    self.spawn_steer_dispatch(thread_id);
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
                || runtime.steer_prepare_in_flight
                || runtime.steer_dispatch_in_flight.is_some()
                || !runtime.pending_steers.is_empty()
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

        self.broadcast_snapshot(&snapshot).await;

        match self
            .backend
            .turn_start(&thread_id, &queued_item.turn_start)
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
                self.broadcast_snapshot(&snapshot).await;
                for event_id in completion_event_ids {
                    self.record_completion_disposition(event_id, QueueCompletionDisposition::Final)
                        .await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use agent_client_protocol::schema::v1::{ContentBlock, StopReason, ToolCallStatus, ToolKind};
    use futures_util::future::BoxFuture;

    use crate::acp::events::CanonicalEvent;

    use super::*;

    struct SteerCall {
        thread_id: String,
        expected_run_id: String,
        expected_source_turn_id: String,
        prompt_generation: u64,
        prompt: Vec<ContentBlock>,
        response: oneshot::Sender<Result<(), String>>,
    }

    struct PrepareCall {
        thread_id: String,
        response: oneshot::Sender<Result<u64, String>>,
    }

    struct VerifyEpochCall {
        thread_id: String,
        epoch: u64,
        response: oneshot::Sender<Result<bool, String>>,
    }

    struct TurnStartCall {
        thread_id: String,
        turn_start: Value,
        response: oneshot::Sender<Result<String, String>>,
    }

    struct FakeQueueDispatcher {
        snapshot: StdMutex<QueueRuntimeSnapshot>,
        snapshot_error: StdMutex<Option<String>>,
        supports_steer: AtomicBool,
        manual_epoch: Arc<AtomicBool>,
        supports_steer_error: StdMutex<Option<String>>,
        steer_tx: mpsc::UnboundedSender<SteerCall>,
        prepare_tx: mpsc::UnboundedSender<PrepareCall>,
        verify_epoch_tx: mpsc::UnboundedSender<VerifyEpochCall>,
        turn_start_tx: mpsc::UnboundedSender<TurnStartCall>,
    }

    struct FakeReceivers {
        steer: mpsc::UnboundedReceiver<SteerCall>,
        prepare: mpsc::UnboundedReceiver<PrepareCall>,
        verify_epoch: mpsc::UnboundedReceiver<VerifyEpochCall>,
        turn_start: mpsc::UnboundedReceiver<TurnStartCall>,
        manual_epoch: Arc<AtomicBool>,
    }

    impl QueueRuntimeDispatcher for FakeQueueDispatcher {
        fn read_snapshot<'a>(
            &'a self,
            _thread_id: &'a str,
        ) -> BoxFuture<'a, Result<QueueRuntimeSnapshot, String>> {
            if let Some(error) = self
                .snapshot_error
                .lock()
                .expect("snapshot error lock")
                .clone()
            {
                return Box::pin(async move { Err(error) });
            }
            let snapshot = self.snapshot.lock().expect("snapshot lock").clone();
            Box::pin(async move { Ok(snapshot) })
        }

        fn supports_steer(&self, _thread_id: &str) -> Result<bool, String> {
            if let Some(error) = self
                .supports_steer_error
                .lock()
                .expect("supports steer error lock")
                .clone()
            {
                return Err(error);
            }
            Ok(self.supports_steer.load(Ordering::SeqCst))
        }

        fn prepare_steer<'a>(&'a self, thread_id: &'a str) -> BoxFuture<'a, Result<u64, String>> {
            if !self.manual_epoch.load(Ordering::SeqCst) {
                return Box::pin(async { Ok(1) });
            }
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.prepare_tx
                    .send(PrepareCall {
                        thread_id: thread_id.to_string(),
                        response,
                    })
                    .map_err(|_| "prepare receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "prepare response dropped".to_string())?
            })
        }

        fn verify_steer_epoch<'a>(
            &'a self,
            thread_id: &'a str,
            epoch: u64,
        ) -> BoxFuture<'a, Result<bool, String>> {
            if !self.manual_epoch.load(Ordering::SeqCst) {
                return Box::pin(async { Ok(true) });
            }
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.verify_epoch_tx
                    .send(VerifyEpochCall {
                        thread_id: thread_id.to_string(),
                        epoch,
                        response,
                    })
                    .map_err(|_| "verify epoch receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "verify epoch response dropped".to_string())?
            })
        }

        fn steer<'a>(
            &'a self,
            thread_id: &'a str,
            expected_run_id: String,
            expected_source_turn_id: String,
            prompt_generation: u64,
            _interaction_epoch: u64,
            prompt: Vec<ContentBlock>,
        ) -> BoxFuture<'a, Result<(), String>> {
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.steer_tx
                    .send(SteerCall {
                        thread_id: thread_id.to_string(),
                        expected_run_id,
                        expected_source_turn_id,
                        prompt_generation,
                        prompt,
                        response,
                    })
                    .map_err(|_| "steer receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "steer response dropped".to_string())?
            })
        }

        fn turn_start<'a>(
            &'a self,
            thread_id: &'a str,
            turn_start: &'a Value,
        ) -> BoxFuture<'a, Result<String, String>> {
            let turn_start = turn_start.clone();
            Box::pin(async move {
                let (response, received) = oneshot::channel();
                self.turn_start_tx
                    .send(TurnStartCall {
                        thread_id: thread_id.to_string(),
                        turn_start,
                        response,
                    })
                    .map_err(|_| "turn start receiver closed".to_string())?;
                received
                    .await
                    .map_err(|_| "turn start response dropped".to_string())?
            })
        }
    }

    fn fake_dispatcher() -> (Arc<FakeQueueDispatcher>, FakeReceivers) {
        let (steer_tx, steer) = mpsc::unbounded_channel();
        let (prepare_tx, prepare) = mpsc::unbounded_channel();
        let (verify_epoch_tx, verify_epoch) = mpsc::unbounded_channel();
        let (turn_start_tx, turn_start) = mpsc::unbounded_channel();
        let manual_epoch = Arc::new(AtomicBool::new(false));
        let mut session =
            crate::acp::snapshot::SessionSnapshot::new("agent".to_string(), "thread".to_string());
        session.active_run_id = Some("run".to_string());
        session.active_source_turn_id = Some("turn".to_string());
        session.active_generation = Some(7);
        (
            Arc::new(FakeQueueDispatcher {
                snapshot: StdMutex::new(QueueRuntimeSnapshot {
                    session,
                    pending_approval_ids: HashSet::new(),
                    pending_user_input_ids: HashSet::new(),
                }),
                snapshot_error: StdMutex::new(None),
                supports_steer: AtomicBool::new(true),
                manual_epoch: manual_epoch.clone(),
                supports_steer_error: StdMutex::new(None),
                steer_tx,
                prepare_tx,
                verify_epoch_tx,
                turn_start_tx,
            }),
            FakeReceivers {
                steer,
                prepare,
                verify_epoch,
                turn_start,
                manual_epoch,
            },
        )
    }

    fn queued(id: &str) -> BridgeQueuedMessageEntry {
        BridgeQueuedMessageEntry {
            id: id.to_string(),
            created_at: format!("created-{id}"),
            content: format!("content-{id}"),
            turn_start: json!({
                "input": [
                    {"type": "text", "text": format!("text-{id}"), "text_elements": []},
                    {"type": "mention", "name": "source.rs", "path": "/repo/source.rs"},
                    {"type": "localImage", "path": "/repo/screen.png"}
                ]
            }),
        }
    }

    fn active_runtime(item_ids: &[&str], tool_ids: &[&str]) -> BridgeThreadQueueRuntime {
        BridgeThreadQueueRuntime {
            items: item_ids.iter().map(|id| queued(id)).collect(),
            active_turn_id: Some("turn".to_string()),
            active_run_id: Some("run".to_string()),
            active_prompt_generation: Some(7),
            active_tool_call_ids: tool_ids.iter().map(|id| id.to_string()).collect(),
            live_generation_known: true,
            thread_running: true,
            ..BridgeThreadQueueRuntime::default()
        }
    }

    async fn service_with_runtime(
        item_ids: &[&str],
        tool_ids: &[&str],
    ) -> (Arc<BridgeQueueService>, FakeReceivers) {
        let (backend, receivers) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        service
            .threads
            .write()
            .await
            .insert("thread".to_string(), active_runtime(item_ids, tool_ids));
        (service, receivers)
    }

    async fn accept_steer(service: &Arc<BridgeQueueService>, item_id: &str) {
        let response = service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: item_id.to_string(),
            })
            .await
            .expect("steer accepted");
        assert!(response.ok);
    }

    fn tool_event(id: &str, generation: u64, status: ToolCallStatus) -> CanonicalHubEvent {
        CanonicalHubEvent {
            event_id: 1,
            event: CanonicalEvent::Tool {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: Some("run".to_string()),
                source_turn_id: Some("turn".to_string()),
                generation: Some(generation),
                tool_call_id: id.to_string(),
                kind: ToolKind::Edit,
                status,
                title: id.to_string(),
                content: crate::acp::events::FieldUpdate::Set(String::new()),
                structured_content: crate::acp::events::FieldUpdate::Set(Vec::new()),
                locations: crate::acp::events::FieldUpdate::Set(Vec::new()),
            },
        }
    }

    fn finish_event(source_turn_id: &str, generation: u64, event_id: u64) -> CanonicalHubEvent {
        CanonicalHubEvent {
            event_id,
            event: CanonicalEvent::RunFinished {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: "run".to_string(),
                source_turn_id: source_turn_id.to_string(),
                generation,
                stop_reason: StopReason::EndTurn,
            },
        }
    }

    #[tokio::test]
    async fn queue_steer_waits_for_exact_active_tools_and_drains_fifo() {
        let (service, mut calls) = service_with_runtime(&["a", "b"], &["tool-1", "tool-2"]).await;
        accept_steer(&service, "a").await;
        accept_steer(&service, "b").await;
        let snapshot = service.read_queue("thread").await;
        assert_eq!(snapshot.pending_steer_count, 2);
        assert!(snapshot.waiting_for_tool_calls);

        service
            .handle_canonical_event(tool_event("tool-1", 7, ToolCallStatus::InProgress))
            .await;
        service
            .handle_canonical_event(tool_event("unknown", 7, ToolCallStatus::Completed))
            .await;
        service
            .handle_canonical_event(tool_event("tool-1", 7, ToolCallStatus::Completed))
            .await;
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());

        service
            .handle_canonical_event(tool_event("tool-1", 7, ToolCallStatus::Completed))
            .await;
        service
            .handle_canonical_event(tool_event("tool-2", 6, ToolCallStatus::Completed))
            .await;
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());

        service
            .handle_canonical_event(tool_event("tool-2", 7, ToolCallStatus::Failed))
            .await;
        let first = calls.steer.recv().await.expect("first steer dispatched");
        assert_eq!(first.thread_id, "thread");
        assert_eq!(first.expected_run_id, "run");
        assert_eq!(first.expected_source_turn_id, "turn");
        assert_eq!(first.prompt_generation, 7);
        assert_eq!(first.prompt.len(), 3);
        assert!(matches!(&first.prompt[0], ContentBlock::Text(text) if text.text == "text-a"));
        assert!(
            matches!(&first.prompt[1], ContentBlock::ResourceLink(link) if link.name == "source.rs" && link.uri == "/repo/source.rs")
        );
        assert!(
            matches!(&first.prompt[2], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/png"))
        );
        first.response.send(Ok(())).expect("ack first steer");
        let second = calls.steer.recv().await.expect("second steer dispatched");
        assert!(matches!(&second.prompt[0], ContentBlock::Text(text) if text.text == "text-b"));
        second.response.send(Ok(())).expect("ack second steer");

        let (service, mut calls) = service_with_runtime(&["reasoning"], &[]).await;
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 4,
                event: CanonicalEvent::MessageChunk {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: Some("run".to_string()),
                    source_turn_id: Some("turn".to_string()),
                    generation: Some(7),
                    role: crate::acp::events::MessageRole::Thought,
                    message_id: "thought".to_string(),
                    content: "considering".to_string(),
                    content_block: None,
                },
            })
            .await;
        accept_steer(&service, "reasoning").await;
        let steer = calls.steer.recv().await.expect("thought does not block");
        steer.response.send(Ok(())).expect("reasoning steer ack");
    }

    #[tokio::test]
    async fn queue_steer_prepares_human_input_then_rechecks_tool_barrier() {
        let (service, mut calls) = service_with_runtime(&["a"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime.pending_approval_ids.insert("approval".to_string());
            runtime
                .pending_user_input_ids
                .insert("elicitation".to_string());
        }
        accept_steer(&service, "a").await;
        let prepare = calls.prepare.recv().await.expect("prepare requested");
        assert_eq!(prepare.thread_id, "thread");
        assert!(calls.steer.try_recv().is_err());

        service
            .handle_canonical_event(tool_event("late-tool", 7, ToolCallStatus::Pending))
            .await;
        prepare.response.send(Ok(1)).expect("prepare acknowledged");
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 2,
                event: CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "approval".to_string(),
                    outcome: "rejected".to_string(),
                },
            })
            .await;
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 3,
                event: CanonicalEvent::ElicitationResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "elicitation".to_string(),
                    action: "cancelled".to_string(),
                },
            })
            .await;
        let verify = calls.verify_epoch.recv().await.expect("epoch verified");
        assert_eq!(verify.thread_id, "thread");
        assert_eq!(verify.epoch, 1);
        verify.response.send(Ok(true)).expect("epoch accepted");
        calls.manual_epoch.store(false, Ordering::SeqCst);
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());
        service
            .handle_canonical_event(tool_event("late-tool", 7, ToolCallStatus::Completed))
            .await;
        let steer = calls.steer.recv().await.expect("steer after tool terminal");
        steer.response.send(Ok(())).expect("steer ack");

        let (service, mut calls) = service_with_runtime(&["b"], &[]).await;
        calls.manual_epoch.store(true, Ordering::SeqCst);
        service
            .threads
            .write()
            .await
            .get_mut("thread")
            .expect("runtime")
            .pending_approval_ids
            .insert("no-reject".to_string());
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            let entry = runtime.items.pop_front().expect("queued entry");
            runtime.pending_steers.push_back(entry);
        }
        let drain = tokio::spawn({
            let service = service.clone();
            async move { service.drain_pending_steers("thread".to_string()).await }
        });
        let prepare = calls.prepare.recv().await.expect("prepare requested");
        prepare
            .response
            .send(Err("permission has no reject option".to_string()))
            .expect("prepare error");
        drain.await.expect("drain task");
        let updated = service.read_queue("thread").await;
        assert_eq!(updated.pending_steers[0].id, "b");
        assert_eq!(updated.pending_steer_count, 1);
        let error = updated.last_error.expect("structured error");
        assert_eq!(error.operation, "steer");
        assert_eq!(error.item_id.as_deref(), Some("b"));
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn late_permission_and_elicitation_force_repreparation_before_steer() {
        for interaction in ["permission", "elicitation"] {
            let (service, mut calls) = service_with_runtime(&[interaction], &[]).await;
            calls.manual_epoch.store(true, Ordering::SeqCst);
            accept_steer(&service, interaction).await;

            let first_prepare = calls.prepare.recv().await.expect("first prepare");
            first_prepare.response.send(Ok(10)).expect("first epoch");
            let first_verify = calls.verify_epoch.recv().await.expect("first verify");
            assert_eq!(first_verify.epoch, 10);
            first_verify
                .response
                .send(Ok(false))
                .expect("late interaction");
            assert!(calls.steer.try_recv().is_err());

            let second_prepare = calls.prepare.recv().await.expect("second prepare");
            second_prepare.response.send(Ok(12)).expect("second epoch");
            let second_verify = calls.verify_epoch.recv().await.expect("second verify");
            assert_eq!(second_verify.epoch, 12);
            second_verify.response.send(Ok(true)).expect("stable epoch");

            let steer = calls.steer.recv().await.expect("steer after repreparation");
            steer.response.send(Ok(())).expect("steer accepted");
        }
    }

    #[tokio::test]
    async fn queue_completion_promotes_pending_and_preserves_in_flight_ownership() {
        let (service, mut calls) = service_with_runtime(&["a", "b"], &["tool"]).await;
        accept_steer(&service, "a").await;
        accept_steer(&service, "b").await;
        service
            .handle_canonical_event(finish_event("other-turn", 7, 10))
            .await;
        assert_eq!(service.read_queue("thread").await.pending_steer_count, 2);
        assert!(calls.turn_start.try_recv().is_err());

        service
            .handle_canonical_event(finish_event("turn", 7, 11))
            .await;
        let first_start = calls.turn_start.recv().await.expect("promoted turn starts");
        assert_eq!(first_start.thread_id, "thread");
        assert_eq!(first_start.turn_start["input"][0]["text"], "text-a");
        first_start
            .response
            .send(Ok("next-turn".to_string()))
            .expect("turn start ack");
        assert_eq!(service.read_queue("thread").await.items[0].id, "b");

        let (service, mut calls) = service_with_runtime(&["c", "d"], &[]).await;
        accept_steer(&service, "c").await;
        let in_flight = calls.steer.recv().await.expect("steer in flight");
        accept_steer(&service, "d").await;
        assert!(service.read_queue("thread").await.steering_in_flight);
        service
            .handle_canonical_event(finish_event("turn", 7, 12))
            .await;
        in_flight
            .response
            .send(Err("turn completed".to_string()))
            .expect("steer failure ack");
        let fallback = calls
            .turn_start
            .recv()
            .await
            .expect("in-flight steer promoted");
        assert_eq!(fallback.turn_start["input"][0]["text"], "text-c");
        assert!(calls.turn_start.try_recv().is_err());
        fallback
            .response
            .send(Ok("fallback-turn".to_string()))
            .expect("fallback ack");
        assert_eq!(service.read_queue("thread").await.items[0].id, "d");
    }

    #[tokio::test]
    async fn queue_cancel_lane_priority_and_unknown_reconcile_are_conservative() {
        let (service, mut calls) = service_with_runtime(&["a", "b"], &["tool"]).await;
        accept_steer(&service, "a").await;
        service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "a".to_string(),
            })
            .await
            .expect("pending steer cancels");
        assert_eq!(service.read_queue("thread").await.pending_steer_count, 0);

        accept_steer(&service, "b").await;
        service
            .handle_canonical_event(tool_event("tool", 7, ToolCallStatus::Completed))
            .await;
        let in_flight = calls.steer.recv().await.expect("steer in flight");
        let error = service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "b".to_string(),
            })
            .await
            .expect_err("in-flight steer cannot cancel");
        assert!(error.contains("already dispatched"));
        in_flight.response.send(Ok(())).expect("steer ack");

        let (service, mut calls) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            runtime.thread_running = false;
            runtime.active_turn_id = None;
            runtime.active_run_id = None;
            runtime.active_prompt_generation = None;
            runtime.live_generation_known = false;
            runtime.pending_steers.push_back(queued("pending"));
            runtime.items.push_back(queued("normal"));
        }
        service.drain_thread_queue("thread".to_string()).await;
        assert!(calls.turn_start.try_recv().is_err());
        let snapshot = service.read_queue("thread").await;
        assert_eq!(snapshot.pending_steers[0].id, "pending");
        assert_eq!(snapshot.items[0].id, "normal");
        assert_eq!(snapshot.pending_steer_count, 1);
        let serialized = serde_json::to_value(snapshot).expect("snapshot serializes");
        assert!(serialized["pendingSteers"][0].get("turnStart").is_none());

        let (backend, mut calls) = fake_dispatcher();
        backend
            .snapshot
            .lock()
            .expect("snapshot lock")
            .session
            .history_reconstruction = true;
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        service
            .ensure_thread_runtime("thread")
            .await
            .expect("hydrate");
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").expect("runtime");
            assert!(!runtime.live_generation_known);
            runtime.pending_steers.push_back(queued("replay"));
        }
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());
    }

    #[test]
    fn bridge_prompt_preserves_official_content_blocks_and_rejects_unknown_blocks() {
        let image = ContentBlock::Image(agent_client_protocol::schema::v1::ImageContent::new(
            "aGVsbG8=",
            "image/png",
        ));
        let image_value = serde_json::to_value(&image).expect("image serializes");
        let prompt = crate::runtime_backend::bridge_prompt(&json!({
            "input": [
                "raw text",
                {"type": "text", "text": "one", "text_elements": []},
                image_value,
                {"type": "mention", "name": "lib.rs", "path": "/repo/lib.rs"},
                {"type": "mention", "path": "/repo/fallback.rs"},
                {"type": "localImage", "path": "/repo/view.webp"},
                {"type": "localImage", "path": "/repo/photo.jpg"},
                {"type": "localImage", "path": "/repo/animation.gif"},
                {"type": "localImage", "path": "/repo/file.unknown"}
            ]
        }))
        .expect("prompt maps");
        assert_eq!(prompt.len(), 9);
        assert!(matches!(&prompt[0], ContentBlock::Text(text) if text.text == "raw text"));
        assert!(matches!(&prompt[1], ContentBlock::Text(text) if text.text == "one"));
        assert_eq!(prompt[2], image);
        assert!(matches!(&prompt[3], ContentBlock::ResourceLink(link) if link.name == "lib.rs"));
        assert!(
            matches!(&prompt[4], ContentBlock::ResourceLink(link) if link.name == "/repo/fallback.rs")
        );
        assert!(
            matches!(&prompt[5], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/webp"))
        );
        assert!(
            matches!(&prompt[6], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/jpeg"))
        );
        assert!(
            matches!(&prompt[7], ContentBlock::ResourceLink(link) if link.mime_type.as_deref() == Some("image/gif"))
        );
        assert!(matches!(&prompt[8], ContentBlock::ResourceLink(link) if link.mime_type.is_none()));
        assert!(crate::runtime_backend::bridge_prompt(&json!({
            "input": [{"type": "futureBlock", "value": true}]
        }))
        .is_err());
        assert!(crate::runtime_backend::bridge_prompt(&json!({})).is_err());
        assert!(crate::runtime_backend::bridge_prompt(&json!({"input": []})).is_err());
        assert!(crate::runtime_backend::bridge_prompt(&json!({"input": [{}]})).is_err());
        assert!(
            crate::runtime_backend::bridge_prompt(&json!({"input": [{"type": "text"}]})).is_err()
        );
        assert!(crate::runtime_backend::bridge_prompt(
            &json!({"input": [{"type": "mention", "path": " "}]})
        )
        .is_err());
        assert!(crate::runtime_backend::bridge_prompt(
            &json!({"input": [{"type": "localImage", "path": " "}]})
        )
        .is_err());
    }

    fn send_request(
        thread_id: &str,
        submission_id: &str,
        content: &str,
    ) -> BridgeThreadQueueSendRequest {
        BridgeThreadQueueSendRequest {
            thread_id: thread_id.to_string(),
            submission_id: submission_id.to_string(),
            content: content.to_string(),
            turn_start: json!({"input": [{"type": "text", "text": content, "text_elements": []}]}),
        }
    }

    #[tokio::test]
    async fn queue_send_validates_limits_idempotency_and_dispatch_outcomes() {
        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().unwrap();
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        for (thread_id, submission_id, content, expected) in [
            (" ", "submission", "content", "threadId"),
            ("thread", "submission", " ", "content"),
            ("thread", " ", "content", "submissionId"),
        ] {
            let error = service
                .send_message(send_request(thread_id, submission_id, content))
                .await
                .expect_err("invalid request");
            assert!(error.contains(expected));
        }
        let error = service
            .send_message(send_request(
                "thread",
                "large-content",
                &"x".repeat(QUEUE_MAX_CONTENT_BYTES + 1),
            ))
            .await
            .expect_err("content limit");
        assert!(error.contains("queue content exceeds"));
        let mut oversized = send_request("thread", "large-item", "content");
        oversized.turn_start = json!({"payload": "x".repeat(QUEUE_MAX_ITEM_BYTES)});
        assert!(service
            .send_message(oversized)
            .await
            .expect_err("item limit")
            .contains("queue item exceeds"));

        let sent = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .send_message(send_request("thread", "sent", "first"))
                    .await
            }
        });
        let call = calls.turn_start.recv().await.expect("initial turn start");
        call.response
            .send(Ok("turn-1".to_string()))
            .expect("turn response");
        let sent = sent.await.expect("send task").expect("send succeeds");
        assert!(matches!(
            sent.disposition,
            BridgeThreadQueueDisposition::Sent
        ));
        assert_eq!(sent.turn_id.as_deref(), Some("turn-1"));
        let duplicate = service
            .send_message(send_request("thread", "sent", "ignored"))
            .await
            .expect("idempotent result");
        assert_eq!(duplicate.turn_id.as_deref(), Some("turn-1"));
        assert!(service
            .send_message(send_request("other-thread", "sent", "conflict"))
            .await
            .expect_err("submission conflict")
            .contains("another thread"));

        let queued = service
            .send_message(send_request("thread", "queued", "second"))
            .await
            .expect("busy thread queues");
        assert!(matches!(
            queued.disposition,
            BridgeThreadQueueDisposition::Queued
        ));

        let (backend, mut calls) = fake_dispatcher();
        {
            let mut snapshot = backend.snapshot.lock().unwrap();
            snapshot.session.active_run_id = None;
            snapshot.session.active_source_turn_id = None;
            snapshot.session.active_generation = None;
        }
        let failed_service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let failed = tokio::spawn({
            let service = failed_service.clone();
            async move {
                service
                    .send_message(send_request("failure", "failed", "content"))
                    .await
            }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("failed turn call")
            .response
            .send(Err("dispatch failed".to_string()))
            .expect("failure response");
        assert_eq!(
            failed
                .await
                .expect("failed task")
                .expect_err("dispatch fails"),
            "dispatch failed"
        );
        assert!(
            !failed_service
                .threads
                .read()
                .await
                .get("failure")
                .unwrap()
                .turn_start_in_flight
        );
    }

    #[tokio::test]
    async fn queue_enforces_thread_item_and_byte_limits_and_submission_eviction() {
        let (service, _) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.items = (0..QUEUE_MAX_ITEMS_PER_THREAD)
                .map(|index| queued(&format!("item-{index}")))
                .collect();
        }
        assert!(service
            .send_message(send_request("thread", "item-limit", "content"))
            .await
            .expect_err("item limit")
            .contains("queue limit"));

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.items.clear();
            runtime.items.push_back(BridgeQueuedMessageEntry {
                id: "large".to_string(),
                created_at: "now".to_string(),
                content: "x".repeat(QUEUE_MAX_BYTES_PER_THREAD),
                turn_start: json!({}),
            });
        }
        assert!(service
            .send_message(send_request("thread", "byte-limit", "content"))
            .await
            .expect_err("byte limit")
            .contains("resource_limit"));

        for index in 0..=SUBMISSION_DEDUPE_LIMIT {
            service
                .remember_submission_result(BridgeThreadQueueSendResponse {
                    submission_id: format!("submission-{index}"),
                    disposition: BridgeThreadQueueDisposition::Queued,
                    queue: BridgeQueueService::snapshot_for_thread("thread", None),
                    turn_id: None,
                })
                .await;
        }
        let results = service.submission_results.lock().await;
        assert_eq!(results.len(), SUBMISSION_DEDUPE_LIMIT);
        assert!(!results.contains_key("submission-0"));
    }

    #[tokio::test]
    async fn queue_hydration_reconcile_and_action_guards_cover_failures() {
        let (backend, _) = fake_dispatcher();
        *backend.snapshot_error.lock().unwrap() = Some("snapshot unavailable".to_string());
        let service = BridgeQueueService::new(backend.clone(), Arc::new(ClientHub::new()));
        assert_eq!(
            service.ensure_thread_runtime(" ").await,
            Err("threadId must not be empty".to_string())
        );
        assert_eq!(
            service.ensure_thread_runtime("thread").await,
            Err("snapshot unavailable".to_string())
        );

        *backend.snapshot_error.lock().unwrap() = None;
        service.ensure_thread_runtime("thread").await.unwrap();
        service.ensure_thread_runtime("thread").await.unwrap();
        *backend.snapshot_error.lock().unwrap() = Some("reconcile failed".to_string());
        service.reconcile_all_threads().await;
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert!(runtime.thread_running);
            assert!(!runtime.live_generation_known);
            assert_eq!(runtime.last_error.as_ref().unwrap().operation, "reconcile");
        }

        backend.supports_steer.store(false, Ordering::SeqCst);
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("unsupported steer")
            .contains("not negotiated"));
        backend.supports_steer.store(true, Ordering::SeqCst);
        *backend.supports_steer_error.lock().unwrap() = Some("capability failed".to_string());
        assert_eq!(
            service
                .steer_message(BridgeThreadQueueSteerRequest {
                    thread_id: "thread".to_string(),
                    item_id: "item".to_string(),
                })
                .await
                .expect_err("capability read fails"),
            "capability failed"
        );

        for request in [
            BridgeThreadQueueCancelRequest {
                thread_id: " ".to_string(),
                item_id: "item".to_string(),
            },
            BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: " ".to_string(),
            },
        ] {
            assert!(service.cancel_message(request).await.is_err());
        }
        assert!(service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "missing".to_string(),
            })
            .await
            .expect_err("missing item")
            .contains("not found"));

        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: " ".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: " ".to_string(),
            })
            .await
            .is_err());
    }

    #[tokio::test]
    async fn queue_canonical_interactions_update_runtime() {
        let (service, _) = service_with_runtime(&["item"], &[]).await;
        for event in [
            CanonicalEvent::PermissionRequested {
                approval: PendingApproval {
                    request_id: "permission".to_string(),
                    agent_id: "agent".to_string(),
                    kind: "fileChange".to_string(),
                    thread_id: "thread".to_string(),
                    turn_id: "turn".to_string(),
                    item_id: "tool".to_string(),
                    title: "Permission".to_string(),
                    message: "Permission".to_string(),
                    requested_at: "2026-07-20T00:00:00Z".to_string(),
                    reason: None,
                    command: None,
                    cwd: None,
                    grant_root: None,
                    proposed_execpolicy_amendment: None,
                    options: vec![],
                },
            },
            CanonicalEvent::ElicitationRequested {
                request: PendingUserInputRequest {
                    request_id: "elicitation".to_string(),
                    agent_id: Some("agent".to_string()),
                    thread_id: "thread".to_string(),
                    turn_id: "turn".to_string(),
                    item_id: "elicitation".to_string(),
                    message: "Input".to_string(),
                    requested_at: "2026-07-20T00:00:01Z".to_string(),
                    questions: vec![],
                },
            },
        ] {
            service
                .handle_canonical_event(CanonicalHubEvent {
                    event_id: 20,
                    event,
                })
                .await;
        }
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert!(runtime.pending_approval_ids.contains("permission"));
            assert!(runtime.pending_user_input_ids.contains("elicitation"));
        }
        for event in [
            CanonicalEvent::PermissionResolved {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                request_id: "permission".to_string(),
                outcome: "rejected".to_string(),
            },
            CanonicalEvent::ElicitationResolved {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                request_id: "elicitation".to_string(),
                action: "cancelled".to_string(),
            },
        ] {
            service
                .handle_canonical_event(CanonicalHubEvent {
                    event_id: 21,
                    event,
                })
                .await;
        }
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 22,
                event: CanonicalEvent::Ignored {
                    agent_id: "agent".to_string(),
                    thread_id: None,
                    kind: "global".to_string(),
                },
            })
            .await;
    }

    #[tokio::test]
    async fn saturated_hub_delivers_resolution_then_terminal_and_queue_converges() {
        let hub = Arc::new(ClientHub::new());
        let mut observer = hub.subscribe_canonical_events();
        let (backend, _) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, hub.clone());
        {
            let mut runtime = active_runtime(&[], &[]);
            runtime
                .pending_approval_ids
                .insert("permission".to_string());
            service
                .threads
                .write()
                .await
                .insert("thread".to_string(), runtime);
        }
        for index in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            hub.broadcast_canonical_event(&CanonicalEvent::Ignored {
                agent_id: "agent".to_string(),
                thread_id: Some("thread".to_string()),
                kind: format!("filler-{index}"),
            })
            .await;
        }
        let producer = {
            let hub = hub.clone();
            tokio::spawn(async move {
                hub.broadcast_canonical_event(&CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    request_id: "permission".to_string(),
                    outcome: "cancelled".to_string(),
                })
                .await;
                hub.broadcast_canonical_event(&CanonicalEvent::RunFinished {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: "run".to_string(),
                    source_turn_id: "turn".to_string(),
                    generation: 7,
                    stop_reason: StopReason::EndTurn,
                })
                .await;
            })
        };
        tokio::task::yield_now().await;
        assert!(!producer.is_finished());
        for _ in 0..INTERNAL_NOTIFICATION_CHANNEL_CAPACITY {
            observer.recv().await.expect("filler event");
        }
        producer.await.expect("canonical producer");
        let resolved = observer.recv().await.expect("resolution event");
        let finished = observer.recv().await.expect("terminal event");
        assert!(resolved.event_id < finished.event_id);
        assert!(matches!(
            resolved.event,
            CanonicalEvent::PermissionResolved { .. }
        ));
        assert!(matches!(finished.event, CanonicalEvent::RunFinished { .. }));

        loop {
            let queue = service.read_queue("thread").await;
            if !queue.waiting_for_tool_calls && queue.pending_steer_count == 0 {
                let threads = service.threads.read().await;
                let runtime = threads.get("thread").expect("tracked runtime");
                if runtime.pending_approval_ids.is_empty() && !runtime.thread_running {
                    break;
                }
            }
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn queue_auto_dispatch_records_continued_and_final_dispositions() {
        let (service, mut calls) = service_with_runtime(&[], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.live_generation_known = false;
            runtime.items.push_back(queued("success"));
            runtime.pending_completion_event_ids.push(30);
        }
        let dispatch = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("thread".to_string()).await }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("continued dispatch")
            .response
            .send(Ok("next".to_string()))
            .unwrap();
        dispatch.await.unwrap();
        assert_eq!(
            service.wait_for_completion_disposition(30).await,
            Some(QueueCompletionDisposition::Continued)
        );

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.items.push_back(queued("failure"));
            runtime.pending_completion_event_ids.push(31);
        }
        let dispatch = tokio::spawn({
            let service = service.clone();
            async move { service.drain_thread_queue("thread".to_string()).await }
        });
        calls
            .turn_start
            .recv()
            .await
            .expect("final dispatch")
            .response
            .send(Err("failed".to_string()))
            .unwrap();
        dispatch.await.unwrap();
        assert_eq!(
            service.wait_for_completion_disposition(31).await,
            Some(QueueCompletionDisposition::Final)
        );
        assert_eq!(
            service
                .read_queue("thread")
                .await
                .last_error
                .unwrap()
                .operation,
            "dispatch"
        );

        service
            .record_completion_disposition(32, QueueCompletionDisposition::Final)
            .await;
        assert_eq!(
            service.wait_for_completion_disposition(32).await,
            Some(QueueCompletionDisposition::Final)
        );

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.thread_running = false;
            runtime.items.clear();
            runtime.pending_completion_event_ids.push(33);
        }
        service.drain_thread_queue("thread".to_string()).await;
        assert_eq!(
            service.wait_for_completion_disposition(33).await,
            Some(QueueCompletionDisposition::Final)
        );
        assert_eq!(service.wait_for_completion_disposition(999).await, None);
        service.drain_thread_queue("missing".to_string()).await;
    }

    #[tokio::test]
    async fn queue_reconcile_resumes_pending_steer_and_malformed_prompt_restores_it() {
        let (backend, mut calls) = fake_dispatcher();
        let service = BridgeQueueService::new(backend, Arc::new(ClientHub::new()));
        let mut runtime = active_runtime(&[], &[]);
        runtime.pending_steers.push_back(queued("reconciled"));
        service
            .threads
            .write()
            .await
            .insert("thread".to_string(), runtime);
        service.reconcile_all_threads().await;
        let steer = calls.steer.recv().await.expect("reconcile resumes steer");
        assert_eq!(steer.prompt_generation, 7);
        steer.response.send(Ok(())).unwrap();

        let mut runtime = active_runtime(&[], &[]);
        runtime.pending_steers.push_back(BridgeQueuedMessageEntry {
            id: "malformed".to_string(),
            created_at: "now".to_string(),
            content: "malformed".to_string(),
            turn_start: json!({"input": []}),
        });
        service
            .threads
            .write()
            .await
            .insert("malformed-thread".to_string(), runtime);
        service
            .drain_pending_steers("malformed-thread".to_string())
            .await;
        let snapshot = service.read_queue("malformed-thread").await;
        assert_eq!(snapshot.pending_steer_count, 1);
        assert_eq!(snapshot.pending_steers[0].id, "malformed");
        assert_eq!(snapshot.last_error.unwrap().operation, "steer");
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn queue_action_guards_and_normal_cancellation_preserve_state() {
        let (service, _) = service_with_runtime(&["item"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            threads.get_mut("thread").unwrap().turn_start_in_flight = true;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("busy action")
            .contains("busy"));
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.turn_start_in_flight = false;
            runtime.live_generation_known = false;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("no live generation")
            .contains("no live"));
        {
            service
                .threads
                .write()
                .await
                .get_mut("thread")
                .unwrap()
                .live_generation_known = true;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "missing".to_string(),
            })
            .await
            .expect_err("missing queued item")
            .contains("not found"));

        {
            service
                .threads
                .write()
                .await
                .get_mut("thread")
                .unwrap()
                .action_in_flight_item_id = Some("item".to_string());
        }
        assert!(service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect_err("in-flight action")
            .contains("being processed"));
        {
            service
                .threads
                .write()
                .await
                .get_mut("thread")
                .unwrap()
                .action_in_flight_item_id = None;
        }
        let cancelled = service
            .cancel_message(BridgeThreadQueueCancelRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .expect("normal item cancels");
        assert!(cancelled.queue.items.is_empty());
    }

    #[tokio::test]
    async fn queue_run_start_and_correlation_guards_are_conservative() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.turn_start_in_flight = true;
            runtime.last_error = Some(BridgeThreadQueueError {
                message: "old".to_string(),
                operation: "dispatch".to_string(),
                at: "now".to_string(),
                item_id: None,
            });
        }
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 40,
                event: CanonicalEvent::RunStarted {
                    agent_id: "agent".to_string(),
                    thread_id: "thread".to_string(),
                    run_id: "new-run".to_string(),
                    source_turn_id: "new-turn".to_string(),
                    generation: 8,
                },
            })
            .await;
        {
            let threads = service.threads.read().await;
            let runtime = threads.get("thread").unwrap();
            assert_eq!(runtime.active_run_id.as_deref(), Some("new-run"));
            assert_eq!(runtime.active_turn_id.as_deref(), Some("new-turn"));
            assert_eq!(runtime.active_prompt_generation, Some(8));
            assert!(runtime.last_error.is_none());
        }

        let mut wrong_run = tool_event("tool", 8, ToolCallStatus::Pending);
        if let CanonicalEvent::Tool { run_id, .. } = &mut wrong_run.event {
            *run_id = Some("wrong".to_string());
        }
        service.handle_canonical_event(wrong_run).await;
        let mut wrong_turn = tool_event("tool", 8, ToolCallStatus::Pending);
        if let CanonicalEvent::Tool {
            run_id,
            source_turn_id,
            ..
        } = &mut wrong_turn.event
        {
            *run_id = Some("new-run".to_string());
            *source_turn_id = Some("wrong".to_string());
        }
        service.handle_canonical_event(wrong_turn).await;
        assert!(service
            .threads
            .read()
            .await
            .get("thread")
            .unwrap()
            .active_tool_call_ids
            .is_empty());

        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 41,
                event: CanonicalEvent::PermissionResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "missing".to_string(),
                    request_id: "permission".to_string(),
                    outcome: "cancelled".to_string(),
                },
            })
            .await;
        service
            .handle_canonical_event(CanonicalHubEvent {
                event_id: 42,
                event: CanonicalEvent::ElicitationResolved {
                    agent_id: "agent".to_string(),
                    thread_id: "missing".to_string(),
                    request_id: "elicitation".to_string(),
                    action: "cancelled".to_string(),
                },
            })
            .await;
        assert!(calls.steer.try_recv().is_err());
    }

    #[tokio::test]
    async fn queue_capacity_status_and_dispatch_blocker_matrix_is_stable() {
        let (service, mut calls) = service_with_runtime(&["item"], &[]).await;
        assert!(Arc::ptr_eq(
            &service.thread_actor("thread").await,
            &service.thread_actor("thread").await
        ));
        assert_eq!(service.read_queue(" ").await.thread_id, "");
        service
            .threads
            .write()
            .await
            .insert("idle".to_string(), BridgeThreadQueueRuntime::default());
        let status = service.status().await;
        assert_eq!(status.tracked_threads, 2);
        assert_eq!(status.depth, 1);
        assert_eq!(status.busy_threads, 1);

        *service.completion_dispositions.lock().await = (0..QUEUE_COMPLETION_DISPOSITION_LIMIT
            as u64)
            .map(|event_id| (event_id, QueueCompletionDisposition::Final))
            .collect();
        service
            .record_completion_disposition(
                QUEUE_COMPLETION_DISPOSITION_LIMIT as u64,
                QueueCompletionDisposition::Continued,
            )
            .await;
        let dispositions = service.completion_dispositions.lock().await;
        assert_eq!(dispositions.len(), QUEUE_COMPLETION_DISPOSITION_LIMIT);
        assert!(!dispositions.contains_key(&0));
        drop(dispositions);

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.action_in_flight_item_id = Some("other".to_string());
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.action_in_flight_item_id = None;
            runtime.active_turn_id = None;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_turn_id = Some("turn".to_string());
            runtime.active_run_id = None;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_run_id = Some("run".to_string());
            runtime.active_prompt_generation = None;
        }
        assert!(service
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: "thread".to_string(),
                item_id: "item".to_string(),
            })
            .await
            .is_err());

        let reset = |runtime: &mut BridgeThreadQueueRuntime| {
            *runtime = active_runtime(&["item"], &[]);
            runtime.thread_running = false;
        };
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.turn_start_in_flight = true;
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.action_in_flight_item_id = Some("item".to_string());
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.steer_prepare_in_flight = true;
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.steer_dispatch_in_flight = Some(PendingSteerDispatch {
                entry: queued("steer"),
                expected_turn_id: "turn".to_string(),
                expected_run_id: "run".to_string(),
                prompt_generation: 7,
                crossed_completion_boundary: false,
            });
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.pending_steers.push_back(queued("steer"));
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.pending_approval_ids.insert("approval".to_string());
        }
        service.drain_thread_queue("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.pending_user_input_ids.insert("input".to_string());
        }
        service.drain_thread_queue("thread".to_string()).await;
        assert!(calls.turn_start.try_recv().is_err());

        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            reset(runtime);
            runtime.thread_running = true;
            runtime
                .pending_steers
                .push_back(runtime.items.pop_front().unwrap());
            runtime.active_turn_id = None;
        }
        service.drain_pending_steers("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_turn_id = Some("turn".to_string());
            runtime.active_run_id = None;
        }
        service.drain_pending_steers("thread".to_string()).await;
        {
            let mut threads = service.threads.write().await;
            let runtime = threads.get_mut("thread").unwrap();
            runtime.active_run_id = Some("run".to_string());
            runtime.active_prompt_generation = None;
        }
        service.drain_pending_steers("thread".to_string()).await;
        assert!(calls.steer.try_recv().is_err());
    }
}
