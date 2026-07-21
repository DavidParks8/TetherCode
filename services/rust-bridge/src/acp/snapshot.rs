use std::collections::{BTreeMap, HashSet, VecDeque};

use agent_client_protocol::schema::v1::{ToolCallStatus, ToolKind};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use super::events::{
    CanonicalEvent, CommandEntry, ConfigEntry, FieldUpdate, MessageRole, PlanEntry,
};

const MAX_MESSAGES: usize = 128;
const MAX_TOOLS: usize = 128;
const MAX_TIMELINE_ENTRIES: usize = MAX_MESSAGES + MAX_TOOLS;
const MAX_ENTRIES: usize = 128;
const MAX_TEXT_BYTES: usize = 32 * 1024;
const MAX_MESSAGE_PARTS: usize = 64;
const MAX_STRUCTURED_PART_BYTES: usize = 16 * 1024;
const MAX_STRUCTURED_FIELDS: usize = 64;
const MAX_TOOL_TEXT_BYTES: usize = 64 * 1024;
const MAX_TOOL_STRUCTURED_ITEMS: usize = 64;
const MAX_TOOL_LOCATIONS: usize = 32;
pub const MAX_SNAPSHOT_PAGE_SIZE: usize = 100;
const MAX_HISTORY_ENTRIES: usize = 1_024;
const MAX_HISTORY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub agent_id: String,
    pub thread_id: String,
    pub history_reconstruction: bool,
    pub active_run_id: Option<String>,
    pub active_source_turn_id: Option<String>,
    pub active_generation: Option<u64>,
    pub active_tool_ids: HashSet<String>,
    pub messages: VecDeque<SnapshotMessage>,
    pub tools: BTreeMap<String, SnapshotTool>,
    pub timeline: VecDeque<SnapshotTimelineEntry>,
    pub next_sequence: u64,
    total_messages: u64,
    total_reasoning: u64,
    total_tools: u64,
    history: VecDeque<SnapshotHistoryEntry>,
    history_bytes: usize,
    unavailable_count: u64,
    pub plan: Vec<PlanEntry>,
    pub mode_id: Option<String>,
    pub config: Vec<ConfigEntry>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub commands: Vec<CommandEntry>,
    pub usage_used: Option<u64>,
    pub usage_size: Option<u64>,
    pub usage_cost: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMessage {
    pub id: String,
    pub role: MessageRole,
    pub parts: Vec<serde_json::Value>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTool {
    pub id: String,
    pub generation: Option<u64>,
    pub kind: ToolKind,
    pub status: ToolCallStatus,
    pub title: String,
    pub content: String,
    pub structured_content: Vec<serde_json::Value>,
    pub locations: Vec<serde_json::Value>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTimelineEntry {
    pub sequence: u64,
    pub kind: SnapshotTimelineKind,
    pub canonical_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotTimelineKind {
    Message,
    Reasoning,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotHistoryEntry {
    pub sequence: u64,
    pub kind: SnapshotTimelineKind,
    pub canonical_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<SnapshotMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<SnapshotTool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCollectionMetadata {
    pub truncated: bool,
    pub omitted_count: u64,
    pub oldest_available_sequence: Option<u64>,
    pub newest_sequence: Option<u64>,
    pub before_cursor: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotContinuation {
    pub revision: u64,
    pub unavailable_count: u64,
    pub earliest_available_sequence: Option<u64>,
    pub latest_available_sequence: Option<u64>,
    pub max_page_size: usize,
    pub max_history_entries: usize,
    pub max_history_bytes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPage {
    pub entries: Vec<SnapshotHistoryEntry>,
    pub before_cursor: Option<String>,
    pub after_cursor: Option<String>,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub unavailable_count: u64,
    pub earliest_available_sequence: Option<u64>,
    pub latest_available_sequence: Option<u64>,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotCursor {
    thread_id: String,
    sequence: u64,
    revision: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeThreadSnapshot {
    pub version: u64,
    pub timeline: Vec<SnapshotTimelineEntry>,
    pub messages: Vec<SnapshotMessage>,
    pub tools: Vec<SnapshotTool>,
    pub message_collection: SnapshotCollectionMetadata,
    pub reasoning_collection: SnapshotCollectionMetadata,
    pub tool_collection: SnapshotCollectionMetadata,
    pub continuation: SnapshotContinuation,
    pub plan: Vec<PlanEntry>,
    pub usage: BridgeUsageSnapshot,
    pub mode: Option<String>,
    pub config: Vec<ConfigEntry>,
    pub commands: Vec<CommandEntry>,
    pub session: BridgeSessionMetadata,
    pub active: BridgeActiveRunSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeUsageSnapshot {
    pub used: Option<u64>,
    pub size: Option<u64>,
    pub cost: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSessionMetadata {
    pub agent_id: String,
    pub thread_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub history_reconstruction: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeActiveRunSnapshot {
    pub run_id: Option<String>,
    pub source_turn_id: Option<String>,
    pub generation: Option<u64>,
    pub tool_ids: Vec<String>,
}

impl From<SessionSnapshot> for BridgeThreadSnapshot {
    fn from(snapshot: SessionSnapshot) -> Self {
        let message_collection = snapshot.collection_metadata(SnapshotTimelineKind::Message);
        let reasoning_collection = snapshot.collection_metadata(SnapshotTimelineKind::Reasoning);
        let tool_collection = snapshot.collection_metadata(SnapshotTimelineKind::Tool);
        let continuation = snapshot.continuation();
        Self {
            version: 2,
            timeline: snapshot.timeline.into_iter().collect(),
            messages: snapshot.messages.into_iter().collect(),
            tools: snapshot.tools.into_values().collect(),
            message_collection,
            reasoning_collection,
            tool_collection,
            continuation,
            plan: snapshot.plan,
            usage: BridgeUsageSnapshot {
                used: snapshot.usage_used,
                size: snapshot.usage_size,
                cost: snapshot.usage_cost,
            },
            mode: snapshot.mode_id,
            config: snapshot.config,
            commands: snapshot.commands,
            session: BridgeSessionMetadata {
                agent_id: snapshot.agent_id,
                thread_id: snapshot.thread_id,
                title: snapshot.title,
                updated_at: snapshot.updated_at,
                history_reconstruction: snapshot.history_reconstruction,
            },
            active: BridgeActiveRunSnapshot {
                run_id: snapshot.active_run_id,
                source_turn_id: snapshot.active_source_turn_id,
                generation: snapshot.active_generation,
                tool_ids: {
                    let mut ids = snapshot.active_tool_ids.into_iter().collect::<Vec<_>>();
                    ids.sort();
                    ids
                },
            },
        }
    }
}

struct ToolProjection<'a> {
    kind: &'a ToolKind,
    status: &'a ToolCallStatus,
    title: &'a str,
    content: &'a FieldUpdate<String>,
    structured_content: &'a FieldUpdate<Vec<serde_json::Value>>,
    locations: &'a FieldUpdate<Vec<serde_json::Value>>,
}

impl SessionSnapshot {
    pub fn new(agent_id: String, thread_id: String) -> Self {
        Self {
            agent_id,
            thread_id,
            ..Self::default()
        }
    }

    pub fn apply(&mut self, event: &CanonicalEvent) {
        match event {
            CanonicalEvent::RunStarted {
                run_id,
                source_turn_id,
                generation,
                ..
            } => {
                self.active_run_id = Some(run_id.clone());
                self.active_source_turn_id = Some(source_turn_id.clone());
                self.active_generation = Some(*generation);
                self.active_tool_ids.clear();
            }
            CanonicalEvent::RunFinished { generation, .. }
            | CanonicalEvent::RunFailed { generation, .. }
                if self.active_generation == Some(*generation) =>
            {
                self.active_run_id = None;
                self.active_source_turn_id = None;
                self.active_generation = None;
                self.active_tool_ids.clear();
            }
            CanonicalEvent::MessageChunk {
                message_id,
                role,
                content,
                content_block,
                ..
            } => self.append_message(
                message_id.clone(),
                *role,
                content.clone(),
                content_block.clone(),
            ),
            CanonicalEvent::Tool {
                tool_call_id,
                generation,
                kind,
                status,
                title,
                content,
                structured_content,
                locations,
                ..
            } => self.apply_tool(
                tool_call_id,
                *generation,
                ToolProjection {
                    kind,
                    status,
                    title,
                    content,
                    structured_content,
                    locations,
                },
            ),
            CanonicalEvent::Plan { entries, .. } => {
                self.plan = entries
                    .iter()
                    .take(MAX_ENTRIES)
                    .cloned()
                    .map(bound_plan)
                    .collect()
            }
            CanonicalEvent::Mode { id, .. } => {
                self.mode_id = Some(bound(id.clone(), MAX_TEXT_BYTES))
            }
            CanonicalEvent::Config { entries, .. } => {
                self.config = entries
                    .iter()
                    .take(MAX_ENTRIES)
                    .cloned()
                    .map(bound_config)
                    .collect()
            }
            CanonicalEvent::SessionInfo {
                title, updated_at, ..
            } => {
                apply_field(&mut self.title, title);
                apply_field(&mut self.updated_at, updated_at);
            }
            CanonicalEvent::Commands { commands, .. } => {
                self.commands = commands
                    .iter()
                    .take(MAX_ENTRIES)
                    .cloned()
                    .map(bound_command)
                    .collect()
            }
            CanonicalEvent::Usage {
                used, size, cost, ..
            } => {
                self.usage_used = Some(*used);
                self.usage_size = Some(*size);
                self.usage_cost = cost.clone().map(|value| bound(value, MAX_TEXT_BYTES));
            }
            CanonicalEvent::RunFinished { .. }
            | CanonicalEvent::RunFailed { .. }
            | CanonicalEvent::PermissionRequested { .. }
            | CanonicalEvent::PermissionResolved { .. }
            | CanonicalEvent::ElicitationRequested { .. }
            | CanonicalEvent::ElicitationResolved { .. }
            | CanonicalEvent::Ignored { .. } => {}
        }
    }

    fn append_message(
        &mut self,
        id: String,
        role: MessageRole,
        content: String,
        content_block: Option<serde_json::Value>,
    ) {
        if let Some(message) = self.messages.iter_mut().find(|message| message.id == id) {
            message.truncated |= append_message_text(&mut message.parts, content);
            if let Some(content_block) = content_block {
                message.truncated |= content_block
                    .get("truncated")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                message.truncated |= append_structured_part(&mut message.parts, content_block);
            }
            let message = message.clone();
            self.update_history_message(&message);
            return;
        }
        if self.messages.len() == MAX_MESSAGES {
            let removed = self.messages.pop_front().expect("full message snapshot");
            self.timeline
                .retain(|entry| entry.canonical_id != removed.id);
        }
        self.push_timeline(
            if role == MessageRole::Thought {
                SnapshotTimelineKind::Reasoning
            } else {
                SnapshotTimelineKind::Message
            },
            id.clone(),
        );
        let mut parts = Vec::new();
        let mut truncated = append_message_text(&mut parts, content);
        if let Some(content_block) = content_block {
            truncated |= content_block
                .get("truncated")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            truncated |= append_structured_part(&mut parts, content_block);
        }
        self.messages.push_back(SnapshotMessage {
            id,
            role,
            parts,
            truncated,
        });
        let message = self.messages.back().expect("message was inserted").clone();
        self.attach_history_message(message);
    }

    fn apply_tool(&mut self, id: &str, generation: Option<u64>, projection: ToolProjection<'_>) {
        if self.tools.len() >= MAX_TOOLS && !self.tools.contains_key(id) {
            let oldest = self
                .timeline
                .iter()
                .find(|entry| {
                    entry.kind == SnapshotTimelineKind::Tool
                        && self.tools.contains_key(&entry.canonical_id)
                })
                .map(|entry| entry.canonical_id.clone())
                .expect("full tool snapshot");
            self.tools.remove(&oldest);
            self.active_tool_ids.remove(&oldest);
            self.timeline.retain(|entry| entry.canonical_id != oldest);
        }
        if !self.tools.contains_key(id) {
            self.push_timeline(SnapshotTimelineKind::Tool, id.to_string());
        }
        let terminal = matches!(
            projection.status,
            ToolCallStatus::Completed | ToolCallStatus::Failed
        );
        if generation == self.active_generation {
            if terminal {
                self.active_tool_ids.remove(id);
            } else {
                self.active_tool_ids.insert(id.to_string());
            }
        }
        let existing = self.tools.get(id);
        let mut tool = SnapshotTool {
            id: id.to_string(),
            generation,
            kind: *projection.kind,
            status: *projection.status,
            title: bound(projection.title.to_string(), MAX_TEXT_BYTES),
            content: existing
                .map(|tool| tool.content.clone())
                .unwrap_or_default(),
            structured_content: existing
                .map(|tool| tool.structured_content.clone())
                .unwrap_or_default(),
            locations: existing
                .map(|tool| tool.locations.clone())
                .unwrap_or_default(),
            truncated: existing.is_some_and(|tool| tool.truncated),
        };
        tool.truncated |= apply_tool_text(&mut tool.content, projection.content);
        tool.truncated |= apply_tool_values(
            &mut tool.structured_content,
            projection.structured_content,
            MAX_TOOL_STRUCTURED_ITEMS,
        );
        tool.truncated |= apply_tool_values(
            &mut tool.locations,
            projection.locations,
            MAX_TOOL_LOCATIONS,
        );
        self.tools.insert(id.to_string(), tool.clone());
        self.attach_or_update_history_tool(tool);
    }

    fn push_timeline(&mut self, kind: SnapshotTimelineKind, canonical_id: String) {
        if self.timeline.len() == MAX_TIMELINE_ENTRIES {
            self.timeline.pop_front();
        }
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        match kind {
            SnapshotTimelineKind::Message => {
                self.total_messages = self.total_messages.saturating_add(1)
            }
            SnapshotTimelineKind::Reasoning => {
                self.total_reasoning = self.total_reasoning.saturating_add(1)
            }
            SnapshotTimelineKind::Tool => self.total_tools = self.total_tools.saturating_add(1),
        }
        self.timeline.push_back(SnapshotTimelineEntry {
            sequence,
            kind,
            canonical_id: canonical_id.clone(),
        });
        self.push_history(SnapshotHistoryEntry {
            sequence,
            kind,
            canonical_id,
            message: None,
            tool: None,
        });
    }

    fn attach_history_message(&mut self, message: SnapshotMessage) {
        self.update_history_message(&message);
    }

    fn update_history_message(&mut self, message: &SnapshotMessage) {
        if let Some(entry) = self
            .history
            .iter_mut()
            .rev()
            .find(|entry| entry.canonical_id == message.id && entry.message.is_some())
        {
            entry.message = Some(message.clone());
        } else if let Some(entry) = self
            .history
            .iter_mut()
            .rev()
            .find(|entry| entry.canonical_id == message.id)
        {
            entry.message = Some(message.clone());
        }
        self.remeasure_history();
    }

    fn attach_or_update_history_tool(&mut self, tool: SnapshotTool) {
        if let Some(entry) = self
            .history
            .iter_mut()
            .rev()
            .find(|entry| entry.canonical_id == tool.id)
        {
            entry.tool = Some(tool);
        }
        self.remeasure_history();
    }

    fn push_history(&mut self, entry: SnapshotHistoryEntry) {
        self.history_bytes = self
            .history_bytes
            .saturating_add(history_entry_bytes(&entry));
        self.history.push_back(entry);
        self.enforce_history_bounds();
    }

    fn remeasure_history(&mut self) {
        self.history_bytes = self.history.iter().map(history_entry_bytes).sum();
        self.enforce_history_bounds();
    }

    fn enforce_history_bounds(&mut self) {
        while self.history.len() > MAX_HISTORY_ENTRIES || self.history_bytes > MAX_HISTORY_BYTES {
            let removed = self
                .history
                .pop_front()
                .expect("bounded history is nonempty");
            self.history_bytes = self
                .history_bytes
                .saturating_sub(history_entry_bytes(&removed));
            self.unavailable_count = self.unavailable_count.saturating_add(1);
        }
    }

    fn collection_metadata(&self, kind: SnapshotTimelineKind) -> SnapshotCollectionMetadata {
        let sequences = self
            .timeline
            .iter()
            .filter(|entry| entry.kind == kind)
            .map(|entry| entry.sequence)
            .collect::<Vec<_>>();
        let retained = sequences.len() as u64;
        let total = match kind {
            SnapshotTimelineKind::Message => self.total_messages,
            SnapshotTimelineKind::Reasoning => self.total_reasoning,
            SnapshotTimelineKind::Tool => self.total_tools,
        };
        let oldest = sequences.first().copied();
        SnapshotCollectionMetadata {
            truncated: total > retained,
            omitted_count: total.saturating_sub(retained),
            oldest_available_sequence: oldest,
            newest_sequence: sequences.last().copied(),
            before_cursor: oldest.map(|sequence| self.cursor(sequence)),
            revision: self.next_sequence,
        }
    }

    fn continuation(&self) -> SnapshotContinuation {
        SnapshotContinuation {
            revision: self.next_sequence,
            unavailable_count: self.unavailable_count,
            earliest_available_sequence: self.history.front().map(|entry| entry.sequence),
            latest_available_sequence: self.history.back().map(|entry| entry.sequence),
            max_page_size: MAX_SNAPSHOT_PAGE_SIZE,
            max_history_entries: MAX_HISTORY_ENTRIES,
            max_history_bytes: MAX_HISTORY_BYTES,
        }
    }

    fn cursor(&self, sequence: u64) -> String {
        serde_json::to_vec(&SnapshotCursor {
            thread_id: self.thread_id.clone(),
            sequence,
            revision: self.next_sequence,
        })
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .expect("snapshot cursor DTO is serializable")
    }

    pub fn page(
        &self,
        before: Option<&str>,
        after: Option<&str>,
        limit: usize,
    ) -> Result<SnapshotPage, &'static str> {
        if before.is_some() && after.is_some() {
            return Err("beforeCursor and afterCursor are mutually exclusive");
        }
        let decode = |value: &str| -> Result<SnapshotCursor, &'static str> {
            let bytes = URL_SAFE_NO_PAD
                .decode(value)
                .map_err(|_| "invalid snapshot cursor")?;
            let cursor: SnapshotCursor =
                serde_json::from_slice(&bytes).map_err(|_| "invalid snapshot cursor")?;
            let valid_identity = cursor.thread_id == self.thread_id;
            let valid_revision = cursor.revision <= self.next_sequence;
            if !(valid_identity & valid_revision) {
                return Err("invalid snapshot cursor");
            }
            Ok(cursor)
        };
        let before = match before {
            Some(cursor) => Some(decode(cursor)?),
            None => None,
        };
        let after = match after {
            Some(cursor) => Some(decode(cursor)?),
            None => None,
        };
        let limit = limit.clamp(1, MAX_SNAPSHOT_PAGE_SIZE);
        let reverse_entries = before.is_some();
        let mut entries = if let Some(cursor) = before {
            self.history
                .iter()
                .rev()
                .filter(|entry| entry.sequence < cursor.sequence)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        } else if let Some(cursor) = after {
            self.history
                .iter()
                .filter(|entry| entry.sequence > cursor.sequence)
                .take(limit)
                .cloned()
                .collect::<Vec<_>>()
        } else {
            self.history.iter().take(limit).cloned().collect::<Vec<_>>()
        };
        if reverse_entries {
            entries.reverse();
        }
        let first = entries.first().map(|entry| entry.sequence);
        let last = entries.last().map(|entry| entry.sequence);
        let earliest = self.history.front().map(|entry| entry.sequence);
        let latest = self.history.back().map(|entry| entry.sequence);
        let has_more_before = first.unwrap_or(0) > earliest.unwrap_or(0);
        let has_more_after = last.unwrap_or(u64::MAX) < latest.unwrap_or(u64::MAX);
        Ok(SnapshotPage {
            before_cursor: first.map(|sequence| self.cursor(sequence)),
            after_cursor: last.map(|sequence| self.cursor(sequence)),
            has_more_before,
            has_more_after,
            entries,
            unavailable_count: self.unavailable_count,
            earliest_available_sequence: earliest,
            latest_available_sequence: latest,
            revision: self.next_sequence,
        })
    }
}

fn history_entry_bytes(entry: &SnapshotHistoryEntry) -> usize {
    serde_json::to_vec(entry)
        .expect("snapshot history DTO is serializable")
        .len()
}

fn append_message_text(parts: &mut Vec<serde_json::Value>, content: String) -> bool {
    if content.is_empty() {
        return false;
    }
    if let Some(text) = parts
        .last_mut()
        .and_then(serde_json::Value::as_object_mut)
        .filter(|part| part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
        .and_then(|part| part.get_mut("text"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
    {
        let (joined, truncated) = bounded_append(text, &content, MAX_TEXT_BYTES);
        *parts.last_mut().expect("text part exists") = serde_json::json!({
            "type": "text",
            "text": joined,
        });
        truncated
    } else {
        if parts.len() >= MAX_MESSAGE_PARTS {
            return true;
        }
        let original_len = content.len();
        let bounded = bound(content, MAX_TEXT_BYTES);
        let truncated = bounded.len() < original_len;
        parts.push(serde_json::json!({"type": "text", "text": bounded}));
        truncated
    }
}

fn append_structured_part(parts: &mut Vec<serde_json::Value>, value: serde_json::Value) -> bool {
    if parts.len() >= MAX_MESSAGE_PARTS {
        return true;
    }
    let (value, truncated) = bound_json(value, MAX_STRUCTURED_PART_BYTES, MAX_STRUCTURED_FIELDS);
    parts.push(value);
    truncated
}

fn apply_field(target: &mut Option<String>, update: &FieldUpdate) {
    match update {
        FieldUpdate::Unchanged => {}
        FieldUpdate::Clear => *target = None,
        FieldUpdate::Set(value) => *target = Some(bound(value.clone(), MAX_TEXT_BYTES)),
        FieldUpdate::Append(value) => {
            let mut combined = target.take().unwrap_or_default();
            combined.push_str(value);
            *target = Some(bound(combined, MAX_TEXT_BYTES));
        }
    }
}

fn apply_tool_text(target: &mut String, update: &FieldUpdate<String>) -> bool {
    match update {
        FieldUpdate::Unchanged => false,
        FieldUpdate::Clear => {
            target.clear();
            false
        }
        FieldUpdate::Set(value) => {
            *target = bound(value.clone(), MAX_TOOL_TEXT_BYTES);
            target.len() < value.len()
        }
        FieldUpdate::Append(value) => {
            let (bounded, truncated) = bounded_append(target.clone(), value, MAX_TOOL_TEXT_BYTES);
            *target = bounded;
            truncated
        }
    }
}

fn apply_tool_values(
    target: &mut Vec<serde_json::Value>,
    update: &FieldUpdate<Vec<serde_json::Value>>,
    max_items: usize,
) -> bool {
    match update {
        FieldUpdate::Unchanged => false,
        FieldUpdate::Clear => {
            target.clear();
            false
        }
        FieldUpdate::Set(values) => {
            target.clear();
            append_bounded_values(target, values, max_items)
        }
        FieldUpdate::Append(values) => append_bounded_values(target, values, max_items),
    }
}

fn append_bounded_values(
    target: &mut Vec<serde_json::Value>,
    values: &[serde_json::Value],
    max_items: usize,
) -> bool {
    let mut truncated = target.len().saturating_add(values.len()) > max_items;
    for value in values.iter().take(max_items.saturating_sub(target.len())) {
        let (value, value_truncated) = bound_json(
            value.clone(),
            MAX_STRUCTURED_PART_BYTES,
            MAX_STRUCTURED_FIELDS,
        );
        target.push(value);
        truncated |= value_truncated;
    }
    truncated
}

fn bounded_append(mut current: String, appended: &str, max: usize) -> (String, bool) {
    if current.len() >= max {
        return (bound(current, max), !appended.is_empty());
    }
    let remaining = max - current.len();
    let bounded = bound(appended.to_string(), remaining);
    let truncated = bounded.len() < appended.len();
    current.push_str(&bounded);
    (current, truncated)
}

fn bound_json(
    value: serde_json::Value,
    max_bytes: usize,
    max_fields: usize,
) -> (serde_json::Value, bool) {
    fn walk(
        value: serde_json::Value,
        fields: &mut usize,
        truncated: &mut bool,
    ) -> serde_json::Value {
        match value {
            serde_json::Value::String(value) => {
                let bounded = bound(value.clone(), MAX_STRUCTURED_PART_BYTES);
                *truncated |= bounded.len() < value.len();
                serde_json::Value::String(bounded)
            }
            serde_json::Value::Array(values) => {
                *truncated |= values.len() > MAX_STRUCTURED_FIELDS;
                serde_json::Value::Array(
                    values
                        .into_iter()
                        .take(MAX_STRUCTURED_FIELDS)
                        .map(|value| walk(value, fields, truncated))
                        .collect(),
                )
            }
            serde_json::Value::Object(values) => serde_json::Value::Object(
                values
                    .into_iter()
                    .filter(|(key, _)| !matches!(key.as_str(), "rawInput" | "rawOutput" | "_meta"))
                    .filter_map(|(key, value)| {
                        if *fields >= MAX_STRUCTURED_FIELDS {
                            *truncated = true;
                            return None;
                        }
                        *fields += 1;
                        Some((bound(key, 256), walk(value, fields, truncated)))
                    })
                    .collect(),
            ),
            value => value,
        }
    }
    let mut fields = 0;
    let mut truncated = false;
    let mut bounded = walk(value, &mut fields, &mut truncated);
    if serde_json::to_vec(&bounded).map_or(true, |bytes| bytes.len() > max_bytes) {
        bounded = serde_json::json!({"type":"truncated","truncated":true});
        truncated = true;
    }
    let _ = max_fields;
    (bounded, truncated)
}
fn bound_plan(mut entry: PlanEntry) -> PlanEntry {
    entry.content = bound(entry.content, MAX_TEXT_BYTES);
    entry.priority = bound(entry.priority, MAX_TEXT_BYTES);
    entry.status = bound(entry.status, MAX_TEXT_BYTES);
    entry
}
fn bound_config(mut entry: ConfigEntry) -> ConfigEntry {
    entry.id = bound(entry.id, MAX_TEXT_BYTES);
    entry.value = bound(entry.value, MAX_TEXT_BYTES);
    entry
}
fn bound_command(mut entry: CommandEntry) -> CommandEntry {
    entry.name = bound(entry.name, MAX_TEXT_BYTES);
    entry.description = bound(entry.description, MAX_TEXT_BYTES);
    entry
}
fn bound(mut value: String, max: usize) -> String {
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
    value
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::{StopReason, ToolCallStatus, ToolKind};

    use super::*;

    fn run_started(generation: u64) -> CanonicalEvent {
        CanonicalEvent::RunStarted {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: format!("run-{generation}"),
            source_turn_id: format!("turn-{generation}"),
            generation,
        }
    }

    fn tool(id: &str, generation: Option<u64>, status: ToolCallStatus) -> CanonicalEvent {
        CanonicalEvent::Tool {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation,
            tool_call_id: id.to_string(),
            kind: ToolKind::Other,
            status,
            title: "title".to_string(),
            content: FieldUpdate::Set("content".to_string()),
            structured_content: FieldUpdate::Set(Vec::new()),
            locations: FieldUpdate::Set(Vec::new()),
        }
    }

    #[test]
    fn snapshot_tracks_active_generation_messages_and_tools() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        snapshot.apply(&run_started(2));
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run-2".to_string()),
            source_turn_id: Some("turn-2".to_string()),
            generation: Some(2),
            role: MessageRole::Agent,
            message_id: "message".to_string(),
            content: "one".to_string(),
            content_block: None,
        });
        snapshot.apply(&CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: Some("run-2".to_string()),
            source_turn_id: Some("turn-2".to_string()),
            generation: Some(2),
            role: MessageRole::Agent,
            message_id: "message".to_string(),
            content: " two".to_string(),
            content_block: None,
        });
        snapshot.apply(&tool("tool", Some(2), ToolCallStatus::InProgress));
        snapshot.apply(&tool("other-generation", Some(1), ToolCallStatus::Pending));
        assert_eq!(
            snapshot.messages[0].parts,
            vec![serde_json::json!({"type":"text","text":"one two"})]
        );
        assert_eq!(
            snapshot.active_tool_ids,
            HashSet::from(["tool".to_string()])
        );

        snapshot.apply(&tool("tool", Some(2), ToolCallStatus::Completed));
        snapshot.apply(&CanonicalEvent::RunFinished {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "stale".to_string(),
            source_turn_id: "stale".to_string(),
            generation: 1,
            stop_reason: StopReason::EndTurn,
        });
        assert_eq!(snapshot.active_generation, Some(2));
        snapshot.apply(&CanonicalEvent::RunFailed {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: "run-2".to_string(),
            source_turn_id: "turn-2".to_string(),
            generation: 2,
            message: "failed".to_string(),
        });
        assert_eq!(snapshot.active_generation, None);
        assert!(snapshot.active_tool_ids.is_empty());
    }

    #[test]
    fn snapshot_preserves_ordered_typed_message_content() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        let event = CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role: MessageRole::Agent,
            message_id: "content".to_string(),
            content: "A".to_string(),
            content_block: None,
        };
        let exercise = |snapshot: &mut SessionSnapshot, mut event: CanonicalEvent| {
            snapshot.apply(&event);
            if let CanonicalEvent::MessageChunk { content_block, .. } = &mut event {
                *content_block = Some(serde_json::json!({"type":"image"}));
            }
            if let CanonicalEvent::MessageChunk { content, .. } = &mut event {
                content.clear();
            }
            snapshot.apply(&event);
            if let CanonicalEvent::MessageChunk { content_block, .. } = &mut event {
                *content_block = None;
            }
            if let CanonicalEvent::MessageChunk { content, .. } = &mut event {
                *content = "B".to_string();
            }
            snapshot.apply(&event);
        };
        exercise(&mut snapshot, event);
        exercise(
            &mut snapshot,
            CanonicalEvent::Plan {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                entries: Vec::new(),
            },
        );
        assert_eq!(
            snapshot.messages[0].parts,
            vec![
                serde_json::json!({"type":"text","text":"A"}),
                serde_json::json!({"type":"image"}),
                serde_json::json!({"type":"text","text":"B"}),
            ]
        );
    }

    #[test]
    fn snapshot_timeline_preserves_first_seen_canonical_order_across_updates() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        let message = |id: &str, role| CanonicalEvent::MessageChunk {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            role,
            message_id: id.to_string(),
            content: id.to_string(),
            content_block: None,
        };
        snapshot.apply(&message("message-a", MessageRole::Agent));
        snapshot.apply(&tool("tool-t", None, ToolCallStatus::InProgress));
        snapshot.apply(&message("message-b", MessageRole::Agent));
        snapshot.apply(&message("reasoning-r", MessageRole::Thought));
        snapshot.apply(&tool("tool-t", None, ToolCallStatus::Completed));

        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|entry| (entry.sequence, entry.kind, entry.canonical_id.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (0, SnapshotTimelineKind::Message, "message-a"),
                (1, SnapshotTimelineKind::Tool, "tool-t"),
                (2, SnapshotTimelineKind::Message, "message-b"),
                (3, SnapshotTimelineKind::Reasoning, "reasoning-r"),
            ]
        );
    }

    #[test]
    fn snapshot_applies_append_and_clear_updates_without_reordering_tool() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        snapshot.apply(&tool("tool", None, ToolCallStatus::InProgress));
        let update = |content, structured_content, locations| CanonicalEvent::Tool {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            run_id: None,
            source_turn_id: None,
            generation: None,
            tool_call_id: "tool".to_string(),
            kind: ToolKind::Other,
            status: ToolCallStatus::InProgress,
            title: "title".to_string(),
            content,
            structured_content,
            locations,
        };
        snapshot.apply(&update(
            FieldUpdate::Append(" appended".to_string()),
            FieldUpdate::Append(vec![serde_json::json!({"type":"terminal"})]),
            FieldUpdate::Append(vec![serde_json::json!({"path":"file"})]),
        ));
        let updated = snapshot.tools.get("tool").unwrap();
        assert_eq!(updated.content, "content appended");
        assert_eq!(updated.structured_content.len(), 1);
        assert_eq!(updated.locations.len(), 1);

        snapshot.apply(&update(
            FieldUpdate::Clear,
            FieldUpdate::Clear,
            FieldUpdate::Clear,
        ));
        let cleared = snapshot.tools.get("tool").unwrap();
        assert!(cleared.content.is_empty());
        assert!(cleared.structured_content.is_empty());
        assert!(cleared.locations.is_empty());
        assert_eq!(snapshot.timeline.len(), 1);
    }

    #[test]
    fn snapshot_timeline_bounds_and_saturates_sequence() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        snapshot.next_sequence = u64::MAX;
        for index in 0..=MAX_TIMELINE_ENTRIES {
            snapshot.push_timeline(SnapshotTimelineKind::Message, format!("entry-{index}"));
        }
        assert_eq!(snapshot.timeline.len(), MAX_TIMELINE_ENTRIES);
        assert_eq!(snapshot.timeline.front().unwrap().canonical_id, "entry-1");
        assert_eq!(snapshot.next_sequence, u64::MAX);
        assert!(snapshot
            .timeline
            .iter()
            .all(|entry| entry.sequence == u64::MAX));
    }

    #[test]
    fn checked_contract_snapshot_fixture_matches_rust_dto() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/bridge-rpc/v2/manifest.json"
        ))
        .unwrap();
        let mut snapshot = SessionSnapshot::new(
            "agent-alpha".to_string(),
            "agent-alpha:thread-snapshot".to_string(),
        );
        snapshot.title = Some("Typed ACP snapshot".to_string());
        snapshot.updated_at = Some("2026-07-19T00:00:00Z".to_string());
        snapshot.messages.push_back(SnapshotMessage {
            id: "message-1".to_string(),
            role: MessageRole::Agent,
            parts: vec![
                serde_json::json!({"type":"text","text":"Snapshot A"}),
                serde_json::json!({"type":"image","data":"aW1hZ2U=","mimeType":"image/png"}),
                serde_json::json!({"type":"text","text":"Snapshot B"}),
                serde_json::json!({"type":"resource","resource":{"uri":"file:///tmp/result.txt","text":"embedded result","mimeType":"text/plain"}}),
                serde_json::json!({"type":"audio","data":"YXVkaW8=","mimeType":"audio/wav"}),
            ],
            truncated: false,
        });
        snapshot.messages.push_back(SnapshotMessage {
            id: "reasoning-1".to_string(),
            role: MessageRole::Thought,
            parts: vec![serde_json::json!({"type":"text","text":"Snapshot reasoning"})],
            truncated: false,
        });
        snapshot.timeline = VecDeque::from([
            SnapshotTimelineEntry {
                sequence: 0,
                kind: SnapshotTimelineKind::Message,
                canonical_id: "message-1".to_string(),
            },
            SnapshotTimelineEntry {
                sequence: 1,
                kind: SnapshotTimelineKind::Tool,
                canonical_id: "tool-1".to_string(),
            },
            SnapshotTimelineEntry {
                sequence: 2,
                kind: SnapshotTimelineKind::Reasoning,
                canonical_id: "reasoning-1".to_string(),
            },
        ]);
        snapshot.next_sequence = 3;
        snapshot.total_messages = 1;
        snapshot.total_reasoning = 1;
        snapshot.total_tools = 1;
        snapshot.tools.insert(
            "tool-1".to_string(),
            SnapshotTool {
                id: "tool-1".to_string(),
                generation: Some(7),
                kind: ToolKind::Read,
                status: ToolCallStatus::Completed,
                title: "Read file".to_string(),
                content: "done".to_string(),
                structured_content: vec![
                    serde_json::json!({"type":"content","content":{"type":"text","text":"structured"}}),
                    serde_json::json!({"type":"diff","path":"src/file.ts","oldText":"old","newText":"new"}),
                    serde_json::json!({"type":"terminal","terminalId":"terminal-1"}),
                ],
                locations: vec![serde_json::json!({"path":"src/file.ts","line":7})],
                truncated: false,
            },
        );
        snapshot.plan = vec![PlanEntry {
            content: "Inspect state".to_string(),
            priority: "high".to_string(),
            status: "completed".to_string(),
        }];
        snapshot.usage_used = Some(120);
        snapshot.usage_size = Some(4096);
        snapshot.usage_cost = Some("$0.01".to_string());
        snapshot.mode_id = Some("plan".to_string());
        snapshot.config = vec![ConfigEntry {
            id: "model".to_string(),
            value: "example-model".to_string(),
        }];
        snapshot.commands = vec![CommandEntry {
            name: "test".to_string(),
            description: "Run tests".to_string(),
        }];
        snapshot.active_run_id = Some("run-7".to_string());
        snapshot.active_source_turn_id = Some("turn-7".to_string());
        snapshot.active_generation = Some(7);
        snapshot.active_tool_ids.insert("tool-live".to_string());
        snapshot.history = VecDeque::from([
            SnapshotHistoryEntry {
                sequence: 0,
                kind: SnapshotTimelineKind::Message,
                canonical_id: "message-1".to_string(),
                message: snapshot.messages.front().cloned(),
                tool: None,
            },
            SnapshotHistoryEntry {
                sequence: 1,
                kind: SnapshotTimelineKind::Tool,
                canonical_id: "tool-1".to_string(),
                message: None,
                tool: snapshot.tools.get("tool-1").cloned(),
            },
            SnapshotHistoryEntry {
                sequence: 2,
                kind: SnapshotTimelineKind::Reasoning,
                canonical_id: "reasoning-1".to_string(),
                message: snapshot.messages.back().cloned(),
                tool: None,
            },
        ]);
        snapshot.remeasure_history();

        assert_eq!(
            serde_json::to_value(BridgeThreadSnapshot::from(snapshot)).unwrap(),
            manifest["fixtures"]["threadSnapshot"]["acpSnapshot"]
        );
    }

    #[test]
    fn snapshot_pages_typed_history_and_reports_irretrievable_eviction() {
        let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
        for index in 0..=MAX_HISTORY_ENTRIES {
            snapshot.append_message(
                format!("message-{index}"),
                if index % 2 == 0 {
                    MessageRole::Agent
                } else {
                    MessageRole::Thought
                },
                "x".into(),
                None,
            );
        }
        let metadata = snapshot.collection_metadata(SnapshotTimelineKind::Message);
        assert!(metadata.truncated);
        assert!(metadata.omitted_count > 0);
        assert!(snapshot.continuation().unavailable_count > 0);

        let before_cursor = metadata.before_cursor.as_deref().unwrap();
        let older = snapshot
            .page(Some(before_cursor), None, MAX_SNAPSHOT_PAGE_SIZE + 1)
            .unwrap();
        assert!(older.entries.len() <= MAX_SNAPSHOT_PAGE_SIZE);
        assert!(older.entries.iter().all(|entry| entry.message.is_some()));
        assert!(older
            .entries
            .last()
            .is_some_and(|entry| entry.sequence < metadata.oldest_available_sequence.unwrap()));
        assert!(snapshot.page(Some("invalid"), None, 1).is_err());
        assert!(snapshot.page(Some("invalid"), Some("invalid"), 1).is_err());
    }

    #[test]
    fn snapshot_page_cursors_cover_forward_empty_and_revision_validation() {
        let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
        snapshot.append_message("message".into(), MessageRole::Agent, "answer".into(), None);
        snapshot.append_message(
            "reasoning".into(),
            MessageRole::Thought,
            "thought".into(),
            None,
        );
        snapshot.apply(&tool("tool", None, ToolCallStatus::Completed));

        let first = snapshot.page(None, None, 0).unwrap();
        assert_eq!(first.entries.len(), 1);
        assert!(first.has_more_after);
        assert!(!first.has_more_before);
        let reverse = snapshot
            .page(first.after_cursor.as_deref(), None, 1)
            .unwrap();
        assert!(reverse.entries.is_empty());
        let forward = snapshot
            .page(None, first.after_cursor.as_deref(), MAX_SNAPSHOT_PAGE_SIZE)
            .unwrap();
        assert_eq!(forward.entries.len(), 2);
        assert!(forward.has_more_before);
        assert!(forward
            .entries
            .iter()
            .any(|entry| entry.kind == SnapshotTimelineKind::Reasoning));
        assert!(forward
            .entries
            .iter()
            .any(|entry| entry.kind == SnapshotTimelineKind::Tool));
        assert!(!forward.has_more_after);

        let empty = snapshot
            .page(None, forward.after_cursor.as_deref(), 10)
            .unwrap();
        assert!(empty.entries.is_empty());
        assert!(empty.before_cursor.is_none());
        assert!(empty.after_cursor.is_none());
        assert!(!empty.has_more_before);
        assert!(!empty.has_more_after);

        let wrong_thread = SessionSnapshot::new("agent".into(), "other".into()).cursor(0);
        assert!(snapshot.page(Some(&wrong_thread), None, 1).is_err());
        let future_revision = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&SnapshotCursor {
                thread_id: "thread".into(),
                sequence: 0,
                revision: snapshot.next_sequence + 1,
            })
            .unwrap(),
        );
        assert!(snapshot.page(None, Some(&future_revision), 1).is_err());
        assert!(snapshot.page(None, Some("%%%"), 1).is_err());

        for kind in [
            SnapshotTimelineKind::Message,
            SnapshotTimelineKind::Reasoning,
            SnapshotTimelineKind::Tool,
        ] {
            let metadata = snapshot.collection_metadata(kind);
            assert!(!metadata.truncated);
            assert_eq!(metadata.omitted_count, 0);
            assert!(metadata.oldest_available_sequence.is_some());
            assert!(metadata.newest_sequence.is_some());
        }
    }

    #[test]
    fn empty_snapshot_and_before_earliest_cursor_report_no_available_entries() {
        let empty = SessionSnapshot::new("agent".into(), "empty".into());
        let continuation = empty.continuation();
        assert_eq!(continuation.unavailable_count, 0);
        assert_eq!(continuation.earliest_available_sequence, None);
        assert_eq!(continuation.latest_available_sequence, None);
        for kind in [
            SnapshotTimelineKind::Message,
            SnapshotTimelineKind::Reasoning,
            SnapshotTimelineKind::Tool,
        ] {
            let metadata = empty.collection_metadata(kind);
            assert!(!metadata.truncated);
            assert_eq!(metadata.omitted_count, 0);
            assert_eq!(metadata.oldest_available_sequence, None);
            assert_eq!(metadata.newest_sequence, None);
            assert_eq!(metadata.before_cursor, None);
        }
        let page = empty.page(None, None, 0).unwrap();
        assert!(page.entries.is_empty());
        assert!(!page.has_more_before);
        assert!(!page.has_more_after);

        let malformed_json = URL_SAFE_NO_PAD.encode(b"not-json");
        assert!(empty.page(Some(&malformed_json), None, 1).is_err());

        let mut populated = SessionSnapshot::new("agent".into(), "thread".into());
        populated.append_message("message".into(), MessageRole::Agent, "answer".into(), None);
        let before_earliest = populated.cursor(populated.history.front().unwrap().sequence);
        let page = populated.page(Some(&before_earliest), None, 1).unwrap();
        assert!(page.entries.is_empty());
        assert!(page.before_cursor.is_none());
        assert!(page.after_cursor.is_none());
    }

    #[test]
    fn history_eviction_accounts_for_each_timeline_kind() {
        let cases = [
            (SnapshotTimelineKind::Message, MessageRole::Agent),
            (SnapshotTimelineKind::Reasoning, MessageRole::Thought),
        ];
        for (kind, role) in cases {
            let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
            snapshot.push_timeline(kind, "entry".into());
            snapshot.attach_history_message(SnapshotMessage {
                id: "entry".into(),
                role,
                parts: vec![serde_json::json!({"type":"text","text":"x"})],
                truncated: false,
            });
            snapshot.history_bytes = MAX_HISTORY_BYTES + 1;
            snapshot.enforce_history_bounds();
            assert_eq!(snapshot.continuation().unavailable_count, 1);
        }

        let mut tools = SessionSnapshot::new("agent".into(), "thread".into());
        tools.push_timeline(SnapshotTimelineKind::Tool, "tool".into());
        tools.attach_or_update_history_tool(SnapshotTool {
            id: "tool".into(),
            generation: None,
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
            title: "Read".into(),
            content: String::new(),
            structured_content: Vec::new(),
            locations: Vec::new(),
            truncated: false,
        });
        tools.history_bytes = MAX_HISTORY_BYTES + 1;
        tools.enforce_history_bounds();
        assert_eq!(tools.continuation().unavailable_count, 1);

        let mut absent = SessionSnapshot::new("agent".into(), "absent".into());
        absent.update_history_message(&SnapshotMessage {
            id: "missing-message".into(),
            role: MessageRole::Agent,
            parts: Vec::new(),
            truncated: false,
        });
        absent.attach_or_update_history_tool(SnapshotTool {
            id: "missing-tool".into(),
            generation: None,
            kind: ToolKind::Read,
            status: ToolCallStatus::Completed,
            title: "Read".into(),
            content: String::new(),
            structured_content: Vec::new(),
            locations: Vec::new(),
            truncated: false,
        });
        assert!(absent.history.is_empty());
    }

    #[test]
    fn snapshot_bounds_collections_fields_and_unicode_text() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        for index in 0..=MAX_MESSAGES {
            snapshot.apply(&CanonicalEvent::MessageChunk {
                agent_id: "agent".to_string(),
                thread_id: "thread".to_string(),
                run_id: None,
                source_turn_id: None,
                generation: None,
                role: MessageRole::User,
                message_id: format!("message-{index}"),
                content: "x".to_string(),
                content_block: None,
            });
        }
        for index in 0..=MAX_TOOLS {
            snapshot.apply(&tool(
                &format!("tool-{index:03}"),
                None,
                ToolCallStatus::Pending,
            ));
        }
        assert_eq!(snapshot.messages.len(), MAX_MESSAGES);
        assert_eq!(snapshot.messages.front().unwrap().id, "message-1");
        assert_eq!(snapshot.tools.len(), MAX_TOOLS);
        assert!(!snapshot.tools.contains_key("tool-000"));
        snapshot.apply(&tool(
            &format!("tool-{MAX_TOOLS:03}"),
            None,
            ToolCallStatus::Completed,
        ));
        assert_eq!(snapshot.tools.len(), MAX_TOOLS);
        assert_eq!(
            snapshot.tools[&format!("tool-{MAX_TOOLS:03}")].status,
            ToolCallStatus::Completed
        );

        let mut nonlexical = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        nonlexical.active_generation = Some(1);
        nonlexical.apply(&tool("z-oldest", Some(1), ToolCallStatus::InProgress));
        nonlexical.apply(&tool("z-oldest", Some(1), ToolCallStatus::InProgress));
        for index in 1..MAX_TOOLS {
            nonlexical.apply(&tool(
                &format!("a-newer-{index:03}"),
                Some(1),
                ToolCallStatus::Pending,
            ));
        }
        nonlexical.apply(&tool("m-newest", Some(1), ToolCallStatus::Pending));
        assert!(!nonlexical.tools.contains_key("z-oldest"));
        assert!(!nonlexical.active_tool_ids.contains("z-oldest"));
        assert!(nonlexical.tools.contains_key("a-newer-001"));
        assert!(nonlexical.tools.contains_key("m-newest"));
        assert_eq!(
            nonlexical
                .timeline
                .iter()
                .filter(|entry| entry.canonical_id == "z-oldest")
                .count(),
            0
        );
        assert_eq!(nonlexical.timeline.len(), MAX_TOOLS);

        let unicode = format!("{}é", "x".repeat(MAX_TEXT_BYTES - 1));
        snapshot.apply(&CanonicalEvent::Mode {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            id: unicode,
        });
        assert_eq!(
            snapshot.mode_id.as_deref().unwrap().len(),
            MAX_TEXT_BYTES - 1
        );

        snapshot.title = Some("old".to_string());
        snapshot.updated_at = Some("old".to_string());
        let mut empty_metadata = SessionSnapshot::new("agent".to_string(), "empty".to_string());
        empty_metadata.apply(&CanonicalEvent::SessionInfo {
            agent_id: "agent".to_string(),
            thread_id: "empty".to_string(),
            title: FieldUpdate::Append("title".to_string()),
            updated_at: FieldUpdate::Append("time".to_string()),
        });
        assert_eq!(empty_metadata.title.as_deref(), Some("title"));
        assert_eq!(empty_metadata.updated_at.as_deref(), Some("time"));
        snapshot.apply(&CanonicalEvent::SessionInfo {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            title: FieldUpdate::Unchanged,
            updated_at: FieldUpdate::Clear,
        });
        snapshot.apply(&CanonicalEvent::SessionInfo {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            title: FieldUpdate::Set("new".to_string()),
            updated_at: FieldUpdate::Set("now".to_string()),
        });
        snapshot.apply(&CanonicalEvent::SessionInfo {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            title: FieldUpdate::Append(" title".to_string()),
            updated_at: FieldUpdate::Append(" later".to_string()),
        });
        assert_eq!(snapshot.title.as_deref(), Some("new title"));
        assert_eq!(snapshot.updated_at.as_deref(), Some("now later"));
    }

    #[test]
    fn snapshot_bounds_thousands_of_incremental_message_and_reasoning_chunks() {
        let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
        for role in [MessageRole::Agent, MessageRole::Thought] {
            let id = format!("{role:?}");
            for _ in 0..2_000 {
                snapshot.apply(&CanonicalEvent::MessageChunk {
                    agent_id: "agent".into(),
                    thread_id: "thread".into(),
                    run_id: None,
                    source_turn_id: None,
                    generation: None,
                    role,
                    message_id: id.clone(),
                    content: "é".repeat(128),
                    content_block: None,
                });
            }
            let message = snapshot
                .messages
                .iter()
                .find(|message| message.id == id)
                .unwrap();
            let text = message.parts[0]["text"].as_str().unwrap();
            assert!(text.len() <= MAX_TEXT_BYTES);
            assert!(text.is_char_boundary(text.len()));
            assert!(message.truncated);
        }
    }

    #[test]
    fn snapshot_bounds_mixed_parts_tool_fields_and_preserves_terminal_items() {
        let mut snapshot = SessionSnapshot::new("agent".into(), "thread".into());
        for index in 0..1_000 {
            snapshot.append_message(
                "mixed".into(),
                MessageRole::Agent,
                String::new(),
                Some(serde_json::json!({
                    "type": "resource",
                    "field": index,
                    "text": "x".repeat(MAX_STRUCTURED_PART_BYTES * 2),
                    "rawOutput": "secret"
                })),
            );
        }
        let message = snapshot.messages.back().unwrap();
        assert!(message.parts.len() <= MAX_MESSAGE_PARTS);
        assert!(message.truncated);
        assert!(!serde_json::to_string(message).unwrap().contains("secret"));

        for index in 0..1_000 {
            snapshot.apply_tool(
                "tool",
                None,
                ToolProjection {
                    kind: &ToolKind::Execute,
                    status: if index == 999 {
                        &ToolCallStatus::Completed
                    } else {
                        &ToolCallStatus::InProgress
                    },
                    title: "terminal",
                    content: &FieldUpdate::Append("é".repeat(256)),
                    structured_content: &FieldUpdate::Append(vec![serde_json::json!({
                        "type": if index == 999 { "terminal" } else { "diff" },
                        "terminalId": "terminal-1",
                        "oldText": "x".repeat(MAX_STRUCTURED_PART_BYTES * 2),
                        "rawInput": "secret"
                    })]),
                    locations: &FieldUpdate::Append(vec![serde_json::json!({
                        "path": "x".repeat(MAX_STRUCTURED_PART_BYTES * 2),
                        "line": index,
                        "rawOutput": "secret"
                    })]),
                },
            );
        }
        let tool = &snapshot.tools["tool"];
        assert!(tool.content.len() <= MAX_TOOL_TEXT_BYTES);
        assert!(tool.structured_content.len() <= MAX_TOOL_STRUCTURED_ITEMS);
        assert!(tool.locations.len() <= MAX_TOOL_LOCATIONS);
        assert!(tool.truncated);
        assert!(!serde_json::to_string(tool).unwrap().contains("secret"));
        assert_eq!(tool.status, ToolCallStatus::Completed);
    }

    #[test]
    fn accumulator_helpers_cover_clear_unchanged_exact_and_overflow_paths() {
        let mut parts = Vec::new();
        assert!(!append_message_text(&mut parts, "x".repeat(MAX_TEXT_BYTES)));
        assert!(append_message_text(&mut parts, "more".into()));
        parts.resize(MAX_MESSAGE_PARTS, serde_json::Value::Null);
        assert!(append_message_text(&mut parts, "new part".into()));
        assert!(append_structured_part(
            &mut parts,
            serde_json::json!({"ok": true})
        ));

        let mut text = "existing".to_string();
        assert!(!apply_tool_text(&mut text, &FieldUpdate::Unchanged));
        assert!(!apply_tool_text(&mut text, &FieldUpdate::Clear));
        assert!(text.is_empty());
        assert!(apply_tool_text(
            &mut text,
            &FieldUpdate::Set("x".repeat(MAX_TOOL_TEXT_BYTES + 1))
        ));
        assert!(apply_tool_text(
            &mut text,
            &FieldUpdate::Append("more".into())
        ));

        let mut values = vec![serde_json::json!({"old": true})];
        assert!(!apply_tool_values(&mut values, &FieldUpdate::Unchanged, 2));
        assert!(!apply_tool_values(&mut values, &FieldUpdate::Clear, 2));
        assert!(values.is_empty());
        assert!(apply_tool_values(
            &mut values,
            &FieldUpdate::Set(vec![
                serde_json::json!({"one": 1}),
                serde_json::json!({"two": 2}),
                serde_json::json!({"three": 3}),
            ]),
            2,
        ));

        let oversized_array = serde_json::Value::Array(
            (0..=MAX_STRUCTURED_FIELDS)
                .map(serde_json::Value::from)
                .collect(),
        );
        let (_, array_truncated) = bound_json(
            oversized_array,
            MAX_STRUCTURED_PART_BYTES,
            MAX_STRUCTURED_FIELDS,
        );
        assert!(array_truncated);
        let oversized_object = serde_json::Value::Object(
            (0..=MAX_STRUCTURED_FIELDS)
                .map(|index| (format!("key-{index}"), serde_json::Value::from(index)))
                .collect(),
        );
        let (_, object_truncated) = bound_json(
            oversized_object,
            MAX_STRUCTURED_PART_BYTES,
            MAX_STRUCTURED_FIELDS,
        );
        assert!(object_truncated);
    }

    #[test]
    fn snapshot_applies_plan_config_commands_usage_and_ignored_events() {
        let mut snapshot = SessionSnapshot::new("agent".to_string(), "thread".to_string());
        let oversized = "x".repeat(MAX_TEXT_BYTES + 1);
        snapshot.apply(&CanonicalEvent::Plan {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            entries: vec![
                PlanEntry {
                    content: oversized.clone(),
                    priority: oversized.clone(),
                    status: oversized.clone(),
                };
                MAX_ENTRIES + 1
            ],
        });
        snapshot.apply(&CanonicalEvent::Config {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            entries: vec![
                ConfigEntry {
                    id: oversized.clone(),
                    value: oversized.clone(),
                };
                MAX_ENTRIES + 1
            ],
        });
        snapshot.apply(&CanonicalEvent::Commands {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            commands: vec![
                CommandEntry {
                    name: oversized.clone(),
                    description: oversized.clone(),
                };
                MAX_ENTRIES + 1
            ],
        });
        snapshot.apply(&CanonicalEvent::Usage {
            agent_id: "agent".to_string(),
            thread_id: "thread".to_string(),
            used: 3,
            size: 10,
            cost: Some(oversized),
        });
        snapshot.apply(&CanonicalEvent::Ignored {
            agent_id: "agent".to_string(),
            thread_id: Some("thread".to_string()),
            kind: "ignored".to_string(),
        });
        assert_eq!(snapshot.plan.len(), MAX_ENTRIES);
        assert_eq!(snapshot.config.len(), MAX_ENTRIES);
        assert_eq!(snapshot.commands.len(), MAX_ENTRIES);
        assert_eq!(snapshot.plan[0].content.len(), MAX_TEXT_BYTES);
        assert_eq!(snapshot.config[0].id.len(), MAX_TEXT_BYTES);
        assert_eq!(snapshot.commands[0].name.len(), MAX_TEXT_BYTES);
        assert_eq!(snapshot.usage_used, Some(3));
        assert_eq!(snapshot.usage_size, Some(10));
        assert_eq!(
            snapshot.usage_cost.as_deref().unwrap().len(),
            MAX_TEXT_BYTES
        );
    }
}
