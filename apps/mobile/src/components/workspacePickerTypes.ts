import type { FileSystemEntry, WorkspaceSummary } from '../api/types';

export type WorkspacePickerScreen = 'home' | 'browser';

export interface WorkspacePickerModalProps {
  visible: boolean;
  selectedPath?: string | null;
  bridgeRoot?: string | null;
  recentWorkspaces: WorkspaceSummary[];
  favoriteWorkspacePaths?: string[];
  currentPath?: string | null;
  parentPath?: string | null;
  entries: FileSystemEntry[];
  loadingEntries?: boolean;
  error?: string | null;
  truncationMessage?: string | null;
  onBrowsePath: (path: string | null) => void;
  onSelectPath: (path: string | null) => void;
  onToggleFavorite?: (path: string | null) => void;
  actionLabel?: string | null;
  actionDescription?: string | null;
  actionDisabled?: boolean;
  onActionPress?: (path: string | null) => void;
  onClose: () => void;
}