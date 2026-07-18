import type { ChatSummary } from '../../api/types';
import { buildChatWorkspaceSections } from '../chatThreadTree';

function chat(partial: Partial<ChatSummary> & Pick<ChatSummary, 'id' | 'updatedAt'>): ChatSummary {
  return {
    id: partial.id,
    title: partial.title ?? partial.id,
    status: partial.status ?? 'idle',
    createdAt: partial.createdAt ?? '2026-03-19T00:00:00.000Z',
    updatedAt: partial.updatedAt,
    statusUpdatedAt: partial.statusUpdatedAt ?? partial.updatedAt,
    lastMessagePreview: partial.lastMessagePreview ?? '',
    cwd: partial.cwd,
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

describe('buildChatWorkspaceSections', () => {
  it('returns no sections for an empty chat list', () => {
    expect(buildChatWorkspaceSections([])).toEqual([]);
  });

  it('nests sub-agent rows below their root thread', () => {
    const sections = buildChatWorkspaceSections([
      chat({
        id: 'root',
        title: 'Review repo',
        cwd: '/workspace/repo',
        updatedAt: '2026-03-20T10:00:00.000Z',
      }),
      chat({
        id: 'agent-a',
        title: 'Review app',
        cwd: '/workspace/repo/sub',
        updatedAt: '2026-03-20T09:59:00.000Z',
        parentThreadId: 'root',
        sourceKind: 'subAgentThreadSpawn',
        subAgentDepth: 1,
      }),
      chat({
        id: 'agent-b',
        title: 'Review bridge',
        cwd: '/workspace/repo',
        updatedAt: '2026-03-20T09:58:00.000Z',
        parentThreadId: 'root',
        sourceKind: 'subAgentReview',
        subAgentDepth: 1,
      }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBe('repo');
    expect(sections[0].itemCount).toBe(3);
    expect(sections[0].data.map((row) => [row.chat.id, row.indentLevel])).toEqual([
      ['root', 0],
      ['agent-a', 1],
      ['agent-b', 1],
    ]);
  });

  it('groups sub-agent rows under the root workspace', () => {
    const sections = buildChatWorkspaceSections([
      chat({
        id: 'root',
        title: 'Root',
        cwd: '/workspace/one',
        updatedAt: '2026-03-20T10:00:00.000Z',
      }),
      chat({
        id: 'child',
        title: 'Child',
        cwd: '/workspace/two',
        updatedAt: '2026-03-20T09:59:00.000Z',
        parentThreadId: 'root',
        sourceKind: 'subAgentThreadSpawn',
        subAgentDepth: 1,
      }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('/workspace/one');
    expect(sections[0].data.map((row) => row.chat.id)).toEqual(['root', 'child']);
  });

  it('treats blank, missing, self, and unknown parents as roots', () => {
    const sections = buildChatWorkspaceSections([
      chat({ id: 'blank', cwd: '   ', updatedAt: '2026-03-20T10:04:00.000Z', parentThreadId: '  ' }),
      chat({ id: 'missing', updatedAt: '2026-03-20T10:03:00.000Z' }),
      chat({ id: 'self', updatedAt: '2026-03-20T10:02:00.000Z', parentThreadId: 'self' }),
      chat({ id: 'unknown', updatedAt: '2026-03-20T10:01:00.000Z', parentThreadId: 'gone' }),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      key: '__bridge_default_workspace__',
      title: 'Bridge default workspace',
      subtitle: undefined,
      itemCount: 4,
    });
    expect(sections[0].data.map((row) => row.chat.id)).toEqual([
      'blank',
      'missing',
      'self',
      'unknown',
    ]);
  });

  it('sorts workspaces and roots by their latest update', () => {
    const sections = buildChatWorkspaceSections([
      chat({ id: 'old-a', cwd: '/work/a', updatedAt: '2026-03-20T09:00:00.000Z' }),
      chat({ id: 'new-a', cwd: '/work/a', updatedAt: '2026-03-20T12:00:00.000Z' }),
      chat({ id: 'only-b', cwd: '/work/b', updatedAt: '2026-03-20T11:00:00.000Z' }),
    ]);

    expect(sections.map((entry) => entry.key)).toEqual(['/work/a', '/work/b']);
    expect(sections[0].data.map((row) => row.chat.id)).toEqual(['new-a', 'old-a']);
  });

  it('orders branch children by running state, depth, update time, then title', () => {
    const sections = buildChatWorkspaceSections([
      chat({ id: 'root', cwd: '/work/repo', updatedAt: '2026-03-20T12:00:00.000Z' }),
      chat({ id: 'running', parentThreadId: 'root', status: 'running', updatedAt: '2026-03-20T10:00:00.000Z' }),
      chat({ id: 'idle-deep', parentThreadId: 'root', subAgentDepth: 2, updatedAt: '2026-03-20T11:59:00.000Z' }),
      chat({ id: 'idle-new', parentThreadId: 'root', subAgentDepth: 1, updatedAt: '2026-03-20T11:58:00.000Z', title: 'Zulu' }),
      chat({ id: 'idle-a', parentThreadId: 'root', subAgentDepth: 1, updatedAt: '2026-03-20T11:57:00.000Z', title: 'Alpha' }),
      chat({ id: 'idle-b', parentThreadId: 'root', subAgentDepth: 1, updatedAt: '2026-03-20T11:57:00.000Z', title: 'Beta' }),
      chat({ id: 'no-depth-b', parentThreadId: 'root', updatedAt: '2026-03-20T11:56:00.000Z', title: 'No depth B' }),
      chat({ id: 'no-depth-a', parentThreadId: 'root', updatedAt: '2026-03-20T11:56:00.000Z', title: 'No depth A' }),
      chat({ id: 'grandchild', parentThreadId: 'idle-new', updatedAt: '2026-03-20T09:00:00.000Z' }),
    ]);

    expect(sections[0].data.map((row) => [row.chat.id, row.indentLevel, row.rootThreadId])).toEqual([
      ['root', 0, 'root'],
      ['running', 1, 'root'],
      ['no-depth-a', 1, 'root'],
      ['no-depth-b', 1, 'root'],
      ['idle-new', 1, 'root'],
      ['grandchild', 2, 'root'],
      ['idle-a', 1, 'root'],
      ['idle-b', 1, 'root'],
      ['idle-deep', 1, 'root'],
    ]);
  });

  it.each([
    ['/Users/me/projects/repo/', 'repo', '.../projects/repo'],
    ['C:\\Users\\me\\repo\\', 'repo', '.../me/repo'],
    ['relative', 'relative', 'relative'],
    ['/', '/', ''],
  ])('formats workspace %s as %s', (cwd, title, subtitle) => {
    expect(
      buildChatWorkspaceSections([
        chat({ id: 'root', cwd, updatedAt: '2026-03-20T10:00:00.000Z' }),
      ])[0]
    ).toMatchObject({ title, subtitle });
  });
});
