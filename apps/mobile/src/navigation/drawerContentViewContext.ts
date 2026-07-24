import { createContext, useContext, type RefObject } from 'react';
import type { AppTheme } from '../theme';
import type {
  DrawerAttentionLane,
  DrawerAttentionSection,
  DrawerFolderOption,
} from './drawerAttention';
import type { DrawerContentStyles } from './drawerContentStyles';
import type { DrawerScreen } from './drawerContentTypes';

export interface DrawerContentViewModel {
  attentionCount: number;
  collapsedLaneKeys: Set<DrawerAttentionLane>;
  folderOptions: DrawerFolderOption[];
  folderPickerVisible: boolean;
  handleDismissFolderPicker: () => void;
  handleNavigate: (screen: DrawerScreen) => void;
  handleNewChat: () => void;
  handleOpenFolderPicker: () => void;
  handleSelectChat: (chatId: string) => void;
  handleSelectFolder: (folderKey: string | null) => void;
  loading: boolean;
  loadingOlderChats: boolean;
  noticeMessages: string[];
  recentCount: number;
  refreshing: boolean;
  refreshDrawer: () => Promise<void>;
  resolvedEmptyHint: string;
  resolvedEmptyTitle: string;
  retryDeepChatListRef: RefObject<() => Promise<void>>;
  selectedChatId: string | null;
  selectedFolderKey: string | null;
  selectedFolderLabel: string;
  styles: DrawerContentStyles;
  theme: AppTheme;
  toggleAttentionSection: (lane: DrawerAttentionLane) => void;
  totalChatCount: number;
  visibleAttentionSections: DrawerAttentionSection[];
  visibleChatCount: number;
  workingCount: number;
  wsConnected: boolean;
}

export const DrawerContentViewContext = createContext<DrawerContentViewModel | null>(null);

export function useDrawerContentViewModel(): DrawerContentViewModel {
  const value = useContext(DrawerContentViewContext);
  if (!value) throw new Error('DrawerContentView requires DrawerContentViewContext');
  return value;
}
