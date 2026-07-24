import type {
  AgentDescriptor,
  ChatSummary,
  PendingApproval,
  PendingUserInputRequest,
} from '../api/types';
import {
  buildDrawerAttentionModel,
  getDrawerFolderPickerLabels,
} from './drawerAttention';

const agents: AgentDescriptor[] = [
  {
    agentId: 'copilot',
    displayName: 'GitHub Copilot',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  },
  {
    agentId: 'codex',
    displayName: 'Codex',
    version: '1',
    provenance: 'test',
    lifecycle: 'ready',
  },
];

function chat(
  id: string,
  overrides: Partial<ChatSummary> = {}
): ChatSummary {
  return {
    id,
    title: `Chat ${id}`,
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:20:00.000Z',
    statusUpdatedAt: '2026-07-20T00:20:00.000Z',
    lastMessagePreview: '',
    cwd: '/repo/mobile',
    agentId: 'copilot',
    ...overrides,
  };
}

function approval(
  threadId: string,
  requestedAt = '2026-07-20T00:25:00.000Z'
): PendingApproval {
  return {
    requestId: `approval-${threadId}`,
    agentId: 'codex',
    kind: 'command',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    title: 'Approval requested',
    message: 'Approve this command.',
    requestedAt,
    options: [{ id: 'accept', label: 'Accept' }],
  };
}

function userInput(
  threadId: string,
  requestedAt = '2026-07-20T00:26:00.000Z'
): PendingUserInputRequest {
  return {
    requestId: `input-${threadId}`,
    agentId: 'copilot',
    threadId,
    turnId: `turn-${threadId}`,
    itemId: `item-${threadId}`,
    message: 'Input requested.',
    requestedAt,
    questions: [],
  };
}

describe('buildDrawerAttentionModel', () => {
  it('groups authoritative requests, failures, running sessions, and recent work', () => {
    const model = buildDrawerAttentionModel({
      chats: [
        chat('approval', { agentId: 'codex' }),
        chat('input'),
        chat('failed', { status: 'error' }),
        chat('working', { status: 'running' }),
        chat('recent'),
      ],
      agents,
      runIndicatorsByThread: {},
      pendingApprovals: [approval('approval')],
      pendingUserInputs: [userInput('input')],
      selectedFolderKey: null,
      workspaceChatLimit: null,
    });

    expect(model.sections.map((section) => section.key)).toEqual([
      'attention',
      'working',
      'recent',
    ]);
    expect(model.attentionCount).toBe(3);
    expect(model.workingCount).toBe(1);
    expect(model.recentCount).toBe(1);
    expect(model.sections[0]?.data.map((row) => row.chat.id)).toEqual([
      'input',
      'approval',
      'failed',
    ]);
    expect(model.sections[0]?.data[0]).toEqual(
      expect.objectContaining({
        attentionReason: 'input',
        stateLabel: 'Input requested',
        agentLabel: 'GitHub Copilot',
        workspaceLabel: 'mobile',
      })
    );
    expect(model.sections[1]?.data[0]?.stateLabel).toBe('Working');
    expect(model.sections[2]?.data[0]?.stateLabel).toBe('Complete');
  });

  it('combines multiple pending requests without implying completion progress', () => {
    const model = buildDrawerAttentionModel({
      chats: [chat('multi', { status: 'running' })],
      agents,
      runIndicatorsByThread: {},
      pendingApprovals: [
        approval('multi', '2026-07-20T00:24:00.000Z'),
        approval('multi', '2026-07-20T00:25:00.000Z'),
      ],
      pendingUserInputs: [userInput('multi')],
      selectedFolderKey: null,
      workspaceChatLimit: null,
    });

    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.key).toBe('attention');
    expect(model.sections[0]?.data[0]?.stateLabel).toBe('3 requests');
  });

  it('prefers a newer realtime run indicator over a stale error snapshot', () => {
    const model = buildDrawerAttentionModel({
      chats: [chat('retry', { status: 'error' })],
      agents,
      runIndicatorsByThread: {
        retry: {
          source: 'lifecycle',
          updatedAt: Date.now(),
        },
      },
      pendingApprovals: [],
      pendingUserInputs: [],
      selectedFolderKey: null,
      workspaceChatLimit: null,
    });

    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.key).toBe('working');
    expect(model.sections[0]?.data[0]).toEqual(
      expect.objectContaining({
        attentionReason: null,
        stateLabel: 'Working',
      })
    );
  });

  it('keeps a pending sub-agent request visible under its parent folder', () => {
    const model = buildDrawerAttentionModel({
      chats: [
        chat('root'),
        chat('child', {
          cwd: undefined,
          parentThreadId: 'root',
          subAgentDepth: 1,
          agentId: 'codex',
        }),
      ],
      agents,
      runIndicatorsByThread: {},
      pendingApprovals: [],
      pendingUserInputs: [userInput('child')],
      selectedFolderKey: null,
      workspaceChatLimit: null,
    });

    const child = model.sections
      .flatMap((section) => section.data)
      .find((row) => row.chat.id === 'child');
    expect(child).toEqual(
      expect.objectContaining({
        lane: 'attention',
        stateLabel: 'Input requested',
        workspaceLabel: 'mobile',
        indentLevel: 1,
      })
    );
  });

  it('disambiguates duplicate folder basenames for native pickers and selection', () => {
    const model = buildDrawerAttentionModel({
      chats: [
        chat('first', { cwd: '/Users/a/src/mobile', updatedAt: '2026-07-20T00:29:00.000Z' }),
        chat('second', { cwd: '/Users/b/src/mobile', updatedAt: '2026-07-20T00:28:00.000Z' }),
      ],
      agents,
      runIndicatorsByThread: {},
      pendingApprovals: [],
      pendingUserInputs: [],
      selectedFolderKey: '/Users/a/src/mobile',
      workspaceChatLimit: null,
    });

    expect(getDrawerFolderPickerLabels(model.folderOptions)).toEqual([
      'All folders',
      'mobile — /Users/a/src/mobile',
      'mobile — /Users/b/src/mobile',
    ]);
    expect(model.selectedFolderLabel).toBe('mobile — /Users/a/src/mobile');
  });

  it('filters by folder and reveals the full selected folder history', () => {
    const mobileChats = Array.from({ length: 8 }, (_, index) =>
      chat(`mobile-${index}`, {
        cwd: '/repo/mobile',
        status: index === 5 ? 'running' : index === 6 ? 'error' : 'complete',
        updatedAt: `2026-07-20T00:${String(29 - index).padStart(2, '0')}:00.000Z`,
      })
    );
    const bridgeChat = chat('bridge', {
      cwd: '/repo/rust-bridge',
      agentId: 'codex',
    });

    const allFolders = buildDrawerAttentionModel({
      chats: [...mobileChats, bridgeChat],
      agents,
      runIndicatorsByThread: {},
      pendingApprovals: [],
      pendingUserInputs: [],
      selectedFolderKey: null,
      workspaceChatLimit: 5,
    });
    expect(allFolders.visibleChatCount).toBe(8);
    expect(allFolders.folderOptions.map((option) => option.label)).toEqual([
      'All folders',
      'mobile',
      'rust-bridge',
    ]);

    const mobileFolder = buildDrawerAttentionModel({
      chats: [...mobileChats, bridgeChat],
      agents,
      runIndicatorsByThread: {},
      pendingApprovals: [],
      pendingUserInputs: [],
      selectedFolderKey: '/repo/mobile',
      workspaceChatLimit: 5,
    });
    expect(mobileFolder.selectedFolderLabel).toBe('mobile');
    expect(mobileFolder.visibleChatCount).toBe(8);
    expect(
      mobileFolder.sections.flatMap((section) => section.data).every(
        (row) => row.workspaceKey === '/repo/mobile'
      )
    ).toBe(true);
  });
});
