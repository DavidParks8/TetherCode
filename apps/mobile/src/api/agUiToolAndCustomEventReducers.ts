import { SUBAGENT_ACTIVITY_TYPE } from "./messages";
import {
  applyJsonPatch,
  nonEmptyString,
  record,
  timestampIso,
  upsertToolCall,
} from "./agUiReducerUtilities";
import {
  findMessage,
  reduceStructuredMessageContent,
  reduceSubagentActivity,
  reduceToolContent,
  reduceToolText,
} from "./agUiStructuredAndTerminalReducers";
import { startToolCall, upsertMessage } from "./agUiMessageMutations";
import {
  type AGUIEvent,
  EventType,
  type Message,
  type ToolMessage,
} from "@ag-ui/core";
import { type AgUiEventEnvelope } from "./agUi";
import {
  type AgUiThreadMessageState,
  MAX_CUSTOM_METADATA_ENTRIES,
  MAX_MESSAGES_PER_THREAD,
} from "./agUiMessagesState";
import { type ChatMessage } from "./types";

export function appendToolArgs(
  current: AgUiThreadMessageState,
  runId: string,
  toolCallId: string,
  delta: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const messageId =
    current.toolCallMessageIdByCallId[toolCallId] ?? `tool-call:${toolCallId}`;
  const started = current.toolCallMessageIdByCallId[toolCallId]
    ? current
    : startToolCall(current, runId, toolCallId, "tool", undefined, timestamp);
  const message = findMessage(started, messageId);
  if (!message || message.role !== "assistant") return started;
  const existing = message.toolCalls?.find((call) => call.id === toolCallId);
  return upsertMessage(
    started,
    {
      ...message,
      toolCalls: upsertToolCall(
        message.toolCalls ?? [],
        toolCallId,
        existing?.function.name ?? "tool",
        `${existing?.function.arguments ?? ""}${delta}`,
      ),
    },
    runId,
    timestamp,
  );
}

export function upsertToolResult(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  toolCallId: string,
  content: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const toolMessage: ToolMessage & { createdAt: string } = {
    id: messageId,
    role: "tool",
    toolCallId,
    content,
    createdAt: timestampIso(timestamp),
  };
  const next = upsertMessage(current, toolMessage, runId, timestamp);
  return {
    ...next,
    toolResultMessageIdByCallId: {
      ...next.toolResultMessageIdByCallId,
      [toolCallId]: messageId,
    },
  };
}

export function applyMessagesSnapshot(
  current: AgUiThreadMessageState,
  runId: string,
  messages: Message[],
  timestamp?: number,
): AgUiThreadMessageState {
  const snapshotSubagentIds = messages.reduce<Record<string, true>>(
    (ids, message) => {
      if (
        message.role === "activity" &&
        message.activityType === SUBAGENT_ACTIVITY_TYPE
      ) {
        const content = record(message.content);
        const subAgent = record(content?.subAgent);
        const toolCallId = nonEmptyString(subAgent?.toolCallId);
        if (toolCallId) ids[toolCallId] = true;
      }
      return ids;
    },
    { ...current.subagentToolCallIds },
  );
  const previous = new Map(
    current.messages.map((message) => [message.id, message]),
  );
  const nextMessages = messages
    .filter(
      (message) => !messageUsesSuppressedTool(message, snapshotSubagentIds),
    )
    .map(
      (message) =>
        ({
          ...message,
          createdAt:
            previous.get(message.id)?.createdAt ?? timestampIso(timestamp),
          parts: previous.get(message.id)?.parts,
        }) as ChatMessage,
    );
  return {
    ...current,
    messages: nextMessages.slice(-MAX_MESSAGES_PER_THREAD),
    authoritativeSnapshot: true,
    runByMessageId: Object.fromEntries(
      nextMessages.map((message) => [message.id, runId]),
    ),
    terminalMessageIds: nextMessages.map((message) => message.id),
    subagentToolCallIds: snapshotSubagentIds,
  };
}

export function messageUsesSuppressedTool(
  message: Message,
  suppressed: Record<string, true>,
): boolean {
  if (message.role === "tool") {
    return Boolean(suppressed[message.toolCallId]);
  }
  if (message.role === "assistant") {
    return (message.toolCalls ?? []).some((call) => suppressed[call.id]);
  }
  return false;
}

export function applyActivityDelta(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  activityType: string,
  patch: unknown[],
  timestamp?: number,
): AgUiThreadMessageState {
  const existing = findMessage(current, messageId);
  const content = existing?.role === "activity" ? existing.content : {};
  return upsertMessage(
    current,
    {
      id: messageId,
      role: "activity",
      activityType,
      content: applyJsonPatch(content, patch) as Record<string, unknown>,
      createdAt: existing?.createdAt ?? timestampIso(timestamp),
    },
    runId,
    timestamp,
  );
}

export function reduceCustomEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  const event = envelope.event;
  if (event.type !== EventType.CUSTOM) return current;
  const value = record(event.value);
  if (event.name.endsWith("-chunk")) {
    return reduceCustomChunk(current, envelope, value);
  }
  if (event.name === "tethercode.dev/message-content") {
    return reduceStructuredMessageContent(current, envelope, value);
  }
  if (event.name === "tethercode.dev/tool-text") {
    return reduceToolText(current, envelope, value);
  }
  if (event.name === "tethercode.dev/tool-content") {
    return reduceToolContent(current, envelope, value);
  }
  if (event.name === "tethercode.dev/subagent") {
    return reduceSubagentActivity(current, envelope, value);
  }
  return storeCustomMetadata(current, event.name, event.value);
}

export function reduceCustomChunk(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null,
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.CUSTOM) return current;
  const customName = envelope.event.name;
  const canonicalId = nonEmptyString(value?.canonicalId);
  const revision = nonEmptyString(value?.revision);
  const index = typeof value?.index === "number" ? value.index : -1;
  const count = typeof value?.count === "number" ? value.count : 0;
  const data = typeof value?.data === "string" ? value.data : null;
  if (!canonicalId || !revision || index < 0 || index >= count || !data)
    return current;
  const key = `${customName}\0${revision}`;
  const existing = current.chunkAssemblies[key];
  const chunks =
    existing?.count === count
      ? { ...existing.chunks, [index]: data }
      : { [index]: data };
  const pending = {
    ...current,
    chunkAssemblies: { ...current.chunkAssemblies, [key]: { count, chunks } },
  };
  if (Object.keys(chunks).length !== count) return pending;
  try {
    const event = {
      type: EventType.CUSTOM,
      name: customName.slice(0, -"-chunk".length),
      value: JSON.parse(
        Array.from(
          { length: count },
          (_, chunkIndex) => chunks[chunkIndex],
        ).join(""),
      ),
    } as AGUIEvent;
    const completed = reduceCustomEvent(pending, { ...envelope, event });
    const chunkAssemblies = { ...completed.chunkAssemblies };
    delete chunkAssemblies[key];
    return { ...completed, chunkAssemblies };
  } catch {
    return pending;
  }
}

export function storeCustomMetadata(
  current: AgUiThreadMessageState,
  name: string,
  value: unknown,
): AgUiThreadMessageState {
  const order = current.customMetadataOrder.filter((entry) => entry !== name);
  order.push(name);
  while (order.length > MAX_CUSTOM_METADATA_ENTRIES) order.shift();
  const customMetadata = Object.fromEntries(
    order.map((entry) => [
      entry,
      entry === name ? value : current.customMetadata[entry],
    ]),
  );
  return { ...current, customMetadata, customMetadataOrder: order };
}
