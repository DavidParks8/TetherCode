#[cfg(test)]
use agent_client_protocol::schema::v1::SessionNotification;
use agent_client_protocol::schema::v1::{
    ContentBlock, ContentChunk, SessionConfigKind, SessionUpdate, ToolCallContent, ToolCallStatus,
    ToolKind,
};
use agent_client_protocol::schema::MaybeUndefined;

use super::events::{
    CanonicalEvent, CommandEntry, ConfigEntry, FieldUpdate, MessageRole, PlanEntry,
};
use super::session::{AcpSession, ReceivedSessionNotification};

const MAX_MESSAGE_CHUNK_BYTES: usize = 32 * 1024;
const MAX_TOOL_TEXT_CHUNK_BYTES: usize = 64 * 1024;
const MAX_STRUCTURED_ITEMS: usize = 64;
const MAX_LOCATION_ITEMS: usize = 32;
const MAX_STRUCTURED_VALUE_BYTES: usize = 16 * 1024;
const MAX_STRUCTURED_FIELDS: usize = 64;

pub async fn handle_session_notification(
    agent_id: &str,
    session: &AcpSession,
    received: ReceivedSessionNotification,
) {
    let snapshot = session.snapshot().await;
    let thread_id = snapshot.thread_id;
    let operation = if received.reconstruction {
        None
    } else {
        received.operation
    };
    let (run_id, source_turn_id, generation) = match operation {
        Some((run_id, source_turn_id, generation)) => {
            (Some(run_id), Some(source_turn_id), Some(generation))
        }
        None => (None, None, None),
    };
    let event = match received.notification.update {
        SessionUpdate::UserMessageChunk(chunk) => {
            message_event(
                agent_id,
                &thread_id,
                session,
                MessageRole::User,
                chunk,
                (run_id, source_turn_id, generation),
            )
            .await
        }
        SessionUpdate::AgentMessageChunk(chunk) => {
            message_event(
                agent_id,
                &thread_id,
                session,
                MessageRole::Agent,
                chunk,
                (run_id, source_turn_id, generation),
            )
            .await
        }
        SessionUpdate::AgentThoughtChunk(chunk) => {
            message_event(
                agent_id,
                &thread_id,
                session,
                MessageRole::Thought,
                chunk,
                (run_id, source_turn_id, generation),
            )
            .await
        }
        SessionUpdate::ToolCall(tool) => CanonicalEvent::Tool {
            agent_id: agent_id.to_string(),
            thread_id,
            run_id,
            source_turn_id,
            generation,
            tool_call_id: tool.tool_call_id.to_string(),
            kind: tool.kind,
            status: tool.status,
            title: tool.title,
            content: FieldUpdate::Set(tool_content(&tool.content)),
            structured_content: FieldUpdate::Set(bounded_tool_values(&tool.content)),
            locations: FieldUpdate::Set(bounded_values(&tool.locations, MAX_LOCATION_ITEMS)),
        },
        SessionUpdate::ToolCallUpdate(update) => {
            let existing = snapshot.tools.get(&update.tool_call_id.to_string());
            CanonicalEvent::Tool {
                agent_id: agent_id.to_string(),
                thread_id,
                run_id,
                source_turn_id,
                tool_call_id: update.tool_call_id.to_string(),
                generation: existing.and_then(|tool| tool.generation).or(generation),
                kind: update
                    .fields
                    .kind
                    .or_else(|| existing.map(|tool| tool.kind))
                    .unwrap_or(ToolKind::Other),
                status: update
                    .fields
                    .status
                    .or_else(|| existing.map(|tool| tool.status))
                    .unwrap_or(ToolCallStatus::Pending),
                title: update
                    .fields
                    .title
                    .or_else(|| existing.map(|tool| tool.title.clone()))
                    .unwrap_or_default(),
                content: update
                    .fields
                    .content
                    .as_ref()
                    .map_or(FieldUpdate::Unchanged, |content| {
                        FieldUpdate::Append(tool_content(content))
                    }),
                structured_content: update
                    .fields
                    .content
                    .as_ref()
                    .map_or(FieldUpdate::Unchanged, |content| {
                        FieldUpdate::Append(bounded_tool_values(content))
                    }),
                locations: update
                    .fields
                    .locations
                    .as_ref()
                    .map_or(FieldUpdate::Unchanged, |locations| {
                        FieldUpdate::Append(bounded_values(locations, MAX_LOCATION_ITEMS))
                    }),
            }
        }
        SessionUpdate::Plan(plan) => CanonicalEvent::Plan {
            agent_id: agent_id.to_string(),
            thread_id,
            entries: plan
                .entries
                .into_iter()
                .map(|entry| PlanEntry {
                    content: entry.content,
                    priority: format!("{:?}", entry.priority),
                    status: format!("{:?}", entry.status),
                })
                .collect(),
        },
        SessionUpdate::AvailableCommandsUpdate(update) => CanonicalEvent::Commands {
            agent_id: agent_id.to_string(),
            thread_id,
            commands: update
                .available_commands
                .into_iter()
                .map(|command| CommandEntry {
                    name: command.name,
                    description: command.description,
                })
                .collect(),
        },
        SessionUpdate::CurrentModeUpdate(update) => CanonicalEvent::Mode {
            agent_id: agent_id.to_string(),
            thread_id,
            id: update.current_mode_id.to_string(),
        },
        SessionUpdate::ConfigOptionUpdate(update) => CanonicalEvent::Config {
            agent_id: agent_id.to_string(),
            thread_id,
            entries: update
                .config_options
                .into_iter()
                .map(|option| ConfigEntry {
                    id: option.id.to_string(),
                    value: match option.kind {
                        SessionConfigKind::Select(select) => select.current_value.to_string(),
                        SessionConfigKind::Boolean(boolean) => boolean.current_value.to_string(),
                        _ => "unknown".to_string(),
                    },
                })
                .collect(),
        },
        SessionUpdate::SessionInfoUpdate(update) => CanonicalEvent::SessionInfo {
            agent_id: agent_id.to_string(),
            thread_id,
            title: field_update(update.title),
            updated_at: field_update(update.updated_at),
        },
        SessionUpdate::UsageUpdate(update) => CanonicalEvent::Usage {
            agent_id: agent_id.to_string(),
            thread_id,
            used: update.used,
            size: update.size,
            cost: update
                .cost
                .map(|cost| format!("{} {}", cost.amount, cost.currency)),
        },
        _ => CanonicalEvent::Ignored {
            agent_id: agent_id.to_string(),
            thread_id: Some(thread_id),
            kind: "unknown_session_update".to_string(),
        },
    };
    session.emit(event).await;
}

async fn message_event(
    agent_id: &str,
    thread_id: &str,
    session: &AcpSession,
    role: MessageRole,
    chunk: ContentChunk,
    operation: (Option<String>, Option<String>, Option<u64>),
) -> CanonicalEvent {
    let (run_id, source_turn_id, generation) = operation;
    let supplied = chunk.message_id.map(|id| id.to_string());
    let message_id = session
        .message_id_for_generation(role, supplied, generation)
        .await;
    let (content, content_block) = match chunk.content {
        ContentBlock::Text(text) => {
            let truncated = text.text.len() > MAX_MESSAGE_CHUNK_BYTES;
            (
                bound_text(text.text, MAX_MESSAGE_CHUNK_BYTES),
                truncated.then(|| {
                    serde_json::json!({
                        "type": "truncation",
                        "truncated": true,
                        "maxBytes": MAX_MESSAGE_CHUNK_BYTES,
                    })
                }),
            )
        }
        content => (
            String::new(),
            serde_json::to_value(content).ok().map(bound_json),
        ),
    };
    CanonicalEvent::MessageChunk {
        agent_id: agent_id.to_string(),
        thread_id: thread_id.to_string(),
        run_id,
        source_turn_id,
        generation,
        role,
        message_id,
        content,
        content_block,
    }
}

fn tool_content(content: &[ToolCallContent]) -> String {
    let mut output = String::new();
    for text in content.iter().filter_map(|item| match item {
        ToolCallContent::Content(content) => match &content.content {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        },
        _ => None,
    }) {
        if !output.is_empty() {
            append_bounded(&mut output, "\n", MAX_TOOL_TEXT_CHUNK_BYTES);
        }
        append_bounded(&mut output, text, MAX_TOOL_TEXT_CHUNK_BYTES);
        if output.len() == MAX_TOOL_TEXT_CHUNK_BYTES {
            break;
        }
    }
    output
}

fn bounded_tool_values(content: &[ToolCallContent]) -> Vec<serde_json::Value> {
    bounded_values(content, MAX_STRUCTURED_ITEMS)
}

fn bounded_values<T: serde::Serialize>(values: &[T], max_items: usize) -> Vec<serde_json::Value> {
    values
        .iter()
        .take(max_items)
        .filter_map(|value| serde_json::to_value(value).ok())
        .map(bound_json)
        .collect()
}

fn bound_json(value: serde_json::Value) -> serde_json::Value {
    let value = redact_json(value, &mut 0);
    if serde_json::to_vec(&value).is_ok_and(|bytes| bytes.len() <= MAX_STRUCTURED_VALUE_BYTES) {
        value
    } else {
        serde_json::json!({"type":"truncated","truncated":true})
    }
}

fn redact_json(value: serde_json::Value, fields: &mut usize) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .take(MAX_STRUCTURED_FIELDS)
                .map(|value| redact_json(value, fields))
                .collect(),
        ),
        serde_json::Value::Object(values) => serde_json::Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| key != "rawInput" && key != "rawOutput" && key != "_meta")
                .filter_map(|(key, value)| {
                    if *fields >= MAX_STRUCTURED_FIELDS {
                        return None;
                    }
                    *fields += 1;
                    Some((bound_text(key, 256), redact_json(value, fields)))
                })
                .collect(),
        ),
        serde_json::Value::String(value) => {
            serde_json::Value::String(bound_text(value, MAX_STRUCTURED_VALUE_BYTES))
        }
        value => value,
    }
}

fn append_bounded(target: &mut String, value: &str, max: usize) {
    let remaining = max.saturating_sub(target.len());
    if remaining == 0 {
        return;
    }
    target.push_str(&bound_text(value.to_string(), remaining));
}

fn bound_text(mut value: String, max: usize) -> String {
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

fn field_update(value: MaybeUndefined<String>) -> FieldUpdate {
    match value {
        MaybeUndefined::Undefined => FieldUpdate::Unchanged,
        MaybeUndefined::Null => FieldUpdate::Clear,
        MaybeUndefined::Value(value) => FieldUpdate::Set(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn typed_tool_update_preserves_all_structured_variants_and_excludes_raw_fields() {
        let session = AcpSession::new("agent".into(), "thread".into());
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "tool",
            "title": "Structured",
            "kind": "edit",
            "status": "completed",
            "content": [
                {"type": "content", "content": {"type": "text", "text": "done"}},
                {"type": "content", "content": {"type": "image", "data": "aW1hZ2U=", "mimeType": "image/png"}},
                {"type": "content", "content": {"type": "audio", "data": "YXVkaW8=", "mimeType": "audio/wav"}},
                {"type": "content", "content": {"type": "resource_link", "uri": "file:///tmp/file", "name": "file"}},
                {"type": "content", "content": {"type": "resource", "resource": {"uri": "file:///tmp/file", "text": "body", "mimeType": "text/plain"}}},
                {"type": "diff", "path": "/tmp/file", "oldText": "old", "newText": "new"},
                {"type": "terminal", "terminalId": "terminal-1"}
            ],
            "locations": [{"path": "/tmp/file", "line": 7}],
            "rawInput": {"secret": "must-not-appear"},
            "rawOutput": {"secret": "must-not-appear"}
        }))
        .expect("typed tool update");
        handle_session_notification(
            "agent",
            &session,
            SessionNotification::new("session", update).into(),
        )
        .await;
        let snapshot = session.snapshot().await;
        let tool = &snapshot.tools["tool"];
        assert_eq!(tool.content, "done");
        assert_eq!(tool.structured_content.len(), 7);
        assert_eq!(tool.structured_content[1]["content"]["type"], "image");
        assert_eq!(tool.structured_content[2]["content"]["type"], "audio");
        assert_eq!(
            tool.structured_content[3]["content"]["type"],
            "resource_link"
        );
        assert_eq!(tool.structured_content[4]["content"]["type"], "resource");
        assert_eq!(tool.structured_content[5]["type"], "diff");
        assert_eq!(tool.structured_content[6]["type"], "terminal");
        assert_eq!(tool.locations[0]["line"], 7);
        let serialized = serde_json::to_string(tool).unwrap();
        assert!(!serialized.contains("must-not-appear"));
        assert!(!serialized.contains("rawInput"));
        assert!(!serialized.contains("rawOutput"));
    }

    #[tokio::test]
    async fn non_text_message_blocks_are_preserved_without_placeholders_or_raw_secrets() {
        let session = AcpSession::new("agent".into(), "thread".into());
        let blocks = [
            serde_json::json!({"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}),
            serde_json::json!({"type":"audio","data":"YXVkaW8=","mimeType":"audio/wav"}),
            serde_json::json!({"type":"resource_link","uri":"file:///tmp/file","name":"file","mimeType":"text/plain"}),
            serde_json::json!({"type":"resource","resource":{"uri":"file:///tmp/file","text":"body","mimeType":"text/plain","rawInput":{"secret":"hidden"}}}),
        ];
        for (index, block) in blocks.into_iter().enumerate() {
            let update: SessionUpdate = serde_json::from_value(serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "messageId": format!("message-{index}"),
                "content": block,
            }))
            .expect("typed message update");
            handle_session_notification(
                "agent",
                &session,
                SessionNotification::new("session", update).into(),
            )
            .await;
        }
        let snapshot = session.snapshot().await;
        assert_eq!(snapshot.messages.len(), 4);
        let serialized = serde_json::to_string(&snapshot.messages).unwrap();
        for content_type in ["image", "audio", "resource_link", "resource"] {
            assert!(serialized.contains(content_type));
        }
        assert!(!serialized.contains("non-text content omitted"));
        assert!(!serialized.contains("hidden"));
        assert!(!serialized.contains("rawInput"));
    }

    #[tokio::test]
    async fn oversized_single_text_chunk_is_utf8_bounded_and_marked_truncated() {
        let session = AcpSession::new("agent".into(), "thread".into());
        let update: SessionUpdate = serde_json::from_value(serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": "oversized",
            "content": {"type":"text","text":"é".repeat(MAX_MESSAGE_CHUNK_BYTES)}
        }))
        .expect("typed message update");
        handle_session_notification(
            "agent",
            &session,
            SessionNotification::new("session", update).into(),
        )
        .await;
        let snapshot = session.snapshot().await;
        let message = &snapshot.messages[0];
        assert!(message.truncated);
        assert!(message.parts[0]["text"].as_str().unwrap().len() <= MAX_MESSAGE_CHUNK_BYTES);
        assert_eq!(message.parts[1]["truncated"], true);
    }

    #[test]
    fn structured_value_sanitizer_is_lossless_and_filters_every_excluded_key() {
        let values = vec![serde_json::Value::Object(
            (0..64)
                .map(|index| {
                    (
                        format!("key-{index}"),
                        serde_json::json!("x".repeat(40_000)),
                    )
                })
                .collect(),
        )];
        let bounded = bounded_values(&values, MAX_STRUCTURED_ITEMS);
        assert_eq!(bounded.len(), 1);
        assert_eq!(bounded[0]["truncated"], true);

        let filtered = bound_json(serde_json::json!({
            "rawInput": "secret",
            "rawOutput": "secret",
            "_meta": "secret",
            "kept": "value"
        }));
        assert_eq!(filtered, serde_json::json!({"kept": "value"}));

        let capped = bounded_values(&(0..70).collect::<Vec<_>>(), MAX_STRUCTURED_ITEMS);
        assert_eq!(capped.len(), MAX_STRUCTURED_ITEMS);
    }
}
