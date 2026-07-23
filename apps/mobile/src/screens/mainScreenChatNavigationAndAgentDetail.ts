import { useCallback } from 'react';
import type { Chat } from '../api/types';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { MainScreenChatLoadPipelineContext, MainScreenChatLoadPipelineResult } from './mainScreenChatLoadPipeline';






export type MainScreenChatNavigationAndAgentDetailContext = MainScreenChatLoadPipelineContext & MainScreenChatLoadPipelineResult;

export function useMainScreenChatNavigationAndAgentDetail(context: MainScreenChatNavigationAndAgentDetailContext) {
  const {
    agentDetailRequestRef,
    agentRootThreadId,
    agentThreadsController,
    api,
    applyThreadRuntimeSnapshot,
    attachmentController,
    autoEnabledPlanTurnIdByThreadRef,
    chatIdRef,
    loadChat,
    mergeChatWithPendingOptimisticMessages,
    openingChatStartedAtRef,
    refreshPendingApprovalsForThread,
    selectedChatIdRef,
    selectedChatRef,
    setActivePlan,
    setActiveTurnId,
    setActivity,
    setAgentDetailChat,
    setAgentDetailError,
    setAgentDetailLoading,
    setAgentDetailParentChat,
    setAgentDetailThreadId,
    setAgentThreadMenuVisible,
    setCreating,
    setError,
    setOpeningChatId,
    setPendingUserInputRequest,
    setQueueActionItemId,
    setQueueActionKind,
    setResolvingUserInput,
    setSelectedChat,
    setSelectedChatId,
    setSending,
    setStoppingTurn,
    setTranscriptContinuationState,
    setUserInputDrafts,
    setUserInputError,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    transcriptContinuationController,
    transcriptContinuationState,
  } = context;


  const handleLoadEarlier = useCallback(async () => {
    const chat = selectedChatRef.current;
    if (!chat || transcriptContinuationState.loading) return;
    setTranscriptContinuationState((previous) => ({ ...previous, loading: true, error: null }));
    const result = await transcriptContinuationController.loadEarlier(chat);
    if (selectedChatIdRef.current !== chat.id) return;
    if (result.kind === 'stale') {
      setTranscriptContinuationState(result.state);
      void loadChat(chat.id, { preserveRuntimeState: true });
      return;
    }
    setSelectedChat((previous) => previous?.id === chat.id ? result.chat : previous);
    api.rememberChat(result.chat);
    setTranscriptContinuationState(result.state);
  }, [api, loadChat, transcriptContinuationController, transcriptContinuationState.loading]);

  const openChatThread = useCallback(
    (id: string, optimisticChat?: Chat | null) => {
      const isSameChat = chatIdRef.current === id;
      const providedSnapshot =
        optimisticChat && optimisticChat.id === id ? optimisticChat : null;
      const providedHydratedSnapshot =
        providedSnapshot && providedSnapshot.messages.length > 0 ? providedSnapshot : null;
      const cachedChat = providedHydratedSnapshot ?? api.peekChat(id);
      const optimisticSnapshot = cachedChat ?? providedSnapshot ?? api.peekChatShell(id);
      const hasHydratedSnapshot = Boolean(cachedChat);

      if (isSameChat) {
        setSelectedChatId(id);
        openingChatStartedAtRef.current = 0;
        setOpeningChatId(null);
        setError(null);
        if (optimisticSnapshot) {
          setSelectedChat(mergeChatWithPendingOptimisticMessages(optimisticSnapshot));
        }
        void refreshPendingApprovalsForThread(id);
        loadChat(id, {
          forceScroll: true,
          preserveRuntimeState: true,
          revalidate: hasHydratedSnapshot,
        }).catch(() => {});
        return;
      }

      setSelectedChatId(id);
      openingChatStartedAtRef.current = hasHydratedSnapshot ? 0 : Date.now();
      setOpeningChatId(hasHydratedSnapshot ? null : id);
      setSending(false);
      setCreating(false);
      setError(null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
    attachmentController.closePathModal();
      setAgentThreadMenuVisible(false);
      setActivePlan(null);
      setActiveTurnId(null);
      setStoppingTurn(false);
      setQueueActionItemId(null);
      setQueueActionKind(null);
      stopRequestedRef.current = false;
      stopSystemMessageLoggedRef.current = false;
      delete autoEnabledPlanTurnIdByThreadRef.current[id];

      if (optimisticSnapshot) {
        setSelectedChat(mergeChatWithPendingOptimisticMessages(optimisticSnapshot));
      } else {
        setSelectedChat(null);
      }
      setActivity({
        tone: 'running',
        title: 'Opening chat',
      });

      applyThreadRuntimeSnapshot(id);
      void refreshPendingApprovalsForThread(id);
      loadChat(id, { forceScroll: true, revalidate: hasHydratedSnapshot }).catch(() => {});
    },
    [
      api,
      applyThreadRuntimeSnapshot,
      loadChat,
      mergeChatWithPendingOptimisticMessages,
      refreshPendingApprovalsForThread,
    ]
  );

  const closeAgentDetail = useCallback(() => {
    agentDetailRequestRef.current += 1;
    setAgentDetailThreadId(null);
    setAgentDetailChat(null);
    setAgentDetailParentChat(null);
    setAgentDetailLoading(false);
    setAgentDetailError(null);
  }, []);

  const loadAgentDetail = useCallback(
    async (threadId: string, showLoading = false) => {
      const requestId = agentDetailRequestRef.current + 1;
      agentDetailRequestRef.current = requestId;
      if (showLoading) {
        setAgentDetailLoading(true);
      }

      try {
        const { chat, parent } = await agentThreadsController.loadDetail(threadId);
        if (agentDetailRequestRef.current !== requestId) {
          return;
        }
        setAgentDetailChat((previous) =>
          previous?.id === chat.id ? resolveEquivalentChat(previous, chat) : chat
        );
        setAgentDetailParentChat(parent);
        setAgentDetailError(null);
      } catch (err) {
        if (agentDetailRequestRef.current === requestId) {
          setAgentDetailError((err as Error).message);
        }
      } finally {
        if (agentDetailRequestRef.current === requestId) {
          setAgentDetailLoading(false);
        }
      }
    },
    [agentThreadsController]
  );

  const openAgentDetail = useCallback(
    (threadId: string) => {
      if (!threadId || threadId === agentRootThreadId) {
        closeAgentDetail();
        return;
      }
      setAgentThreadMenuVisible(false);
      setAgentDetailThreadId(threadId);
      setAgentDetailChat(api.peekChat(threadId) ?? api.peekChatShell(threadId));
      setAgentDetailParentChat(null);
      setAgentDetailError(null);
      void loadAgentDetail(threadId, true);
    },
    [agentRootThreadId, api, closeAgentDetail, loadAgentDetail]
  );

  return {
    handleLoadEarlier,
    openChatThread,
    closeAgentDetail,
    loadAgentDetail,
    openAgentDetail,
  };
}

export type MainScreenChatNavigationAndAgentDetailResult = ReturnType<typeof useMainScreenChatNavigationAndAgentDetail>;
