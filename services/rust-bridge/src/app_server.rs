use crate::*;

pub(super) struct AppServerBridge {
    pub(super) engine: BridgeRuntimeEngine,
    pub(super) child: Mutex<Child>,
    pub(super) child_pid: u32,
    pub(super) writer: Mutex<ChildStdin>,
    pub(super) pending_requests: Mutex<HashMap<u64, PendingRequest>>,
    pub(super) internal_waiters: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    pub(super) pending_approvals: Mutex<HashMap<String, PendingApprovalEntry>>,
    pub(super) pending_user_inputs: Mutex<HashMap<String, PendingUserInputEntry>>,
    pub(super) next_request_id: AtomicU64,
    pub(super) approval_counter: AtomicU64,
    pub(super) user_input_counter: AtomicU64,
    pub(super) hub: Arc<ClientHub>,
    pub(super) lifecycle: Arc<BackendRuntimeStatus>,
    pub(super) metrics: Arc<OperationalMetrics>,
    pub(super) timed_out_requests: AtomicU64,
    pub(super) request_timeout: Duration,
}

pub(super) struct PendingRequest {
    pub(super) client_id: u64,
    pub(super) client_request_id: Value,
    pub(super) method: String,
    pub(super) cached_chatgpt_auth: Option<BridgeChatGptAuthBundle>,
    pub(super) clear_cached_chatgpt_auth_on_success: bool,
    pub(super) _in_flight_permits: Option<InFlightRequestPermits>,
    pub(super) trace: RequestTrace,
}

pub(super) struct InFlightRequestPermits {
    pub(super) _client: OwnedSemaphorePermit,
    pub(super) _global: OwnedSemaphorePermit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(super) struct BridgeChatGptAuthBundle {
    pub(super) access_token: String,
    pub(super) account_id: String,
    pub(super) plan_type: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) enum ApprovalResponseFormat {
    Modern,
    Legacy,
}

#[derive(Clone)]
pub(super) struct PendingApprovalEntry {
    pub(super) app_server_request_id: Value,
    pub(super) response_format: ApprovalResponseFormat,
    pub(super) approval: PendingApproval,
}

#[derive(Clone)]
pub(super) struct PendingUserInputEntry {
    pub(super) app_server_request_id: Value,
    pub(super) request: PendingUserInputRequest,
}

impl AppServerBridge {
    pub(super) async fn start_codex(
        cli_bin: &str,
        hub: Arc<ClientHub>,
        metrics: Arc<OperationalMetrics>,
    ) -> Result<Arc<Self>, String> {
        let mut command = Command::new(cli_bin);
        command
            .arg("app-server")
            .arg("--listen")
            .arg("stdio://")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Self::start_with_command(command, BridgeRuntimeEngine::Codex, hub, metrics).await
    }

    pub(super) async fn start_cursor(
        cursor_app_server_bin: &str,
        api_key: &str,
        workdir: &Path,
        hub: Arc<ClientHub>,
        metrics: Arc<OperationalMetrics>,
    ) -> Result<Arc<Self>, String> {
        let mut command = Command::new(cursor_app_server_bin);
        command
            .env("CURSOR_API_KEY", api_key)
            .env("CURSOR_WORKDIR", workdir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        Self::start_with_command(command, BridgeRuntimeEngine::Cursor, hub, metrics).await
    }

    pub(super) async fn start_with_command(
        command: Command,
        engine: BridgeRuntimeEngine,
        hub: Arc<ClientHub>,
        metrics: Arc<OperationalMetrics>,
    ) -> Result<Arc<Self>, String> {
        Self::start_with_command_timeout(command, engine, hub, metrics, APP_SERVER_REQUEST_TIMEOUT)
            .await
    }

    pub(super) async fn start_with_command_timeout(
        mut command: Command,
        engine: BridgeRuntimeEngine,
        hub: Arc<ClientHub>,
        metrics: Arc<OperationalMetrics>,
        request_timeout: Duration,
    ) -> Result<Arc<Self>, String> {
        configure_managed_child_command(&mut command);

        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start app-server: {error}"))?;
        let child_pid = child
            .id()
            .ok_or_else(|| "app-server pid unavailable".to_string())?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "app-server stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "app-server stdout unavailable".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "app-server stderr unavailable".to_string())?;

        let bridge = Arc::new(Self {
            engine,
            child: Mutex::new(child),
            child_pid,
            writer: Mutex::new(stdin),
            pending_requests: Mutex::new(HashMap::new()),
            internal_waiters: Mutex::new(HashMap::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            pending_user_inputs: Mutex::new(HashMap::new()),
            next_request_id: AtomicU64::new(1),
            approval_counter: AtomicU64::new(1),
            user_input_counter: AtomicU64::new(1),
            hub,
            lifecycle: Arc::new(BackendRuntimeStatus::starting()),
            metrics,
            timed_out_requests: AtomicU64::new(0),
            request_timeout,
        });

        bridge.spawn_stdout_loop(stdout);
        bridge.spawn_stderr_loop(stderr);
        bridge.spawn_wait_loop();

        if let Err(error) = bridge.initialize().await {
            bridge
                .lifecycle
                .transition(BackendLifecycleState::Degraded, Some(error.clone()))
                .await;
            bridge.request_shutdown().await;
            let _ = timeout(Duration::from_secs(5), async {
                let mut child = bridge.child.lock().await;
                child.wait().await
            })
            .await;
            bridge
                .lifecycle
                .transition(BackendLifecycleState::Dead, Some(error.clone()))
                .await;
            return Err(error);
        }
        bridge
            .lifecycle
            .transition(BackendLifecycleState::Ready, None)
            .await;

        Ok(bridge)
    }

    pub(super) async fn request_shutdown(&self) {
        self.lifecycle
            .transition(
                BackendLifecycleState::Degraded,
                Some("shutdown requested".to_string()),
            )
            .await;
        terminate_managed_child(self.child_pid, "app-server").await;
    }

    pub(super) async fn initialize(&self) -> Result<(), String> {
        let init_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.internal_waiters.lock().await.insert(init_id, tx);

        let initialize_request = json!({
            "id": init_id,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "clawdex-mobile-rust-bridge",
                    "title": "Clawdex Mobile Rust Bridge",
                    "version": "0.1.0"
                },
                "capabilities": {
                    "experimentalApi": true
                }
            }
        });

        if let Err(error) = self.write_json(initialize_request).await {
            self.internal_waiters.lock().await.remove(&init_id);
            return Err(format!("initialize write failed: {error}"));
        }

        let init_result = timeout(Duration::from_secs(15), rx)
            .await
            .map_err(|_| "app-server initialize timed out".to_string());
        if init_result.is_err() {
            self.internal_waiters.lock().await.remove(&init_id);
        }
        let init_result = init_result?;

        match init_result {
            Ok(Ok(_)) => {}
            Ok(Err(message)) => return Err(format!("app-server initialize failed: {message}")),
            Err(_) => return Err("app-server initialize waiter dropped".to_string()),
        }

        self.write_json(json!({
            "method": "initialized",
            "params": {}
        }))
        .await
        .map_err(|error| format!("initialized write failed: {error}"))?;

        Ok(())
    }

    pub(super) fn spawn_stdout_loop(self: &Arc<Self>, stdout: ChildStdout) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();

            loop {
                match lines.next_line().await {
                    Ok(Some(line)) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }

                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(value) => this.handle_incoming(value).await,
                            Err(error) => eprintln!(
                                "{}",
                                json!({
                                    "timestamp": now_iso(),
                                    "level": "warn",
                                    "event": "backend_protocol_parse_failed",
                                    "backend": this.engine.as_str(),
                                    "kind": format!("{:?}", error.classify()),
                                })
                            ),
                        }
                    }
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("app-server stdout read error: {error}");
                        break;
                    }
                }
            }
        });
    }

    pub(super) fn spawn_stderr_loop(self: &Arc<Self>, stderr: tokio::process::ChildStderr) {
        let backend = self.engine.as_str();
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
                            "backend": backend,
                            "redacted": true,
                        })
                    ),
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("app-server stderr read error: {error}");
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
                Ok(status) => {
                    eprintln!("app-server exited with status: {status}");
                }
                Err(error) => {
                    eprintln!("failed waiting for app-server exit: {error}");
                }
            }

            this.fail_all_pending("app-server closed").await;
            this.fail_all_internal("app-server closed").await;
            this.pending_approvals.lock().await.clear();
            this.pending_user_inputs.lock().await.clear();
            this.lifecycle
                .transition(
                    BackendLifecycleState::Dead,
                    Some("app-server exited".to_string()),
                )
                .await;
        });
    }

    pub(super) async fn fail_all_pending(&self, message: &str) {
        let pending_entries = {
            let mut pending = self.pending_requests.lock().await;
            pending.drain().map(|(_, entry)| entry).collect::<Vec<_>>()
        };

        for pending in pending_entries {
            self.hub
                .send_json(
                    pending.client_id,
                    json!({
                        "id": pending.client_request_id,
                        "error": {
                            "code": -32000,
                            "message": message
                        }
                    }),
                )
                .await;
        }
    }

    pub(super) async fn fail_all_internal(&self, message: &str) {
        let waiters = self
            .internal_waiters
            .lock()
            .await
            .drain()
            .map(|(_, waiter)| waiter)
            .collect::<Vec<_>>();
        for waiter in waiters {
            let _ = waiter.send(Err(message.to_string()));
        }
    }

    pub(super) async fn cancel_client_requests(&self, client_id: u64) {
        self.pending_requests
            .lock()
            .await
            .retain(|_, pending| pending.client_id != client_id);
    }

    #[allow(dead_code)]
    pub(super) async fn forward_request(
        self: &Arc<Self>,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        self.forward_request_with_permits(client_id, client_request_id, method, params, None)
            .await
    }

    pub(super) async fn forward_request_with_permits(
        self: &Arc<Self>,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        params: Option<Value>,
        permits: Option<InFlightRequestPermits>,
    ) -> Result<(), String> {
        let internal_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let trace = self.metrics.start_request(method, self.engine.as_str());
        let cached_chatgpt_auth =
            extract_chatgpt_auth_tokens_from_account_login_start(params.as_ref());
        let clear_cached_chatgpt_auth_on_success = method == "account/logout";

        {
            let mut pending = self.pending_requests.lock().await;
            pending.insert(
                internal_id,
                PendingRequest {
                    client_id,
                    client_request_id,
                    method: method.to_string(),
                    cached_chatgpt_auth,
                    clear_cached_chatgpt_auth_on_success,
                    _in_flight_permits: permits,
                    trace,
                },
            );
        }

        let mut payload = json!({
            "id": internal_id,
            "method": method,
        });
        if let Some(params) = params {
            payload["params"] = params;
        }

        if let Err(error) = self.write_json(payload).await {
            if let Some(pending) = self.pending_requests.lock().await.remove(&internal_id) {
                self.metrics.finish_request(&pending.trace, "write_error");
                self.metrics.record_error(
                    Some(&pending.trace.request_id),
                    Some(method),
                    Some(self.engine.as_str()),
                    "backend_write_error",
                );
            }
            return Err(format!("failed forwarding request to app-server: {error}"));
        }

        let this = Arc::clone(self);
        tokio::spawn(async move {
            sleep(this.request_timeout).await;
            let pending = this.pending_requests.lock().await.remove(&internal_id);
            if let Some(pending) = pending {
                this.timed_out_requests.fetch_add(1, Ordering::Relaxed);
                this.metrics.time_out_request(&pending.trace);
                this.hub
                    .send_json(
                        pending.client_id,
                        json!({
                            "id": pending.client_request_id,
                            "error": {
                                "code": -32000,
                                "message": format!("app-server request timed out: {}", pending.method),
                                "data": { "error": "timeout", "retryable": true }
                            }
                        }),
                    )
                    .await;
            }
        });

        Ok(())
    }

    pub(super) async fn request_internal(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let mut last_transient_error = None;
        for attempt in 0..=APP_SERVER_TRANSIENT_THREAD_READ_RETRY_DELAYS_MS.len() {
            match self.request_internal_once(method, params.clone()).await {
                Ok(result) => return Ok(result),
                Err(error) if is_transient_app_server_thread_read_error(method, &error) => {
                    let delay_ms = APP_SERVER_TRANSIENT_THREAD_READ_RETRY_DELAYS_MS.get(attempt);
                    let Some(delay_ms) = delay_ms else {
                        return Err(error);
                    };
                    last_transient_error = Some(error);
                    sleep(Duration::from_millis(*delay_ms)).await;
                }
                Err(error) => return Err(error),
            }
        }

        Err(last_transient_error
            .unwrap_or_else(|| format!("internal app-server request failed: {method}")))
    }

    pub(super) async fn request_internal_once(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let internal_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        self.internal_waiters.lock().await.insert(internal_id, tx);

        let mut payload = json!({
            "id": internal_id,
            "method": method,
        });
        if let Some(params) = params {
            payload["params"] = params;
        }

        if let Err(error) = self.write_json(payload).await {
            self.internal_waiters.lock().await.remove(&internal_id);
            return Err(format!(
                "failed forwarding internal request to app-server: {error}"
            ));
        }

        match timeout(self.request_timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => Err(message),
            Ok(Err(_)) => Err("internal app-server waiter dropped".to_string()),
            Err(_) => {
                self.internal_waiters.lock().await.remove(&internal_id);
                Err(format!("internal app-server request timed out: {method}"))
            }
        }
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

        let Some(mapped_decision) =
            approval_decision_to_response_value(decision, pending.response_format)
        else {
            self.pending_approvals
                .lock()
                .await
                .insert(approval_id.to_string(), pending.clone());
            return Err("invalid approval decision payload".to_string());
        };

        let response = json!({
            "id": pending.app_server_request_id,
            "result": {
                "decision": mapped_decision
            }
        });

        if let Err(error) = self.write_json(response).await {
            self.pending_approvals
                .lock()
                .await
                .insert(approval_id.to_string(), pending.clone());
            return Err(format!("failed to send approval response: {error}"));
        }

        self.hub
            .broadcast_notification(
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

        let response = json!({
            "id": pending.app_server_request_id,
            "result": {
                "answers": answers
            }
        });

        if let Err(error) = self.write_json(response).await {
            self.pending_user_inputs
                .lock()
                .await
                .insert(request_id.to_string(), pending.clone());
            return Err(format!("failed to send requestUserInput response: {error}"));
        }

        self.hub
            .broadcast_notification(
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

    pub(super) async fn handle_incoming(&self, value: Value) {
        let Some(object) = value.as_object() else {
            return;
        };

        let method = object
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let id = object.get("id").cloned();

        match (method, id) {
            (Some(method), Some(id)) => {
                self.handle_server_request(&method, id, object.get("params").cloned())
                    .await;
            }
            (Some(method), None) => {
                self.handle_notification(&method, object.get("params").cloned())
                    .await;
            }
            (None, Some(_)) => {
                self.handle_response(value).await;
            }
            (None, None) => {}
        }
    }

    pub(super) async fn handle_server_request(
        &self,
        method: &str,
        id: Value,
        params: Option<Value>,
    ) {
        if matches!(
            method,
            APPROVAL_COMMAND_METHOD
                | APPROVAL_FILE_METHOD
                | LEGACY_APPROVAL_PATCH_METHOD
                | LEGACY_APPROVAL_COMMAND_METHOD
        ) {
            let params_obj = params.as_ref().and_then(Value::as_object);
            let approval_id = format!(
                "{}-{}",
                Utc::now().timestamp_millis(),
                self.approval_counter.fetch_add(1, Ordering::Relaxed)
            );

            let response_format = if matches!(
                method,
                LEGACY_APPROVAL_PATCH_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                ApprovalResponseFormat::Legacy
            } else {
                ApprovalResponseFormat::Modern
            };

            let kind = if matches!(
                method,
                APPROVAL_COMMAND_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                "commandExecution".to_string()
            } else {
                "fileChange".to_string()
            };

            let thread_id = if matches!(
                method,
                LEGACY_APPROVAL_PATCH_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                read_string(params_obj.and_then(|p| p.get("conversationId")))
                    .unwrap_or_else(|| "unknown-thread".to_string())
            } else {
                read_string(params_obj.and_then(|p| p.get("threadId")))
                    .unwrap_or_else(|| "unknown-thread".to_string())
            };

            let legacy_call_id = read_string(params_obj.and_then(|p| p.get("callId")));
            let turn_id = if matches!(
                method,
                LEGACY_APPROVAL_PATCH_METHOD | LEGACY_APPROVAL_COMMAND_METHOD
            ) {
                legacy_call_id
                    .clone()
                    .unwrap_or_else(|| "unknown-turn".to_string())
            } else {
                read_string(params_obj.and_then(|p| p.get("turnId")))
                    .unwrap_or_else(|| "unknown-turn".to_string())
            };

            let item_id = if method == LEGACY_APPROVAL_COMMAND_METHOD {
                read_string(params_obj.and_then(|p| p.get("approvalId")))
                    .or_else(|| legacy_call_id.clone())
                    .unwrap_or_else(|| "unknown-item".to_string())
            } else if method == LEGACY_APPROVAL_PATCH_METHOD {
                legacy_call_id
                    .clone()
                    .unwrap_or_else(|| "unknown-item".to_string())
            } else {
                read_string(params_obj.and_then(|p| p.get("itemId")))
                    .unwrap_or_else(|| "unknown-item".to_string())
            };

            let approval = PendingApproval {
                id: approval_id.clone(),
                kind,
                thread_id: encode_engine_qualified_id(self.engine, &thread_id),
                turn_id,
                item_id,
                requested_at: now_iso(),
                reason: read_string(params_obj.and_then(|p| p.get("reason"))),
                command: if method == LEGACY_APPROVAL_COMMAND_METHOD {
                    read_shell_command(params_obj.and_then(|p| p.get("command")))
                } else {
                    read_string(params_obj.and_then(|p| p.get("command")))
                },
                cwd: read_string(params_obj.and_then(|p| p.get("cwd"))),
                grant_root: read_string(params_obj.and_then(|p| p.get("grantRoot"))),
                proposed_execpolicy_amendment: parse_execpolicy_amendment(
                    if method == APPROVAL_COMMAND_METHOD {
                        params_obj.and_then(|p| p.get("proposedExecpolicyAmendment"))
                    } else {
                        None
                    },
                ),
            };

            self.pending_approvals.lock().await.insert(
                approval_id,
                PendingApprovalEntry {
                    app_server_request_id: id,
                    response_format,
                    approval: approval.clone(),
                },
            );

            self.hub
                .broadcast_notification(
                    "bridge/approval.requested",
                    serde_json::to_value(approval).unwrap_or(Value::Null),
                )
                .await;
            return;
        }

        if method == REQUEST_USER_INPUT_METHOD || method == REQUEST_USER_INPUT_METHOD_ALT {
            let params_obj = params.as_ref().and_then(Value::as_object);
            let request_id = format!(
                "request-user-input-{}-{}",
                Utc::now().timestamp_millis(),
                self.user_input_counter.fetch_add(1, Ordering::Relaxed)
            );

            let request = PendingUserInputRequest {
                id: request_id.clone(),
                thread_id: encode_engine_qualified_id(
                    self.engine,
                    &read_string(params_obj.and_then(|p| p.get("threadId")))
                        .unwrap_or_else(|| "unknown-thread".to_string()),
                ),
                turn_id: read_string(params_obj.and_then(|p| p.get("turnId")))
                    .unwrap_or_else(|| "unknown-turn".to_string()),
                item_id: read_string(params_obj.and_then(|p| p.get("itemId")))
                    .unwrap_or_else(|| "unknown-item".to_string()),
                requested_at: now_iso(),
                questions: parse_user_input_questions(params_obj.and_then(|p| p.get("questions"))),
            };

            self.pending_user_inputs.lock().await.insert(
                request_id,
                PendingUserInputEntry {
                    app_server_request_id: id,
                    request: request.clone(),
                },
            );

            self.hub
                .broadcast_notification(
                    "bridge/userInput.requested",
                    serde_json::to_value(request).unwrap_or(Value::Null),
                )
                .await;
            return;
        }

        if method == DYNAMIC_TOOL_CALL_METHOD {
            self.hub
                .broadcast_notification(
                    "bridge/tool.call.unsupported",
                    json!({
                        "requestedAt": now_iso(),
                        "message": "Dynamic tool calls are not supported by clawdex-mobile bridge",
                        "request": params.clone().unwrap_or(Value::Null),
                    }),
                )
                .await;

            let _ = self
                .write_json(json!({
                    "id": id,
                    "result": {
                        "success": false,
                        "contentItems": [
                            {
                                "type": "inputText",
                                "text": "Dynamic tool calls are not supported by clawdex-mobile bridge"
                            }
                        ]
                    }
                }))
                .await;
            return;
        }

        if method == ACCOUNT_CHATGPT_TOKENS_REFRESH_METHOD {
            if let Some(auth) = resolve_bridge_chatgpt_auth_bundle_for_refresh() {
                let mut result = json!({
                    "accessToken": auth.access_token,
                    "chatgptAccountId": auth.account_id,
                    "chatgptPlanType": Value::Null,
                });

                if let Some(plan_type) = auth.plan_type {
                    result["chatgptPlanType"] = json!(plan_type);
                }

                let _ = self
                    .write_json(json!({
                        "id": id,
                        "result": result
                    }))
                    .await;
            } else {
                self.hub
                    .broadcast_notification(
                        "bridge/account.chatgptAuthTokens.refresh.required",
                        json!({
                            "requestedAt": now_iso(),
                            "reason": params
                                .as_ref()
                                .and_then(Value::as_object)
                                .and_then(|raw| raw.get("reason"))
                                .and_then(Value::as_str)
                                .unwrap_or("unauthorized"),
                        }),
                    )
                    .await;

                let _ = self
                    .write_json(json!({
                        "id": id,
                        "error": {
                            "code": -32001,
                            "message": "account/chatgptAuthTokens/refresh is not configured (set BRIDGE_CHATGPT_ACCESS_TOKEN and BRIDGE_CHATGPT_ACCOUNT_ID, or use Codex-managed ChatGPT login instead)"
                        }
                    }))
                    .await;
            }
            return;
        }

        let _ = self
            .write_json(json!({
                "id": id,
                "error": {
                    "code": -32601,
                    "message": format!("Unsupported server request method: {method}")
                }
            }))
            .await;
    }

    pub(super) async fn handle_notification(&self, method: &str, params: Option<Value>) {
        let normalized_params =
            normalize_forwarded_notification(method, params.unwrap_or(Value::Null), self.engine);
        self.hub
            .broadcast_notification(method, normalized_params)
            .await;
    }

    pub(super) async fn handle_response(&self, response: Value) {
        let Some(object) = response.as_object() else {
            return;
        };

        let Some(internal_id) = parse_internal_id(object.get("id")) else {
            return;
        };

        let pending = self.pending_requests.lock().await.remove(&internal_id);
        if pending.is_none() {
            let waiter = self.internal_waiters.lock().await.remove(&internal_id);
            if let Some(waiter) = waiter {
                if let Some(error) = object.get("error") {
                    let message = error
                        .as_object()
                        .and_then(|entry| entry.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("unknown initialize error")
                        .to_string();
                    let _ = waiter.send(Err(message));
                } else {
                    let _ = waiter.send(Ok(object.get("result").cloned().unwrap_or(Value::Null)));
                }
                return;
            }
        }
        let Some(pending) = pending else {
            return;
        };

        if object.get("error").is_none() {
            if pending.clear_cached_chatgpt_auth_on_success {
                clear_cached_bridge_chatgpt_auth();
            }
            if let Some(auth) = pending.cached_chatgpt_auth.clone() {
                cache_bridge_chatgpt_auth(auth);
            }
        }
        self.metrics.finish_request(
            &pending.trace,
            if object.get("error").is_none() {
                "ok"
            } else {
                "backend_error"
            },
        );
        if object.get("error").is_some() {
            self.metrics.record_error(
                Some(&pending.trace.request_id),
                Some(&pending.method),
                Some(self.engine.as_str()),
                "backend_error",
            );
        }

        let client_payload = if let Some(error) = object.get("error") {
            json!({
                "id": pending.client_request_id,
                "error": error,
            })
        } else {
            let normalized_result = normalize_forwarded_result(
                &pending.method,
                object.get("result").cloned().unwrap_or(Value::Null),
                self.engine,
            );
            json!({
                "id": pending.client_request_id,
                "result": normalized_result,
            })
        };

        self.hub.send_json(pending.client_id, client_payload).await;
    }

    pub(super) async fn write_json(&self, payload: Value) -> Result<(), std::io::Error> {
        let line = serde_json::to_string(&payload).map_err(std::io::Error::other)?;
        let mut writer = self.writer.lock().await;
        writer.write_all(line.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await
    }
}
