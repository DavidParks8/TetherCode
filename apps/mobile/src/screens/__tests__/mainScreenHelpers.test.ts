import {
  buildOptimisticGoalBridgeUiSurface,
  formatGitCloneFailureMessage,
  findSlashCommandDefinition,
  isSlashCommandAvailable,
  parseChatBridgeUiSurfaces,
  parseGoalSlashObjective,
  shouldSurfaceChatLoadError,
  toBridgeUiSurface,
  toApprovalPolicyForMode,
} from '../mainScreenHelpers';

describe('mainScreenHelpers', () => {
  const availability = {
    hasOpenChat: true,
    supportsGoal: false,
    supportsPlanMode: true,
    supportsReview: false,
  };

  it('exposes only executable slash commands for the active agent and chat state', () => {
    const compact = findSlashCommandDefinition('compact');
    const goal = findSlashCommandDefinition('goal');
    const permissions = findSlashCommandDefinition('permissions');
    expect(compact).toBeNull();
    expect(goal && isSlashCommandAvailable(goal, availability)).toBe(false);
    expect(permissions && isSlashCommandAvailable(permissions, availability)).toBe(false);
  });

  it('keeps transient revalidation failures behind a hydrated chat snapshot', () => {
    expect(shouldSurfaceChatLoadError(true, 'thread-1', 'thread-1', 3)).toBe(false);
    expect(shouldSurfaceChatLoadError(false, 'thread-1', 'thread-1', 3)).toBe(true);
    expect(shouldSurfaceChatLoadError(true, 'thread-2', 'thread-1', 3)).toBe(true);
    expect(shouldSurfaceChatLoadError(true, 'thread-1', 'thread-1', 0)).toBe(true);
  });

  it('maps only explicit YOLO mode to never approvals', () => {
    expect(toApprovalPolicyForMode(undefined)).toBe('untrusted');
    expect(toApprovalPolicyForMode(null)).toBe('untrusted');
    expect(toApprovalPolicyForMode('normal')).toBe('untrusted');
    expect(toApprovalPolicyForMode('yolo')).toBe('never');
  });

  it('keeps successful git clone responses quiet', () => {
    expect(
      formatGitCloneFailureMessage({
        code: 0,
        stdout: '',
        stderr: '',
        cloned: true,
      })
    ).toBeNull();
  });

  it('surfaces git stderr when clone exits unsuccessfully', () => {
    expect(
      formatGitCloneFailureMessage({
        code: 128,
        stdout: '',
        stderr: 'fatal: repository not found',
        cloned: false,
      })
    ).toBe('fatal: repository not found');
  });

  it('falls back to a readable clone failure when git gives no output', () => {
    expect(
      formatGitCloneFailureMessage(
        {
          code: 1,
          stdout: '',
          stderr: '',
          cloned: false,
        },
        'DavidParks8/launchkit'
      )
    ).toBe('Git clone failed for DavidParks8/launchkit.');
  });

  it('parses bridge UI surfaces for provider-owned workflow cards', () => {
    expect(
      toBridgeUiSurface({
        id: 'goal-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        kind: 'goal',
        presentation: 'workflowCard',
        tone: 'info',
        title: 'Goal',
        subtitle: 'Active',
        bodyMarkdown: 'Ship the generic surface.',
        blocks: [
          {
            type: 'keyValue',
            items: [{ label: 'Status', value: 'active' }],
          },
          {
            type: 'progress',
            label: 'Budget used',
            value: 5,
            max: 10,
          },
        ],
        actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
      })
    ).toMatchObject({
      id: 'goal-1',
      threadId: 'thread-1',
      kind: 'goal',
      presentation: 'workflowCard',
      title: 'Goal',
      blocks: [
        {
          type: 'keyValue',
          items: [{ label: 'Status', value: 'active' }],
        },
        {
          type: 'progress',
          label: 'Budget used',
          value: 5,
          max: 10,
        },
      ],
      actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
    });
  });

  it('hydrates persisted bridge UI surfaces by thread', () => {
    const result = parseChatBridgeUiSurfaces(
      JSON.stringify({
        version: 1,
        entries: {
          'thread-1': [
            {
              id: 'goal-1',
              threadId: 'thread-1',
              presentation: 'workflowCard',
              title: 'Goal',
              subtitle: 'Active',
              blocks: [
                {
                  type: 'keyValue',
                  items: [{ label: 'Status', value: 'Active' }],
                },
              ],
              actions: [{ id: 'dismiss', label: 'Dismiss' }],
            },
          ],
          'thread-2': [
            {
              id: 'wrong-thread',
              threadId: 'thread-1',
              presentation: 'workflowCard',
              title: 'Goal',
            },
          ],
        },
      })
    );

    expect(result).toMatchObject({
      'thread-1': [
        {
          id: 'goal-1',
          threadId: 'thread-1',
          presentation: 'workflowCard',
          title: 'Goal',
        },
      ],
    });
    expect(result['thread-2']).toBeUndefined();
  });

  it('builds an optimistic replacement surface for new goal slash commands', () => {
    expect(parseGoalSlashObjective('/goal Now verify the PR')).toBe('Now verify the PR');
    expect(parseGoalSlashObjective('/goal')).toBeNull();
    expect(parseGoalSlashObjective('/model gpt-5.5')).toBeNull();

    expect(
      buildOptimisticGoalBridgeUiSurface(
        'agent-alpha:thread-1',
        'Now verify the PR',
        '2026-05-17T03:00:00.000Z'
      )
    ).toMatchObject({
      id: 'goal-agent-alpha:thread-1',
      threadId: 'agent-alpha:thread-1',
      kind: 'goal',
      presentation: 'workflowCard',
      subtitle: 'Starting',
      bodyMarkdown: 'Now verify the PR',
      blocks: [
        {
          type: 'keyValue',
          items: [{ label: 'Status', value: 'Starting' }],
        },
      ],
    });
  });
});
