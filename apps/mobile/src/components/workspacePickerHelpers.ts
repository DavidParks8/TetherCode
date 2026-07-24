import type { WorkspaceSummary } from '../api/types';

export const ENTRY_ROW_HEIGHT = 54;
export const WORKSPACE_PICKER_MAX_WIDTH = 640;
export const WORKSPACE_PICKER_MAX_HEIGHT = 820;

interface WorkspacePickerViewport {
  width: number;
  height: number;
  topInset: number;
  bottomInset: number;
}

export interface WorkspacePickerPresentation {
  isLargeScreen: boolean;
  horizontalPadding: number;
  topPadding: number;
  bottomPadding: number;
  panelHeight: number;
  panelMaxWidth: number;
}

export function getWorkspacePickerPresentation({
  width,
  height,
  topInset,
  bottomInset,
}: WorkspacePickerViewport): WorkspacePickerPresentation {
  const isLargeScreen = Math.min(width, height) >= 600;
  const topPadding = isLargeScreen
    ? Math.max(topInset + 24, 48)
    : Math.max(topInset + 8, 16);
  const bottomPadding = isLargeScreen ? Math.max(bottomInset + 24, 48) : 0;
  const availableHeight = Math.max(0, height - topPadding - bottomPadding);

  return {
    isLargeScreen,
    horizontalPadding: isLargeScreen ? 24 : 0,
    topPadding,
    bottomPadding,
    panelHeight: isLargeScreen
      ? Math.min(WORKSPACE_PICKER_MAX_HEIGHT, availableHeight)
      : availableHeight,
    panelMaxWidth: isLargeScreen ? WORKSPACE_PICKER_MAX_WIDTH : width,
  };
}

export function toPathBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function matchesSearch(values: string[], query: string): boolean {
  return !query || values.some((value) => value.toLowerCase().includes(query));
}

export function formatWorkspaceMeta(workspace: WorkspaceSummary): string {
  const relative = formatRelativeTime(workspace.updatedAt);
  if (relative) return relative;
  if (workspace.chatCount === 1) return '1 chat';
  return `${String(workspace.chatCount)} chats`;
}

export function formatRelativeTime(iso?: string): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;

  const diffMs = Math.max(0, Date.now() - timestamp);
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  const weeks = Math.floor(days / 7);

  if (seconds < 10) return 'now';
  if (seconds < 60) return `${String(seconds)} sec ago`;
  if (minutes < 60) return `${String(minutes)} min ago`;
  if (hours < 24) return `${String(hours)} hr ago`;
  if (days < 7) return `${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
  if (weeks < 5) return `${String(weeks)} wk ago`;
  return `${String(Math.floor(days / 30))} mo ago`;
}