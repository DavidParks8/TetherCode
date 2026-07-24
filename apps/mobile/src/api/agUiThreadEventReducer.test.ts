import { EventType, type AGUIEvent } from '@ag-ui/core';

import type { AgUiEventEnvelope } from './agUi';
import { reduceThreadState } from './agUiThreadEventReducer';
import {
  MAX_RAW_EVENTS_PER_THREAD,
  createAgUiThreadMessageState,
} from './agUiMessagesState';

const THREAD_ID = 'thread-1';
const RUN_ID = 'run-1';

function envelope(event: Record<string, unknown>, runId = RUN_ID): AgUiEventEnvelope {
  return {
    threadId: THREAD_ID,
    runId,
    event: event as unknown as AGUIEvent,
  };
}

describe('agUiThreadEventReducer.reduceThreadState', () => {
  it('resets thread state on run started', () => {
    const seeded = {
      ...createAgUiThreadMessageState(),
      messages: [{ id: 'm1', role: 'assistant' as const, content: 'seed', createdAt: 'now' }],
      rawEvents: [{ source: 'seed', event: { ok: true } }],
    };

    const next = reduceThreadState(
      seeded,
      envelope({ type: EventType.RUN_STARTED, threadId: THREAD_ID, runId: RUN_ID }),
    );

    expect(next).toEqual(createAgUiThreadMessageState());
  });

  it('handles text start existing-message path and replacement metadata', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(
      state,
      envelope({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' }),
    );

    const withReplacement = reduceThreadState(
      state,
      envelope({
        type: EventType.TEXT_MESSAGE_START,
        messageId: 'm1',
        role: 'assistant',
        replacesMessageId: 'draft-1',
      }),
    );

    expect(withReplacement.messages).toHaveLength(1);
    expect(withReplacement.replacesMessageIdByMessageId).toEqual({ m1: 'draft-1' });
  });

  it('handles text chunk fallback id and empty delta path', () => {
    const withFallback = reduceThreadState(
      createAgUiThreadMessageState(),
      envelope({ type: EventType.TEXT_MESSAGE_CHUNK, delta: 'Hello' }),
    );
    expect(withFallback.messages[0]).toMatchObject({
      id: `${RUN_ID}:text`,
      role: 'assistant',
      content: 'Hello',
    });

    const noDelta = reduceThreadState(
      withFallback,
      envelope({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: `${RUN_ID}:text` }),
    );
    expect(noDelta).toBe(withFallback);
  });

  it('handles reasoning message creation, empty chunk deltas, and terminal markers', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_START, messageId: 'r1', role: 'reasoning' }),
    );
    const repeatedStart = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_MESSAGE_START, messageId: 'r1', role: 'reasoning' }),
    );
    expect(repeatedStart).toBe(state);

    state = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r1', delta: 'step-1' }),
    );

    const chunkNoDelta = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_MESSAGE_CHUNK, messageId: 'r1' }),
    );
    expect(chunkNoDelta).toBe(state);

    state = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_MESSAGE_CHUNK, delta: ' +chunk' }),
    );
    expect(state.messages.find((entry) => entry.id === `${RUN_ID}:reasoning`)?.content).toContain(' +chunk');

    state = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_MESSAGE_END, messageId: 'r1' }),
    );
    state = reduceThreadState(
      state,
      envelope({ type: EventType.REASONING_END, messageId: `${RUN_ID}:reasoning` }),
    );

    expect(state.terminalMessageIds).toEqual(expect.arrayContaining(['r1', `${RUN_ID}:reasoning`]));
  });

  it('updates encrypted values for message and tool-call subtypes', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(
      state,
      envelope({ type: EventType.TEXT_MESSAGE_START, messageId: 'assistant-1', role: 'assistant' }),
    );
    state = reduceThreadState(
      state,
      envelope({ type: EventType.TOOL_CALL_START, toolCallId: 'tool-1', toolCallName: 'readFile' }),
    );

    state = reduceThreadState(
      state,
      envelope({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        entityId: 'assistant-1',
        subtype: 'message',
        encryptedValue: 'enc-message',
      }),
    );
    state = reduceThreadState(
      state,
      envelope({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        entityId: 'tool-1',
        subtype: 'tool-call',
        encryptedValue: 'enc-tool',
      }),
    );

    expect(state.messages.find((entry) => entry.id === 'assistant-1')).toMatchObject({
      encryptedValue: 'enc-message',
    });
    const toolMessage = state.messages.find((entry) => entry.id === 'tool-call:tool-1');
    expect(toolMessage?.role).toBe('assistant');
    if (toolMessage?.role === 'assistant') {
      expect(toolMessage.toolCalls?.[0]).toMatchObject({ encryptedValue: 'enc-tool' });
    }
  });

  it('suppresses tool-call lifecycle events for subagent tool ids', () => {
    const current = {
      ...createAgUiThreadMessageState(),
      subagentToolCallIds: { suppressed: true as const },
    };

    const cases: Record<string, unknown>[] = [
      { type: EventType.TOOL_CALL_START, toolCallId: 'suppressed', toolCallName: 'tool' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'suppressed', delta: '{' },
      { type: EventType.TOOL_CALL_END, toolCallId: 'suppressed' },
      { type: EventType.TOOL_CALL_CHUNK, toolCallId: 'suppressed', delta: '{}' },
      { type: EventType.TOOL_CALL_RESULT, toolCallId: 'suppressed', messageId: 'm', content: 'x' },
    ];

    for (const event of cases) {
      expect(reduceThreadState(current, envelope(event))).toBe(current);
    }
  });

  it('handles tool-call chunk variants and unresolved terminal end', () => {
    const base = createAgUiThreadMessageState();
    expect(reduceThreadState(base, envelope({ type: EventType.TOOL_CALL_CHUNK }))).toBe(base);

    let state = reduceThreadState(
      base,
      envelope({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 'tc-1' }),
    );
    expect(state.messages.find((entry) => entry.id === 'tool-call:tc-1')).toBeDefined();

    state = reduceThreadState(
      state,
      envelope({ type: EventType.TOOL_CALL_CHUNK, toolCallId: 'tc-1', delta: '{"k":1}' }),
    );
    const tcMessage = state.messages.find((entry) => entry.id === 'tool-call:tc-1');
    expect(tcMessage?.role).toBe('assistant');
    if (tcMessage?.role === 'assistant') {
      expect(tcMessage.toolCalls?.[0]?.function.arguments).toContain('{"k":1}');
    }

    const unchanged = reduceThreadState(
      state,
      envelope({ type: EventType.TOOL_CALL_END, toolCallId: 'unknown-tool' }),
    );
    expect(unchanged).toBe(state);
  });

  it('applies message snapshots and activity snapshot/delta updates', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(
      state,
      envelope({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: 'a1', role: 'assistant', content: 'snapshot' },
          { id: 'u1', role: 'user', content: 'hello' },
        ],
      }),
    );
    expect(state.messages.map((entry) => entry.id)).toEqual(['a1', 'u1']);

    state = reduceThreadState(
      state,
      envelope({
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: 'activity-1',
        activityType: 'status',
        content: { text: 'working', progress: 1 },
      }),
    );
    state = reduceThreadState(
      state,
      envelope({
        type: EventType.ACTIVITY_DELTA,
        messageId: 'activity-1',
        activityType: 'status',
        patch: [{ op: 'replace', path: '/progress', value: 2 }],
      }),
    );

    expect(state.messages.find((entry) => entry.id === 'activity-1')).toMatchObject({
      role: 'activity',
      content: expect.objectContaining({ progress: 2 }),
    });
  });

  it('applies state snapshot and json-patch delta', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(
      state,
      envelope({ type: EventType.STATE_SNAPSHOT, snapshot: { count: 1, nested: { ok: true } } }),
    );
    state = reduceThreadState(
      state,
      envelope({
        type: EventType.STATE_DELTA,
        delta: [
          { op: 'replace', path: '/count', value: 2 },
          { op: 'add', path: '/nested/value', value: 'yes' },
        ],
      }),
    );

    expect(state.state).toEqual({ count: 2, nested: { ok: true, value: 'yes' } });
  });

  it('tracks step lifecycle, raw event cap, and custom metadata', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(state, envelope({ type: EventType.STEP_STARTED, stepName: 'compile' }));
    state = reduceThreadState(state, envelope({ type: EventType.STEP_FINISHED, stepName: 'compile' }));
    expect(state.steps.compile).toBe('finished');

    for (let index = 0; index < MAX_RAW_EVENTS_PER_THREAD + 5; index += 1) {
      state = reduceThreadState(
        state,
        envelope({ type: EventType.RAW, source: `s-${index}`, event: { i: index } }),
      );
    }
    expect(state.rawEvents).toHaveLength(MAX_RAW_EVENTS_PER_THREAD);
    expect(state.rawEvents[0]).toEqual({
      source: 's-5',
      event: { i: 5 },
    });

    state = reduceThreadState(
      state,
      envelope({ type: EventType.CUSTOM, name: 'tethercode.dev/custom-meta', value: { ok: true } }),
    );
    expect(state.customMetadata['tethercode.dev/custom-meta']).toEqual({ ok: true });
  });

  it('marks all messages terminal for run finished and run error', () => {
    let state = createAgUiThreadMessageState();
    state = reduceThreadState(
      state,
      envelope({ type: EventType.TEXT_MESSAGE_START, messageId: 'm1', role: 'assistant' }, 'run-finished'),
    );
    state = reduceThreadState(
      state,
      envelope({ type: EventType.TEXT_MESSAGE_START, messageId: 'm2', role: 'assistant' }, 'run-error'),
    );

    state = reduceThreadState(state, envelope({ type: EventType.RUN_FINISHED }, 'run-finished'));
    state = reduceThreadState(state, envelope({ type: EventType.RUN_ERROR }, 'run-error'));

    expect(state.terminalMessageIds).toEqual(expect.arrayContaining(['m1', 'm2']));
  });

  it('returns current state for unknown event types', () => {
    const state = createAgUiThreadMessageState();
    const next = reduceThreadState(state, envelope({ type: 'tethercode.dev/unknown-event' }));
    expect(next).toBe(state);
  });
});