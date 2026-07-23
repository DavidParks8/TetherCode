import { useEffect, useMemo, useRef } from 'react';
import type { Chat } from '../api/types';
import { type ActivityState, GENERIC_RUNNING_ACTIVITY_DELAY_MS, GENERIC_RUNNING_ACTIVITY_TITLES, normalizeCloneDirectoryName, joinWorkspacePath, isBridgeRecoveryActivity } from './mainScreenHelpers';
import { areChatStatusMapsEquivalent } from './mainScreenChatState';
import type { MainScreenUiActionHandlersContext, MainScreenUiActionHandlersResult } from './mainScreenUiActionHandlers';






export type MainScreenHeaderActivityViewModelContext = MainScreenUiActionHandlersContext & MainScreenUiActionHandlersResult;

export function useMainScreenHeaderActivityViewModel(context: MainScreenHeaderActivityViewModelContext) {
  const {
    activeTurnId,
    activity,
    clearGenericRunningActivityDelay,
    genericRunningActivityTimeoutRef,
    gitCheckoutDirectoryName,
    gitCheckoutParentPath,
    heldActivity,
    isLoading,
    isOpeningChat,
    isTurnLikelyRunning,
    isTurnLoading,
    liveAgentRows,
    pendingApproval,
    pendingUserInputRequest,
    preferredStartCwd,
    relatedAgentThreads,
    selectedChat,
    selectorAgentCount,
    setShowDelayedGenericRunningActivity,
    showBridgeRecoveryBanner,
    showDelayedGenericRunningActivity,
    turnFailureDetail,
    workspaceBridgeRoot,
    ws,
  } = context;

  const visibleActivity = (() => {
    if (isOpeningChat) {
      return {
        tone: 'running',
        title: 'Opening chat',
      } satisfies ActivityState;
    }

    if (pendingApproval) {
      return {
        tone: 'idle',
        title: 'Waiting for approval',
        detail: pendingApproval.command ?? pendingApproval.kind,
      } satisfies ActivityState;
    }

    if (pendingUserInputRequest) {
      return {
        tone: 'idle',
        title: 'Waiting for input',
      } satisfies ActivityState;
    }

    if (activity.tone === 'error' && activity.title !== 'Turn failed') {
      return activity;
    }

    if (heldActivity && !isLoading && !isTurnLikelyRunning) {
      return heldActivity;
    }

    if (
      isLoading ||
      isTurnLikelyRunning ||
      (activity.tone === 'running' && selectedChat?.status !== 'complete')
    ) {
      const runningTitle = activity.title.trim() || 'Working';
      return {
        tone: 'running',
        title: runningTitle,
        detail: activity.detail,
      } satisfies ActivityState;
    }

    if (!isLoading && !isTurnLikelyRunning && selectedChat?.status === 'complete') {
      return {
        tone: 'complete',
        title: 'Turn completed',
      } satisfies ActivityState;
    }

    if (activity.tone === 'error' && activity.title === 'Turn failed') {
      return {
        tone: 'error',
        title: 'Turn failed',
        detail: turnFailureDetail ?? undefined,
      } satisfies ActivityState;
    }

    return activity;
  })();
  const displayedActivity = (() => {
    if (!ws.isConnected && isBridgeRecoveryActivity(visibleActivity)) {
      if (!showBridgeRecoveryBanner) {
        return {
          tone: 'idle',
          title: 'Ready',
        } satisfies ActivityState;
      }

      return {
        tone: 'error',
        title: 'Bridge disconnected',
        detail: 'Start the bridge on your computer to continue.',
      } satisfies ActivityState;
    }

    return visibleActivity;
  })();
  const isGenericRunningActivity =
    displayedActivity.tone === 'running' &&
    !displayedActivity.detail &&
    GENERIC_RUNNING_ACTIVITY_TITLES.has(displayedActivity.title.trim().toLowerCase());
  const shouldShowGenericRunningActivityImmediately =
    isGenericRunningActivity && (isTurnLoading || Boolean(activeTurnId));

  useEffect(() => {
    if (!isGenericRunningActivity) {
      clearGenericRunningActivityDelay();
      return;
    }

    if (shouldShowGenericRunningActivityImmediately) {
      if (genericRunningActivityTimeoutRef.current) {
        clearTimeout(genericRunningActivityTimeoutRef.current);
        genericRunningActivityTimeoutRef.current = null;
      }
      if (!showDelayedGenericRunningActivity) {
        setShowDelayedGenericRunningActivity(true);
      }
      return;
    }

    if (showDelayedGenericRunningActivity || genericRunningActivityTimeoutRef.current) {
      return;
    }

    genericRunningActivityTimeoutRef.current = setTimeout(() => {
      genericRunningActivityTimeoutRef.current = null;
      setShowDelayedGenericRunningActivity(true);
    }, GENERIC_RUNNING_ACTIVITY_DELAY_MS);

    return () => {
      if (genericRunningActivityTimeoutRef.current) {
        clearTimeout(genericRunningActivityTimeoutRef.current);
        genericRunningActivityTimeoutRef.current = null;
      }
    };
  }, [
    clearGenericRunningActivityDelay,
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately,
    showDelayedGenericRunningActivity,
    isTurnLoading,
    activeTurnId,
  ]);

  const activityDetail = displayedActivity.detail;
  const showActivity =
    (isLoading && !isGenericRunningActivity) ||
    isOpeningChat ||
    (displayedActivity.tone !== 'idle' &&
      (!isGenericRunningActivity || showDelayedGenericRunningActivity)) ||
    Boolean(activityDetail);
  const headerTitle = isOpeningChat ? 'Opening chat' : selectedChat?.title?.trim() || 'New chat';
  const defaultStartWorkspaceLabel =
    preferredStartCwd ?? 'Select project';
  const gitCheckoutDestinationLabel =
    gitCheckoutParentPath ?? workspaceBridgeRoot ?? 'Bridge default workspace';
  const gitCheckoutTargetPath =
    gitCheckoutParentPath && normalizeCloneDirectoryName(gitCheckoutDirectoryName)
      ? joinWorkspacePath(
          gitCheckoutParentPath,
          normalizeCloneDirectoryName(gitCheckoutDirectoryName) ?? ''
        )
      : null;
  const spawnedAgentCount = selectorAgentCount;
  const selectedChatIsSubAgent = Boolean(selectedChat?.parentThreadId);
  const showAgentThreadChip =
    !isOpeningChat &&
    Boolean(selectedChat) &&
    (spawnedAgentCount > 0 || selectedChatIsSubAgent);
  const agentThreadChipLabel = selectedChatIsSubAgent
    ? spawnedAgentCount > 1
      ? `Sub-agent · ${String(spawnedAgentCount)} threads`
      : 'Sub-agent'
    : spawnedAgentCount === 1
      ? '1 agent'
      : `${String(spawnedAgentCount)} agents`;
  const showLiveAgentPanel =
    !isOpeningChat && Boolean(selectedChat) && liveAgentRows.length > 0;
  const agentThreadStatusByIdRef = useRef<ReadonlyMap<string, Chat['status']>>(new Map());
  const agentThreadStatusById = useMemo(() => {
    const nextMap = new Map(relatedAgentThreads.map((chat) => [chat.id, chat.status] as const));
    const previousMap = agentThreadStatusByIdRef.current;
    if (areChatStatusMapsEquivalent(previousMap, nextMap)) {
      return previousMap;
    }
    agentThreadStatusByIdRef.current = nextMap;
    return nextMap;
  }, [relatedAgentThreads]);

  return {
    visibleActivity,
    displayedActivity,
    isGenericRunningActivity,
    shouldShowGenericRunningActivityImmediately,
    activityDetail,
    showActivity,
    headerTitle,
    defaultStartWorkspaceLabel,
    gitCheckoutDestinationLabel,
    gitCheckoutTargetPath,
    spawnedAgentCount,
    selectedChatIsSubAgent,
    showAgentThreadChip,
    agentThreadChipLabel,
    showLiveAgentPanel,
    agentThreadStatusByIdRef,
    agentThreadStatusById,
  };
}

export type MainScreenHeaderActivityViewModelResult = ReturnType<typeof useMainScreenHeaderActivityViewModel>;
