use crate::*;

pub(super) fn read_non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

impl BridgeRuntimeEngine {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Cursor => "cursor",
        }
    }
}

pub(super) fn is_known_engine(value: &str) -> bool {
    matches!(value, "codex" | "opencode" | "cursor")
}

pub(super) fn decode_engine_qualified_id(value: &str) -> String {
    let trimmed = value.trim();
    match trimmed.split_once(':') {
        Some(("codex", raw)) | Some(("opencode", raw)) | Some(("cursor", raw))
            if !raw.trim().is_empty() =>
        {
            raw.trim().to_string()
        }
        _ => trimmed.to_string(),
    }
}

pub(super) fn encode_engine_qualified_id(engine: BridgeRuntimeEngine, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    match trimmed.split_once(':') {
        Some((prefix, raw)) if is_known_engine(prefix) && !raw.trim().is_empty() => {
            format!("{prefix}:{}", raw.trim())
        }
        _ => format!("{}:{trimmed}", engine.as_str()),
    }
}

pub(super) fn normalize_forwarded_ids(value: Value) -> Value {
    normalize_forwarded_ids_for_key(None, value)
}

pub(super) fn normalize_forwarded_params(value: Value) -> Value {
    strip_bridge_routing_fields(normalize_forwarded_ids(value))
}

pub(super) fn normalize_forwarded_path_params(
    params: Option<Value>,
    path_policy: &PathPolicy,
) -> Result<Option<Value>, BridgeError> {
    params
        .map(|value| normalize_forwarded_value_paths(value, path_policy, path_policy.root()))
        .transpose()
}

pub(super) fn normalize_forwarded_value_paths(
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

            let normalized = object
                .into_iter()
                .map(|(key, child)| {
                    normalize_forwarded_value_paths(child, path_policy, &base)
                        .map(|child| (key, child))
                })
                .collect::<Result<serde_json::Map<String, Value>, BridgeError>>()?;
            Ok(Value::Object(normalized))
        }
        Value::Array(values) => values
            .into_iter()
            .map(|item| normalize_forwarded_value_paths(item, path_policy, inherited_base))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        other => Ok(other),
    }
}

pub(super) fn normalize_forwarded_ids_for_key(key: Option<&str>, value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let normalized = object
                .into_iter()
                .map(|(child_key, child_value)| {
                    let normalized_value =
                        normalize_forwarded_ids_for_key(Some(child_key.as_str()), child_value);
                    (child_key, normalized_value)
                })
                .collect();
            Value::Object(normalized)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|item| normalize_forwarded_ids_for_key(key, item))
                .collect(),
        ),
        Value::String(raw) if key.is_some_and(is_engine_id_field) => {
            Value::String(decode_engine_qualified_id(&raw))
        }
        other => other,
    }
}

pub(super) fn strip_bridge_routing_fields(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            object.remove("engine");
            Value::Object(object)
        }
        other => other,
    }
}

pub(super) fn is_engine_id_field(key: &str) -> bool {
    matches!(
        key,
        "threadId"
            | "thread_id"
            | "conversationId"
            | "conversation_id"
            | "parentThreadId"
            | "parent_thread_id"
    )
}

pub(super) fn normalize_forwarded_notification(
    method: &str,
    params: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    let normalized = qualify_engine_ids(params, engine);
    if method.starts_with("thread/") {
        return normalize_thread_payload_container(normalized, engine);
    }

    normalized
}

pub(super) fn normalize_forwarded_result(
    method: &str,
    result: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    let normalized = qualify_engine_ids(result, engine);
    match method {
        "thread/list" => normalize_thread_list_result(normalized, engine),
        "thread/loaded/list" => normalize_loaded_thread_ids_result(normalized, engine),
        "thread/read" | "thread/start" | "thread/fork" => {
            normalize_thread_payload_container(normalized, engine)
        }
        _ => normalized,
    }
}

pub(super) fn is_transient_app_server_thread_read_error(method: &str, message: &str) -> bool {
    if method != "thread/read" {
        return false;
    }

    let normalized = message.to_ascii_lowercase();
    normalized.contains("failed to read thread")
        && normalized.contains("thread-store internal error")
        && normalized.contains("rollout")
        && normalized.contains("is empty")
}

pub(super) fn qualify_engine_ids(value: Value, engine: BridgeRuntimeEngine) -> Value {
    qualify_engine_ids_for_key(None, value, engine)
}

pub(super) fn qualify_engine_ids_for_key(
    key: Option<&str>,
    value: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    match value {
        Value::Object(object) => {
            let normalized = object
                .into_iter()
                .map(|(child_key, child_value)| {
                    let normalized_value =
                        qualify_engine_ids_for_key(Some(child_key.as_str()), child_value, engine);
                    (child_key, normalized_value)
                })
                .collect();
            Value::Object(normalized)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|item| qualify_engine_ids_for_key(key, item, engine))
                .collect(),
        ),
        Value::String(raw) if key.is_some_and(is_engine_id_field) => {
            Value::String(encode_engine_qualified_id(engine, &raw))
        }
        other => other,
    }
}

pub(super) fn normalize_thread_list_result(value: Value, engine: BridgeRuntimeEngine) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };

    if let Some(Value::Array(entries)) = object.get_mut("data") {
        for entry in entries.iter_mut() {
            let next_value = match entry {
                Value::String(raw_id) => json!(encode_engine_qualified_id(engine, raw_id)),
                _ => normalize_thread_record(entry.take(), engine),
            };
            *entry = next_value;
        }
    }

    Value::Object(object)
}

pub(super) fn normalize_loaded_thread_ids_result(
    value: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };

    if let Some(Value::Array(entries)) = object.get_mut("data") {
        for entry in entries.iter_mut() {
            if let Some(id) = entry.as_str() {
                *entry = json!(encode_engine_qualified_id(engine, id));
            }
        }
    }

    Value::Object(object)
}

pub(super) fn is_dual_engine_aggregate_method(method: &str) -> bool {
    matches!(method, "thread/list" | "thread/loaded/list")
}

pub(super) fn route_engine_from_params(params: Option<&Value>) -> Option<BridgeRuntimeEngine> {
    let params = params?.as_object()?;
    let thread_id = read_string(
        params
            .get("threadId")
            .or_else(|| params.get("thread_id"))
            .or_else(|| params.get("conversationId"))
            .or_else(|| params.get("conversation_id"))
            .or_else(|| params.get("parentThreadId"))
            .or_else(|| params.get("parent_thread_id")),
    );
    if let Some(thread_id) = thread_id.as_deref() {
        if let Some((engine, _)) = parse_engine_qualified_id(&thread_id) {
            return Some(engine);
        }
    }

    let explicit_engine = params
        .get("engine")
        .and_then(Value::as_str)
        .and_then(parse_bridge_runtime_engine);
    if explicit_engine.is_some() {
        return explicit_engine;
    }

    thread_id
        .as_deref()
        .and_then(infer_unqualified_thread_engine)
}

pub(super) fn parse_engine_qualified_id(value: &str) -> Option<(BridgeRuntimeEngine, String)> {
    let trimmed = value.trim();
    let (prefix, raw) = trimmed.split_once(':')?;
    let engine = parse_bridge_runtime_engine(prefix)?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    Some((engine, raw.to_string()))
}

pub(super) fn infer_unqualified_thread_engine(value: &str) -> Option<BridgeRuntimeEngine> {
    let trimmed = value.trim();
    if trimmed.starts_with("agent-") {
        return Some(BridgeRuntimeEngine::Cursor);
    }
    None
}

pub(super) fn extract_thread_list_entries(result: &Value) -> Vec<Value> {
    result
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

pub(super) fn extract_thread_list_cursor(params: Option<&Value>) -> Option<String> {
    params
        .and_then(Value::as_object)
        .and_then(|object| object.get("cursor"))
        .and_then(|value| read_string(Some(value)))
}

pub(super) fn thread_list_params_with_cursor(
    params: Option<&Value>,
    cursor: Option<&str>,
) -> Value {
    let mut object = params
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    match cursor {
        Some(cursor) if !cursor.trim().is_empty() => {
            object.insert("cursor".to_string(), json!(cursor.trim()));
        }
        _ => {
            object.insert("cursor".to_string(), Value::Null);
        }
    }

    Value::Object(object)
}

pub(super) fn extract_next_cursor(result: &Value) -> Option<String> {
    read_string(result.get("nextCursor"))
}

pub(super) fn extract_backwards_cursor(result: &Value) -> Option<String> {
    read_string(result.get("backwardsCursor"))
}

pub(super) fn encode_bridge_thread_list_cursor(
    cursors: &[(BridgeRuntimeEngine, String)],
) -> Option<String> {
    if cursors.is_empty() {
        return None;
    }

    let mut object = serde_json::Map::new();
    for (engine, cursor) in cursors {
        let cursor = cursor.trim();
        if cursor.is_empty() {
            continue;
        }
        object.insert(engine.as_str().to_string(), json!(cursor));
    }

    if object.is_empty() {
        return None;
    }

    let raw = serde_json::to_vec(&Value::Object(object)).ok()?;
    Some(format!(
        "{BRIDGE_THREAD_LIST_CURSOR_PREFIX}{}",
        general_purpose::URL_SAFE_NO_PAD.encode(raw)
    ))
}

pub(super) fn decode_bridge_thread_list_cursor(
    raw: &str,
) -> Option<HashMap<BridgeRuntimeEngine, String>> {
    let encoded = raw.trim().strip_prefix(BRIDGE_THREAD_LIST_CURSOR_PREFIX)?;
    let decoded = general_purpose::URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    let object = value.as_object()?;
    let mut cursors = HashMap::new();

    for (engine_key, cursor_value) in object {
        let Some(engine) = parse_bridge_runtime_engine(engine_key) else {
            continue;
        };
        let Some(cursor) = read_string(Some(cursor_value)).filter(|cursor| !cursor.is_empty())
        else {
            continue;
        };
        cursors.insert(engine, cursor);
    }

    (!cursors.is_empty()).then_some(cursors)
}

pub(super) fn extract_loaded_thread_ids(result: &Value) -> Vec<String> {
    result
        .get("data")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(super) fn merge_thread_list_results(results: Vec<(BridgeRuntimeEngine, Value)>) -> Value {
    let mut entries = Vec::new();
    let mut next_cursors = Vec::new();
    let mut backwards_cursor = None;
    let result_count = results.len();

    for (engine, result) in results {
        let normalized = normalize_forwarded_result("thread/list", result, engine);
        if let Some(cursor) = extract_next_cursor(&normalized) {
            next_cursors.push((engine, cursor));
        }
        if result_count == 1 {
            backwards_cursor = extract_backwards_cursor(&normalized);
        }
        entries.extend(extract_thread_list_entries(&normalized));
    }

    entries.sort_by(|left, right| {
        let left_updated = parse_internal_id(left.get("updatedAt")).unwrap_or(0);
        let right_updated = parse_internal_id(right.get("updatedAt")).unwrap_or(0);
        right_updated.cmp(&left_updated).then_with(|| {
            read_string(left.get("id"))
                .unwrap_or_default()
                .cmp(&read_string(right.get("id")).unwrap_or_default())
        })
    });

    let next_cursor = if result_count == 1 {
        next_cursors.first().map(|(_, cursor)| cursor.clone())
    } else {
        encode_bridge_thread_list_cursor(&next_cursors)
    };

    json!({
        "data": entries,
        "nextCursor": next_cursor,
        "backwardsCursor": backwards_cursor,
    })
}

pub(super) fn merge_loaded_thread_ids_results(results: Vec<(BridgeRuntimeEngine, Value)>) -> Value {
    let mut ids = Vec::new();

    for (engine, result) in results {
        let normalized = normalize_forwarded_result("thread/loaded/list", result, engine);
        ids.extend(extract_loaded_thread_ids(&normalized));
    }

    ids.sort();
    ids.dedup();
    json!({ "data": ids })
}

pub(super) fn normalize_thread_payload_container(
    value: Value,
    engine: BridgeRuntimeEngine,
) -> Value {
    let Value::Object(mut object) = value else {
        return value;
    };

    if let Some(thread_value) = object.remove("thread") {
        object.insert(
            "thread".to_string(),
            normalize_thread_record(thread_value, engine),
        );
        return Value::Object(object);
    }

    if looks_like_thread_record(&object) {
        return normalize_thread_record(Value::Object(object), engine);
    }

    Value::Object(object)
}

pub(super) fn normalize_thread_record(value: Value, engine: BridgeRuntimeEngine) -> Value {
    let value = qualify_engine_ids(value, engine);
    let Value::Object(mut object) = value else {
        return value;
    };

    if engine == BridgeRuntimeEngine::Codex {
        enrich_thread_record_with_rollout_mcp_media(&mut object);
    }

    if let Some(id) = object.get("id").and_then(Value::as_str) {
        object.insert(
            "id".to_string(),
            json!(encode_engine_qualified_id(engine, id)),
        );
    }
    object.insert("engine".to_string(), json!(engine.as_str()));
    Value::Object(object)
}

pub(super) fn enrich_thread_record_with_rollout_mcp_media(
    thread: &mut serde_json::Map<String, Value>,
) {
    let Some(path) = read_string(thread.get("path")).filter(|value| !value.is_empty()) else {
        return;
    };

    let candidate_ids = collect_thread_mcp_tool_media_candidates(thread);
    if candidate_ids.is_empty() {
        return;
    }

    let enrichments =
        read_rollout_mcp_tool_result_parts_by_call_id(Path::new(&path), &candidate_ids);
    if enrichments.is_empty() {
        return;
    }

    apply_rollout_mcp_tool_result_part_enrichments(thread, &enrichments);
}

pub(super) fn collect_thread_mcp_tool_media_candidates(
    thread: &serde_json::Map<String, Value>,
) -> HashSet<String> {
    let mut candidates = HashSet::new();
    let Some(turns) = thread.get("turns").and_then(Value::as_array) else {
        return candidates;
    };

    for turn in turns {
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };

        for item in items {
            let Some(item_object) = item.as_object() else {
                continue;
            };
            if item_object.get("type").and_then(Value::as_str) != Some("mcpToolCall") {
                continue;
            }
            let Some(item_id) =
                read_string(item_object.get("id")).filter(|value| !value.is_empty())
            else {
                continue;
            };
            if thread_mcp_tool_result_has_image(item_object.get("result")) {
                continue;
            }
            candidates.insert(item_id);
        }
    }

    candidates
}

pub(super) fn thread_mcp_tool_result_has_image(result: Option<&Value>) -> bool {
    rollout_value_contains_image(result, 0)
}

pub(super) fn rollout_value_contains_image(value: Option<&Value>, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    let Some(value) = value else {
        return false;
    };

    match value {
        Value::Array(entries) => entries
            .iter()
            .any(|entry| rollout_value_contains_image(Some(entry), depth + 1)),
        Value::Object(object) => {
            let entry_type = object
                .get("type")
                .and_then(Value::as_str)
                .map(normalize_rollout_content_type)
                .unwrap_or_default();
            if matches!(entry_type.as_str(), "image" | "inputimage" | "localimage")
                && (object
                    .get("image_url")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .is_some()
                    || object
                        .get("imageUrl")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_some()
                    || object
                        .get("url")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_some()
                    || object
                        .get("path")
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .is_some()
                    || rollout_image_data_url(object).is_some())
            {
                return true;
            }

            let candidate_keys = [
                "content",
                "contents",
                "items",
                "item",
                "result",
                "results",
                "output",
                "data",
                "structuredContent",
                "structured_content",
                "_meta",
                "meta",
            ];
            candidate_keys.iter().any(|key| {
                object
                    .get(*key)
                    .map(|child| rollout_value_contains_image(Some(child), depth + 1))
                    .unwrap_or(false)
            })
        }
        _ => false,
    }
}

pub(super) fn read_rollout_mcp_tool_result_parts_by_call_id(
    path: &Path,
    candidate_ids: &HashSet<String>,
) -> HashMap<String, Vec<Value>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return HashMap::new(),
    };
    let reader = std::io::BufReader::new(file);
    let mut enrichments = HashMap::new();
    use std::io::BufRead as _;

    for line in reader.lines() {
        if enrichments.len() >= candidate_ids.len() {
            break;
        }

        let Ok(line) = line else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(record_object) = record.as_object() else {
            continue;
        };
        if read_string(record_object.get("type")).as_deref() != Some("event_msg") {
            continue;
        }

        let Some(payload) = record_object.get("payload").and_then(Value::as_object) else {
            continue;
        };
        if read_string(payload.get("type")).as_deref() != Some("mcp_tool_call_end") {
            continue;
        }

        let Some(call_id) = read_string(payload.get("call_id")).filter(|value| !value.is_empty())
        else {
            continue;
        };
        if !candidate_ids.contains(&call_id) {
            continue;
        }

        let result_parts = payload
            .get("result")
            .and_then(Value::as_object)
            .and_then(|result| result.get("Ok"))
            .and_then(rollout_mcp_tool_result_parts);
        let Some(result_parts) = result_parts.filter(|parts| !parts.is_empty()) else {
            continue;
        };
        enrichments.insert(call_id, result_parts);
    }

    enrichments
}

pub(super) fn rollout_mcp_tool_result_parts(result: &Value) -> Option<Vec<Value>> {
    let content = result.get("content").and_then(Value::as_array)?;
    let mut parts = Vec::new();

    for entry in content {
        let Some(entry_object) = entry.as_object() else {
            continue;
        };
        match normalize_rollout_content_type(
            entry_object
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .as_str()
        {
            "text" => {
                if let Some(text) =
                    read_string(entry_object.get("text")).filter(|value| !value.is_empty())
                {
                    parts.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
            }
            "image" | "inputimage" => {
                if let Some(image_url) = rollout_image_data_url(entry_object) {
                    parts.push(json!({
                        "type": "input_image",
                        "image_url": image_url,
                    }));
                }
            }
            "localimage" => {
                if let Some(path) =
                    read_string(entry_object.get("path")).filter(|value| !value.is_empty())
                {
                    parts.push(json!({
                        "type": "localImage",
                        "path": path,
                    }));
                }
            }
            _ => {}
        }
    }

    Some(parts)
}

pub(super) fn rollout_image_data_url(entry: &serde_json::Map<String, Value>) -> Option<String> {
    let data = read_string(entry.get("data")).filter(|value| !value.is_empty())?;
    let mime_type = read_string(entry.get("mimeType"))
        .or_else(|| read_string(entry.get("mime_type")))
        .filter(|value| !value.is_empty())?;
    Some(format!("data:{mime_type};base64,{data}"))
}

pub(super) fn normalize_rollout_content_type(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

pub(super) fn apply_rollout_mcp_tool_result_part_enrichments(
    thread: &mut serde_json::Map<String, Value>,
    enrichments: &HashMap<String, Vec<Value>>,
) {
    let Some(turns) = thread.get_mut("turns").and_then(Value::as_array_mut) else {
        return;
    };

    for turn in turns {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };

        for item in items {
            let Some(item_object) = item.as_object_mut() else {
                continue;
            };
            if item_object.get("type").and_then(Value::as_str) != Some("mcpToolCall") {
                continue;
            }
            let Some(item_id) = read_string(item_object.get("id")) else {
                continue;
            };
            let Some(enrichment_parts) = enrichments.get(&item_id) else {
                continue;
            };

            let result = item_object
                .entry("result".to_string())
                .or_insert_with(|| json!({}));
            let Some(result_object) = result.as_object_mut() else {
                continue;
            };

            let existing_has_content = result_object
                .get("content")
                .and_then(Value::as_array)
                .map(|content| !content.is_empty())
                .unwrap_or(false);
            if !existing_has_content {
                result_object.insert(
                    "content".to_string(),
                    Value::Array(enrichment_parts.clone()),
                );
                continue;
            }
            if thread_mcp_tool_result_has_image(Some(&Value::Object(result_object.clone()))) {
                continue;
            }

            let Some(content) = result_object
                .get_mut("content")
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            content.extend(
                enrichment_parts
                    .iter()
                    .filter(|entry| {
                        entry
                            .get("type")
                            .and_then(Value::as_str)
                            .map(normalize_rollout_content_type)
                            .is_some_and(|entry_type| {
                                matches!(entry_type.as_str(), "image" | "inputimage" | "localimage")
                            })
                    })
                    .cloned(),
            );
        }
    }
}

pub(super) fn looks_like_thread_record(object: &serde_json::Map<String, Value>) -> bool {
    object.contains_key("id")
        || object.contains_key("turns")
        || object.contains_key("updatedAt")
        || object.contains_key("createdAt")
        || object.contains_key("cwd")
}
