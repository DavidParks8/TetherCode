use crate::*;

#[derive(Clone)]
pub(super) struct RuntimeBackend {
    pub(super) preferred_engine: BridgeRuntimeEngine,
    pub(super) codex: Arc<StdRwLock<Option<Arc<AppServerBridge>>>>,
    pub(super) opencode: Option<Arc<OpencodeBackend>>,
    pub(super) cursor: Arc<StdRwLock<Option<Arc<AppServerBridge>>>>,
    pub(super) metrics: Arc<OperationalMetrics>,
}

impl RuntimeBackend {
    pub(super) async fn engine_statuses(
        &self,
        configured_engines: &[BridgeRuntimeEngine],
    ) -> HashMap<BridgeRuntimeEngine, BridgeEngineStatus> {
        let mut statuses = HashMap::new();
        for engine in [
            BridgeRuntimeEngine::Codex,
            BridgeRuntimeEngine::Opencode,
            BridgeRuntimeEngine::Cursor,
        ] {
            let configured = configured_engines.contains(&engine);
            let (runtime, pending_requests, timed_out_requests) = match engine {
                BridgeRuntimeEngine::Codex => match self.codex_backend() {
                    Some(backend) => (
                        backend.lifecycle.snapshot().await,
                        backend.pending_requests.lock().await.len(),
                        backend.timed_out_requests.load(Ordering::Relaxed),
                    ),
                    None => (dead_backend_snapshot("backend not started"), 0, 0),
                },
                BridgeRuntimeEngine::Opencode => match self.opencode.as_ref() {
                    Some(backend) => (backend.lifecycle.snapshot().await, 0, 0),
                    None => (dead_backend_snapshot("backend not started"), 0, 0),
                },
                BridgeRuntimeEngine::Cursor => match self.cursor_backend() {
                    Some(backend) => (
                        backend.lifecycle.snapshot().await,
                        backend.pending_requests.lock().await.len(),
                        backend.timed_out_requests.load(Ordering::Relaxed),
                    ),
                    None => (dead_backend_snapshot("backend not started"), 0, 0),
                },
            };
            statuses.insert(
                engine,
                BridgeEngineStatus {
                    configured,
                    lifecycle: runtime.state,
                    available: configured && runtime.state == BackendLifecycleState::Ready,
                    restart_count: runtime.restart_count,
                    pending_requests,
                    timed_out_requests,
                    last_error: runtime
                        .last_error
                        .map(|_| "backend lifecycle error (details redacted)".to_string()),
                },
            );
        }
        statuses
    }

    pub(super) async fn start(
        config: &Arc<BridgeConfig>,
        hub: Arc<ClientHub>,
        metrics: Arc<OperationalMetrics>,
    ) -> Result<Arc<Self>, String> {
        let preferred_engine = config.active_engine;
        let codex_enabled = config.enabled_engines.contains(&BridgeRuntimeEngine::Codex);
        let opencode_enabled = config
            .enabled_engines
            .contains(&BridgeRuntimeEngine::Opencode);
        let cursor_enabled = config
            .enabled_engines
            .contains(&BridgeRuntimeEngine::Cursor);
        let codex = Arc::new(StdRwLock::new(None));
        let mut opencode = None;
        let cursor = Arc::new(StdRwLock::new(None));

        match preferred_engine {
            BridgeRuntimeEngine::Codex => {
                if codex_enabled {
                    let app_server =
                        AppServerBridge::start_codex(&config.cli_bin, hub.clone(), metrics.clone())
                            .await?;
                    spawn_rollout_live_sync(hub.clone(), metrics.clone());
                    Self::store_codex_backend(&codex, app_server);
                }

                if opencode_enabled {
                    match OpencodeBackend::start(config, hub.clone()).await {
                        Ok(backend) => opencode = Some(backend),
                        Err(error) => eprintln!(
                            "opencode backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }

                if cursor_enabled {
                    match start_cursor_app_server_from_config(config, hub.clone(), metrics.clone()).await {
                        Ok(app_server) => Self::store_cursor_backend(&cursor, app_server),
                        Err(error) => eprintln!(
                            "cursor backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }
            }
            BridgeRuntimeEngine::Opencode => {
                if opencode_enabled {
                    let backend = OpencodeBackend::start(config, hub.clone()).await?;
                    opencode = Some(backend);
                }

                if codex_enabled {
                    match AppServerBridge::start_codex(
                        &config.cli_bin,
                        hub.clone(),
                        metrics.clone(),
                    )
                    .await
                    {
                        Ok(app_server) => {
                            spawn_rollout_live_sync(hub.clone(), metrics.clone());
                            Self::store_codex_backend(&codex, app_server);
                        }
                        Err(error) => eprintln!(
                            "codex backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }

                if cursor_enabled {
                    match start_cursor_app_server_from_config(config, hub.clone(), metrics.clone()).await {
                        Ok(app_server) => Self::store_cursor_backend(&cursor, app_server),
                        Err(error) => eprintln!(
                            "cursor backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }
            }
            BridgeRuntimeEngine::Cursor => {
                if cursor_enabled {
                    let app_server =
                        start_cursor_app_server_from_config(config, hub.clone(), metrics.clone())
                            .await?;
                    Self::store_cursor_backend(&cursor, app_server);
                }

                if codex_enabled {
                    match AppServerBridge::start_codex(&config.cli_bin, hub.clone(), metrics.clone()).await {
                        Ok(app_server) => {
                            spawn_rollout_live_sync(hub.clone(), metrics.clone());
                            Self::store_codex_backend(&codex, app_server);
                        }
                        Err(error) => eprintln!(
                            "codex backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }

                if opencode_enabled {
                    match OpencodeBackend::start(config, hub.clone()).await {
                        Ok(backend) => opencode = Some(backend),
                        Err(error) => eprintln!(
                            "opencode backend unavailable; continuing with selected harnesses only: {error}"
                        ),
                    }
                }
            }
        }

        Ok(Arc::new(Self {
            preferred_engine,
            codex,
            opencode,
            cursor,
            metrics,
        }))
    }

    pub(super) fn cursor_backend(&self) -> Option<Arc<AppServerBridge>> {
        self.cursor.read().ok().and_then(|guard| guard.clone())
    }

    pub(super) fn codex_backend(&self) -> Option<Arc<AppServerBridge>> {
        self.codex.read().ok().and_then(|guard| guard.clone())
    }

    pub(super) fn store_codex_backend(
        codex_slot: &Arc<StdRwLock<Option<Arc<AppServerBridge>>>>,
        bridge: Arc<AppServerBridge>,
    ) {
        if let Ok(mut guard) = codex_slot.write() {
            *guard = Some(bridge);
        }
    }

    pub(super) fn store_cursor_backend(
        cursor_slot: &Arc<StdRwLock<Option<Arc<AppServerBridge>>>>,
        bridge: Arc<AppServerBridge>,
    ) {
        if let Ok(mut guard) = cursor_slot.write() {
            *guard = Some(bridge);
        }
    }

    pub(super) async fn restart_codex_app_server(
        &self,
        config: &Arc<BridgeConfig>,
        hub: Arc<ClientHub>,
    ) -> Result<(), String> {
        if !config.enabled_engines.contains(&BridgeRuntimeEngine::Codex) {
            return Err("codex backend is not enabled".to_string());
        }

        let next_backend =
            AppServerBridge::start_codex(&config.cli_bin, hub, self.metrics.clone()).await?;
        let previous_backend = self
            .codex
            .write()
            .map(|mut guard| guard.replace(next_backend))
            .map_err(|_| "codex backend lock is unavailable".to_string())?;

        if let Some(previous_backend) = previous_backend {
            previous_backend.request_shutdown().await;
        }

        Ok(())
    }

    pub(super) async fn shutdown(&self) {
        if let Some(codex) = self.codex_backend() {
            codex.request_shutdown().await;
        }
        if let Some(opencode) = &self.opencode {
            opencode.request_shutdown().await;
        }
        if let Some(cursor) = self.cursor_backend() {
            cursor.request_shutdown().await;
        }
    }

    pub(super) async fn cancel_client_requests(&self, client_id: u64) {
        if let Some(bridge) = self.codex_backend() {
            bridge.cancel_client_requests(client_id).await;
        }
        if let Some(bridge) = self.cursor_backend() {
            bridge.cancel_client_requests(client_id).await;
        }
    }

    pub(super) fn engine(&self) -> BridgeRuntimeEngine {
        self.preferred_engine
    }

    pub(super) fn available_engines(&self) -> Vec<BridgeRuntimeEngine> {
        let mut engines = Vec::new();
        if self
            .codex_backend()
            .is_some_and(|backend| backend.lifecycle.is_ready())
        {
            engines.push(BridgeRuntimeEngine::Codex);
        }
        if self
            .opencode
            .as_ref()
            .is_some_and(|backend| backend.lifecycle.is_ready())
        {
            engines.push(BridgeRuntimeEngine::Opencode);
        }
        if self
            .cursor_backend()
            .is_some_and(|backend| backend.lifecycle.is_ready())
        {
            engines.push(BridgeRuntimeEngine::Cursor);
        }
        engines
    }

    pub(super) fn capabilities(&self, stream_id: &str) -> BridgeCapabilities {
        let preferred_engine = self.engine();
        let supports_for_engine = |engine| match engine {
            BridgeRuntimeEngine::Codex => BridgeCapabilitySupport {
                review_start: true,
                compact_start: true,
                goal_slash: true,
                plan_mode: true,
                agent_list: false,
                turn_steer: true,
                command_output_delta: true,
                fast_mode: true,
                account: true,
                account_rate_limits: true,
                self_update: false,
                browser_preview: false,
                generic_ui_surface: true,
            },
            BridgeRuntimeEngine::Opencode => BridgeCapabilitySupport {
                review_start: false,
                compact_start: true,
                goal_slash: false,
                plan_mode: true,
                agent_list: true,
                turn_steer: false,
                command_output_delta: false,
                fast_mode: false,
                account: false,
                account_rate_limits: false,
                self_update: false,
                browser_preview: false,
                generic_ui_surface: true,
            },
            BridgeRuntimeEngine::Cursor => BridgeCapabilitySupport {
                review_start: false,
                compact_start: false,
                goal_slash: false,
                plan_mode: true,
                agent_list: false,
                turn_steer: false,
                command_output_delta: false,
                fast_mode: false,
                account: false,
                account_rate_limits: false,
                self_update: false,
                browser_preview: false,
                generic_ui_surface: true,
            },
        };
        let available_engines = self.available_engines();
        let active_engine = if available_engines.contains(&preferred_engine) {
            preferred_engine
        } else {
            available_engines
                .first()
                .copied()
                .unwrap_or(preferred_engine)
        };
        let supports = supports_for_engine(active_engine);
        let supports_by_engine = [
            BridgeRuntimeEngine::Codex,
            BridgeRuntimeEngine::Opencode,
            BridgeRuntimeEngine::Cursor,
        ]
        .iter()
        .copied()
        .map(|engine| (engine, supports_for_engine(engine)))
        .collect();

        BridgeCapabilities {
            protocol_version: BRIDGE_PROTOCOL_VERSION,
            stream_id: stream_id.to_string(),
            active_engine,
            preferred_engine,
            configured_engines: available_engines.clone(),
            unified_chat_list: available_engines.len() > 1,
            available_engines,
            supports,
            supports_by_engine,
        }
    }

    pub(super) fn backend_for_engine(
        &self,
        engine: BridgeRuntimeEngine,
    ) -> Result<RuntimeBackendRef<'_>, String> {
        match engine {
            BridgeRuntimeEngine::Codex => self
                .codex_backend()
                .map(RuntimeBackendRef::Codex)
                .ok_or_else(|| "codex backend is unavailable".to_string()),
            BridgeRuntimeEngine::Opencode => self
                .opencode
                .as_ref()
                .map(RuntimeBackendRef::Opencode)
                .ok_or_else(|| "opencode backend is unavailable".to_string()),
            BridgeRuntimeEngine::Cursor => self
                .cursor_backend()
                .map(RuntimeBackendRef::Cursor)
                .ok_or_else(|| "cursor backend is unavailable".to_string()),
        }
    }

    pub(super) fn route_engine_for_method(
        &self,
        method: &str,
        raw_params: Option<&Value>,
    ) -> BridgeRuntimeEngine {
        if is_dual_engine_aggregate_method(method) {
            return self.preferred_engine;
        }

        route_engine_from_params(raw_params).unwrap_or_else(|| self.engine())
    }

    #[allow(dead_code)]
    pub(super) async fn forward_request(
        self: &Arc<Self>,
        client_id: u64,
        client_request_id: Value,
        method: &str,
        raw_params: Option<Value>,
        permits: Option<InFlightRequestPermits>,
    ) -> Result<(), String> {
        if is_dual_engine_aggregate_method(method) {
            let result = self.request_internal(method, raw_params).await?;
            self.send_client_result(client_id, client_request_id, result)
                .await;
            return Ok(());
        }

        let target_engine = self.route_engine_for_method(method, raw_params.as_ref());
        let normalized_params = raw_params.map(normalize_forwarded_params);
        match self.backend_for_engine(target_engine)? {
            RuntimeBackendRef::Codex(bridge) => {
                bridge
                    .forward_request_with_permits(
                        client_id,
                        client_request_id,
                        method,
                        normalized_params,
                        permits,
                    )
                    .await
            }
            RuntimeBackendRef::Opencode(backend) => backend
                .forward_request(client_id, client_request_id, method, normalized_params)
                .await
                .map(|()| drop(permits)),
            RuntimeBackendRef::Cursor(bridge) => {
                bridge
                    .forward_request_with_permits(
                        client_id,
                        client_request_id,
                        method,
                        normalized_params,
                        permits,
                    )
                    .await
            }
        }
    }

    pub(super) async fn request_internal(
        &self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, String> {
        if method == "thread/list" {
            return self.aggregate_thread_list(params).await;
        }
        if method == "thread/loaded/list" {
            return self.aggregate_loaded_thread_ids().await;
        }
        if method == "model/list" {
            let target_engine =
                route_engine_from_params(params.as_ref()).unwrap_or_else(|| self.engine());
            let normalized_params = params.map(normalize_forwarded_params);
            return match self.backend_for_engine(target_engine)? {
                RuntimeBackendRef::Codex(bridge) => {
                    bridge.request_internal(method, normalized_params).await
                }
                RuntimeBackendRef::Opencode(backend) => {
                    backend.request_internal(method, normalized_params).await
                }
                RuntimeBackendRef::Cursor(bridge) => {
                    bridge.request_internal(method, normalized_params).await
                }
            };
        }

        let target_engine = self.route_engine_for_method(method, params.as_ref());
        let normalized_params = params.map(normalize_forwarded_params);
        match self.backend_for_engine(target_engine)? {
            RuntimeBackendRef::Codex(bridge) => {
                bridge.request_internal(method, normalized_params).await
            }
            RuntimeBackendRef::Opencode(backend) => {
                backend.request_internal(method, normalized_params).await
            }
            RuntimeBackendRef::Cursor(bridge) => {
                bridge.request_internal(method, normalized_params).await
            }
        }
    }

    pub(super) async fn aggregate_thread_list(
        &self,
        params: Option<Value>,
    ) -> Result<Value, String> {
        let mut results = Vec::new();
        let bridge_cursor = extract_thread_list_cursor(params.as_ref())
            .and_then(|cursor| decode_bridge_thread_list_cursor(&cursor));

        if let Some(codex) = self.codex_backend() {
            if let Some(cursor_map) = bridge_cursor.as_ref() {
                if let Some(cursor) = cursor_map.get(&BridgeRuntimeEngine::Codex) {
                    results.push((
                        BridgeRuntimeEngine::Codex,
                        codex
                            .request_internal(
                                "thread/list",
                                Some(thread_list_params_with_cursor(
                                    params.as_ref(),
                                    Some(cursor),
                                )),
                            )
                            .await?,
                    ));
                }
            } else {
                results.push((
                    BridgeRuntimeEngine::Codex,
                    codex
                        .request_internal("thread/list", params.clone())
                        .await?,
                ));
            }
        }

        if let Some(opencode) = &self.opencode {
            if let Some(cursor_map) = bridge_cursor.as_ref() {
                if let Some(cursor) = cursor_map.get(&BridgeRuntimeEngine::Opencode) {
                    results.push((
                        BridgeRuntimeEngine::Opencode,
                        opencode
                            .request_internal(
                                "thread/list",
                                Some(thread_list_params_with_cursor(
                                    params.as_ref(),
                                    Some(cursor),
                                )),
                            )
                            .await?,
                    ));
                }
            } else {
                results.push((
                    BridgeRuntimeEngine::Opencode,
                    opencode
                        .request_internal("thread/list", params.clone())
                        .await?,
                ));
            }
        }

        if let Some(cursor_backend) = self.cursor_backend() {
            if let Some(cursor_map) = bridge_cursor.as_ref() {
                if let Some(cursor) = cursor_map.get(&BridgeRuntimeEngine::Cursor) {
                    results.push((
                        BridgeRuntimeEngine::Cursor,
                        cursor_backend
                            .request_internal(
                                "thread/list",
                                Some(thread_list_params_with_cursor(
                                    params.as_ref(),
                                    Some(cursor),
                                )),
                            )
                            .await?,
                    ));
                }
            } else {
                results.push((
                    BridgeRuntimeEngine::Cursor,
                    cursor_backend
                        .request_internal("thread/list", params.clone())
                        .await?,
                ));
            }
        }

        Ok(merge_thread_list_results(results))
    }

    pub(super) async fn aggregate_loaded_thread_ids(&self) -> Result<Value, String> {
        let mut results = Vec::new();

        if let Some(codex) = self.codex_backend() {
            results.push((
                BridgeRuntimeEngine::Codex,
                codex.request_internal("thread/loaded/list", None).await?,
            ));
        }

        if let Some(opencode) = &self.opencode {
            results.push((
                BridgeRuntimeEngine::Opencode,
                opencode
                    .request_internal("thread/loaded/list", None)
                    .await?,
            ));
        }

        if let Some(cursor) = self.cursor_backend() {
            results.push((
                BridgeRuntimeEngine::Cursor,
                cursor.request_internal("thread/loaded/list", None).await?,
            ));
        }

        Ok(merge_loaded_thread_ids_results(results))
    }

    pub(super) async fn list_pending_approvals(&self) -> Vec<PendingApproval> {
        let mut approvals = Vec::new();
        if let Some(codex) = self.codex_backend() {
            approvals.extend(codex.list_pending_approvals().await);
        }
        if let Some(opencode) = &self.opencode {
            approvals.extend(opencode.list_pending_approvals().await);
        }
        if let Some(cursor) = self.cursor_backend() {
            approvals.extend(cursor.list_pending_approvals().await);
        }
        approvals.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        approvals
    }

    pub(super) async fn list_pending_user_inputs(&self) -> Vec<PendingUserInputRequest> {
        let mut requests = Vec::new();
        if let Some(codex) = self.codex_backend() {
            requests.extend(codex.list_pending_user_inputs().await);
        }
        if let Some(opencode) = &self.opencode {
            requests.extend(opencode.list_pending_user_inputs().await);
        }
        if let Some(cursor) = self.cursor_backend() {
            requests.extend(cursor.list_pending_user_inputs().await);
        }
        requests.sort_by(|a, b| b.requested_at.cmp(&a.requested_at));
        requests
    }

    pub(super) async fn resolve_approval(
        &self,
        approval_id: &str,
        decision: &Value,
    ) -> Result<Option<PendingApproval>, String> {
        if let Some(codex) = self.codex_backend() {
            if let Some(approval) = codex.resolve_approval(approval_id, decision).await? {
                return Ok(Some(approval));
            }
        }

        if let Some(opencode) = &self.opencode {
            if let Some(approval) = opencode.resolve_approval(approval_id, decision).await? {
                return Ok(Some(approval));
            }
        }

        if let Some(cursor) = self.cursor_backend() {
            if let Some(approval) = cursor.resolve_approval(approval_id, decision).await? {
                return Ok(Some(approval));
            }
        }

        Ok(None)
    }

    pub(super) async fn resolve_user_input(
        &self,
        request_id: &str,
        answers: &HashMap<String, UserInputAnswerPayload>,
    ) -> Result<Option<PendingUserInputRequest>, String> {
        if let Some(codex) = self.codex_backend() {
            if let Some(request) = codex.resolve_user_input(request_id, answers).await? {
                return Ok(Some(request));
            }
        }

        if let Some(opencode) = &self.opencode {
            if let Some(request) = opencode.resolve_user_input(request_id, answers).await? {
                return Ok(Some(request));
            }
        }

        if let Some(cursor) = self.cursor_backend() {
            if let Some(request) = cursor.resolve_user_input(request_id, answers).await? {
                return Ok(Some(request));
            }
        }

        Ok(None)
    }

    pub(super) async fn send_client_result(
        &self,
        client_id: u64,
        client_request_id: Value,
        result: Value,
    ) {
        self.send_client_result_error(client_id, client_request_id, Ok(result))
            .await;
    }

    pub(super) async fn send_client_result_error(
        &self,
        client_id: u64,
        client_request_id: Value,
        result: Result<Value, String>,
    ) {
        let payload = match result {
            Ok(result) => json!({
                "id": client_request_id,
                "result": result,
            }),
            Err(error) => json!({
                "id": client_request_id,
                "error": {
                    "code": -32000,
                    "message": error,
                }
            }),
        };
        if let Some(codex) = self.codex_backend() {
            codex.hub.send_json(client_id, payload).await;
        } else if let Some(opencode) = &self.opencode {
            opencode.hub.send_json(client_id, payload).await;
        } else if let Some(cursor) = self.cursor_backend() {
            cursor.hub.send_json(client_id, payload).await;
        }
    }
}

pub(super) fn dead_backend_snapshot(error: &str) -> BackendRuntimeSnapshot {
    BackendRuntimeSnapshot {
        state: BackendLifecycleState::Dead,
        restart_count: 0,
        last_error: Some(error.to_string()),
    }
}

pub(super) fn configure_managed_child_command(command: &mut Command) {
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
}

pub(super) async fn terminate_managed_child(pid: u32, label: &str) {
    #[cfg(unix)]
    {
        terminate_process_group_unix(pid, label).await;
        return;
    }

    #[cfg(windows)]
    {
        terminate_process_tree_windows(pid, label).await;
        return;
    }

    #[allow(unreachable_code)]
    let _ = (pid, label);
}

#[cfg(unix)]
pub(super) async fn wait_for_shutdown_signal() -> &'static str {
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .expect("failed to install SIGINT handler");
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("failed to install SIGTERM handler");

    tokio::select! {
        _ = sigint.recv() => "SIGINT",
        _ = sigterm.recv() => "SIGTERM",
    }
}

#[cfg(not(unix))]
pub(super) async fn wait_for_shutdown_signal() -> &'static str {
    let _ = tokio::signal::ctrl_c().await;
    "Ctrl+C"
}

#[cfg(unix)]
pub(super) async fn terminate_process_group_unix(pid: u32, label: &str) {
    let process_group = pid as i32;
    if process_group <= 0 {
        return;
    }

    let terminate_result = unsafe { libc::killpg(process_group, libc::SIGTERM) };
    if terminate_result != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            eprintln!("failed to terminate {label} process group {process_group}: {error}");
        }
        return;
    }

    tokio::time::sleep(Duration::from_millis(400)).await;

    let kill_result = unsafe { libc::killpg(process_group, 0) };
    if kill_result == 0 {
        let force_result = unsafe { libc::killpg(process_group, libc::SIGKILL) };
        if force_result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                eprintln!("failed to force-kill {label} process group {process_group}: {error}");
            }
        }
    }
}

#[cfg(windows)]
pub(super) async fn terminate_process_tree_windows(pid: u32, label: &str) {
    let status = Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .status()
        .await;

    match status {
        Ok(result) if result.success() => {}
        Ok(result) => eprintln!("failed to terminate {label} process tree {pid}: {result}"),
        Err(error) => eprintln!("failed to terminate {label} process tree {pid}: {error}"),
    }
}
