import { EventType } from "@ag-ui/core";
import {
  appendText,
  appendToolResult,
  reduceActivitySnapshot,
  rememberReplacement,
  startToolCall,
  textMessage,
  upsertMessage,
} from "./agUiMessageMutations";
import {
  appendToolArgs,
  applyActivityDelta,
  applyMessagesSnapshot,
  reduceCustomEvent,
} from "./agUiToolAndCustomEventReducers";
import {
  applyJsonPatch,
  nonEmptyString,
  record,
  timestampIso,
} from "./agUiReducerUtilities";
import {
  findMessage,
  markRunTerminal,
  markTerminal,
  updateEncryptedValue,
} from "./agUiStructuredAndTerminalReducers";
import { type AgUiEventEnvelope } from "./agUi";
import {
  type AgUiThreadMessageState,
  createAgUiThreadMessageState,
  MAX_RAW_EVENTS_PER_THREAD,
} from "./agUiMessagesState";

export function reduceThreadState(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
): AgUiThreadMessageState {
  const event = envelope.event;
  switch (event.type) {
    case EventType.RUN_STARTED:
      return createAgUiThreadMessageState();
    case EventType.TEXT_MESSAGE_START: {
      const started = findMessage(current, event.messageId)
        ? current
        : upsertMessage(
            current,
            textMessage(event.messageId, event.role, "", event.name),
            envelope.runId,
            event.timestamp,
          );
      return rememberReplacement(
        started,
        event.messageId,
        nonEmptyString(record(event)?.replacesMessageId),
      );
    }
    case EventType.TEXT_MESSAGE_CONTENT:
      return appendText(
        current,
        event.messageId,
        event.delta,
        envelope.runId,
        event.timestamp,
        "assistant",
      );
    case EventType.TEXT_MESSAGE_END:
      return markTerminal(current, event.messageId);
    case EventType.TEXT_MESSAGE_CHUNK: {
      const messageId = event.messageId ?? `${envelope.runId}:text`;
      let next = current;
      if (!findMessage(next, messageId)) {
        next = upsertMessage(
          next,
          textMessage(messageId, event.role ?? "assistant", "", event.name),
          envelope.runId,
          event.timestamp,
        );
      }
      return event.delta
        ? appendText(
            next,
            messageId,
            event.delta,
            envelope.runId,
            event.timestamp,
            event.role ?? "assistant",
          )
        : next;
    }
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
      return findMessage(current, event.messageId)
        ? current
        : upsertMessage(
            current,
            {
              id: event.messageId,
              role: "reasoning",
              content: "",
              createdAt: timestampIso(event.timestamp),
            },
            envelope.runId,
            event.timestamp,
          );
    case EventType.REASONING_MESSAGE_CONTENT:
      return appendText(
        current,
        event.messageId,
        event.delta,
        envelope.runId,
        event.timestamp,
        "reasoning",
      );
    case EventType.REASONING_MESSAGE_CHUNK: {
      const messageId = event.messageId ?? `${envelope.runId}:reasoning`;
      const next = findMessage(current, messageId)
        ? current
        : upsertMessage(
            current,
            {
              id: messageId,
              role: "reasoning",
              content: "",
              createdAt: timestampIso(event.timestamp),
            },
            envelope.runId,
            event.timestamp,
          );
      return event.delta
        ? appendText(
            next,
            messageId,
            event.delta,
            envelope.runId,
            event.timestamp,
            "reasoning",
          )
        : next;
    }
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_END:
      return markTerminal(current, event.messageId);
    case EventType.REASONING_ENCRYPTED_VALUE:
      return updateEncryptedValue(
        current,
        event.entityId,
        event.encryptedValue,
        event.subtype,
      );
    case EventType.TOOL_CALL_START:
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      return startToolCall(
        current,
        envelope.runId,
        event.toolCallId,
        event.toolCallName,
        event.parentMessageId,
        event.timestamp,
      );
    case EventType.TOOL_CALL_ARGS:
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      return appendToolArgs(
        current,
        envelope.runId,
        event.toolCallId,
        event.delta,
        event.timestamp,
      );
    case EventType.TOOL_CALL_END: {
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      const messageId = current.toolCallMessageIdByCallId[event.toolCallId];
      return messageId ? markTerminal(current, messageId) : current;
    }
    case EventType.TOOL_CALL_CHUNK: {
      if (!event.toolCallId) return current;
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      let next = current;
      if (!current.toolCallMessageIdByCallId[event.toolCallId]) {
        next = startToolCall(
          next,
          envelope.runId,
          event.toolCallId,
          event.toolCallName ?? "tool",
          event.parentMessageId,
          event.timestamp,
        );
      }
      return event.delta
        ? appendToolArgs(
            next,
            envelope.runId,
            event.toolCallId,
            event.delta,
            event.timestamp,
          )
        : next;
    }
    case EventType.TOOL_CALL_RESULT:
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      return appendToolResult(
        current,
        envelope.runId,
        event.messageId,
        event.toolCallId,
        event.content,
        event.timestamp,
      );
    case EventType.MESSAGES_SNAPSHOT:
      return applyMessagesSnapshot(
        current,
        envelope.runId,
        event.messages,
        event.timestamp,
      );
    case EventType.ACTIVITY_SNAPSHOT:
      return reduceActivitySnapshot(
        current,
        envelope.runId,
        event.messageId,
        event.activityType,
        event.content,
        event.timestamp,
      );
    case EventType.ACTIVITY_DELTA:
      return applyActivityDelta(
        current,
        envelope.runId,
        event.messageId,
        event.activityType,
        event.patch,
        event.timestamp,
      );
    case EventType.STATE_SNAPSHOT:
      return { ...current, state: event.snapshot };
    case EventType.STATE_DELTA:
      return { ...current, state: applyJsonPatch(current.state, event.delta) };
    case EventType.STEP_STARTED:
      return {
        ...current,
        steps: { ...current.steps, [event.stepName]: "running" },
      };
    case EventType.STEP_FINISHED:
      return {
        ...current,
        steps: { ...current.steps, [event.stepName]: "finished" },
      };
    case EventType.RAW:
      return {
        ...current,
        rawEvents: [
          ...current.rawEvents,
          { source: event.source, event: event.event },
        ].slice(-MAX_RAW_EVENTS_PER_THREAD),
      };
    case EventType.CUSTOM:
      return reduceCustomEvent(current, envelope);
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
      return markRunTerminal(current, envelope.runId);
    default:
      return current;
  }
}
