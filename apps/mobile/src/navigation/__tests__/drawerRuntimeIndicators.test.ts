import type { ChatSummary, RpcNotification } from '../../api/types';
import {
  countDrawerRunningChats,
  extractDrawerNotificationThreadId,
  extractDrawerStatusHint,
  isDrawerChatRunning,
  isDrawerWorkspaceSectionRunning,
  reconcileDrawerRunIndicatorsWithChats,
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
});
