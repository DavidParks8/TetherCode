import { EventSchemas, EventType, type AGUIEvent } from '@ag-ui/core';

import type { ChatMessagePart, RpcNotification } from './types';

export interface AgUiEventEnvelope {
  threadId: string;
  runId: string;
  sourceTurnId?: string;
  event: AGUIEvent;
}

export interface AgUiLiveAssistantMessage {
  runId: string;
  messageId: string;
  text: string;
  role?: 'assistant' | 'user' | 'system';
  systemKind?: 'tool' | 'reasoning';
  replacesMessageId?: string;
  terminal?: boolean;
  parts?: ChatMessagePart[];
  structuredRevision?: string;
  structuredText?: string;
  customChunkAssemblies?: Record<string, {
    count: number;
    chunks: Record<number, string>;
  }>;
  toolText?: string;
  toolTextRevision?: string;
}

export type AgUiLiveAssistantMessages = Record<string, AgUiLiveAssistantMessage[]>;

const MAX_LIVE_MESSAGES_PER_THREAD = 128;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function parseAgUiEventNotification(
  notification: RpcNotification
): AgUiEventEnvelope | null {
  if (notification.method !== 'bridge/agui.event') {
    return null;
  }
  const params = record(notification.params);
  const threadId = nonEmptyString(params?.threadId);
  const runId = nonEmptyString(params?.runId);
  const sourceTurnId = nonEmptyString(params?.sourceTurnId) ?? undefined;
  const parsedEvent = EventSchemas.safeParse(params?.event);
  if (!threadId || !runId || !parsedEvent.success) {
    return null;
  }
  const event = parsedEvent.data;
  if (
    (event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED) &&
    (event.threadId !== threadId || event.runId !== runId)
  ) {
    return null;
  }
  return { threadId, runId, sourceTurnId, event };
}

export function updateAgUiLiveAssistantMessages(
  previous: AgUiLiveAssistantMessages,
  envelope: AgUiEventEnvelope
): AgUiLiveAssistantMessages {
  const event = envelope.event;
  if (event.type === EventType.RUN_STARTED) {
    if (!(envelope.threadId in previous)) {
      return previous;
    }
    const next = { ...previous };
    delete next[envelope.threadId];
    return next;
  }
  if (event.type === EventType.TEXT_MESSAGE_START) {
    if (event.role && event.role !== 'assistant' && event.role !== 'user') {
      return previous;
    }
    const messages = previous[envelope.threadId] ?? [];
    if (
      messages.some(
        (message) => message.runId === envelope.runId && message.messageId === event.messageId
      )
    ) {
      return previous;
    }
    return {
      ...previous,
      [envelope.threadId]: [
        ...messages,
        {
          runId: envelope.runId,
          messageId: event.messageId,
          text: '',
          parts: [],
          role: event.role === 'user' ? 'user' : 'assistant',
          replacesMessageId:
            nonEmptyString(record(event)?.replacesMessageId) ?? undefined,
        },
      ],
    };
  }
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    const messages = previous[envelope.threadId] ?? [];
    const currentIndex = messages.findIndex(
      (message) => message.runId === envelope.runId && message.messageId === event.messageId
    );
    const current = currentIndex >= 0 ? messages[currentIndex] : null;
    const parts = appendOrderedMessagePart(current?.parts ?? [], {
      type: 'text',
      text: event.delta,
    });
    const nextMessage = {
      ...current,
      runId: envelope.runId,
      messageId: event.messageId,
      text: renderOrderedMessageParts(parts),
      parts,
      role: current?.role ?? 'assistant' as const,
    };
    return boundedUpdate(previous, envelope.threadId,
      currentIndex >= 0
        ? messages.map((message, index) => (index === currentIndex ? nextMessage : message))
        : [...messages, nextMessage]
    );
  }
  if (event.type === EventType.REASONING_MESSAGE_START) {
    const current = findLiveMessage(previous, envelope.threadId, envelope.runId, event.messageId);
    return upsertLiveMessage(previous, envelope.threadId, {
      runId: envelope.runId,
      messageId: event.messageId,
      text: current?.text ?? '',
      role: 'system',
      systemKind: 'reasoning',
    });
  }
  if (event.type === EventType.REASONING_MESSAGE_CONTENT) {
    return appendLiveText(previous, envelope, event.messageId, event.delta, 'reasoning');
  }
  if (event.type === EventType.REASONING_MESSAGE_END) {
    return markMessageTerminal(previous, envelope.threadId, envelope.runId, event.messageId);
  }
  if (event.type === EventType.TOOL_CALL_START) {
    return upsertLiveMessage(previous, envelope.threadId, {
      runId: envelope.runId,
      messageId: `tool:${event.toolCallId}`,
      text: event.toolCallName,
      role: 'system',
      systemKind: 'tool',
    });
  }
  if (event.type === EventType.TOOL_CALL_ARGS) {
    return appendLiveText(previous, envelope, `tool:${event.toolCallId}`, event.delta, 'tool');
  }
  if (event.type === EventType.TOOL_CALL_END) {
    return markMessageTerminal(previous, envelope.threadId, envelope.runId, `tool:${event.toolCallId}`);
  }
  if (event.type === EventType.TOOL_CALL_RESULT) {
    const current = findLiveMessage(
      previous,
      envelope.threadId,
      envelope.runId,
      `tool:${event.toolCallId}`
    );
    return replaceToolText(
      previous,
      envelope,
      event.toolCallId,
      `${current?.toolText ?? ''}${event.content}`
    );
  }
  if (event.type === EventType.CUSTOM) {
    const value = record(event.value);
    if (event.name.endsWith('-chunk')) {
      const canonicalId = nonEmptyString(value?.canonicalId);
      const revision = nonEmptyString(value?.revision);
      const index = typeof value?.index === 'number' ? value.index : -1;
      const count = typeof value?.count === 'number' ? value.count : 0;
      const data = typeof value?.data === 'string' ? value.data : null;
      if (!canonicalId || !revision || index < 0 || index >= count || !data) {
        return previous;
      }
      const toolChunk = event.name.startsWith('clawdex.dev/tool-content')
        || event.name.startsWith('clawdex.dev/tool-text');
      const messageId = toolChunk ? `tool:${canonicalId}` : canonicalId;
      const current = findLiveMessage(previous, envelope.threadId, envelope.runId, messageId);
      const assemblyKey = `${event.name}\0${revision}`;
      const assembly = current?.customChunkAssemblies?.[assemblyKey];
      const chunks = assembly?.count === count
        ? { ...assembly.chunks, [index]: data }
        : { [index]: data };
      const customChunkAssemblies = {
        ...current?.customChunkAssemblies,
        [assemblyKey]: { count, chunks },
      };
      const pending = upsertLiveMessage(previous, envelope.threadId, {
        ...current,
        runId: envelope.runId,
        messageId,
        text: current?.text ?? '',
        role: toolChunk ? 'system' : current?.role,
        systemKind: toolChunk ? 'tool' : current?.systemKind,
        customChunkAssemblies,
      });
      if (Object.keys(chunks).length !== count) {
        return pending;
      }
      try {
        const completed = updateAgUiLiveAssistantMessages(pending, {
          ...envelope,
          event: {
            type: EventType.CUSTOM,
            name: event.name.slice(0, -'-chunk'.length),
            value: JSON.parse(Array.from({ length: count }, (_, chunkIndex) => chunks[chunkIndex]).join('')),
          },
        });
        const completedMessage = findLiveMessage(
          completed,
          envelope.threadId,
          envelope.runId,
          messageId
        );
        if (!completedMessage?.customChunkAssemblies?.[assemblyKey]) {
          return completed;
        }
        const remainingAssemblies = { ...completedMessage.customChunkAssemblies };
        delete remainingAssemblies[assemblyKey];
        return upsertLiveMessage(completed, envelope.threadId, {
          ...completedMessage,
          customChunkAssemblies: Object.keys(remainingAssemblies).length > 0
            ? remainingAssemblies
            : undefined,
        });
      } catch {
        return pending;
      }
    }
    if (event.name === 'clawdex.dev/message-content') {
      const messageId = nonEmptyString(value?.messageId) ?? `${envelope.runId}:content`;
      const current = findLiveMessage(previous, envelope.threadId, envelope.runId, messageId);
      const parts = appendOrderedMessagePart(current?.parts ?? [], value?.content);
      return upsertLiveMessage(previous, envelope.threadId, {
        runId: envelope.runId,
        messageId,
        text: renderOrderedMessageParts(parts),
        parts,
        role: value?.role === 'agent' ? 'assistant' : 'system',
        systemKind: value?.role === 'thought' ? 'reasoning' : 'tool',
      });
    }
    if (event.name === 'clawdex.dev/tool-content') {
      const toolCallId = nonEmptyString(value?.toolCallId) ?? 'unknown';
      const messageId = `tool:${toolCallId}`;
      const current = findLiveMessage(previous, envelope.threadId, envelope.runId, messageId);
      const structuredRevision = nonEmptyString(value?.revision) ?? JSON.stringify(value);
      if (current?.structuredRevision === structuredRevision) {
        return previous;
      }
      const structuredText = Array.isArray(value?.content) && value.content.length === 0
        && Array.isArray(value?.locations) && value.locations.length === 0
        ? ''
        : renderAgUiCustomContent(value);
      const baseText = current?.structuredText && current.text.endsWith(current.structuredText)
        ? current.text.slice(0, -current.structuredText.length).trimEnd()
        : current?.text ?? '';
      return upsertLiveMessage(previous, envelope.threadId, {
        ...current,
        runId: envelope.runId,
        messageId,
        text: [baseText, structuredText].filter(Boolean).join('\n'),
        role: 'system',
        systemKind: 'tool',
        structuredRevision,
        structuredText,
      });
    }
    if (event.name === 'clawdex.dev/tool-text') {
      const toolCallId = nonEmptyString(value?.toolCallId);
      const revision = nonEmptyString(value?.revision);
      const content = typeof value?.content === 'string' ? value.content : null;
      if (!toolCallId || !revision || content === null) {
        return previous;
      }
      const current = findLiveMessage(
        previous,
        envelope.threadId,
        envelope.runId,
        `tool:${toolCallId}`
      );
      if (current?.toolTextRevision === revision) {
        return previous;
      }
      return replaceToolText(previous, envelope, toolCallId, content, revision);
    }
    if (event.name.startsWith('clawdex.dev/')) {
      return upsertLiveMessage(previous, envelope.threadId, {
        runId: envelope.runId,
        messageId: `${envelope.runId}:custom:${event.name}`,
        text: `${event.name.slice('clawdex.dev/'.length)}: ${renderAgUiCustomContent(event.value)}`,
        role: 'system',
        systemKind: event.name === 'clawdex.dev/plan' ? 'reasoning' : 'tool',
      });
    }
  }
  if (event.type === EventType.TEXT_MESSAGE_END) {
    return markMessageTerminal(previous, envelope.threadId, envelope.runId, event.messageId);
  }
  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    const snapshotMessages = event.messages
      .filter((message) => message.role === 'assistant' || message.role === 'reasoning')
      .map((message) => ({
        runId: envelope.runId,
        messageId: message.id,
        text: typeof message.content === 'string' ? message.content : renderAgUiCustomContent(message.content),
        role: message.role === 'assistant' ? 'assistant' as const : 'system' as const,
        systemKind: message.role === 'reasoning' ? 'reasoning' as const : undefined,
      }));
    const current = previous[envelope.threadId] ?? [];
    const snapshotKeys = new Set(snapshotMessages.map((message) => `${message.runId}\0${message.messageId}`));
    return boundedUpdate(previous, envelope.threadId, [
      ...current.filter((message) => !snapshotKeys.has(`${message.runId}\0${message.messageId}`)),
      ...snapshotMessages,
    ]);
  }
  if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) {
    const messages = previous[envelope.threadId];
    if (!messages?.some((message) => message.runId === envelope.runId && !message.terminal)) {
      return previous;
    }
    return boundedUpdate(previous, envelope.threadId, messages.map((message) =>
      message.runId === envelope.runId ? { ...message, terminal: true } : message
    ));
  }
  return previous;
}

function boundedUpdate(
  previous: AgUiLiveAssistantMessages,
  threadId: string,
  messages: AgUiLiveAssistantMessage[]
): AgUiLiveAssistantMessages {
  return {
      ...previous,
    [threadId]: messages.slice(-MAX_LIVE_MESSAGES_PER_THREAD),
  };
}

function upsertLiveMessage(
  previous: AgUiLiveAssistantMessages,
  threadId: string,
  message: AgUiLiveAssistantMessage
): AgUiLiveAssistantMessages {
  const messages = previous[threadId] ?? [];
  const index = messages.findIndex(
    (entry) => entry.runId === message.runId && entry.messageId === message.messageId
  );
  return boundedUpdate(
    previous,
    threadId,
    index >= 0
      ? messages.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...message } : entry)
      : [...messages, message]
  );
}

function findLiveMessage(
  previous: AgUiLiveAssistantMessages,
  threadId: string,
  runId: string,
  messageId: string
): AgUiLiveAssistantMessage | undefined {
  return previous[threadId]?.find(
    (message) => message.runId === runId && message.messageId === messageId
  );
}

function appendLiveText(
  previous: AgUiLiveAssistantMessages,
  envelope: AgUiEventEnvelope,
  messageId: string,
  delta: string,
  systemKind: 'tool' | 'reasoning'
): AgUiLiveAssistantMessages {
  const messages = previous[envelope.threadId] ?? [];
  const current = messages.find(
    (message) => message.runId === envelope.runId && message.messageId === messageId
  );
  return upsertLiveMessage(previous, envelope.threadId, {
    runId: envelope.runId,
    messageId,
    text: `${current?.text ?? ''}${delta}`,
    role: 'system',
    systemKind,
  });
}

function appendOrderedMessagePart(parts: ChatMessagePart[], part: unknown): ChatMessagePart[] {
  const partRecord = record(part);
  const text = partRecord?.type === 'text' && typeof partRecord.text === 'string'
    ? partRecord.text
    : null;
  if (text === null || text.length === 0) {
    return text === null && isChatMessagePart(part) ? [...parts, part] : parts;
  }
  const previous = record(parts.at(-1));
  if (previous?.type === 'text' && typeof previous.text === 'string') {
    return [
      ...parts.slice(0, -1),
      { type: 'text', text: `${previous.text}${text}` },
    ];
  }
  return [...parts, { type: 'text', text }];
}

function renderOrderedMessageParts(parts: ChatMessagePart[]): string {
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

function replaceToolText(
  previous: AgUiLiveAssistantMessages,
  envelope: AgUiEventEnvelope,
  toolCallId: string,
  toolText: string,
  toolTextRevision?: string
): AgUiLiveAssistantMessages {
  const messageId = `tool:${toolCallId}`;
  const current = findLiveMessage(previous, envelope.threadId, envelope.runId, messageId);
  let baseText = current?.text ?? '';
  if (current?.structuredText && baseText.endsWith(current.structuredText)) {
    baseText = baseText.slice(0, -current.structuredText.length).trimEnd();
  }
  if (current?.toolText && baseText.endsWith(current.toolText)) {
    baseText = baseText.slice(0, -current.toolText.length);
  }
  const textWithTool = `${baseText}${toolText}`;
  return upsertLiveMessage(previous, envelope.threadId, {
    ...current,
    runId: envelope.runId,
    messageId,
    text: [textWithTool, current?.structuredText].filter(Boolean).join('\n'),
    role: 'system',
    systemKind: 'tool',
    toolText,
    toolTextRevision: toolTextRevision ?? current?.toolTextRevision,
  });
}

function markMessageTerminal(
  previous: AgUiLiveAssistantMessages,
  threadId: string,
  runId: string,
  messageId: string
): AgUiLiveAssistantMessages {
  const messages = previous[threadId] ?? [];
  return boundedUpdate(previous, threadId, messages.map((message) =>
    message.runId === runId && message.messageId === messageId
      ? { ...message, terminal: true }
      : message
  ));
}

export function renderAgUiCustomContent(value: unknown): string {
  const structured = renderStructuredContent(value, 0);
  if (structured.length > 0) {
    return structured.join('\n');
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[content unavailable]';
  }
}

function renderStructuredContent(value: unknown, depth: number): string[] {
  if (depth > 4 || value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => renderStructuredContent(entry, depth + 1));
  }
  if (typeof value === 'string') {
    return value.trim() ? [value] : [];
  }
  const entry = record(value);
  if (!entry) {
    return [];
  }
  const type = nonEmptyString(entry.type)?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (type === 'text') {
    return nonEmptyString(entry.text) ? [String(entry.text)] : [];
  }
  if (type === 'image') {
    const url = nonEmptyString(entry.url) ?? nonEmptyString(entry.imageUrl) ?? nonEmptyString(entry.image_url);
    const data = nonEmptyString(entry.data);
    const mimeType = nonEmptyString(entry.mimeType) ?? nonEmptyString(entry.mime_type);
    const source = url ?? (data && mimeType ? `data:${mimeType};base64,${data}` : null);
    return source ? [`[image: ${source}]`] : ['[image]'];
  }
  if (type === 'audio') {
    const mimeType = nonEmptyString(entry.mimeType) ?? nonEmptyString(entry.mime_type);
    return [`[audio${mimeType ? `: ${mimeType}` : ''}]`];
  }
  if (type === 'resourcelink') {
    const uri = nonEmptyString(entry.uri);
    const name = nonEmptyString(entry.name);
    return uri ? [`[file: ${uri}]${name && name !== uri ? ` ${name}` : ''}`] : [];
  }
  if (type === 'resource') {
    const resource = record(entry.resource);
    const uri = nonEmptyString(resource?.uri);
    const text = nonEmptyString(resource?.text);
    return [uri ? `[resource: ${uri}]` : '[resource]', ...(text ? [text] : [])];
  }
  if (type === 'content') {
    return renderStructuredContent(entry.content, depth + 1);
  }
  if (type === 'diff') {
    const path = nonEmptyString(entry.path) ?? 'file';
    return [`[diff: ${path}]`, ...[entry.oldText, entry.newText].flatMap((part) => renderStructuredContent(part, depth + 1))];
  }
  if (type === 'terminal') {
    const terminalId = nonEmptyString(entry.terminalId) ?? nonEmptyString(entry.terminal_id);
    return [
      `[terminal${terminalId ? `: ${terminalId}` : ''}]`,
      ...['output', 'content'].flatMap((key) =>
        key in entry ? renderStructuredContent(entry[key], depth + 1) : []
      ),
    ];
  }
  const nested = ['content', 'structuredContent', 'structured_content', 'locations', 'result', 'output']
    .flatMap((key) => key in entry ? renderStructuredContent(entry[key], depth + 1) : []);
  if (nested.length > 0) {
    return nested;
  }
  const path = nonEmptyString(entry.path);
  const line = typeof entry.line === 'number' ? entry.line : null;
  return path ? [`[location: ${path}${line ? `:${line}` : ''}]`] : [];
}
