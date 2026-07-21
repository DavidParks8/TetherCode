use crate::*;

pub(super) fn build_bridge_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/rpc", get(ws_handler))
        .route(
            "/attachments",
            post(attachment_upload_handler)
                .layer(DefaultBodyLimit::max(ATTACHMENT_MULTIPART_MAX_BYTES)),
        )
        .route("/health", get(health_handler))
        .route("/status", get(status_handler))
        .route("/local-image", get(local_image_handler))
        .with_state(state)
}

pub(super) fn build_preview_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", any(preview_entry_handler))
        .route("/{*path}", any(preview_entry_handler))
        .with_state(state)
}

pub(super) async fn health_handler(State(state): State<Arc<AppState>>) -> Response {
    let status = state.bridge_status().await;
    let http_status = if status.status == "unhealthy" {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (
        http_status,
        Json(json!({
            "status": status.status,
            "at": now_iso(),
            "uptimeSec": state.started_at.elapsed().as_secs(),
        })),
    )
        .into_response()
}

pub(super) async fn status_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RpcQuery>,
) -> Response {
    if let Some(response) = protected_request_error(&state.config, &headers, query.token.as_deref())
    {
        return response;
    }

    Json(state.bridge_status().await).into_response()
}

pub(super) async fn local_image_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<LocalImageQuery>,
) -> Response {
    if let Some(response) = protected_request_error(&state.config, &headers, query.token.as_deref())
    {
        return response;
    }

    let (file, path) = match state.path_policy.open_regular_file_beneath(&query.path) {
        Ok(opened) => opened,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "invalid_path",
                    "message": error.message,
                })),
            )
                .into_response();
        }
    };

    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": "not_found",
                    "message": "Image file not found"
                })),
            )
                .into_response();
        }
    };

    if !metadata.is_file() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "invalid_path",
                "message": "Image path must reference a file"
            })),
        )
            .into_response();
    }

    if metadata.len() > LOCAL_IMAGE_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": "resource_limit_exceeded",
                "resource": "local_image_bytes",
                "limit": LOCAL_IMAGE_MAX_BYTES,
                "actual": metadata.len(),
                "message": format!("Image exceeds the {LOCAL_IMAGE_MAX_BYTES} byte limit")
            })),
        )
            .into_response();
    }

    let content_type = match infer_image_content_type_from_path(&path) {
        Some(content_type) => content_type,
        None => {
            return (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                Json(json!({
                    "error": "unsupported_media_type",
                    "message": "Only image files can be served through /local-image"
                })),
            )
                .into_response();
        }
    };

    let mut file = fs::File::from_std(file);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if let Err(error) = (&mut file)
        .take(LOCAL_IMAGE_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "error": "read_failed",
                "message": format!("Failed to read image file: {error}")
            })),
        )
            .into_response();
    }
    if bytes.len() as u64 > LOCAL_IMAGE_MAX_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({
                "error": "resource_limit_exceeded",
                "resource": "local_image_bytes",
                "limit": LOCAL_IMAGE_MAX_BYTES,
                "actual": bytes.len(),
                "message": format!("Image exceeds the {LOCAL_IMAGE_MAX_BYTES} byte limit")
            })),
        )
            .into_response();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "no-store")
        .body(Body::from(bytes))
        .unwrap_or_else(|error| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({
                    "error": "response_failed",
                    "message": format!("Failed to build image response: {error}")
                })),
            )
                .into_response()
        })
}

pub(super) async fn preview_entry_handler(
    State(state): State<Arc<AppState>>,
    request: Request,
) -> Response {
    let (mut parts, body) = request.into_parts();

    if parts.uri.path() == BROWSER_PREVIEW_RUNTIME_SCRIPT_PATH {
        return preview_runtime_script_response();
    }

    if is_websocket_upgrade_request(&parts.method, &parts.headers) {
        return handle_preview_websocket_request(state, &mut parts).await;
    }

    handle_preview_http_request(state, parts, body).await
}

pub(super) fn preview_runtime_script_response() -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/javascript; charset=utf-8")
        .header(CACHE_CONTROL, "no-store")
        .header(REFERRER_POLICY, "no-referrer")
        .body(Body::from(build_preview_runtime_script()))
        .unwrap_or_else(|_| Response::new(Body::from(String::new())))
}

pub(super) async fn handle_preview_http_request(
    state: Arc<AppState>,
    parts: axum::http::request::Parts,
    body: Body,
) -> Response {
    let resolved_request = match resolve_preview_session_from_request(
        &state.preview,
        &parts.headers,
        &parts.uri,
    )
    .await
    {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session = resolved_request.session;
    let bootstrap_session_id = resolved_request.bootstrap_session_id;
    let bootstrap_token = resolved_request.bootstrap_token;
    let requested_viewport = resolved_request.requested_viewport;
    let requested_shell_mode = resolved_request.requested_shell_mode;
    let raw_frame = resolved_request.raw_frame;
    let sanitized_path_and_query = resolved_request.sanitized_path_and_query;

    if let Some(token) = bootstrap_token.as_deref() {
        if !raw_frame {
            return preview_bootstrap_redirect_response(
                &sanitized_path_and_query,
                token,
                requested_viewport,
                state.preview.secure_cookie(),
            );
        }
    }

    if let (Some(session_id), Some(shell_mode)) =
        (bootstrap_session_id.as_deref(), requested_shell_mode)
    {
        if !raw_frame {
            let viewport = requested_viewport.unwrap_or(PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(DEFAULT_PREVIEW_DESKTOP_WIDTH),
                height: Some(DEFAULT_PREVIEW_DESKTOP_HEIGHT),
            });
            return match shell_mode {
                PreviewShellMode::Desktop => preview_desktop_shell_response(
                    &sanitized_path_and_query,
                    viewport,
                    Some(session_id),
                    None,
                ),
                PreviewShellMode::Overview => preview_overview_shell_response(
                    &sanitized_path_and_query,
                    viewport,
                    Some(session_id),
                    None,
                ),
            };
        }
    }

    let request_target =
        match resolve_preview_request_target(&session.target_url, &sanitized_path_and_query) {
            Ok(target) => target,
            Err(error) => {
                return preview_error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("invalid preview request path: {error}"),
                );
            }
        };
    let upstream_url = match build_preview_upstream_url(
        &request_target.target_url,
        &request_target.path_and_query,
        false,
    ) {
        Ok(url) => url,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid preview request path: {error}"),
            );
        }
    };

    let body_bytes = match to_bytes(body, PREVIEW_REQUEST_MAX_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return preview_error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("preview request body exceeds limit: {error}"),
            );
        }
    };

    let mut upstream_request = state
        .preview
        .http
        .request(to_reqwest_method(&parts.method), upstream_url.clone())
        .body(body_bytes);
    for (name, value) in parts.headers.iter() {
        let header_name = name.as_str();
        if should_skip_preview_request_header(header_name) {
            continue;
        }

        if header_name.eq_ignore_ascii_case(COOKIE.as_str()) {
            if let Some(filtered_cookie) = filter_preview_cookie_header(value) {
                upstream_request = upstream_request.header(name, filtered_cookie);
            }
            continue;
        }

        if let Some(rewritten) =
            rewrite_preview_request_header(header_name, value, &request_target.target_url)
        {
            upstream_request = upstream_request.header(name, rewritten);
        }
    }

    let upstream_response = match upstream_request.send().await {
        Ok(response) => response,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to reach preview target: {error}"),
            );
        }
    };

    let request_host = parts
        .headers
        .get(HOST.as_str())
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let effective_viewport =
        requested_viewport.or_else(|| read_preview_viewport_preset(&parts.headers));
    let effective_shell_mode = requested_shell_mode;

    if let Some(shell_mode) = effective_shell_mode {
        if !raw_frame {
            let viewport = effective_viewport.unwrap_or(PreviewViewportConfig {
                preset: PreviewViewportPreset::Desktop,
                width: Some(DEFAULT_PREVIEW_DESKTOP_WIDTH),
                height: Some(DEFAULT_PREVIEW_DESKTOP_HEIGHT),
            });
            return match shell_mode {
                PreviewShellMode::Desktop => {
                    preview_desktop_shell_response(&sanitized_path_and_query, viewport, None, None)
                }
                PreviewShellMode::Overview => {
                    preview_overview_shell_response(&sanitized_path_and_query, viewport, None, None)
                }
            };
        }
    }
    let status = StatusCode::from_u16(upstream_response.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream_response.headers().clone();
    let rewrite_html = should_rewrite_preview_html_response(&upstream_headers);

    let mut response = if rewrite_html {
        if upstream_response
            .content_length()
            .is_some_and(|length| length > PREVIEW_BUFFERED_RESPONSE_MAX_BYTES as u64)
        {
            return preview_error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!(
                    "preview buffered response exceeds {} bytes",
                    PREVIEW_BUFFERED_RESPONSE_MAX_BYTES
                ),
            );
        }
        let mut upstream_body = Vec::new();
        let mut body_stream = upstream_response.bytes_stream();
        while let Some(chunk) = body_stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    return preview_error_response(
                        StatusCode::BAD_GATEWAY,
                        &format!("failed to read preview document: {error}"),
                    );
                }
            };
            if upstream_body.len().saturating_add(chunk.len()) > PREVIEW_BUFFERED_RESPONSE_MAX_BYTES
            {
                return preview_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    &format!(
                        "preview buffered response exceeds {} bytes",
                        PREVIEW_BUFFERED_RESPONSE_MAX_BYTES
                    ),
                );
            }
            upstream_body.extend_from_slice(&chunk);
        }
        let rewritten_body = rewrite_preview_html_document(&upstream_body, effective_viewport)
            .unwrap_or(upstream_body);
        let mut response = Response::new(Body::from(rewritten_body));
        *response.status_mut() = status;
        response
    } else {
        let mut response = Response::new(Body::from_stream(upstream_response.bytes_stream()));
        *response.status_mut() = status;
        response
    };

    for (name, value) in upstream_headers.iter() {
        if should_skip_preview_response_header(name.as_str()) {
            continue;
        }

        if rewrite_html
            && (name.as_str().eq_ignore_ascii_case("etag")
                || name.as_str().eq_ignore_ascii_case("last-modified"))
        {
            continue;
        }

        if name.as_str().eq_ignore_ascii_case(LOCATION.as_str()) {
            if let Some(rewritten) = rewrite_preview_location_header(
                value,
                &upstream_url,
                request_host.as_deref(),
                request_target.proxy_path_prefix.as_deref(),
            ) {
                response.headers_mut().append(LOCATION, rewritten);
            }
            continue;
        }

        if name.as_str().eq_ignore_ascii_case(SET_COOKIE.as_str()) {
            if let Some(rewritten) = rewrite_preview_set_cookie_header(
                value,
                request_target.proxy_path_prefix.as_deref(),
            ) {
                response.headers_mut().append(SET_COOKIE, rewritten);
            }
            continue;
        }

        response.headers_mut().append(name.clone(), value.clone());
    }

    if rewrite_html {
        response
            .headers_mut()
            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store, private"));
        append_vary_header_value(response.headers_mut(), "Cookie");
    }

    append_preview_bootstrap_headers(
        &mut response,
        bootstrap_token.as_deref(),
        requested_viewport,
        state.preview.secure_cookie(),
    );

    apply_preview_security_headers(&mut response);

    response
}

pub(super) async fn handle_preview_websocket_request(
    state: Arc<AppState>,
    parts: &mut axum::http::request::Parts,
) -> Response {
    let resolved_request = match resolve_preview_session_from_request(
        &state.preview,
        &parts.headers,
        &parts.uri,
    )
    .await
    {
        Ok(result) => result,
        Err(response) => return response,
    };
    let session = resolved_request.session;
    let sanitized_path_and_query = resolved_request.sanitized_path_and_query;

    let request_target =
        match resolve_preview_request_target(&session.target_url, &sanitized_path_and_query) {
            Ok(target) => target,
            Err(error) => {
                return preview_error_response(
                    StatusCode::BAD_REQUEST,
                    &format!("invalid websocket preview path: {error}"),
                );
            }
        };
    let upstream_url = match build_preview_upstream_url(
        &request_target.target_url,
        &request_target.path_and_query,
        true,
    ) {
        Ok(url) => url,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid websocket preview path: {error}"),
            );
        }
    };

    let original_headers = parts.headers.clone();
    let mut upstream_request = match upstream_url.as_str().into_client_request() {
        Ok(request) => request,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to create websocket request: {error}"),
            );
        }
    };
    for (name, value) in original_headers.iter() {
        let header_name = name.as_str();
        if should_skip_preview_websocket_request_header(header_name) {
            continue;
        }

        if header_name.eq_ignore_ascii_case(COOKIE.as_str()) {
            if let Some(filtered_cookie) = filter_preview_cookie_header(value) {
                upstream_request.headers_mut().append(name, filtered_cookie);
            }
            continue;
        }

        if let Some(rewritten) =
            rewrite_preview_request_header(header_name, value, &request_target.target_url)
        {
            upstream_request.headers_mut().append(name, rewritten);
        }
    }

    let (upstream_socket, upstream_response) = match connect_async(upstream_request).await {
        Ok(result) => result,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to connect websocket preview target: {error}"),
            );
        }
    };

    let websocket_upgrade = match WebSocketUpgrade::from_request_parts(parts, &state).await {
        Ok(upgrade) => upgrade,
        Err(error) => {
            return preview_error_response(
                StatusCode::BAD_REQUEST,
                &format!("invalid websocket upgrade request: {error}"),
            );
        }
    };

    let accepted_protocol = upstream_response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let websocket_upgrade = if let Some(protocol) = accepted_protocol {
        websocket_upgrade.protocols([protocol])
    } else {
        websocket_upgrade
    };

    websocket_upgrade
        .max_frame_size(state.config.ws_limits.max_frame_bytes)
        .max_message_size(state.config.ws_limits.max_message_bytes)
        .on_upgrade(move |socket| async move {
            proxy_preview_websocket(socket, upstream_socket).await;
        })
        .into_response()
}

pub(super) async fn proxy_preview_websocket(
    socket: WebSocket,
    upstream_socket: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let (mut client_tx, mut client_rx) = socket.split();
    let (mut upstream_tx, mut upstream_rx) = upstream_socket.split();

    let mut client_to_upstream = tokio::spawn(async move {
        while let Some(message) = client_rx.next().await {
            let Ok(message) = message else {
                break;
            };

            let upstream_message = match message {
                Message::Text(text) => UpstreamWsMessage::Text(text.to_string().into()),
                Message::Binary(data) => UpstreamWsMessage::Binary(data),
                Message::Ping(data) => UpstreamWsMessage::Ping(data),
                Message::Pong(data) => UpstreamWsMessage::Pong(data),
                Message::Close(_) => UpstreamWsMessage::Close(None),
            };

            if upstream_tx.send(upstream_message).await.is_err() {
                break;
            }
        }
    });

    let mut upstream_to_client = tokio::spawn(async move {
        while let Some(message) = upstream_rx.next().await {
            let Ok(message) = message else {
                break;
            };

            let client_message = match message {
                UpstreamWsMessage::Text(text) => Message::Text(text.to_string().into()),
                UpstreamWsMessage::Binary(data) => Message::Binary(data),
                UpstreamWsMessage::Ping(data) => Message::Ping(data),
                UpstreamWsMessage::Pong(data) => Message::Pong(data),
                UpstreamWsMessage::Close(_) => Message::Close(None),
                UpstreamWsMessage::Frame(_) => continue,
            };

            if client_tx.send(client_message).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = &mut client_to_upstream => upstream_to_client.abort(),
        _ = &mut upstream_to_client => client_to_upstream.abort(),
    }
}

pub(super) async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RpcQuery>,
) -> Response {
    if let Some(response) = protected_request_error(&state.config, &headers, query.token.as_deref())
    {
        return response;
    }

    let client_metadata = ClientConnectionMetadata::from_query(&query);

    ws.max_frame_size(state.config.ws_limits.max_frame_bytes)
        .max_message_size(state.config.ws_limits.max_message_bytes)
        .on_upgrade(move |socket| handle_socket(socket, state, client_metadata))
        .into_response()
}

pub(super) async fn attachment_upload_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<RpcQuery>,
    request: Request,
) -> Response {
    if let Some(response) = protected_request_error(&state.config, &headers, query.token.as_deref())
    {
        return response;
    }

    let multipart = match Multipart::from_request(request, &state).await {
        Ok(multipart) => multipart,
        Err(error) => {
            return (
                error.status(),
                Json(json!({
                    "error": "invalid_upload",
                    "message": error.body_text(),
                })),
            )
                .into_response();
        }
    };
    match save_multipart_attachment(multipart, &state.path_policy).await {
        Ok(uploaded) => (StatusCode::CREATED, Json(uploaded)).into_response(),
        Err(error) => bridge_error_http_response(error),
    }
}

pub(super) fn bridge_error_http_response(error: BridgeError) -> Response {
    let status = if error
        .data
        .as_ref()
        .and_then(|data| data.get("error"))
        .and_then(Value::as_str)
        == Some("resource_limit_exceeded")
    {
        StatusCode::PAYLOAD_TOO_LARGE
    } else if error.code == -32602 {
        StatusCode::BAD_REQUEST
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    };
    let mut body = json!({
        "error": if status == StatusCode::INTERNAL_SERVER_ERROR { "upload_failed" } else { "invalid_upload" },
        "message": error.message,
    });
    if let (Some(target), Some(data)) = (body.as_object_mut(), error.data) {
        if let Some(data) = data.as_object() {
            target.extend(data.clone());
        }
    }
    (status, Json(body)).into_response()
}
