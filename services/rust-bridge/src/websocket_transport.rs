use crate::*;

pub(super) fn protected_request_error(
    config: &BridgeConfig,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Option<Response> {
    if !config.is_browser_origin_allowed(headers) {
        return Some(
            (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "error": "forbidden_origin",
                    "message": "Browser origin is not allowed in no-auth mode"
                })),
            )
                .into_response(),
        );
    }
    if !config.is_authorized(headers, query_token) {
        return Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": "unauthorized",
                    "message": "Missing or invalid bridge credentials"
                })),
            )
                .into_response(),
        );
    }

    None
}

pub(super) async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    client_metadata: ClientConnectionMetadata,
) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(WS_CLIENT_QUEUE_CAPACITY);
    let client_in_flight = Arc::new(Semaphore::new(state.config.ws_limits.per_client_in_flight));
    let client_id = state
        .hub
        .add_client_with_metadata(tx, client_metadata)
        .await;
    state.backend.register_client(client_id);

    let mut writer_task = tokio::spawn(async move {
        while let Some(message) = rx.recv().await {
            if socket_tx.send(message).await.is_err() {
                break;
            }
        }
    });

    state
        .hub
        .send_json(client_id, state.hub.connection_state_payload())
        .await;

    loop {
        tokio::select! {
            writer_result = &mut writer_task => {
                if let Err(error) = writer_result {
                    eprintln!("websocket writer task error: {error}");
                }
                break;
            }
            maybe_message = socket_rx.next() => {
                let Some(message) = maybe_message else {
                    break;
                };

                match message {
                    Ok(Message::Text(text)) => {
                        let request_id = parse_client_request_id(&text);
                        let client_permit = match client_in_flight.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                send_overload_error(
                                    &state,
                                    client_id,
                                    request_id,
                                    "client_in_flight_requests",
                                    state.config.ws_limits.per_client_in_flight,
                                )
                                .await;
                                continue;
                            }
                        };
                        let global_permit = match state.ws_global_in_flight.clone().try_acquire_owned() {
                            Ok(permit) => permit,
                            Err(_) => {
                                drop(client_permit);
                                send_overload_error(
                                    &state,
                                    client_id,
                                    request_id,
                                    "global_in_flight_requests",
                                    state.config.ws_limits.global_in_flight,
                                )
                                .await;
                                continue;
                            }
                        };
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            handle_client_message(
                                client_id,
                                text.to_string(),
                                &state,
                                Some(InFlightRequestPermits {
                                    _client: client_permit,
                                    _global: global_permit,
                                }),
                            )
                            .await;
                        });
                    }
                    Ok(Message::Close(_)) => break,
                    Ok(Message::Binary(_)) => {
                        state
                            .hub
                            .send_json(
                                client_id,
                                json!({
                                    "id": Value::Null,
                                    "error": {
                                        "code": -32600,
                                        "message": "Binary websocket messages are not supported"
                                    }
                                }),
                            )
                            .await;
                    }
                    Ok(Message::Ping(payload)) => {
                        state
                            .hub
                            .send_json(
                                client_id,
                                json!({
                                    "method": "bridge/ping",
                                    "params": {
                                        "size": payload.len()
                                    }
                                }),
                            )
                            .await;
                    }
                    Ok(Message::Pong(_)) => {}
                    Err(error) => {
                        eprintln!("websocket error: {error}");
                        break;
                    }
                }
            }
        }
    }

    cancel_client_thread_list_streams(&state, client_id).await;
    state.hub.remove_client(client_id).await;
    state.backend.cancel_client_requests(client_id).await;
    state.preview.revoke_owner(client_id).await;
    if !writer_task.is_finished() {
        writer_task.abort();
    }
}

pub(super) async fn handle_client_message(
    client_id: u64,
    text: String,
    state: &Arc<AppState>,
    permits: Option<InFlightRequestPermits>,
) {
    state.hub.mark_client_seen(client_id).await;

    let request = match parse_request(&text) {
        Ok(request) => request,
        Err(RpcRequestParseError::InvalidJson(error)) => {
            send_rpc_error(
                state,
                client_id,
                Value::Null,
                -32700,
                &format!("Parse error: {error}"),
                None,
            )
            .await;
            return;
        }
        Err(RpcRequestParseError::InvalidPayload) => {
            send_rpc_error(
                state,
                client_id,
                Value::Null,
                -32600,
                "Invalid request payload",
                None,
            )
            .await;
            return;
        }
        Err(RpcRequestParseError::MissingMethod { id }) => {
            send_rpc_error(state, client_id, id, -32600, "Missing method", None).await;
            return;
        }
        Err(RpcRequestParseError::Notification) => return,
    };
    let id = request.id;
    let method = request.method;
    let params = request.params;

    if method.starts_with("bridge/") {
        let trace = state.metrics.start_request(&method, "bridge");
        match handle_bridge_method(&method, params, state, client_id).await {
            Ok(result) => {
                state.metrics.finish_request(&trace, "ok");
                state
                    .hub
                    .send_json(client_id, json!({ "id": id, "result": result }))
                    .await;
            }
            Err(error) => {
                state.metrics.finish_request(&trace, "bridge_error");
                state.metrics.record_error(
                    Some(&trace.request_id),
                    Some(&method),
                    Some("bridge"),
                    "bridge_error",
                );
                send_rpc_error(state, client_id, id, error.code, &error.message, error.data).await;
            }
        }
        return;
    }

    if !is_forwarded_method(&method) {
        send_rpc_error(
            state,
            client_id,
            id,
            -32601,
            &format!("Method not allowed: {method}"),
            None,
        )
        .await;
        return;
    }

    let params = match normalize_forwarded_path_params(params, &state.path_policy) {
        Ok(params) => params,
        Err(error) => {
            send_rpc_error(state, client_id, id, error.code, &error.message, error.data).await;
            return;
        }
    };

    if let Err(error) = state
        .backend
        .forward_request(client_id, id.clone(), &method, params, permits)
        .await
    {
        send_rpc_error(state, client_id, id, -32000, &error, None).await;
    }
}

pub(super) async fn handle_bridge_method(
    method: &str,
    params: Option<Value>,
    state: &Arc<AppState>,
    client_id: u64,
) -> Result<Value, BridgeError> {
    match method {
        "bridge/health/read" => serde_json::to_value(state.bridge_status().await)
            .map_err(|error| BridgeError::server(&error.to_string())),
        "bridge/status/read" => serde_json::to_value(state.bridge_status().await)
            .map_err(|error| BridgeError::server(&error.to_string())),
        "bridge/capabilities/read" => serde_json::to_value(state.bridge_capabilities())
            .map_err(|error| BridgeError::server(&error.to_string())),
        "bridge/push/register" => {
            let params = params.unwrap_or_else(|| json!({}));
            let profile_id = required_push_id(&params, "profileId")?;
            let registration_id = required_push_id(&params, "registrationId")?;
            let token = read_string(params.get("token"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| BridgeError::invalid_params("push token is required"))?;
            let platform = read_string(params.get("platform"))
                .map(|value| value.trim().to_lowercase())
                .unwrap_or_else(|| "unknown".to_string());
            let device_name = read_string(params.get("deviceName"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Unknown device".to_string());
            let events = parse_push_event_preferences(params.get("events"));
            if token.len() > PUSH_TOKEN_MAX_BYTES {
                return Err(BridgeError::resource_limit(
                    "push_token_bytes",
                    PUSH_TOKEN_MAX_BYTES,
                    token.len(),
                ));
            }
            if platform.len() > PUSH_PLATFORM_MAX_BYTES {
                return Err(BridgeError::resource_limit(
                    "push_platform_bytes",
                    PUSH_PLATFORM_MAX_BYTES,
                    platform.len(),
                ));
            }
            if device_name.len() > PUSH_DEVICE_NAME_MAX_BYTES {
                return Err(BridgeError::resource_limit(
                    "push_device_name_bytes",
                    PUSH_DEVICE_NAME_MAX_BYTES,
                    device_name.len(),
                ));
            }
            let count = state
                .push
                .register(
                    profile_id,
                    registration_id,
                    token,
                    platform,
                    device_name,
                    events,
                )
                .await?;
            Ok(json!({ "ok": true, "deviceCount": count }))
        }
        "bridge/push/unregister" => {
            let params = params.unwrap_or_else(|| json!({}));
            let profile_id = required_push_id(&params, "profileId")?;
            let registration_id = required_push_id(&params, "registrationId")?;
            let removed = state.push.unregister(&profile_id, &registration_id).await?;
            Ok(json!({ "ok": true, "removed": removed }))
        }
        "bridge/push/list" => Ok(json!({ "devices": state.push.list().await })),
        "bridge/browser/session/create" => {
            let request: BrowserPreviewCreateRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let session = state
                .preview
                .create_session(client_id, &request.target_url)
                .await?;
            serde_json::to_value(session).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/browser/sessions/list" => {
            let sessions = state.preview.list_sessions(client_id).await;
            serde_json::to_value(json!({ "sessions": sessions }))
                .map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/browser/session/close" => {
            let request: BrowserPreviewCloseRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let session_id = request.session_id.trim();
            if session_id.is_empty() {
                return Err(BridgeError::invalid_params("sessionId must not be empty"));
            }
            Ok(json!({
                "closed": state.preview.close_session(client_id, session_id).await,
            }))
        }
        "bridge/browser/targets/discover" => {
            let result = state.preview.discover_targets().await;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/events/replay" => {
            let request: EventReplayRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let limit = request
                .limit
                .unwrap_or(200)
                .clamp(1, NOTIFICATION_REPLAY_MAX_LIMIT);
            let replay = state
                .hub
                .replay_snapshot(request.after_event_id, limit)
                .await;

            Ok(json!({
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "streamId": state.hub.stream_id(),
                "events": replay.events,
                "hasMore": replay.has_more,
                "truncatedByBytes": replay.has_more && replay.events.len() < limit,
                "returnedBytes": replay.returned_bytes,
                "maxBytes": REPLAY_RESPONSE_MAX_BYTES,
                "earliestEventId": replay.earliest_event_id,
                "latestEventId": replay.latest_event_id,
            }))
        }
        "bridge/ui/present" | "bridge/ui/update" => {
            let surface: BridgeUiSurface =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            validate_bridge_ui_surface(&surface)?;
            let method = if method == "bridge/ui/present" {
                "bridge/ui.present"
            } else {
                "bridge/ui.update"
            };
            let surface_value = serde_json::to_value(&surface)
                .map_err(|error| BridgeError::server(&error.to_string()))?;
            state
                .hub
                .broadcast_notification(method, surface_value.clone())
                .await;
            Ok(json!({
                "ok": true,
                "surface": surface_value,
            }))
        }
        "bridge/ui/dismiss" => {
            let request: DismissBridgeUiSurfaceRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            if request.id.trim().is_empty() {
                return Err(BridgeError::invalid_params("id must not be empty"));
            }

            state
                .hub
                .broadcast_notification(
                    "bridge/ui.dismiss",
                    json!({
                        "id": request.id,
                        "threadId": request.thread_id,
                    }),
                )
                .await;
            Ok(json!({
                "ok": true,
                "id": request.id,
                "threadId": request.thread_id,
            }))
        }
        "bridge/ui/resolve" => {
            let request: ResolveBridgeUiSurfaceRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            if request.id.trim().is_empty() {
                return Err(BridgeError::invalid_params("id must not be empty"));
            }
            if request.thread_id.trim().is_empty() {
                return Err(BridgeError::invalid_params("threadId must not be empty"));
            }
            if request.action_id.trim().is_empty() {
                return Err(BridgeError::invalid_params("actionId must not be empty"));
            }

            state
                .hub
                .broadcast_notification(
                    "bridge/ui.resolved",
                    json!({
                        "id": request.id,
                        "threadId": request.thread_id,
                        "turnId": request.turn_id,
                        "actionId": request.action_id,
                        "resolvedAt": now_iso(),
                    }),
                )
                .await;
            Ok(json!({
                "ok": true,
                "id": request.id,
                "threadId": request.thread_id,
                "actionId": request.action_id,
            }))
        }
        "bridge/thread/list/stream/start" => {
            let request: ThreadListStreamStartRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            start_thread_list_stream(state, client_id, request).await
        }
        "bridge/thread/list/stream/cancel" => {
            let request: ThreadListStreamCancelRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            cancel_thread_list_stream(state, client_id, &request.stream_id).await
        }
        "bridge/thread/create" => {
            let mut request: BridgeThreadCreateRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            request.submission_id = request.submission_id.trim().to_string();
            if request.submission_id.is_empty() {
                return Err(BridgeError::invalid_params(
                    "submissionId must not be empty",
                ));
            }
            let _create_guard = state.thread_create_actor.lock().await;
            if let Some(result) = state
                .thread_create_results
                .lock()
                .await
                .get(&request.submission_id)
                .cloned()
            {
                return serde_json::to_value(result)
                    .map_err(|error| BridgeError::server(&error.to_string()));
            }
            request.thread_start =
                normalize_forwarded_path_params(Some(request.thread_start), &state.path_policy)?
                    .ok_or_else(|| {
                        BridgeError::invalid_params("threadStart payload is required")
                    })?;
            let started = state
                .backend
                .request_for_client(client_id, "thread/start", Some(request.thread_start))
                .await
                .map_err(|error| BridgeError::server(&error))?;
            let response = BridgeThreadCreateResponse {
                submission_id: request.submission_id.clone(),
                thread: started
                    .get("thread")
                    .cloned()
                    .ok_or_else(|| BridgeError::server("thread/start did not return thread"))?,
            };
            let mut results = state.thread_create_results.lock().await;
            let mut order = state.thread_create_order.lock().await;
            results.insert(request.submission_id.clone(), response.clone());
            order.push_back(request.submission_id);
            while order.len() > SUBMISSION_DEDUPE_LIMIT {
                if let Some(oldest) = order.pop_front() {
                    results.remove(&oldest);
                }
            }
            serde_json::to_value(response).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/read" => {
            let request: BridgeThreadQueueReadRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            serde_json::to_value(state.queue.read_queue(&request.thread_id).await)
                .map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/send" => {
            let mut request: BridgeThreadQueueSendRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            request.turn_start =
                normalize_forwarded_path_params(Some(request.turn_start), &state.path_policy)?
                    .ok_or_else(|| BridgeError::invalid_params("turnStart payload is required"))?;
            let content_bytes = request.content.trim().len();
            if content_bytes > QUEUE_MAX_CONTENT_BYTES {
                return Err(BridgeError::resource_limit(
                    "queue_content_bytes",
                    QUEUE_MAX_CONTENT_BYTES,
                    content_bytes,
                ));
            }
            let item_bytes = serde_json::to_vec(&request.turn_start)
                .map(|value| value.len())
                .unwrap_or(usize::MAX)
                .saturating_add(content_bytes);
            if item_bytes > QUEUE_MAX_ITEM_BYTES {
                return Err(BridgeError::resource_limit(
                    "queue_item_bytes",
                    QUEUE_MAX_ITEM_BYTES,
                    item_bytes,
                ));
            }
            let result = state
                .queue
                .send_message(request)
                .await
                .map_err(queue_operation_error)?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/steer" => {
            let request: BridgeThreadQueueSteerRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = state
                .queue
                .steer_message(request)
                .await
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/thread/queue/cancel" => {
            let request: BridgeThreadQueueCancelRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = state
                .queue
                .cancel_message(request)
                .await
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/workspaces/list" => {
            let request: WorkspaceListRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = list_workspace_roots(state, request).await?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/fs/list" => {
            let request: FileSystemListRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = list_filesystem_entries(state, request).await?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/terminal/exec" => {
            let request: TerminalExecRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let result = state.terminal.execute_shell(request).await?;
            let result_value = serde_json::to_value(&result)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            state
                .hub
                .broadcast_notification("bridge/terminal/completed", result_value.clone())
                .await;

            Ok(result_value)
        }
        "bridge/github/auth/install" => {
            let request: GitHubAuthInstallRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let result = install_github_git_auth(state, request).await?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/status" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let status = state.git.get_status(request.cwd.as_deref()).await?;
            serde_json::to_value(status).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/diff" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let diff = state.git.get_diff(request.cwd.as_deref()).await?;
            serde_json::to_value(diff).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/history" => {
            let request: GitHistoryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let history = state
                .git
                .get_history(request.cwd.as_deref(), request.limit)
                .await?;
            serde_json::to_value(history).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/branches" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let branches = state.git.get_branches(request.cwd.as_deref()).await?;
            serde_json::to_value(branches).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/clone" => {
            let request: GitCloneRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitCloneRequest {
                url,
                parent_path,
                directory_name,
            } = request;

            if url.trim().is_empty() {
                return Err(BridgeError::invalid_params("url must not be empty"));
            }
            if directory_name.trim().is_empty() {
                return Err(BridgeError::invalid_params(
                    "directoryName must not be empty",
                ));
            }

            let cloned = state
                .git
                .clone_repo(&url, parent_path.as_deref(), &directory_name)
                .await?;
            serde_json::to_value(cloned).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/git/stage" => {
            let request: GitFileRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitFileRequest { path, cwd } = request;
            if path.trim().is_empty() {
                return Err(BridgeError::invalid_params("path must not be empty"));
            }

            let staged = state.git.stage_file(&path, cwd.as_deref()).await?;
            let staged_value = serde_json::to_value(&staged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if staged.staged {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(staged_value)
        }
        "bridge/git/stageAll" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let staged = state.git.stage_all(request.cwd.as_deref()).await?;
            let staged_value = serde_json::to_value(&staged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if staged.staged {
                if let Ok(status) = state.git.get_status(request.cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(staged_value)
        }
        "bridge/git/unstage" => {
            let request: GitFileRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitFileRequest { path, cwd } = request;
            if path.trim().is_empty() {
                return Err(BridgeError::invalid_params("path must not be empty"));
            }

            let unstaged = state.git.unstage_file(&path, cwd.as_deref()).await?;
            let unstaged_value = serde_json::to_value(&unstaged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if unstaged.unstaged {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(unstaged_value)
        }
        "bridge/git/unstageAll" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let unstaged = state.git.unstage_all(request.cwd.as_deref()).await?;
            let unstaged_value = serde_json::to_value(&unstaged)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if unstaged.unstaged {
                if let Ok(status) = state.git.get_status(request.cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(unstaged_value)
        }
        "bridge/git/commit" => {
            let request: GitCommitRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitCommitRequest { message, cwd } = request;

            if message.trim().is_empty() {
                return Err(BridgeError::invalid_params("message must not be empty"));
            }

            let commit = state.git.commit(message, cwd.as_deref()).await?;
            let commit_value = serde_json::to_value(&commit)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if commit.committed {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(commit_value)
        }
        "bridge/git/switch" => {
            let request: GitSwitchRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let GitSwitchRequest { branch, cwd } = request;

            if branch.trim().is_empty() {
                return Err(BridgeError::invalid_params("branch must not be empty"));
            }

            let switched = state.git.switch_branch(branch, cwd.as_deref()).await?;
            let switched_value = serde_json::to_value(&switched)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if switched.switched {
                if let Ok(status) = state.git.get_status(cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(switched_value)
        }
        "bridge/git/push" => {
            let request: GitQueryRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            let push = state.git.push(request.cwd.as_deref()).await?;
            let push_value = serde_json::to_value(&push)
                .map_err(|error| BridgeError::server(&error.to_string()))?;

            if push.pushed {
                if let Ok(status) = state.git.get_status(request.cwd.as_deref()).await {
                    let status_value = serde_json::to_value(status)
                        .map_err(|error| BridgeError::server(&error.to_string()))?;
                    state
                        .hub
                        .broadcast_notification("bridge/git/updated", status_value)
                        .await;
                }
            }

            Ok(push_value)
        }
        "bridge/approvals/list" => {
            let list = state.backend.list_pending_approvals().await;
            serde_json::to_value(list).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/userInput/list" => {
            let list = state.backend.list_pending_user_inputs().await;
            serde_json::to_value(list).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/approvals/resolve" => {
            let mut request: ResolveApprovalRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            request.resolution_id = request.resolution_id.trim().to_string();
            if request.resolution_id.is_empty() || request.resolution_id.len() > PUSH_ID_MAX_BYTES {
                return Err(BridgeError::invalid_params(
                    "resolutionId must be non-empty and at most 128 bytes",
                ));
            }

            if request.decision.trim().is_empty() {
                return Err(BridgeError::invalid_params(
                    "decision must be one of: accept/approved, acceptForSession/approved_for_session, decline/denied, cancel/abort, or an execpolicy amendment object",
                ));
            }

            let _resolution_guard = state.approval_resolution_actor.lock().await;
            if let Some(result) = state
                .approval_resolution_results
                .lock()
                .await
                .get(&request.resolution_id)
                .cloned()
            {
                if read_string(
                    result
                        .get("approval")
                        .and_then(|value| value.get("requestId")),
                )
                .as_deref()
                    != Some(request.id.as_str())
                    || result.get("decision").and_then(Value::as_str)
                        != Some(request.decision.as_str())
                {
                    return Err(BridgeError::invalid_params(
                        "resolutionId is already bound to another approval decision",
                    ));
                }
                return Ok(result);
            }
            let resolved = state
                .backend
                .resolve_approval(&request.id, &request.decision)
                .await
                .map_err(|error| BridgeError::server(&error))?;

            let Some(approval) = resolved else {
                return Err(BridgeError {
                    code: -32004,
                    message: "approval_not_found".to_string(),
                    data: Some(json!({ "error": "approval_not_found" })),
                });
            };

            let result = json!({
                "ok": true,
                "approval": approval,
                "decision": request.decision,
                "resolutionId": request.resolution_id,
            });
            let mut results = state.approval_resolution_results.lock().await;
            let mut order = state.approval_resolution_order.lock().await;
            results.insert(request.resolution_id.clone(), result.clone());
            order.push_back(request.resolution_id);
            while order.len() > APPROVAL_RESOLUTION_DEDUPE_LIMIT {
                if let Some(oldest) = order.pop_front() {
                    results.remove(&oldest);
                }
            }
            Ok(result)
        }
        "bridge/userInput/resolve" => {
            let request: ResolveUserInputRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;

            if request.action.as_deref().unwrap_or("submit") == "submit"
                && request.answers.is_empty()
            {
                return Err(BridgeError::invalid_params(
                    "answers must contain at least one question response",
                ));
            }

            let resolved = state
                .backend
                .resolve_user_input(&request.id, &request.answers, request.action.as_deref())
                .await
                .map_err(|error| BridgeError::server(&error))?;

            let Some(user_input_request) = resolved else {
                return Err(BridgeError {
                    code: -32004,
                    message: "user_input_not_found".to_string(),
                    data: Some(json!({ "error": "user_input_not_found" })),
                });
            };

            Ok(json!({
                "ok": true,
                "request": user_input_request,
            }))
        }
        _ => Err(BridgeError::method_not_found(&format!(
            "Unknown bridge method: {method}"
        ))),
    }
}

pub(super) async fn start_thread_list_stream(
    state: &Arc<AppState>,
    client_id: u64,
    request: ThreadListStreamStartRequest,
) -> Result<Value, BridgeError> {
    let stream_id = normalize_thread_list_stream_id(request.stream_id, client_id);
    let stream_key = thread_list_stream_key(client_id, &stream_id);
    let limits = normalize_thread_list_stream_limits(request.limits);
    let response_limits = limits.clone();
    let delay_ms = request
        .delay_ms
        .unwrap_or(THREAD_LIST_STREAM_DEFAULT_DELAY_MS)
        .min(THREAD_LIST_STREAM_MAX_DELAY_MS);
    let include_sub_agents = request.include_sub_agents.unwrap_or(false);
    let cancellation = Arc::new(ThreadListStreamCancellation::default());

    {
        let mut streams = state.thread_list_streams.lock().await;
        if let Some(previous) = streams.insert(stream_key.clone(), cancellation.clone()) {
            previous.cancel();
        }
    }

    let stream_state = state.clone();
    let stream_id_for_task = stream_id.clone();
    tokio::spawn(async move {
        run_thread_list_stream(ThreadListStreamTask {
            state: stream_state,
            client_id,
            stream_id: stream_id_for_task,
            stream_key,
            include_sub_agents,
            limits,
            delay_ms,
            cancellation,
        })
        .await;
    });

    Ok(json!({
        "streamId": stream_id,
        "started": true,
        "limits": response_limits,
        "delayMs": delay_ms,
    }))
}

pub(super) async fn cancel_thread_list_stream(
    state: &Arc<AppState>,
    client_id: u64,
    stream_id: &str,
) -> Result<Value, BridgeError> {
    let stream_id = stream_id.trim();
    if stream_id.is_empty() {
        return Err(BridgeError::invalid_params("streamId must not be empty"));
    }

    let stream_key = thread_list_stream_key(client_id, stream_id);
    let cancelled = {
        let mut streams = state.thread_list_streams.lock().await;
        streams
            .remove(&stream_key)
            .map(|cancellation| {
                cancellation.cancel();
                true
            })
            .unwrap_or(false)
    };

    Ok(json!({
        "streamId": stream_id,
        "cancelled": cancelled,
    }))
}

#[derive(Debug, Default)]
pub(super) struct ThreadListStreamCancellation {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

impl ThreadListStreamCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

pub(super) async fn cancel_client_thread_list_streams(state: &Arc<AppState>, client_id: u64) {
    let owned = {
        let mut streams = state.thread_list_streams.lock().await;
        take_client_thread_list_streams(&mut streams, client_id)
    };
    for cancellation in owned {
        cancellation.cancel();
    }
}

fn take_client_thread_list_streams(
    streams: &mut HashMap<String, Arc<ThreadListStreamCancellation>>,
    client_id: u64,
) -> Vec<Arc<ThreadListStreamCancellation>> {
    let prefix = format!("{client_id}:");
    let keys = streams
        .keys()
        .filter(|key| key.starts_with(&prefix))
        .cloned()
        .collect::<Vec<_>>();
    keys.into_iter()
        .filter_map(|key| streams.remove(&key))
        .collect()
}

pub(super) struct ThreadListStreamTask {
    pub(super) state: Arc<AppState>,
    pub(super) client_id: u64,
    pub(super) stream_id: String,
    pub(super) stream_key: String,
    pub(super) include_sub_agents: bool,
    pub(super) limits: Vec<usize>,
    pub(super) delay_ms: u64,
    pub(super) cancellation: Arc<ThreadListStreamCancellation>,
}

pub(super) async fn run_thread_list_stream(task: ThreadListStreamTask) {
    let ThreadListStreamTask {
        state,
        client_id,
        stream_id,
        stream_key,
        include_sub_agents,
        limits,
        delay_ms,
        cancellation,
    } = task;
    for (index, limit) in limits.iter().copied().enumerate() {
        if cancellation.is_cancelled() {
            break;
        }

        if index > 0 && delay_ms > 0 {
            tokio::select! {
                _ = sleep(Duration::from_millis(delay_ms)) => {}
                _ = cancellation.cancelled() => break,
            }
        }

        let started_at = Instant::now();
        let request = state.backend.request_internal(
            "thread/list",
            Some(thread_list_stream_request_params(include_sub_agents, limit)),
        );
        let result = tokio::select! {
            result = request => result,
            _ = cancellation.cancelled() => break,
        };

        if cancellation.is_cancelled() {
            break;
        }

        match result {
            Ok(result) => {
                let data = result
                    .get("data")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                send_thread_list_stream_notification(
                    &state,
                    client_id,
                    THREAD_LIST_STREAM_BATCH_METHOD,
                    json!({
                        "streamId": stream_id.clone(),
                        "includeSubAgents": include_sub_agents,
                        "limit": limit,
                        "done": index + 1 == limits.len(),
                        "elapsedMs": started_at.elapsed().as_millis(),
                        "data": data,
                    }),
                )
                .await;
            }
            Err(error) => {
                send_thread_list_stream_notification(
                    &state,
                    client_id,
                    THREAD_LIST_STREAM_ERROR_METHOD,
                    json!({
                        "streamId": stream_id.clone(),
                        "includeSubAgents": include_sub_agents,
                        "limit": limit,
                        "done": true,
                        "elapsedMs": started_at.elapsed().as_millis(),
                        "error": error,
                    }),
                )
                .await;
                break;
            }
        }
    }

    let mut streams = state.thread_list_streams.lock().await;
    if streams
        .get(&stream_key)
        .map(|active| Arc::ptr_eq(active, &cancellation))
        .unwrap_or(false)
    {
        streams.remove(&stream_key);
    }
}

pub(super) async fn send_thread_list_stream_notification(
    state: &Arc<AppState>,
    client_id: u64,
    method: &str,
    params: Value,
) {
    state
        .hub
        .send_json(
            client_id,
            json!({
                "method": method,
                "params": params,
            }),
        )
        .await;
}

pub(super) fn thread_list_stream_request_params(include_sub_agents: bool, limit: usize) -> Value {
    json!({
        "cursor": Value::Null,
        "limit": limit,
        "includeSubAgents": include_sub_agents,
    })
}

pub(super) fn normalize_thread_list_stream_limits(limits: Option<Vec<usize>>) -> Vec<usize> {
    let requested = limits.unwrap_or_else(|| THREAD_LIST_STREAM_DEFAULT_LIMITS.to_vec());
    let mut normalized = Vec::new();
    for limit in requested {
        let clamped = limit.clamp(1, THREAD_LIST_STREAM_MAX_LIMIT);
        if !normalized.contains(&clamped) {
            normalized.push(clamped);
        }
    }

    if normalized.is_empty() {
        THREAD_LIST_STREAM_DEFAULT_LIMITS.to_vec()
    } else {
        normalized
    }
}

pub(super) fn normalize_thread_list_stream_id(stream_id: Option<String>, client_id: u64) -> String {
    stream_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| next_thread_list_stream_id(client_id))
}

pub(super) fn next_thread_list_stream_id(client_id: u64) -> String {
    let stamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("thread-list-{client_id}-{stamp:x}")
}

pub(super) fn thread_list_stream_key(client_id: u64, stream_id: &str) -> String {
    format!("{client_id}:{}", stream_id.trim())
}

pub(super) fn normalize_forwarded_path_params(
    params: Option<Value>,
    path_policy: &PathPolicy,
) -> Result<Option<Value>, BridgeError> {
    params
        .map(|value| normalize_forwarded_value_paths(value, path_policy, path_policy.root()))
        .transpose()
}

fn normalize_forwarded_value_paths(
    value: Value,
    path_policy: &PathPolicy,
    inherited_base: &Path,
) -> Result<Value, BridgeError> {
    match value {
        Value::Object(mut object) => {
            let base = match object.get("cwd").and_then(Value::as_str) {
                Some(raw) if !raw.trim().is_empty() => {
                    let cwd = path_policy.resolve_existing_from(
                        inherited_base,
                        raw,
                        PathKind::Directory,
                    )?;
                    object.insert("cwd".to_string(), Value::String(path_to_string(&cwd)));
                    cwd
                }
                _ => inherited_base.to_path_buf(),
            };
            let input_kind =
                object
                    .get("type")
                    .and_then(Value::as_str)
                    .and_then(|kind| match kind {
                        "mention" => Some(PathKind::Any),
                        "localImage" => Some(PathKind::File),
                        _ => None,
                    });
            if let Some(kind) = input_kind {
                let raw_path = object
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BridgeError::invalid_params("input path is required"))?;
                let path = path_policy.resolve_existing_from(&base, raw_path, kind)?;
                object.insert("path".to_string(), Value::String(path_to_string(&path)));
            }
            object
                .into_iter()
                .map(|(key, child)| {
                    normalize_forwarded_value_paths(child, path_policy, &base)
                        .map(|child| (key, child))
                })
                .collect::<Result<serde_json::Map<String, Value>, BridgeError>>()
                .map(Value::Object)
        }
        Value::Array(values) => values
            .into_iter()
            .map(|item| normalize_forwarded_value_paths(item, path_policy, inherited_base))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        other => Ok(other),
    }
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::config::{
        WebSocketResourceLimits, DEFAULT_WS_GLOBAL_IN_FLIGHT, DEFAULT_WS_MAX_FRAME_BYTES,
        DEFAULT_WS_MAX_MESSAGE_BYTES, DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
    };

    fn protected_request_config() -> BridgeConfig {
        BridgeConfig {
            host: "127.0.0.1".to_string(),
            port: 8787,
            preview_host: "127.0.0.1".to_string(),
            preview_port: 8788,
            connect_url: None,
            preview_connect_url: None,
            workdir: PathBuf::from("/tmp"),
            acp_manifest_path: PathBuf::from("/tmp/agents.json"),
            acp_approved_executable_roots: vec![PathBuf::from("/tmp")],
            acp_initialize_timeout: Duration::from_secs(15),
            auth_token: Some("secret".to_string()),
            auth_enabled: true,
            allow_insecure_no_auth: false,
            no_auth_allowed_origins: HashSet::new(),
            allow_query_token_auth: true,
            allow_outside_root_cwd: false,
            terminal_exec_policies: HashSet::new(),
            show_pairing_qr: false,
            ws_limits: WebSocketResourceLimits {
                max_frame_bytes: DEFAULT_WS_MAX_FRAME_BYTES,
                max_message_bytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
                per_client_in_flight: DEFAULT_WS_PER_CLIENT_IN_FLIGHT,
                global_in_flight: DEFAULT_WS_GLOBAL_IN_FLIGHT,
            },
        }
    }

    #[test]
    fn protected_requests_enforce_origin_before_credentials() {
        let config = protected_request_config();
        let headers = HeaderMap::new();

        let unauthorized = protected_request_error(&config, &headers, None).unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert!(protected_request_error(&config, &headers, Some("secret")).is_none());

        let mut no_auth = config;
        no_auth.auth_token = None;
        no_auth.auth_enabled = false;
        no_auth.allow_insecure_no_auth = true;
        let mut foreign_origin = HeaderMap::new();
        foreign_origin.insert(ORIGIN, "https://example.com".parse().unwrap());
        let forbidden = protected_request_error(&no_auth, &foreign_origin, None).unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn disconnect_cancels_only_owned_streams_and_wakes_blocked_requests() {
        let client_one_a = Arc::new(ThreadListStreamCancellation::default());
        let client_one_b = Arc::new(ThreadListStreamCancellation::default());
        let client_two = Arc::new(ThreadListStreamCancellation::default());
        let mut streams = HashMap::from([
            ("1:a".to_string(), client_one_a.clone()),
            ("1:b".to_string(), client_one_b.clone()),
            ("2:a".to_string(), client_two.clone()),
        ]);
        let blocked = {
            let cancellation = client_one_a.clone();
            tokio::spawn(async move { cancellation.cancelled().await })
        };
        tokio::task::yield_now().await;

        let owned = take_client_thread_list_streams(&mut streams, 1);
        assert_eq!(owned.len(), 2);
        for cancellation in owned {
            cancellation.cancel();
        }
        tokio::time::timeout(Duration::from_secs(1), blocked)
            .await
            .expect("blocked request wakes")
            .expect("waiter completes");
        assert!(client_one_a.is_cancelled());
        assert!(client_one_b.is_cancelled());
        assert!(!client_two.is_cancelled());
        assert_eq!(streams.len(), 1);
        assert!(streams.contains_key("2:a"));
        client_one_b.cancelled().await;

        let remaining = take_client_thread_list_streams(&mut streams, 2);
        assert_eq!(remaining.len(), 1);
        remaining[0].cancel();
        assert!(streams.is_empty());
        assert!(take_client_thread_list_streams(&mut streams, 99).is_empty());

        assert_eq!(
            normalize_thread_list_stream_limits(Some(vec![0, 1, usize::MAX, 1])),
            vec![1, THREAD_LIST_STREAM_MAX_LIMIT]
        );
        assert_eq!(
            normalize_thread_list_stream_limits(Some(Vec::new())),
            THREAD_LIST_STREAM_DEFAULT_LIMITS
        );
    }
}
