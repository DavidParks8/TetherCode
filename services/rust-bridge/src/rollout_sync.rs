use crate::*;

#[derive(Default)]
pub(super) struct RolloutLiveSyncState {
    pub(super) files: HashMap<PathBuf, RolloutTrackedFile>,
    pub(super) tick: u64,
}

pub(super) struct RolloutTrackedFile {
    pub(super) path: PathBuf,
    pub(super) offset: u64,
    pub(super) partial_line: String,
    pub(super) drop_first_partial_line: bool,
    pub(super) thread_id: Option<String>,
    pub(super) originator: Option<String>,
    pub(super) include_for_live_sync: bool,
    pub(super) last_seen: Instant,
    pub(super) recent_line_hashes: VecDeque<u64>,
    pub(super) recent_line_hash_set: HashSet<u64>,
}

impl RolloutTrackedFile {
    pub(super) async fn new(path: PathBuf) -> Result<Self, std::io::Error> {
        let metadata = fs::metadata(&path).await?;
        let mut thread_id = None;
        let mut originator = None;
        let mut include_for_live_sync = false;

        if let Some((meta_thread_id, meta_originator)) = read_rollout_session_meta(&path).await? {
            include_for_live_sync = rollout_originator_allowed(meta_originator.as_deref());
            thread_id = Some(meta_thread_id);
            originator = meta_originator;
        }

        let offset = metadata
            .len()
            .saturating_sub(ROLLOUT_LIVE_SYNC_INITIAL_TAIL_BYTES);
        Ok(Self {
            path,
            offset,
            partial_line: String::new(),
            drop_first_partial_line: offset > 0,
            thread_id,
            originator,
            include_for_live_sync,
            last_seen: Instant::now(),
            recent_line_hashes: VecDeque::new(),
            recent_line_hash_set: HashSet::new(),
        })
    }

    pub(super) async fn poll(
        &mut self,
        hub: &Arc<ClientHub>,
        metrics: &Arc<OperationalMetrics>,
    ) -> Result<(), std::io::Error> {
        let mut file = match fs::File::open(&self.path).await {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(error);
            }
            Err(error) => return Err(error),
        };

        let metadata = file.metadata().await?;
        let len = metadata.len();

        if len < self.offset {
            self.offset = 0;
            self.partial_line.clear();
            self.drop_first_partial_line = false;
            self.recent_line_hashes.clear();
            self.recent_line_hash_set.clear();
        }

        if len == self.offset {
            return Ok(());
        }

        file.seek(SeekFrom::Start(self.offset)).await?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).await?;
        self.offset = len;
        self.last_seen = Instant::now();

        if bytes.is_empty() {
            return Ok(());
        }

        let chunk = String::from_utf8_lossy(&bytes);
        let mut combined = String::with_capacity(self.partial_line.len() + chunk.len());
        combined.push_str(&self.partial_line);
        combined.push_str(&chunk);
        self.partial_line.clear();

        if self.drop_first_partial_line {
            if let Some(index) = combined.find('\n') {
                combined = combined[(index + 1)..].to_string();
                self.drop_first_partial_line = false;
            } else {
                self.partial_line = combined;
                return Ok(());
            }
        }

        let has_trailing_newline = combined.ends_with('\n');
        let mut lines = combined.split('\n').map(str::to_string).collect::<Vec<_>>();
        if !has_trailing_newline {
            self.partial_line = lines.pop().unwrap_or_default();
        }

        for line in lines {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let line_hash = hash_rollout_line(trimmed);
            if !self.remember_line_hash(line_hash) {
                metrics.live_sync_deduplicated();
                continue;
            }

            if let Some((method, params)) = self.to_notification(trimmed) {
                if let Some(status_payload) =
                    build_rollout_thread_status_notification(&method, &params)
                {
                    hub.broadcast_notification("thread/status/changed", status_payload)
                        .await;
                }
                hub.broadcast_notification(&method, params).await;
                metrics.live_sync_event();
            }
        }

        Ok(())
    }

    pub(super) fn remember_line_hash(&mut self, line_hash: u64) -> bool {
        if self.recent_line_hash_set.contains(&line_hash) {
            return false;
        }

        self.recent_line_hash_set.insert(line_hash);
        self.recent_line_hashes.push_back(line_hash);
        while self.recent_line_hashes.len() > ROLLOUT_LIVE_SYNC_DEDUP_CAPACITY {
            if let Some(oldest) = self.recent_line_hashes.pop_front() {
                self.recent_line_hash_set.remove(&oldest);
            }
        }

        true
    }

    pub(super) fn to_notification(&mut self, line: &str) -> Option<(String, Value)> {
        let parsed = serde_json::from_str::<Value>(line).ok()?;
        let parsed_object = parsed.as_object()?;
        let record_type = read_string(parsed_object.get("type"))?;
        let timestamp = read_string(parsed_object.get("timestamp"));
        let payload = parsed_object.get("payload")?.as_object()?;

        if record_type == "session_meta" {
            self.thread_id =
                extract_rollout_thread_id(payload, true).or_else(|| self.thread_id.clone());
            self.originator =
                read_string(payload.get("originator")).or_else(|| self.originator.clone());
            self.include_for_live_sync =
                self.thread_id.is_some() && rollout_originator_allowed(self.originator.as_deref());
            return None;
        }

        if !self.include_for_live_sync {
            return None;
        }

        if let Some(payload_thread_id) = extract_rollout_thread_id(payload, false) {
            self.thread_id = Some(payload_thread_id);
        }

        let thread_id = self.thread_id.as_deref()?;
        if record_type == "event_msg" {
            return build_rollout_event_msg_notification(payload, thread_id, timestamp.as_deref());
        }

        if record_type == "response_item" {
            return build_rollout_response_item_notification(
                payload,
                thread_id,
                timestamp.as_deref(),
            );
        }

        None
    }
}

pub(super) fn spawn_rollout_live_sync(hub: Arc<ClientHub>, metrics: Arc<OperationalMetrics>) {
    tokio::spawn(async move {
        let Some(sessions_root) = resolve_codex_sessions_root() else {
            return;
        };

        let mut state = RolloutLiveSyncState::default();
        let mut ticker =
            tokio::time::interval(Duration::from_millis(ROLLOUT_LIVE_SYNC_POLL_INTERVAL_MS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            state.tick = state.tick.wrapping_add(1);

            if should_run_rollout_discovery_tick(
                state.tick,
                ROLLOUT_LIVE_SYNC_DISCOVERY_INTERVAL_TICKS,
            ) {
                if let Err(error) =
                    rollout_live_sync_discover_files(&sessions_root, &mut state).await
                {
                    metrics.live_sync_error("live_sync_discovery_error");
                    eprintln!("rollout live sync discovery failed: {error}");
                } else {
                    metrics.live_sync_discovery(state.files.len());
                }
            }

            metrics.live_sync_poll();
            if let Err(error) = rollout_live_sync_poll_files(&hub, &mut state, &metrics).await {
                metrics.live_sync_error("live_sync_poll_error");
                eprintln!("rollout live sync poll failed: {error}");
            }
        }
    });
}

pub(super) async fn rollout_live_sync_discover_files(
    sessions_root: &Path,
    state: &mut RolloutLiveSyncState,
) -> Result<(), std::io::Error> {
    let discovered_paths = discover_recent_rollout_files(sessions_root).await?;
    let discovered_set = discovered_paths.iter().cloned().collect::<HashSet<_>>();

    for path in discovered_paths {
        if state.files.contains_key(&path) {
            continue;
        }

        match RolloutTrackedFile::new(path.clone()).await {
            Ok(tracked) => {
                state.files.insert(path, tracked);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }

    state.files.retain(|path, tracked| {
        discovered_set.contains(path)
            || tracked.last_seen.elapsed() < ROLLOUT_LIVE_SYNC_MAX_FILE_AGE
    });

    Ok(())
}

pub(super) async fn rollout_live_sync_poll_files(
    hub: &Arc<ClientHub>,
    state: &mut RolloutLiveSyncState,
    metrics: &Arc<OperationalMetrics>,
) -> Result<(), std::io::Error> {
    let tracked_paths = state.files.keys().cloned().collect::<Vec<_>>();
    let mut removed_paths = Vec::new();

    for path in tracked_paths {
        let Some(tracked) = state.files.get_mut(&path) else {
            continue;
        };

        match tracked.poll(hub, metrics).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                removed_paths.push(path.clone());
            }
            Err(error) => return Err(error),
        }
    }

    for path in removed_paths {
        state.files.remove(&path);
    }

    Ok(())
}

pub(super) async fn read_rollout_session_meta(
    path: &Path,
) -> Result<Option<(String, Option<String>)>, std::io::Error> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };

    let mut lines = BufReader::new(file).lines();
    let Some(first_line) = lines.next_line().await? else {
        return Ok(None);
    };

    let parsed = match serde_json::from_str::<Value>(&first_line) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(None),
    };

    let parsed_object = match parsed.as_object() {
        Some(object) => object,
        None => return Ok(None),
    };

    if read_string(parsed_object.get("type")).as_deref() != Some("session_meta") {
        return Ok(None);
    }

    let payload = match parsed_object.get("payload").and_then(Value::as_object) {
        Some(payload) => payload,
        None => return Ok(None),
    };

    let thread_id = match extract_rollout_thread_id(payload, true) {
        Some(id) => id,
        None => return Ok(None),
    };
    let originator = read_string(payload.get("originator"));

    Ok(Some((thread_id, originator)))
}

pub(super) fn extract_rollout_thread_id(
    payload: &serde_json::Map<String, Value>,
    allow_session_id_fallback: bool,
) -> Option<String> {
    let source = payload.get("source").and_then(Value::as_object);
    let source_subagent = source
        .and_then(|value| value.get("subagent"))
        .and_then(Value::as_object);
    let source_thread_spawn = source_subagent
        .and_then(|value| value.get("thread_spawn"))
        .and_then(Value::as_object);

    read_string(payload.get("thread_id"))
        .or_else(|| read_string(payload.get("threadId")))
        .or_else(|| read_string(payload.get("conversation_id")))
        .or_else(|| read_string(payload.get("conversationId")))
        .or_else(|| source.and_then(|value| read_string(value.get("thread_id"))))
        .or_else(|| source.and_then(|value| read_string(value.get("threadId"))))
        .or_else(|| source.and_then(|value| read_string(value.get("conversation_id"))))
        .or_else(|| source.and_then(|value| read_string(value.get("conversationId"))))
        .or_else(|| source.and_then(|value| read_string(value.get("parent_thread_id"))))
        .or_else(|| source.and_then(|value| read_string(value.get("parentThreadId"))))
        .or_else(|| {
            source_thread_spawn.and_then(|value| read_string(value.get("parent_thread_id")))
        })
        .or_else(|| {
            if allow_session_id_fallback {
                read_string(payload.get("id"))
            } else {
                None
            }
        })
}

pub(super) fn build_rollout_thread_status_notification(
    method: &str,
    params: &Value,
) -> Option<Value> {
    let codex_event_type = method.strip_prefix("codex/event/")?;
    let status = match codex_event_type {
        "task_started" | "taskstarted" => "running",
        "task_complete" | "taskcomplete" => "completed",
        "task_failed" | "taskfailed" | "turn_failed" | "turnfailed" => "failed",
        "task_interrupted" | "taskinterrupted" | "turn_aborted" | "turnaborted" => "interrupted",
        _ => return None,
    };

    let msg = params
        .as_object()
        .and_then(|value| value.get("msg"))
        .and_then(Value::as_object)?;
    let thread_id = encode_engine_qualified_id(
        BridgeRuntimeEngine::Codex,
        &read_string(msg.get("thread_id")).or_else(|| read_string(msg.get("threadId")))?,
    );

    Some(json!({
        "threadId": thread_id,
        "thread_id": thread_id,
        "status": status,
        "source": "rollout_live_sync",
    }))
}

pub(super) fn build_rollout_event_msg_notification(
    payload: &serde_json::Map<String, Value>,
    thread_id: &str,
    timestamp: Option<&str>,
) -> Option<(String, Value)> {
    let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Codex, thread_id);
    let raw_type = read_string(payload.get("type"))?;
    if matches!(raw_type.as_str(), "user_message" | "context_compacted") {
        return None;
    }

    let mut msg = payload.clone();
    msg.entry("thread_id".to_string())
        .or_insert_with(|| json!(thread_id));
    msg.entry("threadId".to_string())
        .or_insert_with(|| json!(thread_id));
    if let Some(timestamp) = timestamp {
        msg.entry("timestamp".to_string())
            .or_insert_with(|| json!(timestamp));
    }

    if raw_type == "agent_reasoning" {
        let delta = read_string(payload.get("text"))?;
        if delta.trim().is_empty() {
            return None;
        }
        msg.insert("type".to_string(), json!("agent_reasoning_delta"));
        msg.insert("delta".to_string(), json!(delta));
        return Some((
            "codex/event/agent_reasoning_delta".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    if raw_type == "agent_message" {
        let delta = read_string(payload.get("message"))?;
        if delta.trim().is_empty() {
            return None;
        }
        msg.insert("type".to_string(), json!("agent_message_delta"));
        msg.insert("delta".to_string(), json!(delta));
        return Some((
            "codex/event/agent_message_delta".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    Some((
        format!("codex/event/{raw_type}"),
        json!({ "msg": Value::Object(msg) }),
    ))
}

pub(super) fn build_rollout_response_item_notification(
    payload: &serde_json::Map<String, Value>,
    thread_id: &str,
    timestamp: Option<&str>,
) -> Option<(String, Value)> {
    let thread_id = encode_engine_qualified_id(BridgeRuntimeEngine::Codex, thread_id);
    let item_type = read_string(payload.get("type"))?;
    if item_type == "message" {
        return build_rollout_goal_budget_ui_surface_notification(payload, &thread_id, timestamp);
    }

    if item_type == "function_call_output" {
        return build_rollout_goal_ui_surface_notification(payload, &thread_id, timestamp);
    }

    if item_type != "function_call" {
        return None;
    }

    let name = read_string(payload.get("name"))?;
    let arguments = parse_rollout_function_call_arguments(payload.get("arguments"));

    if name == "exec_command" {
        let command = arguments
            .as_object()
            .and_then(|object| read_shell_command(object.get("cmd")));
        let command = command?.trim().to_string();
        if command.is_empty() {
            return None;
        }

        let command_parts = shlex::split(&command).unwrap_or_else(|| vec![command.clone()]);
        let mut msg = serde_json::Map::new();
        msg.insert("type".to_string(), json!("exec_command_begin"));
        msg.insert("thread_id".to_string(), json!(thread_id));
        msg.insert("threadId".to_string(), json!(thread_id));
        msg.insert("command".to_string(), json!(command_parts));
        if let Some(call_id) = read_string(payload.get("call_id")) {
            msg.insert("call_id".to_string(), json!(call_id));
        }
        if let Some(timestamp) = timestamp {
            msg.insert("timestamp".to_string(), json!(timestamp));
        }
        return Some((
            "codex/event/exec_command_begin".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    if let Some((server, tool)) = parse_rollout_mcp_tool_name(&name) {
        let mut msg = serde_json::Map::new();
        msg.insert("type".to_string(), json!("mcp_tool_call_begin"));
        msg.insert("thread_id".to_string(), json!(thread_id));
        msg.insert("threadId".to_string(), json!(thread_id));
        msg.insert("server".to_string(), json!(server));
        msg.insert("tool".to_string(), json!(tool));
        if let Some(timestamp) = timestamp {
            msg.insert("timestamp".to_string(), json!(timestamp));
        }
        return Some((
            "codex/event/mcp_tool_call_begin".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    if name == "search_query" || name == "image_query" {
        let query = extract_rollout_search_query(&arguments)?;
        if query.trim().is_empty() {
            return None;
        }
        let mut msg = serde_json::Map::new();
        msg.insert("type".to_string(), json!("web_search_begin"));
        msg.insert("thread_id".to_string(), json!(thread_id));
        msg.insert("threadId".to_string(), json!(thread_id));
        msg.insert("query".to_string(), json!(query));
        if let Some(timestamp) = timestamp {
            msg.insert("timestamp".to_string(), json!(timestamp));
        }
        return Some((
            "codex/event/web_search_begin".to_string(),
            json!({ "msg": Value::Object(msg) }),
        ));
    }

    None
}

pub(super) fn build_rollout_goal_ui_surface_notification(
    payload: &serde_json::Map<String, Value>,
    fallback_thread_id: &str,
    timestamp: Option<&str>,
) -> Option<(String, Value)> {
    let output = parse_rollout_function_call_output(payload.get("output"));
    let output_object = output.as_object()?;
    let goal = output_object.get("goal")?.as_object()?;
    let objective = read_string(goal.get("objective"))?;
    if objective.trim().is_empty() {
        return None;
    }

    let raw_thread_id = read_string(goal.get("threadId"))
        .or_else(|| read_string(goal.get("thread_id")))
        .filter(|value| !value.trim().is_empty());
    let thread_id = raw_thread_id
        .as_deref()
        .map(|value| encode_engine_qualified_id(BridgeRuntimeEngine::Codex, value))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_thread_id.to_string());
    let status = read_string(goal.get("status")).unwrap_or_else(|| "active".to_string());
    let normalized_status = status.trim().to_ascii_lowercase();
    let tone = match normalized_status.as_str() {
        "complete" | "completed" => "success",
        "failed" | "cancelled" | "canceled" => "error",
        _ => "info",
    };

    let mut key_values = Vec::new();
    key_values.push(json!({
        "label": "Status",
        "value": format_goal_status(&status),
    }));
    if let Some(tokens_used) = parse_internal_id(goal.get("tokensUsed")) {
        key_values.push(json!({
            "label": "Tokens used",
            "value": tokens_used.to_string(),
        }));
    }
    if let Some(time_used) = parse_internal_id(goal.get("timeUsedSeconds")) {
        key_values.push(json!({
            "label": "Time used",
            "value": format_duration_seconds(time_used),
        }));
    }
    if let Some(remaining_tokens) = parse_internal_id(output_object.get("remainingTokens")) {
        key_values.push(json!({
            "label": "Remaining tokens",
            "value": remaining_tokens.to_string(),
        }));
    }

    let mut blocks = vec![json!({
        "type": "keyValue",
        "items": key_values,
    })];
    if let Some(report) = read_string(output_object.get("completionBudgetReport"))
        .filter(|value| !value.trim().is_empty())
    {
        blocks.push(json!({
            "type": "markdown",
            "markdown": report,
        }));
    }

    let mut surface = serde_json::Map::new();
    surface.insert("id".to_string(), json!(format!("goal-{thread_id}")));
    surface.insert("threadId".to_string(), json!(thread_id));
    surface.insert("turnId".to_string(), Value::Null);
    surface.insert("kind".to_string(), json!("goal"));
    surface.insert("presentation".to_string(), json!("workflowCard"));
    surface.insert("tone".to_string(), json!(tone));
    surface.insert("title".to_string(), json!("Goal"));
    surface.insert("subtitle".to_string(), json!(format_goal_status(&status)));
    surface.insert("bodyMarkdown".to_string(), json!(objective));
    surface.insert("blocks".to_string(), json!(blocks));
    surface.insert(
        "actions".to_string(),
        json!([
            {
                "id": "dismiss",
                "label": "Dismiss",
                "style": "secondary",
                "dismissesSurface": true
            }
        ]),
    );
    surface.insert("dismissible".to_string(), json!(true));

    if let Some(created_at) =
        parse_internal_id(goal.get("createdAt")).and_then(epoch_seconds_to_rfc3339)
    {
        surface.insert("createdAt".to_string(), json!(created_at));
    }
    let updated_at = parse_internal_id(goal.get("updatedAt"))
        .and_then(epoch_seconds_to_rfc3339)
        .or_else(|| timestamp.map(str::to_string));
    if let Some(updated_at) = updated_at {
        surface.insert("updatedAt".to_string(), json!(updated_at));
    }

    Some(("bridge/ui.update".to_string(), Value::Object(surface)))
}

pub(super) fn build_rollout_goal_budget_ui_surface_notification(
    payload: &serde_json::Map<String, Value>,
    thread_id: &str,
    timestamp: Option<&str>,
) -> Option<(String, Value)> {
    if read_string(payload.get("role")).as_deref() != Some("developer") {
        return None;
    }

    let message = extract_rollout_message_text(payload)?;
    let budget = parse_rollout_goal_budget_message(&message)?;

    let mut key_values = vec![
        json!({
            "label": "Status",
            "value": "Active",
        }),
        json!({
            "label": "Tokens used",
            "value": budget.tokens_used.to_string(),
        }),
        json!({
            "label": "Time used",
            "value": format_duration_seconds(budget.time_used_seconds),
        }),
    ];

    if let Some(remaining_tokens) = budget.remaining_tokens {
        key_values.push(json!({
            "label": "Remaining tokens",
            "value": remaining_tokens.to_string(),
        }));
    }

    let mut surface = serde_json::Map::new();
    surface.insert("id".to_string(), json!(format!("goal-{thread_id}")));
    surface.insert("threadId".to_string(), json!(thread_id));
    surface.insert("turnId".to_string(), Value::Null);
    surface.insert("kind".to_string(), json!("goal"));
    surface.insert("presentation".to_string(), json!("workflowCard"));
    surface.insert("tone".to_string(), json!("info"));
    surface.insert("title".to_string(), json!("Goal"));
    surface.insert("subtitle".to_string(), json!("Active"));
    surface.insert("bodyMarkdown".to_string(), json!(budget.objective));
    surface.insert(
        "blocks".to_string(),
        json!([
            {
                "type": "keyValue",
                "items": key_values,
            }
        ]),
    );
    surface.insert(
        "actions".to_string(),
        json!([
            {
                "id": "dismiss",
                "label": "Dismiss",
                "style": "secondary",
                "dismissesSurface": true
            }
        ]),
    );
    surface.insert("dismissible".to_string(), json!(true));
    if let Some(updated_at) = timestamp {
        surface.insert("updatedAt".to_string(), json!(updated_at));
    }

    Some(("bridge/ui.update".to_string(), Value::Object(surface)))
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct RolloutGoalBudget {
    pub(super) objective: String,
    pub(super) time_used_seconds: u64,
    pub(super) tokens_used: u64,
    pub(super) remaining_tokens: Option<u64>,
}

pub(super) fn extract_rollout_message_text(
    payload: &serde_json::Map<String, Value>,
) -> Option<String> {
    let content = payload.get("content")?.as_array()?;
    let mut text_parts = Vec::new();
    for part in content {
        let part_object = part.as_object()?;
        if let Some(text) = read_string(part_object.get("text")) {
            text_parts.push(text);
        }
    }

    if text_parts.is_empty() {
        None
    } else {
        Some(text_parts.join("\n"))
    }
}

pub(super) fn parse_rollout_goal_budget_message(message: &str) -> Option<RolloutGoalBudget> {
    if !message.contains("Continue working toward the active thread goal.") {
        return None;
    }

    let objective =
        extract_between_markers(message, "<untrusted_objective>", "</untrusted_objective>")?
            .trim()
            .to_string();
    if objective.is_empty() {
        return None;
    }

    let time_used_seconds = extract_number_after_prefix(message, "- Time spent pursuing goal:")?;
    let tokens_used = extract_number_after_prefix(message, "- Tokens used:")?;
    let remaining_tokens = extract_number_after_prefix(message, "- Tokens remaining:");

    Some(RolloutGoalBudget {
        objective,
        time_used_seconds,
        tokens_used,
        remaining_tokens,
    })
}

pub(super) fn extract_between_markers<'a>(
    value: &'a str,
    start: &str,
    end: &str,
) -> Option<&'a str> {
    let after_start = value.split_once(start)?.1;
    Some(after_start.split_once(end)?.0)
}

pub(super) fn extract_number_after_prefix(value: &str, prefix: &str) -> Option<u64> {
    let line = value
        .lines()
        .find(|line| line.trim_start().starts_with(prefix))?;
    let raw = line.trim_start().strip_prefix(prefix)?.trim();
    let digits = raw
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(|character| character.is_ascii_digit() || *character == ',')
        .filter(|character| *character != ',')
        .collect::<String>();
    if digits.is_empty() {
        None
    } else {
        digits.parse::<u64>().ok()
    }
}

pub(super) fn parse_rollout_function_call_output(raw_output: Option<&Value>) -> Value {
    if let Some(text_output) = raw_output.and_then(Value::as_str) {
        return serde_json::from_str::<Value>(text_output).unwrap_or(Value::Null);
    }

    raw_output.cloned().unwrap_or(Value::Null)
}

pub(super) fn parse_rollout_function_call_arguments(raw_arguments: Option<&Value>) -> Value {
    if let Some(text_arguments) = raw_arguments.and_then(Value::as_str) {
        return serde_json::from_str::<Value>(text_arguments).unwrap_or(Value::Null);
    }

    raw_arguments.cloned().unwrap_or(Value::Null)
}

pub(super) fn format_goal_status(status: &str) -> String {
    let trimmed = status.trim();
    if trimmed.is_empty() {
        return "Active".to_string();
    }

    let normalized = trimmed.replace(['_', '-'], " ");
    let mut formatted = Vec::new();
    for word in normalized.split_whitespace() {
        let mut chars = word.chars();
        if let Some(first) = chars.next() {
            formatted.push(format!(
                "{}{}",
                first.to_uppercase(),
                chars.as_str().to_ascii_lowercase()
            ));
        }
    }

    if formatted.is_empty() {
        "Active".to_string()
    } else {
        formatted.join(" ")
    }
}

pub(super) fn format_duration_seconds(seconds: u64) -> String {
    let hours = seconds / 3600;
    let minutes = (seconds % 3600) / 60;
    let remaining_seconds = seconds % 60;

    if hours > 0 {
        return format!("{hours}h {minutes}m");
    }
    if minutes > 0 {
        return format!("{minutes}m {remaining_seconds}s");
    }
    format!("{remaining_seconds}s")
}

pub(super) fn epoch_seconds_to_rfc3339(seconds: u64) -> Option<String> {
    let seconds = i64::try_from(seconds).ok()?;
    DateTime::<Utc>::from_timestamp(seconds, 0).map(|timestamp| timestamp.to_rfc3339())
}

pub(super) fn parse_rollout_mcp_tool_name(name: &str) -> Option<(String, String)> {
    if !name.starts_with("mcp__") {
        return None;
    }

    let raw = name.trim_start_matches("mcp__");
    let mut segments = raw.split("__");
    let server = segments.next()?.trim();
    if server.is_empty() {
        return None;
    }

    let tool = segments.collect::<Vec<_>>().join("__");
    if tool.trim().is_empty() {
        return None;
    }

    Some((server.to_string(), tool))
}

pub(super) fn extract_rollout_search_query(arguments: &Value) -> Option<String> {
    let object = arguments.as_object()?;

    let entries = object
        .get("search_query")
        .and_then(Value::as_array)
        .or_else(|| object.get("image_query").and_then(Value::as_array))?;

    for entry in entries {
        let query = read_string(entry.as_object().and_then(|item| item.get("q")));
        if let Some(query) = query.filter(|query| !query.trim().is_empty()) {
            return Some(query);
        }
    }

    None
}
