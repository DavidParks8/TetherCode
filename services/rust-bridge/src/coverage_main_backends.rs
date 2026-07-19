use super::*;

use tokio::task::JoinHandle;

// Tests for GitHub auth helpers, credential resolution, and related backend utilities.

#[test]
fn github_grant_resolution_covers_grants_access_token_and_empty_paths() {
    // grants array path
    let request = GitHubAuthInstallRequest {
        grants: Some(vec![
            GitHubAuthGrantInput {
                access_token: "  token-a  ".to_string(),
                repositories: Some(vec!["owner/repo-a".to_string()]),
            },
            GitHubAuthGrantInput {
                access_token: "".to_string(), // empty — skipped
                repositories: Some(vec!["owner/skip".to_string()]),
            },
            GitHubAuthGrantInput {
                access_token: "token-b".to_string(),
                repositories: Some(vec![]), // empty repos — skipped
            },
        ]),
        access_token: None,
        repositories: None,
    };
    let grants = resolve_github_auth_grants(request).expect("resolve grants");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].access_token, "token-a");

    // access_token shorthand path
    let request = GitHubAuthInstallRequest {
        grants: None,
        access_token: Some("token-c".to_string()),
        repositories: Some(vec!["owner/repo-c".to_string()]),
    };
    let grants = resolve_github_auth_grants(request).expect("resolve shorthand");
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].access_token, "token-c");

    // completely empty path
    let request = GitHubAuthInstallRequest {
        grants: None,
        access_token: None,
        repositories: None,
    };
    let grants = resolve_github_auth_grants(request).expect("resolve empty");
    assert!(grants.is_empty());
}

#[test]
fn github_repo_normalization_deduplicates_and_rejects_malformed_entries() {
    let repos = vec![
        "Owner/Repo".to_string(),
        "owner/repo".to_string(), // duplicate (case-insensitive)
        "bad-no-slash".to_string(),
        "/leading-slash".to_string(),
        "owner/repo/extra".to_string(), // nested path — rejected
        "  ".to_string(),               // blank
        "".to_string(),
    ];
    let result = normalize_github_auth_repositories(&repos);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0], "Owner/Repo");
}

#[test]
fn github_repo_normalization_sorts_and_preserves_case() {
    let repos = vec!["z-owner/a-repo".to_string(), "a-owner/z-repo".to_string()];
    let result = normalize_github_auth_repositories(&repos);
    assert_eq!(result[0], "a-owner/z-repo");
    assert_eq!(result[1], "z-owner/a-repo");
}

#[test]
fn github_scope_helpers_cover_all_cases() {
    // App token — no scopes — still allowed for git auth
    assert!(github_token_can_be_used_for_git_auth(&[]));
    // OAuth token with repo scope
    let repo_scopes: Vec<String> = vec!["repo".to_string()];
    assert!(github_scopes_allow_repo_access(&repo_scopes));
    assert!(github_token_can_be_used_for_git_auth(&repo_scopes));
    // OAuth token with public_repo scope
    let public_scopes: Vec<String> = vec!["public_repo".to_string()];
    assert!(github_scopes_allow_repo_access(&public_scopes));
    // OAuth token with insufficient scopes
    let read_only: Vec<String> = vec!["read:user".to_string()];
    assert!(!github_scopes_allow_repo_access(&read_only));
    assert!(!github_token_can_be_used_for_git_auth(&read_only));
}

#[test]
fn github_oauth_scope_parsing_handles_whitespace_case_and_empty() {
    let parsed = parse_github_oauth_scopes(Some("  Repo ,  PUBLIC_REPO , read:user , "));
    assert!(parsed.iter().any(|s| s == "repo"));
    assert!(parsed.iter().any(|s| s == "public_repo"));
    assert!(parsed.iter().any(|s| s == "read:user"));
    assert_eq!(parsed.len(), 3);

    let empty = parse_github_oauth_scopes(None);
    assert!(empty.is_empty());
}

#[test]
fn normalize_github_auth_repositories_accepts_empty_component() {
    // empty/empty component — both sides empty
    let repos = vec!["/".to_string(), "//".to_string()];
    let result = normalize_github_auth_repositories(&repos);
    assert!(result.is_empty());
}

#[derive(Clone, Debug)]
struct OpenCodeRequest {
    method: Method,
    path: String,
    directory: Option<String>,
    authorization: Option<String>,
    body: Value,
}

#[derive(Default)]
struct OpenCodeApiState {
    requests: Mutex<Vec<OpenCodeRequest>>,
    failures: Mutex<HashSet<String>>,
    invalid_json: Mutex<HashSet<String>>,
    message_reads: AtomicU64,
    prompt_started: AtomicBool,
}

struct OpenCodeApiServer {
    task: JoinHandle<()>,
    state: Arc<OpenCodeApiState>,
}

impl Drop for OpenCodeApiServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn fake_opencode_api(
    State(state): State<Arc<OpenCodeApiState>>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().trim_start_matches('/').to_string();
    let directory = request
        .headers()
        .get("x-opencode-directory")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let authorization = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = to_bytes(request.into_body(), 1024 * 1024)
        .await
        .expect("read fake OpenCode request");
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::String("invalid".to_string()))
    };
    state.requests.lock().await.push(OpenCodeRequest {
        method: method.clone(),
        path: path.clone(),
        directory,
        authorization,
        body,
    });

    if state.failures.lock().await.contains(&path) {
        return (StatusCode::BAD_GATEWAY, "secret backend failure").into_response();
    }
    if state.invalid_json.lock().await.contains(&path) {
        return (StatusCode::OK, "not-json").into_response();
    }
    if path == "no-content" {
        return StatusCode::NO_CONTENT.into_response();
    }
    if path == "global/event" {
        return (
            StatusCode::OK,
            "data:\n\ndata: not-json\n\ndata: {\"directory\":\"/repo\",\"payload\":{\"type\":\"server.heartbeat\",\"properties\":{}}}\n\n",
        )
            .into_response();
    }
    if method == Method::POST && path == "session/s1/prompt_async" {
        state.prompt_started.store(true, Ordering::Relaxed);
    }

    let payload = match (method.as_str(), path.as_str()) {
        ("GET", "global/health") => json!({ "healthy": true }),
        ("GET", "experimental/session") | ("GET", "session") => json!([
            {
                "id": "s1",
                "title": "Active thread",
                "directory": "/repo",
                "time": { "created": 1000, "updated": 4000 }
            },
            {
                "id": "archived",
                "title": "Archived thread",
                "directory": "/repo",
                "time": { "created": 1000, "updated": 2000, "archived": 3000 }
            }
        ]),
        ("GET", "session/status") => json!({
            "s1": { "type": "busy" },
            "idle": { "type": "idle" }
        }),
        ("GET", "session/s1") => json!({
            "id": "s1",
            "title": "Active thread",
            "directory": "/repo",
            "parentID": "parent",
            "time": { "created": 1000, "updated": 4000 }
        }),
        ("GET", "session/s1/message") => {
            state.message_reads.fetch_add(1, Ordering::Relaxed);
            let user_id = if state.prompt_started.load(Ordering::Relaxed) {
                "user-new"
            } else {
                "user-old"
            };
            json!([
                {
                    "info": { "id": user_id, "role": "user" },
                    "parts": [{ "type": "text", "text": "hello" }]
                },
                {
                    "info": { "id": "assistant", "role": "assistant", "parentID": user_id },
                    "parts": [{ "type": "text", "text": "world" }]
                }
            ])
        }
        ("POST", "session") => json!({
            "id": "created",
            "title": "Created",
            "directory": "/new",
            "time": { "created": 5000, "updated": 5000 }
        }),
        ("PATCH", "session/s1") => json!({
            "id": "s1",
            "title": "Renamed",
            "directory": "/repo",
            "time": { "created": 1000, "updated": 6000 }
        }),
        ("POST", "session/s1/fork") => json!({
            "id": "forked",
            "title": "Forked",
            "directory": "/repo",
            "time": { "created": 7000, "updated": 7000 }
        }),
        ("GET", "config/providers") => json!({
            "providers": [{
                "id": "provider",
                "name": "Provider",
                "models": {
                    "model": {
                        "name": "Model",
                        "variants": { "high": {}, "low": {} }
                    }
                }
            }],
            "default": { "provider": "model" }
        }),
        ("GET", "provider") => json!({ "connected": ["provider"] }),
        ("GET", "config") => json!({ "model": "provider/model" }),
        ("GET", "agent") => json!([
            {
                "name": "build",
                "mode": "primary",
                "native": true,
                "description": "Build agent",
                "model": { "providerID": "provider", "modelID": "model" }
            },
            {
                "name": "custom",
                "mode": "subagent",
                "builtIn": false,
                "color": "blue"
            },
            { "name": "all", "mode": "all", "native": false },
            { "name": "", "mode": "primary" },
            { "name": "hidden", "mode": "all", "hidden": true },
            { "name": "invalid", "mode": "secondary" },
            { "mode": "primary" }
        ]),
        _ => json!({}),
    };
    Json(payload).into_response()
}

async fn start_opencode_api(password: Option<&str>) -> (OpenCodeApiServer, Arc<OpencodeBackend>) {
    let state = Arc::new(OpenCodeApiState::default());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind fake OpenCode API");
    let address = listener.local_addr().expect("fake OpenCode API address");
    let router = Router::new()
        .fallback(any(fake_opencode_api))
        .with_state(state.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve fake OpenCode API");
    });

    let mut command = Command::new("sh");
    command
        .arg("-c")
        .arg("sleep 60")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_managed_child_command(&mut command);
    let child = command.spawn().expect("spawn fake OpenCode process");
    let child_pid = child.id().expect("fake OpenCode process id");
    let backend = Arc::new(OpencodeBackend {
        child: Mutex::new(child),
        child_pid,
        hub: Arc::new(ClientHub::with_replay_capacity(64)),
        http: HttpClient::new(),
        base_url: Url::parse(&format!("http://{address}/")).expect("fake OpenCode URL"),
        username: "coverage".to_string(),
        password: password.map(str::to_string),
        fallback_directory: "/fallback".to_string(),
        session_directories: RwLock::new(HashMap::new()),
        session_statuses: RwLock::new(HashMap::new()),
        active_turns: RwLock::new(HashMap::new()),
        part_kinds: RwLock::new(HashMap::new()),
        interrupted_sessions: RwLock::new(HashSet::new()),
        pending_approvals: Mutex::new(HashMap::new()),
        pending_user_inputs: Mutex::new(HashMap::new()),
        lifecycle: Arc::new(BackendRuntimeStatus::starting()),
    });
    backend
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;

    (OpenCodeApiServer { task, state }, backend)
}

async fn stop_opencode_backend(backend: &OpencodeBackend) {
    let mut child = backend.child.lock().await;
    let _ = child.kill().await;
    let _ = child.wait().await;
}

#[tokio::test]
async fn opencode_event_stream_reconnects_while_wait_task_owns_child() {
    let (server, backend) = start_opencode_api(None).await;
    backend.spawn_wait_loop();
    timeout(Duration::from_secs(1), async {
        while backend.child.try_lock().is_ok() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("OpenCode wait task should own the child mutex");
    backend.spawn_global_event_loop();

    timeout(Duration::from_secs(4), async {
        loop {
            let event_requests = server
                .state
                .requests
                .lock()
                .await
                .iter()
                .filter(|request| request.path == "global/event")
                .count();
            if event_requests >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("OpenCode event stream should reconnect after closure");

    backend.request_shutdown().await;
    timeout(Duration::from_secs(5), async {
        while !backend.lifecycle.is_dead() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("OpenCode wait task should observe shutdown");

    let requests_after_exit = server
        .state
        .requests
        .lock()
        .await
        .iter()
        .filter(|request| request.path == "global/event")
        .count();
    tokio::time::sleep(OPENCODE_EVENT_RECONNECT_DELAY + Duration::from_millis(100)).await;
    let final_requests = server
        .state
        .requests
        .lock()
        .await
        .iter()
        .filter(|request| request.path == "global/event")
        .count();
    assert_eq!(final_requests, requests_after_exit);
}

async fn app_server_sink(
    engine: BridgeRuntimeEngine,
    timeout_duration: Duration,
) -> Arc<AppServerBridge> {
    let mut child = Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn fake stdio app-server");
    let writer = child.stdin.take().expect("fake app-server stdin");
    let child_pid = child.id().expect("fake app-server pid");
    Arc::new(AppServerBridge {
        engine,
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
        hub: Arc::new(ClientHub::with_replay_capacity(64)),
        lifecycle: Arc::new(BackendRuntimeStatus::starting()),
        metrics: Arc::new(OperationalMetrics::new()),
        timed_out_requests: AtomicU64::new(0),
        request_timeout: timeout_duration,
    })
}

async fn stop_app_server_sink(bridge: &AppServerBridge) {
    let mut child = bridge.child.lock().await;
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn runtime_backend(
    preferred_engine: BridgeRuntimeEngine,
    codex: Option<Arc<AppServerBridge>>,
    opencode: Option<Arc<OpencodeBackend>>,
    cursor: Option<Arc<AppServerBridge>>,
) -> RuntimeBackend {
    RuntimeBackend {
        preferred_engine,
        codex: Arc::new(StdRwLock::new(codex)),
        opencode,
        cursor: Arc::new(StdRwLock::new(cursor)),
        metrics: Arc::new(OperationalMetrics::new()),
    }
}

fn sample_pending_approval(id: &str) -> PendingApproval {
    PendingApproval {
        id: id.to_string(),
        kind: "commandExecution".to_string(),
        thread_id: "opencode:s1".to_string(),
        turn_id: "turn".to_string(),
        item_id: "item".to_string(),
        requested_at: now_iso(),
        reason: Some("coverage".to_string()),
        command: Some("pwd".to_string()),
        cwd: Some("/repo".to_string()),
        grant_root: None,
        proposed_execpolicy_amendment: None,
    }
}

fn sample_pending_input(id: &str) -> PendingUserInputRequest {
    PendingUserInputRequest {
        id: id.to_string(),
        thread_id: "opencode:s1".to_string(),
        turn_id: "turn".to_string(),
        item_id: "item".to_string(),
        requested_at: now_iso(),
        questions: vec![PendingUserInputQuestion {
            id: format!("{id}:0"),
            header: "Choice".to_string(),
            question: "Pick one".to_string(),
            is_other: true,
            is_secret: false,
            options: None,
        }],
    }
}

#[tokio::test]
async fn github_credentials_helpers_cover_filesystem_success_and_errors() {
    let root = env::temp_dir().join(format!("clawdex-github-coverage-{}", Uuid::new_v4()));
    let credentials = root.join("nested").join("credentials");
    ensure_private_parent_dir(&credentials)
        .await
        .expect("create private credentials directory");
    let grants = vec![ResolvedGitHubAuthGrant {
        access_token: "token".to_string(),
        repositories: vec!["owner/repo".to_string()],
    }];
    write_github_credentials_file(&credentials, &grants)
        .await
        .expect("write credentials");
    let content = fs::read_to_string(&credentials)
        .await
        .expect("read credentials");
    assert!(content.contains("owner/repo.git"));
    assert!(ensure_private_parent_dir(Path::new("/")).await.is_err());
    assert!(write_github_credentials_file(&root, &grants).await.is_err());

    let _ = fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn credential_path_and_cursor_env_resolution_cover_present_and_missing_values() {
    let old_home = env::var_os("HOME");
    let old_cursor = env::var_os("CURSOR_API_KEY");
    let home = env::temp_dir().join(format!("clawdex-credential-env-{}", Uuid::new_v4()));

    env::set_var("HOME", &home);
    assert_eq!(
        resolve_github_credentials_dir_path().expect("credentials dir"),
        home.join(GITHUB_CREDENTIALS_DIR_NAME)
    );
    assert_eq!(
        resolve_github_credentials_file_path().expect("credentials file"),
        home.join(GITHUB_CREDENTIALS_DIR_NAME)
            .join(GITHUB_CREDENTIALS_FILE_NAME)
    );
    env::set_var("CURSOR_API_KEY", "  cursor-secret  ");
    let credential = resolve_cursor_runtime_credential()
        .await
        .expect("cursor credential");
    assert_eq!(credential.api_key, "cursor-secret");
    assert_eq!(credential.source, CursorCredentialSource::Env);

    env::remove_var("HOME");
    env::set_var("CURSOR_API_KEY", "   ");
    assert!(resolve_github_credentials_dir_path().is_err());
    assert!(resolve_github_credentials_file_path().is_err());
    assert!(resolve_cursor_runtime_credential().await.is_err());

    match old_home {
        Some(value) => env::set_var("HOME", value),
        None => env::remove_var("HOME"),
    }
    match old_cursor {
        Some(value) => env::set_var("CURSOR_API_KEY", value),
        None => env::remove_var("CURSOR_API_KEY"),
    }
}

#[tokio::test]
async fn app_server_bridge_handles_requests_responses_notifications_and_timeouts() {
    let bridge = app_server_sink(BridgeRuntimeEngine::Codex, Duration::from_millis(25)).await;
    let mut notifications = bridge.hub.subscribe_notifications();

    bridge.handle_incoming(Value::Null).await;
    bridge.handle_incoming(json!({})).await;
    bridge
        .handle_incoming(json!({ "method": "thread/started", "params": { "threadId": "raw" } }))
        .await;
    let notification = notifications.recv().await.expect("forwarded notification");
    assert_eq!(notification.params["threadId"], "codex:raw");

    for (method, params) in [
        (
            APPROVAL_COMMAND_METHOD,
            json!({
                "threadId": "thread",
                "turnId": "turn",
                "itemId": "item",
                "command": "pwd",
                "proposedExecpolicyAmendment": ["pwd"]
            }),
        ),
        (APPROVAL_FILE_METHOD, json!({ "threadId": "thread" })),
        (
            LEGACY_APPROVAL_COMMAND_METHOD,
            json!({
                "conversationId": "legacy",
                "callId": "call",
                "approvalId": "approval",
                "command": ["git", "status"]
            }),
        ),
        (
            LEGACY_APPROVAL_PATCH_METHOD,
            json!({ "conversationId": "legacy" }),
        ),
    ] {
        bridge
            .handle_server_request(method, json!(method), Some(params))
            .await;
    }
    let approvals = bridge.list_pending_approvals().await;
    assert_eq!(approvals.len(), 4);
    let approval_id = approvals[0].id.clone();
    assert!(bridge
        .resolve_approval(&approval_id, &json!("invalid"))
        .await
        .is_err());
    assert!(bridge
        .resolve_approval(&approval_id, &json!("accept"))
        .await
        .expect("resolve approval")
        .is_some());
    assert!(bridge
        .resolve_approval("missing", &json!("accept"))
        .await
        .expect("missing approval")
        .is_none());

    for method in [REQUEST_USER_INPUT_METHOD, REQUEST_USER_INPUT_METHOD_ALT] {
        bridge
            .handle_server_request(
                method,
                json!(method),
                Some(json!({
                    "threadId": "thread",
                    "turnId": "turn",
                    "itemId": "item",
                    "questions": [{
                        "id": "q",
                        "header": "Header",
                        "question": "Question"
                    }]
                })),
            )
            .await;
    }
    let inputs = bridge.list_pending_user_inputs().await;
    assert_eq!(inputs.len(), 2);
    let answers = HashMap::from([(
        "q".to_string(),
        UserInputAnswerPayload {
            answers: vec!["answer".to_string()],
        },
    )]);
    assert!(bridge
        .resolve_user_input(&inputs[0].id, &answers)
        .await
        .expect("resolve input")
        .is_some());
    assert!(bridge
        .resolve_user_input("missing", &answers)
        .await
        .expect("missing input")
        .is_none());

    bridge
        .handle_server_request(
            DYNAMIC_TOOL_CALL_METHOD,
            json!(90),
            Some(json!({ "tool": "x" })),
        )
        .await;

    // Set up a cached auth bundle so handle_server_request for chatgptAuthTokens/refresh
    // exercises the `if let Some(auth)` true branch at line 4102.
    let _auth_cache_scope = TestBridgeChatGptAuthCacheScope::new();
    cache_bridge_chatgpt_auth(BridgeChatGptAuthBundle {
        access_token: "test-access".to_string(),
        account_id: "test-account".to_string(),
        plan_type: Some("plus".to_string()), // Some plan_type exercises line 4109
    });
    bridge
        .handle_server_request(ACCOUNT_CHATGPT_TOKENS_REFRESH_METHOD, json!(91), None)
        .await;
    clear_cached_bridge_chatgpt_auth();
    bridge
        .handle_server_request("unsupported/server/request", json!(92), None)
        .await;

    let (success_tx, success_rx) = oneshot::channel();
    bridge.internal_waiters.lock().await.insert(100, success_tx);
    bridge
        .handle_response(json!({ "id": 100, "result": { "ok": true } }))
        .await;
    assert_eq!(
        success_rx
            .await
            .expect("success waiter")
            .expect("success result")["ok"],
        true
    );
    let (error_tx, error_rx) = oneshot::channel();
    bridge.internal_waiters.lock().await.insert(101, error_tx);
    bridge
        .handle_response(json!({ "id": "101", "error": { "message": "failed" } }))
        .await;
    assert_eq!(
        error_rx
            .await
            .expect("error waiter")
            .expect_err("error result"),
        "failed"
    );
    bridge.handle_response(json!({ "id": "bad" })).await;
    bridge.handle_response(json!({ "id": 999 })).await;

    let (response_tx, mut response_rx) = mpsc::channel(4);
    let response_client = bridge.hub.add_client(response_tx).await;
    bridge
        .forward_request(response_client, json!("ok"), "thread/read", None)
        .await
        .expect("forward successful response");
    let response_id = *bridge
        .pending_requests
        .lock()
        .await
        .keys()
        .next()
        .expect("pending successful response");
    bridge
        .handle_response(json!({ "id": response_id, "result": { "id": "thread" } }))
        .await;
    let Message::Text(success_text) = response_rx.recv().await.expect("successful response") else {
        panic!("expected successful text response");
    };
    let success_payload: Value = serde_json::from_str(&success_text).expect("success JSON");
    assert_eq!(success_payload["id"], "ok");
    assert_eq!(success_payload["result"]["id"], "codex:thread");

    bridge
        .forward_request(response_client, json!("error"), "thread/read", None)
        .await
        .expect("forward backend error response");
    let response_id = *bridge
        .pending_requests
        .lock()
        .await
        .keys()
        .next()
        .expect("pending backend error response");
    bridge
        .handle_response(json!({ "id": response_id, "error": { "message": "bad request" } }))
        .await;
    let Message::Text(error_text) = response_rx.recv().await.expect("backend error response")
    else {
        panic!("expected backend error text response");
    };
    let error_payload: Value = serde_json::from_str(&error_text).expect("error JSON");
    assert_eq!(error_payload["id"], "error");
    assert_eq!(error_payload["error"]["message"], "bad request");

    let (client_tx, mut client_rx) = mpsc::channel(8);
    let client_id = bridge.hub.add_client(client_tx).await;
    bridge
        .forward_request(client_id, json!("timeout"), "thread/list", None)
        .await
        .expect("forward timeout request");
    let Message::Text(timeout_message) = timeout(Duration::from_secs(1), client_rx.recv())
        .await
        .expect("timeout response deadline")
        .expect("timeout response")
    else {
        panic!("expected timeout text response");
    };
    let timeout_payload: Value = serde_json::from_str(&timeout_message).expect("timeout JSON");
    assert_eq!(timeout_payload["error"]["data"]["error"], "timeout");
    assert_eq!(bridge.timed_out_requests.load(Ordering::Relaxed), 1);

    bridge.cancel_client_requests(client_id).await;
    bridge.fail_all_pending("closed").await;
    let (dropped_tx, dropped_rx) = oneshot::channel();
    bridge.internal_waiters.lock().await.insert(102, dropped_tx);
    bridge.fail_all_internal("closed").await;
    assert_eq!(
        dropped_rx
            .await
            .expect("failed waiter")
            .expect_err("failure"),
        "closed"
    );
    stop_app_server_sink(&bridge).await;
}

#[tokio::test]
async fn app_server_internal_requests_cover_success_error_drop_and_write_failure() {
    let bridge = app_server_sink(BridgeRuntimeEngine::Cursor, Duration::from_millis(30)).await;
    let success_bridge = bridge.clone();
    let success = tokio::spawn(async move {
        success_bridge
            .request_internal_once("model/list", Some(json!({ "limit": 1 })))
            .await
    });
    loop {
        let id = bridge.internal_waiters.lock().await.keys().next().copied();
        if let Some(id) = id {
            bridge
                .handle_response(json!({ "id": id, "result": { "data": [] } }))
                .await;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(success.await.expect("join success request").is_ok());

    let error_bridge = bridge.clone();
    let error =
        tokio::spawn(async move { error_bridge.request_internal_once("model/list", None).await });
    loop {
        let id = bridge.internal_waiters.lock().await.keys().next().copied();
        if let Some(id) = id {
            bridge
                .handle_response(json!({ "id": id, "error": { "message": "backend error" } }))
                .await;
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        error
            .await
            .expect("join error request")
            .expect_err("backend error"),
        "backend error"
    );

    assert!(bridge
        .request_internal_once("model/list", None)
        .await
        .expect_err("request timeout")
        .contains("timed out"));
    stop_app_server_sink(&bridge).await;
    assert!(bridge
        .request_internal_once("model/list", None)
        .await
        .expect_err("write failure")
        .contains("failed forwarding"));
}

#[tokio::test]
async fn opencode_http_dispatch_covers_every_supported_method_and_failures() {
    let (server, backend) = start_opencode_api(Some("password")).await;

    for method in [
        "account/logout",
        "account/rateLimits/read",
        "account/read",
        "config/read",
    ] {
        assert!(
            backend.dispatch_request(method, None).await.is_ok(),
            "{method}"
        );
    }
    assert!(backend
        .dispatch_request("review/start", None)
        .await
        .expect_err("review unsupported")
        .contains("not supported"));
    assert!(backend
        .dispatch_request("unknown", None)
        .await
        .expect_err("unknown unsupported")
        .contains("unsupported opencode"));

    let listed = backend
        .dispatch_request(
            "thread/list",
            Some(json!({ "limit": 0, "cwd": "/repo", "archived": false })),
        )
        .await
        .expect("list threads");
    assert_eq!(listed["data"].as_array().expect("thread data").len(), 1);
    let archived = backend
        .dispatch_request("thread/list", Some(json!({ "archived": true })))
        .await
        .expect("list archived threads");
    assert_eq!(archived["data"].as_array().expect("archived data").len(), 2);
    assert_eq!(
        backend
            .dispatch_request("thread/loaded/list", None)
            .await
            .expect("loaded threads")["data"][0],
        "s1"
    );
    assert!(backend.dispatch_request("thread/read", None).await.is_err());
    assert!(backend
        .dispatch_request("thread/read", Some(json!({})))
        .await
        .is_err());
    let read = backend
        .dispatch_request(
            "thread/read",
            Some(json!({ "threadId": "s1", "includeTurns": true })),
        )
        .await
        .expect("read thread");
    assert!(read["thread"]["turns"].is_array());
    assert!(backend
        .dispatch_request(
            "thread/start",
            Some(json!({ "cwd": "/new", "threadName": "Created" })),
        )
        .await
        .is_ok());
    assert!(backend
        .dispatch_request("thread/name/set", Some(json!({ "threadId": "s1" })))
        .await
        .is_err());
    assert!(backend
        .dispatch_request(
            "thread/name/set",
            Some(json!({ "threadId": "s1", "name": "Renamed" })),
        )
        .await
        .is_ok());
    assert!(backend
        .dispatch_request("thread/fork", Some(json!({ "threadId": "s1" })))
        .await
        .is_ok());
    assert!(backend
        .dispatch_request("thread/compact/start", Some(json!({ "threadId": "s1" })))
        .await
        .is_ok());
    assert!(backend
        .dispatch_request("thread/resume", Some(json!({ "threadId": "s1" })))
        .await
        .is_ok());
    assert!(backend
        .dispatch_request("turn/start", Some(json!({ "threadId": "s1", "input": [] })))
        .await
        .is_err());
    let turn = backend
        .dispatch_request(
            "turn/start",
            Some(json!({
                "threadId": "s1",
                "input": [{ "type": "text", "text": "hello" }],
                "collaborationMode": { "mode": "plan" },
                "model": "provider/model",
                "effort": "high"
            })),
        )
        .await
        .expect("start turn");
    assert_eq!(turn["turn"]["id"], "user-new");
    assert!(backend
        .dispatch_request("turn/interrupt", Some(json!({ "threadId": "s1" })))
        .await
        .is_ok());
    assert!(backend
        .dispatch_request("model/list", Some(json!({ "threadId": "s1" })))
        .await
        .expect("list models")["data"]
        .is_array());
    assert_eq!(
        backend
            .dispatch_request("agent/list", Some(json!({ "cwd": "/repo" })))
            .await
            .expect("list agents")["data"]
            .as_array()
            .expect("agent data")
            .len(),
        3
    );
    assert!(backend
        .dispatch_request("model/list", Some(json!({ "cwd": "/explicit" })))
        .await
        .is_ok());
    assert!(backend.dispatch_request("model/list", None).await.is_ok());
    assert!(backend
        .dispatch_request("agent/list", Some(json!({ "threadId": "s1" })))
        .await
        .is_ok());
    assert!(backend.dispatch_request("agent/list", None).await.is_ok());
    assert!(backend.dispatch_request("thread/start", None).await.is_ok());
    assert!(backend
        .dispatch_request(
            "thread/start",
            Some(json!({ "cwd": "/alias", "name": "Alias" })),
        )
        .await
        .is_ok());
    assert!(backend
        .dispatch_request(
            "thread/fork",
            Some(json!({ "threadId": "s1", "cwd": "/explicit" })),
        )
        .await
        .is_ok());
    assert!(backend
        .dispatch_request(
            "turn/start",
            Some(json!({
                "threadId": "s1",
                "cwd": "/explicit",
                "agent": "custom",
                "model": "provider/model",
                "input": [{ "type": "text", "text": "again" }]
            })),
        )
        .await
        .is_ok());

    for (method, params) in [
        ("thread/fork", None),
        ("thread/fork", Some(json!({}))),
        ("thread/compact/start", None),
        ("thread/compact/start", Some(json!({}))),
        ("turn/interrupt", None),
        ("turn/interrupt", Some(json!({}))),
    ] {
        assert!(
            backend.dispatch_request(method, params).await.is_err(),
            "{method}"
        );
    }

    assert_eq!(
        backend
            .request_json(HttpMethod::GET, "no-content", Some("  "), None, None)
            .await
            .expect("no content"),
        Value::Null
    );
    server
        .state
        .invalid_json
        .lock()
        .await
        .insert("invalid-json".to_string());
    assert!(backend
        .request_json(HttpMethod::GET, "invalid-json", None, None, None)
        .await
        .expect_err("invalid JSON")
        .contains("failed decoding"));
    server
        .state
        .failures
        .lock()
        .await
        .insert("http-error".to_string());
    let http_error = backend
        .request_json(HttpMethod::GET, "http-error", None, None, None)
        .await
        .expect_err("HTTP failure");
    assert!(http_error.contains("HTTP 502"));
    assert!(!http_error.contains("secret backend failure"));

    let requests = server.state.requests.lock().await;
    assert!(requests.iter().any(|request| {
        request
            .authorization
            .as_deref()
            .is_some_and(|value| value.starts_with("Basic "))
    }));
    assert!(requests
        .iter()
        .any(|request| request.directory.as_deref() == Some("/repo")));
    assert!(requests
        .iter()
        .any(|request| request.method == Method::POST && !request.body.is_null()));
    assert!(requests
        .iter()
        .any(|request| request.path == "experimental/session"));
    drop(requests);

    stop_opencode_backend(&backend).await;
}

#[tokio::test]
async fn opencode_dispatch_fallback_forwarding_and_resolution_restore_pending_entries() {
    let (server, backend) = start_opencode_api(None).await;
    server
        .state
        .failures
        .lock()
        .await
        .insert("experimental/session".to_string());
    let fallback = backend
        .list_threads(None)
        .await
        .expect("fallback session list");
    assert_eq!(fallback["data"].as_array().expect("fallback data").len(), 1);

    let (tx, mut rx) = mpsc::channel(4);
    let client = backend.hub.add_client(tx).await;
    backend
        .forward_request(client, json!(1), "account/read", None)
        .await
        .expect("forward success");
    backend
        .forward_request(client, json!(2), "unknown", None)
        .await
        .expect("forward unsupported error");
    for expected_code in [Value::Null, json!(-32601)] {
        let Message::Text(text) = rx.recv().await.expect("forward response") else {
            panic!("expected text response");
        };
        let payload: Value = serde_json::from_str(&text).expect("forward response JSON");
        if expected_code.is_null() {
            assert!(payload.get("result").is_some());
        } else {
            assert_eq!(payload["error"]["code"], expected_code);
        }
    }

    backend.pending_approvals.lock().await.insert(
        "approval".to_string(),
        OpencodePendingApprovalEntry {
            approval: sample_pending_approval("approval"),
            directory: "/repo".to_string(),
        },
    );
    assert!(backend
        .resolve_approval("approval", &json!("invalid"))
        .await
        .is_err());
    server
        .state
        .failures
        .lock()
        .await
        .insert("permission/approval/reply".to_string());
    assert!(backend
        .resolve_approval("approval", &json!("acceptForSession"))
        .await
        .is_err());
    server
        .state
        .failures
        .lock()
        .await
        .remove("permission/approval/reply");
    assert!(backend
        .resolve_approval("approval", &json!("decline"))
        .await
        .expect("resolve approval")
        .is_some());
    assert!(backend
        .resolve_approval("missing", &json!("accept"))
        .await
        .expect("missing approval")
        .is_none());

    backend.pending_user_inputs.lock().await.insert(
        "question".to_string(),
        OpencodePendingUserInputEntry {
            request: sample_pending_input("question"),
            directory: "/repo".to_string(),
        },
    );
    let answers = HashMap::from([(
        "question:0".to_string(),
        UserInputAnswerPayload {
            answers: vec!["one".to_string()],
        },
    )]);
    server
        .state
        .failures
        .lock()
        .await
        .insert("question/question/reply".to_string());
    assert!(backend
        .resolve_user_input("question", &answers)
        .await
        .is_err());
    server
        .state
        .failures
        .lock()
        .await
        .remove("question/question/reply");
    assert!(backend
        .resolve_user_input("question", &answers)
        .await
        .expect("resolve question")
        .is_some());
    assert!(backend
        .resolve_user_input("missing", &answers)
        .await
        .expect("missing question")
        .is_none());

    stop_opencode_backend(&backend).await;
}

#[tokio::test]
async fn opencode_event_handlers_cover_valid_and_invalid_envelopes() {
    let (_server, backend) = start_opencode_api(None).await;
    let mut notifications = backend.hub.subscribe_notifications();

    backend.handle_sse_frame("").await;
    backend.handle_sse_frame("data: invalid").await;
    backend.handle_global_event(Value::Null).await;
    backend.handle_global_event(json!({})).await;
    backend.handle_global_event(json!({ "payload": {} })).await;

    let event = |event_type: &str, properties: Value| {
        json!({
            "directory": "/repo",
            "payload": { "type": event_type, "properties": properties }
        })
    };
    backend
        .handle_global_event(event(
            "session.created",
            json!({ "info": { "id": "s1", "directory": "/repo" } }),
        ))
        .await;
    backend
        .handle_global_event(event(
            "session.updated",
            json!({ "info": { "id": "s1", "directory": "/repo", "title": "New" } }),
        ))
        .await;
    backend
        .handle_global_event(event(
            "session.status",
            json!({ "sessionID": "s1", "status": { "type": "busy" } }),
        ))
        .await;
    backend
        .interrupted_sessions
        .write()
        .await
        .insert("s1".to_string());
    backend
        .handle_global_event(event(
            "session.status",
            json!({ "sessionID": "s1", "status": { "type": "idle" } }),
        ))
        .await;
    backend
        .handle_global_event(event(
            "session.error",
            json!({ "sessionID": "s1", "error": { "message": "boom" } }),
        ))
        .await;

    for part in [
        json!({ "id": "reason", "sessionID": "s1", "type": "reasoning" }),
        json!({ "id": "text", "sessionID": "s1", "type": "text" }),
        json!({
            "id": "tool",
            "sessionID": "s1",
            "type": "tool",
            "tool": "bash",
            "state": { "status": "running", "input": { "command": "pwd" } }
        }),
    ] {
        backend
            .handle_global_event(event("message.part.updated", json!({ "part": part })))
            .await;
    }
    for (part_id, field, delta) in [
        ("reason", "text", "thinking"),
        ("text", "text", "answer"),
        ("text", "other", "ignored"),
        ("missing", "text", "ignored"),
    ] {
        backend
            .handle_global_event(event(
                "message.part.delta",
                json!({
                    "sessionID": "s1",
                    "partID": part_id,
                    "field": field,
                    "delta": delta
                }),
            ))
            .await;
    }
    backend
        .handle_global_event(event(
            "message.part.removed",
            json!({ "sessionID": "s1", "partID": "text" }),
        ))
        .await;

    backend
        .handle_global_event(event(
            "permission.asked",
            json!({
                "id": "permission",
                "sessionID": "s1",
                "permission": "bash",
                "metadata": { "command": ["git", "status"] },
                "tool": { "messageID": "turn", "callID": "call" }
            }),
        ))
        .await;
    backend
        .handle_global_event(event(
            "permission.replied",
            json!({ "requestID": "permission", "reply": "always" }),
        ))
        .await;
    backend
        .handle_global_event(event(
            "question.asked",
            json!({
                "id": "question",
                "sessionID": "s1",
                "questions": [
                    null,
                    { "header": "missing question" },
                    {
                        "header": "Choice",
                        "question": "Pick",
                        "custom": false,
                        "options": [
                            { "label": "One", "description": "First" },
                            { "description": "invalid" }
                        ]
                    }
                ]
            }),
        ))
        .await;
    backend
        .handle_global_event(event(
            "question.replied",
            json!({ "requestID": "question" }),
        ))
        .await;
    backend
        .handle_global_event(event("unknown.event", json!({})))
        .await;

    backend.handle_session_status_event(json!({})).await;
    backend
        .handle_session_status_event(json!({ "sessionID": "s1" }))
        .await;
    backend.handle_session_error_event(json!({})).await;
    backend.cache_message_part_kind(json!({})).await;
    backend.cache_message_part_kind(json!({ "part": {} })).await;
    backend.handle_message_part_delta(json!({})).await;
    backend.handle_permission_asked(Value::Null, None).await;
    backend.handle_permission_replied(json!({})).await;
    backend.handle_question_asked(Value::Null, None).await;
    backend.handle_question_resolved(json!({})).await;
    backend.cache_session_info(&json!({})).await;
    assert_eq!(
        backend.current_directory_for_session("missing").await,
        "/fallback"
    );
    assert!(!backend
        .list_pending_approvals()
        .await
        .iter()
        .any(|value| value.id == "permission"));
    assert!(backend.list_pending_user_inputs().await.is_empty());
    assert!(notifications.try_recv().is_ok());

    let stream_error = backend
        .consume_global_events()
        .await
        .expect_err("fake event stream closes");
    assert!(stream_error.contains("closed"));
    assert!(!backend.child_has_exited().await);
    stop_opencode_backend(&backend).await;
    assert!(backend.child_has_exited().await);
}

#[tokio::test]
async fn runtime_backend_covers_engine_availability_status_routing_and_fallbacks() {
    let (_server, opencode) = start_opencode_api(None).await;
    let codex = app_server_sink(BridgeRuntimeEngine::Codex, Duration::from_millis(20)).await;
    let cursor = app_server_sink(BridgeRuntimeEngine::Cursor, Duration::from_millis(20)).await;
    codex
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;
    cursor
        .lifecycle
        .transition(
            BackendLifecycleState::Degraded,
            Some("coverage".to_string()),
        )
        .await;
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Cursor,
        Some(codex.clone()),
        Some(opencode.clone()),
        Some(cursor.clone()),
    );

    assert_eq!(
        runtime.available_engines(),
        vec![BridgeRuntimeEngine::Codex, BridgeRuntimeEngine::Opencode]
    );
    let capabilities = runtime.capabilities("coverage-stream");
    assert_eq!(capabilities.active_engine, BridgeRuntimeEngine::Codex);
    assert_eq!(capabilities.preferred_engine, BridgeRuntimeEngine::Cursor);
    assert!(capabilities.unified_chat_list);
    assert_eq!(capabilities.supports_by_engine.len(), 3);
    assert!(matches!(
        runtime
            .backend_for_engine(BridgeRuntimeEngine::Opencode)
            .expect("opencode backend"),
        RuntimeBackendRef::Opencode(_)
    ));
    assert!(matches!(
        runtime
            .backend_for_engine(BridgeRuntimeEngine::Codex)
            .expect("codex backend"),
        RuntimeBackendRef::Codex(_)
    ));
    assert!(matches!(
        runtime
            .backend_for_engine(BridgeRuntimeEngine::Cursor)
            .expect("cursor backend"),
        RuntimeBackendRef::Cursor(_)
    ));
    assert_eq!(
        runtime.route_engine_for_method("thread/list", Some(&json!({ "engine": "opencode" })),),
        BridgeRuntimeEngine::Cursor
    );
    assert_eq!(
        runtime
            .route_engine_for_method("thread/read", Some(&json!({ "threadId": "opencode:s1" })),),
        BridgeRuntimeEngine::Opencode
    );
    assert!(runtime
        .request_internal("account/read", Some(json!({ "engine": "opencode" })),)
        .await
        .is_ok());
    assert!(runtime
        .request_internal(
            "model/list",
            Some(json!({ "engine": "opencode", "cwd": "/repo" })),
        )
        .await
        .is_ok());
    let statuses = runtime
        .engine_statuses(&[
            BridgeRuntimeEngine::Codex,
            BridgeRuntimeEngine::Opencode,
            BridgeRuntimeEngine::Cursor,
        ])
        .await;
    assert!(statuses[&BridgeRuntimeEngine::Codex].available);
    assert!(!statuses[&BridgeRuntimeEngine::Cursor].available);
    assert!(statuses[&BridgeRuntimeEngine::Cursor].last_error.is_some());

    let empty = runtime_backend(BridgeRuntimeEngine::Opencode, None, None, None);
    assert!(empty.available_engines().is_empty());
    assert_eq!(
        empty.capabilities("empty").active_engine,
        BridgeRuntimeEngine::Opencode
    );
    for engine in [
        BridgeRuntimeEngine::Codex,
        BridgeRuntimeEngine::Opencode,
        BridgeRuntimeEngine::Cursor,
    ] {
        assert!(empty.backend_for_engine(engine).is_err());
    }
    let statuses = empty.engine_statuses(&[]).await;
    assert!(statuses
        .values()
        .all(|status| !status.configured && !status.available));

    // Exercise aggregate_thread_list by calling thread/list through the RuntimeBackend.
    // This hits the opencode dispatch branch in request_internal.
    let _ = runtime
        .request_internal("thread/list", Some(json!({ "engine": "opencode" })))
        .await;

    // thread/loaded/list exercises aggregate_loaded_thread_ids.
    let _ = runtime.request_internal("thread/loaded/list", None).await;

    // model/list dispatched through codex engine routing.
    let _ = runtime
        .request_internal("model/list", Some(json!({ "engine": "codex" })))
        .await;

    stop_app_server_sink(&codex).await;
    stop_app_server_sink(&cursor).await;
    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn aggregate_lists_skip_degraded_backends_and_preserve_ready_results() {
    let (_server, opencode) = start_opencode_api(None).await;
    let codex = app_server_sink(BridgeRuntimeEngine::Codex, Duration::from_millis(20)).await;
    codex
        .lifecycle
        .transition(
            BackendLifecycleState::Dead,
            Some("backend exited".to_string()),
        )
        .await;
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Codex,
        Some(codex.clone()),
        Some(opencode.clone()),
        None,
    );

    let threads = runtime
        .aggregate_thread_list(Some(json!({ "limit": 5 })))
        .await
        .expect("healthy OpenCode thread list survives dead Codex");
    assert_eq!(
        threads["data"][0]["id"],
        json!(encode_engine_qualified_id(
            BridgeRuntimeEngine::Opencode,
            "s1"
        ))
    );

    let loaded = runtime
        .aggregate_loaded_thread_ids()
        .await
        .expect("healthy OpenCode loaded threads survive dead Codex");
    assert_eq!(
        loaded["data"][0],
        json!(encode_engine_qualified_id(
            BridgeRuntimeEngine::Opencode,
            "s1"
        ))
    );

    stop_app_server_sink(&codex).await;
    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn aggregate_lists_report_when_every_ready_backend_fails() {
    let (server, opencode) = start_opencode_api(None).await;
    for path in ["experimental/session", "session", "session/status"] {
        server.state.failures.lock().await.insert(path.to_string());
    }
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Opencode,
        None,
        Some(opencode.clone()),
        None,
    );

    assert!(runtime
        .aggregate_thread_list(None)
        .await
        .expect_err("all-ready thread list failure")
        .contains("opencode"));
    assert!(runtime
        .aggregate_loaded_thread_ids()
        .await
        .expect_err("all-ready loaded thread list failure")
        .contains("opencode"));

    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn opencode_event_edge_cases_cover_fallbacks_duplicates_and_missing_fields() {
    let (_server, backend) = start_opencode_api(None).await;
    backend
        .cache_session_info(&json!({ "id": "fallback", "directory": "/cached" }))
        .await;

    for status in [
        json!({ "sessionID": "fallback", "status": {} }),
        json!({ "sessionID": "fallback", "status": { "type": "idle" } }),
        json!({ "sessionID": "fallback", "status": { "type": "busy" } }),
        json!({ "sessionID": "fallback", "status": { "type": "retry" } }),
        json!({ "sessionID": "fallback", "status": { "type": "idle" } }),
    ] {
        backend.handle_session_status_event(status).await;
    }
    backend
        .handle_session_error_event(json!({ "sessionID": "fallback", "error": {} }))
        .await;

    for part in [
        json!({ "part": { "sessionID": "fallback" } }),
        json!({ "part": { "sessionID": "fallback", "id": "missing-kind" } }),
        json!({ "part": { "sessionID": "fallback", "id": "reason", "type": "reasoning" } }),
        json!({ "part": { "sessionID": "fallback", "id": "reason", "type": "reasoning" } }),
        json!({ "part": { "sessionID": "fallback", "id": "tool", "type": "tool" } }),
        json!({
            "part": {
                "sessionID": "fallback",
                "id": "tool",
                "type": "tool",
                "tool": "edit_file",
                "state": { "status": "completed" }
            }
        }),
        json!({
            "part": {
                "sessionID": "fallback",
                "id": "tool",
                "type": "tool",
                "tool": "edit_file",
                "state": { "status": "completed" }
            }
        }),
    ] {
        backend.cache_message_part_kind(part).await;
    }

    for delta in [
        json!({ "sessionID": "fallback" }),
        json!({ "sessionID": "fallback", "partID": "reason" }),
        json!({ "sessionID": "fallback", "partID": "reason", "field": "text" }),
        json!({
            "sessionID": "fallback",
            "partID": "reason",
            "field": "text",
            "delta": ""
        }),
    ] {
        backend.handle_message_part_delta(delta).await;
    }

    for permission in [
        Value::Null,
        json!({}),
        json!({ "id": "p" }),
        json!({ "id": "p", "sessionID": "unknown" }),
    ] {
        backend.handle_permission_asked(permission, None).await;
    }
    backend
        .handle_permission_asked(
            json!({
                "id": "cached-permission",
                "sessionID": "fallback",
                "permission": "edit",
                "metadata": { "command": "touch file" }
            }),
            None,
        )
        .await;
    backend.handle_permission_replied(json!({})).await;
    backend
        .handle_permission_replied(json!({ "requestID": "missing" }))
        .await;
    backend
        .handle_permission_replied(json!({
            "requestID": "cached-permission",
            "reply": "reject"
        }))
        .await;

    for question in [
        Value::Null,
        json!({}),
        json!({ "id": "q" }),
        json!({ "id": "q", "sessionID": "unknown", "questions": [] }),
        json!({ "id": "q", "sessionID": "fallback" }),
        json!({
            "id": "q",
            "sessionID": "fallback",
            "questions": [{ "header": "Only header" }]
        }),
    ] {
        backend.handle_question_asked(question, None).await;
    }
    backend
        .handle_question_asked(
            json!({
                "id": "cached-question",
                "sessionID": "fallback",
                "questions": [{
                    "header": "Free form",
                    "question": "Answer",
                    "options": []
                }]
            }),
            None,
        )
        .await;
    backend.handle_question_resolved(json!({})).await;
    backend
        .handle_question_resolved(json!({ "requestID": "missing" }))
        .await;
    backend
        .handle_question_resolved(json!({ "requestID": "cached-question" }))
        .await;
    backend.cache_session_info(&json!({ "id": "no-dir" })).await;
    assert_eq!(backend.current_status_for_session("missing").await, None);

    stop_opencode_backend(&backend).await;
}

#[tokio::test]
async fn rollout_tracking_covers_metadata_polling_dedup_partial_and_removed_files() {
    let root = env::temp_dir().join(format!("clawdex-rollout-backends-{}", Uuid::new_v4()));
    fs::create_dir_all(&root)
        .await
        .expect("create rollout root");
    let missing = root.join("missing.jsonl");
    assert!(RolloutTrackedFile::new(missing.clone()).await.is_err());
    assert!(read_rollout_session_meta(&missing)
        .await
        .expect("missing metadata")
        .is_none());

    for (name, content) in [
        ("empty", ""),
        ("invalid", "not-json\n"),
        ("array", "[]\n"),
        ("wrong", "{\"type\":\"event_msg\",\"payload\":{}}\n"),
        ("no-payload", "{\"type\":\"session_meta\"}\n"),
        ("no-id", "{\"type\":\"session_meta\",\"payload\":{}}\n"),
    ] {
        let path = root.join(format!("{name}.jsonl"));
        fs::write(&path, content)
            .await
            .expect("write metadata variant");
        assert!(read_rollout_session_meta(&path)
            .await
            .expect("read metadata variant")
            .is_none());
    }

    let path = root.join("active.jsonl");
    let meta = json!({
        "type": "session_meta",
        "payload": { "id": "thread", "originator": "codex_cli_rs" }
    });
    fs::write(&path, format!("{meta}\n"))
        .await
        .expect("write active metadata");
    assert_eq!(
        read_rollout_session_meta(&path)
            .await
            .expect("active metadata"),
        Some(("thread".to_string(), Some("codex_cli_rs".to_string())))
    );
    let mut tracked = RolloutTrackedFile::new(path.clone())
        .await
        .expect("track rollout");
    assert!(tracked.include_for_live_sync);
    let hub = Arc::new(ClientHub::with_replay_capacity(16));
    let metrics = Arc::new(OperationalMetrics::new());
    let mut notifications = hub.subscribe_notifications();
    tracked.poll(&hub, &metrics).await.expect("unchanged poll");

    let event = json!({
        "timestamp": "2026-01-01T00:00:00Z",
        "type": "event_msg",
        "payload": { "type": "task_started", "thread_id": "thread" }
    });
    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .expect("open rollout append");
    file.write_all(format!("{event}\n{event}\n").as_bytes())
        .await
        .expect("append complete events");
    file.write_all(b"{\"type\":\"event_msg\"")
        .await
        .expect("append partial event");
    file.flush().await.expect("flush rollout");
    drop(file);
    tracked.poll(&hub, &metrics).await.expect("poll events");
    assert!(!tracked.partial_line.is_empty());
    assert!(notifications.try_recv().is_ok());

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .await
        .expect("reopen rollout append");
    file.write_all(b"}\n\n")
        .await
        .expect("finish partial event");
    file.flush().await.expect("flush partial event");
    drop(file);
    tracked
        .poll(&hub, &metrics)
        .await
        .expect("poll partial event");

    fs::write(&path, format!("{meta}\n"))
        .await
        .expect("truncate rollout");
    tracked
        .poll(&hub, &metrics)
        .await
        .expect("poll truncated rollout");
    assert_eq!(
        tracked.offset,
        fs::metadata(&path).await.expect("metadata").len()
    );

    for index in 0..=ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY {
        assert!(tracked.remember_line_hash(index as u64 + 10_000));
    }
    assert_eq!(
        tracked.recent_line_hashes.len(),
        ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY
    );
    assert!(!tracked.remember_line_hash(10_000 + ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY as u64));

    for malformed in [
        "not-json",
        "[]",
        "{}",
        "{\"type\":\"event_msg\"}",
        "{\"type\":\"event_msg\",\"payload\":{}}",
    ] {
        assert!(tracked.process_line(malformed).is_none());
    }
    tracked.include_for_live_sync = false;
    assert!(tracked
        .process_line(
            &json!({ "type": "event_msg", "payload": { "type": "task_complete" } }).to_string(),
        )
        .is_none());

    let mut state = RolloutLiveSyncState::default();
    state.files.insert(path.clone(), tracked);
    fs::remove_file(&path)
        .await
        .expect("remove tracked rollout");
    rollout_live_sync_poll_files(&hub, &mut state, &metrics)
        .await
        .expect("poll removed rollout");
    assert!(state.files.is_empty());
    let _ = fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn discover_rollout_files_handles_stale_files_and_non_files() {
    let root = env::temp_dir().join(format!("clawdex-discover-edge-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).await.expect("create root");

    // A fresh rollout file - should be included.
    let fresh = root.join("rollout-fresh.jsonl");
    fs::write(&fresh, "content\n").await.expect("write fresh");

    // A non-rollout file - should be skipped.
    fs::write(root.join("readme.txt"), "not a rollout")
        .await
        .expect("write non-rollout");

    let discovered = discover_recent_rollout_files(&root)
        .await
        .expect("discover files");
    assert!(discovered
        .iter()
        .any(|p| p.ends_with("rollout-fresh.jsonl")));
    assert!(!discovered.iter().any(|p| p.ends_with("readme.txt")));

    // Stale file: set mtime to epoch so it exceeds ROLLOUT_LIVE_SYNC_MAX_FILE_AGE.
    let stale = root.join("rollout-stale.jsonl");
    fs::write(&stale, "old content\n")
        .await
        .expect("write stale");
    #[cfg(unix)]
    {
        let path_cstr = std::ffi::CString::new(stale.to_str().unwrap()).unwrap();
        let old_time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        unsafe {
            libc::utimensat(
                libc::AT_FDCWD,
                path_cstr.as_ptr(),
                [old_time, old_time].as_ptr(),
                0,
            )
        };
    }
    let discovered2 = discover_recent_rollout_files(&root)
        .await
        .expect("discover after stale");
    #[cfg(unix)]
    assert!(!discovered2
        .iter()
        .any(|p| p.ends_with("rollout-stale.jsonl")));

    let _ = fs::remove_dir_all(root).await;
}

#[cfg(unix)]
#[tokio::test]
async fn discover_rollout_files_handles_subdirectory_recursion_and_missing_dir() {
    use std::os::unix::fs::symlink;
    let root = env::temp_dir().join(format!("clawdex-discover-subdir-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).await.expect("create root");

    // Real subdirectory with a rollout file — exercises is_dir() true branch.
    let subdir = root.join("nested");
    fs::create_dir_all(&subdir).await.expect("create subdir");
    fs::write(subdir.join("rollout-nested.jsonl"), "content\n")
        .await
        .expect("write nested rollout");

    // Dangling symlink: looks like a dir in listing but read_dir returns NotFound.
    let dangling = root.join("dangling_dir");
    symlink(root.join("__nonexistent__"), &dangling).expect("create dangling symlink");

    let discovered = discover_recent_rollout_files(&root)
        .await
        .expect("discover with dangling symlink");
    assert!(discovered
        .iter()
        .any(|p| p.ends_with("rollout-nested.jsonl")));

    let _ = fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn aggregate_thread_list_with_bridge_cursor_covers_per_engine_cursor_branches() {
    use base64::{engine::general_purpose, Engine};

    let (_server, opencode) = start_opencode_api(None).await;
    let codex = app_server_sink(BridgeRuntimeEngine::Codex, Duration::from_millis(20)).await;
    codex
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Codex,
        Some(codex.clone()),
        Some(opencode.clone()),
        None,
    );

    // Construct a bridge cursor that references codex and opencode engines.
    let cursor_json = serde_json::json!({
        "codex": "codex-cursor-value",
        "opencode": "opencode-cursor-value"
    });
    let encoded = general_purpose::URL_SAFE_NO_PAD.encode(cursor_json.to_string().as_bytes());
    let bridge_cursor = format!("bridge:{encoded}");

    // Call thread/list with bridge cursor — exercises aggregate_thread_list cursor code paths.
    let _ = runtime
        .request_internal(
            "thread/list",
            Some(json!({ "cursor": bridge_cursor, "limit": 5 })),
        )
        .await;

    // Call without cursor — exercises the non-cursor branches.
    let _ = runtime
        .request_internal("thread/list", Some(json!({ "limit": 5 })))
        .await;

    // thread/loaded/list exercises aggregate_loaded_thread_ids.
    let _ = runtime.request_internal("thread/loaded/list", None).await;

    stop_app_server_sink(&codex).await;
    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn opencode_health_check_and_event_loop_cover_wait_until_healthy_branches() {
    let (_server, backend) = start_opencode_api(None).await;

    // Directly call wait_until_healthy — the mock server returns { "healthy": true },
    // so this immediately succeeds, exercising the Ok(health) && healthy=true branch.
    backend
        .wait_until_healthy()
        .await
        .expect("health check should succeed");

    // child_has_exited: the spawned sleep process should still be running.
    assert!(!backend.child_has_exited().await);

    stop_opencode_backend(&backend).await;

    // After the child is killed, child_has_exited returns true.
    assert!(backend.child_has_exited().await);
}

#[tokio::test]
async fn runtime_backend_multi_engine_dispatch_covers_opencode_approval_and_input_paths() {
    let (_server, opencode) = start_opencode_api(None).await;
    let codex = app_server_sink(BridgeRuntimeEngine::Codex, Duration::from_millis(20)).await;
    codex
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Codex,
        Some(codex.clone()),
        Some(opencode.clone()),
        None,
    );

    // list_pending_approvals/inputs through RuntimeBackend with both codex and opencode.
    let approvals = runtime.list_pending_approvals().await;
    assert!(approvals.is_empty());

    let inputs = runtime.list_pending_user_inputs().await;
    assert!(inputs.is_empty());

    // resolve_approval: not found in either backend.
    let resolved = runtime
        .resolve_approval("missing-approval", &json!("accept"))
        .await
        .expect("resolve_approval Ok(None) for missing");
    assert!(resolved.is_none());

    // resolve_user_input: not found.
    let resolved_input = runtime
        .resolve_user_input("missing-input", &HashMap::new())
        .await
        .expect("resolve_user_input Ok(None) for missing");
    assert!(resolved_input.is_none());

    // aggregate_loaded_thread_ids via request_internal.
    let _ = runtime.request_internal("thread/loaded/list", None).await;

    stop_app_server_sink(&codex).await;
    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn opencode_only_runtime_covers_aggregate_thread_list_opencode_branches() {
    use base64::{engine::general_purpose, Engine};

    let (_server, opencode) = start_opencode_api(None).await;

    // Runtime with ONLY opencode — no codex/cursor.
    // This ensures aggregate_thread_list reaches the opencode dispatch branches.
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Opencode,
        None,
        Some(opencode.clone()),
        None,
    );

    // thread/list without cursor — exercises opencode-only non-cursor branch.
    let _ = runtime
        .request_internal("thread/list", Some(json!({ "limit": 5 })))
        .await;

    // thread/list with an opencode bridge cursor.
    let cursor_json = serde_json::json!({ "opencode": "opencode-cursor" });
    let encoded = general_purpose::URL_SAFE_NO_PAD.encode(cursor_json.to_string().as_bytes());
    let bridge_cursor = format!("bridge:{encoded}");
    let _ = runtime
        .request_internal(
            "thread/list",
            Some(json!({ "cursor": bridge_cursor, "limit": 5 })),
        )
        .await;

    // thread/loaded/list — exercises opencode aggregate_loaded_thread_ids.
    let _ = runtime.request_internal("thread/loaded/list", None).await;

    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn cursor_backend_aggregate_covers_thread_list_and_loaded_branches() {
    use base64::{engine::general_purpose, Engine};

    let cursor = app_server_sink(BridgeRuntimeEngine::Cursor, Duration::from_millis(20)).await;
    cursor
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;

    // Runtime with ONLY cursor — exercises cursor-specific aggregate branches.
    let runtime = runtime_backend(
        BridgeRuntimeEngine::Cursor,
        None,
        None,
        Some(cursor.clone()),
    );

    // thread/list without cursor.
    let _ = runtime
        .request_internal("thread/list", Some(json!({ "limit": 5 })))
        .await;

    // thread/list with a cursor bridge cursor.
    let cursor_json = serde_json::json!({ "cursor": "cursor-value" });
    let encoded = general_purpose::URL_SAFE_NO_PAD.encode(cursor_json.to_string().as_bytes());
    let bridge_cursor = format!("bridge:{encoded}");
    let _ = runtime
        .request_internal(
            "thread/list",
            Some(json!({ "cursor": bridge_cursor, "limit": 5 })),
        )
        .await;

    // thread/loaded/list.
    let _ = runtime.request_internal("thread/loaded/list", None).await;

    // list_pending_approvals and inputs through RuntimeBackend with cursor.
    let _ = runtime.list_pending_approvals().await;
    let _ = runtime.list_pending_user_inputs().await;
    let _ = runtime.resolve_approval("missing", &json!("accept")).await;
    let _ = runtime.resolve_user_input("missing", &HashMap::new()).await;

    stop_app_server_sink(&cursor).await;
}

#[tokio::test]
async fn runtime_backend_start_with_stub_covers_codex_and_cursor_startup_paths() {
    // Path to the Python stub that handles the app-server JSON-RPC initialize handshake.
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        eprintln!("test_app_server_stub.py not found, skipping startup coverage");
        return;
    }

    let stub_path = stub.to_string_lossy().to_string();
    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());

    // start_codex with the stub exercises RuntimeBackend::start() codex paths.
    let codex = AppServerBridge::start_codex(&stub_path, hub.clone(), metrics.clone())
        .await
        .expect("start codex with stub");
    assert!(codex.lifecycle.is_ready());

    // Create a RuntimeBackend with the stub-backed codex — exercises store_codex_backend.
    // Also verify request_internal reaches the codex dispatch.
    let runtime = runtime_backend(BridgeRuntimeEngine::Codex, Some(codex.clone()), None, None);
    let _ = runtime.request_internal("thread/list", None).await;
    let _ = runtime.request_internal("thread/loaded/list", None).await;

    // Shut down via request_shutdown which sends SIGTERM to the process group.
    codex.request_shutdown().await;
    // Brief wait for background wait_loop to process exit.
    tokio::time::sleep(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn runtime_backend_start_covers_store_codex_backend_and_startup_paths() {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        eprintln!("test_app_server_stub.py not found, skipping RuntimeBackend::start coverage");
        return;
    }
    let stub_path = stub.to_string_lossy().to_string();

    let workdir = env::temp_dir().join(format!("clawdex-start-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&workdir).await.expect("create workdir");

    let config = Arc::new(BridgeConfig {
        host: "127.0.0.1".to_string(),
        port: 9000,
        preview_host: "127.0.0.1".to_string(),
        preview_port: 9001,
        connect_url: None,
        preview_connect_url: None,
        workdir: workdir.clone(),
        cli_bin: stub_path.clone(),
        opencode_cli_bin: "false".to_string(),
        cursor_app_server_bin: "false".to_string(),
        active_engine: BridgeRuntimeEngine::Codex,
        enabled_engines: vec![BridgeRuntimeEngine::Codex],
        opencode_host: "127.0.0.1".to_string(),
        opencode_port: 9002,
        opencode_server_username: "test".to_string(),
        opencode_server_password: None,
        auth_token: None,
        auth_enabled: false,
        allow_insecure_no_auth: true,
        no_auth_allowed_origins: HashSet::new(),
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

    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());

    // RuntimeBackend::start() with Codex-only config — exercises store_codex_backend.
    let backend = RuntimeBackend::start(&config, hub.clone(), metrics.clone())
        .await
        .expect("start RuntimeBackend with stub");
    assert!(!backend.available_engines().is_empty());

    backend.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = fs::remove_dir_all(workdir).await;
}

#[tokio::test]
async fn restart_codex_app_server_covers_store_codex_and_replace_paths() {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        return;
    }
    let stub_path = stub.to_string_lossy().to_string();

    let workdir = env::temp_dir().join(format!("clawdex-restart-test-{}", Uuid::new_v4()));
    fs::create_dir_all(&workdir).await.expect("create workdir");

    let config = Arc::new(BridgeConfig {
        host: "127.0.0.1".to_string(),
        port: 9010,
        preview_host: "127.0.0.1".to_string(),
        preview_port: 9011,
        connect_url: None,
        preview_connect_url: None,
        workdir: workdir.clone(),
        cli_bin: stub_path,
        opencode_cli_bin: "false".to_string(),
        cursor_app_server_bin: "false".to_string(),
        active_engine: BridgeRuntimeEngine::Codex,
        enabled_engines: vec![BridgeRuntimeEngine::Codex],
        opencode_host: "127.0.0.1".to_string(),
        opencode_port: 9012,
        opencode_server_username: "test".to_string(),
        opencode_server_password: None,
        auth_token: None,
        auth_enabled: false,
        allow_insecure_no_auth: true,
        no_auth_allowed_origins: HashSet::new(),
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

    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());
    let backend = RuntimeBackend::start(&config, hub.clone(), metrics.clone())
        .await
        .expect("start for restart test");

    // restart_codex_app_server: replaces the existing codex backend with a new one.
    // This exercises store_codex_backend and the if-let Some(previous_backend) path.
    backend
        .restart_codex_app_server(&config, hub.clone())
        .await
        .expect("restart codex app server");

    backend.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = fs::remove_dir_all(workdir).await;
}

#[tokio::test]
async fn runtime_backend_start_with_failing_secondary_engines_covers_error_branches() {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        return;
    }
    let stub_path = stub.to_string_lossy().to_string();
    let workdir = env::temp_dir().join(format!("clawdex-start-multi-{}", Uuid::new_v4()));
    fs::create_dir_all(&workdir).await.expect("create workdir");
    // Pick a random port for OpenCode by binding briefly.
    let opencode_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind for opencode port");
    let opencode_port = opencode_listener.local_addr().unwrap().port();
    drop(opencode_listener); // Release the port for the stub to bind.
    let config = Arc::new(BridgeConfig {
        host: "127.0.0.1".to_string(),
        port: 9020,
        preview_host: "127.0.0.1".to_string(),
        preview_port: 9021,
        connect_url: None,
        preview_connect_url: None,
        workdir: workdir.clone(),
        cli_bin: stub_path.clone(),
        opencode_cli_bin: stub_path.clone(), // stub starts HTTP server in "serve" mode
        cursor_app_server_bin: "false".to_string(), // cursor will still fail (no binary)
        active_engine: BridgeRuntimeEngine::Codex,
        enabled_engines: vec![
            BridgeRuntimeEngine::Codex,
            BridgeRuntimeEngine::Opencode,
            BridgeRuntimeEngine::Cursor,
        ],
        opencode_host: "127.0.0.1".to_string(),
        opencode_port, // stub will bind here in serve mode
        opencode_server_username: "test".to_string(),
        opencode_server_password: None,
        auth_token: None,
        auth_enabled: false,
        allow_insecure_no_auth: true,
        no_auth_allowed_origins: HashSet::new(),
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
    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());
    let backend = RuntimeBackend::start(&config, hub, metrics)
        .await
        .expect("start despite secondary engine failures");
    let available = backend.available_engines();
    assert!(available.contains(&BridgeRuntimeEngine::Codex));
    assert!(!available.contains(&BridgeRuntimeEngine::Cursor)); // "false" binary can't start cursor
                                                                // Opencode may or may not be available depending on whether the stub started fast enough.
    backend.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = fs::remove_dir_all(workdir).await;
}

/// Helper to build a BridgeConfig pointing to the Python stub for all engine binaries.
async fn stub_bridge_config(stub_path: String, port: u16) -> Arc<BridgeConfig> {
    let workdir = env::temp_dir().join(format!("clawdex-stub-config-{}", Uuid::new_v4()));
    fs::create_dir_all(&workdir).await.expect("create workdir");
    // Get a free opencode port.
    let opencode_listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind opencode port");
    let opencode_port = opencode_listener.local_addr().unwrap().port();
    drop(opencode_listener);
    Arc::new(BridgeConfig {
        host: "127.0.0.1".to_string(),
        port,
        preview_host: "127.0.0.1".to_string(),
        preview_port: port + 1,
        connect_url: None,
        preview_connect_url: None,
        workdir,
        cli_bin: stub_path.clone(),
        opencode_cli_bin: stub_path.clone(),
        cursor_app_server_bin: stub_path.clone(),
        active_engine: BridgeRuntimeEngine::Codex, // overridden by caller
        enabled_engines: vec![BridgeRuntimeEngine::Codex],
        opencode_host: "127.0.0.1".to_string(),
        opencode_port,
        opencode_server_username: "test".to_string(),
        opencode_server_password: None,
        auth_token: None,
        auth_enabled: false,
        allow_insecure_no_auth: true,
        no_auth_allowed_origins: HashSet::new(),
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
    })
}

#[tokio::test]
async fn runtime_backend_opencode_preferred_start_covers_opencode_primary_branches() {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        return;
    }
    let stub_path = stub.to_string_lossy().to_string();
    let mut config = (*stub_bridge_config(stub_path, 9030).await).clone();
    config.active_engine = BridgeRuntimeEngine::Opencode;
    config.enabled_engines = vec![BridgeRuntimeEngine::Opencode, BridgeRuntimeEngine::Codex];
    // Set a password so consume_global_events exercises the basic_auth branch.
    config.opencode_server_password = Some("test-pass".to_string());
    let config = Arc::new(config);
    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());
    let backend = RuntimeBackend::start(&config, hub, metrics)
        .await
        .expect("start opencode-preferred backend");
    let available = backend.available_engines();
    assert!(available.contains(&BridgeRuntimeEngine::Opencode));
    // Brief wait to let spawn_global_event_loop run once and exercise consume_global_events.
    tokio::time::sleep(Duration::from_millis(100)).await;
    backend.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test]
async fn runtime_backend_cursor_preferred_start_covers_cursor_primary_branches() {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        return;
    }
    let stub_path = stub.to_string_lossy().to_string();
    let mut config = (*stub_bridge_config(stub_path, 9040).await).clone();
    config.active_engine = BridgeRuntimeEngine::Cursor;
    config.enabled_engines = vec![BridgeRuntimeEngine::Cursor, BridgeRuntimeEngine::Codex];
    let config = Arc::new(config);
    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());
    // CURSOR_API_KEY is required for cursor startup.
    std::env::set_var("CURSOR_API_KEY", "test-api-key-for-coverage");
    let backend = RuntimeBackend::start(&config, hub, metrics)
        .await
        .expect("start cursor-preferred backend");
    std::env::remove_var("CURSOR_API_KEY");
    let available = backend.available_engines();
    assert!(available.contains(&BridgeRuntimeEngine::Cursor));
    backend.shutdown().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
}

#[tokio::test]
async fn runtime_backend_resolve_with_pending_approvals_covers_some_result_branches() {
    let (_server, opencode) = start_opencode_api(None).await;
    let cursor = app_server_sink(BridgeRuntimeEngine::Cursor, Duration::from_millis(20)).await;
    cursor
        .lifecycle
        .transition(BackendLifecycleState::Ready, None)
        .await;

    // Inject a pending approval into the opencode backend.
    opencode.pending_approvals.lock().await.insert(
        "open-approval".to_string(),
        OpencodePendingApprovalEntry {
            approval: sample_pending_approval("open-approval"),
            directory: "/repo".to_string(),
        },
    );

    // Inject a pending user input into the cursor backend.
    cursor.pending_user_inputs.lock().await.insert(
        "cursor-input".to_string(),
        PendingUserInputEntry {
            app_server_request_id: json!(99),
            request: sample_pending_input("cursor-input"),
        },
    );

    let runtime = runtime_backend(
        BridgeRuntimeEngine::Codex,
        None,
        Some(opencode.clone()),
        Some(cursor.clone()),
    );

    // resolve_approval through RuntimeBackend — opencode backend has the approval.
    let resolved = runtime
        .resolve_approval("open-approval", &json!("accept"))
        .await
        .expect("resolve_approval Ok");
    // The approval ID is "open-approval" — the resolution writes to the mock server
    // which may return an error, but the resolution attempt exercises the Some(approval) branch.
    let _ = resolved; // may be Some or None depending on server response

    // list_pending_approvals — exercised when opencode has a pending approval.
    let approvals = runtime.list_pending_approvals().await;
    // (approval may already be resolved or still present)
    let _ = approvals;

    // resolve_user_input through RuntimeBackend — cursor has the pending input.
    let answers = {
        let mut m = HashMap::new();
        m.insert(
            "cursor-input:0".to_string(),
            UserInputAnswerPayload {
                answers: vec!["response".to_string()],
            },
        );
        m
    };
    let resolved_input = runtime
        .resolve_user_input("cursor-input", &answers)
        .await
        .expect("resolve_user_input Ok");
    let _ = resolved_input;

    stop_app_server_sink(&cursor).await;
    stop_opencode_backend(&opencode).await;
}

#[tokio::test]
async fn rollout_live_sync_with_sessions_root_covers_spawn_discovery_and_poll_branches() {
    // Create a temporary sessions root with rollout files to exercise spawn_rollout_live_sync.
    let home = env::temp_dir().join(format!("clawdex-codex-home-{}", Uuid::new_v4()));
    let sessions_root = home.join("sessions");
    fs::create_dir_all(&sessions_root)
        .await
        .expect("create sessions root");

    // Write a valid rollout file.
    let rollout = sessions_root.join("rollout-test-session.jsonl");
    let meta = serde_json::json!({
        "type": "session_meta",
        "payload": { "id": "test-session", "originator": "codex_cli_rs" }
    });
    fs::write(&rollout, format!("{meta}\n"))
        .await
        .expect("write rollout");

    // Set CODEX_HOME so resolve_codex_sessions_root returns our directory.
    std::env::set_var("CODEX_HOME", &home);

    let hub = Arc::new(ClientHub::with_replay_capacity(16));
    let metrics = Arc::new(OperationalMetrics::new());

    // spawn_rollout_live_sync is the function we want to exercise.
    spawn_rollout_live_sync(hub.clone(), metrics.clone());

    // Wait for the background task to run at least one poll cycle (900ms interval).
    tokio::time::sleep(Duration::from_millis(1200)).await;

    std::env::remove_var("CODEX_HOME");

    // Verify live sync metrics were updated.
    let snapshot = metrics.live_sync_snapshot();
    assert!(
        snapshot.poll_runs > 0,
        "rollout poll should have run at least once"
    );

    let _ = fs::remove_dir_all(home).await;
}

#[tokio::test]
async fn transient_thread_read_error_triggers_retry_in_request_internal() {
    let stub = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("test_app_server_stub.py");
    if !stub.exists() {
        return;
    }
    let stub_path = stub.to_string_lossy().to_string();
    let hub = Arc::new(ClientHub::with_replay_capacity(8));
    let metrics = Arc::new(OperationalMetrics::new());

    // Start a bridge with STUB_TRANSIENT_ERROR_COUNT=2 — the stub will return
    // transient errors for the first 2 thread/read requests, then succeed.
    // This exercises the retry loop at lines 3727-3729 in request_internal.
    let codex = {
        let mut cmd = tokio::process::Command::new(&stub_path);
        cmd.arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .env("STUB_TRANSIENT_ERROR_COUNT", "2")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        AppServerBridge::start_with_command(cmd, BridgeRuntimeEngine::Codex, hub, metrics)
            .await
            .expect("start stub bridge for transient error test")
    };

    // thread/read should succeed after retries.
    let result = codex
        .request_internal("thread/read", Some(json!({ "threadId": "test" })))
        .await;
    assert!(
        result.is_ok(),
        "thread/read should succeed after transient retries: {:?}",
        result
    );

    codex.request_shutdown().await;
    tokio::time::sleep(Duration::from_millis(200)).await;
}
