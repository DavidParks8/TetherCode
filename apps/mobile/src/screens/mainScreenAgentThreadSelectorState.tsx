import { useCallback, useImperativeHandle, useLayoutEffect, useMemo } from 'react';
import type { Chat } from '../api/types';
import { type SelectionSheetOption } from '../components/SelectionSheet';
import { describeAgentThreadSource, findMatchingAgentThread, resolveAgentActivitySummary } from './agentThreads';
import { buildAgentThreadDisplayState } from './agentThreadDisplay';
import { formatAgentThreadOptionTitle, iconForAgentThread } from './mainScreenHelpers';
import type { MainScreenChatNavigationAndAgentDetailContext, MainScreenChatNavigationAndAgentDetailResult } from './mainScreenChatNavigationAndAgentDetail';






export type MainScreenAgentThreadSelectorStateContext = MainScreenChatNavigationAndAgentDetailContext & MainScreenChatNavigationAndAgentDetailResult;

export function useMainScreenAgentThreadSelectorState(context: MainScreenAgentThreadSelectorStateContext) {
  const {
    agentDetailThreadId,
    agentRootThreadId,
    agentRuntimeRevision,
    closeAgentDetail,
    onPendingOpenChatHandled,
    openAgentDetail,
    openAgentThreadSelectorRef,
    openChatThread,
    pendingOpenChatId,
    pendingOpenChatSnapshot,
    ref,
    refreshAgentThreads,
    relatedAgentThreads,
    runWatchdogNow,
    selectedChatRef,
    setAgentThreadMenuVisible,
    setError,
    startNewChat,
    threadRuntimeSnapshotsRef,
  } = context;


  const openAgentThreadSelector = useCallback(
    async (query?: string | null): Promise<boolean> => {
      const focusChat = selectedChatRef.current;
      if (!focusChat?.id) {
        setError('Open a chat before switching agent threads.');
        return false;
      }

      const related = await refreshAgentThreads(focusChat.id, { showLoading: true });
      if (related.threads.length <= 1) {
        setAgentThreadMenuVisible(false);
        setError('No spawned agent threads for this chat yet.');
        return true;
      }

      const normalizedQuery = query?.trim() ?? '';
      if (!normalizedQuery) {
        setError(null);
        setAgentThreadMenuVisible(true);
        return true;
      }

      const match = findMatchingAgentThread(related.threads, normalizedQuery);
      if (!match) {
        setError(`No agent thread matched "${normalizedQuery}".`);
        setAgentThreadMenuVisible(true);
        return true;
      }

      setAgentThreadMenuVisible(false);
      if (match.id === agentRootThreadId) {
        closeAgentDetail();
      } else {
        openAgentDetail(match.id);
      }
      return true;
    },
    [agentRootThreadId, closeAgentDetail, openAgentDetail, refreshAgentThreads]
  );
  openAgentThreadSelectorRef.current = openAgentThreadSelector;

  const agentThreadRows = useMemo(() => {
    let subAgentOrdinal = 0;

    return relatedAgentThreads.map((chat) => {
      const isRootThread = Boolean(agentRootThreadId) && chat.id === agentRootThreadId;
      const ordinal = isRootThread ? null : (subAgentOrdinal += 1);
      const snapshot = threadRuntimeSnapshotsRef.current[chat.id] ?? null;
      const runtime = buildAgentThreadDisplayState(
        chat,
        snapshot,
        runWatchdogNow
      );
      const latestCommand = snapshot?.latestCommand ?? snapshot?.activeCommands?.at(-1) ?? null;

      return {
        chat,
        isRootThread,
        ordinal,
        title: formatAgentThreadOptionTitle(chat, agentRootThreadId, ordinal),
        description: resolveAgentActivitySummary({
          runtimeDetail: runtime.detail,
          latestCommandDetail: latestCommand?.detail,
          role: chat.agentRole,
          preview: chat.lastMessagePreview,
          sourceDescription: describeAgentThreadSource(chat, agentRootThreadId),
        }),
        latestCommand,
        runtime,
        selected: chat.id === agentDetailThreadId,
      };
    });
  }, [
    agentRootThreadId,
    agentRuntimeRevision,
    relatedAgentThreads,
    runWatchdogNow,
    agentDetailThreadId,
  ]);

  const liveAgentRows = useMemo(
    () => agentThreadRows.filter((row) => !row.isRootThread),
    [agentThreadRows]
  );
  const liveRunningAgentCount = useMemo(
    () => agentThreadRows.filter((row) => !row.isRootThread && row.runtime.isActive).length,
    [agentThreadRows]
  );
  const selectorAgentCount = useMemo(
    () => agentThreadRows.filter((row) => !row.isRootThread).length,
    [agentThreadRows]
  );

  const agentThreadMenuOptions = useMemo<SelectionSheetOption[]>(() => {
    return agentThreadRows.map((row) => {
      const { chat, description, isRootThread, runtime } = row;
      return {
        key: chat.id,
        title: row.title,
        description,
        badge: isRootThread
          ? 'Main'
          : chat.subAgentDepth
            ? `D${String(chat.subAgentDepth)}`
            : undefined,
        badgeBackgroundColor: isRootThread ? undefined : runtime.statusSurfaceColor,
        badgeTextColor: isRootThread ? undefined : runtime.accentColor,
        meta: runtime.label,
        metaColor: runtime.statusColor,
        icon: isRootThread ? iconForAgentThread(chat, agentRootThreadId) : runtime.icon,
        iconColor: isRootThread ? undefined : runtime.accentColor,
        titleColor: isRootThread ? undefined : runtime.accentColor,
        selected: row.selected,
        onPress: () => {
          setAgentThreadMenuVisible(false);
          if (isRootThread) {
            closeAgentDetail();
          } else {
            openAgentDetail(chat.id);
          }
        },
      } satisfies SelectionSheetOption;
    });
  }, [agentRootThreadId, agentThreadRows, closeAgentDetail, openAgentDetail]);

  useImperativeHandle(
    ref,
    () => ({
      openChat: (id: string, optimisticChat?: Chat | null) => {
        closeAgentDetail();
        openChatThread(id, optimisticChat);
      },
      startNewChat: () => {
        closeAgentDetail();
        startNewChat();
      },
    }),
    [closeAgentDetail, openChatThread, startNewChat]
  );

  useLayoutEffect(() => {
    if (!pendingOpenChatId) {
      return;
    }

    const snapshot =
      pendingOpenChatSnapshot && pendingOpenChatSnapshot.id === pendingOpenChatId
        ? pendingOpenChatSnapshot
        : null;

    openChatThread(pendingOpenChatId, snapshot);
    onPendingOpenChatHandled?.();
  }, [
    onPendingOpenChatHandled,
    openChatThread,
    pendingOpenChatId,
    pendingOpenChatSnapshot,
  ]);

  return {
    openAgentThreadSelector,
    agentThreadRows,
    liveAgentRows,
    liveRunningAgentCount,
    selectorAgentCount,
    agentThreadMenuOptions,
  };
}

export type MainScreenAgentThreadSelectorStateResult = ReturnType<typeof useMainScreenAgentThreadSelectorState>;
