import { useCallback, useEffect } from 'react';
import { shouldCollapseWorkflowCardForKeyboard } from './planCardState';
import type { MainScreenPlanExecutionActionsContext, MainScreenPlanExecutionActionsResult } from './mainScreenPlanExecutionActions';






export type MainScreenPanelCollapseCoordinatorContext = MainScreenPlanExecutionActionsContext & MainScreenPlanExecutionActionsResult;

export function useMainScreenPanelCollapseCoordinator(context: MainScreenPanelCollapseCoordinatorContext) {
  const {
    keyboardVisible,
    planPanelCollapsed,
    selectedChat,
    setAgentPanelCollapsed,
    setPlanPanelCollapsedByThread,
    showLiveAgentPanel,
    workflowCardMode,
  } = context;


  useEffect(() => {
    const threadId = selectedChat?.id;
    if (
      !threadId ||
      !shouldCollapseWorkflowCardForKeyboard({
        collapsed: planPanelCollapsed,
        keyboardVisible,
        mode: workflowCardMode,
        threadId,
      })
    ) {
      return;
    }

    setPlanPanelCollapsedByThread((prev) => {
      if (prev[threadId] === true) {
        return prev;
      }
      return {
        ...prev,
        [threadId]: true,
      };
    });
  }, [keyboardVisible, planPanelCollapsed, selectedChat?.id, workflowCardMode]);

  useEffect(() => {
    if (!showLiveAgentPanel) {
      setAgentPanelCollapsed(false);
    }
  }, [showLiveAgentPanel]);

  useEffect(() => {
    setAgentPanelCollapsed(false);
  }, [selectedChat?.id]);

  const toggleSelectedPlanPanel = useCallback(() => {
    if (!selectedChat?.id || workflowCardMode === null) {
      return;
    }

    setPlanPanelCollapsedByThread((prev) => ({
      ...prev,
      [selectedChat.id]: !(prev[selectedChat.id] ?? false),
    }));
  }, [selectedChat?.id, workflowCardMode]);

  return {
    toggleSelectedPlanPanel,
  };
}

export type MainScreenPanelCollapseCoordinatorResult = ReturnType<typeof useMainScreenPanelCollapseCoordinator>;
