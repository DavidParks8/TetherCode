import { useCallback } from 'react';
import type { Chat } from '../api/types';
import { buildUserInputAnswers } from './controllers/approvalController';
import { type ChatSyncAssessment, useChatSynchronization } from './controllers/chatSyncController';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { MainScreenWsEventRouterContext, MainScreenWsEventRouterResult } from './mainScreenWsEventRouter';






export type MainScreenApprovalAndUserInputResolutionContext = MainScreenWsEventRouterContext & MainScreenWsEventRouterResult;

export function useMainScreenApprovalAndUserInputResolution(context: MainScreenApprovalAndUserInputResolutionContext) {
  const {
    activeTurnIdRef,
    appStateRef,
    approvalController,
    bumpRunWatchdog,
    cacheThreadPendingApproval,
    cacheThreadPendingUserInputRequest,
    chatSyncController,
    clearRunWatchdog,
    creating,
    hadCommandRef,
    mergeChatWithPendingOptimisticMessages,
    pendingApproval,
    pendingUserInputRequest,
    reasoningBufferRef,
    reasoningSummaryRef,
    resolvingUserInput,
    runWatchdogUntilRef,
    selectedChatId,
    selectedChatIdRef,
    selectedChatRef,
    sending,
    setActiveCommands,
    setActiveTurnId,
    setActivity,
    setError,
    setPendingApproval,
    setPendingUserInputRequest,
    setResolvingUserInput,
    setSelectedChat,
    setStoppingTurn,
    setStreamingText,
    setUserInputDrafts,
    setUserInputError,
    userInputDrafts,
  } = context;


  const applySynchronizedChat = useCallback((latest: Chat, assessment: ChatSyncAssessment) => {
    const targetChatId = latest.id;
    if (selectedChatIdRef.current !== targetChatId) return;
    const hasPendingApproval = Boolean(pendingApproval?.requestId);
    const hasPendingUserInput = Boolean(pendingUserInputRequest?.requestId);
    const resolvedLatest = mergeChatWithPendingOptimisticMessages(latest);
    setSelectedChat((prev) => {
      if (!prev || prev.id !== resolvedLatest.id) return resolvedLatest;
      return resolveEquivalentChat(prev, resolvedLatest);
    });
        const shouldShowRunning = assessment.shouldShowRunning;
        const shouldRefreshWatchdog = assessment.shouldRefreshWatchdog;
        const watchdogDurationMs = assessment.watchdogDurationMs;

        if (shouldShowRunning && !hasPendingApproval && !hasPendingUserInput) {
          setActivity((prev) => {
            // Only guard against watchdog-only bumps overriding a fresh
            // completion. When the server explicitly reports running, trust it
            // (handles externally-started turns like CLI).
            if (
              !shouldRefreshWatchdog &&
              (prev.tone === 'complete' || prev.tone === 'error')
            ) {
              return prev;
            }
            if (shouldRefreshWatchdog) {
              bumpRunWatchdog(watchdogDurationMs);
            }
            return prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' };
          });
        } else if (!hasPendingApproval && !hasPendingUserInput) {
          clearRunWatchdog();
          setActiveCommands([]);
          setStreamingText(null);
          setActiveTurnId(null);
          setStoppingTurn(false);
          reasoningSummaryRef.current = {};
          reasoningBufferRef.current = '';
          hadCommandRef.current = false;
          setActivity((prev) => {
            if (resolvedLatest.status === 'complete') {
              return prev.tone === 'running'
                ? {
                    tone: 'complete',
                    title: 'Turn completed',
                  }
                : {
                    tone: 'idle',
                    title: 'Ready',
                  };
            }

            if (resolvedLatest.status === 'error') {
              const failureDetail = resolvedLatest.lastError?.trim() || prev.detail;
              return {
                tone: 'error',
                title: prev.tone === 'error' && prev.title ? prev.title : 'Turn failed',
                detail: failureDetail || undefined,
              };
            }

            return {
              tone: 'idle',
              title: 'Ready',
            };
          });
        }
  }, [
    pendingApproval?.requestId,
    pendingUserInputRequest?.requestId,
    bumpRunWatchdog,
    clearRunWatchdog,
    mergeChatWithPendingOptimisticMessages,
  ]);

  useChatSynchronization({
    controller: chatSyncController,
    threadId: selectedChatId,
    paused: sending || creating,
    getPrevious: () => selectedChatRef.current,
    isWatchdogActive: () => runWatchdogUntilRef.current > Date.now(),
    isAppActive: () => appStateRef.current === 'active',
    isTurnActive: () =>
      appStateRef.current === 'active' &&
      (Boolean(activeTurnIdRef.current) || runWatchdogUntilRef.current > Date.now()),
    onSnapshot: applySynchronizedChat,
  });

  const handleResolveApproval = useCallback(
    async (id: string, optionId: string): Promise<void> => {
      try {
        await approvalController.resolveApproval(id, optionId);
        if (selectedChatId) {
          cacheThreadPendingApproval(selectedChatId, null);
        }
        setPendingApproval(null);
      } catch (err) {
        setError((err as Error).message);
        throw err;
      }
    },
    [approvalController, cacheThreadPendingApproval, selectedChatId]
  );

  const setUserInputDraft = useCallback((questionId: string, value: string) => {
    setUserInputDrafts((prev) => ({
      ...prev,
      [questionId]: value,
    }));
    setUserInputError(null);
  }, []);

  const submitUserInputRequest = useCallback(async () => {
    if (!pendingUserInputRequest || resolvingUserInput) {
      return;
    }

    const validation = buildUserInputAnswers(pendingUserInputRequest, userInputDrafts);
    if ('error' in validation) {
      setUserInputError(validation.error);
      return;
    }

    setResolvingUserInput(true);
    try {
      const resolutionError = await approvalController.resolveUserInput(
        pendingUserInputRequest,
        userInputDrafts
      );
      if (resolutionError) {
        setUserInputError(resolutionError);
        return;
      }
      cacheThreadPendingUserInputRequest(pendingUserInputRequest.threadId, null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setActivity({
        tone: 'running',
        title: 'Input submitted',
      });
      bumpRunWatchdog();
    } catch (err) {
      setUserInputError((err as Error).message);
    } finally {
      setResolvingUserInput(false);
    }
  }, [
    approvalController,
    bumpRunWatchdog,
    cacheThreadPendingUserInputRequest,
    pendingUserInputRequest,
    resolvingUserInput,
    userInputDrafts,
  ]);

  return {
    applySynchronizedChat,
    handleResolveApproval,
    setUserInputDraft,
    submitUserInputRequest,
  };
}

export type MainScreenApprovalAndUserInputResolutionResult = ReturnType<typeof useMainScreenApprovalAndUserInputResolution>;
