use crate::*;

#[derive(Clone)]
pub(super) struct OpencodePendingApprovalEntry {
    pub(super) approval: PendingApproval,
    pub(super) directory: String,
}

#[derive(Clone)]
pub(super) struct OpencodePendingUserInputEntry {
    pub(super) request: PendingUserInputRequest,
    pub(super) directory: String,
}

pub(super) struct OpencodeBackend {
    pub(super) child: Mutex<Child>,
    pub(super) child_pid: u32,
    pub(super) hub: Arc<ClientHub>,
    pub(super) http: HttpClient,
    pub(super) base_url: Url,
    pub(super) username: String,
    pub(super) password: Option<String>,
    pub(super) fallback_directory: String,
    pub(super) session_directories: RwLock<HashMap<String, String>>,
    pub(super) session_statuses: RwLock<HashMap<String, String>>,
    pub(super) active_turns: RwLock<HashMap<String, String>>,
    pub(super) part_kinds: RwLock<HashMap<String, String>>,
    pub(super) interrupted_sessions: RwLock<HashSet<String>>,
    pub(super) pending_approvals: Mutex<HashMap<String, OpencodePendingApprovalEntry>>,
    pub(super) pending_user_inputs: Mutex<HashMap<String, OpencodePendingUserInputEntry>>,
    pub(super) lifecycle: Arc<BackendRuntimeStatus>,
}

impl OpencodeBackend {
    pub(super) async fn start(
        config: &Arc<BridgeConfig>,
        hub: Arc<ClientHub>,
    ) -> Result<Arc<Self>, String> {
        let mut command = Command::new(&config.opencode_cli_bin);
        command
            .arg("serve")
            .arg("--hostname")
            .arg(&config.opencode_host)
            .arg("--port")
            .arg(config.opencode_port.to_string())
            .current_dir(&config.workdir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_managed_child_command(&mut command);

        if let Some(password) = config.opencode_server_password.as_deref() {
            command.env("OPENCODE_SERVER_PASSWORD", password);
            command.env("OPENCODE_SERVER_USERNAME", &config.opencode_server_username);
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start opencode serve: {error}"))?;
        let child_pid = child
            .id()
            .ok_or_else(|| "opencode pid unavailable".to_string())?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "opencode stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "opencode stderr unavailable".to_string())?;

        let base_url = Url::parse(&format!(
            "http://{}:{}/",
            config.opencode_host, config.opencode_port
        ))
        .map_err(|error| format!("invalid opencode base url: {error}"))?;

        let backend = Arc::new(Self {
            child: Mutex::new(child),
            child_pid,
            hub,
            http: HttpClient::builder()
                .build()
                .map_err(|error| format!("failed to build opencode http client: {error}"))?,
            base_url,
            username: config.opencode_server_username.clone(),
            password: config.opencode_server_password.clone(),
            fallback_directory: config.workdir.to_string_lossy().to_string(),
            session_directories: RwLock::new(HashMap::new()),
            session_statuses: RwLock::new(HashMap::new()),
            active_turns: RwLock::new(HashMap::new()),
            part_kinds: RwLock::new(HashMap::new()),
            interrupted_sessions: RwLock::new(HashSet::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
            lifecycle: Arc::new(BackendRuntimeStatus::starting()),
        });

        backend.spawn_stdout_loop(stdout);
        backend.spawn_stderr_loop(stderr);
        backend.spawn_wait_loop();
        if let Err(error) = backend.wait_until_healthy().await {
            backend
                .lifecycle
                .transition(BackendLifecycleState::Degraded, Some(error.clone()))
                .await;
            backend.request_shutdown().await;
            let _ = timeout(Duration::from_secs(5), async {
                let mut child = backend.child.lock().await;
                child.wait().await
            })
            .await;
            backend
                .lifecycle
                .transition(BackendLifecycleState::Dead, Some(error.clone()))
                .await;
            return Err(error);
        }
        backend
            .lifecycle
            .transition(BackendLifecycleState::Ready, None)
            .await;
        backend.spawn_global_event_loop();

        Ok(backend)
    }

    pub(super) async fn request_shutdown(&self) {
        self.lifecycle
            .transition(
                BackendLifecycleState::Degraded,
                Some("shutdown requested".to_string()),
            )
            .await;
        terminate_managed_child(self.child_pid, "opencode").await;
    }

    pub(super) fn spawn_stdout_loop(self: &Arc<Self>, stdout: ChildStdout) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(_)) => eprintln!(
                        "{}",
                        json!({
                            "timestamp": now_iso(),
                            "level": "info",
                            "event": "backend_stdout_line",
                            "backend": "opencode",
                            "redacted": true,
                        })
                    ),
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("opencode stdout read error: {error}");
                        break;
                    }
                }
            }
        });
    }

    pub(super) fn spawn_stderr_loop(self: &Arc<Self>, stderr: tokio::process::ChildStderr) {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(_)) => eprintln!(
                        "{}",
                        json!({
                            "timestamp": now_iso(),
                            "level": "warn",
                            "event": "backend_stderr_line",
                            "backend": "opencode",
                            "redacted": true,
                        })
                    ),
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("opencode stderr read error: {error}");
                        break;
                    }
                }
            }
        });
    }

    pub(super) fn spawn_wait_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let status_result = {
                let mut child = this.child.lock().await;
                child.wait().await
            };

            match status_result {
                Ok(status) => eprintln!("opencode exited with status: {status}"),
                Err(error) => eprintln!("failed waiting for opencode exit: {error}"),
            }

            this.pending_approvals.lock().await.clear();
            this.pending_user_inputs.lock().await.clear();
            this.session_statuses.write().await.clear();
            this.active_turns.write().await.clear();
            this.part_kinds.write().await.clear();
            this.interrupted_sessions.write().await.clear();
            this.lifecycle
                .transition(
                    BackendLifecycleState::Dead,
                    Some("opencode exited".to_string()),
                )
                .await;
        });
    }

    pub(super) async fn wait_until_healthy(&self) -> Result<(), String> {
        let mut last_error = "opencode health probe did not run".to_string();
        let deadline = Instant::now() + OPENCODE_HEALTH_TIMEOUT;
        while Instant::now() < deadline {
            match self
                .request_json(HttpMethod::GET, "global/health", None, None, None)
                .await
            {
                Ok(health) if health.get("healthy").and_then(Value::as_bool) == Some(true) => {
                    return Ok(());
                }
                Ok(_) => {
                    last_error = "opencode health probe returned unhealthy response".to_string();
                }
                Err(error) => {
                    last_error = error;
                }
            }

            tokio::time::sleep(OPENCODE_HEALTH_POLL_INTERVAL).await;
        }

        Err(format!("opencode failed health check: {last_error}"))
    }

    pub(super) fn spawn_global_event_loop(self: &Arc<Self>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if this.lifecycle.is_dead() {
                    break;
                }
                if let Err(error) = this.consume_global_events().await {
                    eprintln!("opencode global event stream failed: {error}");
                }
                if this.lifecycle.is_dead() {
                    break;
                }
                tokio::time::sleep(OPENCODE_EVENT_RECONNECT_DELAY).await;
            }
        });
    }

    #[cfg(test)]
    pub(super) async fn child_has_exited(&self) -> bool {
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                eprintln!("failed to poll opencode child status: {error}");
                true
            }
        }
    }

    pub(super) async fn consume_global_events(&self) -> Result<(), String> {
        let url = self
            .base_url
            .join("global/event")
            .map_err(|error| format!("invalid opencode global event url: {error}"))?;

        let mut request = self.http.request(HttpMethod::GET, url);
        if let Some(password) = self.password.as_deref() {
            request = request.basic_auth(&self.username, Some(password));
        }

        let mut response = request
            .send()
            .await
            .map_err(|error| format!("failed to open opencode global event stream: {error}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "opencode global event stream returned {}: {}",
                status.as_u16(),
                body.trim()
            ));
        }

        let mut buffer = String::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("failed reading opencode event stream: {error}"))?
        {
            if chunk.is_empty() {
                continue;
            }

            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text.replace("\r\n", "\n"));

            while let Some(index) = buffer.find("\n\n") {
                let frame = buffer[..index].to_string();
                buffer.drain(..index + 2);
                self.handle_sse_frame(&frame).await;
            }
        }

        Err("opencode global event stream closed".to_string())
    }

    pub(super) async fn handle_sse_frame(&self, frame: &str) {
        let data = frame
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.trim().is_empty() {
            return;
        }

        let Ok(payload) = serde_json::from_str::<Value>(&data) else {
            return;
        };
        self.handle_global_event(payload).await;
    }

    pub(super) async fn handle_global_event(&self, envelope: Value) {
        let Some(envelope_object) = envelope.as_object() else {
            return;
        };
        let directory = read_string(envelope_object.get("directory"));
        let Some(payload) = envelope_object.get("payload").and_then(Value::as_object) else {
            return;
        };
        let Some(event_type) = read_string(payload.get("type")) else {
            return;
        };
        let properties = payload.get("properties").cloned().unwrap_or(Value::Null);

        match event_type.as_str() {
            "server.connected" | "server.heartbeat" => {}
            "session.created" => {
                if let Some(info) = properties.get("info") {
                    self.cache_session_info(info).await;
                    if let Some(session_id) = read_string(info.get("id")) {
                        self.broadcast_json_notification(
                            "thread/started",
                            json!({
                                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                            }),
                        )
                        .await;
                    }
                }
            }
            "session.updated" => {
                if let Some(info) = properties.get("info") {
                    self.cache_session_info(info).await;
                    if let Some(session_id) = read_string(info.get("id")) {
                        self.broadcast_json_notification(
                            "thread/name/updated",
                            json!({
                                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                                "threadName": read_string(info.get("title")),
                            }),
                        )
                        .await;
                    }
                }
            }
            "session.status" => {
                self.handle_session_status_event(properties).await;
            }
            "session.error" => {
                self.handle_session_error_event(properties).await;
            }
            "message.part.updated" => {
                self.cache_message_part_kind(properties).await;
            }
            "message.part.delta" => {
                self.handle_message_part_delta(properties).await;
            }
            "message.part.removed" => {
                let session_id = read_string(properties.get("sessionID"));
                let part_id = read_string(properties.get("partID"));
                if let (Some(session_id), Some(part_id)) = (session_id, part_id) {
                    self.part_kinds
                        .write()
                        .await
                        .remove(&opencode_part_key(&session_id, &part_id));
                }
            }
            "permission.asked" => {
                self.handle_permission_asked(properties, directory).await;
            }
            "permission.replied" => {
                self.handle_permission_replied(properties).await;
            }
            "question.asked" => {
                self.handle_question_asked(properties, directory).await;
            }
            "question.replied" | "question.rejected" => {
                self.handle_question_resolved(properties).await;
            }
            _ => {}
        }
    }

    pub(super) async fn handle_session_status_event(&self, properties: Value) {
        let Some(session_id) = read_string(properties.get("sessionID")) else {
            return;
        };
        let status_type = properties
            .get("status")
            .and_then(Value::as_object)
            .and_then(|status| read_string(status.get("type")));
        let Some(status_type) = status_type else {
            return;
        };

        let previous_status = self
            .session_statuses
            .write()
            .await
            .insert(session_id.clone(), status_type.clone());
        let was_active = opencode_status_is_active(previous_status.as_deref());
        let is_active = opencode_status_is_active(Some(status_type.as_str()));
        let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id);
        let interrupted = if !is_active && was_active {
            self.interrupted_sessions.write().await.remove(&session_id)
        } else {
            false
        };

        self.broadcast_json_notification(
            "thread/status/changed",
            json!({
                "threadId": thread_id,
                "status": if is_active {
                    "running"
                } else if was_active && interrupted {
                    "interrupted"
                } else if was_active {
                    "completed"
                } else {
                    "idle"
                },
            }),
        )
        .await;

        if is_active && !was_active {
            let turn_id = self.active_turns.read().await.get(&session_id).cloned();
            self.broadcast_json_notification(
                "turn/started",
                json!({
                    "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                    "turnId": turn_id,
                }),
            )
            .await;
            return;
        }

        if !is_active && was_active {
            let turn_id = self.active_turns.write().await.remove(&session_id);
            self.broadcast_json_notification(
                "turn/completed",
                json!({
                    "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                    "turnId": turn_id,
                    "status": if interrupted { "interrupted" } else { "completed" },
                }),
            )
            .await;
        }
    }

    pub(super) async fn handle_session_error_event(&self, properties: Value) {
        let Some(session_id) = read_string(properties.get("sessionID")) else {
            return;
        };
        let error_message = properties
            .get("error")
            .and_then(Value::as_object)
            .and_then(|error| read_string(error.get("message")));
        self.session_statuses
            .write()
            .await
            .insert(session_id.clone(), "idle".to_string());
        let turn_id = self.active_turns.write().await.remove(&session_id);
        self.interrupted_sessions.write().await.remove(&session_id);

        self.broadcast_json_notification(
            "thread/status/changed",
            json!({
                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                "status": "failed",
                "error": {
                    "message": error_message,
                },
            }),
        )
        .await;
        self.broadcast_json_notification(
            "turn/completed",
            json!({
                "threadId": encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
                "turnId": turn_id,
                "status": "failed",
                "error": {
                    "message": error_message,
                },
            }),
        )
        .await;
    }

    pub(super) async fn cache_message_part_kind(&self, properties: Value) {
        let Some(part) = properties.get("part").and_then(Value::as_object) else {
            return;
        };
        let Some(session_id) = read_string(part.get("sessionID")) else {
            return;
        };
        let Some(part_id) = read_string(part.get("id")) else {
            return;
        };
        let Some(kind) = read_string(part.get("type")) else {
            return;
        };
        let storage_kind = if kind == "tool" {
            let status = part
                .get("state")
                .and_then(Value::as_object)
                .and_then(|state| read_string(state.get("status")))
                .unwrap_or_else(|| "pending".to_string());
            format!("tool:{status}")
        } else {
            kind.clone()
        };
        let part_key = opencode_part_key(&session_id, &part_id);
        let previous = self
            .part_kinds
            .write()
            .await
            .insert(part_key, storage_kind.clone());

        let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id);
        if kind == "reasoning" && previous.is_none() {
            self.broadcast_json_notification(
                "item/started",
                json!({
                    "threadId": thread_id,
                    "item": {
                        "id": part_id,
                        "type": "reasoning",
                    }
                }),
            )
            .await;
            return;
        }

        if kind == "tool" {
            if let Some((event_method, item)) = opencode_tool_part_bridge_event(part) {
                let should_emit = previous.as_deref() != Some(storage_kind.as_str());
                if should_emit {
                    self.broadcast_json_notification(
                        event_method,
                        json!({
                            "threadId": thread_id,
                            "item": item,
                        }),
                    )
                    .await;
                }
            }
        }
    }

    pub(super) async fn handle_message_part_delta(&self, properties: Value) {
        let Some(session_id) = read_string(properties.get("sessionID")) else {
            return;
        };
        let Some(part_id) = read_string(properties.get("partID")) else {
            return;
        };
        let Some(field) = read_string(properties.get("field")) else {
            return;
        };
        let Some(delta) = read_string(properties.get("delta")) else {
            return;
        };
        if field != "text" || delta.is_empty() {
            return;
        }

        let part_key = opencode_part_key(&session_id, &part_id);
        let part_kind = self.part_kinds.read().await.get(&part_key).cloned();
        let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id);
        match part_kind.as_deref() {
            Some("reasoning") => {
                self.broadcast_json_notification(
                    "item/reasoning/textDelta",
                    json!({
                        "threadId": thread_id,
                        "itemId": part_id,
                        "delta": delta,
                    }),
                )
                .await;
            }
            Some("text") => {
                self.broadcast_json_notification(
                    "item/agentMessage/delta",
                    json!({
                        "threadId": thread_id,
                        "itemId": part_id,
                        "delta": delta,
                    }),
                )
                .await;
            }
            _ => {}
        }
    }

    pub(super) async fn handle_permission_asked(
        &self,
        properties: Value,
        directory: Option<String>,
    ) {
        let Some(request) = properties.as_object() else {
            return;
        };
        let Some(id) = read_string(request.get("id")) else {
            return;
        };
        let Some(session_id) = read_string(request.get("sessionID")) else {
            return;
        };
        let directory = match directory {
            Some(directory) => Some(directory),
            None => self
                .session_directories
                .read()
                .await
                .get(&session_id)
                .cloned(),
        };
        let Some(directory) = directory else {
            return;
        };

        let tool = request.get("tool").and_then(Value::as_object);
        let approval = PendingApproval {
            id: id.clone(),
            kind: opencode_permission_kind(read_string(request.get("permission")).as_deref())
                .to_string(),
            thread_id: encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
            turn_id: read_string(tool.and_then(|tool| tool.get("messageID")))
                .unwrap_or_else(|| session_id.clone()),
            item_id: read_string(tool.and_then(|tool| tool.get("callID")))
                .unwrap_or_else(|| id.clone()),
            requested_at: now_iso(),
            reason: read_string(request.get("permission")),
            command: request
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|metadata| {
                    read_shell_command(metadata.get("command"))
                        .or_else(|| read_string(metadata.get("command")))
                }),
            cwd: Some(directory.clone()),
            grant_root: None,
            proposed_execpolicy_amendment: None,
        };

        self.pending_approvals.lock().await.insert(
            id.clone(),
            OpencodePendingApprovalEntry {
                approval: approval.clone(),
                directory,
            },
        );

        self.broadcast_json_notification(
            "bridge/approval.requested",
            serde_json::to_value(approval).unwrap_or(Value::Null),
        )
        .await;
    }

    pub(super) async fn handle_permission_replied(&self, properties: Value) {
        let Some(request_id) = read_string(properties.get("requestID")) else {
            return;
        };
        let Some(pending) = self.pending_approvals.lock().await.remove(&request_id) else {
            return;
        };
        let decision = match read_string(properties.get("reply")).as_deref() {
            Some("always") => "acceptForSession",
            Some("reject") => "decline",
            _ => "accept",
        };

        self.broadcast_json_notification(
            "bridge/approval.resolved",
            json!({
                "id": pending.approval.id,
                "threadId": pending.approval.thread_id,
                "decision": decision,
                "resolvedAt": now_iso(),
            }),
        )
        .await;
    }

    pub(super) async fn handle_question_asked(&self, properties: Value, directory: Option<String>) {
        let Some(request) = properties.as_object() else {
            return;
        };
        let Some(id) = read_string(request.get("id")) else {
            return;
        };
        let Some(session_id) = read_string(request.get("sessionID")) else {
            return;
        };
        let directory = match directory {
            Some(directory) => Some(directory),
            None => self
                .session_directories
                .read()
                .await
                .get(&session_id)
                .cloned(),
        };
        let Some(directory) = directory else {
            return;
        };

        let tool = request.get("tool").and_then(Value::as_object);
        let raw_questions = request
            .get("questions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut questions = Vec::new();
        for (index, raw_question) in raw_questions.iter().enumerate() {
            let Some(question) = raw_question.as_object() else {
                continue;
            };
            let Some(header) = read_string(question.get("header")) else {
                continue;
            };
            let Some(question_text) = read_string(question.get("question")) else {
                continue;
            };
            let options = question
                .get("options")
                .and_then(Value::as_array)
                .map(|options| {
                    options
                        .iter()
                        .filter_map(Value::as_object)
                        .filter_map(|option| {
                            let label = read_string(option.get("label"))?;
                            let description =
                                read_string(option.get("description")).unwrap_or_default();
                            Some(PendingUserInputQuestionOption { label, description })
                        })
                        .collect::<Vec<_>>()
                })
                .filter(|options| !options.is_empty());

            questions.push(PendingUserInputQuestion {
                id: format!("{id}:{index}"),
                header,
                question: question_text,
                is_other: read_bool(question.get("custom")).unwrap_or(true),
                is_secret: false,
                options,
            });
        }

        if questions.is_empty() {
            return;
        }

        let request_payload = PendingUserInputRequest {
            id: id.clone(),
            thread_id: encode_engine_qualified_id(BridgeRuntimeEngine::Opencode, &session_id),
            turn_id: read_string(tool.and_then(|tool| tool.get("messageID")))
                .unwrap_or_else(|| session_id.clone()),
            item_id: read_string(tool.and_then(|tool| tool.get("callID")))
                .unwrap_or_else(|| id.clone()),
            requested_at: now_iso(),
            questions,
        };

        self.pending_user_inputs.lock().await.insert(
            id.clone(),
            OpencodePendingUserInputEntry {
                request: request_payload.clone(),
                directory,
            },
        );

        self.broadcast_json_notification(
            "bridge/userInput.requested",
            serde_json::to_value(request_payload).unwrap_or(Value::Null),
        )
        .await;
    }

    pub(super) async fn handle_question_resolved(&self, properties: Value) {
        let Some(request_id) = read_string(properties.get("requestID")) else {
            return;
        };
        let Some(pending) = self.pending_user_inputs.lock().await.remove(&request_id) else {
            return;
        };

        self.broadcast_json_notification(
            "bridge/userInput.resolved",
            json!({
                "id": pending.request.id,
                "threadId": pending.request.thread_id,
                "turnId": pending.request.turn_id,
                "resolvedAt": now_iso(),
            }),
        )
        .await;
    }

    pub(super) async fn cache_session_info(&self, info: &Value) {
        let Some(session_id) = read_string(info.get("id")) else {
            return;
        };
        let Some(directory) = read_string(info.get("directory")) else {
            return;
        };
        self.session_directories
            .write()
            .await
            .insert(session_id, directory);
    }

    pub(super) async fn current_directory_for_session(&self, session_id: &str) -> String {
        self.session_directories
            .read()
            .await
            .get(session_id)
            .cloned()
            .unwrap_or_else(|| self.fallback_directory.clone())
    }

    pub(super) async fn current_status_for_session(&self, session_id: &str) -> Option<String> {
        self.session_statuses.read().await.get(session_id).cloned()
    }

    pub(super) async fn forward_request(
        &self,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        match self.dispatch_request(method, params).await {
            Ok(result) => {
                let normalized =
                    normalize_forwarded_result(method, result, BridgeRuntimeEngine::Opencode);
                self.hub
                    .send_json(
                        client_id,
                        json!({ "id": client_request_id, "result": normalized }),
                    )
                    .await;
                Ok(())
            }
            Err(error) => {
                let code = if error.starts_with("unsupported opencode backend method:") {
                    -32601
                } else {
                    -32000
                };
                self.hub
                    .send_json(
                        client_id,
                        json!({
                            "id": client_request_id,
                            "error": {
                                "code": code,
                                "message": error,
                            }
                        }),
                    )
                    .await;
                Ok(())
            }
        }
    }

    pub(super) async fn request_internal(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        self.dispatch_request(method, params).await
    }

    pub(super) async fn list_pending_approvals(&self) -> Vec<PendingApproval> {
        let mut approvals = self
            .pending_approvals
            .lock()
            .await
            .values()
            .map(|entry| entry.approval.clone())
            .collect::<Vec<_>>();
        approvals.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        approvals
    }

    pub(super) async fn list_pending_user_inputs(&self) -> Vec<PendingUserInputRequest> {
        let mut requests = self
            .pending_user_inputs
            .lock()
            .await
            .values()
            .map(|entry| entry.request.clone())
            .collect::<Vec<_>>();
        requests.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        requests
    }

    pub(super) async fn resolve_approval(
        &self,
        approval_id: &str,
        decision: &Value,
    ) -> Result<Option<PendingApproval>, String> {
        let pending = self.pending_approvals.lock().await.remove(approval_id);
        let Some(pending) = pending else {
            return Ok(None);
        };

        let reply = match parse_approval_decision(decision) {
            Some(ApprovalDecisionCanonical::AcceptForSession) => "always",
            Some(ApprovalDecisionCanonical::Accept)
            | Some(ApprovalDecisionCanonical::AcceptWithExecpolicyAmendment(_)) => "once",
            Some(ApprovalDecisionCanonical::Decline) | Some(ApprovalDecisionCanonical::Cancel) => {
                "reject"
            }
            None => {
                self.pending_approvals
                    .lock()
                    .await
                    .insert(approval_id.to_string(), pending.clone());
                return Err("invalid approval decision payload".to_string());
            }
        };

        let body = json!({ "reply": reply });
        if let Err(error) = self
            .request_json(
                HttpMethod::POST,
                &format!("permission/{approval_id}/reply"),
                Some(&pending.directory),
                None,
                Some(body),
            )
            .await
        {
            self.pending_approvals
                .lock()
                .await
                .insert(approval_id.to_string(), pending.clone());
            return Err(error);
        }

        self.broadcast_json_notification(
            "bridge/approval.resolved",
            json!({
                "id": pending.approval.id,
                "threadId": pending.approval.thread_id,
                "decision": decision,
                "resolvedAt": now_iso(),
            }),
        )
        .await;

        Ok(Some(pending.approval))
    }

    pub(super) async fn resolve_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, UserInputAnswerPayload>,
    ) -> Result<Option<PendingUserInputRequest>, String> {
        let pending = self.pending_user_inputs.lock().await.remove(request_id);
        let Some(pending) = pending else {
            return Ok(None);
        };

        let ordered_answers = pending
            .request
            .questions
            .iter()
            .map(|question| {
                answers
                    .get(&question.id)
                    .map(|answer| answer.answers.clone())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>();

        let body = json!({ "answers": ordered_answers });
        if let Err(error) = self
            .request_json(
                HttpMethod::POST,
                &format!("question/{request_id}/reply"),
                Some(&pending.directory),
                None,
                Some(body),
            )
            .await
        {
            self.pending_user_inputs
                .lock()
                .await
                .insert(request_id.to_string(), pending.clone());
            return Err(error);
        }

        self.broadcast_json_notification(
            "bridge/userInput.resolved",
            json!({
                "id": pending.request.id,
                "threadId": pending.request.thread_id,
                "turnId": pending.request.turn_id,
                "resolvedAt": now_iso(),
            }),
        )
        .await;

        Ok(Some(pending.request))
    }

    pub(super) async fn dispatch_request(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        match method {
            "account/logout" => Ok(json!({})),
            "account/rateLimits/read" => Ok(json!({})),
            "account/read" => Ok(json!({
                "account": Value::Null,
                "requiresOpenaiAuth": false,
            })),
            "config/read" => Ok(json!({ "config": {} })),
            "agent/list" => self.list_agents(params).await,
            "thread/list" => self.list_threads(params).await,
            "thread/loaded/list" => self.list_loaded_threads().await,
            "thread/read" => self.read_thread(params).await,
            "thread/start" => self.start_thread(params).await,
            "thread/name/set" => self.set_thread_name(params).await,
            "thread/fork" => self.fork_thread(params).await,
            "thread/compact/start" => self.compact_thread(params).await,
            "thread/resume" => Ok(json!({
                "model": Value::Null,
                "effort": Value::Null,
            })),
            "review/start" => Err("review/start is not supported for opencode threads".to_string()),
            "turn/start" => self.start_turn(params).await,
            "turn/interrupt" => self.interrupt_turn(params).await,
            "model/list" => self.list_models(params).await,
            _ => Err(format!("unsupported opencode backend method: {method}")),
        }
    }

    pub(super) async fn list_threads(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let limit = params_object
            .and_then(|params| params.get("limit"))
            .and_then(Value::as_u64)
            .unwrap_or(200)
            .clamp(1, 1000);
        let cwd = read_string(params_object.and_then(|params| params.get("cwd")));
        let archived = params_object
            .and_then(|params| params.get("archived"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut query = vec![("limit", limit.to_string())];
        if let Some(cwd) = cwd.as_deref() {
            query.push(("directory", cwd.to_string()));
        }
        if archived {
            query.push(("archived", "true".to_string()));
        }
        let sessions = match self
            .request_json(
                HttpMethod::GET,
                "experimental/session",
                None,
                Some(query.clone()),
                None,
            )
            .await
        {
            Ok(result) => result,
            Err(error) => {
                eprintln!(
                    "opencode experimental session list unavailable; falling back to directory-scoped session list: {error}"
                );
                self.request_json(HttpMethod::GET, "session", None, Some(query), None)
                    .await?
            }
        };
        let statuses = self
            .request_json(
                HttpMethod::GET,
                "session/status",
                cwd.as_deref(),
                None,
                None,
            )
            .await
            .ok();
        let session_entries = sessions.as_array().cloned().unwrap_or_default();
        let status_map = statuses.as_ref().and_then(Value::as_object);

        let mut data = Vec::new();
        for session in session_entries {
            if !archived
                && session
                    .get("time")
                    .and_then(Value::as_object)
                    .and_then(|time| time.get("archived"))
                    .is_some()
            {
                continue;
            }

            self.cache_session_info(&session).await;
            let session_id = read_string(session.get("id")).unwrap_or_default();
            let status = status_map
                .and_then(|statuses| statuses.get(&session_id))
                .and_then(Value::as_object)
                .and_then(|status| read_string(status.get("type")));
            let thread = self
                .project_session_to_thread(&session, status.as_deref(), None)
                .await;
            data.push(thread);
        }

        data.sort_by(|a, b| {
            let left = a.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
            let right = b.get("updatedAt").and_then(Value::as_u64).unwrap_or(0);
            right.cmp(&left)
        });

        Ok(json!({ "data": data }))
    }

    pub(super) async fn list_loaded_threads(&self) -> Result<Value, String> {
        let statuses = self
            .request_json(HttpMethod::GET, "session/status", None, None, None)
            .await?;
        let ids = statuses
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(session_id, status)| {
                let status_type = status
                    .as_object()
                    .and_then(|status| read_string(status.get("type")));
                if opencode_status_is_active(status_type.as_deref()) {
                    Some(session_id.clone())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        Ok(json!({ "data": ids }))
    }

    pub(super) async fn read_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/read requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/read requires threadId".to_string())?;
        let include_turns = params_object
            .get("includeTurns")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let directory = self.current_directory_for_session(&session_id).await;
        let session = self
            .request_json(
                HttpMethod::GET,
                &format!("session/{session_id}"),
                Some(&directory),
                None,
                None,
            )
            .await?;
        self.cache_session_info(&session).await;

        let messages = if include_turns {
            Some(
                self.request_json(
                    HttpMethod::GET,
                    &format!("session/{session_id}/message"),
                    Some(&directory),
                    None,
                    None,
                )
                .await?,
            )
        } else {
            None
        };

        let fetched_status = self
            .request_json(
                HttpMethod::GET,
                "session/status",
                Some(&directory),
                None,
                None,
            )
            .await
            .ok()
            .and_then(|statuses| {
                statuses
                    .as_object()
                    .and_then(|statuses| statuses.get(&session_id).cloned())
            })
            .and_then(|status| {
                status
                    .as_object()
                    .and_then(|status| read_string(status.get("type")))
            });
        let status = match fetched_status {
            Some(status) => Some(status),
            None => self.current_status_for_session(&session_id).await,
        };
        let thread = self
            .project_session_to_thread(&session, status.as_deref(), messages.as_ref())
            .await;
        Ok(json!({ "thread": thread }))
    }

    pub(super) async fn start_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let directory = read_string(params_object.and_then(|params| params.get("cwd")))
            .unwrap_or_else(|| self.fallback_directory.clone());
        let title = read_string(params_object.and_then(|params| params.get("threadName")))
            .or_else(|| read_string(params_object.and_then(|params| params.get("name"))));
        let body = title
            .map(|title| json!({ "title": title }))
            .unwrap_or_else(|| json!({}));
        let session = self
            .request_json(
                HttpMethod::POST,
                "session",
                Some(&directory),
                None,
                Some(body),
            )
            .await?;
        self.cache_session_info(&session).await;
        let thread = self.project_session_to_thread(&session, None, None).await;
        Ok(json!({ "thread": thread }))
    }

    pub(super) async fn list_models(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let requested_directory = read_string(params_object.and_then(|params| params.get("cwd")));
        let thread_id = read_string(params_object.and_then(|params| params.get("threadId")));
        let directory = match (
            requested_directory.filter(|value| !value.is_empty()),
            thread_id.filter(|value| !value.is_empty()),
        ) {
            (Some(directory), _) => directory,
            (None, Some(session_id)) => self.current_directory_for_session(&session_id).await,
            (None, None) => self.fallback_directory.clone(),
        };

        let configured_providers = self
            .request_json(
                HttpMethod::GET,
                "config/providers",
                Some(&directory),
                None,
                None,
            )
            .await?;
        let provider_catalog = self
            .request_json(HttpMethod::GET, "provider", Some(&directory), None, None)
            .await
            .ok();
        let config = self
            .request_json(HttpMethod::GET, "config", Some(&directory), None, None)
            .await
            .ok();

        Ok(json!({
            "data": opencode_flatten_model_options(
                &configured_providers,
                provider_catalog.as_ref(),
                config.as_ref(),
            )
        }))
    }

    pub(super) async fn list_agents(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params.as_ref().and_then(Value::as_object);
        let requested_directory = read_string(params_object.and_then(|params| params.get("cwd")));
        let thread_id = read_string(params_object.and_then(|params| params.get("threadId")));
        let directory = match (
            requested_directory.filter(|value| !value.is_empty()),
            thread_id.filter(|value| !value.is_empty()),
        ) {
            (Some(directory), _) => directory,
            (None, Some(session_id)) => self.current_directory_for_session(&session_id).await,
            (None, None) => self.fallback_directory.clone(),
        };
        let agents = self
            .request_json(HttpMethod::GET, "agent", Some(&directory), None, None)
            .await?;
        let data = agents
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| {
                let agent = value.as_object()?;
                let name = read_string(agent.get("name"))?.trim().to_string();
                let mode = read_string(agent.get("mode"))?.trim().to_ascii_lowercase();
                let hidden = agent
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if name.is_empty()
                    || hidden
                    || !matches!(mode.as_str(), "primary" | "subagent" | "all")
                {
                    return None;
                }
                let custom = agent
                    .get("native")
                    .and_then(Value::as_bool)
                    .map(|native| !native)
                    .or_else(|| {
                        agent
                            .get("builtIn")
                            .and_then(Value::as_bool)
                            .map(|built_in| !built_in)
                    })
                    .unwrap_or(true);
                let model = agent
                    .get("model")
                    .and_then(Value::as_object)
                    .and_then(|model| {
                        let provider_id = read_string(model.get("providerID"))?;
                        let model_id = read_string(model.get("modelID"))?;
                        Some(format!("{provider_id}/{model_id}"))
                    });
                Some(json!({
                    "id": name,
                    "name": name,
                    "description": read_string(agent.get("description")),
                    "mode": mode,
                    "custom": custom,
                    "color": read_string(agent.get("color")),
                    "model": model,
                }))
            })
            .collect::<Vec<_>>();
        Ok(json!({ "data": data }))
    }

    pub(super) async fn set_thread_name(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/name/set requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/name/set requires threadId".to_string())?;
        let thread_name = read_string(params_object.get("threadName"))
            .or_else(|| read_string(params_object.get("name")))
            .ok_or_else(|| "thread/name/set requires threadName".to_string())?;
        let directory = self.current_directory_for_session(&session_id).await;

        let session = self
            .request_json(
                HttpMethod::PATCH,
                &format!("session/{session_id}"),
                Some(&directory),
                None,
                Some(json!({ "title": thread_name })),
            )
            .await?;
        self.cache_session_info(&session).await;
        Ok(json!({}))
    }

    pub(super) async fn fork_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/fork requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/fork requires threadId".to_string())?;
        let directory = read_string(params_object.get("cwd"))
            .unwrap_or_else(|| self.fallback_directory.clone());
        let directory = if directory == self.fallback_directory {
            self.current_directory_for_session(&session_id).await
        } else {
            directory
        };

        let session = self
            .request_json(
                HttpMethod::POST,
                &format!("session/{session_id}/fork"),
                Some(&directory),
                None,
                Some(json!({})),
            )
            .await?;
        self.cache_session_info(&session).await;
        let thread = self.project_session_to_thread(&session, None, None).await;
        Ok(json!({ "thread": thread }))
    }

    pub(super) async fn compact_thread(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "thread/compact/start requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "thread/compact/start requires threadId".to_string())?;
        let directory = self.current_directory_for_session(&session_id).await;
        let configured_providers = self
            .request_json(
                HttpMethod::GET,
                "config/providers",
                Some(&directory),
                None,
                None,
            )
            .await?;
        let provider_catalog = self
            .request_json(HttpMethod::GET, "provider", Some(&directory), None, None)
            .await
            .ok();
        let config = self
            .request_json(HttpMethod::GET, "config", Some(&directory), None, None)
            .await
            .ok();
        let (provider_id, model_id) = opencode_default_model_selector(
            &configured_providers,
            provider_catalog.as_ref(),
            config.as_ref(),
        )
        .ok_or_else(|| "opencode compaction requires an available default model".to_string())?;

        self.request_json(
            HttpMethod::POST,
            &format!("session/{session_id}/summarize"),
            Some(&directory),
            None,
            Some(json!({
                "providerID": provider_id,
                "modelID": model_id,
            })),
        )
        .await?;

        Ok(json!({}))
    }

    pub(super) async fn start_turn(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "turn/start requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "turn/start requires threadId".to_string())?;
        let directory = match read_string(params_object.get("cwd")) {
            Some(directory) => directory,
            None => self.current_directory_for_session(&session_id).await,
        };
        let input = params_object
            .get("input")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let parts = opencode_prompt_parts_from_turn_input(&input);
        if parts.is_empty() {
            return Err("turn/start requires non-empty input".to_string());
        }

        let mut body = json!({
            "parts": parts,
        });
        if let Some(agent) = read_string(params_object.get("agent")).or_else(|| {
            opencode_agent_for_collaboration_mode(params_object.get("collaborationMode"))
                .map(str::to_string)
        }) {
            body["agent"] = Value::String(agent);
        }
        let requested_effort = read_string(params_object.get("effort"));
        let mut configured_providers: Option<Value> = None;
        let config = if requested_effort.is_some() {
            Some(
                self.request_json(HttpMethod::GET, "config", Some(&directory), None, None)
                    .await
                    .ok(),
            )
            .flatten()
        } else {
            None
        };
        let mut resolved_model = params_object
            .get("model")
            .and_then(Value::as_str)
            .and_then(parse_opencode_model_selector);

        if requested_effort.is_some() || resolved_model.is_none() {
            configured_providers = Some(
                self.request_json(
                    HttpMethod::GET,
                    "config/providers",
                    Some(&directory),
                    None,
                    None,
                )
                .await?,
            );
        }

        if resolved_model.is_none() {
            resolved_model = configured_providers.as_ref().and_then(|providers| {
                opencode_default_model_selector(providers, None, config.as_ref())
            });
        }

        if let Some((provider_id, model_id)) = resolved_model.as_ref() {
            body["model"] = json!({
                "providerID": provider_id,
                "modelID": model_id,
            });
            if let (Some(requested_effort), Some(configured_providers)) =
                (requested_effort.as_deref(), configured_providers.as_ref())
            {
                if let Some(variant) = opencode_variant_for_effort(
                    configured_providers,
                    provider_id,
                    model_id,
                    requested_effort,
                ) {
                    body["variant"] = Value::String(variant);
                }
            }
        }

        let before_message_id = self
            .latest_user_message_id(&session_id, &directory)
            .await
            .ok()
            .flatten();
        self.request_json(
            HttpMethod::POST,
            &format!("session/{session_id}/prompt_async"),
            Some(&directory),
            None,
            Some(body),
        )
        .await?;

        let turn_id = self
            .wait_for_new_user_message_id(&session_id, &directory, before_message_id.as_deref())
            .await?
            .unwrap_or_else(|| format!("turn-{}", Utc::now().timestamp_millis()));
        self.active_turns
            .write()
            .await
            .insert(session_id.clone(), turn_id.clone());

        Ok(json!({
            "turn": {
                "id": turn_id,
            }
        }))
    }

    pub(super) async fn interrupt_turn(&self, params: Option<Value>) -> Result<Value, String> {
        let params_object = params
            .as_ref()
            .and_then(Value::as_object)
            .ok_or_else(|| "turn/interrupt requires params".to_string())?;
        let session_id = read_string(params_object.get("threadId"))
            .ok_or_else(|| "turn/interrupt requires threadId".to_string())?;
        let directory = self.current_directory_for_session(&session_id).await;
        self.request_json(
            HttpMethod::POST,
            &format!("session/{session_id}/abort"),
            Some(&directory),
            None,
            None,
        )
        .await?;
        self.interrupted_sessions.write().await.insert(session_id);
        Ok(json!({}))
    }

    pub(super) async fn latest_user_message_id(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<Option<String>, String> {
        let messages = self
            .request_json(
                HttpMethod::GET,
                &format!("session/{session_id}/message"),
                Some(directory),
                None,
                None,
            )
            .await?;
        Ok(opencode_latest_user_message_id(&messages))
    }

    pub(super) async fn wait_for_new_user_message_id(
        &self,
        session_id: &str,
        directory: &str,
        previous_id: Option<&str>,
    ) -> Result<Option<String>, String> {
        for _ in 0..20 {
            let latest = self.latest_user_message_id(session_id, directory).await?;
            if let Some(latest) = latest {
                if previous_id != Some(latest.as_str()) {
                    return Ok(Some(latest));
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        Ok(None)
    }

    pub(super) async fn project_session_to_thread(
        &self,
        session: &Value,
        status: Option<&str>,
        messages: Option<&Value>,
    ) -> Value {
        let session_object = session.as_object().cloned().unwrap_or_default();
        let session_id = read_string(session_object.get("id")).unwrap_or_default();
        let created_at_ms = session_object
            .get("time")
            .and_then(Value::as_object)
            .and_then(|time| time.get("created"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let updated_at_ms = session_object
            .get("time")
            .and_then(Value::as_object)
            .and_then(|time| time.get("updated"))
            .and_then(Value::as_u64)
            .unwrap_or(created_at_ms);
        let active_turn_id = self.active_turns.read().await.get(&session_id).cloned();
        let turns = messages.map(|messages| {
            opencode_messages_to_turns(&session_id, messages, status, active_turn_id.as_deref())
        });

        let preview = messages
            .and_then(opencode_thread_preview_from_messages)
            .unwrap_or_default();
        let source = read_string(session_object.get("parentID"))
            .map(|parent_id| {
                json!({
                    "kind": "subAgentThreadSpawn",
                    "parentThreadId": parent_id,
                })
            })
            .unwrap_or_else(|| json!("appServer"));

        let mut thread = json!({
            "id": session_id,
            "name": read_string(session_object.get("title")),
            "title": read_string(session_object.get("title")),
            "preview": preview,
            "createdAt": created_at_ms / 1000,
            "updatedAt": updated_at_ms / 1000,
            "status": {
                "type": if opencode_status_is_active(status) { "running" } else { "idle" }
            },
            "cwd": read_string(session_object.get("directory")),
            "source": source,
        });

        if let Some(turns) = turns {
            thread["turns"] = Value::Array(turns);
        }

        thread
    }

    pub(super) async fn request_json(
        &self,
        method: HttpMethod,
        path: &str,
        directory: Option<&str>,
        query: Option<Vec<(&str, String)>>,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut url = self
            .base_url
            .join(path)
            .map_err(|error| format!("invalid opencode path {path}: {error}"))?;
        if let Some(query) = query {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, &value);
            }
        }

        let mut request = self.http.request(method, url);
        if let Some(password) = self.password.as_deref() {
            request = request.basic_auth(&self.username, Some(password));
        }
        if let Some(directory) = directory
            .map(str::trim)
            .filter(|directory| !directory.is_empty())
        {
            request = request.header("x-opencode-directory", directory);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("opencode request {path} failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "opencode request {path} failed with HTTP {} (response body redacted)",
                status.as_u16()
            ));
        }
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }

        response
            .json::<Value>()
            .await
            .map_err(|error| format!("failed decoding opencode response for {path}: {error}"))
    }

    pub(super) async fn broadcast_json_notification(&self, method: &str, params: Value) {
        self.hub.broadcast_notification(method, params).await;
    }
}
