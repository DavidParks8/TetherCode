import { EventType, type AGUIEvent } from '@ag-ui/core';
import { getMessageText, getSubAgentMeta } from '../messages';
import { SUPPORTED_AG_UI_EVENT_TYPES } from '../agUiMessages';

import {
  type AgUiLiveAssistantMessages,
  createAgUiThreadMessageState,
  parseAgUiEventNotification,
  updateAgUiLiveAssistantMessages,
} from '../agUi';

const notification = {
  method: 'bridge/agui.event',
  protocolVersion: 2,
  streamId: 'stream',
  eventId: 8,
  params: {
    threadId: 'agent-alpha:thread-1',
    runId: 'agent-alpha:thread-1::turn::turn-1',
    event: {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'agent-alpha:thread-1::item::message-1',
      delta: 'Hello',
      timestamp: 1784371200000,
    },
  },
};

function messages(state: AgUiLiveAssistantMessages, threadId = 'thread') {
  return state[threadId]?.messages ?? [];
}

describe('AG-UI bridge notifications', () => {
  it('handles every event type exported by the installed AG-UI core', () => {
    expect(SUPPORTED_AG_UI_EVENT_TYPES).toEqual(new Set(Object.values(EventType)));
  });
  it('parses canonical text events and projects them to the migration reducer', () => {
    expect(parseAgUiEventNotification(notification)).toEqual(notification.params);
  });

  it('preserves official user message role across start and chunk events', () => {
    let state = updateAgUiLiveAssistantMessages({}, {
      threadId: 'thread',
      runId: 'run',
      event: { type: EventType.TEXT_MESSAGE_START, messageId: 'user', role: 'user' },
    });
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread',
      runId: 'run',
      event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'user', delta: 'hello' },
    });
    expect(messages(state)).toEqual([
      expect.objectContaining({ id: 'user', role: 'user', content: 'hello' }),
    ]);
  });

  it('preserves ordered live text and structured message parts', () => {
    const events: AGUIEvent[] = [
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta: 'A' },
      {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/message-content',
        value: { messageId: 'message', role: 'agent', content: { type: 'image', url: 'image.png' } },
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta: 'B' },
      {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/message-content',
        value: {
          messageId: 'message',
          role: 'agent',
          content: { type: 'resource', resource: { uri: 'file:///result', text: 'result' } },
        },
      },
      {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/message-content',
        value: {
          messageId: 'message',
          role: 'agent',
          content: { type: 'audio', mimeType: 'audio/wav', data: 'YQ==' },
        },
      },
    ];
    const state = events.reduce(
      (current, event) => updateAgUiLiveAssistantMessages(current, {
        threadId: 'thread', runId: 'run', event,
      }),
      {} as AgUiLiveAssistantMessages
    );
    expect(messages(state)[0]?.parts).toEqual([
      { type: 'text', text: 'A' },
      { type: 'image', url: 'image.png' },
      { type: 'text', text: 'B' },
      { type: 'resource', resource: { uri: 'file:///result', text: 'result' } },
      { type: 'audio', mimeType: 'audio/wav', data: 'YQ==' },
    ]);
    expect(getMessageText(messages(state)[0]!)).toMatch(/A[\s\S]*image\.png[\s\S]*B[\s\S]*result[\s\S]*audio\/wav/);
  });

  it('keeps first-seen canonical order when tools and reasoning receive later updates', () => {
    const events: AGUIEvent[] = [
      { type: EventType.TEXT_MESSAGE_START, messageId: 'message-a', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message-a', delta: 'A' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'tool-t', toolCallName: 'T' },
      { type: EventType.TEXT_MESSAGE_START, messageId: 'message-b', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message-b', delta: 'B' },
      { type: EventType.REASONING_MESSAGE_START, messageId: 'reasoning-r', role: 'reasoning' },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'reasoning-r', delta: 'R' },
      {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/tool-text',
        value: { toolCallId: 'tool-t', revision: 'updated', content: 'updated' },
      },
    ];
    const state = events.reduce(
      (current, event) => updateAgUiLiveAssistantMessages(current, {
        threadId: 'thread', runId: 'run', event,
      }),
      {} as AgUiLiveAssistantMessages
    );
    expect(messages(state).map((message) => message.id)).toEqual([
      'message-a', 'tool-call:tool-t', 'message-b', 'reasoning-r', 'tool-result:tool-t',
    ]);
  });

  it('validates every oversized chunk and reconstructs exact structured bytes', () => {
    const text = 'a🙂界'.repeat(12_000);
    const textChunks = [text.slice(0, 20_000), text.slice(20_000)];
    for (const delta of textChunks) {
      expect(parseAgUiEventNotification({
        method: 'bridge/agui.event',
        params: {
          threadId: 'thread',
          runId: 'run',
          event: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta },
        },
      })).not.toBeNull();
    }
    expect(textChunks.join('')).toBe(text);

    const serialized = JSON.stringify({
      toolCallId: 'tool',
      revision: 'payload',
      content: [{ type: 'terminal', output: text }],
      locations: [],
    });
    const structuredChunks = [serialized.slice(0, 16_000), serialized.slice(16_000)];
    let state: AgUiLiveAssistantMessages = {};
    structuredChunks.forEach((data, index) => {
      const parsed = parseAgUiEventNotification({
        method: 'bridge/agui.event',
        params: {
          threadId: 'thread',
          runId: 'run',
          event: {
            type: EventType.CUSTOM,
            name: 'tethercode.dev/tool-content-chunk',
            value: {
              canonicalId: 'tool',
              revision: 'sha256:fixture',
              index,
              count: structuredChunks.length,
              data,
              retrieval: { method: 'thread/read', threadId: 'thread', canonicalId: 'tool' },
            },
          },
        },
      });
      expect(parsed).not.toBeNull();
      state = updateAgUiLiveAssistantMessages(state, parsed!);
    });
    expect(structuredChunks.join('')).toBe(serialized);
    expect(getMessageText(messages(state)[0]!)).toContain(text);
  });

  it('validates lifecycle routing and accepts official custom events', () => {
    expect(parseAgUiEventNotification({
      method: 'bridge/agui.event',
      params: {
        threadId: 'thread',
        runId: 'run',
        event: { type: EventType.RUN_STARTED, threadId: 'other', runId: 'run' },
      },
    })).toBeNull();
    expect(parseAgUiEventNotification({
      method: 'bridge/agui.event',
      params: {
        threadId: 'thread',
        runId: 'run',
        event: { type: EventType.CUSTOM, name: 'tethercode.dev/plan', value: { entries: [] } },
      },
    })?.event).toMatchObject({ type: EventType.CUSTOM, name: 'tethercode.dev/plan' });
    expect(parseAgUiEventNotification({
      method: 'bridge/agui.event',
      params: {
        threadId: 'thread',
        runId: 'run',
        event: {
          type: EventType.CUSTOM,
          name: 'tethercode.dev/tool-content',
          value: {
            toolCallId: 'tool',
            content: [
              { type: 'content', content: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } },
              { type: 'diff', path: '/tmp/file', oldText: 'old', newText: 'new' },
              { type: 'terminal', terminalId: 'terminal-1' },
            ],
            locations: [{ path: '/tmp/file', line: 7 }],
          },
        },
      },
    })?.event).toMatchObject({
      type: EventType.CUSTOM,
      name: 'tethercode.dev/tool-content',
    });
  });

  it('reduces reasoning, tools, results, and custom content into bounded live projection state', () => {
    const events = [
      { type: EventType.REASONING_MESSAGE_START, messageId: 'reasoning', role: 'reasoning' },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'reasoning', delta: 'thinking' },
      { type: EventType.REASONING_MESSAGE_END, messageId: 'reasoning' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'tool', toolCallName: 'read' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'tool', delta: '{}' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'tool' },
      { type: EventType.TOOL_CALL_RESULT, messageId: 'tool-result', toolCallId: 'tool', role: 'tool', content: 'done' },
    ];
    let state: AgUiLiveAssistantMessages = {};
    for (const event of events) {
      const parsed = parseAgUiEventNotification({
        method: 'bridge/agui.event',
        params: { threadId: 'thread', runId: 'run', event },
      });
      expect(parsed?.event.type).toBe(event.type);
      state = updateAgUiLiveAssistantMessages(state, parsed!);
    }
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread',
      runId: 'run',
      event: {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/message-content',
        value: { messageId: 'image', role: 'agent', content: { type: 'image', mimeType: 'image/png', data: 'redacted-fixture' } },
      },
    });
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread',
      runId: 'run',
      event: { type: EventType.CUSTOM, name: 'tethercode.dev/usage', value: { used: 10, size: 100 } },
    });
    expect(messages(state)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reasoning', role: 'reasoning', content: 'thinking' }),
      expect.objectContaining({ id: 'tool-result', role: 'tool', toolCallId: 'tool', content: expect.stringContaining('done') }),
      expect.objectContaining({ id: 'image', role: 'assistant' }),
    ]));
    expect(state.thread?.customMetadata['tethercode.dev/usage']).toEqual({ used: 10, size: 100 });
    expect(state.thread?.terminalMessageIds).toEqual(expect.arrayContaining(['reasoning', 'tool-call:tool']));

    for (let index = 0; index < 140; index += 1) {
      state = updateAgUiLiveAssistantMessages(state, {
        threadId: 'thread',
        runId: 'run',
        event: { type: EventType.CUSTOM, name: `tethercode.dev/config-${index}`, value: { index } },
      });
    }
    expect(messages(state).length).toBeLessThanOrEqual(128);
    expect(state.thread?.customMetadataOrder).toHaveLength(128);
  });

  it('rejects malformed typed fields', () => {
    expect(parseAgUiEventNotification({
      method: 'bridge/agui.event',
      params: {
        threadId: 'thread',
        runId: 'run',
        event: { type: EventType.TEXT_MESSAGE_START, messageId: 'message', role: 3 },
      },
    })).toBeNull();
    expect(parseAgUiEventNotification({
      method: 'bridge/agui.event',
      params: {
        threadId: 'thread',
        runId: 'run',
        event: { type: EventType.RUN_ERROR, message: 'boom', timestamp: 'now' },
      },
    })).toBeNull();
  });

  it('stores duplicate command metadata without rendering transcript rows', () => {
    const commandEvent: AGUIEvent = {
      type: EventType.CUSTOM,
      name: 'tethercode.dev/commands',
      value: { commands: [{ name: 'review', description: 'Review changes' }] },
    };
    let state: AgUiLiveAssistantMessages = {};
    state = updateAgUiLiveAssistantMessages(state, { threadId: 'thread', runId: 'run', event: commandEvent });
    state = updateAgUiLiveAssistantMessages(state, { threadId: 'thread', runId: 'run', event: commandEvent });

    expect(messages(state)).toEqual([]);
    expect(state.thread?.customMetadata['tethercode.dev/commands']).toEqual(commandEvent.value);
    expect(state.thread?.customMetadataOrder).toEqual(['tethercode.dev/commands']);
  });

  it('keeps live assistant messages isolated by thread and run', () => {
    const first = parseAgUiEventNotification(notification)!;
    const state = updateAgUiLiveAssistantMessages({}, first);
    const otherThread = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread:other',
      runId: 'other-run',
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'other-message',
        delta: 'Other',
      },
    });
    expect(getMessageText(messages(otherThread, 'agent-alpha:thread-1')[0]!)).toBe('Hello');
    expect(getMessageText(messages(otherThread, 'thread:other')[0]!)).toBe('Other');

    const appended = updateAgUiLiveAssistantMessages(otherThread, {
      threadId: first.threadId,
      runId: first.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'agent-alpha:thread-1::item::message-1',
        delta: ' there',
      },
    });
    expect(getMessageText(messages(appended, 'agent-alpha:thread-1')[0]!)).toBe('Hello there');

    const repeated = updateAgUiLiveAssistantMessages(appended, {
      threadId: first.threadId,
      runId: first.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'agent-alpha:thread-1::item::message-1',
        delta: ' there',
      },
    });
    expect(getMessageText(messages(repeated, 'agent-alpha:thread-1')[0]!)).toBe('Hello there there');

    const secondMessage = updateAgUiLiveAssistantMessages(repeated, {
      threadId: first.threadId,
      runId: first.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'agent-alpha:thread-1::item::message-2',
        delta: 'Second message',
      },
    });
    expect(messages(secondMessage, 'agent-alpha:thread-1').map(getMessageText)).toEqual([
      'Hello there there',
      'Second message',
    ]);

    const completed = updateAgUiLiveAssistantMessages(secondMessage, {
      threadId: first.threadId,
      runId: first.runId,
      event: { type: EventType.RUN_FINISHED, threadId: first.threadId, runId: first.runId },
    });
    expect(completed['agent-alpha:thread-1']?.terminalMessageIds).toEqual(
      messages(completed, 'agent-alpha:thread-1').map((message) => message.id)
    );
    expect(completed['thread:other']).toBeDefined();
    const nextRun = updateAgUiLiveAssistantMessages(completed, {
      threadId: first.threadId,
      runId: 'next-run',
      event: { type: EventType.RUN_STARTED, threadId: first.threadId, runId: 'next-run' },
    });
    expect(messages(nextRun, 'agent-alpha:thread-1')).toEqual([]);
    expect(nextRun['thread:other']).toBeDefined();
  });

  it('does not clear a newer live message for a stale terminal event', () => {
    const current = {
      'agent-alpha:thread-1': {
        ...createAgUiThreadMessageState(),
        messages: [{ id: 'message', role: 'assistant' as const, content: 'current', createdAt: 'now' }],
        runByMessageId: { message: 'new-run' },
      },
    };
    expect(updateAgUiLiveAssistantMessages(current, {
      threadId: 'agent-alpha:thread-1',
      runId: 'old-run',
      event: { type: EventType.RUN_ERROR, message: 'superseded' },
    })).toBe(current);
  });

  it('records explicit message replacement metadata', () => {
    const state = updateAgUiLiveAssistantMessages({}, {
      threadId: 'thread:active',
      runId: 'run',
      event: {
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'final',
        role: 'assistant',
        replacesMessageId: 'draft',
      },
    });

    expect(messages(state, 'thread:active')[0]).toMatchObject({ id: 'final' });
    expect(state['thread:active']?.replacesMessageIdByMessageId).toEqual({ final: 'draft' });
    const withContent = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread:active',
      runId: 'run',
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'final',
        delta: 'Corrected',
      },
    });
    expect(messages(withContent, 'thread:active')[0]).toMatchObject({ content: 'Corrected' });
  });

  it('reconciles reasoning and tools by canonical id in either snapshot order', () => {
    const snapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: 'reasoning', role: 'reasoning' as const, content: 'snapshot reasoning' },
        {
          id: 'tool-call:tool',
          role: 'assistant' as const,
          content: '',
          toolCalls: [{
            id: 'tool',
            type: 'function' as const,
            function: { name: 'live tool', arguments: '{}' },
          }],
        },
      ],
    };
    const liveEvents = [
      { type: EventType.REASONING_MESSAGE_START, messageId: 'reasoning', role: 'reasoning' as const },
      { type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'reasoning', delta: 'live reasoning' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'tool', toolCallName: 'live tool' },
    ];
    const reduce = (events: AGUIEvent[]) => events.reduce(
      (state, event) => updateAgUiLiveAssistantMessages(state, {
        threadId: 'thread', runId: 'run', event,
      }),
      {} as AgUiLiveAssistantMessages
    );

    for (const events of [[...liveEvents, snapshot], [snapshot, ...liveEvents]]) {
      const reduced = reduce(events as AGUIEvent[]);
      const reducedMessages = messages(reduced);
      expect(reducedMessages.filter((message) => message.id === 'reasoning')).toHaveLength(1);
      expect(reducedMessages.filter((message) => message.id === 'tool-call:tool')).toHaveLength(1);
      expect(getMessageText(reducedMessages.find((message) => message.id === 'reasoning')!)).toBeTruthy();
    }
  });

  it('upserts repeated structured terminal payloads by revision', () => {
    let state = updateAgUiLiveAssistantMessages({}, {
      threadId: 'thread',
      runId: 'run',
      event: { type: EventType.TOOL_CALL_START, toolCallId: 'tool', toolCallName: 'terminal' },
    });
    const structured = (revision: string, terminalId: string): AGUIEvent => ({
      type: EventType.CUSTOM,
      name: 'tethercode.dev/tool-content',
      value: {
        toolCallId: 'tool',
        revision,
        content: [{ type: 'terminal', terminalId }],
        locations: [],
      },
    });
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread', runId: 'run', event: structured('one', 'terminal-1'),
    });
    const repeated = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread', runId: 'run', event: structured('one', 'terminal-1'),
    });
    expect(repeated).toBe(state);
    const replaced = updateAgUiLiveAssistantMessages(repeated, {
      threadId: 'thread', runId: 'run', event: structured('two', 'terminal-2'),
    });
    expect(messages(replaced)).toHaveLength(2);
    expect(getMessageText(messages(replaced).find((message) => message.role === 'tool')!)).toContain('terminal-2');
    expect(getMessageText(messages(replaced).find((message) => message.role === 'tool')!)).not.toContain('terminal-1');
    const cleared = updateAgUiLiveAssistantMessages(replaced, {
      threadId: 'thread',
      runId: 'run',
      event: {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/tool-content',
        value: { toolCallId: 'tool', revision: 'empty', content: [], locations: [] },
      },
    });
    expect(getMessageText(messages(cleared).find((message) => message.role === 'tool')!)).not.toContain('terminal-2');
    expect(cleared.thread?.structuredTextByCallId.tool).toBe('');
  });

  it('replaces revisioned tool text and only appends official suffix deltas', () => {
    let state = updateAgUiLiveAssistantMessages({}, {
      threadId: 'thread',
      runId: 'run',
      event: { type: EventType.TOOL_CALL_START, toolCallId: 'tool', toolCallName: 'terminal' },
    });
    const replacement = (revision: string, content: string): AGUIEvent => ({
      type: EventType.CUSTOM,
      name: 'tethercode.dev/tool-text',
      value: { toolCallId: 'tool', revision, content },
    });
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread', runId: 'run', event: replacement('one', 'first'),
    });
    const duplicate = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread', runId: 'run', event: replacement('one', 'first'),
    });
    expect(duplicate).toBe(state);
    state = updateAgUiLiveAssistantMessages(duplicate, {
      threadId: 'thread', runId: 'run', event: replacement('two', 'second'),
    });
    expect(getMessageText(messages(state).find((message) => message.role === 'tool')!)).toContain('second');
    expect(getMessageText(messages(state).find((message) => message.role === 'tool')!)).not.toContain('first');
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread',
      runId: 'run',
      event: {
        type: EventType.TOOL_CALL_RESULT,
        messageId: 'result',
        toolCallId: 'tool',
        role: 'tool',
        content: '!',
      },
    });
    expect(getMessageText(messages(state).find((message) => message.role === 'tool')!)).toContain('second!');
    expect(getMessageText(messages(state).find((message) => message.role === 'tool')!)).not.toContain('firstsecond');
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread', runId: 'run', event: replacement('empty', ''),
    });
    expect(getMessageText(messages(state).find((message) => message.role === 'tool')!)).not.toContain('second!');
  });

  it('replaces a generic task tool row with one typed subagent card', () => {
    let state = updateAgUiLiveAssistantMessages({}, {
      threadId: 'parent',
      runId: 'run',
      event: { type: EventType.TOOL_CALL_START, toolCallId: 'task-1', toolCallName: 'task' },
    });
    const subagent: AGUIEvent = {
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: 'subagent:task-1',
      activityType: 'tethercode.subagent',
      replace: true,
      content: {
        text: '• Spawning sub-agent\n  Thread: child\n  Status: running\n  Result: Inspected README.',
        subAgent: {
          toolCallId: 'task-1',
          tool: 'spawnAgent',
          senderThreadId: 'parent',
          receiverThreadIds: ['child'],
          agentStatus: 'running',
          navigable: false,
        },
      },
    };
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'parent', runId: 'run', event: subagent,
    });
    expect(messages(state, 'parent')).toHaveLength(1);
    const message = messages(state, 'parent')[0]!;
    expect(message).toMatchObject({
      id: 'subagent:task-1',
      role: 'activity',
      activityType: 'tethercode.subagent',
    });
    expect(getSubAgentMeta(message)).toEqual({
      toolCallId: 'task-1',
        tool: 'spawnAgent',
        senderThreadId: 'parent',
        receiverThreadIds: ['child'],
        agentStatus: 'running',
        navigable: false,
    });
    expect(getMessageText(message)).toContain('Result: Inspected README.');
    const repeated = updateAgUiLiveAssistantMessages(state, {
      threadId: 'parent', runId: 'run', event: subagent,
    });
    expect(messages(repeated, 'parent')).toHaveLength(1);

    for (const event of [
      { type: EventType.TOOL_CALL_START, toolCallId: 'task-1', toolCallName: 'task' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'task-1', delta: '{}' },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: 'late-result',
        toolCallId: 'task-1',
        role: 'tool',
        content: 'late result',
      },
      {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/tool-text',
        value: { toolCallId: 'task-1', revision: 'late-text', content: 'late text' },
      },
      {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/tool-content',
        value: { toolCallId: 'task-1', revision: 'late-content', content: [], locations: [] },
      },
    ] as AGUIEvent[]) {
      state = updateAgUiLiveAssistantMessages(state, {
        threadId: 'parent', runId: 'run', event,
      });
    }
    expect(messages(state, 'parent')).toHaveLength(1);
    expect(messages(state, 'parent')[0]).toMatchObject({ id: 'subagent:task-1' });
  });
});
