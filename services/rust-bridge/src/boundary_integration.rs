use super::*;
use axum::http::{header::AUTHORIZATION, Request as HttpRequest};
use futures_util::{SinkExt, StreamExt};
use std::{fs as std_fs, net::SocketAddr};
use tokio::task::JoinHandle;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error as WsError, Message as WsMessage},
    MaybeTlsStream, WebSocketStream,
};

type TestSocket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

struct BoundaryServer {
    address: SocketAddr,
    state: Arc<AppState>,
    task: JoinHandle<()>,
    root: PathBuf,
}

impl BoundaryServer {
    async fn stop(self) {
        self.task.abort();
        self.state.backend.shutdown().await;
        let _ = std_fs::remove_dir_all(self.root);
    }
}

fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-app-server.sh")
}

async fn start_fake_backend(
    hub: Arc<ClientHub>,
    metrics: Arc<OperationalMetrics>,
    engine: BridgeRuntimeEngine,
    mode: &str,
    request_timeout: Duration,
) -> Arc<AppServerBridge> {
    let mut command = Command::new("sh");
    command
        .arg(fixture_path())
        .env("CLAWDEX_FAKE_BACKEND_MODE", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    AppServerBridge::start_with_command_timeout(command, engine, hub, metrics, request_timeout)
        .await
        .expect("start fake app-server")
}

async fn start_server(
    mode: &str,
    request_timeout: Duration,
    auth_token: Option<&str>,
    allowed_origins: &[&str],
    ready_cursor: bool,
) -> BoundaryServer {
    let root = env::temp_dir().join(format!("clawdex-boundary-{}", Uuid::new_v4()));
    std_fs::create_dir(&root).expect("create boundary root");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral bridge listener");
    let address = listener.local_addr().expect("ephemeral bridge address");
    let metrics = Arc::new(OperationalMetrics::new());
    let hub = Arc::new(ClientHub::new());
    let codex = start_fake_backend(
        hub.clone(),
        metrics.clone(),
        BridgeRuntimeEngine::Codex,
        mode,
        request_timeout,
    )
    .await;
    let cursor = if ready_cursor {
        Some(
            start_fake_backend(
                hub.clone(),
                metrics.clone(),
                BridgeRuntimeEngine::Cursor,
                "normal",
                request_timeout,
            )
            .await,
        )
    } else {
        None
    };
    let backend = Arc::new(RuntimeBackend {
        preferred_engine: BridgeRuntimeEngine::Codex,
        codex: Arc::new(StdRwLock::new(Some(codex))),
        opencode: None,
        cursor: Arc::new(StdRwLock::new(cursor)),
        metrics: metrics.clone(),
    });
    let auth_token = auth_token.map(str::to_string);
    let config = Arc::new(BridgeConfig {
        host: "127.0.0.1".to_string(),
        port: address.port(),
        preview_host: "127.0.0.1".to_string(),
        preview_port: 0,
        connect_url: None,
        preview_connect_url: None,
        workdir: root.clone(),
        cli_bin: fixture_path().to_string_lossy().to_string(),
        opencode_cli_bin: "unused".to_string(),
        cursor_app_server_bin: "unused".to_string(),
        active_engine: BridgeRuntimeEngine::Codex,
        enabled_engines: if ready_cursor {
            vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Cursor]
        } else {
            vec![BridgeRuntimeEngine::Codex]
        },
        opencode_host: "127.0.0.1".to_string(),
        opencode_port: 0,
        opencode_server_username: "unused".to_string(),
        opencode_server_password: None,
        auth_enabled: auth_token.is_some(),
        auth_token,
        allow_insecure_no_auth: true,
        no_auth_allowed_origins: allowed_origins
            .iter()
            .map(|value| value.to_string())
            .collect(),
        allow_query_token_auth: false,
        allow_outside_root_cwd: false,
        terminal_exec_policies: HashSet::new(),
        show_pairing_qr: false,
        ws_limits: WebSocketResourceLimits {
            max_frame_bytes: DEFAULT_WS_MAX_FRAME_BYTES,
            max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
            per_client_in_flight: DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
            global_in_flight: DEFAULT_WS_GLOBAL_IN_FLIGHT,
        },
    });
    let path_policy = Arc::new(PathPolicy::new(root.clone(), false).expect("test path policy"));
    let terminal = Arc::new(TerminalService::new(path_policy.clone(), HashSet::new()));
    let git = Arc::new(GitService::new(terminal.clone(), path_policy.clone()));
    let queue = BridgeQueueService::new(backend.clone(), hub.clone());
    let push = PushService::load(&root, "Boundary test".to_string(), metrics.clone()).await;
    let state = Arc::new(AppState {
        config: config.clone(),
        path_policy,
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
        terminal,
        git,
        updater: Arc::new(UpdateService::discover()),
        preview: Arc::new(BrowserPreviewService::new(
            config.port,
            config.preview_port,
            None,
            None,
        )),
        push,
        ws_global_in_flight: Arc::new(Semaphore::new(config.ws_limits.global_in_flight)),
        metrics,
    });
    let router = build_bridge_router(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve test bridge");
    });
    BoundaryServer {
        address,
        state,
        task,
        root,
    }
}

fn ws_request(
    server: &BoundaryServer,
    token: Option<&str>,
    origin: Option<&str>,
) -> HttpRequest<()> {
    let mut request = format!("ws://{}/rpc", server.address)
        .into_client_request()
        .expect("websocket request");
    if let Some(token) = token {
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("auth header"),
        );
    }
    if let Some(origin) = origin {
        request.headers_mut().insert(
            ORIGIN,
            HeaderValue::from_str(origin).expect("origin header"),
        );
    }
    request
}

async fn connect(
    server: &BoundaryServer,
    token: Option<&str>,
    origin: Option<&str>,
) -> Result<TestSocket, WsError> {
    connect_async(ws_request(server, token, origin))
        .await
        .map(|(socket, _)| socket)
}

async fn recv_json(socket: &mut TestSocket) -> Value {
    loop {
        let message = timeout(Duration::from_secs(3), socket.next())
            .await
            .expect("websocket receive timeout")
            .expect("websocket closed")
            .expect("websocket message");
        if let WsMessage::Text(text) = message {
            return serde_json::from_str(&text).expect("JSON websocket payload");
        }
    }
}

async fn rpc(socket: &mut TestSocket, id: &str, method: &str, params: Option<Value>) -> Value {
    let mut request = json!({ "id": id, "method": method });
    if let Some(params) = params {
        request["params"] = params;
    }
    socket
        .send(WsMessage::Text(request.to_string().into()))
        .await
        .expect("send RPC request");
    loop {
        let payload = recv_json(socket).await;
        if payload.get("id") == Some(&Value::String(id.to_string())) {
            return payload;
        }
    }
}

fn response_status(error: WsError) -> StatusCode {
    match error {
        WsError::Http(response) => response.status(),
        other => panic!("expected HTTP websocket rejection, got {other}"),
    }
}

#[tokio::test]
async fn real_transport_enforces_auth_and_no_auth_origins() {
    let authenticated = start_server(
        "normal",
        Duration::from_secs(2),
        Some("boundary-secret"),
        &[],
        false,
    )
    .await;
    assert_eq!(
        response_status(connect(&authenticated, None, None).await.unwrap_err()),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        response_status(
            connect(&authenticated, Some("wrong"), Some("https://evil.example"))
                .await
                .unwrap_err()
        ),
        StatusCode::UNAUTHORIZED
    );
    let mut socket = connect(
        &authenticated,
        Some("boundary-secret"),
        Some("https://evil.example"),
    )
    .await
    .expect("authenticated origin is permitted");
    assert_eq!(
        recv_json(&mut socket).await["method"],
        "bridge/connection/state"
    );
    socket
        .close(None)
        .await
        .expect("close authenticated socket");
    authenticated.stop().await;

    let no_auth = start_server(
        "normal",
        Duration::from_secs(2),
        None,
        &["https://allowed.example"],
        false,
    )
    .await;
    assert_eq!(
        response_status(
            connect(&no_auth, None, Some("https://evil.example"))
                .await
                .unwrap_err()
        ),
        StatusCode::FORBIDDEN
    );
    let mut socket = connect(&no_auth, None, Some("https://allowed.example"))
        .await
        .expect("allowlisted no-auth origin");
    assert_eq!(
        recv_json(&mut socket).await["method"],
        "bridge/connection/state"
    );
    socket.close(None).await.expect("close no-auth socket");
    no_auth.stop().await;
}

#[tokio::test]
async fn reconnect_replays_notifications_over_real_websockets() {
    let server = start_server("normal", Duration::from_secs(2), Some("secret"), &[], false).await;
    let mut first = connect(&server, Some("secret"), None)
        .await
        .expect("first connection");
    let connected = recv_json(&mut first).await;
    let stream_id = connected["streamId"].clone();
    let response = rpc(
        &mut first,
        "present",
        "bridge/ui/present",
        Some(json!({
            "id": "surface-1",
            "threadId": "thread-1",
            "presentation": "modal",
            "title": "Boundary",
            "blocks": [{ "type": "text", "text": "Replay me" }],
            "actions": []
        })),
    )
    .await;
    assert_eq!(response["result"]["ok"], true);
    first.close(None).await.expect("disconnect first client");

    let mut second = connect(&server, Some("secret"), None)
        .await
        .expect("reconnect");
    assert_eq!(recv_json(&mut second).await["streamId"], stream_id);
    let replay = rpc(
        &mut second,
        "replay",
        "bridge/events/replay",
        Some(json!({ "afterEventId": 0, "limit": 10 })),
    )
    .await;
    assert_eq!(replay["result"]["streamId"], stream_id);
    assert!(replay["result"]["events"]
        .as_array()
        .expect("replay events")
        .iter()
        .any(|event| event["method"] == "bridge/ui.present"));
    second.close(None).await.expect("close replay client");
    server.stop().await;
}

#[tokio::test]
async fn backend_death_fails_requests_and_reports_degradation() {
    let server = start_server(
        "death-on-account-read",
        Duration::from_secs(2),
        Some("secret"),
        &[],
        true,
    )
    .await;
    let mut socket = connect(&server, Some("secret"), None)
        .await
        .expect("connect bridge");
    let _ = recv_json(&mut socket).await;
    let failed = rpc(&mut socket, "death", "account/read", None).await;
    assert_eq!(failed["error"]["code"], -32000);
    assert!(failed["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains("closed")));

    let status = reqwest::Client::new()
        .get(format!("http://{}/status", server.address))
        .bearer_auth("secret")
        .send()
        .await
        .expect("status request");
    assert_eq!(status.status(), reqwest::StatusCode::OK);
    let body: Value = status.json().await.expect("status JSON");
    assert_eq!(body["status"], "degraded");
    assert_eq!(body["engines"]["codex"]["lifecycle"], "dead");
    assert_eq!(body["engines"]["cursor"]["lifecycle"], "ready");
    socket.close(None).await.expect("close client");
    server.stop().await;
}

#[tokio::test]
async fn concurrent_queue_sends_are_serialized_without_loss() {
    let server = start_server("normal", Duration::from_secs(2), Some("secret"), &[], false).await;
    let mut socket = connect(&server, Some("secret"), None)
        .await
        .expect("connect bridge");
    let _ = recv_json(&mut socket).await;
    for index in 0..8 {
        let request = json!({
            "id": format!("queue-{index}"),
            "method": "bridge/thread/queue/send",
            "params": {
                "threadId": "thread-1",
                "submissionId": format!("submission-{index}"),
                "content": format!("message {index}"),
                "turnStart": { "input": [{ "type": "text", "text": format!("message {index}") }] }
            }
        });
        socket
            .send(WsMessage::Text(request.to_string().into()))
            .await
            .expect("send queue request");
    }

    let mut responses = HashMap::new();
    while responses.len() < 8 {
        let payload = recv_json(&mut socket).await;
        if let Some(id) = payload.get("id").and_then(Value::as_str) {
            responses.insert(id.to_string(), payload);
        }
    }
    assert_eq!(
        responses
            .values()
            .filter(|response| response["result"]["disposition"] == "sent")
            .count(),
        1
    );
    assert_eq!(
        responses
            .values()
            .filter(|response| response["result"]["disposition"] == "queued")
            .count(),
        7
    );
    let queue = rpc(
        &mut socket,
        "read-queue",
        "bridge/thread/queue/read",
        Some(json!({ "threadId": "thread-1" })),
    )
    .await;
    let items = queue["result"]["items"].as_array().expect("queued items");
    assert_eq!(items.len(), 7);
    assert_eq!(
        items
            .iter()
            .filter_map(|item| item["content"].as_str())
            .collect::<HashSet<_>>()
            .len(),
        7
    );
    socket.close(None).await.expect("close queue client");
    server.stop().await;
}

#[tokio::test]
async fn forwarded_requests_time_out_and_disconnect_cancels_pending_work() {
    let server = start_server(
        "hang-account-read",
        Duration::from_millis(120),
        Some("secret"),
        &[],
        false,
    )
    .await;
    let mut socket = connect(&server, Some("secret"), None)
        .await
        .expect("connect bridge");
    let _ = recv_json(&mut socket).await;
    let timed_out = rpc(&mut socket, "timeout", "account/read", None).await;
    assert_eq!(timed_out["error"]["data"]["error"], "timeout");
    assert_eq!(timed_out["error"]["data"]["retryable"], true);

    socket
        .send(WsMessage::Text(
            json!({ "id": "cancel", "method": "account/read" })
                .to_string()
                .into(),
        ))
        .await
        .expect("send cancellable request");
    sleep(Duration::from_millis(20)).await;
    socket.close(None).await.expect("disconnect client");
    for _ in 0..20 {
        if server
            .state
            .backend
            .codex_backend()
            .expect("codex backend")
            .pending_requests
            .lock()
            .await
            .is_empty()
        {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }
    sleep(Duration::from_millis(140)).await;
    let backend = server.state.backend.codex_backend().expect("codex backend");
    assert!(backend.pending_requests.lock().await.is_empty());
    assert_eq!(backend.timed_out_requests.load(Ordering::Relaxed), 1);
    server.stop().await;
}

#[tokio::test]
async fn transport_confines_paths_persists_atomically_and_matches_shared_fixtures() {
    let server = start_server("normal", Duration::from_secs(2), Some("secret"), &[], false).await;
    let outside = server
        .root
        .parent()
        .expect("boundary parent")
        .join(format!("clawdex-outside-{}.png", Uuid::new_v4()));
    std_fs::write(&outside, b"outside").expect("write outside image");
    let escaped = reqwest::Client::new()
        .get(format!("http://{}/local-image", server.address))
        .bearer_auth("secret")
        .query(&[("path", outside.to_string_lossy().to_string())])
        .send()
        .await
        .expect("outside image request");
    assert_eq!(escaped.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(
        escaped.json::<Value>().await.expect("path error JSON")["error"],
        "invalid_path"
    );

    let mut socket = connect(&server, Some("secret"), None)
        .await
        .expect("connect bridge");
    let _ = recv_json(&mut socket).await;
    for index in 0..6 {
        let response = rpc(
            &mut socket,
            &format!("register-{index}"),
            "bridge/push/register",
            Some(json!({
                "profileId": "profile-1",
                "registrationId": format!("registration-{index}"),
                "token": format!("ExponentPushToken[{index}]"),
                "platform": "ios",
                "deviceName": format!("Device {index}")
            })),
        )
        .await;
        assert_eq!(response["result"]["ok"], true);
    }
    let persisted = std_fs::read(server.root.join(".clawdex-push-registry.json"))
        .expect("persisted push registry");
    let persisted: Value = serde_json::from_slice(&persisted).expect("atomic registry JSON");
    assert_eq!(persisted["devices"].as_array().map(Vec::len), Some(6));
    assert!(!std_fs::read_dir(&server.root)
        .expect("read boundary root")
        .filter_map(Result::ok)
        .any(|entry| entry.file_name().to_string_lossy().ends_with(".tmp")));

    let capabilities = rpc(
        &mut socket,
        "capabilities",
        "bridge/capabilities/read",
        None,
    )
    .await;
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../contracts/bridge-rpc/v1/manifest.json"
    ))
    .expect("cross-language contract fixture");
    let fixture = &manifest["fixtures"]["capabilities"];
    assert_eq!(
        capabilities["result"]["protocolVersion"],
        fixture["protocolVersion"]
    );
    assert_eq!(
        capabilities["result"]["activeEngine"],
        fixture["activeEngine"]
    );
    assert_eq!(
        capabilities["result"]["configuredEngines"],
        fixture["configuredEngines"]
    );
    assert_eq!(
        capabilities["result"]["availableEngines"],
        fixture["availableEngines"]
    );
    assert_eq!(
        capabilities["result"]["unifiedChatList"],
        fixture["unifiedChatList"]
    );

    socket.close(None).await.expect("close fixture client");
    server.stop().await;
    let _ = std_fs::remove_file(outside);
}
