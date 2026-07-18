import type { ChatSummary, RpcNotification } from '../../api/types';
import {
  countDrawerRunningChats,
  extractDrawerNotificationThreadId,
  extractDrawerStatusHint,
  isDrawerChatRunning,
  isDrawerWorkspaceSectionRunning,
  reconcileDrawerRunIndicatorsWithChats,
  pruneStaleDrawerRunIndicators,
  updateDrawerRunIndicatorsForEvent,
  type DrawerRunIndicatorMap,
} from '../drawerRuntimeIndicators';
import type { ChatWorkspaceSection } from '../chatThreadTree';

function chat(id: string, partial: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: partial.title ?? id,
    status: partial.status ?? 'idle',
    createdAt: partial.createdAt ?? '2026-04-01T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-04-01T00:00:00.000Z',
    statusUpdatedAt: partial.statusUpdatedAt ?? '2026-04-01T00:00:00.000Z',
    lastMessagePreview: partial.lastMessagePreview ?? '',
    cwd: partial.cwd,
    engine: partial.engine,
    modelProvider: partial.modelProvider,
    sourceKind: partial.sourceKind,
    parentThreadId: partial.parentThreadId,
    subAgentDepth: partial.subAgentDepth,
    lastRunStartedAt: partial.lastRunStartedAt,
    lastRunFinishedAt: partial.lastRunFinishedAt,
    lastRunDurationMs: partial.lastRunDurationMs,
    lastRunExitCode: partial.lastRunExitCode,
    lastRunTimedOut: partial.lastRunTimedOut,
    lastError: partial.lastError,
  };
}

function event(method: string, params: RpcNotification['params']): RpcNotification {
  return {
    method,
    params,
  };
}

function section(chats: ChatSummary[]): ChatWorkspaceSection {
  return {
    key: 'workspace',
    title: 'workspace',
    itemCount: chats.length,
    data: chats.map((entry) => ({
      chat: entry,
      indentLevel: 0,
      rootThreadId: entry.id,
    })),
  };
}

describe('drawerRuntimeIndicators', () => {
  it('keeps turn-start lifecycle indicators beyond the short heartbeat window', () => {
    const state = updateDrawerRunIndicatorsForEvent(
      {},
      event('turn/started', {
        threadId: 'thr_1',
        turnId: 'turn_1',
      }),
      1000
    );

    expect(isDrawerChatRunning(chat('thr_1'), state, 25_000)).toBe(true);
    expect(countDrawerRunningChats([chat('thr_1'), chat('thr_2')], state, 25_000)).toBe(1);
  });

  it('clears lifecycle indicators on turn completion', () => {
    const running = updateDrawerRunIndicatorsForEvent(
      {},
      event('turn/started', {
        threadId: 'thr_1',
        turnId: 'turn_1',
      }),
      1000
    );
    const complete = updateDrawerRunIndicatorsForEvent(
      running,
      event('turn/completed', {
        threadId: 'thr_1',
        turn: {
          id: 'turn_1',
          status: 'completed',
        },
      }),
      2000
    );

    expect(isDrawerChatRunning(chat('thr_1'), complete, 3000)).toBe(false);
  });

  it('uses thread status changes as authoritative running and terminal hints', () => {
    const running = updateDrawerRunIndicatorsForEvent(
      {},
      event('thread/status/changed', {
        thread: {
          id: 'thr_1',
          status: {
            type: 'in_progress',
          },
        },
      }),
      1000
    );
    expect(isDrawerChatRunning(chat('thr_1'), running, 25_000)).toBe(true);

    const complete = updateDrawerRunIndicatorsForEvent(
      running,
      event('thread/status/changed', {
        thread: {
          id: 'thr_1',
          status: {
            type: 'completed',
          },
        },
      }),
      2000
    );
    expect(isDrawerChatRunning(chat('thr_1'), complete, 3000)).toBe(false);
  });

  it('handles Codex task start and task completion events', () => {
    const running = updateDrawerRunIndicatorsForEvent(
      {},
      event('codex/event/task_started', {
        msg: {
          type: 'task_started',
          thread_id: 'codex:thr_1',
        },
      }),
      1000
    );
    expect(isDrawerChatRunning(chat('codex:thr_1'), running, 25_000)).toBe(true);

    const complete = updateDrawerRunIndicatorsForEvent(
      running,
      event('codex/event/task_complete', {
        msg: {
          type: 'task_complete',
          thread_id: 'codex:thr_1',
        },
      }),
      2000
    );
    expect(isDrawerChatRunning(chat('codex:thr_1'), complete, 3000)).toBe(false);
  });

  it('does not let an older idle chat snapshot erase a newer live event', () => {
    const state = updateDrawerRunIndicatorsForEvent(
      {},
      event('turn/started', {
        threadId: 'thr_1',
      }),
      Date.parse('2026-04-01T00:01:00.000Z')
    );
    const reconciled = reconcileDrawerRunIndicatorsWithChats(
      state,
      [
        chat('thr_1', {
          status: 'idle',
          updatedAt: '2026-04-01T00:00:00.000Z',
          statusUpdatedAt: '2026-04-01T00:00:00.000Z',
        }),
      ],
      Date.parse('2026-04-01T00:02:00.000Z')
    );

    expect(isDrawerChatRunning(chat('thr_1'), reconciled, Date.parse('2026-04-01T00:02:00.000Z'))).toBe(
      true
    );
  });

  it('lets a newer non-running chat snapshot clear stale live state', () => {
    const state = updateDrawerRunIndicatorsForEvent(
      {},
      event('turn/started', {
        threadId: 'thr_1',
      }),
      Date.parse('2026-04-01T00:01:00.000Z')
    );
    const reconciled = reconcileDrawerRunIndicatorsWithChats(
      state,
      [
        chat('thr_1', {
          status: 'complete',
          updatedAt: '2026-04-01T00:02:00.000Z',
          statusUpdatedAt: '2026-04-01T00:02:00.000Z',
        }),
      ],
      Date.parse('2026-04-01T00:03:00.000Z')
    );

    expect(isDrawerChatRunning(chat('thr_1'), reconciled, Date.parse('2026-04-01T00:03:00.000Z'))).toBe(
      false
    );
  });

  it('extracts nested thread ids and normalized status hints', () => {
    const params = {
      threadState: {
        threadId: 'thr_nested',
        status: {
          type: 'not_loaded',
        },
      },
    };

    expect(extractDrawerNotificationThreadId(params)).toBe('thr_nested');
    expect(extractDrawerStatusHint(params)).toBe('notloaded');
  });

  it('preserves lifecycle source when heartbeat progress arrives later', () => {
    const lifecycle = updateDrawerRunIndicatorsForEvent(
      {},
      event('turn/started', {
        threadId: 'thr_1',
      }),
      1000
    );
    const refreshed = updateDrawerRunIndicatorsForEvent(
      lifecycle,
      event('item/reasoning/textDelta', {
        threadId: 'thr_1',
      }),
      5000
    );

    expect((refreshed as DrawerRunIndicatorMap).thr_1?.source).toBe('lifecycle');
    expect(isDrawerChatRunning(chat('thr_1'), refreshed, 30_000)).toBe(true);
  });

  it('marks a workspace section live when any chat inside it is live', () => {
    const state = updateDrawerRunIndicatorsForEvent(
      {},
      event('turn/started', {
        threadId: 'thr_live',
      }),
      1000
    );

    expect(isDrawerWorkspaceSectionRunning(section([chat('thr_idle'), chat('thr_live')]), state, 25_000)).toBe(
      true
    );
    expect(isDrawerWorkspaceSectionRunning(section([chat('thr_idle')]), state, 25_000)).toBe(
      false
    );
  });

  it('uses chat running status without a live indicator', () => {
    expect(isDrawerChatRunning(chat('running', { status: 'running' }), {}, 1000)).toBe(true);
    expect(countDrawerRunningChats([chat('running', { status: 'running' })], {}, 1000)).toBe(1);
  });

  it('prunes expired heartbeat and lifecycle indicators without copying active state', () => {
    const active = {
      heartbeat: { source: 'heartbeat' as const, updatedAt: 1000 },
      lifecycle: { source: 'lifecycle' as const, updatedAt: 1000 },
    };
    expect(pruneStaleDrawerRunIndicators(active, 19_000)).toBe(active);
    expect(pruneStaleDrawerRunIndicators(active, 25_000)).toEqual({
      lifecycle: active.lifecycle,
    });
    expect(pruneStaleDrawerRunIndicators(active, 6 * 60 * 60 * 1000 + 1001)).toEqual({});
  });

  it('reconciles running snapshots using timestamp fallbacks', () => {
    const now = Date.parse('2026-04-01T00:03:00.000Z');
    const reconciled = reconcileDrawerRunIndicatorsWithChats(
      {},
      [
        chat('status-time', { status: 'running', statusUpdatedAt: '2026-04-01T00:01:00.000Z' }),
        chat('updated-time', {
          status: 'running',
          statusUpdatedAt: 'invalid',
          updatedAt: '2026-04-01T00:02:00.000Z',
        }),
        chat('now-time', { status: 'running', statusUpdatedAt: 'invalid', updatedAt: 'invalid' }),
      ],
      now
    );

    expect(reconciled).toEqual({
      'status-time': { source: 'lifecycle', updatedAt: Date.parse('2026-04-01T00:01:00.000Z') },
      'updated-time': { source: 'lifecycle', updatedAt: Date.parse('2026-04-01T00:02:00.000Z') },
      'now-time': { source: 'lifecycle', updatedAt: now },
    });
  });

  it('does not clear indicators from snapshots without a usable timestamp', () => {
    const previous = { thread: { source: 'heartbeat' as const, updatedAt: 1000 } };
    expect(
      reconcileDrawerRunIndicatorsWithChats(
        previous,
        [chat('thread', { statusUpdatedAt: 'invalid', updatedAt: 'invalid' })],
        2000
      )
    ).toBe(previous);
  });

  it('throttles tiny indicator refreshes and preserves newer timestamps', () => {
    const initial = updateDrawerRunIndicatorsForEvent(
      {},
      event('item/started', { threadId: 'thread' }),
      5000
    );
    expect(
      updateDrawerRunIndicatorsForEvent(
        initial,
        event('item/reasoning/textDelta', { threadId: 'thread' }),
        6000
      )
    ).toBe(initial);
    expect(
      updateDrawerRunIndicatorsForEvent(
        initial,
        event('item/reasoning/textDelta', { threadId: 'thread' }),
        1000
      )
    ).toBe(initial);
  });

  it('ignores events without thread ids and unrelated methods', () => {
    const previous = { thread: { source: 'heartbeat' as const, updatedAt: 1000 } };
    expect(updateDrawerRunIndicatorsForEvent(previous, event('turn/started', {}), 2000)).toBe(
      previous
    );
    expect(
      updateDrawerRunIndicatorsForEvent(previous, event('unrelated/event', { threadId: 'thread' }), 2000)
    ).toBe(previous);
  });

  it('handles heartbeat, unknown status, and absent terminal indicators', () => {
    const heartbeat = updateDrawerRunIndicatorsForEvent(
      {},
      event('item/commandExecution/outputDelta', { threadId: 'thread' }),
      1000
    );
    expect(heartbeat).toEqual({ thread: { source: 'heartbeat', updatedAt: 1000 } });
    expect(
      updateDrawerRunIndicatorsForEvent(
        heartbeat,
        event('thread/status/changed', { threadId: 'thread', status: 'mystery' }),
        2000
      )
    ).toBe(heartbeat);
    expect(
      updateDrawerRunIndicatorsForEvent({}, event('turn/completed', { threadId: 'absent' }), 2000)
    ).toEqual({});
  });

  it.each([
    ['codex/event/agent_message_delta', 'heartbeat'],
    ['codex/event/task_failed', 'clear'],
    ['codex/event/unknown_event', 'unchanged'],
  ])('handles Codex event method fallback %s', (method, expected) => {
    const previous = { thread: { source: 'lifecycle' as const, updatedAt: 1000 } };
    const result = updateDrawerRunIndicatorsForEvent(
      previous,
      event(method, { threadId: 'thread' }),
      5000
    );
    if (expected === 'heartbeat') {
      expect(result).toEqual({ thread: { source: 'lifecycle', updatedAt: 5000 } });
    } else if (expected === 'clear') {
      expect(result).toEqual({});
    } else {
      expect(result).toBe(previous);
    }
  });

  it('ignores Codex events whose type normalizes to empty', () => {
    const previous = {};
    expect(
      updateDrawerRunIndicatorsForEvent(
        previous,
        event('codex/event/---', { threadId: 'thread', msg: { type: '---' } }),
        1000
      )
    ).toBe(previous);
  });

  it.each([
    [{ msg: { threadId: 'msg-camel' } }, 'msg-camel'],
    [{ msg: { conversation_id: 'msg-conversation-snake' } }, 'msg-conversation-snake'],
    [{ msg: { conversationId: 'msg-conversation-camel' } }, 'msg-conversation-camel'],
    [{ thread_id: 'param-snake' }, 'param-snake'],
    [{ conversation_id: 'param-conversation-snake' }, 'param-conversation-snake'],
    [{ conversationId: 'param-conversation-camel' }, 'param-conversation-camel'],
    [{ thread: { thread_id: 'thread-snake' } }, 'thread-snake'],
    [{ thread: { conversation_id: 'thread-conversation-snake' } }, 'thread-conversation-snake'],
    [{ thread: { conversationId: 'thread-conversation-camel' } }, 'thread-conversation-camel'],
    [{ turn: { thread_id: 'turn-snake' } }, 'turn-snake'],
    [{ turn: { threadId: 'turn-camel' } }, 'turn-camel'],
    [{ source: { thread_id: 'source-snake' } }, 'source-snake'],
    [{ source: { threadId: 'source-camel' } }, 'source-camel'],
    [{ source: { conversation_id: 'source-conversation-snake' } }, 'source-conversation-snake'],
    [{ source: { conversationId: 'source-conversation-camel' } }, 'source-conversation-camel'],
    [{ source: { parent_thread_id: 'source-parent-snake' } }, 'source-parent-snake'],
    [{ source: { parentThreadId: 'source-parent-camel' } }, 'source-parent-camel'],
    [{ source: { subagent: { thread_spawn: { parent_thread_id: 'spawn-snake' } } } }, 'spawn-snake'],
    [{ source: { subAgent: { thread_spawn: { parentThreadId: 'spawn-camel' } } } }, 'spawn-camel'],
    [{ thread: { source: { parent_thread_id: 'thread-source-snake' } } }, 'thread-source-snake'],
    [{ thread: { source: { parentThreadId: 'thread-source-camel' } } }, 'thread-source-camel'],
    [{ thread: { source: { subagent: { thread_spawn: { parent_thread_id: 'thread-spawn-snake' } } } } }, 'thread-spawn-snake'],
    [{ thread: { source: { subAgent: { thread_spawn: { parentThreadId: 'thread-spawn-camel' } } } } }, 'thread-spawn-camel'],
  ])('extracts a thread id from supported shape %#', (params, expected) => {
    expect(extractDrawerNotificationThreadId(params)).toBe(expected);
  });

  it('supports an explicit message argument and rejects empty ids', () => {
    expect(extractDrawerNotificationThreadId(null, { thread_id: ' from-msg ' })).toBe('from-msg');
    expect(extractDrawerNotificationThreadId(null, null)).toBeNull();
    expect(extractDrawerNotificationThreadId({ threadId: '   ' })).toBeNull();
  });

  it.each([
    [{ status: 'RUNNING' }, 'running'],
    [{ msg: { status: 'in_progress' } }, 'inprogress'],
    [{ status: { status: 'completed' } }, 'completed'],
    [{ thread: { status: 'not_loaded' } }, 'notloaded'],
    [{ thread_state: { status: { type: 'queued' } } }, 'queued'],
    [{ msg: { thread: { status: { type: 'idle' } } } }, 'idle'],
  ])('extracts status from supported shape %#', (params, expected) => {
    expect(extractDrawerStatusHint(params)).toBe(expected);
  });

  it('rejects absent and empty status hints', () => {
    expect(extractDrawerStatusHint(null)).toBeNull();
    expect(extractDrawerStatusHint({ status: '---' })).toBeNull();
  });
});
