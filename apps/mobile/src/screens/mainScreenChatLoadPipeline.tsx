import { useCallback } from 'react';
import { sleep, RUN_WATCHDOG_MS, shouldSurfaceChatLoadError, isChatLikelyRunning } from './mainScreenHelpers';
import { getTranscriptContinuationState } from './controllers/transcriptContinuationController';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { MainScreenSlashCommandHandlerContext, MainScreenSlashCommandHandlerResult } from './mainScreenSlashCommandHandler';
import { OPEN_CHAT_MIN_LOADING_MS } from './mainScreenConstants';






export type MainScreenChatLoadPipelineContext = MainScreenSlashCommandHandlerContext & MainScreenSlashCommandHandlerResult;

export function useMainScreenChatLoadPipeline(context: MainScreenChatLoadPipelineContext) {
  const {
    applyThreadRuntimeSnapshot,
    autoEnabledPlanTurnIdByThreadRef,
    bumpRunWatchdog,
    cacheThreadQueueState,
    cacheThreadTurnState,
    chatIdRef,
    chatSyncController,
    clearRunWatchdog,
    hadCommandRef,
    loadChatRequestRef,
    mergeChatWithPendingOptimisticMessages,
    openingChatStartedAtRef,
    reasoningBufferRef,
    reasoningSummaryRef,
    refreshPendingApprovalsForThread,
    scrollToBottomIfPinned,
    scrollToBottomReliable,
    selectedChatRef,
    setActiveCommands,
    setActiveTurnId,
    setActivity,
    setError,
    setOpeningChatId,
    setPendingApproval,
    setSelectedChat,
    setSelectedChatId,
    setStoppingTurn,
    setStreamingText,
    setTranscriptContinuationState,
    stopSystemMessageLoggedRef,
    threadRuntimeSnapshotsRef,
  } = context;


  const loadChat = useCallback(
    async (
      chatId: string,
      options?: {
        forceScroll?: boolean;
        preserveRuntimeState?: boolean;
        revalidate?: boolean;
      }
    ): Promise<boolean> => {
      const requestId = loadChatRequestRef.current + 1;
      loadChatRequestRef.current = requestId;
      let loadedSuccessfully = false;
      try {
        void chatSyncController
          .readQueue(chatId)
          .then((queueState) => {
            if (requestId === loadChatRequestRef.current) {
              cacheThreadQueueState(chatId, queueState);
            }
          })
          .catch(() => {});
        const loadedChat = await chatSyncController.load(chatId);
        const chat = mergeChatWithPendingOptimisticMessages(loadedChat);
        if (requestId !== loadChatRequestRef.current) {
          return false;
        }
        loadedSuccessfully = true;
        const shouldPreserveRuntimeState = Boolean(
          options?.preserveRuntimeState && chatId === chatIdRef.current
        );
        if (!shouldPreserveRuntimeState) {
          delete autoEnabledPlanTurnIdByThreadRef.current[chatId];
        }
        setSelectedChatId(chatId);
        setSelectedChat((prev) =>
          prev && prev.id === chat.id ? resolveEquivalentChat(prev, chat) : chat
        );
        setTranscriptContinuationState(getTranscriptContinuationState(chat));
        setError(null);
        if (!shouldPreserveRuntimeState) {
          setActiveCommands([]);
          setPendingApproval(null);
          setStreamingText(null);
          setActiveTurnId(null);
          setStoppingTurn(false);
          stopSystemMessageLoggedRef.current = false;
          const shouldRun = isChatLikelyRunning(chat);
          if (shouldRun) {
            const restoredActiveTurnId =
              chat.activeTurnId?.trim() ||
              threadRuntimeSnapshotsRef.current[chatId]?.activeTurnId?.trim() ||
              null;
            cacheThreadTurnState(chatId, {
              activeTurnId: restoredActiveTurnId,
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            setActivity({
              tone: 'running',
              title: 'Working',
            });
          } else {
            clearRunWatchdog();
            cacheThreadTurnState(chatId, {
              activeTurnId: null,
              runWatchdogUntil: 0,
            });
            setActivity(
              chat.status === 'complete'
                ? {
                    tone: 'complete',
                    title: 'Turn completed',
                  }
                : chat.status === 'error'
                  ? {
                      tone: 'error',
                      title: 'Turn failed',
                      detail: chat.lastError ?? undefined,
                    }
                  : {
                      tone: 'idle',
                      title: 'Ready',
                    }
            );
          }
          reasoningSummaryRef.current = {};
          reasoningBufferRef.current = '';
          hadCommandRef.current = false;
          applyThreadRuntimeSnapshot(chatId);
        }
        void refreshPendingApprovalsForThread(chatId);
      } catch (err) {
        if (requestId !== loadChatRequestRef.current) {
          return false;
        }
        const cachedChat = selectedChatRef.current;
        if (
          !shouldSurfaceChatLoadError(
            options?.revalidate,
            cachedChat?.id,
            chatId,
            cachedChat?.messages.length ?? 0
          )
        ) {
          return false;
        }
        setError((err as Error).message);
        setActivity({
          tone: 'error',
          title: 'Failed to load chat',
          detail: (err as Error).message,
        });
      } finally {
        if (requestId !== loadChatRequestRef.current) {
          return false;
        }

        if (loadedSuccessfully) {
          if (options?.forceScroll) {
            scrollToBottomReliable(false);
          } else {
            scrollToBottomIfPinned(false);
          }
          const startedAt = openingChatStartedAtRef.current;
          if (startedAt > 0) {
            const remainingMs = OPEN_CHAT_MIN_LOADING_MS - (Date.now() - startedAt);
            if (remainingMs > 0) {
              await sleep(remainingMs);
            }
          }
          if (requestId !== loadChatRequestRef.current) {
            return false;
          }
          setOpeningChatId((current) => {
            if (current === chatId) {
              openingChatStartedAtRef.current = 0;
              return null;
            }
            return current;
          });
        } else {
          openingChatStartedAtRef.current = 0;
          setOpeningChatId(null);
        }
        return loadedSuccessfully;
      }
    },
    [
      chatSyncController,
      applyThreadRuntimeSnapshot,
      bumpRunWatchdog,
      cacheThreadQueueState,
      clearRunWatchdog,
      mergeChatWithPendingOptimisticMessages,
      refreshPendingApprovalsForThread,
      scrollToBottomIfPinned,
      scrollToBottomReliable,
    ]
  );

  return {
    loadChat,
  };
}

export type MainScreenChatLoadPipelineResult = ReturnType<typeof useMainScreenChatLoadPipeline>;
