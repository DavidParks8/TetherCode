use crate::acp::events::{CanonicalEvent, FieldUpdate, MessageRole};
use crate::agui_generated::{AgUiEvent, AgUiEventContent, AgUiEventRole, AgUiEventType, Delta};
use crate::*;
use sha2::{Digest, Sha256};

pub(super) const AG_UI_EVENT_METHOD: &str = "bridge/agui.event";
const CLOSED_THREAD_CAPACITY: usize = 2048;
const MESSAGE_CHUNK_BYTES: usize = 32 * 1024;
const TOOL_RESULT_CHUNK_BYTES: usize = 16 * 1024;
const STRUCTURED_CHUNK_BYTES: usize = 16 * 1024;
const MAX_MESSAGE_TOTAL_BYTES: usize = 32 * 1024;
const MAX_TOOL_TOTAL_BYTES: usize = 64 * 1024;
const MAX_STRUCTURED_TOOL_BYTES: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgUiEventEnvelope {
    pub(super) thread_id: String,
    pub(super) run_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source_turn_id: Option<String>,
    pub(super) event: AgUiEvent,
}

#[derive(Debug)]
struct AgUiRunState {
    run_id: String,
    source_turn_id: Option<String>,
    open_user_id: Option<String>,
    open_message_id: Option<String>,
    open_reasoning_id: Option<String>,
    message_bytes: HashMap<String, usize>,
    truncated_messages: HashSet<String>,
    tools: HashMap<String, AgUiToolState>,
}

#[derive(Debug, Default)]
struct AgUiToolState {
    started: bool,
    ended: bool,
    result_content: String,
    result_revision: Option<String>,
    structured_revision: Option<String>,
    structured_content: Vec<Value>,
    locations: Vec<Value>,
    structured_truncated: bool,
}

#[derive(Debug, Default)]
pub(super) struct AgUiProjector {
    runs: HashMap<String, AgUiRunState>,
    closed_threads: HashSet<String>,
}

#[derive(Debug, Default)]
pub(super) struct CanonicalProjection {
    pub(super) events: Vec<AgUiEventEnvelope>,
    pub(super) controls: Vec<(&'static str, Value)>,
}

impl AgUiProjector {
    pub(super) fn project_canonical(&mut self, canonical: &CanonicalEvent) -> CanonicalProjection {
        let timestamp = Utc::now().timestamp_millis();
        let mut projection = CanonicalProjection::default();
        match canonical {
            CanonicalEvent::RunStarted {
                thread_id,
                run_id,
                source_turn_id,
                ..
            } => {
                self.closed_threads.remove(thread_id);
                if let Some(previous) = self.runs.remove(thread_id) {
                    close_run(thread_id, previous, timestamp, &mut projection.events, true);
                }
                self.runs.insert(
                    thread_id.clone(),
                    AgUiRunState {
                        run_id: run_id.clone(),
                        source_turn_id: Some(source_turn_id.clone()),
                        open_user_id: None,
                        open_message_id: None,
                        open_reasoning_id: None,
                        message_bytes: HashMap::new(),
                        truncated_messages: HashSet::new(),
                        tools: HashMap::new(),
                    },
                );
                projection.events.push(envelope(
                    thread_id,
                    run_id,
                    Some(source_turn_id.clone()),
                    run_event(
                        AgUiEventType::RunStarted,
                        thread_id.clone(),
                        run_id.clone(),
                        timestamp,
                    ),
                ));
            }
            CanonicalEvent::MessageChunk {
                thread_id,
                run_id,
                source_turn_id,
                role,
                message_id,
                content,
                content_block,
                ..
            } if !content.is_empty() || content_block.is_some() => {
                let Some(run) = canonical_run_mut(
                    &mut self.runs,
                    thread_id,
                    run_id.as_deref(),
                    source_turn_id.as_deref(),
                ) else {
                    return projection;
                };
                let (content, newly_truncated) = bounded_live_content(
                    &mut run.message_bytes,
                    &mut run.truncated_messages,
                    message_id,
                    content,
                    MAX_MESSAGE_TOTAL_BYTES,
                );
                let block_truncated = content_block.as_ref().is_some_and(|block| {
                    block
                        .get("truncated")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                });
                if let Some(content_block) = content_block {
                    push_structured_chunks(
                        &mut projection.events,
                        thread_id,
                        run,
                        "tethercode.dev/message-content",
                        message_id,
                        json!({
                            "messageId": message_id,
                            "role": format!("{role:?}").to_ascii_lowercase(),
                            "content": content_block,
                        }),
                        timestamp,
                    );
                }
                if newly_truncated
                    || (block_truncated && run.truncated_messages.insert(message_id.clone()))
                {
                    push_transcript_truncation(
                        &mut projection.events,
                        thread_id,
                        run,
                        message_id,
                        MAX_MESSAGE_TOTAL_BYTES,
                        timestamp,
                    );
                }
                match role {
                    MessageRole::Agent => {
                        if let Some(user_id) = run.open_user_id.take() {
                            push_text_message_end(
                                &mut projection.events,
                                thread_id,
                                run,
                                user_id,
                                timestamp,
                            );
                        }
                        if run.open_message_id.as_deref() != Some(message_id) {
                            if let Some(previous) = run.open_message_id.replace(message_id.clone())
                            {
                                projection.events.push(envelope(
                                    thread_id,
                                    &run.run_id,
                                    run.source_turn_id.clone(),
                                    message_event(
                                        AgUiEventType::TextMessageEnd,
                                        previous,
                                        None,
                                        None,
                                        timestamp,
                                    ),
                                ));
                            }
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                message_event(
                                    AgUiEventType::TextMessageStart,
                                    message_id.clone(),
                                    Some(AgUiEventRole::Assistant),
                                    None,
                                    timestamp,
                                ),
                            ));
                        }
                        if !content.is_empty() {
                            push_message_chunks(
                                &mut projection.events,
                                thread_id,
                                run,
                                false,
                                message_id,
                                &content,
                                timestamp,
                            );
                        }
                    }
                    MessageRole::Thought => {
                        if run.open_reasoning_id.as_deref() != Some(message_id) {
                            if let Some(previous) =
                                run.open_reasoning_id.replace(message_id.clone())
                            {
                                projection.events.push(envelope(
                                    thread_id,
                                    &run.run_id,
                                    run.source_turn_id.clone(),
                                    message_event(
                                        AgUiEventType::ReasoningMessageEnd,
                                        previous,
                                        None,
                                        None,
                                        timestamp,
                                    ),
                                ));
                            }
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                message_event(
                                    AgUiEventType::ReasoningMessageStart,
                                    message_id.clone(),
                                    Some(AgUiEventRole::Reasoning),
                                    None,
                                    timestamp,
                                ),
                            ));
                        }
                        if !content.is_empty() {
                            push_message_chunks(
                                &mut projection.events,
                                thread_id,
                                run,
                                true,
                                message_id,
                                &content,
                                timestamp,
                            );
                        }
                    }
                    MessageRole::User => {
                        if run.open_user_id.as_deref() != Some(message_id) {
                            if let Some(previous) = run.open_user_id.replace(message_id.clone()) {
                                push_text_message_end(
                                    &mut projection.events,
                                    thread_id,
                                    run,
                                    previous,
                                    timestamp,
                                );
                            }
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                message_event(
                                    AgUiEventType::TextMessageStart,
                                    message_id.clone(),
                                    Some(AgUiEventRole::User),
                                    None,
                                    timestamp,
                                ),
                            ));
                        }
                        if !content.is_empty() {
                            push_message_chunks(
                                &mut projection.events,
                                thread_id,
                                run,
                                false,
                                message_id,
                                &content,
                                timestamp,
                            );
                        }
                    }
                }
            }
            CanonicalEvent::Tool {
                thread_id,
                run_id,
                source_turn_id,
                tool_call_id,
                kind,
                status,
                title,
                content,
                structured_content,
                locations,
                ..
            } => {
                let Some(run) = canonical_run_mut(
                    &mut self.runs,
                    thread_id,
                    run_id.as_deref(),
                    source_turn_id.as_deref(),
                ) else {
                    return projection;
                };
                let state = run.tools.entry(tool_call_id.clone()).or_default();
                let terminal = matches!(
                    status,
                    agent_client_protocol::schema::v1::ToolCallStatus::Completed
                        | agent_client_protocol::schema::v1::ToolCallStatus::Failed
                );
                if !state.started {
                    state.started = true;
                    projection.events.push(envelope(
                        thread_id,
                        &run.run_id,
                        run.source_turn_id.clone(),
                        AgUiEvent {
                            tool_call_name: Some(bounded(
                                if title.trim().is_empty() {
                                    format!("{kind:?}").to_ascii_lowercase()
                                } else {
                                    title.clone()
                                },
                                256,
                            )),
                            ..tool_event(
                                AgUiEventType::ToolCallStart,
                                tool_call_id.clone(),
                                timestamp,
                            )
                        },
                    ));
                    projection.events.push(envelope(
                        thread_id,
                        &run.run_id,
                        run.source_turn_id.clone(),
                        AgUiEvent {
                            delta: Some(Delta::String("{}".to_string())),
                            ..tool_event(
                                AgUiEventType::ToolCallArgs,
                                tool_call_id.clone(),
                                timestamp,
                            )
                        },
                    ));
                }
                if terminal && !state.ended {
                    state.ended = true;
                    projection.events.push(envelope(
                        thread_id,
                        &run.run_id,
                        run.source_turn_id.clone(),
                        tool_event(AgUiEventType::ToolCallEnd, tool_call_id.clone(), timestamp),
                    ));
                }
                let content = match content {
                    FieldUpdate::Set(content) => {
                        Some(bounded(content.clone(), MAX_TOOL_TOTAL_BYTES))
                    }
                    FieldUpdate::Clear => Some(String::new()),
                    FieldUpdate::Append(content) => Some(bounded(
                        format!("{}{content}", state.result_content),
                        MAX_TOOL_TOTAL_BYTES,
                    )),
                    FieldUpdate::Unchanged => None,
                };
                let result_revision = content
                    .as_ref()
                    .map(|content| format!("sha256:{:x}", Sha256::digest(content.as_bytes())));
                let changed_result = match content.as_deref() {
                    None => false,
                    Some("") if state.result_revision.is_none() => false,
                    Some(_) => result_revision.as_deref() != state.result_revision.as_deref(),
                };
                let previous_content = if changed_result {
                    let previous_content = state.result_content.clone();
                    state.result_content = content.clone().unwrap_or_default();
                    state.result_revision = result_revision.clone();
                    Some(previous_content)
                } else {
                    None
                };
                let changed_structured_state = apply_structured_updates(
                    &mut state.structured_content,
                    structured_content,
                    &mut state.locations,
                    locations,
                    MAX_STRUCTURED_TOOL_BYTES,
                    &mut state.structured_truncated,
                );
                let structured_value = json!({
                    "toolCallId": tool_call_id,
                    "content": state.structured_content,
                    "locations": state.locations,
                    "retrieval": {
                        "available": !state.structured_truncated,
                    },
                });
                let structured_revision = format!(
                    "sha256:{:x}",
                    Sha256::digest(serde_json::to_vec(&structured_value).unwrap_or_default())
                );
                let changed_structured = changed_structured_state
                    && state.structured_revision.as_deref() != Some(&structured_revision);
                if changed_structured {
                    state.structured_revision = Some(structured_revision.clone());
                }
                let structured_content = state.structured_content.clone();
                let structured_locations = state.locations.clone();
                let structured_available = !state.structured_truncated;
                if let Some(previous_content) = previous_content {
                    let content = content.clone().unwrap_or_default();
                    if terminal && content.starts_with(&previous_content) && !content.is_empty() {
                        let suffix = &content[previous_content.len()..];
                        for chunk in utf8_chunks(suffix, TOOL_RESULT_CHUNK_BYTES) {
                            projection.events.push(envelope(
                                thread_id,
                                &run.run_id,
                                run.source_turn_id.clone(),
                                AgUiEvent {
                                    message_id: Some(format!(
                                        "{}::tool-result::{tool_call_id}",
                                        run.run_id
                                    )),
                                    role: Some(AgUiEventRole::Tool),
                                    content: Some(AgUiEventContent::String(chunk.to_string())),
                                    ..tool_event(
                                        AgUiEventType::ToolCallResult,
                                        tool_call_id.clone(),
                                        timestamp,
                                    )
                                },
                            ));
                        }
                    } else {
                        push_structured_chunks(
                            &mut projection.events,
                            thread_id,
                            run,
                            "tethercode.dev/tool-text",
                            tool_call_id,
                            json!({
                                "toolCallId": tool_call_id,
                                "revision": result_revision,
                                "content": content,
                            }),
                            timestamp,
                        );
                    }
                }
                if changed_structured {
                    push_structured_chunks(
                        &mut projection.events,
                        thread_id,
                        run,
                        "tethercode.dev/tool-content",
                        tool_call_id,
                        json!({
                            "toolCallId": tool_call_id,
                            "content": structured_content,
                            "locations": structured_locations,
                            "revision": structured_revision,
                            "retrieval": {
                                "available": structured_available,
                            },
                        }),
                        timestamp,
                    );
                }
            }
            CanonicalEvent::RunFinished {
                thread_id, run_id, ..
            }
            | CanonicalEvent::RunFailed {
                thread_id, run_id, ..
            } => {
                let std::collections::hash_map::Entry::Occupied(entry) =
                    self.runs.entry(thread_id.clone())
                else {
                    return projection;
                };
                if entry.get().run_id != *run_id {
                    return projection;
                }
                let run = entry.remove();
                close_run(thread_id, run, timestamp, &mut projection.events, false);
                let source_turn_id = canonical_source_turn_id(canonical).map(str::to_string);
                projection.events.push(envelope(
                    thread_id,
                    run_id,
                    source_turn_id,
                    if let CanonicalEvent::RunFailed { message, .. } = canonical {
                        AgUiEvent {
                            message: Some(bounded(message, 2 * 1024)),
                            code: Some("acp_run_failed".to_string()),
                            ..generated_event(AgUiEventType::RunError, timestamp)
                        }
                    } else {
                        run_event(
                            AgUiEventType::RunFinished,
                            thread_id.clone(),
                            run_id.clone(),
                            timestamp,
                        )
                    },
                ));
                self.mark_thread_closed(thread_id);
            }
            CanonicalEvent::PermissionRequested { approval } => {
                projection.controls.push((
                    "bridge/approval.requested",
                    serde_json::to_value(approval).expect("pending approval serializes"),
                ));
            }
            CanonicalEvent::PermissionResolved {
                thread_id,
                request_id,
                outcome,
                ..
            } => {
                projection.controls.push((
                    "bridge/approval.resolved",
                    json!({
                        "id": request_id, "threadId": thread_id, "outcome": bounded(outcome, 256)
                    }),
                ));
            }
            CanonicalEvent::ElicitationRequested { request } => {
                projection.controls.push((
                    "bridge/userInput.requested",
                    serde_json::to_value(request).expect("pending user input serializes"),
                ));
            }
            CanonicalEvent::ElicitationResolved {
                thread_id,
                request_id,
                action,
                ..
            } => {
                projection.controls.push((
                    "bridge/userInput.resolved",
                    json!({
                        "id": request_id, "threadId": thread_id, "action": bounded(action, 256)
                    }),
                ));
            }
            CanonicalEvent::Plan {
                thread_id, entries, ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "tethercode.dev/plan",
                json!({ "entries": entries.iter().take(128).map(|entry| json!({
                    "content": bounded(&entry.content, 2 * 1024),
                    "priority": bounded(&entry.priority, 256),
                    "status": bounded(&entry.status, 256)
                })).collect::<Vec<_>>() }),
                timestamp,
            ),
            CanonicalEvent::Usage {
                thread_id,
                used,
                size,
                cost,
                ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "tethercode.dev/usage",
                json!({ "used": used, "size": size, "cost": cost.as_deref().map(|value| bounded(value, 256)) }),
                timestamp,
            ),
            CanonicalEvent::Mode { thread_id, id, .. } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "tethercode.dev/mode",
                json!({ "id": bounded(id, 256) }),
                timestamp,
            ),
            CanonicalEvent::Config {
                thread_id, entries, ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "tethercode.dev/config",
                json!({ "entries": entries.iter().take(128).map(|entry| json!({
                    "id": bounded(&entry.id, 256),
                    "value": bounded(&entry.value, 2 * 1024)
                })).collect::<Vec<_>>() }),
                timestamp,
            ),
            CanonicalEvent::SessionInfo {
                thread_id,
                title,
                updated_at,
                ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "tethercode.dev/session-info",
                json!({ "title": field_value(title), "updatedAt": field_value(updated_at) }),
                timestamp,
            ),
            CanonicalEvent::Commands {
                thread_id,
                commands,
                ..
            } => push_custom(
                &mut projection.events,
                &self.runs,
                thread_id,
                "tethercode.dev/commands",
                json!({ "commands": commands.iter().take(128).map(|command| json!({
                    "name": bounded(&command.name, 256),
                    "description": bounded(&command.description, 2 * 1024)
                })).collect::<Vec<_>>() }),
                timestamp,
            ),
            CanonicalEvent::Ignored { .. } | CanonicalEvent::MessageChunk { .. } => {}
        }
        projection
    }

    fn mark_thread_closed(&mut self, thread_id: &str) {
        if !self.closed_threads.contains(thread_id)
            && self.closed_threads.len() >= CLOSED_THREAD_CAPACITY
        {
            if let Some(oldest) = self.closed_threads.iter().next().cloned() {
                self.closed_threads.remove(&oldest);
            }
        }
        self.closed_threads.insert(thread_id.to_string());
    }
}

fn generated_event(ag_ui_event_type: AgUiEventType, timestamp: i64) -> AgUiEvent {
    AgUiEvent {
        message_id: None,
        name: None,
        raw_event: None,
        role: None,
        timestamp: Some(timestamp as f64),
        ag_ui_event_type,
        delta: None,
        title: None,
        parent_message_id: None,
        tool_call_id: None,
        tool_call_name: None,
        content: None,
        snapshot: None,
        messages: None,
        activity_type: None,
        replace: None,
        patch: None,
        event: None,
        source: None,
        value: None,
        input: None,
        parent_run_id: None,
        run_id: None,
        thread_id: None,
        outcome: None,
        result: None,
        code: None,
        message: None,
        step_name: None,
        encrypted_value: None,
        entity_id: None,
        subtype: None,
    }
}

fn run_event(
    event_type: AgUiEventType,
    thread_id: String,
    run_id: String,
    timestamp: i64,
) -> AgUiEvent {
    AgUiEvent {
        thread_id: Some(thread_id),
        run_id: Some(run_id),
        ..generated_event(event_type, timestamp)
    }
}

fn message_event(
    event_type: AgUiEventType,
    message_id: String,
    role: Option<AgUiEventRole>,
    delta: Option<String>,
    timestamp: i64,
) -> AgUiEvent {
    AgUiEvent {
        message_id: Some(message_id),
        role,
        delta: delta.map(Delta::String),
        ..generated_event(event_type, timestamp)
    }
}

fn tool_event(event_type: AgUiEventType, tool_call_id: String, timestamp: i64) -> AgUiEvent {
    AgUiEvent {
        tool_call_id: Some(tool_call_id),
        ..generated_event(event_type, timestamp)
    }
}

fn custom_event(name: String, value: Value, timestamp: i64) -> AgUiEvent {
    AgUiEvent {
        name: Some(name),
        value: Some(value),
        ..generated_event(AgUiEventType::Custom, timestamp)
    }
}

fn envelope(
    thread_id: &str,
    run_id: &str,
    source_turn_id: Option<String>,
    event: AgUiEvent,
) -> AgUiEventEnvelope {
    AgUiEventEnvelope {
        thread_id: thread_id.to_string(),
        run_id: run_id.to_string(),
        source_turn_id,
        event,
    }
}

fn canonical_run_mut<'a>(
    runs: &'a mut HashMap<String, AgUiRunState>,
    thread_id: &str,
    run_id: Option<&str>,
    source_turn_id: Option<&str>,
) -> Option<&'a mut AgUiRunState> {
    let run = runs.get_mut(thread_id)?;
    if run_id.is_some_and(|value| value != run.run_id)
        || source_turn_id.is_some()
            && run.source_turn_id.as_deref().is_some()
            && source_turn_id != run.source_turn_id.as_deref()
    {
        return None;
    }
    Some(run)
}

fn close_run(
    thread_id: &str,
    mut run: AgUiRunState,
    timestamp: i64,
    events: &mut Vec<AgUiEventEnvelope>,
    superseded: bool,
) {
    if let Some(message_id) = run.open_user_id.take() {
        push_text_message_end(events, thread_id, &run, message_id, timestamp);
    }
    if let Some(message_id) = run.open_message_id.take() {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            message_event(
                AgUiEventType::TextMessageEnd,
                message_id,
                None,
                None,
                timestamp,
            ),
        ));
    }
    if let Some(message_id) = run.open_reasoning_id.take() {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            message_event(
                AgUiEventType::ReasoningMessageEnd,
                message_id,
                None,
                None,
                timestamp,
            ),
        ));
    }
    for (tool_call_id, tool) in run.tools {
        if !tool.ended {
            events.push(envelope(
                thread_id,
                &run.run_id,
                run.source_turn_id.clone(),
                tool_event(AgUiEventType::ToolCallEnd, tool_call_id, timestamp),
            ));
        }
    }
    if superseded {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id,
            AgUiEvent {
                message: Some("Agent run superseded by a new run".to_string()),
                code: Some("superseded".to_string()),
                ..generated_event(AgUiEventType::RunError, timestamp)
            },
        ));
    }
}

fn push_text_message_end(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    message_id: String,
    timestamp: i64,
) {
    events.push(envelope(
        thread_id,
        &run.run_id,
        run.source_turn_id.clone(),
        message_event(
            AgUiEventType::TextMessageEnd,
            message_id,
            None,
            None,
            timestamp,
        ),
    ));
}

fn bounded_live_content(
    totals: &mut HashMap<String, usize>,
    truncated: &mut HashSet<String>,
    id: &str,
    content: &str,
    max: usize,
) -> (String, bool) {
    let used = totals.entry(id.to_string()).or_default();
    let remaining = max.saturating_sub(*used);
    let bounded = bounded(content, remaining);
    *used = used.saturating_add(bounded.len());
    let was_truncated = bounded.len() < content.len();
    let newly_truncated = was_truncated && truncated.insert(id.to_string());
    (bounded, newly_truncated)
}

fn push_transcript_truncation(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    canonical_id: &str,
    max_bytes: usize,
    timestamp: i64,
) {
    events.push(envelope(
        thread_id,
        &run.run_id,
        run.source_turn_id.clone(),
        custom_event(
            "tethercode.dev/transcript-truncated".to_string(),
            json!({
                "canonicalId": canonical_id,
                "truncated": true,
                "maxBytes": max_bytes,
                "retrieval": {
                    "available": false,
                }
            }),
            timestamp,
        ),
    ));
}

fn push_message_chunks(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    reasoning: bool,
    message_id: &str,
    content: &str,
    timestamp: i64,
) {
    for chunk in utf8_chunks(content, MESSAGE_CHUNK_BYTES) {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            message_event(
                if reasoning {
                    AgUiEventType::ReasoningMessageContent
                } else {
                    AgUiEventType::TextMessageContent
                },
                message_id.to_string(),
                None,
                Some(chunk.to_string()),
                timestamp,
            ),
        ));
    }
}

fn utf8_chunks(value: &str, max_bytes: usize) -> impl Iterator<Item = &str> {
    let mut remaining = value;
    std::iter::from_fn(move || {
        if remaining.is_empty() {
            return None;
        }
        let mut end = remaining.len().min(max_bytes.max(1));
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        let (chunk, rest) = remaining.split_at(end);
        remaining = rest;
        Some(chunk)
    })
}

fn push_structured_chunks(
    events: &mut Vec<AgUiEventEnvelope>,
    thread_id: &str,
    run: &AgUiRunState,
    name: &str,
    canonical_id: &str,
    value: Value,
    timestamp: i64,
) {
    let serialized = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
    if serialized.len() <= STRUCTURED_CHUNK_BYTES {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            custom_event(name.to_string(), value, timestamp),
        ));
        return;
    }
    let revision = format!("sha256:{:x}", Sha256::digest(serialized.as_bytes()));
    let chunks = utf8_chunks(&serialized, STRUCTURED_CHUNK_BYTES).collect::<Vec<_>>();
    for (index, data) in chunks.iter().enumerate() {
        events.push(envelope(
            thread_id,
            &run.run_id,
            run.source_turn_id.clone(),
            custom_event(
                format!("{name}-chunk"),
                json!({
                    "canonicalId": canonical_id,
                    "revision": revision,
                    "index": index,
                    "count": chunks.len(),
                    "data": data,
                    "retrieval": {
                        "available": false,
                    }
                }),
                timestamp,
            ),
        ));
    }
}

fn apply_structured_updates(
    content: &mut Vec<Value>,
    content_update: &FieldUpdate<Vec<Value>>,
    locations: &mut Vec<Value>,
    locations_update: &FieldUpdate<Vec<Value>>,
    max_bytes: usize,
    truncated: &mut bool,
) -> bool {
    let previous = (content.clone(), locations.clone());
    let previous_truncated = *truncated;
    let reset_truncation = matches!(content_update, FieldUpdate::Set(_) | FieldUpdate::Clear)
        || matches!(locations_update, FieldUpdate::Set(_) | FieldUpdate::Clear);
    apply_structured_field(content, content_update);
    apply_structured_field(locations, locations_update);
    if reset_truncation {
        *truncated = false;
    }
    while serde_json::to_vec(&(content.as_slice(), locations.as_slice()))
        .expect("structured tool state is JSON serializable")
        .len()
        > max_bytes
    {
        if locations.is_empty() {
            content.pop();
        } else {
            locations.pop();
        }
        *truncated = true;
    }
    previous.0 != *content || previous.1 != *locations || previous_truncated != *truncated
}

fn apply_structured_field(current: &mut Vec<Value>, update: &FieldUpdate<Vec<Value>>) {
    match update {
        FieldUpdate::Set(value) => *current = value.clone(),
        FieldUpdate::Append(value) => current.extend(value.iter().cloned()),
        FieldUpdate::Clear => current.clear(),
        FieldUpdate::Unchanged => {}
    }
}

fn push_custom(
    events: &mut Vec<AgUiEventEnvelope>,
    runs: &HashMap<String, AgUiRunState>,
    thread_id: &str,
    name: &str,
    value: Value,
    timestamp: i64,
) {
    let (run_id, source_turn_id) = runs.get(thread_id).map_or_else(
        || (format!("{thread_id}::session"), None),
        |run| (run.run_id.clone(), run.source_turn_id.clone()),
    );
    events.push(envelope(
        thread_id,
        &run_id,
        source_turn_id,
        custom_event(name.to_string(), value, timestamp),
    ));
}

fn canonical_source_turn_id(event: &CanonicalEvent) -> Option<&str> {
    match event {
        CanonicalEvent::RunStarted { source_turn_id, .. }
        | CanonicalEvent::RunFinished { source_turn_id, .. }
        | CanonicalEvent::RunFailed { source_turn_id, .. } => Some(source_turn_id),
        CanonicalEvent::MessageChunk { source_turn_id, .. }
        | CanonicalEvent::Tool { source_turn_id, .. } => source_turn_id.as_deref(),
        _ => None,
    }
}

fn field_value(update: &FieldUpdate) -> Value {
    match update {
        FieldUpdate::Unchanged => Value::Null,
        FieldUpdate::Clear => Value::Null,
        FieldUpdate::Set(value) => Value::String(bounded(value, 2 * 1024)),
        FieldUpdate::Append(value) => Value::String(bounded(value, 2 * 1024)),
    }
}

fn bounded(value: impl AsRef<str>, max_bytes: usize) -> String {
    let mut value = value.as_ref().to_string();
    if value.len() > max_bytes {
        let mut end = max_bytes;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::snapshot::SessionSnapshot;
    use agent_client_protocol::schema::v1::{StopReason, ToolCallStatus, ToolKind};

    fn event_types(events: &[AgUiEventEnvelope]) -> Vec<&'static str> {
        events
            .iter()
            .map(|event| match event.event.ag_ui_event_type {
                AgUiEventType::RunStarted => "RUN_STARTED",
                AgUiEventType::RunFinished => "RUN_FINISHED",
                AgUiEventType::RunError => "RUN_ERROR",
                AgUiEventType::TextMessageStart => "TEXT_MESSAGE_START",
                AgUiEventType::TextMessageContent => "TEXT_MESSAGE_CONTENT",
                AgUiEventType::TextMessageEnd => "TEXT_MESSAGE_END",
                AgUiEventType::ReasoningMessageStart => "REASONING_MESSAGE_START",
                AgUiEventType::ReasoningMessageContent => "REASONING_MESSAGE_CONTENT",
                AgUiEventType::ReasoningMessageEnd => "REASONING_MESSAGE_END",
                AgUiEventType::ToolCallStart => "TOOL_CALL_START",
                AgUiEventType::ToolCallArgs => "TOOL_CALL_ARGS",
                AgUiEventType::ToolCallEnd => "TOOL_CALL_END",
                AgUiEventType::ToolCallResult => "TOOL_CALL_RESULT",
                AgUiEventType::Custom => "CUSTOM",
                _ => "OTHER",
            })
            .collect()
    }

    #[test]
    fn bounds_closed_threads() {
        let mut projector = AgUiProjector::default();
        projector.mark_thread_closed("closed-0");
        projector.mark_thread_closed("closed-0");
        for index in 0..=CLOSED_THREAD_CAPACITY {
            projector.mark_thread_closed(&format!("closed-{index}"));
        }
        projector.mark_thread_closed("closed-1");
        assert_eq!(projector.closed_threads.len(), CLOSED_THREAD_CAPACITY);
    }

    fn canonical_run_started() -> CanonicalEvent {
        CanonicalEvent::RunStarted {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: "run-1".to_string(),
            source_turn_id: "turn-1".to_string(),
            generation: 1,
        }
    }

    fn canonical_message(role: MessageRole, message_id: &str, content: &str) -> CanonicalEvent {
        CanonicalEvent::MessageChunk {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            role,
            message_id: message_id.to_string(),
            content: content.to_string(),
            content_block: None,
        }
    }

    #[test]
    fn canonical_projection_orders_multiple_text_and_reasoning_messages() {
        let mut projector = AgUiProjector::default();
        assert_eq!(
            event_types(&projector.project_canonical(&canonical_run_started()).events),
            ["RUN_STARTED"]
        );
        let first =
            projector.project_canonical(&canonical_message(MessageRole::Agent, "one", "same"));
        assert_eq!(
            event_types(&first.events),
            ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]
        );
        let repeated =
            projector.project_canonical(&canonical_message(MessageRole::Agent, "one", "same"));
        assert_eq!(event_types(&repeated.events), ["TEXT_MESSAGE_CONTENT"]);
        let second =
            projector.project_canonical(&canonical_message(MessageRole::Agent, "two", "next"));
        assert_eq!(
            event_types(&second.events),
            [
                "TEXT_MESSAGE_END",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT"
            ]
        );
        let thought =
            projector.project_canonical(&canonical_message(MessageRole::Thought, "thought", "why"));
        assert_eq!(
            event_types(&thought.events),
            ["REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"]
        );
        let serialized = serde_json::to_value(&thought.events[0]).unwrap();
        assert_eq!(serialized["event"]["role"], "reasoning");
    }

    #[test]
    fn canonical_tool_lifecycle_is_exactly_once_and_terminal_closes_everything() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        projector.project_canonical(&canonical_message(MessageRole::Agent, "answer", "partial"));
        projector.project_canonical(&canonical_message(MessageRole::Thought, "thought", "work"));
        let tool = |tool_call_id: &str, status, content: &str| CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: tool_call_id.to_string(),
            kind: ToolKind::Read,
            status,
            title: "Read file".to_string(),
            content: FieldUpdate::Set(content.to_string()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        };
        let started = projector.project_canonical(&tool("tool-1", ToolCallStatus::InProgress, ""));
        assert_eq!(
            event_types(&started.events),
            ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
        );
        assert!(projector
            .project_canonical(&tool("tool-1", ToolCallStatus::InProgress, ""))
            .events
            .is_empty());
        let completed =
            projector.project_canonical(&tool("tool-1", ToolCallStatus::Completed, "done"));
        assert_eq!(
            event_types(&completed.events),
            ["TOOL_CALL_END", "TOOL_CALL_RESULT"]
        );
        assert!(projector
            .project_canonical(&tool("tool-1", ToolCallStatus::Completed, "done"))
            .events
            .is_empty());
        assert_eq!(
            event_types(
                &projector
                    .project_canonical(&tool("tool-open", ToolCallStatus::InProgress, ""))
                    .events
            ),
            ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
        );

        let terminal = projector.project_canonical(&CanonicalEvent::RunFinished {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: "run-1".to_string(),
            source_turn_id: "turn-1".to_string(),
            generation: 1,
            stop_reason: StopReason::EndTurn,
        });
        assert_eq!(
            event_types(&terminal.events),
            [
                "TEXT_MESSAGE_END",
                "REASONING_MESSAGE_END",
                "TOOL_CALL_END",
                "RUN_FINISHED"
            ]
        );
    }

    #[test]
    fn canonical_metadata_and_interactions_use_custom_and_control_planes() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let thread_id = "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string();
        let metadata = [
            CanonicalEvent::Plan {
                agent_id: "alpha-agent".into(),
                thread_id: thread_id.clone(),
                entries: vec![crate::acp::events::PlanEntry {
                    content: "Inspect".into(),
                    priority: "high".into(),
                    status: "pending".into(),
                }],
            },
            CanonicalEvent::Usage {
                agent_id: "alpha-agent".into(),
                thread_id: thread_id.clone(),
                used: 1,
                size: 2,
                cost: Some("1 USD".into()),
            },
            CanonicalEvent::Mode {
                agent_id: "alpha-agent".into(),
                thread_id: thread_id.clone(),
                id: "plan".into(),
            },
            CanonicalEvent::Config {
                agent_id: "alpha-agent".into(),
                thread_id: thread_id.clone(),
                entries: vec![crate::acp::events::ConfigEntry {
                    id: "model".into(),
                    value: "example".into(),
                }],
            },
            CanonicalEvent::SessionInfo {
                agent_id: "alpha-agent".into(),
                thread_id: thread_id.clone(),
                title: FieldUpdate::Set("Title".into()),
                updated_at: FieldUpdate::Clear,
            },
            CanonicalEvent::Commands {
                agent_id: "alpha-agent".into(),
                thread_id: thread_id.clone(),
                commands: vec![crate::acp::events::CommandEntry {
                    name: "test".into(),
                    description: "Run tests".into(),
                }],
            },
        ];
        let names = metadata
            .iter()
            .map(|event| {
                let projected = projector.project_canonical(event);
                assert_eq!(event_types(&projected.events), ["CUSTOM"]);
                serde_json::to_value(&projected.events[0]).unwrap()["event"]["name"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "tethercode.dev/plan",
                "tethercode.dev/usage",
                "tethercode.dev/mode",
                "tethercode.dev/config",
                "tethercode.dev/session-info",
                "tethercode.dev/commands"
            ]
        );

        let approval = PendingApproval {
            request_id: "permission".into(),
            agent_id: "alpha-agent".into(),
            kind: "fileChange".into(),
            thread_id: thread_id.clone(),
            turn_id: "turn-1".into(),
            item_id: "tool".into(),
            title: "Write".into(),
            message: "Write".into(),
            requested_at: "2026-07-20T00:00:00Z".into(),
            reason: Some("Write".into()),
            command: None,
            cwd: None,
            grant_root: None,
            proposed_execpolicy_amendment: None,
            options: vec![PendingApprovalOption {
                id: "reject".into(),
                label: "Reject".into(),
                kind: Some("RejectOnce".into()),
            }],
        };
        let requested = projector.project_canonical(&CanonicalEvent::PermissionRequested {
            approval: approval.clone(),
        });
        assert!(requested.events.is_empty());
        assert_eq!(requested.controls[0].0, "bridge/approval.requested");
        assert_eq!(
            requested.controls[0].1,
            serde_json::to_value(approval).unwrap()
        );
        let resolved = projector.project_canonical(&CanonicalEvent::PermissionResolved {
            agent_id: "alpha-agent".into(),
            thread_id: thread_id.clone(),
            request_id: "permission".into(),
            outcome: "reject".into(),
        });
        assert_eq!(resolved.controls[0].0, "bridge/approval.resolved");
        let user_input = PendingUserInputRequest {
            request_id: "question".into(),
            agent_id: Some("alpha-agent".into()),
            thread_id: thread_id.clone(),
            turn_id: "turn-1".into(),
            item_id: "tool".into(),
            message: "Value".into(),
            requested_at: "2026-07-20T00:00:01Z".into(),
            questions: vec![PendingUserInputQuestion {
                id: "name".into(),
                header: "Name".into(),
                question: "Value".into(),
                is_other: false,
                is_secret: true,
                required: true,
                field_type: "string".into(),
                default_value: None,
                options: Some(vec![PendingUserInputQuestionOption {
                    value: "value".into(),
                    label: "Value".into(),
                    description: String::new(),
                }]),
            }],
        };
        let elicitation = projector.project_canonical(&CanonicalEvent::ElicitationRequested {
            request: user_input.clone(),
        });
        assert!(elicitation.events.is_empty());
        assert_eq!(elicitation.controls[0].0, "bridge/userInput.requested");
        assert_eq!(
            elicitation.controls[0].1,
            serde_json::to_value(user_input).unwrap()
        );
        let elicitation_resolved =
            projector.project_canonical(&CanonicalEvent::ElicitationResolved {
                agent_id: "alpha-agent".into(),
                thread_id,
                request_id: "question".into(),
                action: "cancelled".into(),
            });
        assert_eq!(
            elicitation_resolved.controls[0].0,
            "bridge/userInput.resolved"
        );
    }

    #[tokio::test]
    async fn canonical_hub_projection_replays_serialized_events_once() {
        let hub = ClientHub::with_replay_capacity(32);
        hub.broadcast_canonical_event(&canonical_run_started())
            .await;
        hub.broadcast_canonical_event(&canonical_message(MessageRole::Agent, "message", "hello"))
            .await;
        let (replay, _, _) = hub.replay_since(None, 32).await;
        assert_eq!(replay.len(), 3);
        assert_eq!(replay[0]["method"], AG_UI_EVENT_METHOD);
        assert_eq!(replay[1]["params"]["event"]["type"], "TEXT_MESSAGE_START");
        assert_eq!(replay[2]["params"]["event"]["type"], "TEXT_MESSAGE_CONTENT");
    }

    #[test]
    fn canonical_projection_handles_superseded_failed_and_stale_runs() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        projector.project_canonical(&canonical_message(MessageRole::Agent, "answer", "partial"));
        projector.project_canonical(&canonical_message(MessageRole::Thought, "thought-1", "one"));
        let changed_thought = projector.project_canonical(&canonical_message(
            MessageRole::Thought,
            "thought-2",
            "two",
        ));
        assert_eq!(
            event_types(&changed_thought.events),
            [
                "REASONING_MESSAGE_END",
                "REASONING_MESSAGE_START",
                "REASONING_MESSAGE_CONTENT"
            ]
        );

        let superseding = CanonicalEvent::RunStarted {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: "run-2".to_string(),
            source_turn_id: "turn-2".to_string(),
            generation: 2,
        };
        let superseded = projector.project_canonical(&superseding);
        assert_eq!(
            event_types(&superseded.events),
            [
                "TEXT_MESSAGE_END",
                "REASONING_MESSAGE_END",
                "RUN_ERROR",
                "RUN_STARTED"
            ]
        );

        let stale = projector.project_canonical(&CanonicalEvent::RunFinished {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: "run-1".to_string(),
            source_turn_id: "turn-1".to_string(),
            generation: 1,
            stop_reason: StopReason::EndTurn,
        });
        assert!(stale.events.is_empty());
        let failed = projector.project_canonical(&CanonicalEvent::RunFailed {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: "run-2".to_string(),
            source_turn_id: "turn-2".to_string(),
            generation: 2,
            message: "failed".to_string(),
        });
        assert_eq!(event_types(&failed.events), ["RUN_ERROR"]);

        let mut empty_projector = AgUiProjector::default();
        empty_projector.project_canonical(&canonical_run_started());
        let empty_superseded = empty_projector.project_canonical(&superseding);
        assert_eq!(
            event_types(&empty_superseded.events),
            ["RUN_ERROR", "RUN_STARTED"]
        );
    }

    #[test]
    fn canonical_projection_filters_empty_and_mismatched_chunks() {
        let mut projector = AgUiProjector::default();
        assert!(projector
            .project_canonical(&canonical_message(MessageRole::Agent, "missing", "content"))
            .events
            .is_empty());
        projector.project_canonical(&canonical_run_started());
        assert!(projector
            .project_canonical(&canonical_message(MessageRole::Agent, "empty", ""))
            .events
            .is_empty());
        let user =
            projector.project_canonical(&canonical_message(MessageRole::User, "user", "content"));
        assert_eq!(
            event_types(&user.events),
            ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]
        );
        assert_eq!(
            serde_json::to_value(&user.events[0]).unwrap()["event"]["role"],
            "user"
        );
        let next_user =
            projector.project_canonical(&canonical_message(MessageRole::User, "next-user", "next"));
        assert_eq!(
            event_types(&next_user.events),
            [
                "TEXT_MESSAGE_END",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT"
            ]
        );

        let mut mismatched_run = canonical_message(MessageRole::Agent, "wrong-run", "content");
        if let CanonicalEvent::MessageChunk { run_id, .. } = &mut mismatched_run {
            *run_id = Some("other-run".to_string());
        }
        assert!(projector
            .project_canonical(&mismatched_run)
            .events
            .is_empty());
        let mut mismatched_turn = canonical_message(MessageRole::Agent, "wrong-turn", "content");
        if let CanonicalEvent::MessageChunk { source_turn_id, .. } = &mut mismatched_turn {
            *source_turn_id = Some("other-turn".to_string());
        }
        assert!(projector
            .project_canonical(&mismatched_turn)
            .events
            .is_empty());
    }

    #[test]
    fn oversized_utf8_text_and_tool_results_are_bounded_and_explicitly_truncated() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let content = "a🙂界".repeat(12_000);
        for role in [MessageRole::User, MessageRole::Agent, MessageRole::Thought] {
            let projection = projector.project_canonical(&canonical_message(
                role,
                &format!("{role:?}"),
                &content,
            ));
            let reconstructed = projection
                .events
                .iter()
                .filter_map(|envelope| envelope.event.delta.as_ref())
                .filter_map(|delta| match delta {
                    Delta::String(value) => Some(value.as_str()),
                    _ => None,
                })
                .collect::<String>();
            assert!(reconstructed.len() <= MAX_MESSAGE_TOTAL_BYTES);
            assert!(content.starts_with(&reconstructed));
            let truncations = projection
                .events
                .iter()
                .filter(|envelope| {
                    envelope.event.name.as_deref() == Some("tethercode.dev/transcript-truncated")
                })
                .collect::<Vec<_>>();
            assert_eq!(truncations.len(), 1);
            assert_eq!(
                truncations[0].event.value.as_ref().unwrap()["retrieval"]["available"],
                false
            );
            let post_cap = projector.project_canonical(&canonical_message(
                role,
                &format!("{role:?}"),
                "ignored after cap",
            ));
            assert!(post_cap.events.is_empty());
            assert!(projection.events.iter().all(|envelope| {
                serde_json::to_value(envelope)
                    .ok()
                    .is_some_and(|value| value["event"]["type"].is_string())
            }));
        }

        let tool = CanonicalEvent::Tool {
            agent_id: "alpha-agent".into(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
            run_id: Some("run-1".into()),
            source_turn_id: Some("turn-1".into()),
            generation: Some(1),
            tool_call_id: "large-tool".into(),
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
            title: "Large".into(),
            content: FieldUpdate::Set(content.clone()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        };
        let projection = projector.project_canonical(&tool);
        let reconstructed = projection
            .events
            .iter()
            .filter_map(|envelope| envelope.event.content.as_ref())
            .filter_map(|content| match content {
                AgUiEventContent::String(value) => Some(value.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert!(reconstructed.len() <= MAX_TOOL_TOTAL_BYTES);
        assert!(content.starts_with(&reconstructed));
        assert_eq!(
            projector.runs.values().next().unwrap().tools["large-tool"]
                .result_content
                .len(),
            MAX_TOOL_TOTAL_BYTES
        );
    }

    #[test]
    fn canonical_non_text_message_projects_custom_content_without_placeholder_text() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let mut message = canonical_message(MessageRole::Agent, "image", "");
        if let CanonicalEvent::MessageChunk { content_block, .. } = &mut message {
            *content_block = Some(json!({"type":"image","mimeType":"image/png"}));
        }
        let projected = projector.project_canonical(&message);
        assert_eq!(
            event_types(&projected.events),
            ["CUSTOM", "TEXT_MESSAGE_START"]
        );
        let value = serde_json::to_value(&projected.events[0]).unwrap();
        assert_eq!(value["event"]["name"], "tethercode.dev/message-content");
        assert_eq!(value["event"]["value"]["content"]["type"], "image");
        assert!(!value.to_string().contains("non-text content omitted"));

        let repeated_reasoning = projector.project_canonical(&canonical_message(
            MessageRole::Thought,
            "reasoning",
            "one",
        ));
        assert_eq!(
            event_types(&repeated_reasoning.events),
            ["REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT"]
        );
        let repeated_reasoning = projector.project_canonical(&canonical_message(
            MessageRole::Thought,
            "reasoning",
            "two",
        ));
        assert_eq!(
            event_types(&repeated_reasoning.events),
            ["REASONING_MESSAGE_CONTENT"]
        );

        let location_only_event = CanonicalEvent::Tool {
            agent_id: "alpha-agent".into(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
            run_id: Some("run-1".into()),
            source_turn_id: Some("turn-1".into()),
            generation: Some(1),
            tool_call_id: "location-only".into(),
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
            title: "Locate".into(),
            content: FieldUpdate::Set(String::new()),
            structured_content: FieldUpdate::Set(vec![]),
            locations: FieldUpdate::Set(vec![json!({"path":"src/lib.rs"})]),
        };
        assert!(AgUiProjector::default()
            .project_canonical(&location_only_event)
            .events
            .is_empty());
        let location_only = projector.project_canonical(&location_only_event);
        assert_eq!(
            event_types(&location_only.events),
            [
                "TOOL_CALL_START",
                "TOOL_CALL_ARGS",
                "TOOL_CALL_END",
                "CUSTOM"
            ]
        );

        let mut runs = HashMap::from([(
            "thread".to_string(),
            AgUiRunState {
                run_id: "run".to_string(),
                source_turn_id: None,
                open_user_id: None,
                open_message_id: None,
                open_reasoning_id: None,
                message_bytes: HashMap::new(),
                truncated_messages: HashSet::new(),
                tools: HashMap::new(),
            },
        )]);
        assert!(canonical_run_mut(&mut runs, "thread", None, None).is_some());
        assert!(canonical_run_mut(&mut runs, "thread", None, Some("turn")).is_some());
        runs.get_mut("thread").unwrap().source_turn_id = Some("turn".to_string());
        assert!(canonical_run_mut(&mut runs, "thread", None, Some("turn")).is_some());
        assert!(canonical_run_mut(&mut runs, "thread", Some("other"), None).is_none());
    }

    #[test]
    fn canonical_message_truncation_block_emits_one_retrieval_marker() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let mut message = canonical_message(MessageRole::Agent, "truncated", "bounded");
        if let CanonicalEvent::MessageChunk { content_block, .. } = &mut message {
            *content_block = Some(json!({"type":"truncation","truncated":true}));
        }
        let projection = projector.project_canonical(&message);
        assert_eq!(
            projection
                .events
                .iter()
                .filter(|envelope| envelope.event.name.as_deref()
                    == Some("tethercode.dev/transcript-truncated"))
                .count(),
            1
        );
        let repeated = projector.project_canonical(&message);
        assert!(repeated.events.iter().all(|envelope| {
            envelope.event.name.as_deref() != Some("tethercode.dev/transcript-truncated")
        }));

        if let CanonicalEvent::MessageChunk { content_block, .. } = &mut message {
            *content_block = Some(json!({"type":"truncation","truncated":"invalid"}));
        }
        let second = projector.project_canonical(&message);
        assert!(second.events.iter().all(|envelope| {
            envelope.event.name.as_deref() != Some("tethercode.dev/transcript-truncated")
        }));
    }

    #[test]
    fn canonical_tool_defaults_title_and_emits_changed_terminal_results() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let tool = |status, content: &str| CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "tool".to_string(),
            kind: ToolKind::Edit,
            status,
            title: " ".to_string(),
            content: FieldUpdate::Set(content.to_string()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        };
        let mut terminal_first_projector = AgUiProjector::default();
        terminal_first_projector.project_canonical(&canonical_run_started());
        let terminal_first = terminal_first_projector
            .project_canonical(&tool(ToolCallStatus::Failed, "terminal-first"));
        assert!(event_types(&terminal_first.events).contains(&"TOOL_CALL_RESULT"));
        let started = projector.project_canonical(&tool(ToolCallStatus::Pending, ""));
        assert_eq!(
            event_types(&started.events),
            ["TOOL_CALL_START", "TOOL_CALL_ARGS"]
        );
        let serialized = serde_json::to_value(&started.events[0]).unwrap();
        assert_eq!(serialized["event"]["toolCallName"], "edit");
        let partial = projector.project_canonical(&tool(ToolCallStatus::InProgress, "first"));
        assert_eq!(event_types(&partial.events), ["CUSTOM"]);
        assert_eq!(
            serde_json::to_value(&partial.events[0]).unwrap()["event"]["name"],
            "tethercode.dev/tool-text"
        );
        assert!(projector
            .project_canonical(&tool(ToolCallStatus::InProgress, "first"))
            .events
            .is_empty());
        let empty_terminal = projector.project_canonical(&tool(ToolCallStatus::Failed, ""));
        assert_eq!(
            event_types(&empty_terminal.events),
            ["TOOL_CALL_END", "CUSTOM"]
        );
        assert_eq!(
            serde_json::to_value(&empty_terminal.events[1]).unwrap()["event"]["name"],
            "tethercode.dev/tool-text"
        );
        let metadata_only = CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "tool".to_string(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::Failed,
            title: "updated title".to_string(),
            content: FieldUpdate::Unchanged,
            structured_content: FieldUpdate::Unchanged,
            locations: FieldUpdate::Unchanged,
        };
        assert!(projector
            .project_canonical(&metadata_only)
            .events
            .is_empty());
        let changed_result = projector.project_canonical(&tool(ToolCallStatus::Failed, "second"));
        assert_eq!(event_types(&changed_result.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&changed_result.events[0]).unwrap()["event"]["content"],
            "second"
        );
        let suffix_result = projector.project_canonical(&tool(ToolCallStatus::Failed, "second!"));
        assert_eq!(event_types(&suffix_result.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&suffix_result.events[0]).unwrap()["event"]["content"],
            "!"
        );
        let prefix_shaped_append = CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "tool".to_string(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::Failed,
            title: " ".to_string(),
            content: FieldUpdate::Append("second! appended".to_string()),
            structured_content: FieldUpdate::Unchanged,
            locations: FieldUpdate::Unchanged,
        };
        let prefix_shaped = projector.project_canonical(&prefix_shaped_append);
        assert_eq!(event_types(&prefix_shaped.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&prefix_shaped.events[0]).unwrap()["event"]["content"],
            "second! appended"
        );
        let mut snapshot = SessionSnapshot::new(
            "alpha-agent".to_string(),
            "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
        );
        snapshot.apply(&tool(ToolCallStatus::Failed, "second!"));
        snapshot.apply(&prefix_shaped_append);
        assert_eq!(snapshot.tools["tool"].content, "second!second! appended");
        assert_eq!(
            projector.runs["v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg"].tools["tool"].result_content,
            snapshot.tools["tool"].content
        );
        let append_event = CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "tool".to_string(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::Failed,
            title: " ".to_string(),
            content: FieldUpdate::Append(" appended".to_string()),
            structured_content: FieldUpdate::Unchanged,
            locations: FieldUpdate::Unchanged,
        };
        let appended = projector.project_canonical(&append_event);
        assert_eq!(event_types(&appended.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&appended.events[0]).unwrap()["event"]["content"],
            " appended"
        );
        let repeated = projector.project_canonical(&append_event);
        assert_eq!(event_types(&repeated.events), ["TOOL_CALL_RESULT"]);
        assert_eq!(
            serde_json::to_value(&repeated.events[0]).unwrap()["event"]["content"],
            " appended"
        );
        let mut cleared = append_event.clone();
        if let CanonicalEvent::Tool { content, .. } = &mut cleared {
            *content = FieldUpdate::Append(String::new());
        }
        assert!(!event_types(&projector.project_canonical(&cleared).events)
            .contains(&"TOOL_CALL_RESULT"));
    }

    #[test]
    fn canonical_tool_preserves_structured_content_in_custom_event() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let projection = projector.project_canonical(&CanonicalEvent::Tool {
            agent_id: "alpha-agent".to_string(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".to_string(),
            run_id: Some("run-1".to_string()),
            source_turn_id: Some("turn-1".to_string()),
            generation: Some(1),
            tool_call_id: "tool-structured".to_string(),
            kind: ToolKind::Edit,
            status: ToolCallStatus::Completed,
            title: "Edit".to_string(),
            content: FieldUpdate::Set("done".to_string()),
            structured_content: FieldUpdate::Set(vec![
                json!({"type": "content", "content": {"type": "image", "data": "aW1hZ2U=", "mimeType": "image/png"}}),
                json!({"type": "diff", "path": "/tmp/file", "oldText": "old", "newText": "new"}),
                json!({"type": "terminal", "terminalId": "terminal-1"}),
            ]),
            locations: FieldUpdate::Set(vec![json!({"path": "/tmp/file", "line": 7})]),
        });
        assert_eq!(
            event_types(&projection.events),
            [
                "TOOL_CALL_START",
                "TOOL_CALL_ARGS",
                "TOOL_CALL_END",
                "TOOL_CALL_RESULT",
                "CUSTOM",
            ]
        );
        let custom = serde_json::to_value(projection.events.last().unwrap()).unwrap();
        assert_eq!(custom["event"]["name"], "tethercode.dev/tool-content");
        assert_eq!(custom["event"]["value"]["content"][1]["type"], "diff");
        assert_eq!(custom["event"]["value"]["locations"][0]["line"], 7);
    }

    #[test]
    fn canonical_tool_projects_changed_in_progress_structured_revisions() {
        let mut projector = AgUiProjector::default();
        projector.project_canonical(&canonical_run_started());
        let tool = |terminal_id: &str| CanonicalEvent::Tool {
            agent_id: "alpha-agent".into(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
            run_id: Some("run-1".into()),
            source_turn_id: Some("turn-1".into()),
            generation: Some(1),
            tool_call_id: "live-tool".into(),
            kind: ToolKind::Execute,
            status: ToolCallStatus::InProgress,
            title: "Terminal".into(),
            content: FieldUpdate::Set(String::new()),
            structured_content: FieldUpdate::Set(vec![
                json!({"type":"terminal","terminalId":terminal_id}),
            ]),
            locations: FieldUpdate::Set(Vec::new()),
        };
        let first = projector.project_canonical(&tool("terminal-1"));
        assert_eq!(
            event_types(&first.events),
            ["TOOL_CALL_START", "TOOL_CALL_ARGS", "CUSTOM"]
        );
        assert!(projector
            .project_canonical(&tool("terminal-1"))
            .events
            .is_empty());
        let changed = projector.project_canonical(&tool("terminal-2"));
        assert_eq!(event_types(&changed.events), ["CUSTOM"]);

        let append = CanonicalEvent::Tool {
            agent_id: "alpha-agent".into(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
            run_id: Some("run-1".into()),
            source_turn_id: Some("turn-1".into()),
            generation: Some(1),
            tool_call_id: "live-tool".into(),
            kind: ToolKind::Execute,
            status: ToolCallStatus::InProgress,
            title: "metadata update".into(),
            content: FieldUpdate::Unchanged,
            structured_content: FieldUpdate::Append(vec![
                json!({"type":"terminal","terminalId":"terminal-3"}),
            ]),
            locations: FieldUpdate::Append(vec![json!({"path":"src/main.rs"})]),
        };
        let appended = projector.project_canonical(&append);
        let appended_value = serde_json::to_value(&appended.events[0]).unwrap();
        assert_eq!(
            appended_value["event"]["value"]["content"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            appended_value["event"]["value"]["locations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut metadata_only = append.clone();
        if let CanonicalEvent::Tool {
            title,
            structured_content,
            locations,
            ..
        } = &mut metadata_only
        {
            *title = "duplicate metadata update".into();
            *structured_content = FieldUpdate::Unchanged;
            *locations = FieldUpdate::Unchanged;
        }
        assert!(projector
            .project_canonical(&metadata_only)
            .events
            .is_empty());

        let mut clear = append;
        if let CanonicalEvent::Tool {
            structured_content,
            locations,
            ..
        } = &mut clear
        {
            *structured_content = FieldUpdate::Clear;
            *locations = FieldUpdate::Clear;
        }
        let cleared = projector.project_canonical(&clear);
        let cleared_value = serde_json::to_value(&cleared.events[0]).unwrap();
        assert_eq!(cleared_value["event"]["value"]["content"], json!([]));
        assert_eq!(cleared_value["event"]["value"]["locations"], json!([]));

        let mut content = Vec::new();
        let mut locations = Vec::new();
        let mut truncated = false;
        assert!(!apply_structured_updates(
            &mut content,
            &FieldUpdate::Unchanged,
            &mut locations,
            &FieldUpdate::Unchanged,
            16,
            &mut truncated,
        ));
        assert!(apply_structured_updates(
            &mut content,
            &FieldUpdate::Append(vec![json!({"large":"value that exceeds the bound"})]),
            &mut locations,
            &FieldUpdate::Append(vec![json!({"path":"also-too-large"})]),
            16,
            &mut truncated,
        ));
        assert!(truncated);
        assert!(content.is_empty());
        assert!(locations.is_empty());
        assert!(apply_structured_updates(
            &mut content,
            &FieldUpdate::Set(vec![json!(1)]),
            &mut locations,
            &FieldUpdate::Clear,
            64,
            &mut truncated,
        ));
        assert!(!truncated);

        let oversized = CanonicalEvent::Tool {
            agent_id: "alpha-agent".into(),
            thread_id: "v1.YWxwaGEtYWdlbnQ.c2Vzc2lvbg".into(),
            run_id: Some("run-1".into()),
            source_turn_id: Some("turn-1".into()),
            generation: Some(1),
            tool_call_id: "live-tool".into(),
            kind: ToolKind::Execute,
            status: ToolCallStatus::InProgress,
            title: "oversized".into(),
            content: FieldUpdate::Unchanged,
            structured_content: FieldUpdate::Append(vec![json!({
                "type": "terminal",
                "output": "x".repeat(MAX_STRUCTURED_TOOL_BYTES + 1),
            })]),
            locations: FieldUpdate::Unchanged,
        };
        let unavailable = projector.project_canonical(&oversized);
        assert_eq!(unavailable.events.len(), 1);
        assert_eq!(
            serde_json::to_value(&unavailable.events[0]).unwrap()["event"]["value"]["retrieval"]
                ["available"],
            false
        );

        let mut recovered = oversized;
        if let CanonicalEvent::Tool {
            structured_content, ..
        } = &mut recovered
        {
            *structured_content = FieldUpdate::Set(vec![json!({"type":"terminal","output":"ok"})]);
        }
        let recovered = projector.project_canonical(&recovered);
        assert_eq!(
            serde_json::to_value(&recovered.events[0]).unwrap()["event"]["value"]["retrieval"]
                ["available"],
            true
        );
    }

    #[test]
    fn canonical_custom_events_and_bounds_work_without_active_run() {
        let mut projector = AgUiProjector::default();
        let custom = projector.project_canonical(&CanonicalEvent::Mode {
            agent_id: "alpha-agent".to_string(),
            thread_id: "thread".to_string(),
            id: "mode".to_string(),
        });
        assert_eq!(custom.events[0].run_id, "thread::session");
        assert_eq!(custom.events[0].source_turn_id, None);
        assert_eq!(field_value(&FieldUpdate::Unchanged), Value::Null);
        assert_eq!(field_value(&FieldUpdate::Clear), Value::Null);
        assert_eq!(
            field_value(&FieldUpdate::Set("value".to_string())),
            Value::String("value".to_string())
        );
        assert_eq!(
            field_value(&FieldUpdate::Append("suffix".to_string())),
            Value::String("suffix".to_string())
        );
        let unicode = format!("{}é", "x".repeat(7));
        assert_eq!(bounded(unicode, 8), "xxxxxxx");
        assert_eq!(bounded("short", 8), "short");
    }
}
