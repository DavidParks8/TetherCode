import { useCallback, useEffect } from 'react';
import { PLAN_IMPLEMENTATION_CODING_MESSAGE, shouldAutoEnablePlanModeFromChat } from './mainScreenHelpers';
import type { MainScreenComposerRendererContext, MainScreenComposerRendererResult } from './mainScreenComposerRenderer';






export type MainScreenPlanExecutionActionsContext = MainScreenComposerRendererContext & MainScreenComposerRendererResult;

export function useMainScreenPlanExecutionActions(context: MainScreenPlanExecutionActionsContext) {
  const {
    autoEnabledPlanTurnIdByThreadRef,
    clearPendingPlanImplementationPrompt,
    dismissedPlanImplementationTurnIdByThreadRef,
    isOpeningChat,
    pendingPlanImplementationPrompts,
    planPanelLastTurnByThreadRef,
    scrollToBottomIfPinned,
    selectedChat,
    selectedChatId,
    selectedCollaborationMode,
    selectedPlanImplementationPrompt,
    selectedThreadPlan,
    sendMessageContent,
    setPendingPlanImplementationPrompts,
    setPlanPanelCollapsedByThread,
    setSelectedCollaborationMode,
    showActivity,
  } = context;


  useEffect(() => {
    if (!selectedChat || isOpeningChat || !shouldAutoEnablePlanModeFromChat(selectedChat)) {
      return;
    }

    const latestPlanTurnId = selectedChat.latestTurnPlan?.turnId?.trim();
    if (!latestPlanTurnId) {
      return;
    }

    if (
      dismissedPlanImplementationTurnIdByThreadRef.current[selectedChat.id] ===
      latestPlanTurnId
    ) {
      return;
    }

    if (autoEnabledPlanTurnIdByThreadRef.current[selectedChat.id] === latestPlanTurnId) {
      return;
    }

    autoEnabledPlanTurnIdByThreadRef.current[selectedChat.id] = latestPlanTurnId;
    setSelectedCollaborationMode('plan');
  }, [
    isOpeningChat,
    selectedChat?.id,
    selectedChat?.latestTurnPlan?.turnId,
    selectedChat?.latestTurnStatus,
  ]);

  useEffect(() => {
    const threadId = selectedChat?.id;
    if (
      !threadId ||
      isOpeningChat ||
      selectedChat?.latestTurnPlan ||
      selectedCollaborationMode !== 'plan'
    ) {
      return;
    }

    if (!autoEnabledPlanTurnIdByThreadRef.current[threadId]) {
      return;
    }

    setSelectedCollaborationMode('default');
  }, [
    isOpeningChat,
    selectedChat?.id,
    selectedChat?.latestTurnPlan?.turnId,
    selectedCollaborationMode,
  ]);

  useEffect(() => {
    const threadId = selectedChat?.id;
    if (!threadId) {
      return;
    }

    const pendingPrompt = pendingPlanImplementationPrompts[threadId];
    if (!pendingPrompt) {
      return;
    }

    const latestTurnPlanTurnId = selectedChat?.latestTurnPlan?.turnId ?? null;
    if (latestTurnPlanTurnId && latestTurnPlanTurnId === pendingPrompt.turnId) {
      return;
    }

    clearPendingPlanImplementationPrompt(threadId);
  }, [
    clearPendingPlanImplementationPrompt,
    pendingPlanImplementationPrompts,
    selectedChat?.id,
    selectedChat?.latestTurnPlan?.turnId,
  ]);

  const stayInPlanMode = useCallback(() => {
    if (!selectedChatId) {
      return;
    }

    const prompt = selectedPlanImplementationPrompt;
    if (prompt) {
      dismissedPlanImplementationTurnIdByThreadRef.current[prompt.threadId] = prompt.turnId;
    }
    setSelectedCollaborationMode('plan');
    clearPendingPlanImplementationPrompt(selectedChatId);
  }, [
    clearPendingPlanImplementationPrompt,
    selectedChatId,
    selectedPlanImplementationPrompt,
  ]);

  const implementPlan = useCallback(async () => {
    if (!selectedChatId) {
      return;
    }

    const prompt = selectedPlanImplementationPrompt;
    if (!prompt) {
      return;
    }

    clearPendingPlanImplementationPrompt(prompt.threadId);
    setSelectedCollaborationMode('default');
    const sent = await sendMessageContent(PLAN_IMPLEMENTATION_CODING_MESSAGE, {
      collaborationMode: 'default',
      clearComposer: false,
      preservePlan: true,
      suppressPlanModeAutoEnable: true,
    });
    if (sent) {
      dismissedPlanImplementationTurnIdByThreadRef.current[prompt.threadId] = prompt.turnId;
    } else {
      setPendingPlanImplementationPrompts((prev) => ({
        ...prev,
        [prompt.threadId]: prompt,
      }));
    }
  }, [
    clearPendingPlanImplementationPrompt,
    pendingPlanImplementationPrompts,
    selectedChatId,
    selectedPlanImplementationPrompt,
    sendMessageContent,
  ]);

  useEffect(() => {
    if (!selectedChat || isOpeningChat || !showActivity) {
      return;
    }
    scrollToBottomIfPinned(false);
  }, [isOpeningChat, scrollToBottomIfPinned, selectedChat, showActivity]);

  useEffect(() => {
    const threadId = selectedChat?.id;
    const turnId = selectedThreadPlan?.turnId;
    if (!threadId || !turnId) {
      return;
    }

    const previousTurnId = planPanelLastTurnByThreadRef.current[threadId];
    if (previousTurnId === turnId) {
      return;
    }

    planPanelLastTurnByThreadRef.current[threadId] = turnId;
    setPlanPanelCollapsedByThread((prev) => {
      if (prev[threadId] === false) {
        return prev;
      }
      return {
        ...prev,
        [threadId]: false,
      };
    });
  }, [selectedChat?.id, selectedThreadPlan?.turnId]);

  return {
    stayInPlanMode,
    implementPlan,
  };
}

export type MainScreenPlanExecutionActionsResult = ReturnType<typeof useMainScreenPlanExecutionActions>;
