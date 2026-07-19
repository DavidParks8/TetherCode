use super::*;

use axum::body::Bytes;
use axum::http::header::{AUTHORIZATION, ETAG, LAST_MODIFIED};
use std::{fs as std_fs, net::SocketAddr, process::Command as StdCommand};
use tokio::task::JoinHandle;

const TEST_TOKEN: &str = "surface-test-token";

struct SurfaceContext {
    root: PathBuf,
    state: Arc<AppState>,
}

impl Drop for SurfaceContext {
    fn drop(&mut self) {
        let _ = std_fs::remove_dir_all(&self.root);
    }
}

impl SurfaceContext {
    async fn new(auth_enabled: bool, allow_query_token_auth: bool) -> Self {
        let root = env::temp_dir().join(format!("clawdex-main-surfaces-{}", Uuid::new_v4()));
        std_fs::create_dir(&root).expect("create surface test root");
        let metrics = Arc::new(OperationalMetrics::new());
        let hub = Arc::new(ClientHub::new());
        let backend = Arc::new(RuntimeBackend {
            preferred_engine: BridgeRuntimeEngine::Codex,
            codex: Arc::new(StdRwLock::new(None)),
            opencode: None,
            cursor: Arc::new(StdRwLock::new(None)),
            metrics: metrics.clone(),
        });
        let config = Arc::new(BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 0,
            preview_host: "127.0.0.1".to_string(),
            preview_port: 0,
            connect_url: None,
            preview_connect_url: None,
            workdir: root.clone(),
            cli_bin: "unused".to_string(),
            opencode_cli_bin: "unused".to_string(),
            cursor_app_server_bin: "unused".to_string(),
            active_engine: BridgeRuntimeEngine::Codex,
            enabled_engines: vec![BridgeRuntimeEngine::Codex],
            opencode_host: "127.0.0.1".to_string(),
            opencode_port: 0,
            opencode_server_username: "unused".to_string(),
            opencode_server_password: None,
            auth_token: auth_enabled.then(|| TEST_TOKEN.to_string()),
            auth_enabled,
            allow_insecure_no_auth: !auth_enabled,
            no_auth_allowed_origins: HashSet::from(["https://allowed.example".to_string()]),
            allow_query_token_auth,
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
        let path_policy = Arc::new(PathPolicy::new(root.clone(), false).expect("path policy"));
        let terminal = Arc::new(TerminalService::new(path_policy.clone(), HashSet::new()));
        let git = Arc::new(GitService::new(terminal.clone(), path_policy.clone()));
        let queue = BridgeQueueService::new(backend.clone(), hub.clone());
        let push = PushService::load(&root, "Surface tests".to_string(), metrics.clone()).await;
        let preview = Arc::new(BrowserPreviewService::new(0, 0, None, None));
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
            preview,
            push,
            ws_global_in_flight: Arc::new(Semaphore::new(config.ws_limits.global_in_flight)),
            metrics,
        });
        Self { root, state }
    }

    async fn with_app_server() -> (Self, Arc<AppServerBridge>) {
        let context = Self::new(true, false).await;
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn app-server sink");
        let writer = child.stdin.take().expect("app-server sink stdin");
        let child_pid = child.id().expect("app-server sink pid");
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
            hub: context.state.hub.clone(),
            lifecycle: Arc::new(BackendRuntimeStatus::starting()),
            metrics: context.state.metrics.clone(),
            timed_out_requests: AtomicU64::new(0),
            request_timeout: Duration::from_secs(2),
        });
        bridge
            .lifecycle
            .transition(BackendLifecycleState::Ready, None)
            .await;
        *context
            .state
            .backend
            .codex
            .write()
            .expect("codex backend lock") = Some(bridge.clone());
        (context, bridge)
    }
}

struct EphemeralServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

impl Drop for EphemeralServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl EphemeralServer {
    fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.address, path)
    }
}

async fn serve(router: Router) -> EphemeralServer {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral server");
    let address = listener.local_addr().expect("server address");
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve ephemeral router");
    });
    EphemeralServer { address, task }
}

fn http_client() -> HttpClient {
    HttpClient::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("test HTTP client")
}

fn bearer(request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    request.header(AUTHORIZATION.as_str(), format!("Bearer {TEST_TOKEN}"))
}

async fn response_json(response: reqwest::Response) -> Value {
    response.json().await.expect("JSON response")
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
    .expect("internal app-server request")
}

fn run_git(root: &Path, args: &[&str]) {
    let output = StdCommand::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "commit.gpgsign")
        .env("GIT_CONFIG_VALUE_0", "false")
        .output()
        .expect("run git fixture command");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

async fn upstream_echo(request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, PREVIEW_REQUEST_MAX_BYTES)
        .await
        .expect("echo body");
    Json(json!({
        "method": parts.method.as_str(),
        "origin": parts.headers.get(ORIGIN).and_then(|value| value.to_str().ok()),
        "referer": parts.headers.get(REFERER).and_then(|value| value.to_str().ok()),
        "cookie": parts.headers.get(COOKIE).and_then(|value| value.to_str().ok()),
        "body": String::from_utf8_lossy(&bytes),
        "path": parts.uri.path_and_query().map(|value| value.as_str()),
    }))
    .into_response()
}

async fn upstream_html() -> Response {
    let mut response = Response::new(Body::from(
        "<html><head><title>Upstream</title></head><body>hello</body></html>",
    ));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(ETAG, HeaderValue::from_static("\"upstream-etag\""));
    response.headers_mut().insert(
        LAST_MODIFIED,
        HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT"),
    );
    response
        .headers_mut()
        .insert(VARY, HeaderValue::from_static("Accept-Encoding"));
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_static("session=abc; Domain=localhost; Path=/; HttpOnly"),
    );
    response
}

async fn upstream_encoded_html() -> Response {
    let mut response = Response::new(Body::from("<html><head></head><body>encoded</body></html>"));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
    response
        .headers_mut()
        .insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    response
}

async fn upstream_redirect() -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::FOUND;
    response.headers_mut().insert(
        LOCATION,
        HeaderValue::from_static("/signed-in?from=preview#top"),
    );
    response.headers_mut().append(
        SET_COOKIE,
        HeaderValue::from_static("backend=ok; Domain=localhost; HttpOnly"),
    );
    response
}

async fn upstream_declared_too_large() -> Response {
    let mut response = Response::new(Body::from(vec![
        b'x';
        PREVIEW_BUFFERED_RESPONSE_MAX_BYTES + 1
    ]));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
    response
}

async fn upstream_chunked_too_large() -> Response {
    let chunks = vec![
        Ok::<_, std::io::Error>(Bytes::from(vec![b'a'; PREVIEW_BUFFERED_RESPONSE_MAX_BYTES])),
        Ok(Bytes::from_static(b"overflow")),
    ];
    let mut response = Response::new(Body::from_stream(futures_util::stream::iter(chunks)));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
    response
}

async fn upstream_broken_html() -> Response {
    let chunks = vec![
        Ok::<_, std::io::Error>(Bytes::from_static(b"<html>")),
        Err(std::io::Error::other("surface stream failure")),
    ];
    let mut response = Response::new(Body::from_stream(futures_util::stream::iter(chunks)));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
    response
}

async fn start_upstream() -> EphemeralServer {
    serve(
        Router::new()
            .route("/echo", any(upstream_echo))
            .route("/html", get(upstream_html))
            .route("/encoded", get(upstream_encoded_html))
            .route("/redirect", get(upstream_redirect))
            .route("/too-large", get(upstream_declared_too_large))
            .route("/chunked-too-large", get(upstream_chunked_too_large))
            .route("/broken-html", get(upstream_broken_html)),
    )
    .await
}

async fn preview_session_path(
    context: &SurfaceContext,
    target_url: &str,
) -> (String, String, String) {
    context.state.preview.set_available(true);
    let session = context
        .state
        .preview
        .create_session(7, target_url)
        .await
        .expect("create preview session");
    let value = serde_json::to_value(session).expect("serialize preview session");
    let bootstrap_path = value["bootstrapPath"]
        .as_str()
        .expect("bootstrap path")
        .to_string();
    let session_id = value["sessionId"].as_str().expect("session id").to_string();
    let parsed =
        Url::parse(&format!("http://preview{bootstrap_path}")).expect("parse bootstrap path");
    let token = parsed
        .query_pairs()
        .find_map(|(key, value)| (key == "st").then(|| value.into_owned()))
        .expect("bootstrap token");
    (bootstrap_path, session_id, token)
}

fn cookie_pair(response: &reqwest::Response, name: &str) -> String {
    response
        .headers()
        .get_all(SET_COOKIE.as_str())
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| {
            let pair = value.split(';').next()?;
            pair.starts_with(&format!("{name}="))
                .then(|| pair.to_string())
        })
        .expect("response cookie")
}

#[tokio::test]
async fn bridge_health_status_and_auth_routes_cover_protected_branches() {
    let context = SurfaceContext::new(true, false).await;
    let server = serve(build_bridge_router(context.state.clone())).await;
    let client = http_client();

    let health = client
        .get(server.url("/health"))
        .send()
        .await
        .expect("health response");
    assert_eq!(health.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let health = response_json(health).await;
    assert_eq!(health["status"], "unhealthy");
    assert!(health["at"].as_str().is_some());

    let unauthorized = client
        .get(server.url("/status"))
        .send()
        .await
        .expect("unauthorized status");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(response_json(unauthorized).await["error"], "unauthorized");

    let status = bearer(client.get(server.url("/status")))
        .send()
        .await
        .expect("authorized status");
    assert_eq!(status.status(), reqwest::StatusCode::OK);
    let status = response_json(status).await;
    assert_eq!(status["status"], "unhealthy");
    assert_eq!(status["engines"]["codex"]["configured"], true);
    assert_eq!(status["engines"]["codex"]["available"], false);

    let query_rejected = client
        .get(server.url(&format!("/status?token={TEST_TOKEN}")))
        .send()
        .await
        .expect("query token rejection");
    assert_eq!(query_rejected.status(), reqwest::StatusCode::UNAUTHORIZED);

    let query_context = SurfaceContext::new(true, true).await;
    let query_server = serve(build_bridge_router(query_context.state.clone())).await;
    let query_allowed = client
        .get(query_server.url(&format!("/status?token={TEST_TOKEN}")))
        .send()
        .await
        .expect("query token status");
    assert_eq!(query_allowed.status(), reqwest::StatusCode::OK);

    let no_auth = SurfaceContext::new(false, false).await;
    let no_auth_server = serve(build_bridge_router(no_auth.state.clone())).await;
    let forbidden = client
        .get(no_auth_server.url("/status"))
        .header(ORIGIN.as_str(), "https://evil.example")
        .send()
        .await
        .expect("forbidden origin");
    assert_eq!(forbidden.status(), reqwest::StatusCode::FORBIDDEN);
    assert_eq!(response_json(forbidden).await["error"], "forbidden_origin");
    let allowed = client
        .get(no_auth_server.url("/status"))
        .header(ORIGIN.as_str(), "https://allowed.example")
        .send()
        .await
        .expect("allowed origin");
    assert_eq!(allowed.status(), reqwest::StatusCode::OK);
}

#[tokio::test]
async fn local_image_route_serves_files_and_reports_path_media_and_size_errors() {
    let context = SurfaceContext::new(true, false).await;
    let server = serve(build_bridge_router(context.state.clone())).await;
    let client = http_client();
    let png = context.root.join("pixel.png");
    let png_bytes = b"\x89PNG\r\n\x1a\nfixture";
    std_fs::write(&png, png_bytes).expect("write image fixture");

    let response = bearer(
        client
            .get(server.url("/local-image"))
            .query(&[("path", png.to_string_lossy().as_ref())]),
    )
    .send()
    .await
    .expect("image response");
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(response.headers()[CONTENT_TYPE.as_str()], "image/png");
    assert_eq!(response.headers()[CACHE_CONTROL.as_str()], "no-store");
    assert_eq!(response.bytes().await.unwrap().as_ref(), png_bytes);

    let missing = bearer(client.get(server.url("/local-image")).query(&[(
        "path",
        context.root.join("missing.png").to_string_lossy().as_ref(),
    )]))
    .send()
    .await
    .expect("missing image response");
    assert_eq!(missing.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(response_json(missing).await["error"], "invalid_path");

    let malformed_query = bearer(client.get(server.url("/local-image")))
        .send()
        .await
        .expect("missing image query response");
    assert_eq!(malformed_query.status(), reqwest::StatusCode::BAD_REQUEST);

    let query_authorized = client
        .get(server.url("/local-image"))
        .query(&[
            ("path", png.to_string_lossy().as_ref()),
            ("token", TEST_TOKEN),
        ])
        .send()
        .await
        .expect("disabled image query token response");
    assert_eq!(query_authorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let directory = bearer(
        client
            .get(server.url("/local-image"))
            .query(&[("path", context.root.to_string_lossy().as_ref())]),
    )
    .send()
    .await
    .expect("directory image response");
    assert_eq!(directory.status(), reqwest::StatusCode::BAD_REQUEST);

    let text = context.root.join("not-image.txt");
    std_fs::write(&text, b"plain text").expect("write text fixture");
    let unsupported = bearer(
        client
            .get(server.url("/local-image"))
            .query(&[("path", text.to_string_lossy().as_ref())]),
    )
    .send()
    .await
    .expect("unsupported image response");
    assert_eq!(
        unsupported.status(),
        reqwest::StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        response_json(unsupported).await["error"],
        "unsupported_media_type"
    );

    let oversized = context.root.join("oversized.png");
    let file = std_fs::File::create(&oversized).expect("create sparse image");
    file.set_len(LOCAL_IMAGE_MAX_BYTES + 1)
        .expect("size sparse image");
    let too_large = bearer(
        client
            .get(server.url("/local-image"))
            .query(&[("path", oversized.to_string_lossy().as_ref())]),
    )
    .send()
    .await
    .expect("oversized image response");
    assert_eq!(too_large.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    let body = response_json(too_large).await;
    assert_eq!(body["error"], "resource_limit_exceeded");
    assert_eq!(body["resource"], "local_image_bytes");

    let outside = env::temp_dir().join(format!("outside-{}.png", Uuid::new_v4()));
    std_fs::write(&outside, png_bytes).expect("write outside image");
    let denied = bearer(
        client
            .get(server.url("/local-image"))
            .query(&[("path", outside.to_string_lossy().as_ref())]),
    )
    .send()
    .await
    .expect("outside image response");
    assert_eq!(denied.status(), reqwest::StatusCode::BAD_REQUEST);
    let _ = std_fs::remove_file(outside);
}

type MultipartField<'a> = (&'a str, Option<&'a str>, Option<&'a str>, &'a [u8]);

fn multipart_body(boundary: &str, fields: &[MultipartField<'_>]) -> Vec<u8> {
    let mut body = Vec::new();
    for (name, file_name, content_type, value) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        let mut disposition = format!("Content-Disposition: form-data; name=\"{name}\"");
        if let Some(file_name) = file_name {
            disposition.push_str(&format!("; filename=\"{file_name}\""));
        }
        body.extend_from_slice(format!("{disposition}\r\n").as_bytes());
        if let Some(content_type) = content_type {
            body.extend_from_slice(format!("Content-Type: {content_type}\r\n").as_bytes());
        }
        body.extend_from_slice(b"\r\n");
        body.extend_from_slice(value);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    body
}

#[tokio::test]
async fn attachment_route_covers_success_extractor_and_validation_responses() {
    let context = SurfaceContext::new(true, false).await;
    let server = serve(build_bridge_router(context.state.clone())).await;
    let client = http_client();
    let boundary = "clawdex-surface-boundary";
    let body = multipart_body(
        boundary,
        &[
            ("threadId", None, None, b"codex:thread/unsafe"),
            ("kind", None, None, b"image"),
            ("fileName", None, None, b"../screen shot.png"),
            ("file", Some("ignored.png"), Some("image/png"), b"png-data"),
        ],
    );
    let uploaded = bearer(
        client
            .post(server.url("/attachments"))
            .header(
                CONTENT_TYPE.as_str(),
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body),
    )
    .send()
    .await
    .expect("attachment upload");
    assert_eq!(uploaded.status(), reqwest::StatusCode::CREATED);
    let uploaded = response_json(uploaded).await;
    assert_eq!(uploaded["fileName"], "screen_shot.png");
    assert_eq!(uploaded["mimeType"], "image/png");
    assert_eq!(uploaded["sizeBytes"], 8);
    assert_eq!(uploaded["kind"], "image");
    let uploaded_path = PathBuf::from(uploaded["path"].as_str().unwrap());
    assert!(uploaded_path
        .canonicalize()
        .unwrap()
        .starts_with(context.root.canonicalize().unwrap()));
    assert_eq!(std_fs::read(uploaded_path).unwrap(), b"png-data");

    let malformed = bearer(
        client
            .post(server.url("/attachments"))
            .header(CONTENT_TYPE.as_str(), "application/json")
            .body("{}"),
    )
    .send()
    .await
    .expect("malformed upload");
    assert_eq!(malformed.status(), reqwest::StatusCode::BAD_REQUEST);
    assert_eq!(response_json(malformed).await["error"], "invalid_upload");

    let no_file = multipart_body(boundary, &[("kind", None, None, b"file")]);
    let no_file = bearer(
        client
            .post(server.url("/attachments"))
            .header(
                CONTENT_TYPE.as_str(),
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(no_file),
    )
    .send()
    .await
    .expect("missing file upload");
    assert_eq!(no_file.status(), reqwest::StatusCode::BAD_REQUEST);
    assert!(response_json(no_file).await["message"]
        .as_str()
        .unwrap()
        .contains("file field is required"));

    let unsupported = multipart_body(boundary, &[("surprise", None, None, b"value")]);
    let unsupported = bearer(
        client
            .post(server.url("/attachments"))
            .header(
                CONTENT_TYPE.as_str(),
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(unsupported),
    )
    .send()
    .await
    .expect("unsupported field upload");
    assert_eq!(unsupported.status(), reqwest::StatusCode::BAD_REQUEST);
    assert!(response_json(unsupported).await["message"]
        .as_str()
        .unwrap()
        .contains("unsupported multipart field"));

    let unauthorized = client
        .post(server.url("/attachments"))
        .send()
        .await
        .expect("unauthorized upload");
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn attachment_route_rejects_duplicate_empty_invalid_and_oversized_fields() {
    let context = SurfaceContext::new(true, false).await;
    let server = serve(build_bridge_router(context.state.clone())).await;
    let client = http_client();
    let boundary = "clawdex-attachment-errors";

    for (fields, expected) in [
        (
            vec![
                (
                    "file",
                    Some("one.txt"),
                    Some("text/plain"),
                    b"one".as_slice(),
                ),
                (
                    "file",
                    Some("two.txt"),
                    Some("text/plain"),
                    b"two".as_slice(),
                ),
            ],
            "exactly one file field is required",
        ),
        (
            vec![(
                "file",
                Some("empty.txt"),
                Some("text/plain"),
                b"".as_slice(),
            )],
            "attachment payload is empty",
        ),
        (
            vec![
                ("fileName", None, None, &[0xff][..]),
                ("file", Some("ok.txt"), Some("text/plain"), b"ok".as_slice()),
            ],
            "multipart metadata must be UTF-8",
        ),
    ] {
        let response = bearer(
            client
                .post(server.url("/attachments"))
                .header(
                    CONTENT_TYPE.as_str(),
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(multipart_body(boundary, &fields)),
        )
        .send()
        .await
        .expect("attachment validation response");
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        assert!(response_json(response).await["message"]
            .as_str()
            .unwrap()
            .contains(expected));
    }

    let metadata = vec![b'x'; 4 * 1024 + 1];
    let fields = [
        ("fileName", None, None, metadata.as_slice()),
        ("file", Some("ok.txt"), Some("text/plain"), b"ok".as_slice()),
    ];
    let response = bearer(
        client
            .post(server.url("/attachments"))
            .header(
                CONTENT_TYPE.as_str(),
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(multipart_body(boundary, &fields)),
    )
    .send()
    .await
    .expect("oversized attachment metadata response");
    assert_eq!(response.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response_json(response).await["resource"],
        "attachment_metadata_bytes"
    );
}

#[tokio::test]
async fn filesystem_and_workspace_rpc_methods_cover_real_entries_and_backend_results() {
    let context = SurfaceContext::new(true, false).await;
    std_fs::create_dir(context.root.join("Alpha")).unwrap();
    std_fs::create_dir(context.root.join("beta")).unwrap();
    std_fs::create_dir(context.root.join(".hidden")).unwrap();
    std_fs::create_dir(context.root.join("Alpha/.git")).unwrap();
    std_fs::write(context.root.join("readme.txt"), b"file").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(context.root.join("beta"), context.root.join("beta-link")).unwrap();

    let directories = handle_bridge_method(
        "bridge/fs/list",
        Some(json!({ "includeGitRepo": true })),
        &context.state,
        1,
    )
    .await
    .unwrap();
    assert_eq!(directories["parentPath"], Value::Null);
    assert_eq!(directories["entries"][0]["name"], "Alpha");
    assert_eq!(directories["entries"][0]["isGitRepo"], true);
    assert!(directories["entries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|entry| entry["kind"] == "directory" && entry["name"] != ".hidden"));

    let all_entries = handle_bridge_method(
        "bridge/fs/list",
        Some(json!({
            "includeHidden": true,
            "directoriesOnly": false,
            "includeGitRepo": false
        })),
        &context.state,
        1,
    )
    .await
    .unwrap();
    assert!(all_entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "readme.txt" && entry["selectable"] == false));
    assert!(all_entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == ".hidden" && entry["hidden"] == true));

    let nested = handle_bridge_method(
        "bridge/fs/list",
        Some(json!({ "path": "Alpha" })),
        &context.state,
        1,
    )
    .await
    .unwrap();
    assert_eq!(
        nested["parentPath"],
        path_to_string(&context.root.canonicalize().unwrap())
    );
    assert_eq!(
        handle_bridge_method(
            "bridge/fs/list",
            Some(json!({ "path": "missing" })),
            &context.state,
            1,
        )
        .await
        .unwrap_err()
        .code,
        -32602
    );

    let (backend_context, bridge) = SurfaceContext::with_app_server().await;
    let workspace = backend_context.root.join("workspace");
    std_fs::create_dir(&workspace).unwrap();
    let outside = env::temp_dir().join(format!("clawdex-workspace-outside-{}", Uuid::new_v4()));
    std_fs::create_dir(&outside).unwrap();
    let state = backend_context.state.clone();
    let task = tokio::spawn(async move {
        handle_bridge_method(
            "bridge/workspaces/list",
            Some(json!({ "limit": 0 })),
            &state,
            1,
        )
        .await
    });
    let request_id = wait_for_internal_waiter(&bridge).await;
    bridge
        .handle_response(json!({
            "id": request_id,
            "result": {
                "data": [
                    { "cwd": workspace, "updatedAt": 10 },
                    { "cwd": backend_context.root.join("workspace/."), "updatedAt": 20 },
                    { "cwd": backend_context.root, "updatedAt": 5 },
                    { "cwd": outside, "updatedAt": 99 },
                    { "updatedAt": 100 },
                    "invalid"
                ]
            }
        }))
        .await;
    let workspaces = task.await.unwrap().unwrap();
    assert_eq!(workspaces["allowOutsideRootCwd"], false);
    assert_eq!(workspaces["workspaces"][0]["chatCount"], 2);
    assert_eq!(workspaces["workspaces"][0]["updatedAt"], 20);
    assert_eq!(workspaces["workspaces"].as_array().unwrap().len(), 2);
    let _ = std_fs::remove_dir_all(outside);
}

#[tokio::test]
async fn git_rpc_methods_operate_on_a_real_repository_and_validate_inputs() {
    let context = SurfaceContext::new(true, false).await;
    run_git(&context.root, &["init", "-b", "main"]);
    run_git(&context.root, &["config", "user.name", "Surface Test"]);
    run_git(
        &context.root,
        &["config", "user.email", "surface@example.com"],
    );
    std_fs::write(context.root.join("tracked.txt"), b"initial\n").unwrap();
    run_git(&context.root, &["add", "tracked.txt"]);
    run_git(&context.root, &["commit", "-m", "initial"]);
    run_git(&context.root, &["branch", "feature"]);

    let call = |method: &'static str, params: Value| {
        let state = context.state.clone();
        async move { handle_bridge_method(method, Some(params), &state, 3).await }
    };

    let status = call("bridge/git/status", json!({})).await.unwrap();
    assert_eq!(status["clean"], true);
    assert_eq!(status["branch"], "main");
    let history = call("bridge/git/history", json!({ "limit": 100 }))
        .await
        .unwrap();
    assert_eq!(history["commits"][0]["subject"], "initial");
    let branches = call("bridge/git/branches", json!({})).await.unwrap();
    assert_eq!(branches["current"], "main");

    std_fs::write(context.root.join("tracked.txt"), b"changed\n").unwrap();
    std_fs::write(context.root.join("new.txt"), b"new\n").unwrap();
    let diff = call("bridge/git/diff", json!({})).await.unwrap();
    assert!(diff["diff"].as_str().unwrap().contains("changed"));
    assert!(diff["diff"].as_str().unwrap().contains("new.txt"));

    assert_eq!(
        call("bridge/git/stage", json!({ "path": "new.txt" }))
            .await
            .unwrap()["staged"],
        true
    );
    assert_eq!(
        call("bridge/git/unstage", json!({ "path": "new.txt" }))
            .await
            .unwrap()["unstaged"],
        true
    );
    assert_eq!(
        call("bridge/git/stageAll", json!({})).await.unwrap()["staged"],
        true
    );
    assert_eq!(
        call("bridge/git/unstageAll", json!({})).await.unwrap()["unstaged"],
        true
    );
    call("bridge/git/stageAll", json!({})).await.unwrap();
    assert_eq!(
        call("bridge/git/commit", json!({ "message": "surface changes" }))
            .await
            .unwrap()["committed"],
        true
    );
    assert_eq!(
        call("bridge/git/switch", json!({ "branch": "feature" }))
            .await
            .unwrap()["switched"],
        true
    );
    assert_eq!(
        call("bridge/git/push", json!({})).await.unwrap()["pushed"],
        false
    );

    for (method, params, message) in [
        (
            "bridge/git/clone",
            json!({ "url": "", "directoryName": "repo" }),
            "url",
        ),
        (
            "bridge/git/clone",
            json!({ "url": "https://example.com/repo.git", "directoryName": "" }),
            "directoryName",
        ),
        ("bridge/git/stage", json!({ "path": "" }), "path"),
        ("bridge/git/unstage", json!({ "path": "" }), "path"),
        ("bridge/git/commit", json!({ "message": "" }), "message"),
        ("bridge/git/switch", json!({ "branch": "" }), "branch"),
    ] {
        let error = call(method, params).await.unwrap_err();
        assert_eq!(error.code, -32602);
        assert!(error.message.contains(message));
    }
}

#[tokio::test]
async fn preview_route_bootstraps_cookie_serves_runtime_and_rejects_missing_sessions() {
    let context = SurfaceContext::new(true, false).await;
    let upstream = start_upstream().await;
    let (bootstrap_path, _, _) = preview_session_path(&context, &upstream.url("/html")).await;
    let server = serve(build_preview_router(context.state.clone())).await;
    let client = http_client();

    let runtime = client
        .get(server.url(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH))
        .send()
        .await
        .expect("runtime script");
    assert_eq!(runtime.status(), reqwest::StatusCode::OK);
    assert!(runtime.headers()[CONTENT_TYPE.as_str()]
        .to_str()
        .unwrap()
        .starts_with("application/javascript"));
    assert!(runtime
        .text()
        .await
        .unwrap()
        .contains("toProxyWebSocketUrl"));

    let missing = client
        .get(server.url("/html"))
        .send()
        .await
        .expect("missing preview session");
    assert_eq!(missing.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(missing.text().await.unwrap().contains("session is missing"));

    let bad = client
        .get(server.url("/html?sid=missing&st=bad"))
        .send()
        .await
        .expect("invalid preview session");
    assert_eq!(bad.status(), reqwest::StatusCode::UNAUTHORIZED);

    let bootstrap = client
        .get(server.url(&bootstrap_path))
        .send()
        .await
        .expect("preview bootstrap");
    assert_eq!(bootstrap.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(bootstrap.headers()[LOCATION.as_str()], "/html");
    assert_eq!(
        bootstrap.headers()[CACHE_CONTROL.as_str()],
        "no-store, private"
    );
    assert_eq!(bootstrap.headers()[REFERRER_POLICY.as_str()], "no-referrer");
    let cookie = cookie_pair(&bootstrap, BROWSER_PREVIEW_COOKIE_NAME);

    let document = client
        .get(server.url("/html"))
        .header(COOKIE.as_str(), cookie)
        .send()
        .await
        .expect("proxied document");
    assert_eq!(document.status(), reqwest::StatusCode::OK);
    assert_eq!(
        document.headers()[CACHE_CONTROL.as_str()],
        "no-store, private"
    );
    assert_eq!(document.headers()[VARY.as_str()], "Accept-Encoding, Cookie");
    assert!(document.headers().get(ETAG.as_str()).is_none());
    assert!(document.headers().get(LAST_MODIFIED.as_str()).is_none());
    let backend_cookie = document
        .headers()
        .get(SET_COOKIE.as_str())
        .unwrap()
        .to_str()
        .unwrap();
    assert!(!backend_cookie.to_ascii_lowercase().contains("domain="));
    let document = document.text().await.unwrap();
    assert!(document.contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH));
    assert_eq!(
        document
            .matches(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH)
            .count(),
        1
    );
}

#[tokio::test]
async fn preview_proxy_rewrites_requests_redirects_cookies_and_encoded_responses() {
    let context = SurfaceContext::new(true, false).await;
    let upstream = start_upstream().await;
    let (_, _, token) = preview_session_path(&context, &upstream.url("/")).await;
    let server = serve(build_preview_router(context.state.clone())).await;
    let client = http_client();
    let preview_cookie = format!(
        "{BROWSER_PREVIEW_COOKIE_NAME}={token}; {BROWSER_PREVIEW_VIEWPORT_COOKIE_NAME}=mobile; app=kept"
    );

    let echo = client
        .post(server.url("/echo?keep=yes"))
        .header(COOKIE.as_str(), &preview_cookie)
        .header(ORIGIN.as_str(), server.url(""))
        .header(
            REFERER.as_str(),
            server.url("/source?sid=secret&st=secret&keep=1"),
        )
        .body("request-body")
        .send()
        .await
        .expect("proxied echo");
    assert_eq!(echo.status(), reqwest::StatusCode::OK);
    let echo = response_json(echo).await;
    assert_eq!(echo["method"], "POST");
    assert_eq!(echo["body"], "request-body");
    assert_eq!(echo["path"], "/echo?keep=yes");
    assert_eq!(echo["cookie"], "app=kept");
    assert_eq!(echo["origin"], format!("http://{}", upstream.address));
    let referer = echo["referer"].as_str().unwrap();
    assert!(referer.starts_with(&format!("http://{}/source", upstream.address)));
    assert!(referer.contains("keep=1"));
    assert!(!referer.contains("sid="));

    let redirect = client
        .get(server.url("/redirect"))
        .header(
            COOKIE.as_str(),
            format!("{BROWSER_PREVIEW_COOKIE_NAME}={token}"),
        )
        .send()
        .await
        .expect("proxied redirect");
    assert_eq!(redirect.status(), reqwest::StatusCode::FOUND);
    assert_eq!(
        redirect.headers()[LOCATION.as_str()],
        format!("http://{}/signed-in?from=preview#top", server.address)
    );
    let cookie = redirect.headers()[SET_COOKIE.as_str()].to_str().unwrap();
    assert_eq!(cookie, "backend=ok; HttpOnly");

    let encoded = client
        .get(server.url("/encoded"))
        .header(
            COOKIE.as_str(),
            format!("{BROWSER_PREVIEW_COOKIE_NAME}={token}"),
        )
        .send()
        .await
        .expect("encoded response");
    assert_eq!(encoded.headers()[CONTENT_ENCODING.as_str()], "gzip");
    let bytes = encoded.bytes().await.expect("encoded body bytes");
    assert!(!String::from_utf8_lossy(&bytes).contains(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH));

    let second_upstream = start_upstream().await;
    let proxy_token =
        encode_preview_proxy_origin_token(&format!("http://{}", second_upstream.address));
    let proxy_prefix = format!("{BROWSER_PREVIEW_PROXY_PREFIX}/{proxy_token}");
    let proxied = client
        .get(server.url(&format!("{proxy_prefix}/redirect")))
        .header(
            COOKIE.as_str(),
            format!("{BROWSER_PREVIEW_COOKIE_NAME}={token}"),
        )
        .send()
        .await
        .expect("secondary proxy redirect");
    assert_eq!(proxied.status(), reqwest::StatusCode::FOUND);
    assert_eq!(
        proxied.headers()[LOCATION.as_str()],
        format!(
            "http://{}{proxy_prefix}/signed-in?from=preview#top",
            server.address
        )
    );
    assert_eq!(
        proxied.headers()[SET_COOKIE.as_str()],
        format!("backend=ok; HttpOnly; Path={proxy_prefix}/")
    );
}

#[tokio::test]
async fn preview_route_reports_proxy_target_upstream_limit_and_websocket_errors() {
    let context = SurfaceContext::new(true, false).await;
    let upstream = start_upstream().await;
    let (_, _, token) = preview_session_path(&context, &upstream.url("/")).await;
    let server = serve(build_preview_router(context.state.clone())).await;
    let client = http_client();
    let cookie = format!("{BROWSER_PREVIEW_COOKIE_NAME}={token}");

    let invalid_proxy = client
        .get(server.url(&format!("{BROWSER_PREVIEW_PROXY_PREFIX}/not-base64/path")))
        .header(COOKIE.as_str(), &cookie)
        .send()
        .await
        .expect("invalid proxy target");
    assert_eq!(invalid_proxy.status(), reqwest::StatusCode::BAD_REQUEST);
    assert!(invalid_proxy
        .text()
        .await
        .unwrap()
        .contains("invalid preview request path"));

    let too_large = client
        .get(server.url("/too-large"))
        .header(COOKIE.as_str(), &cookie)
        .send()
        .await
        .expect("declared large response");
    assert_eq!(too_large.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);

    let unreachable_context = SurfaceContext::new(true, false).await;
    let closed_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("reserve closed port");
    let closed_address = closed_listener.local_addr().unwrap();
    drop(closed_listener);
    let (_, _, unreachable_token) =
        preview_session_path(&unreachable_context, &format!("http://{closed_address}/")).await;
    let unreachable_server = serve(build_preview_router(unreachable_context.state.clone())).await;
    let bad_gateway = client
        .get(unreachable_server.url("/"))
        .header(
            COOKIE.as_str(),
            format!("{BROWSER_PREVIEW_COOKIE_NAME}={unreachable_token}"),
        )
        .send()
        .await
        .expect("unreachable preview response");
    assert_eq!(bad_gateway.status(), reqwest::StatusCode::BAD_GATEWAY);

    let request = Request::builder()
        .method(Method::GET)
        .uri("/socket")
        .header(CONNECTION, "Upgrade")
        .header(UPGRADE, "websocket")
        .body(Body::empty())
        .unwrap();
    let missing_ws = preview_entry_handler(State(context.state.clone()), request).await;
    assert_eq!(missing_ws.status(), StatusCode::UNAUTHORIZED);

    let request = Request::builder()
        .method(Method::GET)
        .uri("/socket")
        .header(CONNECTION, "keep-alive, Upgrade")
        .header(UPGRADE, "websocket")
        .header(
            COOKIE,
            format!("{BROWSER_PREVIEW_COOKIE_NAME}={unreachable_token}"),
        )
        .body(Body::empty())
        .unwrap();
    let websocket_error =
        preview_entry_handler(State(unreachable_context.state.clone()), request).await;
    assert_eq!(websocket_error.status(), StatusCode::BAD_GATEWAY);
}

#[tokio::test]
async fn preview_proxy_covers_shells_chunk_limits_request_limits_and_stream_failures() {
    let context = SurfaceContext::new(true, false).await;
    let upstream = start_upstream().await;
    let (bootstrap_path, _, token) = preview_session_path(&context, &upstream.url("/html")).await;
    let server = serve(build_preview_router(context.state.clone())).await;
    let client = http_client();
    let cookie = format!("{BROWSER_PREVIEW_COOKIE_NAME}={token}");

    for shell in ["desktop", "overview"] {
        let shell_path = format!("/html?shell={shell}&vp=desktop&vw=1280&vh=720");
        let response = client
            .get(server.url(&shell_path))
            .header(COOKIE.as_str(), &cookie)
            .send()
            .await
            .expect("preview shell response");
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body = response.text().await.unwrap();
        assert!(body.contains("<iframe"));
        assert!(body.contains("frame=1"));
    }

    let cookie_shell = client
        .get(server.url("/html?shell=desktop&vp=desktop&vw=1024"))
        .header(COOKIE.as_str(), &cookie)
        .send()
        .await
        .expect("cookie shell response");
    assert_eq!(cookie_shell.status(), reqwest::StatusCode::OK);
    assert!(cookie_shell.text().await.unwrap().contains("<iframe"));

    let raw_frame = client
        .get(server.url(&format!(
            "{bootstrap_path}&shell=desktop&frame=1&vp=desktop&vw=800"
        )))
        .send()
        .await
        .expect("raw preview frame");
    assert_eq!(raw_frame.status(), reqwest::StatusCode::OK);
    assert!(raw_frame
        .text()
        .await
        .unwrap()
        .contains("width=800, initial-scale=1"));

    let chunked_too_large = client
        .get(server.url("/chunked-too-large"))
        .header(COOKIE.as_str(), &cookie)
        .send()
        .await
        .expect("chunked oversized preview response");
    assert_eq!(
        chunked_too_large.status(),
        reqwest::StatusCode::PAYLOAD_TOO_LARGE
    );

    let broken = client
        .get(server.url("/broken-html"))
        .header(COOKIE.as_str(), &cookie)
        .send()
        .await
        .expect("broken preview response");
    assert_eq!(broken.status(), reqwest::StatusCode::BAD_GATEWAY);
    assert!(!broken.text().await.unwrap().is_empty());
}

#[tokio::test]
#[allow(clippy::result_large_err)]
async fn preview_websocket_proxy_forwards_protocol_text_binary_ping_and_close() {
    let upstream_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_address = upstream_listener.local_addr().unwrap();
    let upstream_task = tokio::spawn(async move {
        let (stream, _) = upstream_listener.accept().await.unwrap();
        let mut cookie = None;
        let mut origin = None;
        let mut socket = tokio_tungstenite::accept_hdr_async(
            stream,
            |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
             mut response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                cookie = request
                    .headers()
                    .get("cookie")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                origin = request
                    .headers()
                    .get("origin")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                response.headers_mut().insert(
                    "sec-websocket-protocol",
                    "surface-protocol".parse().unwrap(),
                );
                Ok(response)
            },
        )
        .await
        .unwrap();
        assert_eq!(cookie.as_deref(), Some("app=kept"));
        assert_eq!(
            origin.as_deref(),
            Some(format!("http://{upstream_address}").as_str())
        );

        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            UpstreamWsMessage::Text("hello".into())
        );
        socket
            .send(UpstreamWsMessage::Text("reply".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            UpstreamWsMessage::Binary(Bytes::from_static(b"client-bytes"))
        );
        socket
            .send(UpstreamWsMessage::Binary(Bytes::from_static(
                b"server-bytes",
            )))
            .await
            .unwrap();
        socket
            .send(UpstreamWsMessage::Ping(Bytes::from_static(b"ping")))
            .await
            .unwrap();
        socket.close(None).await.unwrap();
    });

    let context = SurfaceContext::new(true, false).await;
    let (_, _, token) =
        preview_session_path(&context, &format!("http://{upstream_address}/socket")).await;
    let server = serve(build_preview_router(context.state.clone())).await;
    let mut request = format!("ws://{}/socket", server.address)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        COOKIE,
        format!("{BROWSER_PREVIEW_COOKIE_NAME}={token}; app=kept")
            .parse()
            .unwrap(),
    );
    request
        .headers_mut()
        .insert(ORIGIN, server.url("").parse().unwrap());
    request.headers_mut().insert(
        "sec-websocket-protocol",
        "surface-protocol".parse().unwrap(),
    );
    let (mut socket, response) = connect_async(request).await.unwrap();
    assert_eq!(
        response.headers()["sec-websocket-protocol"],
        "surface-protocol"
    );
    socket
        .send(UpstreamWsMessage::Text("hello".into()))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        UpstreamWsMessage::Text("reply".into())
    );
    socket
        .send(UpstreamWsMessage::Binary(Bytes::from_static(
            b"client-bytes",
        )))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        UpstreamWsMessage::Binary(Bytes::from_static(b"server-bytes"))
    );
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        UpstreamWsMessage::Ping(Bytes::from_static(b"ping"))
    );
    let _ = socket.next().await;
    upstream_task.await.unwrap();
}

#[test]
fn preview_rewrite_helpers_cover_html_headers_cookies_locations_and_targets() {
    let mut headers = HeaderMap::new();
    assert!(!should_rewrite_preview_html_response(&headers));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    assert!(!should_rewrite_preview_html_response(&headers));
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/xhtml+xml; charset=utf-8"),
    );
    assert!(should_rewrite_preview_html_response(&headers));
    headers.insert(CONTENT_ENCODING, HeaderValue::from_static("identity"));
    assert!(should_rewrite_preview_html_response(&headers));
    headers.insert(CONTENT_ENCODING, HeaderValue::from_static("br"));
    assert!(!should_rewrite_preview_html_response(&headers));

    assert!(rewrite_preview_html_document(
        &vec![b'a'; PREVIEW_BUFFERED_RESPONSE_MAX_BYTES + 1],
        None
    )
    .is_none());
    assert!(rewrite_preview_html_document(&[0xff, 0xfe], None).is_none());
    let already_injected = format!(
        "<html><head><script src=\"{BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH}\"></script></head></html>"
    );
    let rewritten = rewrite_preview_html_document(already_injected.as_bytes(), None).unwrap();
    assert_eq!(
        String::from_utf8(rewritten)
            .unwrap()
            .matches(BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH)
            .count(),
        1
    );
    assert!(inject_preview_head_markup("<body>x</body>", "<meta x>").starts_with("<meta x>"));
    assert!(inject_preview_viewport_meta(
        "<html><head><meta name='viewport' content='old'></head></html>",
        "width=800"
    )
    .contains("content=\"width=800\""));

    let cookies = HeaderValue::from_static(
        "clawdex_preview=secret; clawdex_preview_vp=desktop; app=one; theme=dark",
    );
    assert_eq!(
        filter_preview_cookie_header(&cookies).unwrap(),
        "app=one; theme=dark"
    );
    assert!(filter_preview_cookie_header(&HeaderValue::from_static(
        "clawdex_preview=secret; clawdex_preview_vp=mobile"
    ))
    .is_none());
    assert!(rewrite_preview_set_cookie_header(&HeaderValue::from_static(""), None).is_none());
    assert_eq!(
        rewrite_preview_set_cookie_header(
            &HeaderValue::from_static("a=b; Path=relative; Secure"),
            Some("/proxy")
        )
        .unwrap(),
        "a=b; Path=/proxy/relative; Secure"
    );

    let current = Url::parse("http://127.0.0.1:3000/a/b").unwrap();
    assert_eq!(
        rewrite_preview_location_header(
            &HeaderValue::from_static("https://example.com/elsewhere"),
            &current,
            Some("preview.test"),
            None
        )
        .unwrap(),
        "https://example.com/elsewhere"
    );
    assert!(rewrite_preview_location_header(
        &HeaderValue::from_static("/same"),
        &current,
        None,
        None
    )
    .is_none());

    let direct = resolve_preview_request_target(&current, "/path?q=1").unwrap();
    assert_eq!(direct.path_and_query, "/path?q=1");
    assert!(direct.proxy_path_prefix.is_none());
    assert!(resolve_preview_request_target(
        &current,
        &format!("{BROWSER_PREVIEW_PROXY_PREFIX}//path")
    )
    .is_err());
    assert!(decode_preview_proxy_origin_token(
        &general_purpose::URL_SAFE_NO_PAD.encode("https://example.com")
    )
    .is_err());
    assert_eq!(
        build_preview_upstream_url(&current, "/socket?q=1", true)
            .unwrap()
            .as_str(),
        "ws://127.0.0.1:3000/socket?q=1"
    );

    let mut vary = HeaderMap::new();
    append_vary_header_value(&mut vary, "");
    assert!(vary.get(VARY).is_none());
    append_vary_header_value(&mut vary, "Cookie");
    append_vary_header_value(&mut vary, "cookie");
    assert_eq!(vary[VARY], "Cookie");
    append_vary_header_value(&mut vary, "Origin");
    assert_eq!(vary[VARY], "Cookie, Origin");

    assert!(should_skip_preview_request_header("HOST"));
    assert!(!should_skip_preview_request_header("x-app"));
    assert!(should_skip_preview_websocket_request_header(
        "sec-websocket-key"
    ));
    assert!(should_skip_preview_response_header("transfer-encoding"));
    assert!(is_websocket_upgrade_request(
        &Method::GET,
        &HeaderMap::from_iter([
            (CONNECTION, HeaderValue::from_static("keep-alive, Upgrade")),
            (UPGRADE, HeaderValue::from_static("WebSocket")),
        ])
    ));
    assert!(!is_websocket_upgrade_request(
        &Method::POST,
        &HeaderMap::new()
    ));
}

#[tokio::test]
async fn github_auth_helpers_normalize_grants_write_private_credentials_and_reject_empty_install() {
    assert_eq!(
        parse_github_oauth_scopes(Some(" repo, READ:ORG, public_repo,  ")),
        vec!["repo", "read:org", "public_repo"]
    );
    assert!(github_scopes_allow_repo_access(
        &["public_repo".to_string()]
    ));
    assert!(!github_scopes_allow_repo_access(&["read:org".to_string()]));
    assert!(github_token_can_be_used_for_git_auth(&[]));
    assert!(!github_token_can_be_used_for_git_auth(
        &["gist".to_string()]
    ));

    let normalized = normalize_github_auth_repositories(&[
        " Zoo/Repo ".to_string(),
        "/alpha/One/".to_string(),
        "zoo/repo".to_string(),
        "invalid".to_string(),
        "too/many/parts".to_string(),
        "/missing".to_string(),
    ]);
    assert_eq!(normalized, vec!["alpha/One", "Zoo/Repo"]);

    let grants = resolve_github_auth_grants(GitHubAuthInstallRequest {
        access_token: Some(" token-one ".to_string()),
        repositories: Some(vec!["Owner/Repo".to_string(), "owner/repo".to_string()]),
        grants: None,
    })
    .unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].access_token, "token-one");
    assert_eq!(grants[0].repositories, vec!["Owner/Repo"]);

    let multi = resolve_github_auth_grants(GitHubAuthInstallRequest {
        access_token: Some("ignored-legacy".to_string()),
        repositories: Some(vec!["ignored/repo".to_string()]),
        grants: Some(vec![
            GitHubAuthGrantInput {
                access_token: " ".to_string(),
                repositories: Some(vec!["skip/token".to_string()]),
            },
            GitHubAuthGrantInput {
                access_token: "token-two".to_string(),
                repositories: Some(vec!["valid/two".to_string()]),
            },
            GitHubAuthGrantInput {
                access_token: "token-three".to_string(),
                repositories: Some(vec!["invalid".to_string()]),
            },
        ]),
    })
    .unwrap();
    assert_eq!(multi.len(), 1);
    assert_eq!(multi[0].access_token, "token-two");

    let root = env::temp_dir().join(format!("clawdex-github-surface-{}", Uuid::new_v4()));
    let credentials = root.join("nested/github-credentials");
    ensure_private_parent_dir(&credentials)
        .await
        .expect("private credentials parent");
    write_github_credentials_file(&credentials, &grants)
        .await
        .expect("write credentials");
    let contents = std_fs::read_to_string(&credentials).unwrap();
    assert_eq!(
        contents,
        "https://x-access-token:token-one@github.com/Owner/Repo\nhttps://x-access-token:token-one@github.com/Owner/Repo.git\n"
    );
    #[cfg(unix)]
    {
        assert_eq!(
            std_fs::metadata(credentials.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std_fs::metadata(&credentials).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let _ = std_fs::remove_dir_all(root);

    let context = SurfaceContext::new(true, false).await;
    let error = install_github_git_auth(
        &context.state,
        GitHubAuthInstallRequest {
            access_token: None,
            repositories: None,
            grants: None,
        },
    )
    .await
    .expect_err("empty install should fail before network access");
    assert_eq!(error.code, -32602);
    assert!(error.message.contains("At least one"));
    assert_eq!(
        fetch_github_viewer(" ")
            .await
            .expect_err("empty token")
            .code,
        -32602
    );
}

#[tokio::test]
async fn error_pairing_and_shutdown_utilities_cover_safe_branches() {
    let invalid = bridge_error_http_response(BridgeError::invalid_params("bad upload"));
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        to_bytes(invalid.into_body(), 1024).await.unwrap(),
        r#"{"error":"invalid_upload","message":"bad upload"}"#
    );
    let limited = bridge_error_http_response(BridgeError::resource_limit("bytes", 3, 4));
    assert_eq!(limited.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let limited: Value =
        serde_json::from_slice(&to_bytes(limited.into_body(), 1024).await.unwrap()).unwrap();
    assert_eq!(limited["resource"], "bytes");
    assert_eq!(limited["actual"], 4);
    let server = bridge_error_http_response(BridgeError::server("disk unavailable"));
    assert_eq!(server.status(), StatusCode::INTERNAL_SERVER_ERROR);

    let context = SurfaceContext::new(true, false).await;
    let mut config = context.state.config.as_ref().clone();
    config.host = "::1".to_string();
    config.port = 8787;
    assert_eq!(
        bridge_access_url(&config).as_deref(),
        Some("http://[::1]:8787")
    );
    let payload: Value = serde_json::from_str(&build_pairing_payload(&config).unwrap()).unwrap();
    assert_eq!(payload["bridgeToken"], TEST_TOKEN);
    assert_eq!(payload["bridgeUrl"], "http://[::1]:8787");
    config.host = "[::]".to_string();
    assert!(bridge_access_url(&config).is_none());
    assert!(build_pairing_payload(&config).is_none());
    assert!(build_token_only_pairing_payload(&config).is_some());
    config.auth_token = None;
    assert!(build_token_only_pairing_payload(&config).is_none());
    maybe_print_pairing_qr(&config);
    flush_pairing_output();

    // Exercise maybe_print_pairing_qr with show_pairing_qr=true and a valid config
    // (has auth_token + connectable URL): prints a full pairing QR.
    let mut qr_config = context.state.config.as_ref().clone();
    qr_config.show_pairing_qr = true;
    qr_config.host = "127.0.0.1".to_string();
    qr_config.port = 9898;
    maybe_print_pairing_qr(&qr_config);
    flush_pairing_output();

    // Exercise the fallback token-only QR branch: show_pairing_qr=true but
    // the bind URL != connect_url (wildcard host makes pairing URL unavailable).
    qr_config.host = "[::]".to_string();
    qr_config.auth_token = Some("qr-token".to_string());
    maybe_print_pairing_qr(&qr_config);
    flush_pairing_output();

    let (tx, mut rx) = watch::channel(true);
    wait_for_shutdown_trigger(&mut rx).await;
    let (tx2, mut rx2) = watch::channel(false);
    let waiter = tokio::spawn(async move {
        wait_for_shutdown_trigger(&mut rx2).await;
    });
    tx2.send(false).unwrap();
    tokio::task::yield_now().await;
    assert!(!waiter.is_finished());
    tx2.send(true).unwrap();
    timeout(Duration::from_secs(1), waiter)
        .await
        .expect("shutdown waiter timeout")
        .expect("shutdown waiter task");
    drop(tx);
    let (tx3, mut rx3) = watch::channel(false);
    drop(tx3);
    wait_for_shutdown_trigger(&mut rx3).await;

    terminate_managed_child(0, "surface-test").await;
    #[cfg(unix)]
    terminate_process_group_unix(0, "surface-test").await;
}

#[tokio::test]
async fn remaining_bridge_handlers_cover_dedupe_validation_and_resolution_branches() {
    let context = SurfaceContext::new(true, false).await;
    let state = &context.state;

    for (method, params, expected) in [
        (
            "bridge/ui/dismiss",
            json!({ "id": "" }),
            "id must not be empty",
        ),
        (
            "bridge/ui/resolve",
            json!({ "id": "", "threadId": "thread", "actionId": "go" }),
            "id must not be empty",
        ),
        (
            "bridge/ui/resolve",
            json!({ "id": "surface", "threadId": "thread", "actionId": "" }),
            "actionid must not be empty",
        ),
        (
            "bridge/thread/create",
            json!({ "submissionId": "  ", "threadStart": {} }),
            "submissionid must not be empty",
        ),
        (
            "bridge/thread/create",
            json!({ "submissionId": "outside", "threadStart": { "cwd": "../" } }),
            "bridge_workdir",
        ),
        (
            "bridge/thread/list/stream/cancel",
            json!({ "streamId": "  " }),
            "streamid must not be empty",
        ),
    ] {
        let error = handle_bridge_method(method, Some(params), state, 9)
            .await
            .expect_err("invalid bridge request");
        assert_eq!(error.code, -32602);
        assert!(error.message.to_ascii_lowercase().contains(expected));
    }

    let oversized_content = handle_bridge_method(
        "bridge/thread/queue/send",
        Some(json!({
            "threadId": "thread",
            "submissionId": "content-limit",
            "content": "x".repeat(QUEUE_MAX_CONTENT_BYTES + 1),
            "turnStart": {}
        })),
        state,
        9,
    )
    .await
    .expect_err("queue content limit");
    assert_eq!(
        oversized_content.data.unwrap()["resource"],
        "queue_content_bytes"
    );

    let oversized_item = handle_bridge_method(
        "bridge/thread/queue/send",
        Some(json!({
            "threadId": "thread",
            "submissionId": "item-limit",
            "content": "small",
            "turnStart": { "payload": "x".repeat(QUEUE_MAX_ITEM_BYTES) }
        })),
        state,
        9,
    )
    .await
    .expect_err("queue item limit");
    assert_eq!(oversized_item.data.unwrap()["resource"], "queue_item_bytes");

    for resolution_id in [" ".to_string(), "x".repeat(PUSH_ID_MAX_BYTES + 1)] {
        let error = handle_bridge_method(
            "bridge/approvals/resolve",
            Some(json!({
                "id": "approval",
                "decision": "accept",
                "resolutionId": resolution_id
            })),
            state,
            9,
        )
        .await
        .expect_err("invalid resolution id");
        assert_eq!(error.code, -32602);
    }
    for decision in [json!(null), json!("later"), json!({ "unexpected": true })] {
        let error = handle_bridge_method(
            "bridge/approvals/resolve",
            Some(json!({
                "id": "approval",
                "decision": decision,
                "resolutionId": "invalid-decision"
            })),
            state,
            9,
        )
        .await
        .expect_err("invalid approval decision");
        assert_eq!(error.code, -32602);
    }
    let missing_approval = handle_bridge_method(
        "bridge/approvals/resolve",
        Some(json!({
            "id": "missing",
            "decision": "accept",
            "resolutionId": "missing-approval"
        })),
        state,
        9,
    )
    .await
    .expect_err("missing approval");
    assert_eq!(missing_approval.code, -32004);

    let cached_approval = json!({
        "ok": true,
        "approval": { "id": "approval-1" },
        "decision": "decline",
        "resolutionId": "cached-resolution"
    });
    state
        .approval_resolution_results
        .lock()
        .await
        .insert("cached-resolution".to_string(), cached_approval.clone());
    let cached = handle_bridge_method(
        "bridge/approvals/resolve",
        Some(json!({
            "id": "approval-1",
            "decision": "decline",
            "resolutionId": " cached-resolution "
        })),
        state,
        9,
    )
    .await
    .expect("cached approval resolution");
    assert_eq!(cached, cached_approval);
    let rebound = handle_bridge_method(
        "bridge/approvals/resolve",
        Some(json!({
            "id": "approval-2",
            "decision": "decline",
            "resolutionId": "cached-resolution"
        })),
        state,
        9,
    )
    .await
    .expect_err("resolution id rebound");
    assert_eq!(rebound.code, -32602);

    for answers in [
        json!({}),
        json!({ " ": { "answers": ["yes"] } }),
        json!({ "question": { "answers": [] } }),
        json!({ "question": { "answers": [" "] } }),
    ] {
        let error = handle_bridge_method(
            "bridge/userInput/resolve",
            Some(json!({ "id": "request", "answers": answers })),
            state,
            9,
        )
        .await
        .expect_err("invalid user input answers");
        assert_eq!(error.code, -32602);
    }
    let missing_input = handle_bridge_method(
        "bridge/userInput/resolve",
        Some(json!({
            "id": "missing",
            "answers": { "question": { "answers": ["yes"] } }
        })),
        state,
        9,
    )
    .await
    .expect_err("missing user input");
    assert_eq!(missing_input.code, -32004);

    assert_eq!(
        handle_bridge_method("bridge/unknown/surface", None, state, 9)
            .await
            .expect_err("unknown method")
            .code,
        -32601
    );

    let (backend_context, bridge) = SurfaceContext::with_app_server().await;
    let create_state = backend_context.state.clone();
    let create = tokio::spawn(async move {
        handle_bridge_method(
            "bridge/thread/create",
            Some(json!({
                "submissionId": " create-once ",
                "threadStart": { "cwd": "." }
            })),
            &create_state,
            11,
        )
        .await
    });
    let request_id = wait_for_internal_waiter(&bridge).await;
    bridge
        .handle_response(json!({
            "id": request_id,
            "result": { "thread": { "id": "thread-created" } }
        }))
        .await;
    let created = create.await.unwrap().unwrap();
    assert_eq!(created["submissionId"], "create-once");
    assert_eq!(created["thread"]["id"], "codex:thread-created");
    let duplicate = handle_bridge_method(
        "bridge/thread/create",
        Some(json!({
            "submissionId": "create-once",
            "threadStart": { "cwd": "missing-and-never-normalized" }
        })),
        &backend_context.state,
        11,
    )
    .await
    .expect("deduplicated thread create");
    assert_eq!(duplicate, created);

    bridge.pending_approvals.lock().await.insert(
        "approval-live".to_string(),
        PendingApprovalEntry {
            app_server_request_id: json!(41),
            response_format: ApprovalResponseFormat::Modern,
            approval: PendingApproval {
                id: "approval-live".to_string(),
                kind: "command".to_string(),
                thread_id: "thread-created".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "item-1".to_string(),
                requested_at: now_iso(),
                reason: None,
                command: Some("pwd".to_string()),
                cwd: Some(path_to_string(&backend_context.root)),
                grant_root: None,
                proposed_execpolicy_amendment: None,
            },
        },
    );
    let resolved = handle_bridge_method(
        "bridge/approvals/resolve",
        Some(json!({
            "id": "approval-live",
            "decision": "acceptForSession",
            "resolutionId": "live-resolution"
        })),
        &backend_context.state,
        11,
    )
    .await
    .expect("resolve live approval");
    assert_eq!(resolved["ok"], true);
    assert_eq!(resolved["decision"], "acceptForSession");

    bridge.pending_user_inputs.lock().await.insert(
        "input-live".to_string(),
        PendingUserInputEntry {
            app_server_request_id: json!(42),
            request: PendingUserInputRequest {
                id: "input-live".to_string(),
                thread_id: "thread-created".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "item-2".to_string(),
                requested_at: now_iso(),
                questions: Vec::new(),
            },
        },
    );
    let input = handle_bridge_method(
        "bridge/userInput/resolve",
        Some(json!({
            "id": "input-live",
            "answers": { "question": { "answers": ["yes"] } }
        })),
        &backend_context.state,
        11,
    )
    .await
    .expect("resolve live user input");
    assert_eq!(input["request"]["id"], "input-live");
}

#[tokio::test]
async fn thread_list_stream_helpers_cover_defaults_clamps_replacement_and_cleanup() {
    assert_eq!(
        normalize_thread_list_stream_limits(None),
        THREAD_LIST_STREAM_DEFAULT_LIMITS
    );
    assert_eq!(
        normalize_thread_list_stream_limits(Some(Vec::new())),
        THREAD_LIST_STREAM_DEFAULT_LIMITS
    );
    assert_eq!(
        normalize_thread_list_stream_limits(Some(vec![0, 1, 5, 5, usize::MAX])),
        vec![1, 5, THREAD_LIST_STREAM_MAX_LIMIT]
    );
    assert_eq!(
        normalize_thread_list_stream_id(Some(" stream ".into()), 7),
        "stream"
    );
    assert!(normalize_thread_list_stream_id(Some("  ".into()), 7).starts_with("thread-list-7-"));
    assert!(normalize_thread_list_stream_id(None, 8).starts_with("thread-list-8-"));
    assert_eq!(thread_list_stream_key(3, " stream "), "3:stream");

    let normal = thread_list_stream_request_params(false, 25);
    assert_eq!(normal["limit"], 25);
    assert!(!normal["sourceKinds"]
        .as_array()
        .unwrap()
        .contains(&json!("subAgent")));
    let sub_agents = thread_list_stream_request_params(true, 50);
    assert!(sub_agents["sourceKinds"]
        .as_array()
        .unwrap()
        .contains(&json!("subAgentReview")));

    let context = SurfaceContext::new(true, false).await;
    let previous = Arc::new(AtomicBool::new(false));
    context
        .state
        .thread_list_streams
        .lock()
        .await
        .insert("5:replace".to_string(), previous.clone());
    let started = start_thread_list_stream(
        &context.state,
        5,
        ThreadListStreamStartRequest {
            stream_id: Some(" replace ".to_string()),
            include_sub_agents: Some(true),
            limits: Some(vec![0, usize::MAX]),
            delay_ms: Some(THREAD_LIST_STREAM_MAX_DELAY_MS + 1),
        },
    )
    .await
    .unwrap();
    assert!(previous.load(Ordering::Relaxed));
    assert_eq!(started["streamId"], "replace");
    assert_eq!(started["limits"], json!([1, THREAD_LIST_STREAM_MAX_LIMIT]));
    assert_eq!(started["delayMs"], THREAD_LIST_STREAM_MAX_DELAY_MS);

    let cancellation = Arc::new(AtomicBool::new(false));
    context
        .state
        .thread_list_streams
        .lock()
        .await
        .insert("6:cancel".to_string(), cancellation.clone());
    let cancelled = cancel_thread_list_stream(&context.state, 6, " cancel ")
        .await
        .unwrap();
    assert_eq!(cancelled["cancelled"], true);
    assert!(cancellation.load(Ordering::Relaxed));
    assert_eq!(
        cancel_thread_list_stream(&context.state, 6, "missing")
            .await
            .unwrap()["cancelled"],
        false
    );

    let stopped = Arc::new(AtomicBool::new(true));
    context
        .state
        .thread_list_streams
        .lock()
        .await
        .insert("7:stopped".to_string(), stopped.clone());
    run_thread_list_stream(ThreadListStreamTask {
        state: context.state.clone(),
        client_id: 7,
        stream_id: "stopped".to_string(),
        stream_key: "7:stopped".to_string(),
        include_sub_agents: false,
        limits: vec![1],
        delay_ms: 0,
        cancellation: stopped,
    })
    .await;
    assert!(!context
        .state
        .thread_list_streams
        .lock()
        .await
        .contains_key("7:stopped"));

    let stale = Arc::new(AtomicBool::new(true));
    let replacement = Arc::new(AtomicBool::new(false));
    context
        .state
        .thread_list_streams
        .lock()
        .await
        .insert("8:stale".to_string(), replacement.clone());
    run_thread_list_stream(ThreadListStreamTask {
        state: context.state.clone(),
        client_id: 8,
        stream_id: "stale".to_string(),
        stream_key: "8:stale".to_string(),
        include_sub_agents: false,
        limits: vec![1],
        delay_ms: 0,
        cancellation: stale,
    })
    .await;
    assert!(Arc::ptr_eq(
        context
            .state
            .thread_list_streams
            .lock()
            .await
            .get("8:stale")
            .unwrap(),
        &replacement
    ));
}

#[tokio::test]
async fn early_routes_filesystem_limits_and_chatgpt_auth_cache_cover_remaining_paths() {
    let healthy_context = SurfaceContext::with_app_server().await.0;
    let healthy_server = serve(build_bridge_router(healthy_context.state.clone())).await;
    let healthy = http_client()
        .get(healthy_server.url("/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(healthy.status(), reqwest::StatusCode::OK);
    assert_ne!(response_json(healthy).await["status"], "unhealthy");

    let auth_context = SurfaceContext::new(true, true).await;
    let auth_server = serve(build_bridge_router(auth_context.state.clone())).await;
    let client = http_client();
    for authorization in ["Basic surface-test-token", "Bearer wrong", "Bearer a b"] {
        let response = client
            .get(auth_server.url("/status"))
            .header(AUTHORIZATION.as_str(), authorization)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }
    let lowercase_bearer = client
        .get(auth_server.url("/status"))
        .header(AUTHORIZATION.as_str(), format!("bearer {TEST_TOKEN}"))
        .send()
        .await
        .unwrap();
    assert_eq!(lowercase_bearer.status(), reqwest::StatusCode::OK);
    let trimmed_query = client
        .get(auth_server.url(&format!("/status?token=%20{TEST_TOKEN}%20")))
        .send()
        .await
        .unwrap();
    assert_eq!(trimmed_query.status(), reqwest::StatusCode::OK);

    let fs_context = SurfaceContext::new(true, false).await;
    for index in 0..=FILESYSTEM_LIST_MAX_ENTRIES {
        std_fs::write(fs_context.root.join(format!("entry-{index:04}")), b"x").unwrap();
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        fs_context.root.join("does-not-exist"),
        fs_context.root.join("broken-link"),
    )
    .unwrap();
    let listing = list_filesystem_entries(
        &fs_context.state,
        FileSystemListRequest {
            path: None,
            include_hidden: Some(true),
            directories_only: Some(false),
            include_git_repo: Some(true),
        },
    )
    .await
    .unwrap();
    assert!(listing.truncated);
    assert_eq!(listing.total_entries, FILESYSTEM_LIST_MAX_ENTRIES + 1);
    assert_eq!(listing.entries.len(), FILESYSTEM_LIST_MAX_ENTRIES);
    assert_eq!(listing.omitted_entries, 1);
    assert!(listing.entries.iter().all(|entry| !entry.is_git_repo));

    let auth_cache_scope = TestBridgeChatGptAuthCacheScope::new();
    let cache_path = auth_cache_scope.cache_path().to_path_buf();
    assert_eq!(
        resolve_bridge_chatgpt_auth_cache_path(),
        Some(cache_path.clone())
    );
    assert!(load_persisted_bridge_chatgpt_auth().is_none());
    std_fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
    std_fs::write(&cache_path, b"not-json").unwrap();
    assert!(load_persisted_bridge_chatgpt_auth().is_none());

    let persisted = BridgeChatGptAuthBundle {
        access_token: "persisted-token".to_string(),
        account_id: "persisted-account".to_string(),
        plan_type: None,
    };
    std_fs::write(&cache_path, serde_json::to_vec(&persisted).unwrap()).unwrap();
    assert_eq!(read_cached_bridge_chatgpt_auth(), Some(persisted));
    std_fs::remove_file(&cache_path).unwrap();
    assert!(read_cached_bridge_chatgpt_auth().is_some());

    let cached = BridgeChatGptAuthBundle {
        access_token: "cached-token".to_string(),
        account_id: "cached-account".to_string(),
        plan_type: Some("plus".to_string()),
    };
    cache_bridge_chatgpt_auth(cached.clone());
    assert_eq!(read_cached_bridge_chatgpt_auth(), Some(cached.clone()));
    assert_eq!(
        serde_json::from_slice::<BridgeChatGptAuthBundle>(&std_fs::read(&cache_path).unwrap())
            .unwrap(),
        cached
    );
    #[cfg(unix)]
    {
        assert_eq!(
            std_fs::metadata(cache_path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std_fs::metadata(&cache_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    clear_cached_bridge_chatgpt_auth();
    assert!(!cache_path.exists());

    for invalid in [
        None,
        Some(&json!(null)),
        Some(&json!({})),
        Some(&json!({ "type": "apiKey", "accessToken": "a", "chatgptAccountId": "b" })),
        Some(&json!({ "type": "chatgptAuthTokens", "accessToken": " ", "chatgptAccountId": "b" })),
    ] {
        assert!(extract_chatgpt_auth_tokens_from_account_login_start(invalid).is_none());
    }
    let tokens = extract_chatgpt_auth_tokens_from_account_login_start(Some(&json!({
        "type": "chatgptAuthTokens",
        "accessToken": " access ",
        "chatgptAccountId": " account ",
        "chatgptPlanType": " plus "
    })))
    .unwrap();
    assert_eq!(tokens.access_token, "access");
    assert_eq!(tokens.account_id, "account");
    assert_eq!(tokens.plan_type.as_deref(), Some("plus"));
    let no_plan = extract_chatgpt_auth_tokens_from_account_login_start(Some(&json!({
        "type": "chatgptAuthTokens",
        "accessToken": "access",
        "chatgptAccountId": "account",
        "chatgptPlanType": " "
    })))
    .unwrap();
    assert!(no_plan.plan_type.is_none());

    for callback in [
        "not a url",
        "https://localhost:1455/auth/callback",
        "http://example.com:1455/auth/callback",
        "http://localhost:1456/auth/callback",
        "http://localhost:1455/wrong",
    ] {
        assert_eq!(
            forward_codex_auth_callback(&auth_context.state, callback)
                .await
                .expect_err("invalid callback")
                .code,
            -32602
        );
    }
}

#[test]
fn preview_bootstrap_viewport_and_cookie_helpers_cover_all_match_arms() {
    assert_eq!(
        parse_preview_viewport_preset(" MOBILE "),
        Some(PreviewViewportPreset::Mobile)
    );
    assert_eq!(
        parse_preview_viewport_preset("desktop"),
        Some(PreviewViewportPreset::Desktop)
    );
    assert_eq!(parse_preview_viewport_preset("tablet"), None);
    assert_eq!(
        parse_preview_shell_mode(" DESKTOP "),
        Some(PreviewShellMode::Desktop)
    );
    assert_eq!(
        parse_preview_shell_mode("overview"),
        Some(PreviewShellMode::Overview)
    );
    assert_eq!(parse_preview_shell_mode("none"), None);

    assert_eq!(normalize_preview_viewport_dimension(None), None);
    assert_eq!(normalize_preview_viewport_dimension(Some("bad")), None);
    assert_eq!(normalize_preview_viewport_dimension(Some("319")), None);
    assert_eq!(normalize_preview_viewport_dimension(Some("4097")), None);
    assert_eq!(
        normalize_preview_viewport_dimension(Some(" 1024 ")),
        Some(1024)
    );
    assert!(build_preview_viewport_config(None, None, None).is_none());

    let mobile =
        build_preview_viewport_config(Some(PreviewViewportPreset::Mobile), Some(800), Some(600))
            .unwrap();
    assert_eq!(mobile.as_cookie_value(), "mobile");
    assert_eq!(mobile.viewport_meta_content(), None);
    assert_eq!(mobile.width, None);
    let desktop_default =
        build_preview_viewport_config(Some(PreviewViewportPreset::Desktop), None, None).unwrap();
    assert_eq!(desktop_default.as_cookie_value(), "desktop");
    let default_meta = desktop_default.viewport_meta_content().unwrap();
    assert!(default_meta.contains("width=1920"));
    assert!(default_meta.contains("height=1080"));
    let desktop_width = PreviewViewportConfig {
        preset: PreviewViewportPreset::Desktop,
        width: Some(1200),
        height: None,
    };
    assert_eq!(desktop_width.as_cookie_value(), "desktop:1200");
    assert!(!desktop_width
        .viewport_meta_content()
        .unwrap()
        .contains("height="));
    let desktop_both = PreviewViewportConfig {
        preset: PreviewViewportPreset::Desktop,
        width: Some(1200),
        height: Some(700),
    };
    assert_eq!(desktop_both.as_cookie_value(), "desktop:1200:700");
    assert!(desktop_both
        .viewport_meta_content()
        .unwrap()
        .contains("height=700"));

    let parsed = parse_preview_bootstrap_params(
        &"/page?sid=session&st=token&vp=desktop&vw=1200&vh=700&shell=overview&frame=1&keep=yes"
            .parse::<Uri>()
            .unwrap(),
    );
    assert_eq!(parsed.session_id.as_deref(), Some("session"));
    assert_eq!(parsed.bootstrap_token.as_deref(), Some("token"));
    assert_eq!(parsed.viewport, Some(desktop_both));
    assert_eq!(parsed.shell_mode, Some(PreviewShellMode::Overview));
    assert!(parsed.raw_frame);
    assert_eq!(
        parsed.sanitized_path_and_query,
        "/page?vp=desktop&vw=1200&vh=700&shell=overview&keep=yes"
    );
    let invalid = parse_preview_bootstrap_params(
        &"/page?vp=invalid&vw=12&vh=nope&shell=invalid&frame=0"
            .parse::<Uri>()
            .unwrap(),
    );
    assert!(invalid.viewport.is_none());
    assert!(invalid.shell_mode.is_none());
    assert!(!invalid.raw_frame);

    let redirect = preview_bootstrap_redirect_response("/next", "token", Some(desktop_both), true);
    assert_eq!(redirect.status(), StatusCode::TEMPORARY_REDIRECT);
    assert_eq!(redirect.headers()[LOCATION], "/next");
    let cookies = redirect
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(cookies.len(), 2);
    assert!(cookies[0].contains("Secure"));
    assert!(cookies[1].contains("desktop:1200:700"));
    let no_viewport = preview_bootstrap_redirect_response("/", "token", None, false);
    assert_eq!(no_viewport.headers().get_all(SET_COOKIE).iter().count(), 1);

    let mut response = Response::new(Body::empty());
    append_preview_bootstrap_headers(&mut response, None, None, false);
    assert!(response.headers().get(SET_COOKIE).is_none());
    append_preview_bootstrap_headers(&mut response, Some("token"), Some(mobile), false);
    assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 2);

    assert_eq!(
        build_preview_shell_frame_src("/page", None, None),
        "/page?frame=1"
    );
    assert_eq!(
        build_preview_shell_frame_src("/page?keep=1&shell=desktop&frame=0&sid=s&st=t", None, None),
        "/page?keep=1&frame=1"
    );
    assert_eq!(
        build_preview_shell_request_key(Some("session"), Some("token")),
        Some("session".to_string())
    );
    assert_eq!(build_preview_shell_request_key(None, Some("token")), None);

    assert!(build_preview_cookie_header("token\ninvalid", false).is_err());
    assert!(build_preview_viewport_cookie_header(desktop_both).is_ok());
    let mut headers = HeaderMap::new();
    assert_eq!(read_cookie_value(&headers, "wanted"), None);
    headers.insert(
        COOKIE,
        HeaderValue::from_static("bad; empty=; wanted = value ; other=x"),
    );
    assert_eq!(
        read_cookie_value(&headers, "wanted").as_deref(),
        Some("value")
    );
    assert_eq!(read_cookie_value(&headers, "empty"), None);

    assert!(parse_preview_viewport_cookie("").is_none());
    assert!(parse_preview_viewport_cookie("tablet").is_none());
    assert!(parse_preview_viewport_cookie("desktop:100:700").is_none());
    assert!(parse_preview_viewport_cookie("desktop:800:700:extra").is_none());
    assert_eq!(
        parse_preview_viewport_cookie("mobile:800:700"),
        Some(mobile)
    );
    assert_eq!(
        parse_preview_viewport_cookie("desktop:800").unwrap().width,
        Some(800)
    );
    assert_eq!(
        parse_preview_viewport_cookie("desktop::700")
            .unwrap()
            .height,
        Some(700)
    );
    headers.insert(
        COOKIE,
        HeaderValue::from_static("clawdex_preview_vp=desktop:1024:768"),
    );
    assert_eq!(
        read_preview_viewport_preset(&headers).unwrap().height,
        Some(768)
    );
}
