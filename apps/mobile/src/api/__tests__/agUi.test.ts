import { EventType, type AGUIEvent } from '@ag-ui/core';

import {
  type AgUiLiveAssistantMessages,
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

describe('AG-UI bridge notifications', () => {
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
    expect(state.thread).toEqual([
      expect.objectContaining({ messageId: 'user', role: 'user', text: 'hello' }),
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
    expect(state.thread[0]?.parts).toEqual([
      { type: 'text', text: 'A' },
      { type: 'image', url: 'image.png' },
      { type: 'text', text: 'B' },
      { type: 'resource', resource: { uri: 'file:///result', text: 'result' } },
      { type: 'audio', mimeType: 'audio/wav', data: 'YQ==' },
    ]);
    expect(state.thread[0]?.text).toMatch(/A[\s\S]*image\.png[\s\S]*B[\s\S]*result[\s\S]*audio\/wav/);
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
    expect(state.thread.map((message) => message.messageId)).toEqual([
      'message-a', 'tool:tool-t', 'message-b', 'reasoning-r',
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
    expect(state.thread?.[0]?.text).toContain(text);
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
    expect(state.thread).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 'reasoning', text: 'thinking', systemKind: 'reasoning', terminal: true }),
      expect.objectContaining({ messageId: 'tool:tool', text: expect.stringContaining('done'), systemKind: 'tool', terminal: true }),
      expect.objectContaining({ messageId: 'image', text: expect.stringContaining('image/png') }),
      expect.objectContaining({ messageId: 'run:custom:tethercode.dev/usage', text: expect.stringContaining('used') }),
    ]));

    for (let index = 0; index < 140; index += 1) {
      state = updateAgUiLiveAssistantMessages(state, {
        threadId: 'thread',
        runId: 'run',
        event: { type: EventType.CUSTOM, name: `tethercode.dev/config-${index}`, value: { index } },
      });
    }
    expect(state.thread).toHaveLength(128);
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
    expect(otherThread['agent-alpha:thread-1']?.[0]?.text).toBe('Hello');
    expect(otherThread['thread:other']?.[0]?.text).toBe('Other');

    const appended = updateAgUiLiveAssistantMessages(otherThread, {
      threadId: first.threadId,
      runId: first.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'agent-alpha:thread-1::item::message-1',
        delta: ' there',
      },
    });
    expect(appended['agent-alpha:thread-1']?.[0]?.text).toBe('Hello there');

    const repeated = updateAgUiLiveAssistantMessages(appended, {
      threadId: first.threadId,
      runId: first.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'agent-alpha:thread-1::item::message-1',
        delta: ' there',
      },
    });
    expect(repeated['agent-alpha:thread-1']?.[0]?.text).toBe('Hello there there');

    const secondMessage = updateAgUiLiveAssistantMessages(repeated, {
      threadId: first.threadId,
      runId: first.runId,
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'agent-alpha:thread-1::item::message-2',
        delta: 'Second message',
      },
    });
    expect(secondMessage['agent-alpha:thread-1']?.map((message) => message.text)).toEqual([
      'Hello there there',
      'Second message',
    ]);

    const completed = updateAgUiLiveAssistantMessages(secondMessage, {
      threadId: first.threadId,
      runId: first.runId,
      event: { type: EventType.RUN_FINISHED, threadId: first.threadId, runId: first.runId },
    });
    expect(completed['agent-alpha:thread-1']?.every((message) => message.terminal)).toBe(true);
    expect(completed['thread:other']).toBeDefined();
    const nextRun = updateAgUiLiveAssistantMessages(completed, {
      threadId: first.threadId,
      runId: 'next-run',
      event: { type: EventType.RUN_STARTED, threadId: first.threadId, runId: 'next-run' },
    });
    expect(nextRun['agent-alpha:thread-1']).toBeUndefined();
    expect(nextRun['thread:other']).toBeDefined();
  });

  it('does not clear a newer live message for a stale terminal event', () => {
    const current = {
      'agent-alpha:thread-1': [{ runId: 'new-run', messageId: 'message', text: 'current' }],
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

    expect(state['thread:active']?.[0]).toMatchObject({
      messageId: 'final',
      replacesMessageId: 'draft',
    });
    const withContent = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread:active',
      runId: 'run',
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: 'final',
        delta: 'Corrected',
      },
    });
    expect(withContent['thread:active']?.[0]).toMatchObject({
      text: 'Corrected',
      replacesMessageId: 'draft',
    });
  });

  it('reconciles reasoning and tools by canonical id in either snapshot order', () => {
    const snapshot = {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: 'reasoning', role: 'reasoning' as const, content: 'snapshot reasoning' },
        { id: 'tool:tool', role: 'assistant' as const, content: 'snapshot tool' },
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
      const messages = reduce(events as AGUIEvent[]).thread;
      expect(messages.filter((message) => message.messageId === 'reasoning')).toHaveLength(1);
      expect(messages.filter((message) => message.messageId === 'tool:tool')).toHaveLength(1);
      expect(messages.find((message) => message.messageId === 'reasoning')?.text).toBeTruthy();
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
    expect(replaced.thread).toHaveLength(1);
    expect(replaced.thread[0]?.text).toContain('terminal-2');
    expect(replaced.thread[0]?.text).not.toContain('terminal-1');
    const cleared = updateAgUiLiveAssistantMessages(replaced, {
      threadId: 'thread',
      runId: 'run',
      event: {
        type: EventType.CUSTOM,
        name: 'tethercode.dev/tool-content',
        value: { toolCallId: 'tool', revision: 'empty', content: [], locations: [] },
      },
    });
    expect(cleared.thread[0]?.text).not.toContain('terminal-2');
    expect(cleared.thread[0]?.structuredText).toBe('');
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
    expect(state.thread[0]?.text).toContain('second');
    expect(state.thread[0]?.text).not.toContain('first');
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
    expect(state.thread[0]?.text).toContain('second!');
    expect(state.thread[0]?.text).not.toContain('firstsecond');
    state = updateAgUiLiveAssistantMessages(state, {
      threadId: 'thread', runId: 'run', event: replacement('empty', ''),
    });
    expect(state.thread[0]?.text).not.toContain('second!');
    expect(state.thread[0]?.toolText).toBe('');
  });
});
