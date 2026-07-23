import { useEffect, useRef, useState } from 'react';
import { AppState, Dimensions, Keyboard, type KeyboardEvent, Platform } from 'react-native';
import { findAgentDescriptor, getAgentLabel, selectAgentId } from '../agents';
import type { BridgeUiSurface, Chat } from '../api/types';
import { type ActivePlanState, type ThreadRuntimeSnapshot, type PendingOptimisticUserMessage, type PendingOptimisticQueuedMessage, type ChatModelPreference, SLASH_COMMANDS, normalizeWorkspacePath, toApprovalPolicyForMode, isSlashCommandAvailable } from './mainScreenHelpers';
import { useAttachmentController } from './controllers/attachmentController';
import { mergeModelOptions, modelOptionsFromAcpConfig } from './mainScreenChatState';
import type { MainScreenLifecycleRecoveryContext, MainScreenLifecycleRecoveryResult } from './mainScreenLifecycleRecovery';
import { EMPTY_MODEL_OPTIONS } from './mainScreenConstants';






export type MainScreenChatSessionStateContext = MainScreenLifecycleRecoveryContext & MainScreenLifecycleRecoveryResult;

export function useMainScreenChatSessionState(context: MainScreenChatSessionStateContext) {
  const {
    activeTurnId,
    agentRootThreadId,
    agentSettings,
    api,
    approvalMode,
    bridgeCapabilities,
    defaultStartCwd,
    draft,
    modelOptionsByAgent,
    pendingAgentId,
    preferredAgentId,
    replayRecoveryAbortControllerRef,
    replayRecoveryGenerationRef,
    replayRecoveryRetryTimerRef,
    selectedChat,
    selectedChatId,
    setAndroidKeyboardInset,
    setDraft,
    setError,
    setKeyboardVisible,
  } = context;


  useEffect(() => {
    return () => {
      replayRecoveryGenerationRef.current += 1;
      replayRecoveryAbortControllerRef.current?.abort();
      replayRecoveryAbortControllerRef.current = null;
      if (replayRecoveryRetryTimerRef.current) {
        clearTimeout(replayRecoveryRetryTimerRef.current);
        replayRecoveryRetryTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
      setKeyboardVisible(true);

      if (Platform.OS !== 'android') {
        return;
      }

      const keyboardTop = event.endCoordinates?.screenY;
      const keyboardHeight = event.endCoordinates?.height ?? 0;
      const screenHeight = Dimensions.get('screen').height;
      const overlap =
        typeof keyboardTop === 'number' && Number.isFinite(keyboardTop)
          ? Math.max(0, screenHeight - keyboardTop)
          : Math.max(0, keyboardHeight);
      setAndroidKeyboardInset(overlap);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setKeyboardVisible(false);
      setAndroidKeyboardInset(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Ref so the WS handler always reads the latest chat ID without
  // needing to re-subscribe on every change.
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = selectedChatId;
  const selectedChatRef = useRef<Chat | null>(selectedChat);
  selectedChatRef.current = selectedChat;
  const selectedChatIdRef = useRef<string | null>(selectedChatId);
  selectedChatIdRef.current = selectedChatId;
  const parentChatCacheRef = useRef<Record<string, Chat>>({});
  const agentRootThreadIdRef = useRef<string | null>(agentRootThreadId);
  agentRootThreadIdRef.current = agentRootThreadId;
  const planPanelLastTurnByThreadRef = useRef<Record<string, string>>({});
  const planItemTurnIdByThreadRef = useRef<Record<string, string>>({});
  const autoEnabledPlanTurnIdByThreadRef = useRef<Record<string, string>>({});
  const dismissedPlanImplementationTurnIdByThreadRef = useRef<Record<string, string>>({});
  const activeTurnIdRef = useRef<string | null>(null);
  activeTurnIdRef.current = activeTurnId;
  const stopRequestedRef = useRef(false);
  const stopSystemMessageLoggedRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const lastAppForegroundedAtRef = useRef(
    AppState.currentState === 'active' ? Date.now() : 0
  );
  const deferredDisconnectActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  // Track whether a command arrived since the last delta — used to
  // know when a new thinking segment starts so we can replace the old one.
  const hadCommandRef = useRef(false);
  const reasoningSummaryRef = useRef<Record<string, string>>({});
  const reasoningBufferRef = useRef('');
  const liveReasoningBuffersRef = useRef<Record<string, string>>({});
  const liveReasoningMessageIdsRef = useRef<Record<string, string>>({});
  const runWatchdogUntilRef = useRef(0);
  const runWatchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [runWatchdogNow, setRunWatchdogNow] = useState(() => Date.now());
  const externalStatusFullSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const externalStatusFullSyncInFlightRef = useRef(false);
  const externalStatusFullSyncQueuedThreadRef = useRef<string | null>(null);
  const externalStatusFullSyncNextAllowedAtRef = useRef(0);
  const threadRuntimeSnapshotsRef = useRef<Record<string, ThreadRuntimeSnapshot>>({});
  const threadReasoningBuffersRef = useRef<Record<string, string>>({});
  const pendingOptimisticUserMessagesRef = useRef<
    Record<string, PendingOptimisticUserMessage[]>
  >({});
  const pendingOptimisticQueuedMessagesRef = useRef<
    Record<string, PendingOptimisticQueuedMessage[]>
  >({});
  const chatModelPreferencesRef = useRef<Record<string, ChatModelPreference>>({});
  const [chatModelPreferencesLoaded, setChatModelPreferencesLoaded] = useState(false);
  const chatPlanSnapshotsRef = useRef<Record<string, ActivePlanState>>({});
  const bridgeUiSurfaceSnapshotsRef = useRef<Record<string, BridgeUiSurface[]>>({});
  const [, setChatPlanSnapshotsLoaded] = useState(false);
  const bridgeUiSurfacePersistenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const preferredStartCwd = normalizeWorkspacePath(defaultStartCwd);
  const readyAgents = bridgeCapabilities?.agents.filter((agent) => agent.lifecycle === 'ready') ?? [];
  const selectedNewAgentId = bridgeCapabilities
    ? selectAgentId(pendingAgentId ?? preferredAgentId, bridgeCapabilities)
    : pendingAgentId ?? preferredAgentId ?? null;
  const activeAgentId = selectedChat?.agentId ?? selectedNewAgentId;
  const activeAgent = findAgentDescriptor(bridgeCapabilities?.agents ?? [], activeAgentId);
  const activeAgentLabel = getAgentLabel(bridgeCapabilities?.agents ?? [], activeAgentId);
  const activeAgentSupports = activeAgentId
    ? bridgeCapabilities?.supportsByAgent[activeAgentId] ?? null
    : null;
  const supportsFastMode = activeAgentSupports?.fastMode === true;
  const supportsReview = activeAgentSupports?.reviewStart === true;
  const supportsGoal = activeAgentSupports?.goalSlash === true;
  const supportsPlanMode = activeAgentSupports?.planMode === true;
  const slashCommandAvailability = {
    hasOpenChat: Boolean(selectedChatId),
    supportsGoal,
    supportsPlanMode,
    supportsReview,
  };
  const activeSlashCommands = SLASH_COMMANDS.filter((command) =>
    isSlashCommandAvailable(command, slashCommandAvailability)
  );
  const activeAcpConfig = selectedChat?.acpConfig ?? [];
  const modelConfig = activeAcpConfig.find((option) => option.category === 'model') ?? null;
  const effortConfig = activeAcpConfig.find((option) => option.category === 'thought_level') ?? null;
  const modeConfig = activeAcpConfig.find((option) => option.category === 'mode') ?? null;
  const snapshotModelOptions = modelOptionsFromAcpConfig(activeAcpConfig);
  const catalogModelOptions = activeAgentId
    ? modelOptionsByAgent[activeAgentId] ?? EMPTY_MODEL_OPTIONS
    : EMPTY_MODEL_OPTIONS;
  const modelOptions = snapshotModelOptions.length > 0
    ? mergeModelOptions(catalogModelOptions, snapshotModelOptions)
    : catalogModelOptions;
  const pendingAgentDefaults = selectedNewAgentId
    ? agentSettings?.[selectedNewAgentId] ?? null
    : null;
  const preferredDefaultModelId = null;
  const preferredDefaultEffort = null;
  const preferredServiceTier = undefined;
  const preferredCollaborationMode =
    pendingAgentDefaults?.collaborationMode === 'plan'
      ? pendingAgentDefaults.collaborationMode
      : 'default';
  const activeApprovalPolicy = toApprovalPolicyForMode(approvalMode);
  const attachmentWorkspace = selectedChat?.cwd ?? preferredStartCwd ?? null;
  const attachmentController = useAttachmentController({
    api,
    chat: selectedChat,
    workspace: attachmentWorkspace,
    draft,
    setDraft,
    setError,
  });
  const {
    attachmentModalVisible,
    attachmentMenuVisible,
    attachmentPathDraft,
    setAttachmentPathDraft,
    pendingMentionPaths,
    pendingLocalImagePaths,
    loadingFileCandidates: loadingAttachmentFileCandidates,
    pickerBusy: attachmentPickerBusy,
    uploading: uploadingAttachment,
    hasFailedUploads: hasFailedAttachmentUploads,
    composerAttachments,
    pathSuggestions: attachmentPathSuggestions,
    openMenu: openAttachmentMenu,
    closePathModal: closeAttachmentModal,
    submitPath: submitAttachmentPath,
    selectPathSuggestion: selectAttachmentSuggestion,
    selectMentionSuggestion,
    removeComposerAttachment,
    removeMentionPath: removePendingMentionPath,
    retryFailedUploads,
  } = attachmentController;

  return {
    chatIdRef,
    selectedChatRef,
    selectedChatIdRef,
    parentChatCacheRef,
    agentRootThreadIdRef,
    planPanelLastTurnByThreadRef,
    planItemTurnIdByThreadRef,
    autoEnabledPlanTurnIdByThreadRef,
    dismissedPlanImplementationTurnIdByThreadRef,
    activeTurnIdRef,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    appStateRef,
    lastAppForegroundedAtRef,
    deferredDisconnectActivityTimeoutRef,
    hadCommandRef,
    reasoningSummaryRef,
    reasoningBufferRef,
    liveReasoningBuffersRef,
    liveReasoningMessageIdsRef,
    runWatchdogUntilRef,
    runWatchdogTimerRef,
    runWatchdogNow,
    setRunWatchdogNow,
    externalStatusFullSyncTimerRef,
    externalStatusFullSyncInFlightRef,
    externalStatusFullSyncQueuedThreadRef,
    externalStatusFullSyncNextAllowedAtRef,
    threadRuntimeSnapshotsRef,
    threadReasoningBuffersRef,
    pendingOptimisticUserMessagesRef,
    pendingOptimisticQueuedMessagesRef,
    chatModelPreferencesRef,
    chatModelPreferencesLoaded,
    setChatModelPreferencesLoaded,
    chatPlanSnapshotsRef,
    bridgeUiSurfaceSnapshotsRef,
    setChatPlanSnapshotsLoaded,
    bridgeUiSurfacePersistenceTimeoutRef,
    preferredStartCwd,
    readyAgents,
    selectedNewAgentId,
    activeAgentId,
    activeAgent,
    activeAgentLabel,
    activeAgentSupports,
    supportsFastMode,
    supportsReview,
    supportsGoal,
    supportsPlanMode,
    slashCommandAvailability,
    activeSlashCommands,
    activeAcpConfig,
    modelConfig,
    effortConfig,
    modeConfig,
    snapshotModelOptions,
    catalogModelOptions,
    modelOptions,
    pendingAgentDefaults,
    preferredDefaultModelId,
    preferredDefaultEffort,
    preferredServiceTier,
    preferredCollaborationMode,
    activeApprovalPolicy,
    attachmentWorkspace,
    attachmentController,
    attachmentModalVisible,
    attachmentMenuVisible,
    attachmentPathDraft,
    setAttachmentPathDraft,
    pendingMentionPaths,
    pendingLocalImagePaths,
    loadingAttachmentFileCandidates,
    attachmentPickerBusy,
    uploadingAttachment,
    hasFailedAttachmentUploads,
    composerAttachments,
    attachmentPathSuggestions,
    openAttachmentMenu,
    closeAttachmentModal,
    submitAttachmentPath,
    selectAttachmentSuggestion,
    selectMentionSuggestion,
    removeComposerAttachment,
    removePendingMentionPath,
    retryFailedUploads,
  };
}

export type MainScreenChatSessionStateResult = ReturnType<typeof useMainScreenChatSessionState>;
