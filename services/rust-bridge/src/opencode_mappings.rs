use crate::*;

pub(super) fn opencode_part_key(session_id: &str, part_id: &str) -> String {
    format!("{session_id}:{part_id}")
}

pub(super) fn opencode_status_is_active(status: Option<&str>) -> bool {
    matches!(status, Some("busy" | "retry"))
}

pub(super) fn opencode_agent_for_collaboration_mode(value: Option<&Value>) -> Option<&'static str> {
    let mode = value.and_then(|value| {
        value
            .as_str()
            .or_else(|| value.as_object()?.get("mode")?.as_str())
    })?;
    match mode.trim().to_ascii_lowercase().as_str() {
        "plan" => Some("plan"),
        "default" => Some("build"),
        _ => None,
    }
}

pub(super) fn opencode_permission_kind(permission: Option<&str>) -> &'static str {
    let normalized = permission.unwrap_or_default().trim().to_ascii_lowercase();
    if normalized.contains("write")
        || normalized.contains("edit")
        || normalized.contains("patch")
        || normalized.contains("delete")
    {
        return "fileChange";
    }

    "commandExecution"
}

pub(super) fn parse_opencode_model_selector(value: &str) -> Option<(String, String)> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let (provider_id, model_id) = trimmed
        .split_once('/')
        .or_else(|| trimmed.split_once(':'))
        .or_else(|| trimmed.split_once('|'))?;
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }

    Some((provider_id.to_string(), model_id.to_string()))
}

pub(super) fn opencode_model_description(model: &serde_json::Map<String, Value>) -> Option<String> {
    let mut parts = Vec::new();

    if let Some(family) = read_string(model.get("family")).filter(|value| !value.is_empty()) {
        parts.push(family);
    }

    if let Some(status) =
        read_string(model.get("status")).filter(|value| !value.eq_ignore_ascii_case("active"))
    {
        parts.push(status);
    }

    if let Some(context_limit) = model
        .get("limit")
        .and_then(Value::as_object)
        .and_then(|limit| limit.get("context"))
        .and_then(Value::as_u64)
    {
        parts.push(format!("{context_limit} ctx"));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

pub(super) fn normalize_reasoning_effort_name(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some("xhigh"),
        _ => None,
    }
}

pub(super) fn opencode_variant_effort(
    variant_name: &str,
    variant_value: Option<&serde_json::Map<String, Value>>,
) -> Option<&'static str> {
    if let Some(effort) = variant_value.and_then(|entry| read_string(entry.get("reasoningEffort")))
    {
        if let Some(normalized) = normalize_reasoning_effort_name(&effort) {
            return Some(normalized);
        }
    }

    normalize_reasoning_effort_name(variant_name).or_else(|| {
        variant_value
            .and_then(|entry| entry.get("thinking"))
            .map(|_| "high")
    })
}

pub(super) fn opencode_variant_description(
    variant_name: &str,
    effort: &str,
    variant_value: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    if variant_name.eq_ignore_ascii_case("max") {
        return Some("Max thinking budget".to_string());
    }

    if let Some(thinking) = variant_value
        .and_then(|entry| entry.get("thinking"))
        .and_then(Value::as_object)
        .and_then(|thinking| thinking.get("budgetTokens"))
        .and_then(Value::as_u64)
    {
        return Some(format!("{thinking} thinking tokens"));
    }

    if variant_name.eq_ignore_ascii_case(effort) {
        return None;
    }

    Some(format!("Uses the {variant_name} variant"))
}

pub(super) fn opencode_reasoning_effort_options(
    model: &serde_json::Map<String, Value>,
) -> Vec<Value> {
    let Some(variants) = model.get("variants").and_then(Value::as_object) else {
        return Vec::new();
    };

    let effort_order = |effort: &str| match effort {
        "none" => 0,
        "minimal" => 1,
        "low" => 2,
        "medium" => 3,
        "high" => 4,
        "xhigh" => 5,
        _ => 99,
    };

    let mut seen = HashSet::new();
    let mut options = variants
        .iter()
        .filter_map(|(variant_name, variant_value)| {
            let variant_object = variant_value.as_object();
            let effort = opencode_variant_effort(variant_name, variant_object)?;
            if !seen.insert(effort) {
                return None;
            }

            Some((
                effort_order(effort),
                json!({
                    "effort": effort,
                    "description": opencode_variant_description(variant_name, effort, variant_object),
                }),
            ))
        })
        .collect::<Vec<_>>();

    options.sort_by_key(|entry| entry.0);
    options.into_iter().map(|(_, value)| value).collect()
}

pub(super) fn opencode_variant_for_effort(
    configured_providers: &Value,
    provider_id: &str,
    model_id: &str,
    requested_effort: &str,
) -> Option<String> {
    let normalized_effort = normalize_reasoning_effort_name(requested_effort)?;
    let providers = configured_providers
        .get("providers")
        .and_then(Value::as_array)?;

    let variants = providers
        .iter()
        .filter_map(Value::as_object)
        .find(|provider| provider.get("id").and_then(Value::as_str) == Some(provider_id))
        .and_then(|provider| provider.get("models"))
        .and_then(Value::as_object)
        .and_then(|models| models.get(model_id))
        .and_then(Value::as_object)
        .and_then(|model| model.get("variants"))
        .and_then(Value::as_object)?;

    let exact_match = variants.iter().find_map(|(variant_name, variant_value)| {
        let variant_object = variant_value.as_object();
        let effort = opencode_variant_effort(variant_name, variant_object)?;
        if effort == normalized_effort && variant_name.eq_ignore_ascii_case(requested_effort) {
            Some(variant_name.to_string())
        } else {
            None
        }
    });
    if exact_match.is_some() {
        return exact_match;
    }

    variants.iter().find_map(|(variant_name, variant_value)| {
        let variant_object = variant_value.as_object();
        let effort = opencode_variant_effort(variant_name, variant_object)?;
        if effort == normalized_effort {
            Some(variant_name.to_string())
        } else {
            None
        }
    })
}

pub(super) fn opencode_connected_provider_ids(provider_catalog: Option<&Value>) -> HashSet<String> {
    provider_catalog
        .and_then(Value::as_object)
        .and_then(|catalog| catalog.get("connected"))
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect::<HashSet<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn opencode_default_model_selector(
    configured_providers: &Value,
    provider_catalog: Option<&Value>,
    config: Option<&Value>,
) -> Option<(String, String)> {
    if let Some(configured) = config
        .and_then(Value::as_object)
        .and_then(|config| config.get("model"))
        .and_then(Value::as_str)
        .and_then(parse_opencode_model_selector)
    {
        return Some(configured);
    }

    let providers = configured_providers
        .get("providers")
        .and_then(Value::as_array)?;
    let defaults = configured_providers
        .get("default")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let connected_provider_ids = opencode_connected_provider_ids(provider_catalog);
    let filter_connected = !connected_provider_ids.is_empty();
    let mut fallback: Option<(String, String)> = None;

    for provider in providers.iter().filter_map(Value::as_object) {
        let Some(provider_id) = read_string(provider.get("id")).filter(|value| !value.is_empty())
        else {
            continue;
        };
        if filter_connected && !connected_provider_ids.contains(&provider_id) {
            continue;
        }

        let Some(models) = provider.get("models").and_then(Value::as_object) else {
            continue;
        };

        if fallback.is_none() {
            if let Some(first_model_id) = models.keys().min() {
                fallback = Some((provider_id.clone(), first_model_id.to_string()));
            }
        }

        if let Some(default_model_id) = defaults
            .get(&provider_id)
            .and_then(Value::as_str)
            .filter(|model_id| models.contains_key(*model_id))
        {
            return Some((provider_id, default_model_id.to_string()));
        }
    }

    fallback
}

pub(super) fn opencode_flatten_model_options(
    configured_providers: &Value,
    provider_catalog: Option<&Value>,
    config: Option<&Value>,
) -> Vec<Value> {
    let Some(configured) = configured_providers.as_object() else {
        return Vec::new();
    };
    let Some(providers) = configured.get("providers").and_then(Value::as_array) else {
        return Vec::new();
    };

    let defaults = configured
        .get("default")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let connected_provider_ids = opencode_connected_provider_ids(provider_catalog);
    let filter_connected = !connected_provider_ids.is_empty();
    let configured_default =
        opencode_default_model_selector(configured_providers, provider_catalog, config);
    let configured_default_key =
        configured_default.map(|(provider_id, model_id)| format!("{provider_id}/{model_id}"));

    let mut flattened = Vec::new();

    for provider in providers {
        let Some(provider_object) = provider.as_object() else {
            continue;
        };
        let Some(provider_id) =
            read_string(provider_object.get("id")).filter(|value| !value.is_empty())
        else {
            continue;
        };
        let connected = !filter_connected || connected_provider_ids.contains(&provider_id);
        if filter_connected && !connected {
            continue;
        }

        let provider_name =
            read_string(provider_object.get("name")).unwrap_or_else(|| provider_id.clone());
        let provider_default = defaults.get(&provider_id).and_then(Value::as_str);
        let Some(models) = provider_object.get("models").and_then(Value::as_object) else {
            continue;
        };

        let mut provider_models = models
            .iter()
            .filter_map(|(model_id, model_value)| {
                let model_object = model_value.as_object()?;
                let display_name = read_string(model_object.get("name"))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| model_id.to_string());
                let full_id = format!("{provider_id}/{model_id}");
                let description = opencode_model_description(model_object);
                let reasoning_efforts = opencode_reasoning_effort_options(model_object);
                let is_default = configured_default_key
                    .as_deref()
                    .map(|default_key| default_key == full_id)
                    .unwrap_or(false);
                let provider_default_rank = provider_default
                    .map(|default_model_id| default_model_id != model_id.as_str())
                    .unwrap_or(true);

                Some((
                    provider_name.to_ascii_lowercase(),
                    provider_default_rank,
                    display_name.to_ascii_lowercase(),
                    json!({
                        "id": full_id,
                        "displayName": display_name,
                        "description": description,
                        "providerId": provider_id.clone(),
                        "providerName": provider_name.clone(),
                        "connected": connected,
                        "authRequired": !connected,
                        "hidden": false,
                        "supportsPersonality": false,
                        "isDefault": is_default,
                        "supportedReasoningEfforts": reasoning_efforts,
                    }),
                ))
            })
            .collect::<Vec<_>>();

        provider_models
            .sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.2.cmp(&right.2)));

        flattened.extend(provider_models.into_iter().map(|(_, _, _, value)| value));
    }

    flattened.sort_by(|left, right| {
        let left_object = left.as_object();
        let right_object = right.as_object();
        let left_provider = left_object
            .and_then(|entry| read_string(entry.get("providerName")))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_provider = right_object
            .and_then(|entry| read_string(entry.get("providerName")))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let left_default =
            !read_bool(left_object.and_then(|entry| entry.get("isDefault"))).unwrap_or(false);
        let right_default =
            !read_bool(right_object.and_then(|entry| entry.get("isDefault"))).unwrap_or(false);
        let left_name = left_object
            .and_then(|entry| read_string(entry.get("displayName")))
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_name = right_object
            .and_then(|entry| read_string(entry.get("displayName")))
            .unwrap_or_default()
            .to_ascii_lowercase();

        left_default
            .cmp(&right_default)
            .then_with(|| left_provider.cmp(&right_provider))
            .then_with(|| left_name.cmp(&right_name))
    });

    flattened
}

pub(super) fn opencode_prompt_parts_from_turn_input(input: &[Value]) -> Vec<Value> {
    let mut parts = Vec::new();

    for item in input {
        let Some(item_object) = item.as_object() else {
            continue;
        };
        let Some(item_type) = read_string(item_object.get("type")) else {
            continue;
        };

        match item_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(item_object.get("text")).filter(|text| !text.is_empty())
                {
                    parts.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
            "mention" => {
                if let Some(path) =
                    read_string(item_object.get("path")).filter(|path| !path.is_empty())
                {
                    let filename = Path::new(&path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("file")
                        .to_string();
                    let mime = if Path::new(&path).is_dir() {
                        "application/x-directory"
                    } else {
                        "text/plain"
                    };
                    if let Ok(url) = Url::from_file_path(&path) {
                        parts.push(json!({
                            "type": "file",
                            "url": url.to_string(),
                            "filename": filename,
                            "mime": mime,
                        }));
                    }
                }
            }
            "localImage" => {
                if let Some(path) =
                    read_string(item_object.get("path")).filter(|path| !path.is_empty())
                {
                    let filename = Path::new(&path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("image")
                        .to_string();
                    let mime =
                        infer_image_content_type_from_path(Path::new(&path)).unwrap_or("image/png");
                    if let Ok(url) = Url::from_file_path(&path) {
                        parts.push(json!({
                            "type": "file",
                            "url": url.to_string(),
                            "filename": filename,
                            "mime": mime,
                        }));
                    }
                }
            }
            _ => {}
        }
    }

    parts
}

pub(super) fn opencode_tool_part_bridge_event(
    part: &serde_json::Map<String, Value>,
) -> Option<(&'static str, Value)> {
    let state = part.get("state")?.as_object()?;
    let status = read_string(state.get("status"))?;
    let status_for_item = opencode_tool_status_for_item(&status);

    let event_method = if status == "pending" || status == "running" {
        "item/started"
    } else {
        "item/completed"
    };

    let item = opencode_tool_part_item(part, status_for_item)?;

    Some((event_method, item))
}

pub(super) fn opencode_tool_input_command(
    input: &serde_json::Map<String, Value>,
) -> Option<String> {
    read_shell_command(input.get("cmd"))
        .or_else(|| read_shell_command(input.get("command")))
        .or_else(|| read_string(input.get("cmd")))
        .or_else(|| read_string(input.get("command")))
}

pub(super) fn opencode_tool_status_for_item(status: &str) -> &'static str {
    match status {
        "pending" | "running" => "running",
        "error" => "failed",
        _ => "completed",
    }
}

pub(super) fn opencode_tool_part_item(
    part: &serde_json::Map<String, Value>,
    status_for_item: &str,
) -> Option<Value> {
    let tool_name = read_string(part.get("tool"))?;
    let state = part.get("state")?.as_object()?;
    let input = state.get("input").and_then(Value::as_object);
    let metadata = state.get("metadata").and_then(Value::as_object);
    let item_id = read_string(part.get("id")).unwrap_or_else(generate_opencode_local_id);
    let result = opencode_tool_result_value(state, metadata);
    let error = opencode_tool_error_value(state, metadata);

    if let Some((server, tool)) = parse_rollout_mcp_tool_name(&tool_name) {
        let mut item = json!({
            "id": item_id,
            "type": "mcpToolCall",
            "server": server,
            "tool": tool,
            "status": status_for_item,
        });
        if !result.is_null() {
            item["result"] = result;
        }
        if !error.is_null() {
            item["error"] = error;
        }
        return Some(item);
    }

    if opencode_permission_kind(Some(&tool_name)) == "fileChange" {
        let mut item = json!({
            "id": item_id,
            "type": "fileChange",
            "status": status_for_item,
        });
        if !error.is_null() {
            item["error"] = error;
        }
        return Some(item);
    }

    let command = input
        .and_then(opencode_tool_input_command)
        .unwrap_or(tool_name.clone());
    let mut item = json!({
        "id": item_id,
        "type": "commandExecution",
        "command": command,
        "status": status_for_item,
    });
    if let Some(output) = opencode_tool_output_text(state, metadata) {
        item["aggregatedOutput"] = json!(output);
    }
    if let Some(exit_code) = opencode_tool_exit_code(state, metadata) {
        item["exitCode"] = json!(exit_code);
    }
    if !error.is_null() {
        item["error"] = error;
    }
    Some(item)
}

pub(super) fn opencode_tool_result_value(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Value {
    state
        .get("output")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            metadata.and_then(|metadata| {
                metadata
                    .get("result")
                    .filter(|value| !value.is_null())
                    .cloned()
            })
        })
        .unwrap_or(Value::Null)
}

pub(super) fn opencode_tool_error_value(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Value {
    state
        .get("error")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            metadata.and_then(|metadata| {
                metadata
                    .get("error")
                    .filter(|value| !value.is_null())
                    .cloned()
            })
        })
        .unwrap_or(Value::Null)
}

pub(super) fn opencode_tool_output_text(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    read_string(state.get("output"))
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("output"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("stdout"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .or_else(|| {
            metadata
                .and_then(|metadata| metadata.get("stderr"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

pub(super) fn opencode_tool_exit_code(
    state: &serde_json::Map<String, Value>,
    metadata: Option<&serde_json::Map<String, Value>>,
) -> Option<u64> {
    parse_internal_id(state.get("exitCode"))
        .or_else(|| metadata.and_then(|metadata| parse_internal_id(metadata.get("exitCode"))))
        .or_else(|| metadata.and_then(|metadata| parse_internal_id(metadata.get("exit_code"))))
}

pub(super) fn opencode_latest_user_message_id(messages: &Value) -> Option<String> {
    messages
        .as_array()?
        .iter()
        .rev()
        .filter_map(Value::as_object)
        .find_map(|message| {
            let info = message.get("info")?.as_object()?;
            let role = read_string(info.get("role"))?;
            if role != "user" {
                return None;
            }
            read_string(info.get("id"))
        })
}

pub(super) fn opencode_thread_preview_from_messages(messages: &Value) -> Option<String> {
    let messages = messages.as_array()?;
    for message in messages.iter().rev() {
        let Some(message_object) = message.as_object() else {
            continue;
        };
        let text = opencode_assistant_message_text(message_object)
            .or_else(|| opencode_user_message_text(message_object));
        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
            return Some(to_preview_like(&text));
        }
    }

    None
}

pub(super) fn opencode_messages_to_turns(
    session_id: &str,
    messages: &Value,
    status: Option<&str>,
    active_turn_id: Option<&str>,
) -> Vec<Value> {
    let mut turns = Vec::new();
    let mut turn_index_by_user_message = HashMap::<String, usize>::new();

    for message in messages.as_array().into_iter().flatten() {
        let Some(message_object) = message.as_object() else {
            continue;
        };
        let Some(info) = message_object.get("info").and_then(Value::as_object) else {
            continue;
        };
        let Some(role) = read_string(info.get("role")) else {
            continue;
        };

        if role == "user" {
            let turn_id =
                read_string(info.get("id")).unwrap_or_else(|| generate_opencode_local_id());
            let user_content = opencode_user_content_items(message_object);
            let mut turn = json!({
                "id": turn_id.clone(),
                "status": "completed",
                "items": [],
            });

            if !user_content.is_empty() {
                turn["items"] = json!([
                    {
                        "type": "userMessage",
                        "id": turn_id.clone(),
                        "content": user_content,
                    }
                ]);
            }

            turn_index_by_user_message.insert(turn_id, turns.len());
            turns.push(turn);
            continue;
        }

        if role != "assistant" {
            continue;
        }

        let Some(parent_id) = read_string(info.get("parentID")) else {
            continue;
        };
        let Some(index) = turn_index_by_user_message.get(&parent_id).copied() else {
            continue;
        };

        let assistant_error = info
            .get("error")
            .and_then(Value::as_object)
            .and_then(|error| read_string(error.get("message")));
        let assistant_items = opencode_assistant_message_items(message_object);
        let has_assistant_items = !assistant_items.is_empty();

        if let Some(items) = turns[index].get_mut("items").and_then(Value::as_array_mut) {
            items.extend(assistant_items);
        }

        if !has_assistant_items {
            if let Some(text) = assistant_error
                .clone()
                .filter(|text| !text.trim().is_empty())
            {
                let item_id =
                    read_string(info.get("id")).unwrap_or_else(|| generate_opencode_local_id());
                if let Some(items) = turns[index].get_mut("items").and_then(Value::as_array_mut) {
                    items.push(json!({
                        "type": "agentMessage",
                        "id": item_id,
                        "text": text,
                    }));
                }
            }
        }

        if let Some(error_message) = assistant_error {
            turns[index]["status"] = json!("failed");
            turns[index]["error"] = json!({
                "message": error_message,
            });
            continue;
        }

        turns[index]["status"] = json!("completed");
    }

    if let Some(last_turn) = turns.last_mut() {
        if opencode_status_is_active(status) {
            last_turn["status"] = json!("in_progress");
            if let Some(active_turn_id) = active_turn_id {
                last_turn["id"] = json!(active_turn_id);
            }
        } else if last_turn
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .is_empty()
        {
            last_turn["status"] = json!("completed");
        }
    }

    if turns.is_empty() && opencode_status_is_active(status) {
        turns.push(json!({
            "id": active_turn_id.unwrap_or(session_id),
            "status": "in_progress",
            "items": [],
        }));
    }

    turns
}

pub(super) fn opencode_assistant_message_items(
    message: &serde_json::Map<String, Value>,
) -> Vec<Value> {
    let Some(parts) = message.get("parts").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut items = Vec::new();
    for part in parts {
        let Some(part_object) = part.as_object() else {
            continue;
        };
        let Some(part_type) = read_string(part_object.get("type")) else {
            continue;
        };
        let item_id = read_string(part_object.get("id")).unwrap_or_else(generate_opencode_local_id);

        match part_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(part_object.get("text")).filter(|text| !text.trim().is_empty())
                {
                    items.push(json!({
                        "type": "agentMessage",
                        "id": item_id,
                        "text": text,
                    }));
                }
            }
            "reasoning" => {
                if let Some(text) =
                    read_string(part_object.get("text")).filter(|text| !text.trim().is_empty())
                {
                    items.push(json!({
                        "type": "reasoning",
                        "id": item_id,
                        "text": text,
                    }));
                }
            }
            "tool" => {
                if let Some(state) = part_object.get("state").and_then(Value::as_object) {
                    let status =
                        read_string(state.get("status")).unwrap_or_else(|| "completed".to_string());
                    if let Some(item) =
                        opencode_tool_part_item(part_object, opencode_tool_status_for_item(&status))
                    {
                        items.push(item);
                    }
                }
            }
            _ => {}
        }
    }

    items
}

pub(super) fn opencode_user_content_items(message: &serde_json::Map<String, Value>) -> Vec<Value> {
    let Some(parts) = message.get("parts").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut content = Vec::new();
    for part in parts {
        let Some(part_object) = part.as_object() else {
            continue;
        };
        let Some(part_type) = read_string(part_object.get("type")) else {
            continue;
        };

        match part_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(part_object.get("text")).filter(|text| !text.is_empty())
                {
                    content.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
            "file" => {
                let Some(url) = read_string(part_object.get("url")) else {
                    continue;
                };
                let Some(path) = opencode_file_url_to_path(&url) else {
                    continue;
                };
                let mime = read_string(part_object.get("mime")).unwrap_or_default();
                if mime.starts_with("image/") {
                    content.push(json!({
                        "type": "localImage",
                        "path": path,
                    }));
                } else {
                    content.push(json!({
                        "type": "mention",
                        "path": path,
                    }));
                }
            }
            _ => {}
        }
    }

    content
}

pub(super) fn opencode_user_message_text(
    message: &serde_json::Map<String, Value>,
) -> Option<String> {
    let content = opencode_user_content_items(message);
    let mut parts = Vec::new();
    for item in content {
        let Some(item_object) = item.as_object() else {
            continue;
        };
        let item_type = read_string(item_object.get("type")).unwrap_or_default();
        match item_type.as_str() {
            "text" => {
                if let Some(text) =
                    read_string(item_object.get("text")).filter(|text| !text.is_empty())
                {
                    parts.push(text);
                }
            }
            "mention" => {
                if let Some(path) = read_string(item_object.get("path")) {
                    parts.push(format!("[file: {path}]"));
                }
            }
            "localImage" => {
                if let Some(path) = read_string(item_object.get("path")) {
                    parts.push(format!("[local image: {path}]"));
                }
            }
            _ => {}
        }
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

pub(super) fn opencode_assistant_message_text(
    message: &serde_json::Map<String, Value>,
) -> Option<String> {
    let parts = message.get("parts").and_then(Value::as_array)?;
    let text_parts = parts
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|part| {
            let part_type = read_string(part.get("type"))?;
            if part_type != "text" {
                return None;
            }
            read_string(part.get("text")).filter(|text| !text.trim().is_empty())
        })
        .collect::<Vec<_>>();
    if !text_parts.is_empty() {
        return Some(text_parts.join("\n"));
    }

    let reasoning = parts
        .iter()
        .filter_map(Value::as_object)
        .filter_map(|part| {
            let part_type = read_string(part.get("type"))?;
            if part_type != "reasoning" {
                return None;
            }
            read_string(part.get("text")).filter(|text| !text.trim().is_empty())
        })
        .collect::<Vec<_>>();
    if reasoning.is_empty() {
        None
    } else {
        Some(reasoning.join("\n"))
    }
}

pub(super) fn opencode_file_url_to_path(raw: &str) -> Option<String> {
    Url::parse(raw)
        .ok()
        .and_then(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

pub(super) fn generate_opencode_local_id() -> String {
    format!("opencode-local-{}", Utc::now().timestamp_millis())
}

pub(super) fn to_preview_like(value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 180 {
        return collapsed;
    }

    format!("{}...", collapsed.chars().take(177).collect::<String>())
}

pub(super) fn normalize_thread_status_label(value: Option<&Value>) -> Option<String> {
    let raw = read_string(value)?;
    let normalized = raw
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub(super) fn read_active_turn_id_from_thread(thread: &Value) -> Option<String> {
    let thread_object = thread.as_object()?;
    let turns = thread_object.get("turns")?.as_array()?;
    for turn in turns.iter().rev() {
        let Some(turn_object) = turn.as_object() else {
            continue;
        };
        let status = normalize_thread_status_label(turn_object.get("status"));
        if matches!(
            status.as_deref(),
            Some("inprogress" | "running" | "active" | "queued" | "pending")
        ) {
            if let Some(turn_id) = read_string(turn_object.get("id")) {
                return Some(turn_id);
            }
        }
    }
    None
}

pub(super) fn read_notification_turn_id(params: &Value) -> Option<String> {
    read_string(params.get("turnId"))
        .or_else(|| read_string(params.get("turn_id")))
        .or_else(|| {
            params
                .get("turn")
                .and_then(|turn| read_string(turn.get("id")))
        })
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn thread_has_running_turn(thread: &Value) -> bool {
    let thread_object = match thread.as_object() {
        Some(object) => object,
        None => return false,
    };
    if read_active_turn_id_from_thread(thread).is_some() {
        return true;
    }

    let status = thread_object
        .get("status")
        .and_then(|value| {
            value
                .as_object()
                .and_then(|status| status.get("type"))
                .or(Some(value))
        })
        .and_then(|value| normalize_thread_status_label(Some(value)));
    matches!(
        status.as_deref(),
        Some("running" | "inprogress" | "queued" | "pending")
    )
}
