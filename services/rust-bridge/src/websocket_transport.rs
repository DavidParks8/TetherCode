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
        "bridge/runtime/read" => serde_json::to_value(state.updater.runtime_info().await)
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
        "bridge/cursor/credentials/read" => {
            let status = read_cursor_credential_status(state).await?;
            serde_json::to_value(status).map_err(|error| BridgeError::server(&error.to_string()))
        }
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
        "bridge/codex/auth/callback/forward" => {
            let request: CodexAuthCallbackForwardRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            forward_codex_auth_callback(state, &request.callback_url).await
        }
        "bridge/codex/app-server/restart" => {
            state
                .backend
                .restart_codex_app_server(&state.config, state.hub.clone())
                .await
                .map_err(|error| BridgeError::server(&error))?;
            Ok(json!({
                "ok": true,
                "message": "Codex app-server restarted."
            }))
        }
        "bridge/update/start" => {
            let request: BridgeUpdateStartRequest =
                serde_json::from_value(params.unwrap_or_else(|| json!({})))
                    .map_err(|error| BridgeError::invalid_params(&error.to_string()))?;
            let target_version = request.version.as_deref().unwrap_or("latest");
            let result = state
                .updater
                .start_update(target_version, std::process::id(), &now_iso())
                .map_err(|error| BridgeError::server(&error))?;
            serde_json::to_value(result).map_err(|error| BridgeError::server(&error.to_string()))
        }
        "bridge/restart/start" => {
            let result = state
                .updater
                .start_restart(std::process::id(), &now_iso())
                .map_err(|error| BridgeError::server(&error))?;
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
            let (events, has_more, returned_bytes) =
                state.hub.replay_since(request.after_event_id, limit).await;

            Ok(json!({
                "protocolVersion": BRIDGE_PROTOCOL_VERSION,
                "streamId": state.hub.stream_id(),
                "events": events,
                "hasMore": has_more,
                "truncatedByBytes": has_more && events.len() < limit,
                "returnedBytes": returned_bytes,
                "maxBytes": REPLAY_RESPONSE_MAX_BYTES,
                "earliestEventId": state.hub.earliest_event_id().await,
                "latestEventId": state.hub.latest_event_id(),
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
            let target_engine = state
                .backend
                .route_engine_for_method("thread/start", Some(&request.thread_start));
            let started = state
                .backend
                .request_internal("thread/start", Some(request.thread_start))
                .await
                .map_err(|error| BridgeError::server(&error))?;
            let started = normalize_forwarded_result("thread/start", started, target_engine);
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

            if !is_valid_approval_decision(&request.decision) {
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
                if read_string(result.get("approval").and_then(|value| value.get("id"))).as_deref()
                    != Some(request.id.as_str())
                    || result.get("decision") != Some(&request.decision)
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

            if request.answers.is_empty() {
                return Err(BridgeError::invalid_params(
                    "answers must contain at least one question response",
                ));
            }

            if !is_valid_user_input_answers(&request.answers) {
                return Err(BridgeError::invalid_params(
                    "answers must map question ids to non-empty answers arrays",
                ));
            }

            let resolved = state
                .backend
                .resolve_user_input(&request.id, &request.answers)
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

pub(super) async fn forward_codex_auth_callback(
    state: &Arc<AppState>,
    callback_url: &str,
) -> Result<Value, BridgeError> {
    let callback = Url::parse(callback_url)
        .map_err(|error| BridgeError::invalid_params(&format!("invalid callbackUrl: {error}")))?;
    if callback.scheme() != "http"
        || !matches!(callback.host_str(), Some("localhost") | Some("127.0.0.1"))
        || callback.port_or_known_default() != Some(1455)
        || callback.path() != "/auth/callback"
    {
        return Err(BridgeError::invalid_params(
            "callbackUrl must be the Codex loopback auth callback",
        ));
    }

    let mut upstream = Url::parse("http://127.0.0.1:1455/auth/callback")
        .map_err(|error| BridgeError::server(&format!("invalid Codex callback URL: {error}")))?;
    upstream.set_query(callback.query());

    let response = state
        .preview
        .http
        .get(upstream)
        .send()
        .await
        .map_err(|error| {
            BridgeError::server(&format!("failed to forward Codex auth callback: {error}"))
        })?;
    let status = response.status();
    if status.as_u16() >= 400 {
        let body = response.text().await.unwrap_or_default();
        return Err(BridgeError::server(&format!(
            "Codex auth callback returned HTTP {status}: {}",
            body.trim().chars().take(300).collect::<String>()
        )));
    }

    Ok(json!({
        "forwarded": true,
        "status": status.as_u16(),
    }))
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
    let cancellation = Arc::new(AtomicBool::new(false));

    {
        let mut streams = state.thread_list_streams.lock().await;
        if let Some(previous) = streams.insert(stream_key.clone(), cancellation.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }

    let stream_state = state.clone();
    let stream_id_for_task = stream_id.clone();
    tokio::spawn(async move {
        run_thread_list_stream(
            stream_state,
            client_id,
            stream_id_for_task,
            stream_key,
            include_sub_agents,
            limits,
            delay_ms,
            cancellation,
        )
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
                cancellation.store(true, Ordering::Relaxed);
                true
            })
            .unwrap_or(false)
    };

    Ok(json!({
        "streamId": stream_id,
        "cancelled": cancelled,
    }))
}

pub(super) async fn run_thread_list_stream(
    state: Arc<AppState>,
    client_id: u64,
    stream_id: String,
    stream_key: String,
    include_sub_agents: bool,
    limits: Vec<usize>,
    delay_ms: u64,
    cancellation: Arc<AtomicBool>,
) {
    for (index, limit) in limits.iter().copied().enumerate() {
        if cancellation.load(Ordering::Relaxed) {
            break;
        }

        if index > 0 && delay_ms > 0 {
            sleep(Duration::from_millis(delay_ms)).await;
            if cancellation.load(Ordering::Relaxed) {
                break;
            }
        }

        let started_at = Instant::now();
        let result = state
            .backend
            .request_internal(
                "thread/list",
                Some(thread_list_stream_request_params(include_sub_agents, limit)),
            )
            .await;

        if cancellation.load(Ordering::Relaxed) {
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
    let source_kinds = if include_sub_agents {
        json!([
            "cli",
            "vscode",
            "exec",
            "appServer",
            "unknown",
            "subAgent",
            "subAgentReview",
            "subAgentCompact",
            "subAgentThreadSpawn",
            "subAgentOther",
        ])
    } else {
        json!(["cli", "vscode", "exec", "appServer", "unknown"])
    };

    json!({
        "cursor": Value::Null,
        "limit": limit,
        "sortKey": "updated_at",
        "modelProviders": Value::Null,
        "sourceKinds": source_kinds,
        "archived": false,
        "cwd": Value::Null,
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
