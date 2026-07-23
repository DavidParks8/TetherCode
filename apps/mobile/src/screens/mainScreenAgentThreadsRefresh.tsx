import { useCallback, useEffect } from 'react';
import { AGENT_THREADS_SYNC_INTERVAL_MS, AGENT_THREADS_IDLE_SYNC_INTERVAL_MS, AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS } from './mainScreenHelpers';
import { areChatSummaryListsEquivalent } from './mainScreenChatState';
import type { MainScreenWorkspaceBrowserStateContext, MainScreenWorkspaceBrowserStateResult } from './mainScreenWorkspaceBrowserState';






export type MainScreenAgentThreadsRefreshContext = MainScreenWorkspaceBrowserStateContext & MainScreenWorkspaceBrowserStateResult;

export function useMainScreenAgentThreadsRefresh(context: MainScreenAgentThreadsRefreshContext) {
  const {
    activeTurnIdRef,
    agentRootThreadId,
    agentThreadsController,
    agentThreadsRefreshTimerRef,
    agentThreadsRequestRef,
    appStateRef,
    chatIdRef,
    clearDeferredDisconnectActivity,
    clearForegroundAgentRefresh,
    relatedAgentThreads,
    resumeGitCheckoutAfterWorkspacePicker,
    runWatchdogUntilRef,
    selectedChatId,
    selectedChatRef,
    setAgentRootThreadId,
    setAgentThreadMenuVisible,
    setError,
    setGitCheckoutModalVisible,
    setLoadingAgentThreads,
    setRelatedAgentThreads,
    setResumeGitCheckoutAfterWorkspacePicker,
    setWorkspaceModalVisible,
    workspacePickerPurpose,
  } = context;


  const refreshAgentThreads = useCallback(
    async (
      focusChatId?: string | null,
      options?: { showLoading?: boolean }
    ) => {
      const activeChatId = focusChatId ?? chatIdRef.current;
      if (!activeChatId) {
        setRelatedAgentThreads([]);
        setAgentRootThreadId(null);
        return {
          rootThreadId: null,
          threads: [],
        };
      }

      const requestId = agentThreadsRequestRef.current + 1;
      agentThreadsRequestRef.current = requestId;
      if (options?.showLoading) {
        setLoadingAgentThreads(true);
      }

      try {
        const related = await agentThreadsController.loadRelated(
          activeChatId,
          selectedChatRef.current?.id === activeChatId ? selectedChatRef.current : null
        );

        if (agentThreadsRequestRef.current !== requestId) {
          return related;
        }

        setRelatedAgentThreads((prev) =>
          areChatSummaryListsEquivalent(prev, related.threads) ? prev : related.threads
        );
        setAgentRootThreadId((prev) =>
          prev === related.rootThreadId ? prev : related.rootThreadId
        );
        return related;
      } catch (err) {
        if (agentThreadsRequestRef.current === requestId && options?.showLoading) {
          setError((err as Error).message);
        }
        return {
          rootThreadId: null,
          threads: [],
        };
      } finally {
        if (agentThreadsRequestRef.current === requestId && options?.showLoading) {
          setLoadingAgentThreads(false);
        }
      }
    },
    [agentThreadsController]
  );

  const scheduleAgentThreadsRefresh = useCallback(
    (focusChatId?: string | null) => {
      const activeChatId = focusChatId ?? chatIdRef.current;
      if (!activeChatId) {
        return;
      }

      const existingTimer = agentThreadsRefreshTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      agentThreadsRefreshTimerRef.current = setTimeout(() => {
        agentThreadsRefreshTimerRef.current = null;
        void refreshAgentThreads(activeChatId);
      }, 220);
    },
    [refreshAgentThreads]
  );

  const closeWorkspaceModal = useCallback(() => {
    setWorkspaceModalVisible(false);
    if (
      workspacePickerPurpose === 'git-checkout-destination' &&
      resumeGitCheckoutAfterWorkspacePicker
    ) {
      setResumeGitCheckoutAfterWorkspacePicker(false);
      setGitCheckoutModalVisible(true);
    }
  }, [
    resumeGitCheckoutAfterWorkspacePicker,
    workspacePickerPurpose,
  ]);

  useEffect(() => {
    if (!selectedChatId) {
      setRelatedAgentThreads([]);
      setAgentRootThreadId(null);
      setAgentThreadMenuVisible(false);
      return;
    }

    void refreshAgentThreads(selectedChatId);
  }, [refreshAgentThreads, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId) {
      return;
    }

    const hasKnownRelatedAgentThreads =
      relatedAgentThreads.length > 0 || Boolean(agentRootThreadId);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNextRefresh = () => {
      if (stopped) {
        return;
      }

      const appIsActive = appStateRef.current === 'active';
      const shouldPollFast =
        appIsActive &&
        (hasKnownRelatedAgentThreads ||
          Boolean(activeTurnIdRef.current) ||
          runWatchdogUntilRef.current > Date.now());
      const intervalMs = !appIsActive
        ? AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS
        : shouldPollFast
          ? AGENT_THREADS_SYNC_INTERVAL_MS
          : AGENT_THREADS_IDLE_SYNC_INTERVAL_MS;

      timer = setTimeout(() => {
        const activeChatId = chatIdRef.current;
        if (activeChatId === selectedChatId) {
          void refreshAgentThreads(activeChatId);
        }
        scheduleNextRefresh();
      }, intervalMs);
    };

    scheduleNextRefresh();
    return () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [agentRootThreadId, refreshAgentThreads, relatedAgentThreads.length, selectedChatId]);

  useEffect(
    () => () => {
      clearDeferredDisconnectActivity();
      clearForegroundAgentRefresh();
    },
    [clearDeferredDisconnectActivity, clearForegroundAgentRefresh]
  );

  return {
    refreshAgentThreads,
    scheduleAgentThreadsRefresh,
    closeWorkspaceModal,
  };
}

export type MainScreenAgentThreadsRefreshResult = ReturnType<typeof useMainScreenAgentThreadsRefresh>;
