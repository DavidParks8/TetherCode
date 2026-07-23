import {
  appendOrderedPart,
  nonEmptyString,
  renderOrderedParts,
  timestampIso,
} from "./agUiReducerUtilities";
import { createActivityMessage, SUBAGENT_ACTIVITY_TYPE } from "./messages";
import { renderAgUiCustomContent } from "./agUiContent";
import { type AgUiEventEnvelope } from "./agUi";
import { type AgUiThreadMessageState } from "./agUiMessagesState";
import { type ChatMessage, type ChatMessageSubAgentMeta } from "./types";
import { type ToolCall } from "@ag-ui/core";
import { upsertMessage } from "./agUiMessageMutations";
import { upsertToolResult } from "./agUiToolAndCustomEventReducers";

export function reduceStructuredMessageContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const messageId =
    nonEmptyString(value?.messageId) ?? `${envelope.runId}:content`;
  const role =
    value?.role === "thought"
      ? "reasoning"
      : value?.role === "user"
        ? "user"
        : "assistant";
  const existing = findMessage(current, messageId);
  const parts = appendOrderedPart(existing?.parts ?? [], value?.content);
  const text = renderOrderedParts(parts);
  const base: ChatMessage =
    role === "reasoning"
      ? {
          id: messageId,
          role: "reasoning",
          content: text,
          createdAt: timestampIso(envelope.event.timestamp),
          parts,
        }
      : role === "user"
        ? {
            id: messageId,
            role: "user",
            content: text,
            createdAt: timestampIso(envelope.event.timestamp),
            parts,
          }
        : {
            id: messageId,
            role: "assistant",
            content: text,
            createdAt: timestampIso(envelope.event.timestamp),
            parts,
          };
  return upsertMessage(current, base, envelope.runId, envelope.event.timestamp);
}

export function reduceToolText(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId);
  if (toolCallId && current.subagentToolCallIds[toolCallId]) return current;
  const revision = nonEmptyString(value?.revision);
  const content = typeof value?.content === "string" ? value.content : null;
  if (!toolCallId || !revision || content === null) return current;
  if (current.toolTextRevisionByCallId[toolCallId] === revision) return current;
  const messageId =
    current.toolResultMessageIdByCallId[toolCallId] ??
    `tool-result:${toolCallId}`;
  const structured = current.structuredTextByCallId[toolCallId] ?? "";
  const next = upsertToolResult(
    current,
    envelope.runId,
    messageId,
    toolCallId,
    [content, structured].filter(Boolean).join("\n"),
    envelope.event.timestamp,
  );
  return {
    ...next,
    toolTextRevisionByCallId: {
      ...next.toolTextRevisionByCallId,
      [toolCallId]: revision,
    },
  };
}

export function reduceToolContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId) ?? "unknown";
  if (current.subagentToolCallIds[toolCallId]) return current;
  const revision = nonEmptyString(value?.revision) ?? JSON.stringify(value);
  if (current.structuredRevisionByCallId[toolCallId] === revision)
    return current;
  const structured =
    Array.isArray(value?.content) &&
    value.content.length === 0 &&
    Array.isArray(value?.locations) &&
    value.locations.length === 0
      ? ""
      : renderAgUiCustomContent(value);
  const messageId =
    current.toolResultMessageIdByCallId[toolCallId] ??
    `tool-result:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const existingText = existing?.role === "tool" ? existing.content : "";
  const previousStructured = current.structuredTextByCallId[toolCallId] ?? "";
  const base =
    previousStructured && existingText.endsWith(previousStructured)
      ? existingText.slice(0, -previousStructured.length).trimEnd()
      : existingText;
  const next = upsertToolResult(
    current,
    envelope.runId,
    messageId,
    toolCallId,
    [base, structured].filter(Boolean).join("\n"),
    envelope.event.timestamp,
  );
  return {
    ...next,
    structuredRevisionByCallId: {
      ...next.structuredRevisionByCallId,
      [toolCallId]: revision,
    },
    structuredTextByCallId: {
      ...next.structuredTextByCallId,
      [toolCallId]: structured,
    },
  };
}

export function reduceSubagentActivity(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId) ?? "unknown";
  const receiverThreadIds = Array.isArray(value?.receiverThreadIds)
    ? value.receiverThreadIds
        .map(nonEmptyString)
        .filter((id): id is string => Boolean(id))
    : [];
  if (receiverThreadIds.length === 0) return current;
  const meta: ChatMessageSubAgentMeta = {
    toolCallId,
    tool: nonEmptyString(value?.tool) ?? "spawnAgent",
    senderThreadId: nonEmptyString(value?.senderThreadId) ?? envelope.threadId,
    receiverThreadIds: Array.from(new Set(receiverThreadIds)),
    agentStatus: nonEmptyString(value?.agentStatus) ?? undefined,
    navigable: false,
  };
  const resultPreview = nonEmptyString(value?.resultPreview);
  const text = [
    meta.agentStatus === "completed"
      ? "• Spawned sub-agent"
      : "• Spawning sub-agent",
    `  Thread: ${receiverThreadIds[0]}`,
    meta.agentStatus ? `  Status: ${meta.agentStatus}` : null,
    resultPreview ? `  Result: ${resultPreview}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const messages = current.messages.filter(
    (message) =>
      !(
        message.id === `tool-call:${toolCallId}` ||
        message.id === `tool-result:${toolCallId}` ||
        message.id === `subagent:${toolCallId}`
      ),
  );
  return upsertMessage(
    {
      ...current,
      messages,
      subagentToolCallIds: {
        ...current.subagentToolCallIds,
        [toolCallId]: true,
      },
    },
    createActivityMessage(
      `subagent:${toolCallId}`,
      SUBAGENT_ACTIVITY_TYPE,
      { text, subAgent: meta },
      timestampIso(envelope.event.timestamp),
    ),
    envelope.runId,
    envelope.event.timestamp,
  );
}

export function markTerminal(
  current: AgUiThreadMessageState,
  messageId: string,
): AgUiThreadMessageState {
  if (current.terminalMessageIds.includes(messageId)) return current;
  return {
    ...current,
    terminalMessageIds: [...current.terminalMessageIds, messageId],
  };
}

export function markRunTerminal(
  current: AgUiThreadMessageState,
  runId: string,
): AgUiThreadMessageState {
  const ids = Object.entries(current.runByMessageId)
    .filter(([, messageRunId]) => messageRunId === runId)
    .map(([messageId]) => messageId);
  if (ids.length === 0) return current;
  return {
    ...current,
    terminalMessageIds: Array.from(
      new Set([...current.terminalMessageIds, ...ids]),
    ),
  };
}

export function updateEncryptedValue(
  current: AgUiThreadMessageState,
  entityId: string,
  encryptedValue: string,
  subtype: "tool-call" | "message",
): AgUiThreadMessageState {
  if (subtype === "message") {
    const message = findMessage(current, entityId);
    return message
      ? upsertMessage(
          current,
          { ...message, encryptedValue } as ChatMessage,
          current.runByMessageId[entityId] ?? "",
          undefined,
        )
      : current;
  }
  const messageId = current.toolCallMessageIdByCallId[entityId];
  const message = messageId ? findMessage(current, messageId) : undefined;
  if (!message || message.role !== "assistant") return current;
  return upsertMessage(
    current,
    {
      ...message,
      toolCalls: message.toolCalls?.map((call) =>
        call.id === entityId ? { ...call, encryptedValue } : call,
      ),
    },
    current.runByMessageId[message.id] ?? "",
    undefined,
  );
}

export function findMessage(
  current: AgUiThreadMessageState,
  id: string,
): ChatMessage | undefined {
  return current.messages.find((message) => message.id === id);
}

export function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: "function", function: { name, arguments: args } };
}
