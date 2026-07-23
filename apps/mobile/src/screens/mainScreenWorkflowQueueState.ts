import { Platform } from 'react-native';
import { useAccessibilityAnnouncement } from '../accessibility';
import { buildAgentThreadDisplayState } from './agentThreadDisplay';
import { hasStructuredPlanCardContent, resolveWorkflowCardMode } from './planCardState';
import { canOfferQueuedMessageSteer, isBridgeConnectionErrorMessage, resolveDisplayedThreadPlan, toPersistedActivePlanState, resolveUndismissedPlanImplementationPrompt, resolvePersistedPlanImplementationPrompt, formatAgentThreadOptionTitle } from './mainScreenHelpers';
import type { MainScreenHeaderActivityViewModelContext, MainScreenHeaderActivityViewModelResult } from './mainScreenHeaderActivityViewModel';






export type MainScreenWorkflowQueueStateContext = MainScreenHeaderActivityViewModelContext & MainScreenHeaderActivityViewModelResult;

export function useMainScreenWorkflowQueueState(context: MainScreenWorkflowQueueStateContext) {
  const {
    activeAgentSupports,
    activeBridgeUiSurfaces,
    activePlan,
    agentDetailThreadId,
    agentRootThreadId,
    agentThreadRows,
    androidKeyboardInset,
    api,
    attachmentMenuVisible,
    attachmentModalVisible,
    chatPlanSnapshotsRef,
    collaborationModeMenuVisible,
    composerHeight,
    creating,
    dismissedPlanImplementationTurnIdByThreadRef,
    draft,
    effortModalVisible,
    error,
    gitCheckoutError,
    isOpeningChat,
    keyboardVisible,
    modelModalVisible,
    pendingApproval,
    pendingOptimisticQueuedMessagesRef,
    pendingPlanImplementationPrompts,
    pendingUserInputRequest,
    planPanelCollapsedByThread,
    queueActionItemId,
    queueActionKind,
    relatedAgentThreads,
    runWatchdogNow,
    safeAreaInsets,
    selectedChat,
    selectedChatId,
    selectedCollaborationMode,
    sending,
    shouldShowComposer,
    showBridgeRecoveryBanner,
    slashSuggestions,
    stoppingTurn,
    theme,
    threadRuntimeSnapshotsRef,
    userInputError,
    workspaceModalVisible,
    ws,
  } = context;

  const agentDetailSummary = agentDetailThreadId
    ? relatedAgentThreads.find((chat) => chat.id === agentDetailThreadId) ??
      api.peekChatSummary(agentDetailThreadId)
    : null;
  const agentDetailRuntime = agentDetailThreadId
    ? threadRuntimeSnapshotsRef.current[agentDetailThreadId] ?? null
    : null;
  const agentDetailDisplay = agentDetailSummary
    ? buildAgentThreadDisplayState(agentDetailSummary, agentDetailRuntime, runWatchdogNow)
    : null;
  const agentDetailTitle = agentDetailSummary
    ? formatAgentThreadOptionTitle(
        agentDetailSummary,
        agentRootThreadId,
        agentThreadRows.find((row) => row.chat.id === agentDetailSummary.id)?.ordinal ?? null
      )
    : 'Sub-agent';
  const selectedThreadRuntimeSnapshot = selectedChat
    ? threadRuntimeSnapshotsRef.current[selectedChat.id] ?? null
    : null;
  const selectedBridgeUiSurfaces = selectedChat
    ? activeBridgeUiSurfaces.filter((surface) => surface.threadId === selectedChat.id)
    : [];
  const workflowBridgeUiSurfaces = selectedBridgeUiSurfaces.filter(
    (surface) => surface.presentation === 'workflowCard'
  );
  const bannerBridgeUiSurfaces = selectedBridgeUiSurfaces.filter(
    (surface) => surface.presentation === 'banner'
  );
  const modalBridgeUiSurface =
    selectedBridgeUiSurfaces.find((surface) => surface.presentation === 'modal') ?? null;
  const selectedBridgeQueuedMessages = selectedThreadRuntimeSnapshot?.queuedMessages ?? [];
  const selectedOptimisticQueuedMessages = selectedChat
    ? pendingOptimisticQueuedMessagesRef.current[selectedChat.id] ?? []
    : [];
  const showingOptimisticQueuedMessage =
    selectedBridgeQueuedMessages.length === 0 &&
    selectedOptimisticQueuedMessages.length > 0;
  const selectedQueuedMessages = showingOptimisticQueuedMessage
    ? selectedOptimisticQueuedMessages
    : selectedBridgeQueuedMessages;
  const selectedQueueError = selectedThreadRuntimeSnapshot?.queuedMessageError ?? null;
  const oldestQueuedMessage = selectedQueuedMessages[0] ?? null;
  const oldestQueuedMessageIsPendingSteer = Boolean(
    oldestQueuedMessage &&
      selectedThreadRuntimeSnapshot?.pendingSteerMessageIds?.includes(oldestQueuedMessage.id)
  );
  const remainingQueuedMessagesCount = Math.max(0, selectedQueuedMessages.length - 1);
  const queueActionInFlight = Boolean(queueActionItemId);
  const inMemorySelectedThreadPlan = selectedChat
    ? activePlan?.threadId === selectedChat.id
      ? activePlan
      : selectedThreadRuntimeSnapshot?.plan ??
        chatPlanSnapshotsRef.current[selectedChat.id] ??
        null
    : null;
  const persistedSelectedThreadPlan = selectedChat
    ? toPersistedActivePlanState(selectedChat.latestPlan, selectedChat.updatedAt)
    : null;
  const selectedThreadPlan = selectedChat
    ? resolveDisplayedThreadPlan(
        inMemorySelectedThreadPlan,
        persistedSelectedThreadPlan,
        selectedThreadRuntimeSnapshot
      )
    : null;
  const dismissedSelectedPlanTurnId = selectedChat
    ? dismissedPlanImplementationTurnIdByThreadRef.current[selectedChat.id] ?? null
    : null;
  const derivedSelectedPlanImplementationPrompt = selectedChat
    ? resolvePersistedPlanImplementationPrompt(
        selectedChat,
        dismissedSelectedPlanTurnId
      )
    : null;
  const selectedPlanImplementationPrompt = selectedChat
    ? resolveUndismissedPlanImplementationPrompt(
        pendingPlanImplementationPrompts[selectedChat.id] ?? null,
        dismissedSelectedPlanTurnId
      ) ??
      derivedSelectedPlanImplementationPrompt
    : null;
  const showStructuredPlanCard = hasStructuredPlanCardContent(selectedThreadPlan);
  const planPanelCollapsed =
    selectedChat ? (planPanelCollapsedByThread[selectedChat.id] ?? false) : false;
  const fastModeControlDisabled = isOpeningChat;
  const showSlashSuggestions = slashSuggestions.length > 0 && draft.trimStart().startsWith('/');
  const canSteerQueuedMessage = canOfferQueuedMessageSteer({
    hasQueuedMessage: Boolean(oldestQueuedMessage),
    hasSelectedThread: Boolean(selectedChatId),
    supportsSteer: activeAgentSupports?.turnSteer === true,
    isPendingSteer: oldestQueuedMessageIsPendingSteer,
    isOptimistic: showingOptimisticQueuedMessage,
    actionInFlight: queueActionInFlight,
  });
  const canCancelQueuedMessage =
    Boolean(oldestQueuedMessage) &&
    !showingOptimisticQueuedMessage &&
    !queueActionInFlight &&
    selectedThreadRuntimeSnapshot?.steeringInFlight !== true;
  const queuedMessageSteerDisabledReason = showingOptimisticQueuedMessage
    ? 'Sending the queued message to the bridge.'
    : selectedQueueError?.message
    ? selectedQueueError.message
    : queueActionKind === 'steer'
      ? 'Sending the queued message to the current turn.'
      : queueActionKind === 'cancel'
        ? 'Removing the queued message.'
      : activeAgentSupports?.turnSteer !== true
        ? 'The active agent does not support steering.'
      : null;
  const showQueuedMessageDock =
    Boolean(selectedChat) && !isOpeningChat && Boolean(oldestQueuedMessage);
  const showPlanImplementationPrompt =
    Boolean(selectedPlanImplementationPrompt) &&
    !isOpeningChat &&
    !sending &&
    !creating &&
    !stoppingTurn &&
    !pendingApproval &&
    !pendingUserInputRequest &&
    !attachmentMenuVisible &&
    !attachmentModalVisible &&
    !collaborationModeMenuVisible &&
    !workspaceModalVisible &&
    !modelModalVisible &&
    !effortModalVisible &&
    selectedQueuedMessages.length === 0;
  const workflowCardMode = resolveWorkflowCardMode({
    collaborationMode: selectedCollaborationMode,
    hasStructuredPlan: showStructuredPlanCard,
    hasPlanApprovalPrompt: showPlanImplementationPrompt,
  });
  const showTopCardsRow =
    !isOpeningChat && (workflowCardMode !== null || workflowBridgeUiSurfaces.length > 0);
  const showFloatingActivity =
    shouldShowComposer &&
    Boolean(selectedChat) &&
    !isOpeningChat &&
    !showBridgeRecoveryBanner;
  const chatBottomInset = shouldShowComposer
    ? theme.spacing.lg
    : Math.max(theme.spacing.xxl, safeAreaInsets.bottom + theme.spacing.lg);
  const composerSafeAreaBottomInset = safeAreaInsets.bottom;
  const composerOverlayInset =
    Platform.OS === 'android' && keyboardVisible ? androidKeyboardInset : 0;
  const visibleError =
    !ws.isConnected && isBridgeConnectionErrorMessage(error) ? null : error;
  useAccessibilityAnnouncement(visibleError ?? userInputError ?? gitCheckoutError);
  const androidComposerReservedInset = shouldShowComposer
    ? Math.max(
        theme.spacing.lg,
        composerHeight +
          composerOverlayInset +
          theme.spacing.sm
      )
    : chatBottomInset;

  return {
    agentDetailSummary,
    agentDetailRuntime,
    agentDetailDisplay,
    agentDetailTitle,
    selectedThreadRuntimeSnapshot,
    selectedBridgeUiSurfaces,
    workflowBridgeUiSurfaces,
    bannerBridgeUiSurfaces,
    modalBridgeUiSurface,
    selectedBridgeQueuedMessages,
    selectedOptimisticQueuedMessages,
    showingOptimisticQueuedMessage,
    selectedQueuedMessages,
    selectedQueueError,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    remainingQueuedMessagesCount,
    queueActionInFlight,
    inMemorySelectedThreadPlan,
    persistedSelectedThreadPlan,
    selectedThreadPlan,
    dismissedSelectedPlanTurnId,
    derivedSelectedPlanImplementationPrompt,
    selectedPlanImplementationPrompt,
    showStructuredPlanCard,
    planPanelCollapsed,
    fastModeControlDisabled,
    showSlashSuggestions,
    canSteerQueuedMessage,
    canCancelQueuedMessage,
    queuedMessageSteerDisabledReason,
    showQueuedMessageDock,
    showPlanImplementationPrompt,
    workflowCardMode,
    showTopCardsRow,
    showFloatingActivity,
    chatBottomInset,
    composerSafeAreaBottomInset,
    composerOverlayInset,
    visibleError,
    androidComposerReservedInset,
  };
}

export type MainScreenWorkflowQueueStateResult = ReturnType<typeof useMainScreenWorkflowQueueState>;
