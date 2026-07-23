import {
  appendOrderedPart,
  nonEmptyString,
  record,
  renderOrderedParts,
  timestampIso,
  upsertToolCall,
} from "./agUiReducerUtilities";
import {
  createActivityMessage,
  getMessageText,
  SUBAGENT_ACTIVITY_TYPE,
} from "./messages";
import { findMessage, toolCall } from "./agUiStructuredAndTerminalReducers";
import {
  type AgUiThreadMessageState,
  MAX_MESSAGES_PER_THREAD,
} from "./agUiMessagesState";
import { type AssistantMessage } from "@ag-ui/core";
import { type ChatMessage } from "./types";
import { upsertToolResult } from "./agUiToolAndCustomEventReducers";

export function rememberReplacement(
  current: AgUiThreadMessageState,
  messageId: string,
  replacesMessageId: string | null,
): AgUiThreadMessageState {
  if (!replacesMessageId) return current;
  return {
    ...current,
    replacesMessageIdByMessageId: {
      ...current.replacesMessageIdByMessageId,
      [messageId]: replacesMessageId,
    },
  };
}

export function textMessage(
  id: string,
  role: "developer" | "system" | "assistant" | "user",
  content: string,
  name?: string,
): ChatMessage {
  const base = {
    id,
    content,
    createdAt: new Date().toISOString(),
    ...(name ? { name } : {}),
  };
  switch (role) {
    case "developer":
      return { ...base, role: "developer" };
    case "system":
      return { ...base, role: "system" };
    case "user":
      return { ...base, role: "user" };
    default:
      return { ...base, role: "assistant" };
  }
}

export function upsertMessage(
  current: AgUiThreadMessageState,
  message: ChatMessage,
  runId: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const index = current.messages.findIndex((entry) => entry.id === message.id);
  const existing = index >= 0 ? current.messages[index] : undefined;
  const nextMessage: ChatMessage = {
    ...message,
    createdAt: existing?.createdAt ?? timestampIso(timestamp),
  } as ChatMessage;
  const messages =
    index >= 0
      ? current.messages.map((entry, entryIndex) =>
          entryIndex === index ? nextMessage : entry,
        )
      : [...current.messages, nextMessage];
  return {
    ...current,
    messages: messages.slice(-MAX_MESSAGES_PER_THREAD),
    runByMessageId: { ...current.runByMessageId, [message.id]: runId },
  };
}

export function appendText(
  current: AgUiThreadMessageState,
  messageId: string,
  delta: string,
  runId: string,
  timestamp: number | undefined,
  defaultRole: "developer" | "system" | "assistant" | "user" | "reasoning",
): AgUiThreadMessageState {
  const existing = findMessage(current, messageId);
  if (defaultRole !== "reasoning" && existing?.role !== "reasoning") {
    const parts = appendOrderedPart(existing?.parts ?? [], {
      type: "text",
      text: delta,
    });
    const content = renderOrderedParts(parts);
    const message = existing
      ? ({ ...withText(existing, content), parts } as ChatMessage)
      : ({
          ...textMessage(messageId, defaultRole, content),
          parts,
        } as ChatMessage);
    return upsertMessage(current, message, runId, timestamp);
  }
  const content = `${existing ? getMessageText(existing) : ""}${delta}`;
  if (existing) {
    return upsertMessage(
      current,
      withText(existing, content),
      runId,
      timestamp,
    );
  }
  if (defaultRole === "reasoning") {
    return upsertMessage(
      current,
      {
        id: messageId,
        role: "reasoning",
        content,
        createdAt: timestampIso(timestamp),
      },
      runId,
      timestamp,
    );
  }
  return upsertMessage(
    current,
    textMessage(messageId, defaultRole, content),
    runId,
    timestamp,
  );
}

export function appendToolResult(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  toolCallId: string,
  delta: string,
  timestamp?: number,
): AgUiThreadMessageState {
  const previousId = current.toolResultMessageIdByCallId[toolCallId];
  const previous = previousId ? findMessage(current, previousId) : undefined;
  const previousText = previous?.role === "tool" ? previous.content : "";
  const withoutPrevious =
    previousId && previousId !== messageId
      ? {
          ...current,
          messages: current.messages.filter(
            (message) => message.id !== previousId,
          ),
        }
      : current;
  return upsertToolResult(
    withoutPrevious,
    runId,
    messageId,
    toolCallId,
    `${previousText}${delta}`,
    timestamp,
  );
}

export function reduceActivitySnapshot(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  activityType: string,
  content: Record<string, unknown>,
  timestamp?: number,
): AgUiThreadMessageState {
  const subAgent =
    activityType === SUBAGENT_ACTIVITY_TYPE ? record(content.subAgent) : null;
  const toolCallId = nonEmptyString(subAgent?.toolCallId);
  const withoutGenericTool = toolCallId
    ? {
        ...current,
        messages: current.messages.filter(
          (message) =>
            message.id !== current.toolCallMessageIdByCallId[toolCallId] &&
            message.id !== current.toolResultMessageIdByCallId[toolCallId],
        ),
      }
    : current;
  const withSuppressedTool = toolCallId
    ? {
        ...withoutGenericTool,
        subagentToolCallIds: {
          ...withoutGenericTool.subagentToolCallIds,
          [toolCallId]: true as const,
        },
      }
    : withoutGenericTool;
  return upsertMessage(
    withSuppressedTool,
    createActivityMessage(
      messageId,
      activityType,
      content as { text: string; [key: string]: unknown },
      timestampIso(timestamp),
    ),
    runId,
    timestamp,
  );
}

export function withText(message: ChatMessage, content: string): ChatMessage {
  if (message.role === "activity") {
    return { ...message, content: { ...message.content, text: content } };
  }
  if (message.role === "assistant") {
    return { ...message, content };
  }
  if (message.role === "user") {
    return { ...message, content };
  }
  return { ...message, content } as ChatMessage;
}

export function startToolCall(
  current: AgUiThreadMessageState,
  runId: string,
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string | undefined,
  timestamp?: number,
): AgUiThreadMessageState {
  const messageId = parentMessageId ?? `tool-call:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const assistant: AssistantMessage & { createdAt: string } =
    existing?.role === "assistant"
      ? {
          ...existing,
          toolCalls: upsertToolCall(
            existing.toolCalls ?? [],
            toolCallId,
            toolCallName,
            "",
          ),
        }
      : {
          id: messageId,
          role: "assistant",
          content: "",
          toolCalls: [toolCall(toolCallId, toolCallName, "")],
          createdAt: timestampIso(timestamp),
        };
  const next = upsertMessage(current, assistant, runId, timestamp);
  return {
    ...next,
    toolCallMessageIdByCallId: {
      ...next.toolCallMessageIdByCallId,
      [toolCallId]: messageId,
    },
  };
}
