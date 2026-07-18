import type { ChatSummary } from '../../api/types';
import {
  buildAgentThreadDisplayState,
  getAgentThreadAccentColor,
} from '../agentThreadDisplay';

function chat(
  id: string,
  partial: Partial<ChatSummary> = {}
): ChatSummary {
  return {
    id,
    title: partial.title ?? id,
    status: partial.status ?? 'idle',
    createdAt: partial.createdAt ?? '2026-03-20T00:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-03-20T00:00:00.000Z',
    statusUpdatedAt: partial.statusUpdatedAt ?? '2026-03-20T00:00:00.000Z',
    lastMessagePreview: partial.lastMessagePreview ?? '',
    cwd: partial.cwd,
    modelProvider: partial.modelProvider,
    sourceKind: partial.sourceKind,
    parentThreadId: partial.parentThreadId,
    subAgentDepth: partial.subAgentDepth,
    lastError: partial.lastError,
  };
}

describe('agentThreadDisplay', () => {
  it('uses live runtime activity for running child threads', () => {
    const display = buildAgentThreadDisplayState(
      chat('thr_worker', { status: 'idle' }),
      {
        activity: {
          tone: 'running',
          title: 'Reasoning',
          detail: 'Inspecting files',
        },
        runWatchdogUntil: Date.parse('2026-03-20T10:00:30.000Z'),
      },
      Date.parse('2026-03-20T10:00:00.000Z')
    );

    expect(display.label).toBe('Reasoning');
    expect(display.detail).toBe('Inspecting files');
    expect(display.tone).toBe('running');
  });

  it('shows pending approvals as active waiting state', () => {
    const display = buildAgentThreadDisplayState(chat('thr_worker'), {
      pendingApproval: { id: 'appr-1' },
      activity: {
        tone: 'running',
        title: 'Working',
      },
    });

    expect(display.label).toBe('Needs approval');
    expect(display.tone).toBe('running');
  });

  it('falls back to error details from the chat summary', () => {
    const display = buildAgentThreadDisplayState(
      chat('thr_worker', {
        status: 'error',
        lastError: 'Command exited 1',
      }),
      null
    );

    expect(display.label).toBe('Error');
    expect(display.detail).toBe('Command exited 1');
    expect(display.tone).toBe('error');
  });

  it('assigns stable accent colors per thread id', () => {
    expect(getAgentThreadAccentColor('thr_worker')).toBe(
      getAgentThreadAccentColor('thr_worker')
    );
  });

  it('prioritizes errors and keeps useful runtime details', () => {
    expect(
      buildAgentThreadDisplayState(chat('error', { status: 'error', lastError: 'fallback' }), {
        activity: { tone: 'error', title: 'Custom failure', detail: ' precise failure ' },
      })
    ).toMatchObject({ label: 'Error', detail: 'precise failure', isActive: false });
    expect(
      buildAgentThreadDisplayState(chat('error', { status: 'error', lastError: 'fallback' }), {
        activity: { tone: 'error', title: 'Custom failure' },
      }).detail
    ).toBe('Custom failure');
    expect(
      buildAgentThreadDisplayState(chat('error', { status: 'error' }), {
        activity: { tone: 'error', title: 'Turn failed' },
      }).detail
    ).toBeNull();
  });

  it('shows input requests and approval context as waiting states', () => {
    expect(
      buildAgentThreadDisplayState(chat('input'), {
        pendingUserInputRequest: {},
        activity: { tone: 'running', title: 'Choose a target' },
      })
    ).toMatchObject({ label: 'Needs input', detail: 'Choose a target', isActive: true });
    expect(
      buildAgentThreadDisplayState(chat('approval'), {
        pendingApproval: {},
        activity: { tone: 'running', title: 'Planning', detail: 'Approve changes' },
      }).detail
    ).toBe('Approve changes');
  });

  it.each([
    ['Planning', 'map-outline'],
    ['Reasoning', 'sparkles-outline'],
    ['Working', 'sync-outline'],
    ['Turn started', 'sync-outline'],
    ['Ready', 'sync-outline'],
    ['Custom task', 'sync-outline'],
  ])('normalizes running activity %s', (title, icon) => {
    expect(
      buildAgentThreadDisplayState(chat(`running-${title}`), {
        activity: { tone: 'running', title },
      })
    ).toMatchObject({
      label: title === 'Turn started' || title === 'Ready' ? 'Working' : title,
      icon,
      detail: null,
      isActive: true,
    });
  });

  it('recognizes every runtime signal and ignores expired watchdogs', () => {
    expect(buildAgentThreadDisplayState(chat('status', { status: 'running' }), null).isActive).toBe(true);
    expect(buildAgentThreadDisplayState(chat('turn'), { activeTurnId: 'turn' }).isActive).toBe(true);
    expect(buildAgentThreadDisplayState(chat('commands'), { activeCommands: [{}] }).isActive).toBe(true);
    expect(buildAgentThreadDisplayState(chat('watchdog'), { runWatchdogUntil: 11 }, 10).isActive).toBe(true);
    expect(buildAgentThreadDisplayState(chat('expired'), { runWatchdogUntil: 10 }, 10).label).toBe('Idle');
  });

  it('formats complete and idle states without generic activity details', () => {
    expect(
      buildAgentThreadDisplayState(chat('complete', { status: 'complete' }), {
        activity: { tone: 'complete', title: 'Published', detail: 'All done' },
      })
    ).toMatchObject({ label: 'Complete', detail: 'All done', isActive: false });
    expect(
      buildAgentThreadDisplayState(chat('complete', { status: 'complete' }), {
        activity: { tone: 'complete', title: 'Turn completed' },
      }).detail
    ).toBeNull();
    expect(buildAgentThreadDisplayState(chat('idle'), undefined)).toMatchObject({
      label: 'Idle', detail: null, tone: 'idle', isActive: false,
    });
  });
});
