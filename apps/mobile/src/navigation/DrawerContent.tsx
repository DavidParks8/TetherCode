import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AgentDescriptor, AgentId } from '../api/types';
import { getAgentLabel } from '../agents';
import {
  filterDrawerChatsByAgents,
  searchDrawerChats,
} from './drawerChats';
import {
  buildChatWorkspaceSections,
  type ChatWorkspaceSection,
} from './chatThreadTree';
import {
  DEFAULT_WORKSPACE_CHAT_LIMIT,
} from '../appSettings';
import {
  countDrawerRunningChats,
} from './drawerRuntimeIndicators';
import { useAppTheme } from '../theme';
import {
  getDefaultCollapsedWorkspaceKeys,
  normalizeWorkspaceChatLimit,
  sortPinnedChatsInSections,
  sortWorkspaceSections,
} from './drawerContentHelpers';
import { createDrawerContentStyles } from './drawerContentStyles';
import type { DrawerContentProps, DrawerScreen } from './drawerContentTypes';
import { DrawerContentView } from './DrawerContentView';
import { DrawerContentViewContext } from './drawerContentViewContext';
import { useDrawerChatLoading } from './useDrawerChatLoading';
import { useDrawerPins } from './useDrawerPins';

const DRAWER_EVENT_REFRESH_DEBOUNCE_MS = 250;
export const DrawerContent = memo(function DrawerContentComponent({
  api,
  ws,
  active,
  workspaceChatLimit = DEFAULT_WORKSPACE_CHAT_LIMIT,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onNavigate,
}: DrawerContentProps) {
  const theme = useAppTheme();
  const {
    chats,
    loading,
    loadingOlderChats,
    partialHistoryDiagnostics,
    refreshing,
    runIndicatorsByThread,
    wsConnected,
    loadChats,
    retryDeepChatListRef,
    cancelChatListStream,
    scheduleLoadChats,
  } = useDrawerChatLoading(api, ws, active);
  const [selectedAgentIds, setSelectedAgentIds] = useState<AgentId[]>([]);
  const [agents, setAgents] = useState<AgentDescriptor[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMenuVisible, setFilterMenuVisible] = useState(false);
  const [collapsedWorkspaceKeys, setCollapsedWorkspaceKeys] = useState<Set<string>>(new Set());
  const { pinnedChatIds, pinnedWorkspacePaths, pinnedChatIdSet,
    pinnedWorkspacePathSet, showChatPinAction, showWorkspacePinAction } = useDrawerPins();
  const [workspaceVisibleCounts, setWorkspaceVisibleCounts] = useState<Record<string, number>>({});
  const hasAppliedInitialCollapseRef = useRef(false);
  const knownWorkspaceKeysRef = useRef<Set<string>>(new Set());
  const chatSectionsRef = useRef<ChatWorkspaceSection[]>([]);
  const styles = useMemo(() => createDrawerContentStyles(theme), [theme]);
  const chatFilterOptions = useMemo(
    () => agents.filter((agent) => agent.lifecycle === 'ready'),
    [agents]
  );
  const agentFilteredChats = useMemo(
    () => selectedAgentIds.length === chatFilterOptions.length
      ? chats
      : filterDrawerChatsByAgents(chats, selectedAgentIds),
    [chatFilterOptions.length, chats, selectedAgentIds]
  );
  const filteredChats = useMemo(
    () => searchDrawerChats(agentFilteredChats, searchQuery),
    [agentFilteredChats, searchQuery]
  );

  useEffect(() => {
    let cancelled = false;
    void api.readBridgeCapabilities().then((capabilities) => {
      if (cancelled) {
        return;
      }
      setAgents(capabilities.agents);
      setSelectedAgentIds(
        capabilities.agents.filter((agent) => agent.lifecycle === 'ready').map((agent) => agent.agentId)
      );
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);
  const baseChatSections = useMemo(
    () =>
      sortWorkspaceSections(
        sortPinnedChatsInSections(buildChatWorkspaceSections(agentFilteredChats), pinnedChatIds),
        pinnedWorkspacePaths
      ),
    [agentFilteredChats, pinnedChatIds, pinnedWorkspacePaths]
  );
  const workspaceChatSections = useMemo(
    () =>
      sortWorkspaceSections(
        sortPinnedChatsInSections(buildChatWorkspaceSections(filteredChats), pinnedChatIds),
        pinnedWorkspacePaths
      ),
    [filteredChats, pinnedChatIds, pinnedWorkspacePaths]
  );
  const chatSections = useMemo(
    () => workspaceChatSections,
    [workspaceChatSections]
  );
  const chatSectionByKey = useMemo(
    () => new Map(chatSections.map((section) => [section.key, section])),
    [chatSections]
  );
  const isSearching = searchQuery.trim().length > 0;
  const normalizedWorkspaceChatLimit = normalizeWorkspaceChatLimit(workspaceChatLimit);
  const visibleChatSections = useMemo(
    () =>
      chatSections.map((section) => {
        const collapsed = !isSearching && collapsedWorkspaceKeys.has(section.key);
        if (collapsed) {
          return {
            ...section,
            data: [],
          };
        }

        if (isSearching || normalizedWorkspaceChatLimit === null) {
          return section;
        }

        const visibleCount = Math.min(
          section.data.length,
          workspaceVisibleCounts[section.key] ?? normalizedWorkspaceChatLimit
        );
        return {
          ...section,
          data: section.data.slice(0, visibleCount),
        };
      }),
    [
      chatSections,
      collapsedWorkspaceKeys,
      isSearching,
      normalizedWorkspaceChatLimit,
      workspaceVisibleCounts,
    ]
  );
  const runningChatCount = useMemo(
    () => countDrawerRunningChats(chats, runIndicatorsByThread),
    [chats, runIndicatorsByThread]
  );

  useEffect(() => {
    setWorkspaceVisibleCounts({});
  }, [normalizedWorkspaceChatLimit]);

  const showAllWorkspaceChats = useCallback(
    (section: ChatWorkspaceSection) => {
      if (normalizedWorkspaceChatLimit === null) {
        return;
      }

      setWorkspaceVisibleCounts((prev) => {
        const currentCount = prev[section.key] ?? normalizedWorkspaceChatLimit;
        const nextCount = section.itemCount;
        if (nextCount <= currentCount) {
          return prev;
        }

        return {
          ...prev,
          [section.key]: nextCount,
        };
      });
    },
    [normalizedWorkspaceChatLimit]
  );

  useEffect(() => {
    chatSectionsRef.current = baseChatSections;
  }, [baseChatSections]);

  useEffect(() => {
    const nextKnownKeys = new Set(baseChatSections.map((section) => section.key));
    if (baseChatSections.length === 0) {
      knownWorkspaceKeysRef.current = nextKnownKeys;
      return;
    }

    setCollapsedWorkspaceKeys((prev) => {
      if (!hasAppliedInitialCollapseRef.current) {
        hasAppliedInitialCollapseRef.current = true;
        return getDefaultCollapsedWorkspaceKeys(baseChatSections);
      }

      let changed = false;
      const next = new Set<string>();

      for (const key of prev) {
        if (nextKnownKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }

      for (let index = 1; index < baseChatSections.length; index += 1) {
        const key = baseChatSections[index]?.key;
        if (key && !knownWorkspaceKeysRef.current.has(key) && !next.has(key)) {
          next.add(key);
          changed = true;
        }
      }

      const everySectionCollapsed =
        baseChatSections.length > 0 &&
        baseChatSections.every((section) => next.has(section.key));
      if (everySectionCollapsed) {
        next.delete(baseChatSections[0]?.key ?? '');
        changed = true;
      }

      return changed ? next : prev;
    });

    knownWorkspaceKeysRef.current = nextKnownKeys;
  }, [baseChatSections]);

  const filteredChatCount = filteredChats.length;
  const selectedAgentIdSet = useMemo(
    () => new Set(selectedAgentIds),
    [selectedAgentIds]
  );
  const hasFilteredAgents = selectedAgentIds.length < chatFilterOptions.length;
  const hasActiveFilters = hasFilteredAgents || isSearching;
  const singleSelectedAgentId = selectedAgentIds.length === 1 ? selectedAgentIds[0] : null;
  const emptyTitle = singleSelectedAgentId
    ? `No ${getAgentLabel(agents, singleSelectedAgentId)} chats`
    : 'No chats yet';
  const emptyHint = singleSelectedAgentId
    ? `Turn another agent back on or start a new ${getAgentLabel(agents, singleSelectedAgentId)} chat.`
    : 'Start a new chat and it will show up here with live activity.';
  const resolvedEmptyTitle = isSearching ? 'No matching chats' : emptyTitle;
  const resolvedEmptyHint = isSearching
    ? 'Try a different title, keyword, or workspace name.'
    : emptyHint;

  useEffect(() => {
    if (!active) {
      return;
    }

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setCollapsedWorkspaceKeys(getDefaultCollapsedWorkspaceKeys(chatSectionsRef.current));
        hasAppliedInitialCollapseRef.current = true;
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [active, scheduleLoadChats]);

  const toggleWorkspaceSection = useCallback((sectionKey: string) => {
    setCollapsedWorkspaceKeys((prev) => {
      const next = new Set(prev);
      if (next.has(sectionKey)) {
        next.delete(sectionKey);
      } else {
        next.add(sectionKey);
      }
      return next;
    });
  }, []);

  const handleSelectChat = useCallback(
    (chatId: string) => {
      if (!isSearching) {
        setFilterMenuVisible(false);
      }
      cancelChatListStream();
      onSelectChat(chatId);
    },
    [cancelChatListStream, isSearching, onSelectChat]
  );

  const handleNewChat = useCallback(() => {
    if (!isSearching) {
      setFilterMenuVisible(false);
    }
    cancelChatListStream();
    onNewChat();
  }, [cancelChatListStream, isSearching, onNewChat]);

  const handleNavigate = useCallback(
    (screen: DrawerScreen) => {
      if (!isSearching) {
        setFilterMenuVisible(false);
      }
      cancelChatListStream();
      onNavigate(screen);
    },
    [cancelChatListStream, isSearching, onNavigate]
  );

  const toggleAgentFilter = useCallback((agentId: AgentId) => {
    setSelectedAgentIds((prev) => {
      const selected = prev.includes(agentId);
      if (selected && prev.length === 1) {
        return prev;
      }
      return selected ? prev.filter((entry) => entry !== agentId) : [...prev, agentId];
    });
  }, []);

  const handleToggleFilterMenu = useCallback(() => {
    if (filterMenuVisible) {
      if (isSearching) {
        setSearchQuery('');
      }
      setFilterMenuVisible(false);
      return;
    }

    setFilterMenuVisible(true);
  }, [filterMenuVisible, isSearching]);

  const viewModel = {
    agents,
    chatFilterOptions,
    chats,
    chatSections,
    visibleChatSections,
    chatSectionByKey,
    collapsedWorkspaceKeys,
    filterMenuVisible,
    filteredChatCount,
    handleNavigate,
    handleNewChat,
    handleSelectChat,
    handleToggleFilterMenu,
    hasActiveFilters,
    isSearching,
    loadChats,
    loading,
    loadingOlderChats,
    normalizedWorkspaceChatLimit,
    partialHistoryDiagnostics,
    pinnedChatIdSet,
    pinnedWorkspacePathSet,
    refreshing,
    resolvedEmptyHint,
    resolvedEmptyTitle,
    retryDeepChatListRef,
    runningChatCount,
    runIndicatorsByThread,
    searchQuery,
    selectedAgentIdSet,
    selectedChatId,
    setSearchQuery,
    showAllWorkspaceChats,
    showChatPinAction,
    showWorkspacePinAction,
    styles,
    theme,
    toggleAgentFilter,
    toggleWorkspaceSection,
    wsConnected,
  };
  return (
    <DrawerContentViewContext.Provider value={viewModel}>
      <DrawerContentView />
    </DrawerContentViewContext.Provider>
  );
});
