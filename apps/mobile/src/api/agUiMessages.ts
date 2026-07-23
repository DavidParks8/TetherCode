import {
  EventType,
  type AGUIEvent,
  type AssistantMessage,
  type Message,
  type ToolCall,
  type ToolMessage,
} from '@ag-ui/core';

import {
  createActivityMessage,
  getMessageText,
  SUBAGENT_ACTIVITY_TYPE,
} from './messages';
import type { AgUiEventEnvelope } from './agUi';
import { renderAgUiCustomContent } from './agUiContent';
import type { ChatMessage, ChatMessagePart, ChatMessageSubAgentMeta } from './types';

export interface AgUiChunkAssembly {
  count: number;
  chunks: Record<number, string>;
}

export interface AgUiThreadMessageState {
  messages: ChatMessage[];
  authoritativeSnapshot: boolean;
  runByMessageId: Record<string, string>;
  terminalMessageIds: string[];
  replacesMessageIdByMessageId: Record<string, string>;
  toolCallMessageIdByCallId: Record<string, string>;
  toolResultMessageIdByCallId: Record<string, string>;
  subagentToolCallIds: Record<string, true>;
  toolTextRevisionByCallId: Record<string, string>;
  structuredRevisionByCallId: Record<string, string>;
  structuredTextByCallId: Record<string, string>;
  chunkAssemblies: Record<string, AgUiChunkAssembly>;
  state: unknown;
  steps: Record<string, 'running' | 'finished'>;
  rawEvents: unknown[];
  customMetadata: Record<string, unknown>;
  customMetadataOrder: string[];
}

export type AgUiMessageState = Record<string, AgUiThreadMessageState>;

const MAX_MESSAGES_PER_THREAD = 128;
const MAX_RAW_EVENTS_PER_THREAD = 128;
const MAX_CUSTOM_METADATA_ENTRIES = 128;

export const SUPPORTED_AG_UI_EVENT_TYPES = new Set<EventType>([
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_END,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_CHUNK,
  EventType.TOOL_CALL_RESULT,
  EventType.THINKING_START,
  EventType.THINKING_END,
  EventType.THINKING_TEXT_MESSAGE_START,
  EventType.THINKING_TEXT_MESSAGE_CONTENT,
  EventType.THINKING_TEXT_MESSAGE_END,
  EventType.STATE_SNAPSHOT,
  EventType.STATE_DELTA,
  EventType.MESSAGES_SNAPSHOT,
  EventType.ACTIVITY_SNAPSHOT,
  EventType.ACTIVITY_DELTA,
  EventType.RAW,
  EventType.CUSTOM,
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.RUN_ERROR,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_MESSAGE_CHUNK,
  EventType.REASONING_END,
  EventType.REASONING_ENCRYPTED_VALUE,
]);

export function createAgUiThreadMessageState(): AgUiThreadMessageState {
  return {
    messages: [],
    authoritativeSnapshot: false,
    runByMessageId: {},
    terminalMessageIds: [],
    replacesMessageIdByMessageId: {},
    toolCallMessageIdByCallId: {},
    toolResultMessageIdByCallId: {},
    subagentToolCallIds: {},
    toolTextRevisionByCallId: {},
    structuredRevisionByCallId: {},
    structuredTextByCallId: {},
    chunkAssemblies: {},
    state: null,
    steps: {},
    rawEvents: [],
    customMetadata: {},
    customMetadataOrder: [],
  };
}

export function reduceAgUiMessageState(
  previous: AgUiMessageState,
  envelope: AgUiEventEnvelope
): AgUiMessageState {
  const current = previous[envelope.threadId] ?? createAgUiThreadMessageState();
  const next = reduceThreadState(current, envelope);
  if (next === current) {
    return previous;
  }
  return { ...previous, [envelope.threadId]: next };
}

function reduceThreadState(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope
): AgUiThreadMessageState {
  const event = envelope.event;
  switch (event.type) {
    case EventType.RUN_STARTED:
      return createAgUiThreadMessageState();
    case EventType.TEXT_MESSAGE_START: {
      const started = findMessage(current, event.messageId)
        ? current
        : upsertMessage(current, textMessage(event.messageId, event.role, '', event.name), envelope.runId, event.timestamp);
      return rememberReplacement(
        started,
        event.messageId,
        nonEmptyString(record(event)?.replacesMessageId)
      );
    }
    case EventType.TEXT_MESSAGE_CONTENT:
      return appendText(current, event.messageId, event.delta, envelope.runId, event.timestamp, 'assistant');
    case EventType.TEXT_MESSAGE_END:
      return markTerminal(current, event.messageId);
    case EventType.TEXT_MESSAGE_CHUNK: {
      const messageId = event.messageId ?? `${envelope.runId}:text`;
      let next = current;
      if (!findMessage(next, messageId)) {
        next = upsertMessage(next, textMessage(messageId, event.role ?? 'assistant', '', event.name), envelope.runId, event.timestamp);
      }
      return event.delta ? appendText(next, messageId, event.delta, envelope.runId, event.timestamp, event.role ?? 'assistant') : next;
    }
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START:
      return findMessage(current, event.messageId) ? current : upsertMessage(current, {
        id: event.messageId,
        role: 'reasoning',
        content: '',
        createdAt: timestampIso(event.timestamp),
      }, envelope.runId, event.timestamp);
    case EventType.REASONING_MESSAGE_CONTENT:
      return appendText(current, event.messageId, event.delta, envelope.runId, event.timestamp, 'reasoning');
    case EventType.REASONING_MESSAGE_CHUNK: {
      const messageId = event.messageId ?? `${envelope.runId}:reasoning`;
      const next = findMessage(current, messageId)
        ? current
        : upsertMessage(current, {
            id: messageId,
            role: 'reasoning',
            content: '',
            createdAt: timestampIso(event.timestamp),
          }, envelope.runId, event.timestamp);
      return event.delta ? appendText(next, messageId, event.delta, envelope.runId, event.timestamp, 'reasoning') : next;
    }
    case EventType.REASONING_MESSAGE_END:
    case EventType.REASONING_END:
      return markTerminal(current, event.messageId);
    case EventType.REASONING_ENCRYPTED_VALUE:
      return updateEncryptedValue(current, event.entityId, event.encryptedValue, event.subtype);
    case EventType.THINKING_START:
    case EventType.THINKING_TEXT_MESSAGE_START: {
      const messageId = `${envelope.runId}:thinking`;
      return findMessage(current, messageId) ? current : upsertMessage(current, {
        id: messageId,
        role: 'reasoning',
        content: event.type === EventType.THINKING_START ? event.title ?? '' : '',
        createdAt: timestampIso(event.timestamp),
      }, envelope.runId, event.timestamp);
    }
    case EventType.THINKING_TEXT_MESSAGE_CONTENT:
      return appendText(
        current,
        `${envelope.runId}:thinking`,
        event.delta,
        envelope.runId,
        event.timestamp,
        'reasoning'
      );
    case EventType.THINKING_TEXT_MESSAGE_END:
    case EventType.THINKING_END:
      return markTerminal(current, `${envelope.runId}:thinking`);
    case EventType.TOOL_CALL_START:
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      return startToolCall(current, envelope.runId, event.toolCallId, event.toolCallName, event.parentMessageId, event.timestamp);
    case EventType.TOOL_CALL_ARGS:
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      return appendToolArgs(current, envelope.runId, event.toolCallId, event.delta, event.timestamp);
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
        next = startToolCall(next, envelope.runId, event.toolCallId, event.toolCallName ?? 'tool', event.parentMessageId, event.timestamp);
      }
      return event.delta ? appendToolArgs(next, envelope.runId, event.toolCallId, event.delta, event.timestamp) : next;
    }
    case EventType.TOOL_CALL_RESULT:
      if (current.subagentToolCallIds[event.toolCallId]) return current;
      return appendToolResult(current, envelope.runId, event.messageId, event.toolCallId, event.content, event.timestamp);
    case EventType.MESSAGES_SNAPSHOT:
      return applyMessagesSnapshot(current, envelope.runId, event.messages, event.timestamp);
    case EventType.ACTIVITY_SNAPSHOT:
      return reduceActivitySnapshot(current, envelope.runId, event.messageId, event.activityType, event.content, event.timestamp);
    case EventType.ACTIVITY_DELTA:
      return applyActivityDelta(current, envelope.runId, event.messageId, event.activityType, event.patch, event.timestamp);
    case EventType.STATE_SNAPSHOT:
      return { ...current, state: event.snapshot };
    case EventType.STATE_DELTA:
      return { ...current, state: applyJsonPatch(current.state, event.delta) };
    case EventType.STEP_STARTED:
      return { ...current, steps: { ...current.steps, [event.stepName]: 'running' } };
    case EventType.STEP_FINISHED:
      return { ...current, steps: { ...current.steps, [event.stepName]: 'finished' } };
    case EventType.RAW:
      return {
        ...current,
        rawEvents: [...current.rawEvents, { source: event.source, event: event.event }].slice(-MAX_RAW_EVENTS_PER_THREAD),
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

function rememberReplacement(
  current: AgUiThreadMessageState,
  messageId: string,
  replacesMessageId: string | null
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

function textMessage(
  id: string,
  role: 'developer' | 'system' | 'assistant' | 'user',
  content: string,
  name?: string
): ChatMessage {
  const base = { id, content, createdAt: new Date().toISOString(), ...(name ? { name } : {}) };
  switch (role) {
    case 'developer': return { ...base, role: 'developer' };
    case 'system': return { ...base, role: 'system' };
    case 'user': return { ...base, role: 'user' };
    default: return { ...base, role: 'assistant' };
  }
}

function upsertMessage(
  current: AgUiThreadMessageState,
  message: ChatMessage,
  runId: string,
  timestamp?: number
): AgUiThreadMessageState {
  const index = current.messages.findIndex((entry) => entry.id === message.id);
  const existing = index >= 0 ? current.messages[index] : undefined;
  const nextMessage: ChatMessage = {
    ...message,
    createdAt: existing?.createdAt ?? timestampIso(timestamp),
  } as ChatMessage;
  const messages = index >= 0
    ? current.messages.map((entry, entryIndex) => entryIndex === index ? nextMessage : entry)
    : [...current.messages, nextMessage];
  return {
    ...current,
    messages: messages.slice(-MAX_MESSAGES_PER_THREAD),
    runByMessageId: { ...current.runByMessageId, [message.id]: runId },
  };
}

function appendText(
  current: AgUiThreadMessageState,
  messageId: string,
  delta: string,
  runId: string,
  timestamp: number | undefined,
  defaultRole: 'developer' | 'system' | 'assistant' | 'user' | 'reasoning'
): AgUiThreadMessageState {
  const existing = findMessage(current, messageId);
  if (defaultRole !== 'reasoning' && existing?.role !== 'reasoning') {
    const parts = appendOrderedPart(existing?.parts ?? [], { type: 'text', text: delta });
    const content = renderOrderedParts(parts);
    const message = existing
      ? { ...withText(existing, content), parts } as ChatMessage
      : { ...textMessage(messageId, defaultRole, content), parts } as ChatMessage;
    return upsertMessage(current, message, runId, timestamp);
  }
  const content = `${existing ? getMessageText(existing) : ''}${delta}`;
  if (existing) {
    return upsertMessage(current, withText(existing, content), runId, timestamp);
  }
  if (defaultRole === 'reasoning') {
    return upsertMessage(current, {
      id: messageId,
      role: 'reasoning',
      content,
      createdAt: timestampIso(timestamp),
    }, runId, timestamp);
  }
  return upsertMessage(current, textMessage(messageId, defaultRole, content), runId, timestamp);
}

function appendToolResult(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  toolCallId: string,
  delta: string,
  timestamp?: number
): AgUiThreadMessageState {
  const previousId = current.toolResultMessageIdByCallId[toolCallId];
  const previous = previousId ? findMessage(current, previousId) : undefined;
  const previousText = previous?.role === 'tool' ? previous.content : '';
  const withoutPrevious = previousId && previousId !== messageId
    ? { ...current, messages: current.messages.filter((message) => message.id !== previousId) }
    : current;
  return upsertToolResult(
    withoutPrevious,
    runId,
    messageId,
    toolCallId,
    `${previousText}${delta}`,
    timestamp
  );
}

function reduceActivitySnapshot(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  activityType: string,
  content: Record<string, unknown>,
  timestamp?: number
): AgUiThreadMessageState {
  const subAgent = activityType === SUBAGENT_ACTIVITY_TYPE ? record(content.subAgent) : null;
  const toolCallId = nonEmptyString(subAgent?.toolCallId);
  const withoutGenericTool = toolCallId
    ? {
        ...current,
        messages: current.messages.filter((message) =>
          message.id !== current.toolCallMessageIdByCallId[toolCallId] &&
          message.id !== current.toolResultMessageIdByCallId[toolCallId]
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
  return upsertMessage(withSuppressedTool, createActivityMessage(
    messageId,
    activityType,
    content as { text: string; [key: string]: unknown },
    timestampIso(timestamp)
  ), runId, timestamp);
}

function withText(message: ChatMessage, content: string): ChatMessage {
  if (message.role === 'activity') {
    return { ...message, content: { ...message.content, text: content } };
  }
  if (message.role === 'assistant') {
    return { ...message, content };
  }
  if (message.role === 'user') {
    return { ...message, content };
  }
  return { ...message, content } as ChatMessage;
}

function startToolCall(
  current: AgUiThreadMessageState,
  runId: string,
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string | undefined,
  timestamp?: number
): AgUiThreadMessageState {
  const messageId = parentMessageId ?? `tool-call:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const assistant: AssistantMessage & { createdAt: string } = existing?.role === 'assistant'
    ? {
        ...existing,
        toolCalls: upsertToolCall(existing.toolCalls ?? [], toolCallId, toolCallName, ''),
      }
    : {
        id: messageId,
        role: 'assistant',
        content: '',
        toolCalls: [toolCall(toolCallId, toolCallName, '')],
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

function appendToolArgs(
  current: AgUiThreadMessageState,
  runId: string,
  toolCallId: string,
  delta: string,
  timestamp?: number
): AgUiThreadMessageState {
  const messageId = current.toolCallMessageIdByCallId[toolCallId] ?? `tool-call:${toolCallId}`;
  const started = current.toolCallMessageIdByCallId[toolCallId]
    ? current
    : startToolCall(current, runId, toolCallId, 'tool', undefined, timestamp);
  const message = findMessage(started, messageId);
  if (!message || message.role !== 'assistant') return started;
  const existing = message.toolCalls?.find((call) => call.id === toolCallId);
  return upsertMessage(started, {
    ...message,
    toolCalls: upsertToolCall(
      message.toolCalls ?? [],
      toolCallId,
      existing?.function.name ?? 'tool',
      `${existing?.function.arguments ?? ''}${delta}`
    ),
  }, runId, timestamp);
}

function upsertToolResult(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  toolCallId: string,
  content: string,
  timestamp?: number
): AgUiThreadMessageState {
  const toolMessage: ToolMessage & { createdAt: string } = {
    id: messageId,
    role: 'tool',
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

function applyMessagesSnapshot(
  current: AgUiThreadMessageState,
  runId: string,
  messages: Message[],
  timestamp?: number
): AgUiThreadMessageState {
  const snapshotSubagentIds = messages.reduce<Record<string, true>>((ids, message) => {
    if (message.role === 'activity' && message.activityType === SUBAGENT_ACTIVITY_TYPE) {
      const content = record(message.content);
      const subAgent = record(content?.subAgent);
      const toolCallId = nonEmptyString(subAgent?.toolCallId);
      if (toolCallId) ids[toolCallId] = true;
    }
    return ids;
  }, { ...current.subagentToolCallIds });
  const previous = new Map(current.messages.map((message) => [message.id, message]));
  const nextMessages = messages.filter((message) => !messageUsesSuppressedTool(message, snapshotSubagentIds)).map((message) => ({
    ...message,
    createdAt: previous.get(message.id)?.createdAt ?? timestampIso(timestamp),
    parts: previous.get(message.id)?.parts,
  } as ChatMessage));
  return {
    ...current,
    messages: nextMessages.slice(-MAX_MESSAGES_PER_THREAD),
    authoritativeSnapshot: true,
    runByMessageId: Object.fromEntries(nextMessages.map((message) => [message.id, runId])),
    terminalMessageIds: nextMessages.map((message) => message.id),
    subagentToolCallIds: snapshotSubagentIds,
  };
}

function messageUsesSuppressedTool(
  message: Message,
  suppressed: Record<string, true>
): boolean {
  if (message.role === 'tool') {
    return Boolean(suppressed[message.toolCallId]);
  }
  if (message.role === 'assistant') {
    return (message.toolCalls ?? []).some((call) => suppressed[call.id]);
  }
  return false;
}

function applyActivityDelta(
  current: AgUiThreadMessageState,
  runId: string,
  messageId: string,
  activityType: string,
  patch: unknown[],
  timestamp?: number
): AgUiThreadMessageState {
  const existing = findMessage(current, messageId);
  const content = existing?.role === 'activity' ? existing.content : {};
  return upsertMessage(current, {
    id: messageId,
    role: 'activity',
    activityType,
    content: applyJsonPatch(content, patch) as Record<string, unknown>,
    createdAt: existing?.createdAt ?? timestampIso(timestamp),
  }, runId, timestamp);
}

function reduceCustomEvent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope
): AgUiThreadMessageState {
  const event = envelope.event;
  if (event.type !== EventType.CUSTOM) return current;
  const value = record(event.value);
  if (event.name.endsWith('-chunk')) {
    return reduceCustomChunk(current, envelope, value);
  }
  if (event.name === 'tethercode.dev/message-content') {
    return reduceStructuredMessageContent(current, envelope, value);
  }
  if (event.name === 'tethercode.dev/tool-text') {
    return reduceToolText(current, envelope, value);
  }
  if (event.name === 'tethercode.dev/tool-content') {
    return reduceToolContent(current, envelope, value);
  }
  if (event.name === 'tethercode.dev/subagent') {
    return reduceSubagentActivity(current, envelope, value);
  }
  return storeCustomMetadata(current, event.name, event.value);
}

function storeCustomMetadata(
  current: AgUiThreadMessageState,
  name: string,
  value: unknown
): AgUiThreadMessageState {
  const order = current.customMetadataOrder.filter((entry) => entry !== name);
  order.push(name);
  while (order.length > MAX_CUSTOM_METADATA_ENTRIES) order.shift();
  const customMetadata = Object.fromEntries(
    order.map((entry) => [entry, entry === name ? value : current.customMetadata[entry]])
  );
  return { ...current, customMetadata, customMetadataOrder: order };
}

function reduceStructuredMessageContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null
): AgUiThreadMessageState {
  const messageId = nonEmptyString(value?.messageId) ?? `${envelope.runId}:content`;
  const role = value?.role === 'thought' ? 'reasoning' : value?.role === 'user' ? 'user' : 'assistant';
  const existing = findMessage(current, messageId);
  const parts = appendOrderedPart(existing?.parts ?? [], value?.content);
  const text = renderOrderedParts(parts);
  const base: ChatMessage = role === 'reasoning'
    ? { id: messageId, role: 'reasoning', content: text, createdAt: timestampIso(envelope.event.timestamp), parts }
    : role === 'user'
      ? { id: messageId, role: 'user', content: text, createdAt: timestampIso(envelope.event.timestamp), parts }
      : { id: messageId, role: 'assistant', content: text, createdAt: timestampIso(envelope.event.timestamp), parts };
  return upsertMessage(current, base, envelope.runId, envelope.event.timestamp);
}

function reduceToolText(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId);
  if (toolCallId && current.subagentToolCallIds[toolCallId]) return current;
  const revision = nonEmptyString(value?.revision);
  const content = typeof value?.content === 'string' ? value.content : null;
  if (!toolCallId || !revision || content === null) return current;
  if (current.toolTextRevisionByCallId[toolCallId] === revision) return current;
  const messageId = current.toolResultMessageIdByCallId[toolCallId] ?? `tool-result:${toolCallId}`;
  const structured = current.structuredTextByCallId[toolCallId] ?? '';
  const next = upsertToolResult(current, envelope.runId, messageId, toolCallId, [content, structured].filter(Boolean).join('\n'), envelope.event.timestamp);
  return {
    ...next,
    toolTextRevisionByCallId: { ...next.toolTextRevisionByCallId, [toolCallId]: revision },
  };
}

function reduceToolContent(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId) ?? 'unknown';
  if (current.subagentToolCallIds[toolCallId]) return current;
  const revision = nonEmptyString(value?.revision) ?? JSON.stringify(value);
  if (current.structuredRevisionByCallId[toolCallId] === revision) return current;
  const structured = Array.isArray(value?.content) && value.content.length === 0 && Array.isArray(value?.locations) && value.locations.length === 0
    ? ''
    : renderAgUiCustomContent(value);
  const messageId = current.toolResultMessageIdByCallId[toolCallId] ?? `tool-result:${toolCallId}`;
  const existing = findMessage(current, messageId);
  const existingText = existing?.role === 'tool' ? existing.content : '';
  const previousStructured = current.structuredTextByCallId[toolCallId] ?? '';
  const base = previousStructured && existingText.endsWith(previousStructured)
    ? existingText.slice(0, -previousStructured.length).trimEnd()
    : existingText;
  const next = upsertToolResult(current, envelope.runId, messageId, toolCallId, [base, structured].filter(Boolean).join('\n'), envelope.event.timestamp);
  return {
    ...next,
    structuredRevisionByCallId: { ...next.structuredRevisionByCallId, [toolCallId]: revision },
    structuredTextByCallId: { ...next.structuredTextByCallId, [toolCallId]: structured },
  };
}

function reduceSubagentActivity(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null
): AgUiThreadMessageState {
  const toolCallId = nonEmptyString(value?.toolCallId) ?? 'unknown';
  const receiverThreadIds = Array.isArray(value?.receiverThreadIds)
    ? value.receiverThreadIds.map(nonEmptyString).filter((id): id is string => Boolean(id))
    : [];
  if (receiverThreadIds.length === 0) return current;
  const meta: ChatMessageSubAgentMeta = {
    toolCallId,
    tool: nonEmptyString(value?.tool) ?? 'spawnAgent',
    senderThreadId: nonEmptyString(value?.senderThreadId) ?? envelope.threadId,
    receiverThreadIds: Array.from(new Set(receiverThreadIds)),
    agentStatus: nonEmptyString(value?.agentStatus) ?? undefined,
    navigable: false,
  };
  const resultPreview = nonEmptyString(value?.resultPreview);
  const text = [
    meta.agentStatus === 'completed' ? '• Spawned sub-agent' : '• Spawning sub-agent',
    `  Thread: ${receiverThreadIds[0]}`,
    meta.agentStatus ? `  Status: ${meta.agentStatus}` : null,
    resultPreview ? `  Result: ${resultPreview}` : null,
  ].filter(Boolean).join('\n');
  const messages = current.messages.filter((message) => !(
    message.id === `tool-call:${toolCallId}` || message.id === `tool-result:${toolCallId}` || message.id === `subagent:${toolCallId}`
  ));
  return upsertMessage({
    ...current,
    messages,
    subagentToolCallIds: { ...current.subagentToolCallIds, [toolCallId]: true },
  }, createActivityMessage(
    `subagent:${toolCallId}`,
    SUBAGENT_ACTIVITY_TYPE,
    { text, subAgent: meta },
    timestampIso(envelope.event.timestamp)
  ), envelope.runId, envelope.event.timestamp);
}

function reduceCustomChunk(
  current: AgUiThreadMessageState,
  envelope: AgUiEventEnvelope,
  value: Record<string, unknown> | null
): AgUiThreadMessageState {
  if (envelope.event.type !== EventType.CUSTOM) return current;
  const customName = envelope.event.name;
  const canonicalId = nonEmptyString(value?.canonicalId);
  const revision = nonEmptyString(value?.revision);
  const index = typeof value?.index === 'number' ? value.index : -1;
  const count = typeof value?.count === 'number' ? value.count : 0;
  const data = typeof value?.data === 'string' ? value.data : null;
  if (!canonicalId || !revision || index < 0 || index >= count || !data) return current;
  const key = `${customName}\0${revision}`;
  const existing = current.chunkAssemblies[key];
  const chunks = existing?.count === count ? { ...existing.chunks, [index]: data } : { [index]: data };
  const pending = { ...current, chunkAssemblies: { ...current.chunkAssemblies, [key]: { count, chunks } } };
  if (Object.keys(chunks).length !== count) return pending;
  try {
    const event = {
      type: EventType.CUSTOM,
      name: customName.slice(0, -'-chunk'.length),
      value: JSON.parse(Array.from({ length: count }, (_, chunkIndex) => chunks[chunkIndex]).join('')),
    } as AGUIEvent;
    const completed = reduceCustomEvent(pending, { ...envelope, event });
    const chunkAssemblies = { ...completed.chunkAssemblies };
    delete chunkAssemblies[key];
    return { ...completed, chunkAssemblies };
  } catch {
    return pending;
  }
}

function markTerminal(current: AgUiThreadMessageState, messageId: string): AgUiThreadMessageState {
  if (current.terminalMessageIds.includes(messageId)) return current;
  return { ...current, terminalMessageIds: [...current.terminalMessageIds, messageId] };
}

function markRunTerminal(current: AgUiThreadMessageState, runId: string): AgUiThreadMessageState {
  const ids = Object.entries(current.runByMessageId)
    .filter(([, messageRunId]) => messageRunId === runId)
    .map(([messageId]) => messageId);
  if (ids.length === 0) return current;
  return { ...current, terminalMessageIds: Array.from(new Set([...current.terminalMessageIds, ...ids])) };
}

function updateEncryptedValue(
  current: AgUiThreadMessageState,
  entityId: string,
  encryptedValue: string,
  subtype: 'tool-call' | 'message'
): AgUiThreadMessageState {
  if (subtype === 'message') {
    const message = findMessage(current, entityId);
    return message ? upsertMessage(current, { ...message, encryptedValue } as ChatMessage, current.runByMessageId[entityId] ?? '', undefined) : current;
  }
  const messageId = current.toolCallMessageIdByCallId[entityId];
  const message = messageId ? findMessage(current, messageId) : undefined;
  if (!message || message.role !== 'assistant') return current;
  return upsertMessage(current, {
    ...message,
    toolCalls: message.toolCalls?.map((call) => call.id === entityId ? { ...call, encryptedValue } : call),
  }, current.runByMessageId[message.id] ?? '', undefined);
}

function findMessage(current: AgUiThreadMessageState, id: string): ChatMessage | undefined {
  return current.messages.find((message) => message.id === id);
}

function toolCall(id: string, name: string, args: string): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function upsertToolCall(calls: ToolCall[], id: string, name: string, args: string): ToolCall[] {
  const next = toolCall(id, name, args);
  const index = calls.findIndex((call) => call.id === id);
  return index >= 0 ? calls.map((call, callIndex) => callIndex === index ? next : call) : [...calls, next];
}

function appendOrderedPart(parts: ChatMessagePart[], part: unknown): ChatMessagePart[] {
  const partRecord = record(part);
  const text = partRecord?.type === 'text' && typeof partRecord.text === 'string' ? partRecord.text : null;
  if (text === null || text.length === 0) {
    return text === null && isChatMessagePart(part) ? [...parts, part] : parts;
  }
  const previous = record(parts.at(-1));
  return previous?.type === 'text' && typeof previous.text === 'string'
    ? [...parts.slice(0, -1), { type: 'text', text: `${previous.text}${text}` }]
    : [...parts, { type: 'text', text }];
}

function renderOrderedParts(parts: ChatMessagePart[]): string {
  return parts.map(renderAgUiCustomContent).filter(Boolean).join('\n');
}

function isChatMessagePart(value: unknown): value is ChatMessagePart {
  const part = record(value);
  if (!part || typeof part.type !== 'string') return false;
  if (part.type === 'text') return typeof part.text === 'string';
  if (part.type === 'image' || part.type === 'audio') return true;
  if (part.type === 'resourceLink') return typeof part.uri === 'string';
  return part.type === 'resource' && record(part.resource) !== null;
}

function applyJsonPatch(value: unknown, operations: unknown[]): unknown {
  let next: unknown = cloneJson(value ?? {});
  for (const operation of operations) {
    const patch = record(operation);
    const op = nonEmptyString(patch?.op);
    const path = typeof patch?.path === 'string' ? patch.path : null;
    if (!op || path === null) continue;
    const segments = path.split('/').slice(1).map(unescapePointer);
    if (segments.length === 0) {
      if (op === 'replace' || op === 'add') next = cloneJson(patch?.value);
      if (op === 'remove') next = null;
      continue;
    }
    const parent = getPatchParent(next, segments.slice(0, -1));
    if (!parent) continue;
    const key = segments.at(-1)!;
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number.parseInt(key, 10);
      if (!Number.isFinite(index)) continue;
      if (op === 'remove') parent.splice(index, 1);
      else if (op === 'add') parent.splice(index, 0, cloneJson(patch?.value));
      else if (op === 'replace') parent[index] = cloneJson(patch?.value);
    } else if (typeof parent === 'object') {
      if (op === 'remove') delete (parent as Record<string, unknown>)[key];
      else if (op === 'add' || op === 'replace') (parent as Record<string, unknown>)[key] = cloneJson(patch?.value);
    }
  }
  return next;
}

function getPatchParent(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number.parseInt(segment, 10)];
    else if (current && typeof current === 'object') current = (current as Record<string, unknown>)[segment];
    else return null;
  }
  return current;
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function unescapePointer(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function timestampIso(timestamp?: number): string {
  return typeof timestamp === 'number' && Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
