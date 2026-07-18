use super::*;

use std::sync::atomic::AtomicUsize;

static TEST_NONCE: AtomicUsize = AtomicUsize::new(1);

struct OrchestrationFixture {
    state: Arc<AppState>,
    bridge: Arc<AppServerBridge>,
    root: PathBuf,
}

impl OrchestrationFixture {
    async fn new(request_timeout: Duration) -> Self {
        let root = env::temp_dir().join(format!(
            "clawdex-orchestration-{}-{}",
            std::process::id(),
            TEST_NONCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).await.expect("create test root");
        let root = normalize_path(&root);
        let hub = Arc::new(ClientHub::with_replay_capacity(8));
        let bridge = test_app_server_bridge(hub.clone(), request_timeout).await;
        let metrics = Arc::new(OperationalMetrics::new());
        let backend = Arc::new(RuntimeBackend {
            preferred_engine: BridgeRuntimeEngine::Codex,
            codex: Arc::new(StdRwLock::new(Some(bridge.clone()))),
            opencode: None,
            cursor: Arc::new(StdRwLock::new(None)),
            metrics: metrics.clone(),
        });
        let config = Arc::new(BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            preview_host: "127.0.0.1".to_string(),
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: root.clone(),
            cli_bin: "cat".to_string(),
            opencode_cli_bin: "cat".to_string(),
            cursor_app_server_bin: "cat".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 4090,
            opencode_server_username: "opencode".to_string(),
            opencode_server_password: Some("secret-token".to_string()),
            auth_token: Some("secret-token".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            no_auth_allowed_origins: HashSet::new(),
            allow_query_token_auth: false,
            allow_outside_root_cwd: false,
            terminal_exec_policies: HashSet::new(),
            show_pairing_qr: false,
            ws_limits: WebSocketResourceLimits {
                max_frame_bytes: DEFAULT_WS_MAX_FRAME_BYTES,
                max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
                per_client_in_flight: 1,
                global_in_flight: 2,
            },
        });
        let path_policy = Arc::new(
            PathPolicy::new(root.clone(), false).expect("construct orchestration path policy"),
        );
        let terminal = Arc::new(TerminalService::new(path_policy.clone(), HashSet::new()));
        let queue = BridgeQueueService::new(backend.clone(), hub.clone());
        let preview = Arc::new(BrowserPreviewService::new(
            config.port,
            config.preview_port,
            None,
            None,
        ));
        let push = PushService::load(&root, "Coverage".to_string(), metrics.clone()).await;
        let state = Arc::new(AppState {
            config,
            path_policy: path_policy.clone(),
            started_at: Instant::now(),
            hub,
            backend,
            queue,
            thread_create_results: Arc::new(Mutex::new(HashMap::new())),
            thread_create_order: Arc::new(Mutex::new(VecDeque::new())),
            thread_create_actor: Arc::new(Mutex::new(())),
            approval_resolution_results: Arc::new(Mutex::new(HashMap::new())),
            approval_resolution_order: Arc::new(Mutex::new(VecDeque::new())),
            approval_resolution_actor: Arc::new(Mutex::new(())),
            thread_list_streams: Arc::new(Mutex::new(HashMap::new())),
            terminal: terminal.clone(),
            git: Arc::new(GitService::new(terminal, path_policy)),
            updater: Arc::new(UpdateService::discover()),
            preview,
            push,
            ws_global_in_flight: Arc::new(Semaphore::new(2)),
            metrics,
        });

        Self {
            state,
            bridge,
            root,
        }
    }

    async fn close(self) {
        let mut child = self.bridge.child.lock().await;
        let _ = child.kill().await;
        let _ = child.wait().await;
        drop(child);
        let _ = fs::remove_dir_all(self.root).await;
    }
}

async fn test_app_server_bridge(
    hub: Arc<ClientHub>,
    request_timeout: Duration,
) -> Arc<AppServerBridge> {
    let mut child = Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test app-server sink");
    let writer = child.stdin.take().expect("test app-server stdin");
    let child_pid = child.id().expect("test app-server pid");
    let bridge = Arc::new(AppServerBridge {
        engine: BridgeRuntimeEngine::Codex,
        child: Mutex::new(child),
        child_pid,
        writer: Mutex::new(writer),
        pending_requests: Mutex::new(HashMap::new()),
        internal_waiters: Mutex::new(HashMap::new()),
        pending_approvals: Mutex::new(HashMap::new()),
        pending_user_inputs: Mutex::new(HashMap::new()),
        next_request_id: AtomicU64::new(1),
        approval_counter: AtomicU64::new(1),
        user_input_counter: AtomicU64::new(1),
        hub,
        lifecycle: Arc::new(BackendRuntimeStatus::starting()),
        metrics: Arc::new(OperationalMetrics::new()),
        timed_out_requests: AtomicU64::new(0),
        request_timeout,
    });
    bridge
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;
    bridge
}

async fn add_client(hub: &Arc<ClientHub>, capacity: usize) -> (u64, mpsc::Receiver<Message>) {
    let (tx, rx) = mpsc::channel(capacity);
    (hub.add_client(tx).await, rx)
}

async fn receive_json(rx: &mut mpsc::Receiver<Message>) -> Value {
    let message = timeout(Duration::from_secs(2), rx.recv())
        .await
        .expect("timed out waiting for hub message")
        .expect("hub client closed");
    let Message::Text(text) = message else {
        panic!("expected text message");
    };
    serde_json::from_str(&text).expect("hub emitted JSON")
}

fn queued_entry(id: &str, content: &str) -> BridgeQueuedMessageEntry {
    BridgeQueuedMessageEntry {
        id: id.to_string(),
        created_at: now_iso(),
        content: content.to_string(),
        turn_start: json!({
            "input": [{ "type": "text", "text": content }]
        }),
    }
}

async fn wait_for_internal_waiter(bridge: &AppServerBridge) -> u64 {
    timeout(Duration::from_secs(1), async {
        loop {
            if let Some(id) = bridge.internal_waiters.lock().await.keys().next().copied() {
                return id;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("queue dispatch created internal waiter")
}

#[tokio::test]
async fn client_hub_tracks_metadata_replay_backpressure_and_stale_clients() {
    let hub = Arc::new(ClientHub::with_replay_capacity(2));
    let (full_tx, mut full_rx) = mpsc::channel(1);
    let full_id = hub
        .add_client_with_metadata(
            full_tx.clone(),
            ClientConnectionMetadata {
                client_type: "mobile".to_string(),
                client_name: "Coverage Phone".to_string(),
            },
        )
        .await;
    let (closed_tx, closed_rx) = mpsc::channel(1);
    let closed_id = hub.add_client(closed_tx).await;
    drop(closed_rx);
    full_tx
        .try_send(Message::Text("already-full".into()))
        .expect("seed client queue");

    hub.broadcast_notification("event/one", json!({ "value": 1 }))
        .await;
    hub.broadcast_notification("event/two", json!({ "value": 2 }))
        .await;
    hub.broadcast_notification("event/three", json!({ "value": 3 }))
        .await;

    assert!(hub.clients.read().await.contains_key(&full_id));
    assert!(!hub.clients.read().await.contains_key(&closed_id));
    assert_eq!(
        hub.client_connections().await[0].client_name,
        "Coverage Phone"
    );
    assert_eq!(hub.earliest_event_id().await, Some(2));
    assert_eq!(hub.latest_event_id(), 3);
    let (events, has_more, bytes) = hub.replay_since(Some(1), 1).await;
    assert_eq!(events.len(), 1);
    assert!(has_more);
    assert!(bytes > 0);
    assert_eq!(events[0]["eventId"], 2);
    assert_eq!(hub.replay_status().await.client_queue_drops, 3);

    let Message::Text(seed) = full_rx.recv().await.expect("seed frame") else {
        panic!("expected text seed");
    };
    assert_eq!(seed, "already-full");
    hub.send_json(999_999, json!({ "ignored": true })).await;
    hub.remove_client(full_id).await;
    assert!(hub.client_connections().await.is_empty());
}

#[tokio::test]
async fn client_hub_send_json_waits_for_capacity_and_evicts_closed_receiver() {
    let hub = Arc::new(ClientHub::new());
    let (id, mut rx) = add_client(&hub, 1).await;
    hub.send_json(id, json!({ "sequence": 1 })).await;
    let draining = tokio::spawn(async move {
        sleep(Duration::from_millis(20)).await;
        let first = receive_json(&mut rx).await;
        let second = receive_json(&mut rx).await;
        (first, second)
    });
    hub.send_json(id, json!({ "sequence": 2 })).await;
    let (first, second) = draining.await.expect("join receiver");
    assert_eq!(first["sequence"], 1);
    assert_eq!(second["sequence"], 2);

    let (closed_id, closed_rx) = add_client(&hub, 1).await;
    drop(closed_rx);
    hub.send_json(closed_id, json!({})).await;
    assert!(!hub.clients.read().await.contains_key(&closed_id));
}

#[tokio::test]
async fn queue_actor_serializes_per_thread_and_validation_covers_busy_cancel_paths() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();
    let actor_a = queue.thread_actor("thread-a").await;
    let actor_a_again = queue.thread_actor("thread-a").await;
    let actor_b = queue.thread_actor("thread-b").await;
    assert!(Arc::ptr_eq(&actor_a, &actor_a_again));
    assert!(!Arc::ptr_eq(&actor_a, &actor_b));
    let guard = actor_a.lock().await;
    assert!(actor_a_again.try_lock().is_err());
    drop(guard);

    for request in [
        BridgeThreadQueueSendRequest {
            thread_id: " ".to_string(),
            submission_id: "submission".to_string(),
            content: "content".to_string(),
            turn_start: json!({}),
        },
        BridgeThreadQueueSendRequest {
            thread_id: "thread-a".to_string(),
            submission_id: " ".to_string(),
            content: "content".to_string(),
            turn_start: json!({}),
        },
        BridgeThreadQueueSendRequest {
            thread_id: "thread-a".to_string(),
            submission_id: "submission".to_string(),
            content: " ".to_string(),
            turn_start: json!({}),
        },
    ] {
        assert!(queue.send_message(request).await.is_err());
    }

    queue.threads.write().await.insert(
        "thread-a".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            active_turn_id: Some("turn-live".to_string()),
            items: VecDeque::from([queued_entry("queue-busy", "queued")]),
            action_in_flight_item_id: Some("queue-busy".to_string()),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    let error = queue
        .cancel_message(BridgeThreadQueueCancelRequest {
            thread_id: "thread-a".to_string(),
            item_id: "queue-busy".to_string(),
        })
        .await
        .expect_err("in-flight item cannot be cancelled");
    assert!(error.contains("being processed"));
    queue
        .threads
        .write()
        .await
        .get_mut("thread-a")
        .unwrap()
        .action_in_flight_item_id = None;
    let cancelled = queue
        .cancel_message(BridgeThreadQueueCancelRequest {
            thread_id: "thread-a".to_string(),
            item_id: "queue-busy".to_string(),
        })
        .await
        .expect("cancel queued item");
    assert!(cancelled.queue.items.is_empty());
    assert_eq!(queue.status().await.busy_threads, 1);
    assert!(queue.read_queue(" ").await.items.is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn queue_notifications_update_blockers_and_record_final_completion() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();
    queue.threads.write().await.insert(
        "thread-notify".to_string(),
        BridgeThreadQueueRuntime::default(),
    );

    for (event_id, method, params) in [
        (
            1,
            "turn/started",
            json!({ "threadId": "thread-notify", "turnId": "turn-1" }),
        ),
        (
            2,
            "bridge/approval.requested",
            json!({ "threadId": "thread-notify", "id": "approval-1" }),
        ),
        (
            3,
            "bridge/userInput.requested",
            json!({ "threadId": "thread-notify", "id": "input-1" }),
        ),
        (
            4,
            "bridge/approval.resolved",
            json!({ "threadId": "thread-notify", "id": "approval-1" }),
        ),
        (
            5,
            "bridge/userInput.resolved",
            json!({ "threadId": "thread-notify", "id": "input-1" }),
        ),
        (
            6,
            "thread/status/changed",
            json!({ "threadId": "thread-notify", "status": "running" }),
        ),
    ] {
        queue
            .handle_notification(HubNotification {
                event_id,
                method: method.to_string(),
                params,
            })
            .await;
    }
    {
        let threads = queue.threads.read().await;
        let runtime = threads.get("thread-notify").unwrap();
        assert!(runtime.thread_running);
        assert_eq!(runtime.active_turn_id.as_deref(), Some("turn-1"));
        assert!(runtime.pending_approval_ids.is_empty());
        assert!(runtime.pending_user_input_ids.is_empty());
    }
    queue
        .handle_notification(HubNotification {
            event_id: 7,
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "thread-notify", "turnId": "turn-1" }),
        })
        .await;
    assert_eq!(
        queue.wait_for_completion_disposition(7).await,
        Some(QueueCompletionDisposition::Final)
    );
    assert!(!queue.threads.read().await["thread-notify"].thread_running);

    queue
        .handle_notification(HubNotification {
            event_id: 8,
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "untracked" }),
        })
        .await;
    assert_eq!(
        queue.wait_for_completion_disposition(8).await,
        Some(QueueCompletionDisposition::Final)
    );
    fixture.close().await;
}

#[tokio::test]
async fn queue_completion_dispatch_success_is_continued_and_failure_is_final() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();
    queue.threads.write().await.insert(
        "codex:thread-success".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            active_turn_id: Some("turn-old".to_string()),
            items: VecDeque::from([queued_entry("queue-1", "continue")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue
        .handle_notification(HubNotification {
            event_id: 101,
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "codex:thread-success", "turnId": "turn-old" }),
        })
        .await;
    let request_id = wait_for_internal_waiter(&fixture.bridge).await;
    fixture
        .bridge
        .handle_response(json!({ "id": request_id, "result": { "turn": { "id": "turn-new" } } }))
        .await;
    assert_eq!(
        queue.wait_for_completion_disposition(101).await,
        Some(QueueCompletionDisposition::Continued)
    );
    assert_eq!(
        queue.threads.read().await["codex:thread-success"]
            .active_turn_id
            .as_deref(),
        Some("turn-new")
    );

    queue.threads.write().await.insert(
        "codex:thread-failure".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            active_turn_id: Some("turn-old".to_string()),
            items: VecDeque::from([queued_entry("queue-2", "fail")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue
        .handle_notification(HubNotification {
            event_id: 102,
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "codex:thread-failure", "turnId": "turn-old" }),
        })
        .await;
    let request_id = wait_for_internal_waiter(&fixture.bridge).await;
    fixture
        .bridge
        .handle_response(json!({ "id": request_id, "error": { "message": "backend refused" } }))
        .await;
    assert_eq!(
        queue.wait_for_completion_disposition(102).await,
        Some(QueueCompletionDisposition::Final)
    );
    let failed = &queue.threads.read().await["codex:thread-failure"];
    assert_eq!(failed.items.len(), 1);
    assert_eq!(failed.last_error.as_ref().unwrap().operation, "dispatch");
    fixture.close().await;
}

#[tokio::test]
async fn completion_disposition_waiter_is_notified_and_storage_is_bounded() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();
    let waiting_queue = queue.clone();
    let waiter =
        tokio::spawn(async move { waiting_queue.wait_for_completion_disposition(55).await });
    tokio::task::yield_now().await;
    queue
        .record_completion_disposition(55, QueueCompletionDisposition::Continued)
        .await;
    assert_eq!(
        waiter.await.expect("join disposition waiter"),
        Some(QueueCompletionDisposition::Continued)
    );
    for event_id in 1..=(QUEUE_COMPLETION_DISPOSITION_LIMIT as u64 + 2) {
        queue
            .record_completion_disposition(event_id, QueueCompletionDisposition::Final)
            .await;
    }
    let dispositions = queue.completion_dispositions.lock().await;
    assert_eq!(dispositions.len(), QUEUE_COMPLETION_DISPOSITION_LIMIT);
    assert!(!dispositions.contains_key(&1));
    drop(dispositions);
    fixture.close().await;
}

#[tokio::test]
async fn app_server_forward_timeout_and_client_cancellation_release_pending_requests() {
    let fixture = OrchestrationFixture::new(Duration::from_millis(30)).await;
    let (client_id, mut rx) = add_client(&fixture.state.hub, 4).await;
    fixture
        .bridge
        .forward_request(client_id, json!("timeout-request"), "thread/read", None)
        .await
        .expect("forward timeout request");
    let timeout_payload = receive_json(&mut rx).await;
    assert_eq!(timeout_payload["id"], "timeout-request");
    assert_eq!(timeout_payload["error"]["data"]["error"], "timeout");
    assert_eq!(fixture.bridge.timed_out_requests.load(Ordering::Relaxed), 1);
    assert!(fixture.bridge.pending_requests.lock().await.is_empty());

    fixture
        .bridge
        .forward_request(client_id, json!("cancelled-request"), "thread/read", None)
        .await
        .expect("forward cancellable request");
    fixture.bridge.cancel_client_requests(client_id).await;
    sleep(Duration::from_millis(50)).await;
    assert!(fixture.bridge.pending_requests.lock().await.is_empty());
    assert_eq!(fixture.bridge.timed_out_requests.load(Ordering::Relaxed), 1);
    assert!(timeout(Duration::from_millis(20), rx.recv()).await.is_err());
    fixture.close().await;
}

#[tokio::test]
async fn app_server_internal_request_covers_result_error_drop_and_timeout() {
    let fixture = OrchestrationFixture::new(Duration::from_millis(30)).await;
    let bridge = fixture.bridge.clone();
    let success = tokio::spawn({
        let bridge = bridge.clone();
        async move { bridge.request_internal_once("model/list", None).await }
    });
    let success_id = wait_for_internal_waiter(&bridge).await;
    bridge
        .handle_response(json!({ "id": success_id, "result": { "data": [1] } }))
        .await;
    assert_eq!(success.await.unwrap().unwrap()["data"][0], 1);

    let backend_error = tokio::spawn({
        let bridge = bridge.clone();
        async move { bridge.request_internal_once("model/list", None).await }
    });
    let error_id = wait_for_internal_waiter(&bridge).await;
    bridge
        .handle_response(json!({ "id": error_id, "error": { "message": "no models" } }))
        .await;
    assert_eq!(backend_error.await.unwrap().unwrap_err(), "no models");

    let dropped = tokio::spawn({
        let bridge = bridge.clone();
        async move { bridge.request_internal_once("model/list", None).await }
    });
    let dropped_id = wait_for_internal_waiter(&bridge).await;
    drop(bridge.internal_waiters.lock().await.remove(&dropped_id));
    assert_eq!(
        dropped.await.unwrap().unwrap_err(),
        "internal app-server waiter dropped"
    );

    let timeout_error = bridge
        .request_internal_once("account/read", None)
        .await
        .expect_err("internal request should time out");
    assert!(timeout_error.contains("timed out: account/read"));
    assert!(bridge.internal_waiters.lock().await.is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn app_server_failures_drain_waiters_and_pending_clients() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let (client_id, mut rx) = add_client(&fixture.state.hub, 2).await;
    fixture
        .bridge
        .forward_request(client_id, json!("pending"), "thread/read", None)
        .await
        .expect("forward pending request");
    fixture.bridge.fail_all_pending("backend closed").await;
    let failure = receive_json(&mut rx).await;
    assert_eq!(failure["error"]["message"], "backend closed");

    let (tx, rx) = oneshot::channel();
    fixture.bridge.internal_waiters.lock().await.insert(77, tx);
    fixture.bridge.fail_all_internal("backend closed").await;
    assert_eq!(rx.await.unwrap(), Err("backend closed".to_string()));
    fixture.close().await;
}

#[tokio::test]
async fn push_coordination_drains_previews_and_gates_completion_dispositions() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let push = fixture.state.push.clone();
    assert!(
        push.accumulate_reply(
            "item/agentMessage/delta",
            &json!({ "threadId": "codex:thread", "delta": "first line\nfinal   answer" }),
        )
        .await
    );
    assert!(
        push.accumulate_reply(
            "codex/event/agent_message_delta",
            &json!({ "thread_id": "codex:thread", "field": "metadata", "delta": "ignored" }),
        )
        .await
    );
    assert!(!push.accumulate_reply("turn/started", &json!({})).await);

    push.handle_notification(
        "turn/completed",
        &json!({ "threadId": "codex:thread" }),
        None,
        None,
        None,
    )
    .await;
    assert!(push.take_reply_preview("codex:thread").await.is_none());

    push.register(
        "profile".to_string(),
        "registration".to_string(),
        "ExponentPushToken[coverage]".to_string(),
        "ios".to_string(),
        "Phone".to_string(),
        PushEventPreferences::default(),
    )
    .await
    .expect("register push target");
    fixture
        .state
        .queue
        .record_completion_disposition(200, QueueCompletionDisposition::Continued)
        .await;
    push.handle_notification(
        "turn/completed",
        &json!({ "threadId": "codex:thread" }),
        Some(&fixture.state.backend),
        Some(&fixture.state.queue),
        Some(200),
    )
    .await;

    fixture
        .state
        .queue
        .record_completion_disposition(201, QueueCompletionDisposition::Final)
        .await;
    push.handle_notification(
        "turn/completed",
        &json!({ "threadId": "codex:thread" }),
        None,
        Some(&fixture.state.queue),
        Some(201),
    )
    .await;
    assert_eq!(PushEvent::TurnCompleted.as_str(), "turn_completed");
    assert_eq!(PushEvent::ApprovalRequested.as_str(), "approval_requested");
    fixture.close().await;
}

#[derive(Clone)]
struct ScriptedPushResponse {
    status: StatusCode,
    body: &'static str,
    retry_after: Option<&'static str>,
}

struct ScriptedPushServer {
    responses: Mutex<VecDeque<ScriptedPushResponse>>,
    requests: Mutex<Vec<(Option<String>, Value)>>,
}

async fn scripted_push_handler(
    State(state): State<Arc<ScriptedPushServer>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    state.requests.lock().await.push((authorization, body));
    let response = state
        .responses
        .lock()
        .await
        .pop_front()
        .expect("scripted push response");
    let mut response_headers = HeaderMap::new();
    if let Some(retry_after) = response.retry_after {
        response_headers.insert(
            "retry-after",
            HeaderValue::from_str(retry_after).expect("valid retry-after header"),
        );
    }
    (response.status, response_headers, response.body).into_response()
}

async fn start_scripted_push_server(
    responses: Vec<ScriptedPushResponse>,
) -> (String, Arc<ScriptedPushServer>, tokio::task::JoinHandle<()>) {
    let state = Arc::new(ScriptedPushServer {
        responses: Mutex::new(responses.into()),
        requests: Mutex::new(Vec::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind push test server");
    let address = listener.local_addr().expect("push test server address");
    let app = Router::new()
        .route("/push", post(scripted_push_handler))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve scripted push responses");
    });
    (format!("http://{address}/push"), state, server)
}

async fn push_service_for_http_test(access_token: Option<&str>) -> (PushService, PathBuf) {
    let root = env::temp_dir().join(format!(
        "clawdex-push-http-{}-{}",
        std::process::id(),
        TEST_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&root)
        .await
        .expect("create push HTTP test root");
    let service = PushService {
        registry: PushRegistryStore::load(&root).await,
        project_label: "Push HTTP coverage".to_string(),
        http: reqwest::Client::new(),
        access_token: access_token.map(str::to_string),
        recent_replies: RwLock::new(HashMap::new()),
        metrics: Arc::new(OperationalMetrics::new()),
    };
    (service, root)
}

#[tokio::test]
async fn push_post_with_retry_sends_bearer_token_and_returns_json_success() {
    let (url, state, server) = start_scripted_push_server(vec![ScriptedPushResponse {
        status: StatusCode::OK,
        body: r#"{"data":[{"status":"ok","id":"ticket-1"}]}"#,
        retry_after: None,
    }])
    .await;
    let (service, root) = push_service_for_http_test(Some("expo-secret")).await;
    let request_body = json!({ "messages": ["one"] });

    let response = service
        .post_with_retry(&url, &request_body)
        .await
        .expect("parse successful push response");

    assert_eq!(response["data"][0]["id"], "ticket-1");
    let requests = state.requests.lock().await;
    assert_eq!(
        requests.as_slice(),
        &[(Some("Bearer expo-secret".to_string()), request_body)]
    );
    drop(requests);
    server.abort();
    fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn push_post_with_retry_omits_bearer_token_and_rejects_invalid_json() {
    let (url, state, server) = start_scripted_push_server(vec![ScriptedPushResponse {
        status: StatusCode::OK,
        body: "not-json",
        retry_after: None,
    }])
    .await;
    let (service, root) = push_service_for_http_test(None).await;

    assert!(service
        .post_with_retry(&url, &json!({ "ok": true }))
        .await
        .is_none());
    let requests = state.requests.lock().await;
    assert_eq!(requests.len(), 1);
    assert!(requests[0].0.is_none());
    drop(requests);
    server.abort();
    fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn push_post_with_retry_retries_429_and_5xx_before_success() {
    let (url, state, server) = start_scripted_push_server(vec![
        ScriptedPushResponse {
            status: StatusCode::TOO_MANY_REQUESTS,
            body: "rate limited",
            retry_after: Some("0"),
        },
        ScriptedPushResponse {
            status: StatusCode::BAD_GATEWAY,
            body: "upstream unavailable",
            retry_after: Some("0"),
        },
        ScriptedPushResponse {
            status: StatusCode::ACCEPTED,
            body: r#"{"data":{"accepted":true}}"#,
            retry_after: None,
        },
    ])
    .await;
    let (service, root) = push_service_for_http_test(None).await;

    let response = service
        .post_with_retry(&url, &json!(["notification"]))
        .await
        .expect("retryable responses eventually succeed");

    assert_eq!(response["data"]["accepted"], true);
    assert_eq!(state.requests.lock().await.len(), 3);
    server.abort();
    fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn push_post_with_retry_returns_none_after_retryable_responses_are_exhausted() {
    let responses = (0..PUSH_SEND_MAX_ATTEMPTS)
        .map(|_| ScriptedPushResponse {
            status: StatusCode::SERVICE_UNAVAILABLE,
            body: "still unavailable",
            retry_after: Some("0"),
        })
        .collect();
    let (url, state, server) = start_scripted_push_server(responses).await;
    let (service, root) = push_service_for_http_test(None).await;

    assert!(service.post_with_retry(&url, &json!({})).await.is_none());
    assert_eq!(
        state.requests.lock().await.len(),
        PUSH_SEND_MAX_ATTEMPTS as usize
    );
    server.abort();
    fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn push_post_with_retry_enters_transport_backoff_without_a_long_sleep() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve closed push endpoint");
    let address = listener.local_addr().expect("closed push endpoint address");
    drop(listener);
    let (service, root) = push_service_for_http_test(None).await;

    assert!(timeout(
        Duration::from_millis(100),
        service.post_with_retry(&format!("http://{address}/push"), &json!({}))
    )
    .await
    .is_err());

    fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn push_post_with_retry_related_reply_buffer_evicts_and_ignores_missing_thread() {
    let (service, root) = push_service_for_http_test(None).await;
    assert!(
        service
            .accumulate_reply("item/agentMessage/delta", &json!({ "delta": "orphan" }))
            .await
    );

    for index in 0..PUSH_PREVIEW_MAX_THREADS {
        service
            .accumulate_reply(
                "item/agentMessage/delta",
                &json!({ "threadId": format!("thread-{index}"), "delta": "reply" }),
            )
            .await;
    }
    assert_eq!(
        service.recent_replies.read().await.len(),
        PUSH_PREVIEW_MAX_THREADS
    );
    service
        .accumulate_reply(
            "item/agentMessage/delta",
            &json!({ "threadId": "thread-overflow", "delta": "reply" }),
        )
        .await;
    let replies = service.recent_replies.read().await;
    assert_eq!(replies.len(), PUSH_PREVIEW_MAX_THREADS);
    assert!(replies.contains_key("thread-overflow"));
    drop(replies);

    fs::remove_dir_all(root).await.unwrap();
}

#[tokio::test]
async fn websocket_parser_and_native_dispatch_return_structured_results() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let (client_id, mut rx) = add_client(&fixture.state.hub, 16).await;
    for (text, expected_code) in [
        ("{".to_string(), -32700),
        (json!([]).to_string(), -32600),
        (json!({ "id": "missing" }).to_string(), -32600),
        (
            json!({ "id": "denied", "method": "thread/delete" }).to_string(),
            -32601,
        ),
        (
            json!({ "id": "unknown", "method": "bridge/unknown" }).to_string(),
            -32601,
        ),
    ] {
        handle_client_message(client_id, text, &fixture.state, None).await;
        assert_eq!(receive_json(&mut rx).await["error"]["code"], expected_code);
    }
    handle_client_message(
        client_id,
        json!({ "method": "ignored-notification" }).to_string(),
        &fixture.state,
        None,
    )
    .await;
    assert!(timeout(Duration::from_millis(20), rx.recv()).await.is_err());

    handle_client_message(
        client_id,
        json!({ "id": "capabilities", "method": "bridge/capabilities/read" }).to_string(),
        &fixture.state,
        None,
    )
    .await;
    let capabilities = receive_json(&mut rx).await;
    assert_eq!(capabilities["id"], "capabilities");
    assert_eq!(
        capabilities["result"]["protocolVersion"],
        BRIDGE_PROTOCOL_VERSION
    );
    fixture.close().await;
}

#[tokio::test]
async fn bridge_native_methods_cover_push_replay_ui_browser_and_queue_branches() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let state = &fixture.state;

    for method in [
        "bridge/health/read",
        "bridge/status/read",
        "bridge/runtime/read",
    ] {
        assert!(handle_bridge_method(method, None, state, 1).await.is_ok());
    }
    let registration = json!({
        "profileId": " profile ",
        "registrationId": " registration ",
        "token": "ExponentPushToken[native]",
        "platform": "IOS",
        "deviceName": "Coverage Phone",
        "events": { "turnCompleted": false }
    });
    assert_eq!(
        handle_bridge_method("bridge/push/register", Some(registration), state, 1)
            .await
            .unwrap()["deviceCount"],
        1
    );
    assert_eq!(
        handle_bridge_method("bridge/push/list", None, state, 1)
            .await
            .unwrap()["devices"][0]["platform"],
        "ios"
    );
    assert_eq!(
        handle_bridge_method(
            "bridge/push/unregister",
            Some(json!({ "profileId": "profile", "registrationId": "registration" })),
            state,
            1,
        )
        .await
        .unwrap()["removed"],
        true
    );
    for invalid in [
        json!({}),
        json!({ "profileId": "p", "registrationId": "r", "token": "" }),
        json!({
            "profileId": "p",
            "registrationId": "r",
            "token": "x".repeat(PUSH_TOKEN_MAX_BYTES + 1)
        }),
    ] {
        assert_eq!(
            handle_bridge_method("bridge/push/register", Some(invalid), state, 1)
                .await
                .unwrap_err()
                .code,
            -32602
        );
    }

    state
        .hub
        .broadcast_notification("coverage/event", json!({ "ok": true }))
        .await;
    let replay = handle_bridge_method(
        "bridge/events/replay",
        Some(json!({ "afterEventId": 0, "limit": 99999 })),
        state,
        1,
    )
    .await
    .unwrap();
    assert_eq!(replay["events"][0]["method"], "coverage/event");

    let surface = json!({
        "id": "surface-1",
        "threadId": "codex:thread-1",
        "presentation": "modal",
        "title": "Coverage",
        "blocks": [{ "type": "text", "text": "Body" }],
        "actions": []
    });
    assert_eq!(
        handle_bridge_method("bridge/ui/present", Some(surface.clone()), state, 1)
            .await
            .unwrap()["ok"],
        true
    );
    assert!(
        handle_bridge_method("bridge/ui/update", Some(surface), state, 1)
            .await
            .is_ok()
    );
    assert_eq!(
        handle_bridge_method(
            "bridge/ui/dismiss",
            Some(json!({ "id": "surface-1", "threadId": "codex:thread-1" })),
            state,
            1,
        )
        .await
        .unwrap()["ok"],
        true
    );
    assert!(handle_bridge_method(
        "bridge/ui/resolve",
        Some(json!({
            "id": "surface-1",
            "threadId": "codex:thread-1",
            "actionId": "continue"
        })),
        state,
        1,
    )
    .await
    .is_ok());
    assert_eq!(
        handle_bridge_method(
            "bridge/ui/resolve",
            Some(json!({ "id": "surface-1", "threadId": "", "actionId": "continue" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    assert!(handle_bridge_method(
        "bridge/browser/session/create",
        Some(json!({ "targetUrl": "https://example.com" })),
        state,
        7,
    )
    .await
    .is_err());
    assert!(
        handle_bridge_method("bridge/browser/sessions/list", None, state, 7)
            .await
            .is_ok()
    );
    assert_eq!(
        handle_bridge_method(
            "bridge/browser/session/close",
            Some(json!({ "sessionId": "" })),
            state,
            7,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );
    assert!(handle_bridge_method(
        "bridge/thread/queue/read",
        Some(json!({ "threadId": "unknown" })),
        state,
        1,
    )
    .await
    .is_ok());
    assert_eq!(
        handle_bridge_method("bridge/not-real", None, state, 1)
            .await
            .unwrap_err()
            .code,
        -32601
    );
    fixture.close().await;
}

#[tokio::test]
async fn real_websocket_enforces_auth_parses_frames_and_applies_admission_limit() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind websocket test server");
    let address = listener.local_addr().unwrap();
    let app = build_bridge_router(fixture.state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("serve websocket test");
    });

    let unauthorized = connect_async(format!("ws://{address}/rpc")).await;
    assert!(unauthorized.is_err());

    let mut request = format!("ws://{address}/rpc?clientType=mobile&clientName=Coverage")
        .into_client_request()
        .expect("websocket request");
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_static("Bearer secret-token"),
    );
    let (mut socket, _) = connect_async(request).await.expect("authorized websocket");
    let connected = receive_ws_json(&mut socket).await;
    assert_eq!(connected["method"], "bridge/connection/state");

    socket
        .send(UpstreamWsMessage::Binary(vec![1, 2, 3].into()))
        .await
        .unwrap();
    assert_eq!(receive_ws_json(&mut socket).await["error"]["code"], -32600);
    socket
        .send(UpstreamWsMessage::Ping(vec![1, 2].into()))
        .await
        .unwrap();
    let ping = receive_ws_json(&mut socket).await;
    assert_eq!(ping["method"], "bridge/ping");
    assert_eq!(ping["params"]["size"], 2);

    socket
        .send(UpstreamWsMessage::Text(
            json!({ "id": "held", "method": "thread/read" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    timeout(Duration::from_secs(1), async {
        while fixture.bridge.pending_requests.lock().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("first websocket request admitted");
    socket
        .send(UpstreamWsMessage::Text(
            json!({ "id": "overloaded", "method": "bridge/status/read" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let overloaded = receive_ws_json(&mut socket).await;
    assert_eq!(overloaded["id"], "overloaded");
    assert_eq!(overloaded["error"]["code"], RPC_SERVER_OVERLOADED);
    assert_eq!(
        overloaded["error"]["data"]["resource"],
        "client_in_flight_requests"
    );

    fixture
        .bridge
        .handle_response(json!({ "id": 1, "result": { "thread": {} } }))
        .await;
    assert_eq!(receive_ws_json(&mut socket).await["id"], "held");
    socket.close(None).await.unwrap();
    timeout(Duration::from_secs(1), async {
        while !fixture.state.hub.client_connections().await.is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("websocket client removed");

    server.abort();
    fixture.close().await;
}

#[tokio::test]
async fn bridge_git_methods_cover_status_diff_history_branches_stage_commit_and_errors() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let root = &fixture.root;

    // Initialize a real git repo in the fixture root.
    tokio::process::Command::new("git")
        .args(["-C", &root.to_string_lossy(), "init", "-b", "main"])
        .output()
        .await
        .expect("git init");
    tokio::process::Command::new("git")
        .args([
            "-C",
            &root.to_string_lossy(),
            "config",
            "user.email",
            "test@example.com",
        ])
        .output()
        .await
        .expect("git config email");
    tokio::process::Command::new("git")
        .args(["-C", &root.to_string_lossy(), "config", "user.name", "Test"])
        .output()
        .await
        .expect("git config name");

    let cwd = root.to_string_lossy().to_string();
    let state = &fixture.state;

    // Status and diff on clean repo (no commits yet)
    assert!(
        handle_bridge_method("bridge/git/status", Some(json!({ "cwd": cwd })), state, 1,)
            .await
            .is_ok()
    );

    // Stage, commit, then check history and branches.
    let file = root.join("main.txt");
    fs::write(&file, "initial content\n")
        .await
        .expect("write test file");
    let staged = handle_bridge_method(
        "bridge/git/stage",
        Some(json!({ "path": "main.txt", "cwd": cwd })),
        state,
        1,
    )
    .await
    .expect("stage file");
    assert_eq!(staged["staged"], true);

    let stage_all =
        handle_bridge_method("bridge/git/stageAll", Some(json!({ "cwd": cwd })), state, 1)
            .await
            .expect("stage all");
    assert_eq!(stage_all["staged"], true);

    let committed = handle_bridge_method(
        "bridge/git/commit",
        Some(json!({ "message": "initial commit", "cwd": cwd })),
        state,
        1,
    )
    .await
    .expect("commit");
    assert_eq!(committed["committed"], true);

    let history = handle_bridge_method(
        "bridge/git/history",
        Some(json!({ "cwd": cwd, "limit": 5 })),
        state,
        1,
    )
    .await
    .expect("history");
    assert_eq!(history["commits"][0]["subject"], "initial commit");

    let branches =
        handle_bridge_method("bridge/git/branches", Some(json!({ "cwd": cwd })), state, 1)
            .await
            .expect("branches");
    assert_eq!(branches["current"], "main");

    // Unstage file and unstage all.
    fs::write(&file, "changed content\n")
        .await
        .expect("modify file");
    handle_bridge_method("bridge/git/stageAll", Some(json!({ "cwd": cwd })), state, 1)
        .await
        .expect("re-stage all");

    let unstaged = handle_bridge_method(
        "bridge/git/unstage",
        Some(json!({ "path": "main.txt", "cwd": cwd })),
        state,
        1,
    )
    .await
    .expect("unstage file");
    assert_eq!(unstaged["unstaged"], true);

    let unstage_all = handle_bridge_method(
        "bridge/git/unstageAll",
        Some(json!({ "cwd": cwd })),
        state,
        1,
    )
    .await
    .expect("unstage all");
    assert_eq!(unstage_all["unstaged"], true);

    // Re-stage and get diff before a second commit.
    handle_bridge_method("bridge/git/stageAll", Some(json!({ "cwd": cwd })), state, 1)
        .await
        .expect("final stage all");
    let diff = handle_bridge_method("bridge/git/diff", Some(json!({ "cwd": cwd })), state, 1)
        .await
        .expect("diff");
    assert!(diff["diff"]
        .as_str()
        .unwrap_or_default()
        .contains("changed"));

    // Push should fail on no-remote repo but return a response.
    let push = handle_bridge_method("bridge/git/push", Some(json!({ "cwd": cwd })), state, 1)
        .await
        .expect("push response");
    assert_eq!(push["pushed"], false);

    // Clone validation errors.
    assert_eq!(
        handle_bridge_method(
            "bridge/git/clone",
            Some(json!({ "url": "", "parentPath": cwd, "directoryName": "repo" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );
    assert_eq!(
        handle_bridge_method(
            "bridge/git/clone",
            Some(json!({ "url": "https://127.0.0.1/repo.git", "parentPath": cwd, "directoryName": "" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // Switch validation error.
    assert_eq!(
        handle_bridge_method(
            "bridge/git/switch",
            Some(json!({ "branch": "--bad", "cwd": cwd })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // stage path validation error.
    assert_eq!(
        handle_bridge_method(
            "bridge/git/stage",
            Some(json!({ "path": "", "cwd": cwd })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // terminal exec is denied (no policies).
    assert_eq!(
        handle_bridge_method(
            "bridge/terminal/exec",
            Some(json!({ "command": "pwd", "cwd": cwd })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32003
    );

    fixture.close().await;
}

#[tokio::test]
async fn thread_create_deduplication_and_queue_send_cover_validation_branches() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let state = &fixture.state;

    // bridge/thread/create with missing submissionId.
    assert_eq!(
        handle_bridge_method(
            "bridge/thread/create",
            Some(json!({ "submissionId": "  ", "threadStart": {} })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // bridge/thread/queue/send with empty content.
    assert_eq!(
        handle_bridge_method(
            "bridge/thread/queue/send",
            Some(json!({
                "threadId": "codex:t1",
                "submissionId": "sub-1",
                "content": "  ",
                "turnStart": {}
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32000
    );

    // bridge/thread/queue/send with oversized content.
    assert_eq!(
        handle_bridge_method(
            "bridge/thread/queue/send",
            Some(json!({
                "threadId": "codex:t1",
                "submissionId": "sub-2",
                "content": "x".repeat(QUEUE_MAX_CONTENT_BYTES + 1),
                "turnStart": {}
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // bridge/thread/queue/send with item bytes exceeding QUEUE_MAX_ITEM_BYTES.
    // Content is fine but turnStart is huge.
    let big_turn_start: serde_json::Value = serde_json::json!({
        "content": "x".repeat(QUEUE_MAX_ITEM_BYTES + 1)
    });
    assert_eq!(
        handle_bridge_method(
            "bridge/thread/queue/send",
            Some(json!({
                "threadId": "codex:t1",
                "submissionId": "sub-big",
                "content": "hello",
                "turnStart": big_turn_start
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    fixture.close().await;
}

#[tokio::test]
async fn push_accumulate_caps_and_approval_notification_path_cover_branches() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let push = fixture.state.push.clone();

    // accumulate_reply: empty delta is a no-op (returns true early).
    assert!(
        push.accumulate_reply(
            "item/agentMessage/delta",
            &json!({ "threadId": "codex:t1", "delta": "" }),
        )
        .await
    );
    // accumulate_reply: field != "text" is skipped.
    assert!(
        push.accumulate_reply(
            "item/agentMessage/delta",
            &json!({ "threadId": "codex:t1", "field": "metadata", "delta": "ignored" }),
        )
        .await
    );
    // accumulate_reply: text accumulation at cap — fill to cap then push more.
    let big = "x".repeat(PUSH_PREVIEW_MAX_BYTES + 100);
    push.accumulate_reply(
        "item/agentMessage/delta",
        &json!({ "threadId": "codex:t2", "delta": big }),
    )
    .await;
    // One more push to hit the already-full branch.
    push.accumulate_reply(
        "item/agentMessage/delta",
        &json!({ "threadId": "codex:t2", "delta": "overflow" }),
    )
    .await;

    // take_reply_preview: multi-line, last non-empty wins.
    push.accumulate_reply(
        "item/agentMessage/delta",
        &json!({ "threadId": "codex:preview", "delta": "line1\n\nfinal answer" }),
    )
    .await;
    let preview = push.take_reply_preview("codex:preview").await;
    assert_eq!(preview.as_deref(), Some("final answer"));

    // take_reply_preview: whitespace-only lines — returns None.
    push.accumulate_reply(
        "item/agentMessage/delta",
        &json!({ "threadId": "codex:blank", "delta": "   \n  " }),
    )
    .await;
    assert!(push.take_reply_preview("codex:blank").await.is_none());

    // approval.requested notification path (no registered devices — early return).
    push.handle_notification(
        "bridge/approval.requested",
        &json!({ "threadId": "codex:t1", "id": "approval-1" }),
        None,
        None,
        None,
    )
    .await;

    // Register a device with default preferences (approval_requested=true) and fire an
    // approval notification. This exercises the "targets is non-empty" path and the
    // approval-specific title/body/categoryId branches.
    push.register(
        "profile-push".to_string(),
        "registration-push".to_string(),
        "ExponentPushToken[push-test-approval]".to_string(),
        "ios".to_string(),
        "Test Phone".to_string(),
        PushEventPreferences::default(),
    )
    .await
    .expect("register device for approval push");
    // Fire approval notification — reaches the "for each registered device" path.
    // The push itself will fail (no real Expo network), but all local branches execute.
    push.handle_notification(
        "bridge/approval.requested",
        &json!({ "threadId": "codex:thread-approval", "id": "approval-push-1" }),
        None,
        None,
        None,
    )
    .await;

    // turn/completed path with backend and final disposition; thread lookup will fail
    // (no real backend), which exercises the "thread read failed" early-return branch.
    fixture
        .state
        .queue
        .record_completion_disposition(999, QueueCompletionDisposition::Final)
        .await;
    push.handle_notification(
        "turn/completed",
        &json!({ "threadId": "codex:thread-approval" }),
        Some(&fixture.state.backend),
        Some(&fixture.state.queue),
        Some(999),
    )
    .await;

    fixture.close().await;
}

async fn receive_ws_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    timeout(Duration::from_secs(2), async {
        loop {
            match socket
                .next()
                .await
                .expect("websocket frame")
                .expect("valid frame")
            {
                UpstreamWsMessage::Text(text) => {
                    return serde_json::from_str(&text).expect("websocket JSON")
                }
                UpstreamWsMessage::Pong(_) => continue,
                other => panic!("unexpected websocket frame: {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for websocket JSON")
}

#[tokio::test]
async fn filesystem_listing_covers_hidden_files_git_detection_and_directory_browsing() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let root = &fixture.root;
    let state = &fixture.state;
    let cwd = root.to_string_lossy().to_string();

    // Create some directory entries.
    fs::create_dir(root.join("visible_dir")).await.unwrap();
    fs::create_dir(root.join(".hidden_dir")).await.unwrap();
    fs::write(root.join("visible_file.txt"), "content")
        .await
        .unwrap();
    fs::write(root.join(".hidden_file"), "hidden")
        .await
        .unwrap();

    // Default: directories only, no hidden.
    let result = handle_bridge_method("bridge/fs/list", Some(json!({ "path": cwd })), state, 1)
        .await
        .expect("filesystem list directories only");
    let entries = result["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["name"] == "visible_dir"));
    assert!(!entries.iter().any(|e| e["name"] == ".hidden_dir"));
    assert!(!entries.iter().any(|e| e["name"] == "visible_file.txt"));

    // Include hidden.
    let result = handle_bridge_method(
        "bridge/fs/list",
        Some(json!({ "path": cwd, "includeHidden": true })),
        state,
        1,
    )
    .await
    .expect("filesystem list with hidden");
    let entries = result["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["name"] == ".hidden_dir"));

    // Include files (directories_only = false), hidden = false.
    let result = handle_bridge_method(
        "bridge/fs/list",
        Some(json!({ "path": cwd, "directoriesOnly": false, "includeHidden": false })),
        state,
        1,
    )
    .await
    .expect("filesystem list all entries");
    let entries = result["entries"].as_array().unwrap();
    assert!(entries.iter().any(|e| e["name"] == "visible_file.txt"));

    // includeGitRepo = true, path contains a git repo.
    tokio::process::Command::new("git")
        .args([
            "-C",
            &root.join("visible_dir").to_string_lossy(),
            "init",
            "-b",
            "main",
        ])
        .output()
        .await
        .expect("git init in subdirectory");
    let result = handle_bridge_method(
        "bridge/fs/list",
        Some(json!({ "path": cwd, "includeGitRepo": true })),
        state,
        1,
    )
    .await
    .expect("filesystem list with git repo detection");
    let entries = result["entries"].as_array().unwrap();
    let visible = entries.iter().find(|e| e["name"] == "visible_dir").unwrap();
    assert_eq!(visible["isGitRepo"], true);

    // Parent browsing: browse at root — parentPath should be null (locked-down policy).
    let root_result =
        handle_bridge_method("bridge/fs/list", Some(json!({ "path": cwd })), state, 1)
            .await
            .expect("root path listing");
    assert!(root_result["parentPath"].is_null());

    fixture.close().await;
}

#[tokio::test]
async fn approval_and_user_input_resolution_cover_validation_not_found_and_error_branches() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let state = &fixture.state;

    // Approval: empty resolutionId → -32602.
    assert_eq!(
        handle_bridge_method(
            "bridge/approvals/resolve",
            Some(json!({
                "id": "approval-1",
                "decision": "accept",
                "resolutionId": ""
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // Approval: invalid decision → -32602.
    assert_eq!(
        handle_bridge_method(
            "bridge/approvals/resolve",
            Some(json!({
                "id": "approval-1",
                "decision": "not-valid",
                "resolutionId": "res-1"
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // Approval: resolutionId too long → -32602.
    assert_eq!(
        handle_bridge_method(
            "bridge/approvals/resolve",
            Some(json!({
                "id": "approval-1",
                "decision": "accept",
                "resolutionId": "x".repeat(PUSH_ID_MAX_BYTES + 1)
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // Approval: not found (no pending approval) → -32004.
    assert_eq!(
        handle_bridge_method(
            "bridge/approvals/resolve",
            Some(json!({
                "id": "missing-approval",
                "decision": "accept",
                "resolutionId": "res-2"
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32004
    );

    // UserInput: empty answers.
    assert_eq!(
        handle_bridge_method(
            "bridge/userInput/resolve",
            Some(json!({
                "id": "input-1",
                "answers": {}
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // UserInput: invalid answers (empty value array).
    assert_eq!(
        handle_bridge_method(
            "bridge/userInput/resolve",
            Some(json!({
                "id": "input-1",
                "answers": { "q1": { "answers": [] } }
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // UserInput: not found.
    assert_eq!(
        handle_bridge_method(
            "bridge/userInput/resolve",
            Some(json!({
                "id": "missing-input",
                "answers": { "q1": { "answers": ["response"] } }
            })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32004
    );

    fixture.close().await;
}

#[tokio::test]
async fn codex_app_server_restart_and_multi_engine_startup_cover_store_backend_paths() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let state = &fixture.state;

    // bridge/codex/app-server/restart uses restart_codex_app_server which calls
    // store_codex_backend and start_codex. The fixture has codex enabled.
    let result = handle_bridge_method("bridge/codex/app-server/restart", None, state, 1).await;
    // It may succeed or fail depending on whether `cat` handles app-server startup,
    // but the branch is exercised either way.
    let _ = result;

    fixture.close().await;
}

#[tokio::test]
async fn queue_notification_handler_covers_dispatch_triggers_and_status_transitions() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let queue = fixture.state.queue.clone();

    // Pre-seed a thread runtime with items so the `should_dispatch` path fires.
    {
        let mut threads = queue.threads.write().await;
        let mut runtime = BridgeThreadQueueRuntime::default();
        runtime
            .pending_approval_ids
            .insert("approval-dispatch".to_string());
        runtime
            .pending_user_input_ids
            .insert("input-dispatch".to_string());
        runtime.items.push_back(BridgeQueuedMessageEntry {
            id: "msg-dispatch-1".to_string(),
            created_at: "now".to_string(),
            content: "pending message".to_string(),
            turn_start: json!({}),
        });
        threads.insert("thread-dispatch".to_string(), runtime);
    }

    // Resolving approval when items are pending exercises should_dispatch=true path.
    queue
        .handle_notification(HubNotification {
            event_id: 100,
            method: "bridge/approval.resolved".to_string(),
            params: json!({ "threadId": "thread-dispatch", "id": "approval-dispatch" }),
        })
        .await;

    // Resolving user input when items are pending.
    queue
        .handle_notification(HubNotification {
            event_id: 101,
            method: "bridge/userInput.resolved".to_string(),
            params: json!({ "threadId": "thread-dispatch", "id": "input-dispatch" }),
        })
        .await;

    // thread/status/changed to a stopped state while turn_start_in_flight=false.
    queue
        .handle_notification(HubNotification {
            event_id: 102,
            method: "thread/status/changed".to_string(),
            params: json!({ "threadId": "thread-dispatch", "status": "stopped" }),
        })
        .await;
    {
        let threads = queue.threads.read().await;
        let runtime = threads.get("thread-dispatch").unwrap();
        assert!(!runtime.thread_running);
    }

    // thread/status/changed to running.
    queue
        .handle_notification(HubNotification {
            event_id: 103,
            method: "thread/status/changed".to_string(),
            params: json!({ "threadId": "thread-dispatch", "status": "running" }),
        })
        .await;
    {
        let threads = queue.threads.read().await;
        let runtime = threads.get("thread-dispatch").unwrap();
        assert!(runtime.thread_running);
    }

    // Notifications for unknown threads are silently ignored.
    queue
        .handle_notification(HubNotification {
            event_id: 104,
            method: "bridge/approval.resolved".to_string(),
            params: json!({ "threadId": "unknown-thread", "id": "whatever" }),
        })
        .await;
    queue
        .handle_notification(HubNotification {
            event_id: 105,
            method: "bridge/userInput.resolved".to_string(),
            params: json!({ "threadId": "unknown-thread", "id": "whatever" }),
        })
        .await;
    queue
        .handle_notification(HubNotification {
            event_id: 106,
            method: "thread/status/changed".to_string(),
            params: json!({ "threadId": "unknown-thread", "status": "stopped" }),
        })
        .await;

    fixture.close().await;
}

#[tokio::test]
async fn codex_auth_callback_and_thread_stream_cover_validation_and_control_branches() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let state = &fixture.state;

    // forward_codex_auth_callback: bad URL → -32602
    assert_eq!(
        handle_bridge_method(
            "bridge/codex/auth/callback/forward",
            Some(json!({ "callbackUrl": "not-a-url" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // forward_codex_auth_callback: wrong scheme → -32602
    assert_eq!(
        handle_bridge_method(
            "bridge/codex/auth/callback/forward",
            Some(json!({ "callbackUrl": "https://localhost:1455/auth/callback" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // forward_codex_auth_callback: wrong host → -32602
    assert_eq!(
        handle_bridge_method(
            "bridge/codex/auth/callback/forward",
            Some(json!({ "callbackUrl": "http://remote.example.com:1455/auth/callback" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // forward_codex_auth_callback: wrong port → -32602
    assert_eq!(
        handle_bridge_method(
            "bridge/codex/auth/callback/forward",
            Some(json!({ "callbackUrl": "http://localhost:9999/auth/callback" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // forward_codex_auth_callback: wrong path → -32602
    assert_eq!(
        handle_bridge_method(
            "bridge/codex/auth/callback/forward",
            Some(json!({ "callbackUrl": "http://localhost:1455/different/path" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    // forward_codex_auth_callback: valid URL but no server listening → -32000
    let callback_err = handle_bridge_method(
        "bridge/codex/auth/callback/forward",
        Some(json!({ "callbackUrl": "http://127.0.0.1:1455/auth/callback?code=test" })),
        state,
        1,
    )
    .await
    .unwrap_err();
    assert_eq!(callback_err.code, -32000);

    // thread list stream: start → should succeed (though backend will immediately fail).
    let stream_result = handle_bridge_method(
        "bridge/thread/list/stream/start",
        Some(json!({ "streamId": "test-stream" })),
        state,
        1,
    )
    .await
    .expect("stream start");
    assert_eq!(stream_result["streamId"], "test-stream");
    assert_eq!(stream_result["started"], true);

    // thread list stream: start duplicate (replaces previous).
    let stream_result2 = handle_bridge_method(
        "bridge/thread/list/stream/start",
        Some(json!({ "streamId": "test-stream", "delayMs": 0 })),
        state,
        1,
    )
    .await
    .expect("stream re-start");
    assert_eq!(stream_result2["streamId"], "test-stream");

    // thread list stream: cancel existing.
    let cancel_result = handle_bridge_method(
        "bridge/thread/list/stream/cancel",
        Some(json!({ "streamId": "test-stream" })),
        state,
        1,
    )
    .await
    .expect("stream cancel");
    assert_eq!(cancel_result["cancelled"], true);

    // thread list stream: cancel non-existent.
    let cancel_missing = handle_bridge_method(
        "bridge/thread/list/stream/cancel",
        Some(json!({ "streamId": "does-not-exist" })),
        state,
        1,
    )
    .await
    .expect("cancel non-existent stream");
    assert_eq!(cancel_missing["cancelled"], false);

    // thread list stream: cancel empty streamId → -32602.
    assert_eq!(
        handle_bridge_method(
            "bridge/thread/list/stream/cancel",
            Some(json!({ "streamId": "" })),
            state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    fixture.close().await;
}

#[tokio::test]
async fn runtime_backend_status_routing_and_hub_fallback_cover_all_engine_variants() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let backend = fixture.state.backend.clone();

    fixture
        .bridge
        .lifecycle
        .transition(
            BackendLifecycleState::Restarting,
            Some("coverage restart".to_string()),
        )
        .await;
    fixture
        .bridge
        .timed_out_requests
        .store(3, Ordering::Relaxed);
    fixture.bridge.pending_requests.lock().await.insert(
        88,
        PendingRequest {
            client_id: 123,
            client_request_id: json!("pending"),
            method: "thread/read".to_string(),
            cached_chatgpt_auth: None,
            clear_cached_chatgpt_auth_on_success: false,
            _in_flight_permits: None,
            trace: fixture.state.metrics.start_request("thread/read", "codex"),
        },
    );
    let statuses = backend
        .engine_statuses(&[
            BridgeRuntimeEngine::Codex,
            BridgeRuntimeEngine::Opencode,
            BridgeRuntimeEngine::Cursor,
        ])
        .await;
    assert_eq!(
        statuses[&BridgeRuntimeEngine::Codex].lifecycle,
        BackendLifecycleState::Restarting
    );
    assert!(!statuses[&BridgeRuntimeEngine::Codex].available);
    assert_eq!(statuses[&BridgeRuntimeEngine::Codex].pending_requests, 1);
    assert_eq!(statuses[&BridgeRuntimeEngine::Codex].timed_out_requests, 3);
    assert!(statuses[&BridgeRuntimeEngine::Codex].last_error.is_some());
    for engine in [BridgeRuntimeEngine::Opencode, BridgeRuntimeEngine::Cursor] {
        assert!(statuses[&engine].configured);
        assert_eq!(statuses[&engine].lifecycle, BackendLifecycleState::Dead);
        assert!(!statuses[&engine].available);
        assert_eq!(statuses[&engine].pending_requests, 0);
        assert_eq!(statuses[&engine].timed_out_requests, 0);
    }
    fixture.bridge.pending_requests.lock().await.remove(&88);
    fixture
        .bridge
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;

    assert_eq!(backend.engine(), BridgeRuntimeEngine::Codex);
    assert_eq!(
        backend.available_engines(),
        vec![BridgeRuntimeEngine::Codex]
    );
    assert!(matches!(
        backend.backend_for_engine(BridgeRuntimeEngine::Codex),
        Ok(RuntimeBackendRef::Codex(_))
    ));
    assert_eq!(
        backend
            .backend_for_engine(BridgeRuntimeEngine::Opencode)
            .err()
            .as_deref(),
        Some("opencode backend is unavailable")
    );
    assert_eq!(
        backend
            .backend_for_engine(BridgeRuntimeEngine::Cursor)
            .err()
            .as_deref(),
        Some("cursor backend is unavailable")
    );
    assert_eq!(
        backend.route_engine_for_method(
            "thread/list",
            Some(&json!({ "engine": "cursor", "threadId": "cursor:t" })),
        ),
        BridgeRuntimeEngine::Codex
    );
    assert_eq!(
        backend.route_engine_for_method("thread/read", Some(&json!({ "threadId": "cursor:t" })),),
        BridgeRuntimeEngine::Cursor
    );
    assert_eq!(
        backend.route_engine_for_method("thread/read", Some(&json!({ "engine": "opencode" }))),
        BridgeRuntimeEngine::Opencode
    );
    assert_eq!(
        backend.route_engine_for_method("thread/read", Some(&json!({}))),
        BridgeRuntimeEngine::Codex
    );

    let capabilities = backend.capabilities("coverage-stream");
    assert_eq!(capabilities.active_engine, BridgeRuntimeEngine::Codex);
    assert!(!capabilities.unified_chat_list);
    assert!(capabilities.supports.review_start);
    assert!(!capabilities.supports.agent_list);
    assert!(capabilities.supports_by_engine[&BridgeRuntimeEngine::Opencode].agent_list);
    assert!(!capabilities.supports_by_engine[&BridgeRuntimeEngine::Cursor].compact_start);

    let empty_backend = RuntimeBackend {
        preferred_engine: BridgeRuntimeEngine::Cursor,
        codex: Arc::new(StdRwLock::new(None)),
        opencode: None,
        cursor: Arc::new(StdRwLock::new(None)),
        metrics: Arc::new(OperationalMetrics::new()),
    };
    let empty_capabilities = empty_backend.capabilities("empty");
    assert_eq!(
        empty_capabilities.active_engine,
        BridgeRuntimeEngine::Cursor
    );
    assert!(empty_capabilities.available_engines.is_empty());
    assert!(!empty_capabilities.supports.review_start);
    assert!(empty_capabilities.supports.plan_mode);
    assert!(empty_capabilities.supports.generic_ui_surface);
    assert!(empty_backend
        .request_internal("model/list", Some(json!({ "engine": "cursor" })))
        .await
        .unwrap_err()
        .contains("cursor backend is unavailable"));

    let (client_id, mut rx) = add_client(&fixture.state.hub, 2).await;
    backend
        .send_client_result_error(client_id, json!("ok"), Ok(json!({ "value": 1 })))
        .await;
    assert_eq!(receive_json(&mut rx).await["result"]["value"], 1);
    backend
        .send_client_result_error(client_id, json!("error"), Err("failed".to_string()))
        .await;
    assert_eq!(receive_json(&mut rx).await["error"]["message"], "failed");
    empty_backend
        .send_client_result_error(client_id, json!("dropped"), Ok(json!({})))
        .await;
    assert!(timeout(Duration::from_millis(20), rx.recv()).await.is_err());

    fixture.close().await;
}

#[tokio::test]
async fn queue_steer_restores_items_and_validates_every_blocker() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();

    for request in [
        BridgeThreadQueueSteerRequest {
            thread_id: " ".to_string(),
            item_id: "item".to_string(),
        },
        BridgeThreadQueueSteerRequest {
            thread_id: "thread".to_string(),
            item_id: " ".to_string(),
        },
    ] {
        assert!(queue.steer_message(request).await.is_err());
    }

    let cases = [
        (
            "busy-start",
            BridgeThreadQueueRuntime {
                turn_start_in_flight: true,
                active_turn_id: Some("turn".to_string()),
                items: VecDeque::from([queued_entry("item", "content")]),
                ..BridgeThreadQueueRuntime::default()
            },
            "queue is busy",
        ),
        (
            "busy-action",
            BridgeThreadQueueRuntime {
                action_in_flight_item_id: Some("other".to_string()),
                active_turn_id: Some("turn".to_string()),
                items: VecDeque::from([queued_entry("item", "content")]),
                ..BridgeThreadQueueRuntime::default()
            },
            "queue is busy",
        ),
        (
            "approval",
            BridgeThreadQueueRuntime {
                pending_approval_ids: HashSet::from(["approval".to_string()]),
                active_turn_id: Some("turn".to_string()),
                items: VecDeque::from([queued_entry("item", "content")]),
                ..BridgeThreadQueueRuntime::default()
            },
            "approval is pending",
        ),
        (
            "input",
            BridgeThreadQueueRuntime {
                pending_user_input_ids: HashSet::from(["input".to_string()]),
                active_turn_id: Some("turn".to_string()),
                items: VecDeque::from([queued_entry("item", "content")]),
                ..BridgeThreadQueueRuntime::default()
            },
            "user input is pending",
        ),
        (
            "no-turn",
            BridgeThreadQueueRuntime {
                items: VecDeque::from([queued_entry("item", "content")]),
                ..BridgeThreadQueueRuntime::default()
            },
            "no active turn",
        ),
        (
            "missing-item",
            BridgeThreadQueueRuntime {
                active_turn_id: Some("turn".to_string()),
                items: VecDeque::from([queued_entry("other", "content")]),
                ..BridgeThreadQueueRuntime::default()
            },
            "queued message not found",
        ),
    ];
    for (thread_id, runtime, expected) in cases {
        queue
            .threads
            .write()
            .await
            .insert(thread_id.to_string(), runtime);
        let error = queue
            .steer_message(BridgeThreadQueueSteerRequest {
                thread_id: thread_id.to_string(),
                item_id: "item".to_string(),
            })
            .await
            .unwrap_err();
        assert!(error.contains(expected), "{thread_id}: {error}");
    }

    queue.threads.write().await.insert(
        "restore".to_string(),
        BridgeThreadQueueRuntime {
            active_turn_id: Some("turn".to_string()),
            items: VecDeque::from([
                queued_entry("first", "first"),
                BridgeQueuedMessageEntry {
                    id: "bad".to_string(),
                    created_at: now_iso(),
                    content: "bad".to_string(),
                    turn_start: json!({}),
                },
                queued_entry("last", "last"),
            ]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    let error = queue
        .steer_message(BridgeThreadQueueSteerRequest {
            thread_id: "restore".to_string(),
            item_id: "bad".to_string(),
        })
        .await
        .unwrap_err();
    assert!(error.contains("missing input"));
    let threads = queue.threads.read().await;
    let restored = &threads["restore"];
    assert_eq!(
        restored
            .items
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "bad", "last"]
    );
    assert!(restored.action_in_flight_item_id.is_none());
    assert_eq!(restored.last_error.as_ref().unwrap().operation, "steer");
    assert_eq!(
        restored.last_error.as_ref().unwrap().item_id.as_deref(),
        Some("bad")
    );
    drop(threads);

    fixture.close().await;
}

#[tokio::test]
async fn queue_send_dedupe_limits_dispatch_failure_and_completion_fallbacks() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();

    queue.threads.write().await.insert(
        "send-failure".to_string(),
        BridgeThreadQueueRuntime::default(),
    );
    let bad_start = queue
        .send_message(BridgeThreadQueueSendRequest {
            thread_id: "send-failure".to_string(),
            submission_id: "bad-start".to_string(),
            content: "content".to_string(),
            turn_start: json!([]),
        })
        .await
        .unwrap_err();
    assert!(bad_start.contains("must be an object"));
    assert!(!queue.threads.read().await["send-failure"].turn_start_in_flight);

    let remembered = BridgeThreadQueueSendResponse {
        submission_id: "duplicate".to_string(),
        disposition: BridgeThreadQueueDisposition::Queued,
        queue: BridgeThreadQueueState {
            thread_id: "thread-a".to_string(),
            items: Vec::new(),
            last_error: None,
        },
        turn_id: None,
    };
    queue.remember_submission_result(remembered.clone()).await;
    assert_eq!(
        queue
            .send_message(BridgeThreadQueueSendRequest {
                thread_id: "thread-a".to_string(),
                submission_id: "duplicate".to_string(),
                content: "ignored".to_string(),
                turn_start: json!({ "input": [] }),
            })
            .await
            .unwrap()
            .submission_id,
        "duplicate"
    );
    assert!(queue
        .send_message(BridgeThreadQueueSendRequest {
            thread_id: "thread-b".to_string(),
            submission_id: "duplicate".to_string(),
            content: "ignored".to_string(),
            turn_start: json!({ "input": [] }),
        })
        .await
        .unwrap_err()
        .contains("another thread"));

    queue.threads.write().await.insert(
        "full".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            items: (0..QUEUE_MAX_ITEMS_PER_THREAD)
                .map(|index| queued_entry(&format!("item-{index}"), "x"))
                .collect(),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    assert!(queue
        .send_message(BridgeThreadQueueSendRequest {
            thread_id: "full".to_string(),
            submission_id: "full-submission".to_string(),
            content: "x".to_string(),
            turn_start: json!({ "input": [] }),
        })
        .await
        .unwrap_err()
        .contains("queue limit reached"));

    queue.threads.write().await.insert(
        "blocked".to_string(),
        BridgeThreadQueueRuntime {
            pending_approval_ids: HashSet::from(["approval".to_string()]),
            items: VecDeque::from([queued_entry("queued", "queued")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue.drain_thread_queue("blocked".to_string()).await;
    assert_eq!(queue.threads.read().await["blocked"].items.len(), 1);

    // Seed a thread with turn_start_in_flight=true but thread_running=false.
    // This exercises the second condition in runtime_has_blockers (line 2962).
    queue.threads.write().await.insert(
        "turn-in-flight".to_string(),
        BridgeThreadQueueRuntime {
            turn_start_in_flight: true,
            items: VecDeque::from([queued_entry("item-x", "x")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue.drain_thread_queue("turn-in-flight".to_string()).await;
    assert_eq!(queue.threads.read().await["turn-in-flight"].items.len(), 1);

    // Seed a thread with action_in_flight but no thread_running or turn_start.
    // This exercises the third condition in runtime_has_blockers (line 2963).
    queue.threads.write().await.insert(
        "action-in-flight".to_string(),
        BridgeThreadQueueRuntime {
            action_in_flight_item_id: Some("action".to_string()),
            items: VecDeque::from([queued_entry("item-y", "y")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue
        .drain_thread_queue("action-in-flight".to_string())
        .await;
    assert_eq!(
        queue.threads.read().await["action-in-flight"].items.len(),
        1
    );

    // Direct send_message calls to cover internal validation paths not reached
    // through the bridge handler (which has its own pre-validation layer).

    // Empty submissionId (line 2489 in main.rs).
    assert!(queue
        .send_message(BridgeThreadQueueSendRequest {
            thread_id: "thread-a".to_string(),
            submission_id: "  ".to_string(),
            content: "hello".to_string(),
            turn_start: json!({ "input": [] }),
        })
        .await
        .unwrap_err()
        .contains("submissionId"));

    // Oversized combined item_bytes (line 2499 in main.rs).
    // Need content_len + turn_start_json_len > QUEUE_MAX_ITEM_BYTES.
    // QUEUE_MAX_CONTENT_BYTES = 64K, QUEUE_MAX_ITEM_BYTES = 256K.
    // Use 32K content + 230K turn_start → ~262K total > 256K limit.
    let medium_content = "x".repeat(32 * 1024);
    let big_turn_start_payload = "y".repeat(230 * 1024);
    assert!(queue
        .send_message(BridgeThreadQueueSendRequest {
            thread_id: "thread-a".to_string(),
            submission_id: "oversize-item".to_string(),
            content: medium_content,
            turn_start: json!({ "payload": big_turn_start_payload }),
        })
        .await
        .unwrap_err()
        .contains("queue item exceeds"));

    queue.threads.write().await.insert(
        "empty-completion".to_string(),
        BridgeThreadQueueRuntime {
            pending_completion_event_ids: vec![401, 402],
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue
        .drain_thread_queue("empty-completion".to_string())
        .await;
    assert_eq!(
        queue.wait_for_completion_disposition(401).await,
        Some(QueueCompletionDisposition::Final)
    );
    assert_eq!(
        queue.wait_for_completion_disposition(402).await,
        Some(QueueCompletionDisposition::Final)
    );
    queue.drain_thread_queue("not-tracked".to_string()).await;

    queue.threads.write().await.insert(
        "mismatch".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            active_turn_id: Some("turn-current".to_string()),
            items: VecDeque::from([queued_entry("queued", "queued")]),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue
        .handle_notification(HubNotification {
            event_id: 403,
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "mismatch", "turnId": "turn-old" }),
        })
        .await;
    assert!(queue.threads.read().await["mismatch"].thread_running);
    assert!(timeout(
        Duration::from_millis(20),
        queue.wait_for_completion_disposition(403)
    )
    .await
    .is_err());

    queue.threads.write().await.insert(
        "in-flight-completion".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            turn_start_in_flight: true,
            active_turn_id: Some("turn-old".to_string()),
            ..BridgeThreadQueueRuntime::default()
        },
    );
    queue
        .handle_notification(HubNotification {
            event_id: 404,
            method: "turn/completed".to_string(),
            params: json!({ "threadId": "in-flight-completion", "turn": { "id": "turn-old" } }),
        })
        .await;
    let runtime = &queue.threads.read().await["in-flight-completion"];
    assert_eq!(runtime.active_turn_id.as_deref(), Some("turn-old"));
    assert_eq!(runtime.pending_completion_event_ids, vec![404]);

    fixture.close().await;
}

#[tokio::test]
async fn queue_notification_validation_status_and_resolution_fallbacks() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let queue = fixture.state.queue.clone();
    queue.threads.write().await.insert(
        "notify".to_string(),
        BridgeThreadQueueRuntime {
            thread_running: true,
            turn_start_in_flight: true,
            active_turn_id: Some("turn".to_string()),
            ..BridgeThreadQueueRuntime::default()
        },
    );

    for (event_id, method, params) in [
        (1, "turn/started", json!({})),
        (2, "turn/started", json!({ "threadId": "missing" })),
        (3, "turn/completed", json!({})),
        (4, "thread/status/changed", json!({})),
        (5, "thread/status/changed", json!({ "threadId": "notify" })),
        (
            6,
            "thread/status/changed",
            json!({ "threadId": "missing", "status": "idle" }),
        ),
        (7, "bridge/approval.requested", json!({})),
        (
            8,
            "bridge/approval.requested",
            json!({ "threadId": "notify" }),
        ),
        (
            9,
            "bridge/approval.requested",
            json!({ "threadId": "missing", "id": "a" }),
        ),
        (10, "bridge/approval.resolved", json!({})),
        (
            11,
            "bridge/approval.resolved",
            json!({ "threadId": "notify" }),
        ),
        (
            12,
            "bridge/approval.resolved",
            json!({ "threadId": "missing", "id": "a" }),
        ),
        (13, "bridge/userInput.requested", json!({})),
        (
            14,
            "bridge/userInput.requested",
            json!({ "threadId": "notify" }),
        ),
        (
            15,
            "bridge/userInput.requested",
            json!({ "threadId": "missing", "id": "u" }),
        ),
        (16, "bridge/userInput.resolved", json!({})),
        (
            17,
            "bridge/userInput.resolved",
            json!({ "threadId": "notify" }),
        ),
        (
            18,
            "bridge/userInput.resolved",
            json!({ "threadId": "missing", "id": "u" }),
        ),
        (19, "unrelated", json!({ "threadId": "notify" })),
    ] {
        queue
            .handle_notification(HubNotification {
                event_id,
                method: method.to_string(),
                params,
            })
            .await;
    }

    queue
        .handle_notification(HubNotification {
            event_id: 20,
            method: "turn/started".to_string(),
            params: json!({ "threadId": "notify", "turnId": "turn-new" }),
        })
        .await;
    {
        let threads = queue.threads.read().await;
        assert!(threads["notify"].thread_running);
        assert!(!threads["notify"].turn_start_in_flight);
        assert_eq!(
            threads["notify"].active_turn_id.as_deref(),
            Some("turn-new")
        );
    }
    for status in ["running", "pending", "queued"] {
        queue
            .handle_notification(HubNotification {
                event_id: 21,
                method: "thread/status/changed".to_string(),
                params: json!({ "threadId": "notify", "status": status }),
            })
            .await;
        assert!(queue.threads.read().await["notify"].thread_running);
    }
    queue
        .handle_notification(HubNotification {
            event_id: 22,
            method: "thread/status/changed".to_string(),
            params: json!({ "threadId": "notify", "status": "idle" }),
        })
        .await;
    assert!(!queue.threads.read().await["notify"].thread_running);
    assert!(queue.threads.read().await["notify"]
        .active_turn_id
        .is_none());

    fixture.close().await;
}

#[tokio::test]
async fn bridge_rpc_deserialization_and_validation_error_matrix() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let state = &fixture.state;
    let invalid_cases = vec![
        ("bridge/push/register", json!([])),
        (
            "bridge/push/register",
            json!({ "profileId": "p", "registrationId": "r", "token": "t", "platform": "x".repeat(PUSH_PLATFORM_MAX_BYTES + 1) }),
        ),
        (
            "bridge/push/register",
            json!({ "profileId": "p", "registrationId": "r", "token": "t", "deviceName": "x".repeat(PUSH_DEVICE_NAME_MAX_BYTES + 1) }),
        ),
        ("bridge/push/unregister", json!({})),
        ("bridge/browser/session/create", json!({})),
        ("bridge/browser/session/close", json!({})),
        ("bridge/codex/auth/callback/forward", json!({})),
        ("bridge/events/replay", json!({ "limit": "bad" })),
        ("bridge/ui/present", json!({})),
        ("bridge/ui/update", json!([])),
        ("bridge/ui/dismiss", json!({})),
        ("bridge/ui/dismiss", json!({ "id": " " })),
        ("bridge/ui/resolve", json!({})),
        (
            "bridge/ui/resolve",
            json!({ "id": " ", "threadId": "t", "actionId": "a" }),
        ),
        (
            "bridge/ui/resolve",
            json!({ "id": "i", "threadId": "t", "actionId": " " }),
        ),
        (
            "bridge/thread/list/stream/start",
            json!({ "limits": "bad" }),
        ),
        ("bridge/thread/list/stream/cancel", json!({})),
        ("bridge/thread/create", json!({})),
        ("bridge/thread/create", json!({ "submissionId": "s" })),
        ("bridge/thread/queue/read", json!({})),
        ("bridge/thread/queue/send", json!({})),
        ("bridge/thread/queue/steer", json!({})),
        ("bridge/thread/queue/cancel", json!({})),
        ("bridge/workspaces/list", json!({ "limit": "bad" })),
        ("bridge/fs/list", json!({ "includeHidden": "bad" })),
        ("bridge/terminal/exec", json!({})),
        ("bridge/github/auth/install", json!([])),
        ("bridge/git/status", json!({ "cwd": 1 })),
        ("bridge/git/diff", json!({ "cwd": 1 })),
        ("bridge/git/history", json!({ "limit": "bad" })),
        ("bridge/git/branches", json!({ "cwd": 1 })),
        ("bridge/git/clone", json!({})),
        ("bridge/git/stage", json!({})),
        ("bridge/git/stageAll", json!({ "cwd": 1 })),
        ("bridge/git/unstage", json!({})),
        ("bridge/git/unstageAll", json!({ "cwd": 1 })),
        ("bridge/git/commit", json!({})),
        ("bridge/git/commit", json!({ "message": " " })),
        ("bridge/git/switch", json!({})),
        ("bridge/git/switch", json!({ "branch": " " })),
        ("bridge/git/push", json!({ "cwd": 1 })),
        ("bridge/approvals/resolve", json!({})),
        ("bridge/userInput/resolve", json!({})),
    ];
    for (method, params) in invalid_cases {
        let error = handle_bridge_method(method, Some(params), state, 1)
            .await
            .expect_err(method);
        assert_eq!(error.code, -32602, "{method}: {}", error.message);
    }

    let oversized_item = handle_bridge_method(
        "bridge/thread/queue/send",
        Some(json!({
            "threadId": "codex:t",
            "submissionId": "large-item",
            "content": "x",
            "turnStart": { "input": [], "padding": "x".repeat(QUEUE_MAX_ITEM_BYTES) }
        })),
        state,
        1,
    )
    .await
    .unwrap_err();
    assert_eq!(oversized_item.code, -32602);
    assert_eq!(oversized_item.data.unwrap()["resource"], "queue_item_bytes");

    for (method, params) in [
        (
            "bridge/thread/queue/steer",
            json!({ "threadId": " ", "itemId": "i" }),
        ),
        (
            "bridge/thread/queue/steer",
            json!({ "threadId": "t", "itemId": " " }),
        ),
        (
            "bridge/thread/queue/cancel",
            json!({ "threadId": " ", "itemId": "i" }),
        ),
        (
            "bridge/thread/queue/cancel",
            json!({ "threadId": "t", "itemId": " " }),
        ),
        (
            "bridge/thread/queue/cancel",
            json!({ "threadId": "t", "itemId": "missing" }),
        ),
    ] {
        assert_eq!(
            handle_bridge_method(method, Some(params), state, 1)
                .await
                .unwrap_err()
                .code,
            -32000
        );
    }

    fixture.close().await;
}

#[tokio::test]
async fn websocket_global_admission_and_direct_rpc_error_variants() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(2)).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn({
        let app = build_bridge_router(fixture.state.clone());
        async move { axum::serve(listener, app).await.unwrap() }
    });

    let global_permit = fixture
        .state
        .ws_global_in_flight
        .clone()
        .acquire_many_owned(2)
        .await
        .unwrap();
    let mut request = format!("ws://{address}/rpc?clientType=%0A&clientName=%09")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_static("Bearer secret-token"),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    assert_eq!(
        receive_ws_json(&mut socket).await["method"],
        "bridge/connection/state"
    );
    socket
        .send(UpstreamWsMessage::Text(
            json!({ "id": "global", "method": "bridge/status/read" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let overloaded = receive_ws_json(&mut socket).await;
    assert_eq!(overloaded["id"], "global");
    assert_eq!(overloaded["error"]["code"], RPC_SERVER_OVERLOADED);
    assert_eq!(
        overloaded["error"]["data"]["resource"],
        "global_in_flight_requests"
    );
    drop(global_permit);

    socket
        .send(UpstreamWsMessage::Pong(Vec::new().into()))
        .await
        .unwrap();
    assert!(timeout(Duration::from_millis(20), socket.next())
        .await
        .is_err());
    socket.close(None).await.unwrap();

    let (client_id, mut rx) = add_client(&fixture.state.hub, 4).await;
    send_rpc_error(
        &fixture.state,
        client_id,
        json!("with-data"),
        -32099,
        "coverage",
        Some(json!({ "detail": true })),
    )
    .await;
    let with_data = receive_json(&mut rx).await;
    assert_eq!(with_data["error"]["data"]["detail"], true);
    send_overload_error(&fixture.state, client_id, Value::Null, "coverage", 7).await;
    let overload = receive_json(&mut rx).await;
    assert_eq!(overload["error"]["data"]["limit"], 7);
    assert_eq!(overload["error"]["data"]["retryable"], true);

    server.abort();
    fixture.close().await;
}

#[test]
fn persisted_chatgpt_auth_cache_covers_missing_invalid_and_memory_paths() {
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    let _guard = LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = env::temp_dir().join(format!(
        "clawdex-auth-orchestration-{}-{}",
        std::process::id(),
        TEST_NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("auth.json");
    set_bridge_chatgpt_auth_cache_path_override(Some(path.clone()));
    clear_cached_bridge_chatgpt_auth();

    assert!(load_persisted_bridge_chatgpt_auth().is_none());
    std::fs::write(&path, "not-json").unwrap();
    assert!(load_persisted_bridge_chatgpt_auth().is_none());
    std::fs::write(
        &path,
        serde_json::to_vec(&BridgeChatGptAuthBundle {
            access_token: "persisted".to_string(),
            account_id: "account".to_string(),
            plan_type: None,
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        read_cached_bridge_chatgpt_auth().unwrap().access_token,
        "persisted"
    );
    std::fs::remove_file(&path).unwrap();
    assert_eq!(
        read_cached_bridge_chatgpt_auth().unwrap().access_token,
        "persisted"
    );

    clear_cached_bridge_chatgpt_auth();
    set_bridge_chatgpt_auth_cache_path_override(None);
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn drain_thread_queue_processes_completion_events_when_items_are_empty() {
    let fixture = OrchestrationFixture::new(Duration::from_secs(5)).await;
    let queue = fixture.state.queue.clone();

    // Seed a thread with pending completion events but NO items.
    // This exercises the lines 3169-3172 path in drain_thread_queue.
    {
        let mut threads = queue.threads.write().await;
        let mut runtime = BridgeThreadQueueRuntime::default();
        runtime.pending_completion_event_ids.push(500);
        runtime.pending_completion_event_ids.push(501);
        // items is empty — this is the key condition.
        threads.insert("thread-empty-drain".to_string(), runtime);
    }

    // Trigger drain via thread/status/changed with a stopped status.
    // spawn_status_dispatch_fallback adds 250ms delay before draining.
    queue
        .handle_notification(HubNotification {
            event_id: 200,
            method: "thread/status/changed".to_string(),
            params: json!({ "threadId": "thread-empty-drain", "status": "stopped" }),
        })
        .await;

    // Wait for the 250ms + some margin for the drain to process completion events.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The drain should have recorded Final dispositions for both event IDs.
    assert_eq!(
        queue.wait_for_completion_disposition(500).await,
        Some(QueueCompletionDisposition::Final)
    );
    assert_eq!(
        queue.wait_for_completion_disposition(501).await,
        Some(QueueCompletionDisposition::Final)
    );

    fixture.close().await;
}
