import type {
  AgentDescriptor,
  ChatSummary,
  PendingApproval,
  PendingUserInputRequest,
} from '../api/types';
import type { WorkspaceChatLimit } from '../appSettings';
import { getAgentLabel } from '../agents';
import { buildChatWorkspaceSections } from './chatThreadTree';
import {
  isDrawerChatRunning,
  type DrawerRunIndicatorMap,
} from './drawerRuntimeIndicators';

export type DrawerAttentionLane = 'attention' | 'working' | 'recent';
export type DrawerAttentionReason = 'approval' | 'input' | 'error' | null;

export interface DrawerFolderOption {
  key: string | null;
  label: string;
  subtitle?: string;
  itemCount: number;
}

export interface DrawerAttentionRow {
  chat: ChatSummary;
  lane: DrawerAttentionLane;
  attentionReason: DrawerAttentionReason;
  stateLabel: string;
  agentLabel: string;
  workspaceKey: string;
  workspaceLabel: string;
  indentLevel: number;
}

export interface DrawerAttentionSection {
  key: DrawerAttentionLane;
  title: string;
  itemCount: number;
  data: DrawerAttentionRow[];
}

export interface DrawerAttentionModel {
  sections: DrawerAttentionSection[];
  folderOptions: DrawerFolderOption[];
  selectedFolderLabel: string;
  attentionCount: number;
  workingCount: number;
  recentCount: number;
  visibleChatCount: number;
}

interface PendingInteractionSummary {
  approvalCount: number;
  inputCount: number;
  latestRequestedAt: string;
}

interface BuildDrawerAttentionModelOptions {
  chats: ChatSummary[];
  agents: AgentDescriptor[];
  runIndicatorsByThread: DrawerRunIndicatorMap;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInputRequest[];
  selectedFolderKey: string | null;
  workspaceChatLimit: WorkspaceChatLimit;
}

const LANE_TITLES: Record<DrawerAttentionLane, string> = {
  attention: 'Needs your attention',
  working: 'Working now',
  recent: 'Recent',
};

export function buildDrawerAttentionModel({
  chats,
  agents,
  runIndicatorsByThread,
  pendingApprovals,
  pendingUserInputs,
  selectedFolderKey,
  workspaceChatLimit,
}: BuildDrawerAttentionModelOptions): DrawerAttentionModel {
  const workspaceSections = buildChatWorkspaceSections(chats);
  const workspaceByChatId = new Map<
    string,
    { key: string; label: string; indentLevel: number }
  >();
  for (const section of workspaceSections) {
    for (const row of section.data) {
      workspaceByChatId.set(row.chat.id, {
        key: section.key,
        label: section.title,
        indentLevel: row.indentLevel,
      });
    }
  }

  const folderOptions: DrawerFolderOption[] = [
    {
      key: null,
      label: 'All folders',
      itemCount: chats.length,
    },
    ...workspaceSections.map((section) => ({
      key: section.key,
      label: section.title,
      subtitle: section.subtitle,
      itemCount: section.itemCount,
    })),
  ];
  const selectedFolder = folderOptions.find((option) => option.key === selectedFolderKey);
  const folderPickerLabels = getDrawerFolderPickerLabels(folderOptions);
  const selectedFolderIndex = selectedFolder
    ? folderOptions.indexOf(selectedFolder)
    : 0;
  const resolvedFolderKey = selectedFolder?.key ?? null;
  const pendingByThread = buildPendingInteractionMap(pendingApprovals, pendingUserInputs);
  const visibleChatIds = buildVisibleChatIdSet(
    workspaceSections,
    resolvedFolderKey,
    workspaceChatLimit,
    pendingByThread,
    runIndicatorsByThread
  );

  const rowsByLane: Record<DrawerAttentionLane, DrawerAttentionRow[]> = {
    attention: [],
    working: [],
    recent: [],
  };
  for (const chat of chats) {
    if (!visibleChatIds.has(chat.id)) {
      continue;
    }
    const workspace = workspaceByChatId.get(chat.id);
    if (!workspace) {
      continue;
    }
    const pending = pendingByThread.get(chat.id);
    const running = isDrawerChatRunning(chat, runIndicatorsByThread);
    const lane: DrawerAttentionLane =
      pending
        ? 'attention'
        : running
          ? 'working'
          : chat.status === 'error'
            ? 'attention'
            : 'recent';
    rowsByLane[lane].push({
      chat,
      lane,
      attentionReason: pending
        ? pending.approvalCount > 0
          ? 'approval'
          : 'input'
        : !running && chat.status === 'error'
          ? 'error'
          : null,
      stateLabel: getStateLabel(chat, pending, running),
      agentLabel: getAgentLabel(agents, chat.agentId),
      workspaceKey: workspace.key,
      workspaceLabel: workspace.label,
      indentLevel: workspace.indentLevel,
    });
  }

  for (const rows of Object.values(rowsByLane)) {
    rows.sort((left, right) => {
      const leftPendingAt = pendingByThread.get(left.chat.id)?.latestRequestedAt;
      const rightPendingAt = pendingByThread.get(right.chat.id)?.latestRequestedAt;
      return (rightPendingAt ?? right.chat.updatedAt).localeCompare(
        leftPendingAt ?? left.chat.updatedAt
      );
    });
  }

  const sections = (Object.keys(rowsByLane) as DrawerAttentionLane[])
    .filter((lane) => rowsByLane[lane].length > 0)
    .map((lane) => ({
      key: lane,
      title: LANE_TITLES[lane],
      itemCount: rowsByLane[lane].length,
      data: rowsByLane[lane],
    }));

  return {
    sections,
    folderOptions,
    selectedFolderLabel: folderPickerLabels[selectedFolderIndex] ?? 'All folders',
    attentionCount: rowsByLane.attention.length,
    workingCount: rowsByLane.working.length,
    recentCount: rowsByLane.recent.length,
    visibleChatCount:
      rowsByLane.attention.length + rowsByLane.working.length + rowsByLane.recent.length,
  };
}

export function getDrawerFolderPickerLabels(
  options: DrawerFolderOption[]
): string[] {
  const labelCounts = new Map<string, number>();
  for (const option of options) {
    if (option.key) {
      labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
    }
  }
  const labels = options.map((option) => {
    if (!option.key || (labelCounts.get(option.label) ?? 0) <= 1) {
      return option.label;
    }
    return `${option.label} — ${option.subtitle ?? option.key}`;
  });
  const generatedLabelCounts = new Map<string, number>();
  for (const label of labels) {
    generatedLabelCounts.set(label, (generatedLabelCounts.get(label) ?? 0) + 1);
  }
  return labels.map((label, index) => {
    const option = options[index];
    return option?.key && (generatedLabelCounts.get(label) ?? 0) > 1
      ? `${option.label} — ${option.key}`
      : label;
  });
}

function buildPendingInteractionMap(
  approvals: PendingApproval[],
  userInputs: PendingUserInputRequest[]
): Map<string, PendingInteractionSummary> {
  const pendingByThread = new Map<string, PendingInteractionSummary>();
  for (const approval of approvals) {
    const existing = pendingByThread.get(approval.threadId);
    pendingByThread.set(approval.threadId, {
      approvalCount: (existing?.approvalCount ?? 0) + 1,
      inputCount: existing?.inputCount ?? 0,
      latestRequestedAt: latestTimestamp(existing?.latestRequestedAt, approval.requestedAt),
    });
  }
  for (const input of userInputs) {
    const existing = pendingByThread.get(input.threadId);
    pendingByThread.set(input.threadId, {
      approvalCount: existing?.approvalCount ?? 0,
      inputCount: (existing?.inputCount ?? 0) + 1,
      latestRequestedAt: latestTimestamp(existing?.latestRequestedAt, input.requestedAt),
    });
  }
  return pendingByThread;
}

function buildVisibleChatIdSet(
  workspaceSections: ReturnType<typeof buildChatWorkspaceSections>,
  selectedFolderKey: string | null,
  workspaceChatLimit: WorkspaceChatLimit,
  pendingByThread: Map<string, PendingInteractionSummary>,
  runIndicatorsByThread: DrawerRunIndicatorMap
): Set<string> {
  const visible = new Set<string>();
  for (const section of workspaceSections) {
    if (selectedFolderKey && section.key !== selectedFolderKey) {
      continue;
    }
    const rows =
      selectedFolderKey || workspaceChatLimit === null
        ? section.data
        : section.data.slice(0, workspaceChatLimit);
    for (const row of rows) {
      visible.add(row.chat.id);
    }
    for (const row of section.data) {
      if (
        pendingByThread.has(row.chat.id) ||
        row.chat.status === 'error' ||
        isDrawerChatRunning(row.chat, runIndicatorsByThread)
      ) {
        visible.add(row.chat.id);
      }
    }
  }
  return visible;
}

function getStateLabel(
  chat: ChatSummary,
  pending: PendingInteractionSummary | undefined,
  running: boolean
): string {
  if (pending) {
    const requestCount = pending.approvalCount + pending.inputCount;
    if (requestCount > 1) {
      return `${requestCount} requests`;
    }
    return pending.approvalCount > 0 ? 'Approval requested' : 'Input requested';
  }
  if (running) {
    return 'Working';
  }
  if (chat.status === 'error') {
    return 'Failed';
  }
  return chat.status === 'complete' ? 'Complete' : 'Idle';
}

function latestTimestamp(left: string | undefined, right: string): string {
  return left && left.localeCompare(right) > 0 ? left : right;
}
