import { Ionicons } from '@expo/vector-icons';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  ActivityIndicator,
  Dimensions,
  type FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type KeyboardEvent,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import { findAgentDescriptor, getAgentLabel, selectAgentId } from '../agents';
import type {
  AgentDefaultSettingsMap,
  AgentId,
  ApprovalMode,
  BridgeCapabilities,
  BridgeUiAction,
  BridgeUiSurface,
  BridgeQueuedMessage,
  BridgeThreadQueueState,
  CollaborationMode,
  AcpConfigOption,
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
  RunEvent,
  Chat,
  ChatSummary,
  ModelOption,
  MentionInput,
  LocalImageInput,
  ReasoningEffort,
  ServiceTier,
  ChatMessage as ChatTranscriptMessage,
  FileSystemEntry,
  FileSystemListResponse,
  WorkspaceSummary,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import {
  parseAgUiEventNotification,
  updateAgUiLiveAssistantMessages,
  type AgUiLiveAssistantMessages,
} from '../api/agUi';
import { getMessageText, getSubAgentMeta } from '../api/messages';
import { ActivityBar } from '../components/ActivityBar';
import { ApprovalBanner } from '../components/ApprovalBanner';
import {
  BridgeUiBanner,
  BridgeUiModal,
  BridgeUiWorkflowCard,
} from '../components/BridgeUiSurface';
import { ChatHeader } from '../components/ChatHeader';
import { ChatInput } from '../components/ChatInput';
import { BrandMark } from '../components/BrandMark';
import { SelectionSheet, type SelectionSheetOption } from '../components/SelectionSheet';
import { WorkspacePickerModal } from '../components/WorkspacePickerModal';
import { env } from '../config';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
} from '../accessibility';
import {
  formatModelOptionDescription,
  formatModelOptionLabel,
} from '../modelOptions';
import {
  describeAgentThreadSource,
  findMatchingAgentThread,
  resolveAgentActivitySummary,
} from './agentThreads';
import {
  buildAgentThreadDisplayState,
  type AgentThreadDisplayState,
} from './agentThreadDisplay';
import {
  hasStructuredPlanCardContent,
  resolveWorkflowCardMode,
  shouldCollapseWorkflowCardForKeyboard,
} from './planCardState';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { useAppTheme } from '../theme';
import { ChatTranscriptView } from './ChatTranscriptView';
import { SubAgentDetailView } from './SubAgentDetailView';
import { createStyles, createWorkflowMarkdownStyles } from './mainScreenStyles';
import {
  type ActivityState,
  type ActivePlanState,
  sleep,
  type IdleTaskHandle,
  scheduleIdleTask,
  type PendingPlanImplementationPrompt,
  type WorkspacePickerPurpose,
  type ThreadContextUsage,
  type ThreadRuntimeSnapshot,
  type PendingOptimisticUserMessage,
  type PendingOptimisticQueuedMessage,
  type AutoScrollState,
  RUN_WATCHDOG_MS,
  WORKSPACE_FAVORITES_LIMIT,
  ACTIVE_CHAT_SYNC_INTERVAL_MS,
  IDLE_CHAT_SYNC_INTERVAL_MS,
  AGENT_THREADS_SYNC_INTERVAL_MS,
  AGENT_THREADS_IDLE_SYNC_INTERVAL_MS,
  AGENT_THREADS_BACKGROUND_SYNC_INTERVAL_MS,
  APP_FOCUS_DISCONNECT_GRACE_MS,
  ACTIVITY_DETAIL_HOLD_MS,
  GENERIC_RUNNING_ACTIVITY_DELAY_MS,
  GENERIC_RUNNING_ACTIVITY_TITLES,
  STREAMING_SCROLL_THROTTLE_MS,
  PLAN_IMPLEMENTATION_TITLE,
  PLAN_IMPLEMENTATION_YES,
  PLAN_IMPLEMENTATION_NO,
  PLAN_IMPLEMENTATION_CODING_MESSAGE,
  EXTERNAL_RUNNING_STATUS_HINTS,
  EXTERNAL_ERROR_STATUS_HINTS,
  EXTERNAL_COMPLETE_STATUS_HINTS,
  type ChatModelPreference,
  type SelectedServiceTier,
  SLASH_COMMANDS,
  toRecord,
  readString,
  readNumber,
  readIntegerLike,
  mergeThreadContextUsage,
  buildNextPlanStateFromDelta,
  buildNextPlanStateFromUpdate,
  renderPlanStatusGlyph,
  toTurnPlanUpdate,
  toPendingUserInputRequest,
  buildUserInputDrafts,
  normalizeWorkspacePath,
  getWorkspaceBrowseCacheKey,
  normalizeCloneDirectoryName,
  deriveCloneDirectoryName,
  formatGitCloneFailureMessage,
  joinWorkspacePath,
  toMentionInput,
  toOptimisticUserContent,
  countUserMessages,
  normalizeChatMessageMatchContent,
  reconcileChatWithPendingOptimisticMessages,
  toPathBasename,
  parseMentionQuery,
  normalizeModelId,
  normalizeReasoningEffort,
  normalizeServiceTier,
  toSelectedServiceTier,
  resolveSelectedServiceTier,
  shouldSurfaceChatLoadError,
  toApprovalPolicyForMode,
  parseBridgeThreadQueueState,
  canOfferQueuedMessageSteer,
  queuedMessageStatusLabel,
  formatCollaborationModeLabel,
  isBridgeConnectionErrorMessage,
  isBridgeRecoveryActivity,
  resolveSnapshotCollaborationMode,
  resolveDisplayedThreadPlan,
  toPersistedActivePlanState,
  resolveUndismissedPlanImplementationPrompt,
  resolvePersistedPlanImplementationPrompt,
  formatReasoningEffort,
  shouldAutoEnablePlanModeFromChat,
  parseSlashCommand,
  parseSlashQuery,
  findSlashCommandDefinition,
  filterSlashCommands,
  isSlashCommandAvailable,
  formatAgentThreadOptionTitle,
  iconForAgentThread,
  stripMarkdownInline,
  mergeStreamingDelta,
  formatLiveReasoningMessage,
  describeStartedToolEvent,
  describeCompletedToolEvent,
  appendRunEventHistory,
  extractNotificationThreadId,
  extractNotificationParentThreadId,
  extractExternalStatusHint,
  isChatSummaryLikelyRunning,
  isChatLikelyRunning,
  hasRecentUnansweredUserTurn,
  extractFirstBoldSnippet,
  toReasoningActivityDetail,
  toPendingApproval,
  toBridgeUiSurface,
  parseGoalSlashObjective,
  buildOptimisticGoalBridgeUiSurface,
  upsertBridgeUiSurfaceList,
  removeBridgeUiSurfaceFromList
} from './mainScreenHelpers';
import {
  ATTACHMENT_MAX_LABEL,
  useAttachmentController,
} from './controllers/attachmentController';
import { ApprovalController, buildUserInputAnswers } from './controllers/approvalController';
import { AgentThreadsController } from './controllers/agentThreadsController';
import {
  ChatSyncController,
  type ChatSyncAssessment,
  useChatSynchronization,
} from './controllers/chatSyncController';
import { useDraftController } from './controllers/draftController';
import {
  SubmissionController,
  type ComposerSubmission,
} from './controllers/submissionController';
import { TurnExecutionController } from './controllers/turnExecutionController';
import { MainScreenPersistenceController } from './controllers/mainScreenPersistenceController';
import {
  fetchReplayRecoverySnapshot,
  ReplayRecoveryProtocolError,
  type ReplayRecoverySnapshot,
} from './controllers/replayRecoveryController';
import {
  TranscriptContinuationController,
  getTranscriptContinuationState,
  type TranscriptContinuationState,
} from './controllers/transcriptContinuationController';

export interface MainScreenHandle {
  openChat: (id: string, optimisticChat?: Chat | null) => void;
  startNewChat: () => void;
}

interface MainScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  bridgeUrl: string;
  bridgeToken?: string | null;
  bridgeProfileId: string;
  onOpenDrawer: () => void;
  onOpenGit: (chat: Chat) => void;
  onOpenLocalPreview?: (targetUrl: string) => void;
  onOpenBridgeRecoveryGuide?: () => void;
  defaultStartCwd?: string | null;
  preferredAgentId?: AgentId | null;
  agentSettings?: AgentDefaultSettingsMap | null;
  approvalMode?: ApprovalMode;
  showToolCalls?: boolean;
  onDefaultStartCwdChange?: (cwd: string | null) => void;
  onLastUsedThreadSettingsChange?: (
    agentId: AgentId,
    collaborationMode: CollaborationMode
  ) => void;
  onChatContextChange?: (chat: Chat | null) => void;
  onChatOpeningStateChange?: (chatId: string | null) => void;
  pendingOpenChatId?: string | null;
  pendingOpenChatSnapshot?: Chat | null;
  onPendingOpenChatHandled?: () => void;
}

const SUGGESTIONS = [
  'Explain the current codebase structure',
  'Write tests for the main module',
];
const OPEN_CHAT_MIN_LOADING_MS = 250;
const EMPTY_MODEL_OPTIONS: ModelOption[] = [];

export const MainScreen = forwardRef<MainScreenHandle, MainScreenProps>(
  function MainScreen(
    {
      api,
      ws,
      bridgeUrl,
      bridgeToken = null,
      bridgeProfileId,
      onOpenDrawer,
      onOpenGit,
      onOpenLocalPreview: onOpenLocalPreviewHandler,
      onOpenBridgeRecoveryGuide,
      defaultStartCwd,
      preferredAgentId,
      agentSettings,
      approvalMode,
      showToolCalls = true,
      onDefaultStartCwdChange,
      onLastUsedThreadSettingsChange,
      onChatContextChange,
      onChatOpeningStateChange,
      pendingOpenChatId,
      pendingOpenChatSnapshot,
      onPendingOpenChatHandled,
    },
    ref
  ) {
    const theme = useAppTheme();
    const { height: windowHeight } = useWindowDimensions();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const chatSyncController = useMemo(() => new ChatSyncController(api), [api]);
    const turnExecutionController = useMemo(() => new TurnExecutionController(api), [api]);
    const approvalController = useMemo(() => new ApprovalController(api), [api]);
    const agentThreadsController = useMemo(() => new AgentThreadsController(api), [api]);
    const persistenceController = useMemo(() => new MainScreenPersistenceController(), []);
    const submissionController = useMemo(() => new SubmissionController(), []);
    const transcriptContinuationController = useMemo(
      () => new TranscriptContinuationController(api),
      [api]
    );
    const initialPendingSnapshot =
      pendingOpenChatId &&
      pendingOpenChatSnapshot?.id === pendingOpenChatId &&
      pendingOpenChatSnapshot.messages.length > 0
        ? pendingOpenChatSnapshot
        : null;
    const [selectedChat, setSelectedChat] = useState<Chat | null>(
      initialPendingSnapshot
    );
    const [transcriptContinuationState, setTranscriptContinuationState] =
      useState<TranscriptContinuationState>(() =>
        initialPendingSnapshot
          ? getTranscriptContinuationState(initialPendingSnapshot)
          : { loading: false, error: null, exhausted: true, unavailableCount: 0 }
      );
    const [selectedParentChat, setSelectedParentChat] = useState<Chat | null>(null);
    const [selectedChatId, setSelectedChatId] = useState<string | null>(
      initialPendingSnapshot?.id ?? pendingOpenChatId ?? null
    );
    const [openingChatId, setOpeningChatId] = useState<string | null>(
      initialPendingSnapshot ? null : pendingOpenChatId ?? null
    );
    const openingChatStartedAtRef = useRef<number>(
      initialPendingSnapshot || !pendingOpenChatId ? 0 : Date.now()
    );
    const draftController = useDraftController(bridgeProfileId, selectedChatId);
    const { draft, setDraft } = draftController;
    const [sending, setSending] = useState(false);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [, setActiveCommands] = useState<RunEvent[]>([]);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingUserInputRequest, setPendingUserInputRequest] =
      useState<PendingUserInputRequest | null>(null);
    const [userInputDrafts, setUserInputDrafts] = useState<Record<string, string>>({});
    const [userInputError, setUserInputError] = useState<string | null>(null);
    const [resolvingUserInput, setResolvingUserInput] = useState(false);
    const [activePlan, setActivePlan] = useState<ActivePlanState | null>(null);
    const [activeBridgeUiSurfaces, setActiveBridgeUiSurfaces] = useState<BridgeUiSurface[]>([]);
    const [liveAssistantByThread, setLiveAssistantByThread] =
      useState<AgUiLiveAssistantMessages>({});
    const streamingTextRef = useRef<string | null>(null);
    const setStreamingText = useCallback(
      (
        next:
          | string
          | null
          | ((previous: string | null) => string | null)
      ) => {
        const resolved =
          typeof next === 'function'
            ? (
                next as (previous: string | null) => string | null
              )(streamingTextRef.current)
            : next;
        streamingTextRef.current = resolved;
      },
      []
    );
    const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
    const [stoppingTurn, setStoppingTurn] = useState(false);
    const [workspaceModalVisible, setWorkspaceModalVisible] = useState(false);
    const [workspacePickerPurpose, setWorkspacePickerPurpose] =
      useState<WorkspacePickerPurpose>('default-start');
    const [workspaceRoots, setWorkspaceRoots] = useState<WorkspaceSummary[]>([]);
    const [workspaceBridgeRoot, setWorkspaceBridgeRoot] = useState<string | null>(null);
    const [, setLoadingWorkspaceRoots] = useState(false);
    const [workspaceBrowsePath, setWorkspaceBrowsePath] = useState<string | null>(null);
    const [workspaceBrowseParentPath, setWorkspaceBrowseParentPath] = useState<string | null>(
      null
    );
    const [workspaceBrowseEntries, setWorkspaceBrowseEntries] = useState<FileSystemEntry[]>([]);
    const [loadingWorkspaceBrowse, setLoadingWorkspaceBrowse] = useState(false);
    const [workspaceBrowseError, setWorkspaceBrowseError] = useState<string | null>(null);
    const [workspaceBrowseTruncation, setWorkspaceBrowseTruncation] = useState<string | null>(null);
    const workspaceBrowseCacheRef = useRef<Record<string, FileSystemListResponse>>({});
    const workspaceBrowseRequestRef = useRef(0);
    const [favoriteWorkspacePaths, setFavoriteWorkspacePaths] = useState<string[]>([]);
    const [resumeGitCheckoutAfterWorkspacePicker, setResumeGitCheckoutAfterWorkspacePicker] =
      useState(false);
    const [gitCheckoutModalVisible, setGitCheckoutModalVisible] = useState(false);
    const [gitCheckoutRepoUrl, setGitCheckoutRepoUrl] = useState('');
    const [gitCheckoutParentPath, setGitCheckoutParentPath] = useState<string | null>(null);
    const [gitCheckoutDirectoryName, setGitCheckoutDirectoryName] = useState('');
    const [gitCheckoutDirectoryNameEdited, setGitCheckoutDirectoryNameEdited] =
      useState(false);
    const [gitCheckoutError, setGitCheckoutError] = useState<string | null>(null);
    const [gitCheckoutCloning, setGitCheckoutCloning] = useState(false);
    const [agentThreadMenuVisible, setAgentThreadMenuVisible] = useState(false);
    const [modelModalVisible, setModelModalVisible] = useState(false);
    const [agentModalVisible, setAgentModalVisible] = useState(false);
    const [titleModalVisible, setTitleModalVisible] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const [titleSaving, setTitleSaving] = useState(false);
    const [bridgeCapabilities, setBridgeCapabilities] = useState<BridgeCapabilities | null>(
      null
    );
    const [modelOptionsByAgent, setModelOptionsByAgent] = useState<
      Record<AgentId, ModelOption[]>
    >({});
    const [loadingModels, setLoadingModels] = useState(false);
    const [pendingAgentId, setPendingAgentId] = useState<AgentId | null>(
      () => preferredAgentId ?? null
    );
    const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
    const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
    const [selectedServiceTier, setSelectedServiceTier] = useState<SelectedServiceTier>();
    const [defaultServiceTier, setDefaultServiceTier] = useState<ServiceTier | null>(null);
    const [selectedCollaborationMode, setSelectedCollaborationMode] =
      useState<CollaborationMode>('default');
    const [selectedAcpModeId, setSelectedAcpModeId] = useState<string | null>(null);
    const [keyboardVisible, setKeyboardVisible] = useState(false);
    const [androidKeyboardInset, setAndroidKeyboardInset] = useState(0);
    const [composerHeight, setComposerHeight] = useState(0);
    const [queueActionItemId, setQueueActionItemId] = useState<string | null>(null);
    const [queueActionKind, setQueueActionKind] = useState<'steer' | 'cancel' | null>(null);
    const [relatedAgentThreads, setRelatedAgentThreads] = useState<ChatSummary[]>([]);
    const [agentRootThreadId, setAgentRootThreadId] = useState<string | null>(null);
    const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
    const [agentRuntimeRevision, setAgentRuntimeRevision] = useState(0);
    const [loadingAgentThreads, setLoadingAgentThreads] = useState(false);
    const [agentDetailThreadId, setAgentDetailThreadId] = useState<string | null>(null);
    const [agentDetailChat, setAgentDetailChat] = useState<Chat | null>(null);
    const [agentDetailParentChat, setAgentDetailParentChat] = useState<Chat | null>(null);
    const [agentDetailLoading, setAgentDetailLoading] = useState(false);
    const [agentDetailError, setAgentDetailError] = useState<string | null>(null);
    const [collaborationModeMenuVisible, setCollaborationModeMenuVisible] = useState(false);
    const [effortModalVisible, setEffortModalVisible] = useState(false);
    const [effortPickerModelId, setEffortPickerModelId] = useState<string | null>(null);
    const [activity, setActivity] = useState<ActivityState>({
      tone: 'idle',
      title: 'Ready',
    });
    const [bridgeRecoveryBannerVisible, setBridgeRecoveryBannerVisible] = useState(false);
    const [heldActivity, setHeldActivity] = useState<ActivityState | null>(null);
    const [showDelayedGenericRunningActivity, setShowDelayedGenericRunningActivity] =
      useState(false);
    const sendingRef = useRef(sending);
    sendingRef.current = sending;
    const creatingRef = useRef(creating);
    creatingRef.current = creating;
    const stoppingTurnRef = useRef(stoppingTurn);
    stoppingTurnRef.current = stoppingTurn;
    const heldActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const genericRunningActivityTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const foregroundAgentRefreshHandleRef = useRef<IdleTaskHandle | null>(null);
    const [planPanelCollapsedByThread, setPlanPanelCollapsedByThread] = useState<
      Record<string, boolean>
    >({});
    const [pendingPlanImplementationPrompts, setPendingPlanImplementationPrompts] =
      useState<Record<string, PendingPlanImplementationPrompt>>({});
    const safeAreaInsets = useSafeAreaInsets();
    const scrollRef = useRef<FlatList<TranscriptDisplayItem>>(null);
    const scrollRetryTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const scheduledPinnedScrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastPinnedScrollAtRef = useRef(0);
    const autoScrollStateRef = useRef<AutoScrollState>({
      shouldStickToBottom: true,
      isUserInteracting: false,
      isMomentumScrolling: false,
    });
    const loadChatRequestRef = useRef(0);
    const modelOptionsRequestRef = useRef(0);
    const agentThreadsRequestRef = useRef(0);
    const agentDetailRequestRef = useRef(0);
    const agentThreadsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const replayRecoveryGenerationRef = useRef(0);
    const replayRecoveryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const replayRecoveryAbortControllerRef = useRef<AbortController | null>(null);
    const replayRecoveryEpochResetPendingRef = useRef(false);
    const openAgentThreadSelectorRef = useRef<(query?: string | null) => Promise<boolean>>(
      async () => false
    );
    const bumpAgentRuntimeRevision = useCallback(() => {
      setAgentRuntimeRevision((previous) => previous + 1);
    }, []);

    const clearDeferredDisconnectActivity = useCallback(() => {
      if (deferredDisconnectActivityTimeoutRef.current) {
        clearTimeout(deferredDisconnectActivityTimeoutRef.current);
        deferredDisconnectActivityTimeoutRef.current = null;
      }
    }, []);

    const clearHeldActivity = useCallback(() => {
      if (heldActivityTimeoutRef.current) {
        clearTimeout(heldActivityTimeoutRef.current);
        heldActivityTimeoutRef.current = null;
      }
      setHeldActivity(null);
    }, []);

    const clearGenericRunningActivityDelay = useCallback(() => {
      if (genericRunningActivityTimeoutRef.current) {
        clearTimeout(genericRunningActivityTimeoutRef.current);
        genericRunningActivityTimeoutRef.current = null;
      }
      setShowDelayedGenericRunningActivity(false);
    }, []);

    const clearForegroundAgentRefresh = useCallback(() => {
      foregroundAgentRefreshHandleRef.current?.cancel?.();
      foregroundAgentRefreshHandleRef.current = null;
    }, []);

    const scheduleDisconnectActivity = useCallback(() => {
      clearDeferredDisconnectActivity();

      if (appStateRef.current !== 'active') {
        return;
      }

      const elapsedSinceForeground = Date.now() - lastAppForegroundedAtRef.current;
      const remainingGraceMs = Math.max(0, APP_FOCUS_DISCONNECT_GRACE_MS - elapsedSinceForeground);

      const showDisconnected = () => {
        deferredDisconnectActivityTimeoutRef.current = null;
        if (appStateRef.current !== 'active' || ws.isConnected) {
          return;
        }
        setBridgeRecoveryBannerVisible(true);
        setActivity({
          tone: 'error',
          title: 'Bridge disconnected',
          detail: 'Start the bridge to continue.',
        });
      };

      if (remainingGraceMs <= 0) {
        showDisconnected();
        return;
      }

      deferredDisconnectActivityTimeoutRef.current = setTimeout(showDisconnected, remainingGraceMs);
    }, [clearDeferredDisconnectActivity, ws]);

    const clearPendingScrollRetries = useCallback(() => {
      for (const timeoutId of scrollRetryTimeoutsRef.current) {
        clearTimeout(timeoutId);
      }
      scrollRetryTimeoutsRef.current = [];
      if (scheduledPinnedScrollTimeoutRef.current) {
        clearTimeout(scheduledPinnedScrollTimeoutRef.current);
        scheduledPinnedScrollTimeoutRef.current = null;
      }
    }, []);

    const scrollToBottomReliable = useCallback(
      (animated = true) => {
        clearPendingScrollRetries();
        const delays = [0, 70, 180, 320];
        scrollRetryTimeoutsRef.current = delays.map((delay, index) =>
          setTimeout(() => {
            requestAnimationFrame(() => {
              scrollRef.current?.scrollToOffset({
                offset: 0,
                animated: index === 0 ? animated : false,
              });
            });
          }, delay)
        );
      },
      [clearPendingScrollRetries]
    );

    const scrollToBottomIfPinned = useCallback(
      (animated = true) => {
        const autoScrollState = autoScrollStateRef.current;
        if (
          autoScrollState.isUserInteracting ||
          autoScrollState.isMomentumScrolling ||
          !autoScrollState.shouldStickToBottom
        ) {
          return;
        }
        scrollToBottomReliable(animated);
      },
      [scrollToBottomReliable]
    );

    const handleJumpToLatest = useCallback(() => {
      scrollToBottomReliable(true);
    }, [scrollToBottomReliable]);

    const schedulePinnedScrollToBottom = useCallback(
      (animated = true) => {
        const autoScrollState = autoScrollStateRef.current;
        if (
          autoScrollState.isUserInteracting ||
          autoScrollState.isMomentumScrolling ||
          !autoScrollState.shouldStickToBottom
        ) {
          return;
        }

        const now = Date.now();
        const elapsed = now - lastPinnedScrollAtRef.current;
        if (elapsed >= STREAMING_SCROLL_THROTTLE_MS) {
          lastPinnedScrollAtRef.current = now;
          scrollToBottomReliable(animated);
          return;
        }

        if (scheduledPinnedScrollTimeoutRef.current) {
          return;
        }

        scheduledPinnedScrollTimeoutRef.current = setTimeout(() => {
          scheduledPinnedScrollTimeoutRef.current = null;
          lastPinnedScrollAtRef.current = Date.now();
          scrollToBottomReliable(animated);
        }, STREAMING_SCROLL_THROTTLE_MS - elapsed);
      },
      [scrollToBottomReliable]
    );

    useEffect(() => {
      return () => {
        clearPendingScrollRetries();
      };
    }, [clearPendingScrollRetries]);

    useEffect(() => {
      return () => {
        const timerId = agentThreadsRefreshTimerRef.current;
        if (timerId) {
          clearTimeout(timerId);
          agentThreadsRefreshTimerRef.current = null;
        }
      };
    }, []);

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
    const slashQuery = parseSlashQuery(draft);
    const slashSuggestions =
      slashQuery !== null
        ? filterSlashCommands(
            slashQuery,
            activeSlashCommands
          )
        : [];
    const mentionQuery = parseMentionQuery(draft);
    const mentionPathSuggestions =
      mentionQuery !== null ? attachmentController.mentionSuggestions(mentionQuery) : [];
    const slashSuggestionsMaxHeight = Math.max(
      148,
      Math.min(300, Math.floor(windowHeight * 0.34))
    );

    const queueOptimisticUserMessage = useCallback(
      (
        threadId: string,
        message: ChatTranscriptMessage,
        options?: { baseChat?: Chat | null; userOrdinal?: number }
      ) => {
        if (!threadId) {
          return;
        }

        const existingPendingMessages =
          pendingOptimisticUserMessagesRef.current[threadId] ?? [];
        const visibleChat =
          selectedChatRef.current?.id === threadId
            ? selectedChatRef.current
            : options?.baseChat ?? null;
        const nextUserOrdinal = options?.userOrdinal ??
          Math.max(
            countUserMessages(visibleChat?.messages ?? []),
            existingPendingMessages[existingPendingMessages.length - 1]?.userOrdinal ?? 0
          ) + 1;

        pendingOptimisticUserMessagesRef.current[threadId] = [
          ...existingPendingMessages,
          {
            message,
            userOrdinal: nextUserOrdinal,
          },
        ];
      },
      []
    );

    const discardOptimisticUserMessage = useCallback(
      (threadId: string, messageId: string) => {
        if (!threadId || !messageId) {
          return;
        }

        const existingPendingMessages =
          pendingOptimisticUserMessagesRef.current[threadId] ?? [];
        if (existingPendingMessages.length === 0) {
          return;
        }

        const nextPendingMessages = existingPendingMessages.filter(
          (entry) => entry.message.id !== messageId
        );
        if (nextPendingMessages.length > 0) {
          pendingOptimisticUserMessagesRef.current[threadId] = nextPendingMessages;
        } else {
          delete pendingOptimisticUserMessagesRef.current[threadId];
        }
      },
      []
    );

    const mergeChatWithPendingOptimisticMessages = useCallback((chat: Chat): Chat => {
      const pendingMessages = pendingOptimisticUserMessagesRef.current[chat.id] ?? [];
      if (pendingMessages.length === 0) {
        return chat;
      }

      const {
        chat: mergedChat,
        remainingPendingMessages,
      } = reconcileChatWithPendingOptimisticMessages(chat, pendingMessages);

      if (remainingPendingMessages.length > 0) {
        pendingOptimisticUserMessagesRef.current[chat.id] = remainingPendingMessages;
      } else {
        delete pendingOptimisticUserMessagesRef.current[chat.id];
      }

      return mergedChat;
    }, []);

    const queueOptimisticQueuedMessage = useCallback(
      (threadId: string, content: string): PendingOptimisticQueuedMessage | null => {
        const normalizedThreadId = threadId.trim();
        const normalizedContent = content.trim();
        if (!normalizedThreadId || !normalizedContent) {
          return null;
        }

        const optimisticMessage: PendingOptimisticQueuedMessage = {
          id: `queued-pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          content: normalizedContent,
          createdAt: new Date().toISOString(),
        };
        const existingMessages =
          pendingOptimisticQueuedMessagesRef.current[normalizedThreadId] ?? [];
        pendingOptimisticQueuedMessagesRef.current[normalizedThreadId] = [
          ...existingMessages,
          optimisticMessage,
        ];
        bumpAgentRuntimeRevision();
        return optimisticMessage;
      },
      [bumpAgentRuntimeRevision]
    );

    const discardOptimisticQueuedMessage = useCallback(
      (threadId: string, messageId: string | null | undefined) => {
        const normalizedThreadId = threadId.trim();
        const normalizedMessageId = messageId?.trim() ?? '';
        if (!normalizedThreadId || !normalizedMessageId) {
          return;
        }

        const existingMessages =
          pendingOptimisticQueuedMessagesRef.current[normalizedThreadId] ?? [];
        if (existingMessages.length === 0) {
          return;
        }

        const nextMessages = existingMessages.filter(
          (message) => message.id !== normalizedMessageId
        );
        if (nextMessages.length > 0) {
          pendingOptimisticQueuedMessagesRef.current[normalizedThreadId] = nextMessages;
        } else {
          delete pendingOptimisticQueuedMessagesRef.current[normalizedThreadId];
        }
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision]
    );

    useEffect(() => {
      if (!selectedChat?.id) {
        return;
      }

      parentChatCacheRef.current[selectedChat.id] = selectedChat;
    }, [selectedChat]);

    useEffect(() => {
      const parentThreadId = selectedChat?.parentThreadId?.trim();
      if (!parentThreadId) {
        setSelectedParentChat(null);
        return;
      }

      const cachedParentChat = parentChatCacheRef.current[parentThreadId];
      if (cachedParentChat) {
        setSelectedParentChat(cachedParentChat);
        return;
      }

      let cancelled = false;

      api
        .getChat(parentThreadId)
        .then((parentChat) => {
          parentChatCacheRef.current[parentThreadId] = parentChat;
          if (!cancelled) {
            setSelectedParentChat(parentChat);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSelectedParentChat(null);
          }
        });

      return () => {
        cancelled = true;
      };
    }, [api, selectedChat?.id, selectedChat?.parentThreadId]);

    const scheduleRunWatchdogExpiry = useCallback((deadlineMs: number) => {
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }

      const delayMs = deadlineMs - Date.now();
      if (delayMs <= 0) {
        return;
      }

      runWatchdogTimerRef.current = setTimeout(() => {
        runWatchdogTimerRef.current = null;
        setRunWatchdogNow(Date.now());
      }, delayMs + 16);
    }, []);

    const bumpRunWatchdog = useCallback(
      (durationMs = RUN_WATCHDOG_MS) => {
        const deadlineMs = Math.max(runWatchdogUntilRef.current, Date.now() + durationMs);
        runWatchdogUntilRef.current = deadlineMs;
        setRunWatchdogNow(Date.now());
        scheduleRunWatchdogExpiry(deadlineMs);
      },
      [scheduleRunWatchdogExpiry]
    );

    const clearRunWatchdog = useCallback(() => {
      runWatchdogUntilRef.current = 0;
      const existingTimer = runWatchdogTimerRef.current;
      if (existingTimer) {
        clearTimeout(existingTimer);
        runWatchdogTimerRef.current = null;
      }
      setRunWatchdogNow(Date.now());
    }, []);

    useEffect(() => {
      return () => {
        const existingTimer = runWatchdogTimerRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
          runWatchdogTimerRef.current = null;
        }
      };
    }, []);

    const readThreadContextUsage = useCallback(
      (value: unknown): ThreadContextUsage | null => {
        const record = toRecord(value);
        if (!record) {
          return null;
        }

        const turnRecord = toRecord(record.turn);
        const tokenUsageRecord =
          toRecord(record.tokenUsage) ??
          toRecord(record.token_usage) ??
          toRecord(toRecord(record.info)?.tokenUsage) ??
          toRecord(toRecord(record.info)?.token_usage);
        const infoRecord = toRecord(record.info);

        const totalRecord =
          toRecord(tokenUsageRecord?.total) ??
          toRecord(infoRecord?.total_token_usage) ??
          toRecord(infoRecord?.totalTokenUsage);
        const lastRecord =
          toRecord(tokenUsageRecord?.last) ??
          toRecord(infoRecord?.last_token_usage) ??
          toRecord(infoRecord?.lastTokenUsage);

        const totalTokens =
          readIntegerLike(totalRecord?.totalTokens) ??
          readIntegerLike(totalRecord?.total_tokens);

        const lastTokens =
          readIntegerLike(lastRecord?.totalTokens) ??
          readIntegerLike(lastRecord?.total_tokens) ??
          (totalTokens !== null ? 0 : null);
        const modelContextWindow =
          readIntegerLike(record.modelContextWindow) ??
          readIntegerLike(record.model_context_window) ??
          readIntegerLike(turnRecord?.modelContextWindow) ??
          readIntegerLike(turnRecord?.model_context_window) ??
          readIntegerLike(tokenUsageRecord?.modelContextWindow) ??
          readIntegerLike(tokenUsageRecord?.model_context_window) ??
          readIntegerLike(infoRecord?.modelContextWindow) ??
          readIntegerLike(infoRecord?.model_context_window);

        if (totalTokens === null && modelContextWindow === null) {
          return null;
        }

        return {
          totalTokens,
          lastTokens,
          modelContextWindow,
          updatedAtMs: Date.now(),
        };
      },
      []
    );

    const saveChatModelPreferences = useCallback(
      (nextPreferences: Record<string, ChatModelPreference>) =>
        persistenceController.saveModelPreferences(nextPreferences),
      [persistenceController]
    );

    const saveChatPlanSnapshots = useCallback(
      (nextSnapshots: Record<string, ActivePlanState>) =>
        persistenceController.savePlanSnapshots(nextSnapshots),
      [persistenceController]
    );

    const saveBridgeUiSurfaceSnapshots = useCallback(
      (nextSnapshots: Record<string, BridgeUiSurface[]>) =>
        persistenceController.saveBridgeUiSurfaces(nextSnapshots),
      [persistenceController]
    );

    const scheduleBridgeUiSurfaceSnapshotsPersist = useCallback(
      (nextSnapshots: Record<string, BridgeUiSurface[]>) => {
        const existingTimer = bridgeUiSurfacePersistenceTimeoutRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        bridgeUiSurfacePersistenceTimeoutRef.current = setTimeout(() => {
          bridgeUiSurfacePersistenceTimeoutRef.current = null;
          void saveBridgeUiSurfaceSnapshots(nextSnapshots);
        }, 180);
      },
      [saveBridgeUiSurfaceSnapshots]
    );

    const saveWorkspaceFavorites = useCallback(
      (paths: string[]) => persistenceController.saveWorkspaceFavorites(paths),
      [persistenceController]
    );

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        const paths = await persistenceController.loadWorkspaceFavorites();
        if (!cancelled) setFavoriteWorkspacePaths(paths);
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [persistenceController]);

    const toggleWorkspaceFavorite = useCallback(
      (path: string | null | undefined) => {
        const normalizedPath = normalizeWorkspacePath(path);
        if (!normalizedPath) {
          return;
        }

        setFavoriteWorkspacePaths((current) => {
          const exists = current.includes(normalizedPath);
          const next = exists
            ? current.filter((entry) => entry !== normalizedPath)
            : [
                normalizedPath,
                ...current.filter((entry) => entry !== normalizedPath),
              ].slice(0, WORKSPACE_FAVORITES_LIMIT);
          void saveWorkspaceFavorites(next);
          return next;
        });
      },
      [saveWorkspaceFavorites]
    );

    useEffect(() => {
      return () => {
        const existingTimer = bridgeUiSurfacePersistenceTimeoutRef.current;
        if (existingTimer) {
          clearTimeout(existingTimer);
          bridgeUiSurfacePersistenceTimeoutRef.current = null;
        }
        void saveBridgeUiSurfaceSnapshots(bridgeUiSurfaceSnapshotsRef.current);
      };
    }, [saveBridgeUiSurfaceSnapshots]);

    const rememberChatPlanSnapshot = useCallback(
      (chatId: string, plan: ActivePlanState | null) => {
        const normalizedChatId = chatId.trim();
        if (!normalizedChatId) {
          return;
        }

        const previous = chatPlanSnapshotsRef.current[normalizedChatId] ?? null;
        const unchanged =
          previous?.turnId === plan?.turnId &&
          previous?.explanation === plan?.explanation &&
          previous?.deltaText === plan?.deltaText &&
          previous?.updatedAt === plan?.updatedAt &&
          JSON.stringify(previous?.steps ?? []) === JSON.stringify(plan?.steps ?? []);
        if (unchanged) {
          return;
        }

        const nextSnapshots = { ...chatPlanSnapshotsRef.current };
        if (plan) {
          nextSnapshots[normalizedChatId] = plan;
        } else {
          delete nextSnapshots[normalizedChatId];
        }
        chatPlanSnapshotsRef.current = nextSnapshots;
        void saveChatPlanSnapshots(nextSnapshots);
      },
      [saveChatPlanSnapshots]
    );

    const rememberBridgeUiSurfaceSnapshots = useCallback(
      (
        chatId: string,
        updater: (previous: BridgeUiSurface[]) => BridgeUiSurface[]
      ) => {
        const normalizedChatId = chatId.trim();
        if (!normalizedChatId) {
          return;
        }

        const previous = bridgeUiSurfaceSnapshotsRef.current[normalizedChatId] ?? [];
        const nextSurfaces = updater(previous);
        const nextSnapshots = { ...bridgeUiSurfaceSnapshotsRef.current };
        if (nextSurfaces.length > 0) {
          nextSnapshots[normalizedChatId] = nextSurfaces;
        } else {
          delete nextSnapshots[normalizedChatId];
        }

        bridgeUiSurfaceSnapshotsRef.current = nextSnapshots;
        scheduleBridgeUiSurfaceSnapshotsPersist(nextSnapshots);
      },
      [scheduleBridgeUiSurfaceSnapshotsPersist]
    );

    const rememberChatModelPreference = useCallback(
      (
        chatId: string | null | undefined,
        modelId: string | null | undefined,
        effort: ReasoningEffort | null | undefined,
        serviceTier: ServiceTier | null | undefined
      ) => {
        const normalizedChatId = typeof chatId === 'string' ? chatId.trim() : '';
        if (!normalizedChatId) {
          return;
        }

        const normalizedModelId = normalizeModelId(modelId);
        const normalizedEffort = normalizeReasoningEffort(effort);
        const normalizedServiceTier = toSelectedServiceTier(
          normalizeServiceTier(serviceTier)
        );
        const previous = chatModelPreferencesRef.current[normalizedChatId];
        if (
          previous &&
          previous.modelId === normalizedModelId &&
          previous.effort === normalizedEffort &&
          previous.serviceTier === normalizedServiceTier
        ) {
          return;
        }

        const nextPreferences: Record<string, ChatModelPreference> = {
          ...chatModelPreferencesRef.current,
          [normalizedChatId]: {
            modelId: normalizedModelId,
            effort: normalizedEffort,
            serviceTier: normalizedServiceTier,
            updatedAt: new Date().toISOString(),
          },
        };
        chatModelPreferencesRef.current = nextPreferences;
        if (chatIdRef.current === normalizedChatId) {
          setSelectedModelId(normalizedModelId);
          setSelectedEffort(normalizedEffort);
          setSelectedServiceTier(normalizedServiceTier);
        }
        void saveChatModelPreferences(nextPreferences);
      },
      [saveChatModelPreferences]
    );

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        const preferences = await persistenceController.loadModelPreferences();
        if (!cancelled) {
          chatModelPreferencesRef.current = preferences;
          setChatModelPreferencesLoaded(true);
        }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [persistenceController]);

    useEffect(() => {
      setDefaultServiceTier(null);
    }, [activeAgentId]);

    const clearExternalStatusFullSync = useCallback(() => {
      const timer = externalStatusFullSyncTimerRef.current;
      if (!timer) {
        externalStatusFullSyncQueuedThreadRef.current = null;
        return;
      }
      clearTimeout(timer);
      externalStatusFullSyncTimerRef.current = null;
      externalStatusFullSyncQueuedThreadRef.current = null;
    }, []);

    const drainExternalStatusFullSyncQueue = useCallback(() => {
      if (externalStatusFullSyncInFlightRef.current) {
        return;
      }

      const queuedThreadId = externalStatusFullSyncQueuedThreadRef.current;
      if (!queuedThreadId) {
        return;
      }

      if (chatIdRef.current !== queuedThreadId) {
        externalStatusFullSyncQueuedThreadRef.current = null;
        return;
      }

      const waitMs = Math.max(
        0,
        externalStatusFullSyncNextAllowedAtRef.current - Date.now()
      );
      if (waitMs > 0) {
        if (!externalStatusFullSyncTimerRef.current) {
          externalStatusFullSyncTimerRef.current = setTimeout(() => {
            externalStatusFullSyncTimerRef.current = null;
            drainExternalStatusFullSyncQueue();
          }, waitMs);
        }
        return;
      }

      externalStatusFullSyncQueuedThreadRef.current = null;
      externalStatusFullSyncInFlightRef.current = true;
      externalStatusFullSyncNextAllowedAtRef.current =
        Date.now() + env.externalStatusFullSyncDebounceMs;

      api
        .getChat(queuedThreadId)
        .then((latest) => {
          const resolvedLatest = mergeChatWithPendingOptimisticMessages(latest);
          if (chatIdRef.current !== queuedThreadId) {
            return;
          }
          setSelectedChat((prev) => {
            if (!prev || prev.id !== resolvedLatest.id) {
              return prev;
            }
            return resolveEquivalentChat(prev, resolvedLatest);
          });
          if (isChatLikelyRunning(resolvedLatest)) {
            bumpRunWatchdog();
            setActivity((prev) =>
              prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' }
            );
          }
        })
        .catch(() => {})
        .finally(() => {
          externalStatusFullSyncInFlightRef.current = false;
          drainExternalStatusFullSyncQueue();
        });
    }, [api, bumpRunWatchdog, mergeChatWithPendingOptimisticMessages]);

    const scheduleExternalStatusFullSync = useCallback(
      (threadId: string) => {
        if (chatIdRef.current !== threadId) {
          return;
        }
        externalStatusFullSyncQueuedThreadRef.current = threadId;
        drainExternalStatusFullSyncQueue();
      },
      [drainExternalStatusFullSyncQueue]
    );

    useEffect(
      () => () => {
        clearExternalStatusFullSync();
      },
      [clearExternalStatusFullSync]
    );

    const upsertThreadRuntimeSnapshot = useCallback(
      (
        threadId: string,
        updater: (previous: ThreadRuntimeSnapshot) => Partial<ThreadRuntimeSnapshot>
      ) => {
        if (!threadId) {
          return;
        }

        const previous =
          threadRuntimeSnapshotsRef.current[threadId] ??
          ({
            updatedAtMs: Date.now(),
          } as ThreadRuntimeSnapshot);
        const nextPatch = updater(previous);

        threadRuntimeSnapshotsRef.current[threadId] = {
          ...previous,
          ...nextPatch,
          updatedAtMs: Date.now(),
        };
      },
      []
    );

    const cacheThreadActivity = useCallback(
      (threadId: string, nextActivity: ActivityState) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({ activity: nextActivity }));
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadStreamingDelta = useCallback(
      (threadId: string, delta: string) => {
        const normalized = delta.trim();
        if (!normalized) {
          return;
        }

        upsertThreadRuntimeSnapshot(threadId, (previous) => {
          const merged = mergeStreamingDelta(previous.streamingText ?? null, delta);
          return { streamingText: merged };
        });
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadActiveCommand = useCallback(
      (threadId: string, eventType: string, detail: string) => {
        upsertThreadRuntimeSnapshot(threadId, (previous) => {
          const activeCommands = appendRunEventHistory(
            previous.activeCommands ?? [],
            threadId,
            eventType,
            detail
          );
          return {
            activeCommands,
            latestCommand: activeCommands[activeCommands.length - 1] ?? previous.latestCommand ?? null,
          };
        });
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPendingApproval = useCallback(
      (threadId: string, approval: PendingApproval | null) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          pendingApproval: approval,
        }));
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPendingUserInputRequest = useCallback(
      (threadId: string, request: PendingUserInputRequest | null) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          pendingUserInputRequest: request,
        }));
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadBridgeUiSurface = useCallback(
      (threadId: string, surface: BridgeUiSurface) => {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          bridgeUiSurfaces: upsertBridgeUiSurfaceList(
            previous.bridgeUiSurfaces ?? [],
            surface
          ),
        }));
        rememberBridgeUiSurfaceSnapshots(threadId, (previous) =>
          upsertBridgeUiSurfaceList(previous, surface)
        );
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot]
    );

    const removeThreadBridgeUiSurface = useCallback(
      (surfaceId: string, threadId?: string | null) => {
        if (threadId) {
          upsertThreadRuntimeSnapshot(threadId, (previous) => ({
            bridgeUiSurfaces: removeBridgeUiSurfaceFromList(
              previous.bridgeUiSurfaces ?? [],
              surfaceId
            ),
          }));
          rememberBridgeUiSurfaceSnapshots(threadId, (previous) =>
            removeBridgeUiSurfaceFromList(previous, surfaceId)
          );
        } else {
          for (const [snapshotThreadId, snapshot] of Object.entries(
            threadRuntimeSnapshotsRef.current
          )) {
            if (!snapshot.bridgeUiSurfaces?.some((surface) => surface.id === surfaceId)) {
              continue;
            }
            upsertThreadRuntimeSnapshot(snapshotThreadId, (previous) => ({
              bridgeUiSurfaces: removeBridgeUiSurfaceFromList(
                previous.bridgeUiSurfaces ?? [],
                surfaceId
              ),
            }));
            rememberBridgeUiSurfaceSnapshots(snapshotThreadId, (previous) =>
              removeBridgeUiSurfaceFromList(previous, surfaceId)
            );
          }
        }
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot]
    );

    const replaceThreadBridgeUiSurfaces = useCallback(
      (threadId: string, surfaces: BridgeUiSurface[]) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          bridgeUiSurfaces: surfaces,
        }));
        rememberBridgeUiSurfaceSnapshots(threadId, () => surfaces);
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadQueueState = useCallback(
      (threadId: string, queueState: BridgeThreadQueueState | null) => {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          queuedMessages: queueState
            ? [...queueState.pendingSteers, ...queueState.items]
            : [],
          pendingSteerMessageIds: queueState?.pendingSteers.map((item) => item.id) ?? [],
          waitingForToolCalls: queueState?.waitingForToolCalls ?? false,
          steeringInFlight: queueState?.steeringInFlight ?? false,
          queuedMessageError: queueState?.lastError ?? null,
        }));
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadTurnState = useCallback(
      (
        threadId: string,
        options: {
          activeTurnId?: string | null;
          runWatchdogUntil?: number;
        }
      ) => {
        upsertThreadRuntimeSnapshot(threadId, () => options);
        bumpAgentRuntimeRevision();
      },
      [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
    );

    const cacheThreadContextUsage = useCallback(
      (threadId: string, contextUsage: ThreadContextUsage | null) => {
        if (!contextUsage) {
          upsertThreadRuntimeSnapshot(threadId, () => ({
            contextUsage: null,
          }));
          return;
        }

        const previousContextUsage =
          threadRuntimeSnapshotsRef.current[threadId]?.contextUsage ?? null;
        const mergedContextUsage = mergeThreadContextUsage(previousContextUsage, contextUsage);

        upsertThreadRuntimeSnapshot(threadId, (previous) => {
          return {
            contextUsage: mergeThreadContextUsage(previous.contextUsage ?? null, mergedContextUsage),
          };
        });
      },
      [upsertThreadRuntimeSnapshot]
    );

    const cacheThreadPlan = useCallback(
      (
        threadId: string,
        nextPlan:
          | ActivePlanState
          | null
          | ((previous: ActivePlanState | null) => ActivePlanState | null)
      ) => {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          plan:
            typeof nextPlan === 'function'
              ? (
                  nextPlan as (previous: ActivePlanState | null) => ActivePlanState | null
                )(previous.plan ?? null)
              : nextPlan,
        }));
        rememberChatPlanSnapshot(
          threadId,
          threadRuntimeSnapshotsRef.current[threadId]?.plan ?? null
        );
      },
      [rememberChatPlanSnapshot, upsertThreadRuntimeSnapshot]
    );

    const clearPendingPlanImplementationPrompt = useCallback((threadId: string) => {
      if (!threadId) {
        return;
      }

      setPendingPlanImplementationPrompts((prev) => {
        if (!(threadId in prev)) {
          return prev;
        }

        const next = { ...prev };
        delete next[threadId];
        return next;
      });
    }, []);

    const applyThreadRuntimeSnapshot = useCallback(
      (threadId: string) => {
        if (!threadId) {
          setActivePlan(null);
          setActiveBridgeUiSurfaces([]);
          setSelectedCollaborationMode('default');
          return;
        }

        const snapshot = threadRuntimeSnapshotsRef.current[threadId];
        if (!snapshot) {
          setActivePlan(null);
          setActiveBridgeUiSurfaces([]);
          setSelectedCollaborationMode('default');
          return;
        }

        setSelectedCollaborationMode(resolveSnapshotCollaborationMode(snapshot));
        if (snapshot.activeCommands !== undefined) {
          setActiveCommands(snapshot.activeCommands);
        }
        if (snapshot.streamingText !== undefined) {
          setStreamingText(snapshot.streamingText);
        }
        if (snapshot.pendingApproval !== undefined) {
          setPendingApproval(snapshot.pendingApproval);
        }
        if (snapshot.pendingUserInputRequest !== undefined) {
          setPendingUserInputRequest(snapshot.pendingUserInputRequest);
          setUserInputDrafts(
            snapshot.pendingUserInputRequest
              ? buildUserInputDrafts(snapshot.pendingUserInputRequest)
              : {}
          );
          setUserInputError(null);
          setResolvingUserInput(false);
        }
        setActivePlan(snapshot.plan ?? null);
        setActiveBridgeUiSurfaces(snapshot.bridgeUiSurfaces ?? []);
        if (snapshot.activeTurnId !== undefined) {
          setActiveTurnId(snapshot.activeTurnId);
        }
        if (snapshot.activity) {
          setActivity(snapshot.activity);
        }
        if (
          typeof snapshot.runWatchdogUntil === 'number' &&
          snapshot.runWatchdogUntil > runWatchdogUntilRef.current
        ) {
          runWatchdogUntilRef.current = snapshot.runWatchdogUntil;
          setRunWatchdogNow(Date.now());
          scheduleRunWatchdogExpiry(snapshot.runWatchdogUntil);
        }
      },
      [scheduleRunWatchdogExpiry]
    );

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
        const snapshots = await persistenceController.loadPlanSnapshots();
        if (cancelled) return;
        chatPlanSnapshotsRef.current = snapshots;
        for (const [threadId, plan] of Object.entries(snapshots)) {
          upsertThreadRuntimeSnapshot(threadId, () => ({ plan }));
        }
        if (chatIdRef.current) applyThreadRuntimeSnapshot(chatIdRef.current);
        setChatPlanSnapshotsLoaded(true);
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [applyThreadRuntimeSnapshot, persistenceController, upsertThreadRuntimeSnapshot]);

    useEffect(() => {
      let cancelled = false;

      const load = async () => {
          const persisted = await persistenceController.loadBridgeUiSurfaces();
          if (cancelled) return;
          const nextSnapshots = { ...persisted };
          for (const [threadId, surfaces] of Object.entries(
            bridgeUiSurfaceSnapshotsRef.current
          )) {
            nextSnapshots[threadId] = surfaces.reduce(
              (merged, surface) => upsertBridgeUiSurfaceList(merged, surface),
              nextSnapshots[threadId] ?? []
            );
          }

          bridgeUiSurfaceSnapshotsRef.current = nextSnapshots;
          for (const [threadId, surfaces] of Object.entries(nextSnapshots)) {
            upsertThreadRuntimeSnapshot(threadId, (previous) => ({
              bridgeUiSurfaces: (previous.bridgeUiSurfaces ?? []).reduce(
                (merged, surface) => upsertBridgeUiSurfaceList(merged, surface),
                surfaces
              ),
            }));
          }
          if (chatIdRef.current) {
            applyThreadRuntimeSnapshot(chatIdRef.current);
          }
      };

      void load();
      return () => {
        cancelled = true;
      };
    }, [applyThreadRuntimeSnapshot, persistenceController, upsertThreadRuntimeSnapshot]);

    const refreshPendingApprovalsForThread = useCallback(
      async (threadId: string) => {
        try {
          const match = await approvalController.findForThread(threadId);
          cacheThreadPendingApproval(threadId, match);
          if (chatIdRef.current === threadId) {
            setPendingApproval(match);
            if (match) {
              setActivity({
                tone: 'idle',
                title: 'Waiting for approval',
                detail: match.command ?? match.kind,
              });
            }
          }
        } catch {
          // Best effort hydration for externally-started turns.
        }
      },
      [approvalController, cacheThreadPendingApproval]
    );

    const pushActiveCommand = useCallback(
      (threadId: string, eventType: string, detail: string) => {
        setActiveCommands((prev) =>
          appendRunEventHistory(prev, threadId, eventType, detail)
        );
      },
      []
    );

    useEffect(() => {
      onChatContextChange?.(selectedChat);
    }, [onChatContextChange, selectedChat]);

    useEffect(() => {
      onChatOpeningStateChange?.(openingChatId);
    }, [onChatOpeningStateChange, openingChatId]);

    useEffect(() => {
      let cancelled = false;

      const loadBridgeCapabilities = async () => {
        try {
          const capabilities = await api.readBridgeCapabilities();
          if (!cancelled) {
            setBridgeCapabilities(capabilities);
          }
        } catch {
          if (!cancelled) {
            setBridgeCapabilities(null);
          }
        }
      };

      void loadBridgeCapabilities();
      return () => {
        cancelled = true;
      };
    }, [api]);

    useEffect(() => {
      if (selectedChatId) {
        return;
      }

      if (bridgeCapabilities) {
        setPendingAgentId(selectAgentId(pendingAgentId ?? preferredAgentId, bridgeCapabilities));
      }
    }, [
      bridgeCapabilities,
      pendingAgentId,
      preferredAgentId,
      selectedChatId,
    ]);

    useEffect(() => {
      if (!chatModelPreferencesLoaded) {
        return;
      }

      const chatId = selectedChatId?.trim();
      if (!chatId) {
        return;
      }

      const preference = chatModelPreferencesRef.current[chatId];
      setSelectedModelId(preference?.modelId ?? null);
      setSelectedEffort(preference?.effort ?? null);
      setSelectedServiceTier(toSelectedServiceTier(preference?.serviceTier ?? null));
    }, [chatModelPreferencesLoaded, selectedChatId]);

    useEffect(() => {
      if (selectedChatId) {
        return;
      }

      setSelectedModelId(preferredDefaultModelId);
      setSelectedEffort(preferredDefaultEffort);
      setSelectedServiceTier(preferredServiceTier);
      setSelectedCollaborationMode(preferredCollaborationMode);
    }, [
      defaultServiceTier,
      pendingAgentId,
      preferredDefaultEffort,
      preferredDefaultModelId,
      preferredCollaborationMode,
      preferredServiceTier,
      selectedChatId,
    ]);

    const serverDefaultModel = modelOptions.find((model) => model.isDefault) ?? null;
    const serverDefaultModelId = serverDefaultModel?.id ?? null;
    const selectedModel = selectedModelId
      ? modelOptions.find((model) => model.id === selectedModelId) ?? null
      : null;
    const preferredDefaultModel =
      !selectedChatId && preferredDefaultModelId
        ? modelOptions.find((model) => model.id === preferredDefaultModelId) ?? null
        : null;
    const activeModel =
      selectedModel ?? preferredDefaultModel ?? serverDefaultModel ?? null;
    const unresolvedDefaultModelId =
      !selectedChatId && modelOptions.length === 0
        ? selectedModelId ?? preferredDefaultModelId
        : null;
    const activeModelId =
      selectedModel?.id ??
      preferredDefaultModel?.id ??
      unresolvedDefaultModelId ??
      serverDefaultModelId;
    const effortPickerModel = effortPickerModelId
      ? modelOptions.find((model) => model.id === effortPickerModelId) ?? null
      : activeModel;
    const effortPickerOptions = effortPickerModel?.reasoningEffort ?? [];
    const effortPickerDefault = effortPickerModel?.defaultReasoningEffort ?? null;
    const activeModelEffortOptions = activeModel?.reasoningEffort ?? [];
    const activeModelDefaultEffort = activeModel?.defaultReasoningEffort ?? null;
    const requestedEffort =
      selectedEffort ?? (!selectedChatId ? preferredDefaultEffort : null);
    const appliedServiceTierForSelectedChat = toSelectedServiceTier(
      selectedChatId
        ? normalizeServiceTier(
            chatModelPreferencesRef.current[selectedChatId]?.serviceTier ?? null
          )
        : defaultServiceTier
    );
    const activeServiceTier = supportsFastMode
      ? resolveSelectedServiceTier(
          selectedServiceTier,
          selectedChatId ? null : defaultServiceTier
        )
      : null;
    const fastModeEnabled = activeServiceTier === 'fast';
    const supportsSelectedEffort =
      requestedEffort &&
      (!activeModel ||
        activeModelEffortOptions.length === 0 ||
        !selectedModelId ||
        activeModelEffortOptions.some((option) => option.effort === requestedEffort));
    const activeEffort = supportsSelectedEffort ? requestedEffort : activeModelDefaultEffort;
    const activeModelLabel =
      selectedModel
        ? formatModelOptionLabel(selectedModel)
        : activeModel
          ? `Default (${formatModelOptionLabel(activeModel)})`
          : 'Default model';
    const activeEffortLabel =
      requestedEffort && activeEffort
        ? formatReasoningEffort(activeEffort)
        : activeModelDefaultEffort
          ? `Default (${formatReasoningEffort(activeModelDefaultEffort)})`
          : activeEffort
            ? formatReasoningEffort(activeEffort)
            : 'Model default';
    const collaborationModeLabel = modeConfig?.options?.find(
      (option) => option.value === modeConfig.value
    )?.name ?? modeConfig?.value ?? (
      selectedAcpModeId && !['build', 'plan'].includes(selectedAcpModeId)
        ? selectedAcpModeId
        : formatCollaborationModeLabel(selectedCollaborationMode)
    );
    const hasPendingServiceTierChange =
      Boolean(selectedChatId) && appliedServiceTierForSelectedChat !== activeServiceTier;
    const fastModeLabel = hasPendingServiceTierChange
      ? `${fastModeEnabled ? 'Fast mode on' : 'Fast mode off'} · next message`
      : fastModeEnabled
        ? 'Fast mode on'
        : 'Fast mode off';

    // Auto-transition complete/error → idle after 3s so the bar hides.
    useEffect(() => {
      if (activity.tone !== 'complete' && activity.tone !== 'error') {
        return;
      }
      const timer = setTimeout(() => {
        setActivity({ tone: 'idle', title: 'Ready' });
      }, 3000);
      return () => clearTimeout(timer);
    }, [activity.tone]);

    useEffect(() => {
      if (!selectedEffort) {
        return;
      }

      if (!selectedModelId) {
        return;
      }

      if (!activeModel) {
        return;
      }

      const effortOptions = activeModel.reasoningEffort ?? [];
      if (effortOptions.length === 0) {
        return;
      }

      const supportsSelectedEffort =
        effortOptions.some((option) => option.effort === selectedEffort);
      if (!supportsSelectedEffort) {
        setSelectedEffort(null);
      }
    }, [activeModel, selectedEffort, selectedModelId]);

    const resetComposerState = useCallback((requestedAgentId?: AgentId) => {
      const nextAgentId = requestedAgentId ?? selectedNewAgentId;
      clearExternalStatusFullSync();
      loadChatRequestRef.current += 1;
      setSelectedChat(null);
      setSelectedChatId(null);
      setPendingAgentId(nextAgentId);
      const rememberedSettings = nextAgentId ? agentSettings?.[nextAgentId] : null;
      setSelectedCollaborationMode(
        rememberedSettings?.collaborationMode === 'plan'
          ? rememberedSettings.collaborationMode
          : 'default'
      );
      setSelectedAcpModeId(null);
      openingChatStartedAtRef.current = 0;
      setOpeningChatId(null);
      setError(null);
      setSelectedServiceTier(undefined);
      setActiveCommands([]);
      setPendingApproval(null);
      setPendingUserInputRequest(null);
      setUserInputDrafts({});
      setUserInputError(null);
      setResolvingUserInput(false);
      setActivePlan(null);
      setStreamingText(null);
      attachmentController.clear();
      setActiveTurnId(null);
      setStoppingTurn(false);
      setWorkspaceModalVisible(false);
      setAgentThreadMenuVisible(false);
      setModelModalVisible(false);
      setCollaborationModeMenuVisible(false);
      setEffortModalVisible(false);
      setQueueActionItemId(null);
      setQueueActionKind(null);
      setActivity({
        tone: 'idle',
        title: 'Ready',
      });
      stopRequestedRef.current = false;
      stopSystemMessageLoggedRef.current = false;
      reasoningSummaryRef.current = {};
      hadCommandRef.current = false;
      clearRunWatchdog();
    }, [
      clearExternalStatusFullSync,
      clearRunWatchdog,
      defaultServiceTier,
      agentSettings,
      selectedNewAgentId,
    ]);

    const startNewChat = useCallback((requestedAgentId?: AgentId) => {
      // New chat should land on compose/home so user can pick workspace first.
      resetComposerState(requestedAgentId);
    }, [resetComposerState]);

    const openTitleEditor = useCallback(() => {
      if (!selectedChat) return;
      setTitleDraft(selectedChat.title);
      setTitleModalVisible(true);
      setError(null);
    }, [selectedChat]);

    const closeTitleEditor = useCallback(() => {
      if (!titleSaving) setTitleModalVisible(false);
    }, [titleSaving]);

    const saveTitle = useCallback(async () => {
      const chat = selectedChatRef.current;
      const title = titleDraft.trim();
      if (!chat || !title || titleSaving) return;
      try {
        setTitleSaving(true);
        const updated = await api.renameChat(chat.id, title);
        selectedChatRef.current = updated;
        setSelectedChat(updated);
        setTitleModalVisible(false);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setTitleSaving(false);
      }
    }, [api, titleDraft, titleSaving]);

    const refreshWorkspaceRoots = useCallback(async () => {
      setLoadingWorkspaceRoots(true);
      try {
        const response = await api.listWorkspaceRoots();
        setWorkspaceBridgeRoot(normalizeWorkspacePath(response.bridgeRoot));
        setWorkspaceRoots(response.workspaces);
        setWorkspaceBrowseError(null);
        return response;
      } catch (err) {
        setWorkspaceBrowseError((err as Error).message);
        return null;
      } finally {
        setLoadingWorkspaceRoots(false);
      }
    }, [api]);

    const browseWorkspacePath = useCallback(
      async (path: string | null | undefined) => {
        const normalizedRequestPath = normalizeWorkspacePath(path);
        const cacheKey = getWorkspaceBrowseCacheKey(normalizedRequestPath);
        const cached = workspaceBrowseCacheRef.current[cacheKey];
        const requestId = workspaceBrowseRequestRef.current + 1;
        workspaceBrowseRequestRef.current = requestId;
        const applyResponse = (
          response: FileSystemListResponse,
          responseCacheKey = cacheKey
        ) => {
          const normalizedPath = normalizeWorkspacePath(response.path);
          workspaceBrowseCacheRef.current[responseCacheKey] = response;
          if (normalizedPath) {
            workspaceBrowseCacheRef.current[getWorkspaceBrowseCacheKey(normalizedPath)] = response;
          }
          setWorkspaceBridgeRoot((current) => normalizeWorkspacePath(response.bridgeRoot) ?? current);
          setWorkspaceBrowsePath(normalizedPath);
          setWorkspaceBrowseParentPath(normalizeWorkspacePath(response.parentPath));
          setWorkspaceBrowseEntries(response.entries);
          setWorkspaceBrowseTruncation(
            response.truncated
              ? `Showing ${String(response.entries.length)} of ${String(response.totalEntries)} entries.`
              : null
          );
        };

        if (cached) {
          setWorkspaceBridgeRoot((current) => normalizeWorkspacePath(cached.bridgeRoot) ?? current);
          setWorkspaceBrowsePath(normalizeWorkspacePath(cached.path));
          setWorkspaceBrowseParentPath(normalizeWorkspacePath(cached.parentPath));
          setWorkspaceBrowseEntries(cached.entries);
          setWorkspaceBrowseTruncation(
            cached.truncated
              ? `Showing ${String(cached.entries.length)} of ${String(cached.totalEntries)} entries.`
              : null
          );
          setWorkspaceBrowseError(null);
        }

        setLoadingWorkspaceBrowse(true);
        try {
          const response = await api.listFilesystemEntries({
            path: normalizedRequestPath,
            directoriesOnly: true,
          });
          if (workspaceBrowseRequestRef.current !== requestId) {
            return;
          }

          applyResponse(response);
          setWorkspaceBrowseError(null);
        } catch (err) {
          if (workspaceBrowseRequestRef.current !== requestId) {
            return;
          }
          const message = (err as Error).message;
          const missingRequestedWorkspace =
            normalizedRequestPath !== null &&
            /workspace directory is invalid or inaccessible|workspace directory must point to a folder/i.test(
              message
            );

          if (missingRequestedWorkspace) {
            try {
              const rootResponse = await api.listFilesystemEntries({
                path: null,
                directoriesOnly: true,
              });
              if (workspaceBrowseRequestRef.current !== requestId) {
                return;
              }
              applyResponse(
                rootResponse,
                getWorkspaceBrowseCacheKey(normalizeWorkspacePath(rootResponse.path))
              );
              if (normalizedRequestPath === preferredStartCwd) {
                onDefaultStartCwdChange?.(null);
              }
              setWorkspaceBrowseError('Saved workspace was not found. Showing start folder.');
              return;
            } catch {
              // Surface the original invalid path error; it names the path the user needs to fix.
            }
          }

          setWorkspaceBrowseError(message);
        } finally {
          if (workspaceBrowseRequestRef.current === requestId) {
            setLoadingWorkspaceBrowse(false);
          }
        }
      },
      [api, onDefaultStartCwdChange, preferredStartCwd]
    );

    const openWorkspacePicker = useCallback(
      (
        purpose: WorkspacePickerPurpose,
        initialPathOverride?: string | null
      ) => {
        const initialPath =
          normalizeWorkspacePath(initialPathOverride) ??
          preferredStartCwd ??
          workspaceBrowsePath ??
          workspaceBridgeRoot ??
          null;
        setWorkspacePickerPurpose(purpose);
        setWorkspaceModalVisible(true);
        void browseWorkspacePath(initialPath);
        scheduleIdleTask(() => {
          void refreshWorkspaceRoots();
        });
      },
      [
        browseWorkspacePath,
        preferredStartCwd,
        refreshWorkspaceRoots,
        workspaceBridgeRoot,
        workspaceBrowsePath,
      ]
    );

    const openWorkspaceModal = useCallback(() => {
      setResumeGitCheckoutAfterWorkspacePicker(false);
      openWorkspacePicker('default-start');
    }, [openWorkspacePicker]);

    const openGitCheckoutModal = useCallback((initialParentPath?: string | null) => {
      const defaultParentPath =
        normalizeWorkspacePath(initialParentPath) ??
        preferredStartCwd ??
        workspaceBrowsePath ??
        workspaceBridgeRoot ??
        null;
      setGitCheckoutRepoUrl('');
      setGitCheckoutDirectoryName('');
      setGitCheckoutDirectoryNameEdited(false);
      setGitCheckoutParentPath(defaultParentPath);
      setGitCheckoutError(null);
      setGitCheckoutCloning(false);
      setResumeGitCheckoutAfterWorkspacePicker(false);
      setGitCheckoutModalVisible(true);
      void refreshWorkspaceRoots().then((response) => {
        const bridgeRoot = normalizeWorkspacePath(response?.bridgeRoot);
        if (bridgeRoot) {
          setGitCheckoutParentPath((current) => current ?? bridgeRoot);
        }
      });
    }, [
      preferredStartCwd,
      refreshWorkspaceRoots,
      workspaceBridgeRoot,
      workspaceBrowsePath,
    ]);

    const closeGitCheckoutModal = useCallback(() => {
      if (gitCheckoutCloning) {
        return;
      }
      setGitCheckoutModalVisible(false);
      setGitCheckoutError(null);
      setResumeGitCheckoutAfterWorkspacePicker(false);
    }, [gitCheckoutCloning]);

    const openGitCheckoutDestinationPicker = useCallback(() => {
      setResumeGitCheckoutAfterWorkspacePicker(true);
      setGitCheckoutModalVisible(false);
      openWorkspacePicker(
        'git-checkout-destination',
        gitCheckoutParentPath ?? preferredStartCwd ?? workspaceBridgeRoot ?? null
      );
    }, [gitCheckoutParentPath, openWorkspacePicker, preferredStartCwd, workspaceBridgeRoot]);

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

    useEffect(() => {
      if (appStateRef.current === 'active' && !ws.isConnected) {
        scheduleDisconnectActivity();
      }

      return ws.onStatus((connected) => {
        if (connected) {
          clearDeferredDisconnectActivity();
          setBridgeRecoveryBannerVisible(false);
          setError((previous) =>
            isBridgeConnectionErrorMessage(previous) ? null : previous
          );
          return;
        }

        if (appStateRef.current !== 'active') {
          clearDeferredDisconnectActivity();
          setBridgeRecoveryBannerVisible(false);
          return;
        }

        scheduleDisconnectActivity();
      });
    }, [clearDeferredDisconnectActivity, scheduleDisconnectActivity, ws]);

    useEffect(() => {
      const subscription = AppState.addEventListener('change', (nextAppState) => {
        const previousAppState = appStateRef.current;
        appStateRef.current = nextAppState;

        if (nextAppState !== 'active') {
          clearDeferredDisconnectActivity();
          clearForegroundAgentRefresh();
          setBridgeRecoveryBannerVisible(false);
          return;
        }

        if (previousAppState === 'active') {
          return;
        }

        lastAppForegroundedAtRef.current = Date.now();
        clearDeferredDisconnectActivity();
        if (!ws.isConnected) {
          scheduleDisconnectActivity();
        }

        const activeChatId = chatIdRef.current;
        if (!activeChatId) {
          return;
        }

        clearForegroundAgentRefresh();
        foregroundAgentRefreshHandleRef.current = scheduleIdleTask(() => {
          foregroundAgentRefreshHandleRef.current = null;
          if (appStateRef.current !== 'active' || chatIdRef.current !== activeChatId) {
            return;
          }
          scheduleAgentThreadsRefresh(activeChatId);
        });
      });

      return () => {
        clearForegroundAgentRefresh();
        subscription.remove();
      };
    }, [
      clearDeferredDisconnectActivity,
      clearForegroundAgentRefresh,
      scheduleAgentThreadsRefresh,
      scheduleDisconnectActivity,
      ws,
    ]);

    const handleWorkspaceSelection = useCallback(
      (cwd: string | null) => {
        const normalizedPath = normalizeWorkspacePath(cwd);
        setWorkspaceBrowseError(null);

        if (workspacePickerPurpose === 'git-checkout-destination') {
          setGitCheckoutParentPath(normalizedPath);
          setResumeGitCheckoutAfterWorkspacePicker(false);
          setWorkspaceModalVisible(false);
          setGitCheckoutModalVisible(true);
          return;
        }

        onDefaultStartCwdChange?.(normalizedPath);
        setWorkspaceModalVisible(false);
      },
      [onDefaultStartCwdChange, workspacePickerPurpose]
    );

    const handleGitCheckoutRepoUrlChange = useCallback(
      (value: string) => {
        setGitCheckoutRepoUrl(value);
        setGitCheckoutError(null);
        if (!gitCheckoutDirectoryNameEdited) {
          setGitCheckoutDirectoryName(deriveCloneDirectoryName(value) ?? '');
        }
      },
      [gitCheckoutDirectoryNameEdited]
    );

    const handleGitCheckoutDirectoryNameChange = useCallback((value: string) => {
      setGitCheckoutDirectoryName(value);
      setGitCheckoutDirectoryNameEdited(value.trim().length > 0);
      setGitCheckoutError(null);
    }, []);

    const submitGitCheckout = useCallback(async () => {
      const url = gitCheckoutRepoUrl.trim();
      const directoryName = normalizeCloneDirectoryName(gitCheckoutDirectoryName);
      if (!url) {
        setGitCheckoutError('Paste an HTTPS or SSH repository URL first.');
        return;
      }
      if (!directoryName) {
        setGitCheckoutError('Choose a valid folder name for the cloned repo.');
        return;
      }

      let parentPath = normalizeWorkspacePath(gitCheckoutParentPath) ?? workspaceBridgeRoot;
      if (!parentPath) {
        const response = await refreshWorkspaceRoots();
        parentPath = normalizeWorkspacePath(response?.bridgeRoot);
      }
      if (!parentPath) {
        setGitCheckoutError('Choose where the repository should be cloned.');
        return;
      }

      try {
        setGitCheckoutCloning(true);
        setGitCheckoutError(null);
        const cloned = await api.gitClone({
          url,
          parentPath,
          directoryName,
        });
        const cloneFailureMessage = formatGitCloneFailureMessage(cloned, directoryName);
        if (cloneFailureMessage) {
          setGitCheckoutError(cloneFailureMessage);
          return;
        }
        const clonedPath = normalizeWorkspacePath(cloned.cwd) ?? joinWorkspacePath(parentPath, directoryName);
        onDefaultStartCwdChange?.(clonedPath);
        setWorkspaceBrowsePath(clonedPath);
        setWorkspaceBrowseParentPath(parentPath);
        setWorkspaceBrowseError(null);
        setGitCheckoutModalVisible(false);
      } catch (err) {
        setGitCheckoutError((err as Error).message);
      } finally {
        setGitCheckoutCloning(false);
      }
    }, [
      api,
      gitCheckoutDirectoryName,
      gitCheckoutParentPath,
      gitCheckoutRepoUrl,
      onDefaultStartCwdChange,
      refreshWorkspaceRoots,
      workspaceBridgeRoot,
    ]);

    const refreshModelOptions = useCallback(async () => {
      const requestId = modelOptionsRequestRef.current + 1;
      modelOptionsRequestRef.current = requestId;
      setLoadingModels(true);
      try {
        const catalogModels = await api.listModelOptions(activeAgentId);
        if (modelOptionsRequestRef.current !== requestId) {
          return;
        }
        if (activeAgentId) {
          setModelOptionsByAgent((previous) => ({
            ...previous,
            [activeAgentId]: Array.isArray(catalogModels) ? catalogModels : EMPTY_MODEL_OPTIONS,
          }));
        }
      } catch (err) {
        if (modelOptionsRequestRef.current === requestId) {
          setError((err as Error).message);
        }
      } finally {
        if (modelOptionsRequestRef.current === requestId) {
          setLoadingModels(false);
        }
      }
    }, [activeAgentId, api]);

    const configurationSessionRef = useRef<Promise<Chat | null> | null>(null);
    const ensureModeConfigurationSession = useCallback(async (): Promise<Chat | null> => {
      if (selectedChatRef.current?.id) {
        return selectedChatRef.current;
      }
      if (configurationSessionRef.current) {
        return configurationSessionRef.current;
      }
      const request = api.createChat({
        agentId: activeAgentId ?? undefined,
        cwd: preferredStartCwd ?? undefined,
        model: activeModelId ?? undefined,
        effort: selectedEffort ?? undefined,
        serviceTier: activeServiceTier ?? undefined,
        approvalPolicy: activeApprovalPolicy,
        collaborationMode: selectedCollaborationMode,
        agentMode: selectedAcpModeId,
      }).then((chat) => {
        selectedChatIdRef.current = chat.id;
        selectedChatRef.current = chat;
        setSelectedChatId(chat.id);
        setSelectedChat(chat);
        const models = modelOptionsFromAcpConfig(chat.acpConfig ?? []);
        if (chat.agentId && models.length > 0) {
          setModelOptionsByAgent((previous) => ({
            ...previous,
            [chat.agentId!]: mergeModelOptions(previous[chat.agentId!] ?? EMPTY_MODEL_OPTIONS, models),
          }));
        }
        return chat;
      }).catch((err) => {
        setError((err as Error).message);
        return null;
      }).finally(() => {
        configurationSessionRef.current = null;
      });
      configurationSessionRef.current = request;
      return request;
    }, [
      activeAgentId,
      activeApprovalPolicy,
      activeModelId,
      activeServiceTier,
      api,
      preferredStartCwd,
      selectedAcpModeId,
      selectedCollaborationMode,
      selectedEffort,
    ]);

    const openModelModal = useCallback(() => {
      setModelModalVisible(true);
      void refreshModelOptions();
    }, [refreshModelOptions]);

    const closeModelModal = useCallback(() => {
      if (loadingModels) {
        return;
      }
      setModelModalVisible(false);
    }, [loadingModels]);

    const openAgentModal = useCallback(() => {
      if (selectedChatId) {
        return;
      }
      setAgentModalVisible(true);
      setError(null);
    }, [selectedChatId]);

    const closeAgentModal = useCallback(() => {
      setAgentModalVisible(false);
    }, []);

    const openEffortModal = useCallback(
      (modelId?: string | null) => {
        const resolvedModelId = normalizeModelId(modelId ?? activeModelId);
        if (!resolvedModelId) {
          setError('Select a model first');
          return;
        }

        setEffortPickerModelId(resolvedModelId);
        setEffortModalVisible(true);
        setError(null);
      },
      [activeModelId]
    );

    const closeEffortModal = useCallback(() => {
      setEffortModalVisible(false);
    }, []);

    const applyAcpConfigOption = useCallback(
      async (config: AcpConfigOption | null, value: string): Promise<Chat | null> => {
        if (!selectedChatId || !config) {
          return null;
        }
        try {
          const updated = await api.setThreadConfigOption(selectedChatId, config.id, value);
          selectedChatRef.current = updated;
          setSelectedChat(updated);
          return updated;
        } catch (err) {
          setError((err as Error).message);
          return null;
        }
      },
      [api, selectedChatId]
    );

    const selectEffort = useCallback(
      async (effort: ReasoningEffort | null) => {
        const value = effort ?? effortConfig?.value;
        if (effortConfig && value) {
          const updated = await applyAcpConfigOption(effortConfig, value);
          if (!updated) {
            return;
          }
        }
        setSelectedEffort(effort);
        setEffortModalVisible(false);
        setError(null);
        if (selectedChatId) {
          rememberChatModelPreference(
            selectedChatId,
            activeModelId,
            effort,
            activeServiceTier
          );
        }
      },
      [
        activeModelId,
        activeServiceTier,
        applyAcpConfigOption,
        effortConfig,
        rememberChatModelPreference,
        selectedChatId,
      ]
    );

    const selectModel = useCallback(
      async (modelId: string | null) => {
        const normalizedModelId = normalizeModelId(modelId);
        if (normalizedModelId && modelConfig) {
          const updated = await applyAcpConfigOption(modelConfig, normalizedModelId);
          if (!updated) {
            return;
          }
        }
        setSelectedModelId(normalizedModelId);
        setSelectedEffort(null);
        setModelModalVisible(false);
        setError(null);
        if (selectedChatId) {
          rememberChatModelPreference(
            selectedChatId,
            normalizedModelId,
            null,
            activeServiceTier
          );
        }

        if (normalizedModelId) {
          const model = modelOptions.find((entry) => entry.id === normalizedModelId) ?? null;
          if ((model?.reasoningEffort?.length ?? 0) > 0) {
            setEffortPickerModelId(normalizedModelId);
            setEffortModalVisible(true);
          }
        }
      },
      [
        activeServiceTier,
        applyAcpConfigOption,
        modelConfig,
        modelOptions,
        rememberChatModelPreference,
        selectedChatId,
      ]
    );

    const selectPendingAgent = useCallback((agentId: AgentId) => {
      if (selectedChatId) {
        return;
      }

      const rememberedSettings = agentSettings?.[agentId];
      setPendingAgentId(agentId);
      setSelectedModelId(null);
      setSelectedEffort(null);
      setSelectedServiceTier(undefined);
      setSelectedAcpModeId(null);
      setSelectedCollaborationMode(
        rememberedSettings?.collaborationMode === 'plan'
          ? rememberedSettings.collaborationMode
          : 'default'
      );
      setAgentModalVisible(false);
      setError(null);
    }, [agentSettings, selectedChatId]);

    useEffect(() => {
      if (ws.isConnected) {
        void refreshModelOptions();
      }
      return ws.onStatus((connected) => {
        if (connected) {
          void refreshModelOptions();
        }
      });
    }, [refreshModelOptions, ws]);

    const openCollaborationModeMenu = useCallback(() => {
      setCollaborationModeMenuVisible(true);
      if (!selectedChatId) {
        void ensureModeConfigurationSession();
      }
    }, [ensureModeConfigurationSession, selectedChatId]);

    const toggleFastMode = useCallback(() => {
      if (!supportsFastMode) {
        return;
      }
      const nextServiceTier: ServiceTier | null =
        activeServiceTier === 'fast' ? null : 'fast';
      const enablingFastMode = nextServiceTier === 'fast';
      const nextTitle = enablingFastMode ? 'Fast mode enabled' : 'Fast mode disabled';
      setSelectedServiceTier(nextServiceTier);
      setError(null);
      setActivity({
        tone: 'complete',
        title: nextTitle,
        detail: selectedChatId ? 'Applies to the next message' : 'Applies to the next new chat',
      });
    }, [activeServiceTier, selectedChatId, supportsFastMode]);

    const attachmentControlsDisabled = attachmentPickerBusy || uploadingAttachment;

    const attachmentMenuOptions = useMemo<SelectionSheetOption[]>(
      () => [
        ...(hasFailedAttachmentUploads
          ? [
              {
                key: 'retry-uploads',
                title: 'Retry failed uploads',
                description: `Retry prepared files without selecting them again. ${ATTACHMENT_MAX_LABEL} each.`,
                icon: 'refresh-outline' as const,
                disabled: attachmentControlsDisabled,
                onPress: () => {
                  attachmentController.closeMenu();
                  retryFailedUploads();
                },
              },
            ]
          : []),
        {
          key: 'workspace-path',
          title: 'Attach from workspace path',
          description: 'Reference a file or folder from the current repo.',
          icon: 'folder-open-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            attachmentController.requestMenuAction('workspace-path');
          },
        },
        {
          key: 'phone-file',
          title: 'Pick file from phone',
          description: `Import a document or asset, up to ${ATTACHMENT_MAX_LABEL}.`,
          icon: 'document-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            attachmentController.requestMenuAction('phone-file');
          },
        },
        {
          key: 'phone-image',
          title: 'Pick image from phone',
          description: `Resize and compress an image, up to ${ATTACHMENT_MAX_LABEL}.`,
          icon: 'image-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            attachmentController.requestMenuAction('phone-image');
          },
        },
        {
          key: 'phone-camera',
          title: 'Take photo',
          description: `Capture, resize, and compress a photo, up to ${ATTACHMENT_MAX_LABEL}.`,
          icon: 'camera-outline',
          disabled: attachmentControlsDisabled,
          onPress: () => {
            attachmentController.requestMenuAction('phone-camera');
          },
        },
      ],
      [attachmentController, attachmentControlsDisabled, hasFailedAttachmentUploads, retryFailedUploads]
    );

    const collaborationModeOptions = useMemo<SelectionSheetOption[]>(
      () => {
        const setMode = async (mode: CollaborationMode, acpMode: string) => {
          if (modeConfig) {
            const updated = await applyAcpConfigOption(modeConfig, acpMode);
            if (!updated) {
              return;
            }
          }
          setSelectedAcpModeId(acpMode);
          setSelectedCollaborationMode(mode);
          setCollaborationModeMenuVisible(false);
          setError(null);
        };

        const advertisedModes = modeConfig?.options ?? [];
        if (advertisedModes.length > 0) {
          return advertisedModes.map((option) => {
            const mode: CollaborationMode = option.value === 'plan' ? 'plan' : 'default';
            return {
              key: option.value,
              title: option.name,
              description: option.description ?? (
                mode === 'plan'
                  ? 'Plan the work before execution.'
                  : 'Use this primary OpenCode agent mode for the next turn.'
              ),
              icon: mode === 'plan' ? 'git-branch-outline' as const : 'chatbubble-ellipses-outline' as const,
              selected: modeConfig?.value === option.value,
              onPress: () => { void setMode(mode, option.value); },
            } satisfies SelectionSheetOption;
          });
        }
        if (selectedChatId) {
          return [];
        }
        return [
          {
            key: 'default',
            title: 'Default mode',
            description: 'Answer directly and keep the turn moving.',
            icon: 'chatbubble-ellipses-outline' as const,
            selected: selectedCollaborationMode === 'default',
            onPress: () => { void setMode('default', 'build'); },
          },
          {
            key: 'plan',
            title: 'Plan mode',
            description: 'Pause to ask structured follow-up questions before execution.',
            icon: 'git-branch-outline' as const,
            selected: selectedCollaborationMode === 'plan',
            onPress: () => { void setMode('plan', 'plan'); },
          },
        ];
      },
      [applyAcpConfigOption, modeConfig, selectedCollaborationMode]
    );

    const agentPickerOptions = useMemo<SelectionSheetOption[]>(
      () =>
        readyAgents.map((agent) => ({
          key: agent.agentId,
          title: agent.displayName,
          description: [agent.version, agent.provenance].filter(Boolean).join(' · '),
          icon: 'hardware-chip-outline' as const,
          selected: activeAgentId === agent.agentId,
          onPress: () => selectPendingAgent(agent.agentId),
        })),
      [activeAgentId, readyAgents, selectPendingAgent]
    );

    const modelPickerOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'server-default',
          title: 'Use server default',
          description: serverDefaultModel
            ? `Currently ${formatModelOptionLabel(serverDefaultModel)}.`
            : 'Follow the bridge default model.',
          icon: 'sparkles-outline',
          badge: 'Auto',
          selected: selectedModelId === null || selectedModel === null,
          onPress: () => { void selectModel(null); },
        },
        ...modelOptions.map((model) => ({
          key: model.id,
          title: formatModelOptionLabel(model),
          description: formatModelOptionDescription(model),
          icon: 'hardware-chip-outline' as const,
          badge: model.isDefault ? 'Default' : undefined,
          meta: model.defaultReasoningEffort
            ? formatReasoningEffort(model.defaultReasoningEffort)
            : undefined,
          selected: model.id === selectedModelId,
          onPress: () => { void selectModel(model.id); },
        })),
      ],
      [modelOptions, selectModel, selectedModel, selectedModelId, serverDefaultModel]
    );

    const effortPickerSheetOptions = useMemo<SelectionSheetOption[]>(
      () => [
        {
          key: 'model-default',
          title: effortPickerDefault
            ? `Use ${formatReasoningEffort(effortPickerDefault)}`
            : 'Use model default',
          description: effortPickerModel
            ? `Follow ${formatModelOptionLabel(effortPickerModel)}'s default reasoning.`
            : 'Follow the active model default.',
          icon: 'sparkles-outline',
          badge: 'Auto',
          selected: selectedEffort === null,
          onPress: () => { void selectEffort(null); },
        },
        ...effortPickerOptions.map((option) => ({
          key: option.effort,
          title: formatReasoningEffort(option.effort),
          description:
            option.description?.trim() ||
            'Override the model default for the next response.',
          icon: 'pulse-outline' as const,
          selected: option.effort === selectedEffort,
          onPress: () => { void selectEffort(option.effort); },
        })),
      ],
      [
        effortPickerDefault,
        effortPickerModel,
        effortPickerOptions,
        selectEffort,
        selectedEffort,
      ]
    );

    const appendLocalAssistantMessage = useCallback(
      (content: string, targetChatId?: string | null) => {
        const normalized = content.trim();
        if (!normalized) {
          return;
        }

        const chatId = targetChatId ?? selectedChatIdRef.current;
        if (!chatId) {
          return;
        }

        const createdAt = new Date().toISOString();
        setSelectedChat((prev) => {
          const baseChat = prev?.id === chatId
            ? prev
            : selectedChatRef.current?.id === chatId
              ? selectedChatRef.current
              : null;
          if (!baseChat) {
            return prev;
          }
          const updated = {
            ...baseChat,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            lastMessagePreview: normalized.slice(0, 120),
            messages: [
              ...baseChat.messages,
              {
                id: `local-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'assistant',
                content: normalized,
                createdAt,
              },
            ],
          } satisfies Chat;
          selectedChatRef.current = updated;
          return updated;
        });
        scrollToBottomIfPinned(true);
      },
      [scrollToBottomIfPinned]
    );

    const ensureLocalCommandChat = useCallback(
      async (command: string): Promise<string | null> => {
        const appendCommand = (baseChat: Chat): string => {
          const createdAt = new Date().toISOString();
          const localChat = {
            ...baseChat,
            status: 'complete' as const,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            lastMessagePreview: command,
            messages: [
              ...baseChat.messages,
              {
                id: `local-command-${Date.now()}`,
                role: 'user' as const,
                content: command,
                createdAt,
              },
            ],
          } satisfies Chat;
          selectedChatIdRef.current = localChat.id;
          selectedChatRef.current = localChat;
          setSelectedChatId(localChat.id);
          setSelectedChat(localChat);
          return localChat.id;
        };

        const current = selectedChatRef.current;
        if (selectedChatId && current?.id === selectedChatId) {
          return appendCommand(current);
        }

        try {
          const created = await api.createChat({
            agentId: activeAgentId ?? undefined,
            cwd: preferredStartCwd ?? undefined,
            model: activeModelId ?? undefined,
            effort: activeEffort ?? undefined,
            serviceTier: activeServiceTier ?? undefined,
            approvalPolicy: activeApprovalPolicy,
            collaborationMode: selectedCollaborationMode,
            agentMode: selectedAcpModeId,
          });
          const chatId = appendCommand(created);
          setError(null);
          return chatId;
        } catch (err) {
          setError((err as Error).message);
          return null;
        }
      },
      [
        activeAgentId,
        activeApprovalPolicy,
        activeEffort,
        activeModelId,
        activeServiceTier,
        api,
        preferredStartCwd,
        selectedChatId,
      ]
    );

    const appendLocalSystemMessage = useCallback(
      (content: string) => {
        const normalized = content.trim();
        if (!normalized || !selectedChatId) {
          return;
        }

        const createdAt = new Date().toISOString();
        setSelectedChat((prev) => {
          if (!prev || prev.id !== selectedChatId) {
            return prev;
          }

          return {
            ...prev,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            messages: [
              ...prev.messages,
              {
                id: `local-system-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                role: 'system',
                content: normalized,
                createdAt,
              },
            ],
          };
        });
        scrollToBottomIfPinned(true);
      },
      [scrollToBottomIfPinned, selectedChatId]
    );

    const upsertLiveReasoningMessage = useCallback(
      (threadId: string, delta?: string | null) => {
        if (!threadId || chatIdRef.current !== threadId) {
          return;
        }

        const previousBuffer = liveReasoningBuffersRef.current[threadId] ?? '';
        const nextBuffer =
          typeof delta === 'string' && delta.length > 0
            ? mergeStreamingDelta(previousBuffer, delta)
            : previousBuffer;

        if (nextBuffer) {
          liveReasoningBuffersRef.current[threadId] = nextBuffer;
        }

        const createdAt = new Date().toISOString();
        const messageId =
          liveReasoningMessageIdsRef.current[threadId] ??
          `local-reasoning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        liveReasoningMessageIdsRef.current[threadId] = messageId;
        const content = formatLiveReasoningMessage(
          liveReasoningBuffersRef.current[threadId] ?? ''
        );

        setSelectedChat((prev) => {
          if (!prev || prev.id !== threadId) {
            return prev;
          }

          let found = false;
          const messages = prev.messages.map((message) => {
            if (message.id !== messageId) {
              return message;
            }

            found = true;
            return {
              ...message,
              role: 'reasoning' as const,
              content,
            };
          });

          return {
            ...prev,
            updatedAt: createdAt,
            statusUpdatedAt: createdAt,
            messages: found
              ? messages
              : [
                  ...messages,
                  {
                    id: messageId,
                    role: 'reasoning',
                    content,
                    createdAt,
                  },
                ],
          };
        });

        schedulePinnedScrollToBottom(true);
      },
      [schedulePinnedScrollToBottom]
    );

    const clearLiveReasoningMessage = useCallback((threadId: string | null | undefined) => {
      if (!threadId) {
        return;
      }
      delete liveReasoningBuffersRef.current[threadId];
      delete liveReasoningMessageIdsRef.current[threadId];
    }, []);

    const appendStopSystemMessageIfNeeded = useCallback(() => {
      if (stopSystemMessageLoggedRef.current) {
        return;
      }
      stopSystemMessageLoggedRef.current = true;
      appendLocalSystemMessage('Turn stopped by user.');
    }, [appendLocalSystemMessage]);

    const handleTurnFailure = useCallback(
      (error: unknown) => {
        const message = (error as Error).message ?? String(error);
        const normalizedMessage = message.toLowerCase();
        const interruptedByUser =
          stopRequestedRef.current &&
          (normalizedMessage.includes('turn aborted') ||
            normalizedMessage.includes('interrupted'));

        if (interruptedByUser) {
          setError(null);
          appendStopSystemMessageIfNeeded();
          setActivity({
            tone: 'complete',
            title: 'Turn stopped',
          });
        } else {
          setError(message);
          setActivity({
            tone: 'error',
            title: 'Turn failed',
            detail: message,
          });
        }

        setActiveTurnId(null);
        setStoppingTurn(false);
        stopRequestedRef.current = interruptedByUser;
        clearRunWatchdog();
      },
      [appendStopSystemMessageIfNeeded, clearRunWatchdog]
    );

    const interruptActiveTurn = useCallback(
      async (threadId: string, turnId: string) => {
        try {
          await turnExecutionController.interrupt(threadId, turnId);
          setError(null);
          setActivity({
            tone: 'running',
            title: 'Stopping turn',
          });
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          setError(message);
          setActivity({
            tone: 'error',
            title: 'Failed to stop turn',
            detail: message,
          });
          setStoppingTurn(false);
          stopRequestedRef.current = false;
        }
      },
      [turnExecutionController]
    );

    const interruptLatestTurn = useCallback(
      async (threadId: string) => {
        try {
          const interruptedTurnId = await turnExecutionController.interrupt(threadId);
          if (interruptedTurnId) {
            setActiveTurnId(interruptedTurnId);
            setError(null);
            setActivity({
              tone: 'running',
              title: 'Stopping turn',
            });
            return;
          }

          setStoppingTurn(false);
          stopRequestedRef.current = false;
          setActivity({
            tone: 'idle',
            title: 'No active turn found',
          });
        } catch (error) {
          const message = (error as Error).message ?? String(error);
          setError(message);
          setActivity({
            tone: 'error',
            title: 'Failed to stop turn',
            detail: message,
          });
          setStoppingTurn(false);
          stopRequestedRef.current = false;
        }
      },
      [turnExecutionController]
    );

    const registerTurnStarted = useCallback(
      (threadId: string, turnId: string) => {
        const currentChatId = chatIdRef.current;
        if (!threadId || !turnId || (currentChatId && currentChatId !== threadId)) {
          return;
        }

        const nowIso = new Date().toISOString();
        setSending(false);
        setCreating(false);
        setActiveTurnId(turnId);
        setSelectedChat((prev) => {
          if (!prev || prev.id !== threadId) {
            return prev;
          }

          return {
            ...prev,
            status: 'running',
            updatedAt: nowIso,
            statusUpdatedAt: nowIso,
            lastError: undefined,
          };
        });
        if (stopRequestedRef.current) {
          void interruptActiveTurn(threadId, turnId);
        }
      },
      [interruptActiveTurn]
    );

    const handleStopTurn = useCallback(() => {
      if (stoppingTurn) {
        return;
      }

      stopRequestedRef.current = true;
      stopSystemMessageLoggedRef.current = false;
      setStoppingTurn(true);
      setError(null);
      setActivity({
        tone: 'running',
        title: 'Stopping turn',
      });

      const threadId = chatIdRef.current;
      const turnId = activeTurnIdRef.current;
      if (threadId && turnId) {
        void interruptActiveTurn(threadId, turnId);
        return;
      }

      if (threadId) {
        void interruptLatestTurn(threadId);
        return;
      }

      setStoppingTurn(false);
      stopRequestedRef.current = false;
      setActivity({
        tone: 'idle',
        title: 'No active turn found',
      });
    }, [interruptActiveTurn, interruptLatestTurn, stoppingTurn]);

    const handleSlashCommand = useCallback(
      async (input: string): Promise<boolean> => {
        const parsed = parseSlashCommand(input);
        if (!parsed) {
          return false;
        }

        const { name: rawName, args } = parsed;
        const commandDef = findSlashCommandDefinition(rawName);
        const name = commandDef?.name ?? rawName;
        const argText = args.trim();

        if (!commandDef) {
          return false;
        }

        if (!commandDef.mobileSupported) {
          setError(commandDef.availabilityNote ?? `/${name} is not supported on mobile.`);
          return true;
        }

        if (commandDef.requiresOpenChat && !selectedChatId) {
          setError(`/${name} requires an open chat`);
          return true;
        }

        if (
          !isSlashCommandAvailable(commandDef, {
            hasOpenChat: Boolean(selectedChatId),
            supportsGoal,
            supportsPlanMode,
            supportsReview,
          })
        ) {
          setError(`/${name} is not supported for ${activeAgentLabel} chats.`);
          return true;
        }

        if (name === 'agent') {
          await openAgentThreadSelectorRef.current(argText || null);
          return true;
        }

        if (name === 'help') {
          const commandChatId = await ensureLocalCommandChat(input);
          if (!commandChatId) {
            return true;
          }
          const lines = activeSlashCommands.map((command) => {
            const suffix = command.argsHint ? ` ${command.argsHint}` : '';
            const scope = command.mobileSupported ? 'mobile' : 'CLI only';
            return `/${command.name}${suffix} — ${command.summary} (${scope})`;
          });
          appendLocalAssistantMessage(
            `Supported slash commands:\n${lines.join('\n')}`,
            commandChatId
          );
          return true;
        }

        if (name === 'new') {
          if (activeAgentId) startNewChat(activeAgentId);
          return true;
        }

        if (name === 'model') {
          setError('This ACP agent does not advertise configurable models.');
          return true;
        }

        if (name === 'plan') {
          const lowered = argText.toLowerCase();
          if (!argText || lowered === 'on' || lowered === 'enable' || lowered === 'enabled') {
            setSelectedCollaborationMode('plan');
            setActivity({
              tone: 'complete',
              title: 'Plan mode enabled',
            });
            setError(null);
            return true;
          }

          if (
            lowered === 'off' ||
            lowered === 'disable' ||
            lowered === 'disabled' ||
            lowered === 'default' ||
            lowered === 'chat'
          ) {
            setSelectedCollaborationMode('default');
            setActivity({
              tone: 'complete',
              title: 'Default mode enabled',
            });
            setError(null);
            return true;
          }

          setSelectedCollaborationMode('plan');
          if (!selectedChatId) {
            const planSubmission = submissionController.begin(
              { ...draftController.snapshot(), value: argText },
              { mentions: [], localImages: [] }
            );
            let createdChatId: string | null = null;
            let adoptedCreatedChat = false;
            const isCreatedChatVisible = () =>
              createdChatId
                ? selectedChatIdRef.current === createdChatId ||
                  (adoptedCreatedChat && selectedChatIdRef.current === null)
                : selectedChatIdRef.current === null;
            const optimisticMessage: ChatTranscriptMessage = {
              id: `msg-${Date.now()}`,
              role: 'user',
              content: argText,
              createdAt: new Date().toISOString(),
            };

            setDraft('');
            submissionController.markCleared(planSubmission, draftController.snapshot().revision);
            try {
              setCreating(true);
              setActiveTurnId(null);
              setStoppingTurn(false);
              stopRequestedRef.current = false;
              setActivePlan(null);
              setPendingUserInputRequest(null);
              setUserInputDrafts({});
              setUserInputError(null);
              setResolvingUserInput(false);
              setActivity({
                tone: 'running',
                title: 'Creating chat',
              });
              const created = await turnExecutionController.create({
                agentId: activeAgentId ?? undefined,
                cwd: preferredStartCwd ?? undefined,
                model: activeModelId ?? undefined,
                effort: activeEffort ?? undefined,
                serviceTier: activeServiceTier ?? undefined,
                approvalPolicy: activeApprovalPolicy,
                collaborationMode: 'plan',
                agentMode: selectedAcpModeId,
              }, planSubmission.id);
              createdChatId = created.id;
              if (activeAgentId) onLastUsedThreadSettingsChange?.(
                activeAgentId,
                'plan'
              );

              queueOptimisticUserMessage(created.id, optimisticMessage, {
                baseChat: created,
              });
              if (selectedChatIdRef.current === null) {
                adoptedCreatedChat = true;
                setSelectedChatId(created.id);
                setSelectedChat({
                  ...created,
                  status: 'running',
                  updatedAt: new Date().toISOString(),
                  statusUpdatedAt: new Date().toISOString(),
                  lastMessagePreview: argText.slice(0, 50),
                  messages: [...created.messages, optimisticMessage],
                });

                setActivity({
                  tone: 'running',
                  title: 'Sending plan prompt',
                });
                bumpRunWatchdog();
              }

              const updated = await turnExecutionController.send(created.id, {
                content: argText,
                cwd: created.cwd ?? preferredStartCwd ?? undefined,
                model: activeModelId ?? undefined,
                effort: activeEffort ?? undefined,
                serviceTier: activeServiceTier ?? undefined,
                approvalPolicy: activeApprovalPolicy,
                collaborationMode: 'plan',
                agent: null,
              }, planSubmission.id, (turnId) => registerTurnStarted(created.id, turnId));
              const resolvedUpdated =
                mergeChatWithPendingOptimisticMessages(updated);
              const autoEnabledPlan =
                shouldAutoEnablePlanModeFromChat(resolvedUpdated);
              const isStillVisible = isCreatedChatVisible();
              if (autoEnabledPlan && isStillVisible) {
                setSelectedCollaborationMode('plan');
              }
              rememberChatModelPreference(
                created.id,
                activeModelId,
                selectedEffort ?? activeEffort,
                activeServiceTier
              );
              if (isStillVisible) {
                setSelectedChat(resolvedUpdated);
                setError(null);
                setActivity({
                  tone: 'complete',
                  title: 'Turn completed',
                  detail:
                    autoEnabledPlan
                      ? 'Plan mode enabled for the next turn'
                      : undefined,
                });
                clearRunWatchdog();
              }
              submissionController.succeed(planSubmission);
            } catch (err) {
              if (submissionController.fail(planSubmission, draftController.snapshot())) {
                setDraft(planSubmission.draft);
              }
              if (createdChatId) {
                discardOptimisticUserMessage(createdChatId, optimisticMessage.id);
              }
              if (isCreatedChatVisible()) {
                handleTurnFailure(err);
              }
            } finally {
              if (isCreatedChatVisible()) {
                setCreating(false);
              }
            }
            return true;
          }

          const optimisticMessage: ChatTranscriptMessage = {
            id: `msg-${Date.now()}`,
            role: 'user',
            content: argText,
            createdAt: new Date().toISOString(),
          };
          const targetChatId = selectedChatId;
          const planSubmission = submissionController.begin(
            { ...draftController.snapshot(), value: argText },
            { mentions: [], localImages: [] }
          );

          try {
            setSending(true);
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopRequestedRef.current = false;
            setActivePlan(null);
            cacheThreadPlan(targetChatId, null);
            setPendingUserInputRequest(null);
            setUserInputDrafts({});
            setUserInputError(null);
            setResolvingUserInput(false);
            setActivity({
              tone: 'running',
              title: 'Sending plan prompt',
            });
            bumpRunWatchdog();
            setDraft('');
            submissionController.markCleared(planSubmission, draftController.snapshot().revision);
            queueOptimisticUserMessage(targetChatId, optimisticMessage);
            setSelectedChat((prev) => {
              const baseChat =
                selectedChat?.id === targetChatId
                  ? selectedChat
                  : prev?.id === targetChatId
                    ? prev
                    : prev;
              if (!baseChat) {
                return prev;
              }
              const nowIso = new Date().toISOString();
              return {
                ...baseChat,
                status: 'running',
                updatedAt: nowIso,
                statusUpdatedAt: nowIso,
                lastError: undefined,
                lastMessagePreview:
                  normalizeChatMessageMatchContent(getMessageText(optimisticMessage)).slice(0, 120) ||
                  baseChat.lastMessagePreview,
                messages: [...baseChat.messages, optimisticMessage],
              };
            });
            scrollToBottomReliable(true);
            const updated = await turnExecutionController.send(targetChatId, {
              content: argText,
              cwd: selectedChat?.cwd,
              model: activeModelId ?? undefined,
              effort: activeEffort ?? undefined,
              serviceTier: activeServiceTier ?? undefined,
              approvalPolicy: activeApprovalPolicy,
              collaborationMode: 'plan',
              agent: null,
            }, planSubmission.id, (turnId) => registerTurnStarted(targetChatId, turnId));
            const resolvedUpdated =
              mergeChatWithPendingOptimisticMessages(updated);
            rememberChatModelPreference(
              targetChatId,
              activeModelId,
              selectedEffort ?? activeEffort,
              activeServiceTier
            );
            if (selectedChatIdRef.current === targetChatId) {
              setSelectedChat(resolvedUpdated);
              setError(null);
              setActivity({
                tone: 'complete',
                title: 'Turn completed',
              });
              clearRunWatchdog();
            }
            submissionController.succeed(planSubmission);
          } catch (err) {
            if (submissionController.fail(planSubmission, draftController.snapshot())) {
              setDraft(planSubmission.draft);
            }
            discardOptimisticUserMessage(targetChatId, optimisticMessage.id);
            if (selectedChatIdRef.current === targetChatId) {
              handleTurnFailure(err);
            }
          } finally {
            if (selectedChatIdRef.current === targetChatId) {
              setSending(false);
            }
          }

          return true;
        }

        if (name === 'status') {
          const commandChatId = await ensureLocalCommandChat(input);
          if (!commandChatId) {
            return true;
          }
          const lines = [
            `Model: ${activeModelLabel}`,
            `Reasoning: ${activeEffortLabel}`,
            `Mode: ${formatCollaborationModeLabel(selectedCollaborationMode)}`,
            `Default workspace: ${preferredStartCwd ?? 'Select project'}`,
          ];
          if (supportsFastMode) {
            lines.splice(2, 0, `Fast mode: ${fastModeEnabled ? 'On' : 'Off'}`);
          }
          if (selectedChat) {
            lines.push(`Chat: ${selectedChat.title || selectedChat.id}`);
            lines.push(`Chat workspace: ${selectedChat.cwd ?? 'Not set'}`);
            lines.push(`Chat status: ${selectedChat.status}`);
          }
          appendLocalAssistantMessage(lines.join('\n'), commandChatId);
          return true;
        }

        if (name === 'review') {
          if (!selectedChatId) {
            setError('/review requires an open chat');
            return true;
          }

          if (!supportsReview) {
            const detail = `Review is not supported for ${activeAgentLabel} chats.`;
            setError(detail);
            setActivity({
              tone: 'error',
              title: 'Review unavailable',
              detail,
            });
            return true;
          }

          try {
            setActivity({
              tone: 'running',
              title: 'Starting review',
            });
            throw new Error('Review is not advertised by this ACP agent.');
          } catch (err) {
            setError((err as Error).message);
            setActivity({
              tone: 'error',
              title: 'Review failed',
              detail: (err as Error).message,
            });
          }
          return true;
        }

        if (name === 'diff') {
          if (!selectedChat) {
            setError('/diff requires an open chat');
            return true;
          }

          onOpenGit(selectedChat);
          return true;
        }

        return false;
      },
      [
        activeAgentId,
        activeSlashCommands,
        activeEffort,
        activeModelId,
        activeEffortLabel,
        activeModelLabel,
        activeApprovalPolicy,
        activeServiceTier,
        api,
        appendLocalAssistantMessage,
        ensureLocalCommandChat,
        bumpRunWatchdog,
        clearRunWatchdog,
        discardOptimisticUserMessage,
        fastModeEnabled,
        supportsFastMode,
        supportsGoal,
        supportsPlanMode,
        supportsReview,
        activeAgentLabel,
        mergeChatWithPendingOptimisticMessages,
        modelOptions,
        onLastUsedThreadSettingsChange,
        onOpenGit,
        openModelModal,
        preferredStartCwd,
        queueOptimisticUserMessage,
        registerTurnStarted,
        selectedChat,
        selectedChatId,
        selectedCollaborationMode,
        handleTurnFailure,
        rememberChatModelPreference,
        scrollToBottomReliable,
        startNewChat,
      ]
    );

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

    useEffect(() => {
      if (!agentDetailThreadId) {
        return;
      }
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const poll = async () => {
        if (stopped) {
          return;
        }
        await loadAgentDetail(agentDetailThreadId);
        if (stopped) {
          return;
        }
        const summary = api.peekChatSummary(agentDetailThreadId) ?? agentDetailChat;
        const snapshot = threadRuntimeSnapshotsRef.current[agentDetailThreadId];
        const running = summary
          ? buildAgentThreadDisplayState(summary, snapshot).isActive
          : false;
        timer = setTimeout(() => {
          void poll();
        }, running ? ACTIVE_CHAT_SYNC_INTERVAL_MS : IDLE_CHAT_SYNC_INTERVAL_MS);
      };
      timer = setTimeout(() => {
        void poll();
      }, ACTIVE_CHAT_SYNC_INTERVAL_MS);
      return () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      };
    }, [agentDetailChat, agentDetailThreadId, api, loadAgentDetail]);

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

    useEffect(() => {
      return ws.onEvent((event: RpcNotification) => {
        const agUi = parseAgUiEventNotification(event);
        const agUiLifecycle = agUi &&
          (agUi.event.type === 'RUN_STARTED' ||
            agUi.event.type === 'RUN_FINISHED' ||
            agUi.event.type === 'RUN_ERROR');
        if (
          event.method !== 'thread/started' &&
          event.method !== 'thread/name/updated' &&
          event.method !== 'thread/status/changed' &&
          !agUiLifecycle
        ) {
          return;
        }

        const currentThreadId = chatIdRef.current;
        const currentRootThreadId = agentRootThreadIdRef.current;
        if (!currentThreadId || !currentRootThreadId) {
          return;
        }

        const params = toRecord(event.params);
        const eventThreadId = agUi?.threadId ?? extractNotificationThreadId(params);
        const eventParentThreadId = extractNotificationParentThreadId(params);
        if (
          eventThreadId &&
          eventThreadId !== currentThreadId &&
          eventThreadId !== currentRootThreadId &&
          eventParentThreadId !== currentThreadId &&
          eventParentThreadId !== currentRootThreadId
        ) {
          return;
        }

        scheduleAgentThreadsRefresh(currentThreadId);
      });
    }, [scheduleAgentThreadsRefresh, ws]);

    const createChat = useCallback(async () => {
      const draftSnapshot = draftController.snapshot();
      const content = draftSnapshot.value.trim();
      if (!content) return;

      if (await handleSlashCommand(content)) {
        setDraft('');
        return;
      }

      const turnMentions = pendingMentionPaths.map((path) =>
        toMentionInput(path, preferredStartCwd)
      );
      const turnLocalImages = pendingLocalImagePaths.map((path) => ({ path }));
      const submission = submissionController.begin(draftSnapshot, {
        mentions: pendingMentionPaths,
        localImages: pendingLocalImagePaths,
      });
      const optimisticContent = toOptimisticUserContent(content, turnMentions, turnLocalImages);

      const optimisticMessage: ChatTranscriptMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content: optimisticContent,
        createdAt: new Date().toISOString(),
      };
      const optimisticChatId = `pending-${submission.id}`;
      const optimisticCreatedAt = new Date().toISOString();
      const optimisticChat: Chat = {
        id: optimisticChatId,
        title: '',
        status: 'running',
        activeTurnId: null,
        createdAt: optimisticCreatedAt,
        updatedAt: optimisticCreatedAt,
        statusUpdatedAt: optimisticCreatedAt,
        lastMessagePreview: content.slice(0, 50),
        cwd: preferredStartCwd ?? '',
        agentId: activeAgentId ?? preferredAgentId ?? 'unknown',
        messages: [optimisticMessage],
      };

      attachmentController.beginSubmission();
      setDraft('');
      submissionController.markCleared(submission, draftController.snapshot().revision);
      if (selectedChatIdRef.current === null) {
        selectedChatIdRef.current = optimisticChatId;
        selectedChatRef.current = optimisticChat;
        setSelectedChatId(optimisticChatId);
        setSelectedChat(optimisticChat);
        scrollToBottomReliable(true);
      }

      let createdChatId: string | null = null;
      let adoptedCreatedChat = false;
      const isCreatedChatVisible = () =>
        createdChatId
          ? selectedChatIdRef.current === createdChatId ||
            (adoptedCreatedChat && selectedChatIdRef.current === null)
          : selectedChatIdRef.current === null || selectedChatIdRef.current === optimisticChatId;
      try {
        setCreating(true);
        setActiveTurnId(null);
        setStoppingTurn(false);
        stopRequestedRef.current = false;
        setActivePlan(null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setUserInputError(null);
        setResolvingUserInput(false);
        setActivity({
          tone: 'running',
          title: 'Creating chat',
        });
        const updated = await turnExecutionController.createAndStart({
          submissionId: submission.id,
          create: {
            agentId: activeAgentId ?? undefined,
            cwd: preferredStartCwd ?? undefined,
            model: activeModelId ?? undefined,
            effort: activeEffort ?? undefined,
            serviceTier: activeServiceTier ?? undefined,
            approvalPolicy: activeApprovalPolicy,
            collaborationMode: selectedCollaborationMode,
            agentMode: selectedAcpModeId,
          },
          message: (created) => ({
            content,
            mentions: turnMentions,
            localImages: turnLocalImages,
            cwd: created.cwd ?? preferredStartCwd ?? undefined,
            model: activeModelId ?? undefined,
            effort: activeEffort ?? undefined,
            serviceTier: activeServiceTier ?? undefined,
            approvalPolicy: activeApprovalPolicy,
            collaborationMode: selectedCollaborationMode,
          }),
          onCreated: (created) => {
            createdChatId = created.id;
            if (activeAgentId) onLastUsedThreadSettingsChange?.(
              activeAgentId,
              selectedCollaborationMode
            );
            queueOptimisticUserMessage(created.id, optimisticMessage, {
              baseChat: created,
              userOrdinal: 1,
            });
            if (
              selectedChatIdRef.current === null ||
              selectedChatIdRef.current === optimisticChatId
            ) {
              adoptedCreatedChat = true;
              selectedChatIdRef.current = created.id;
              setSelectedChatId(created.id);
              const visibleCreatedChat = {
                ...created,
                status: 'running',
                updatedAt: new Date().toISOString(),
                statusUpdatedAt: new Date().toISOString(),
                lastMessagePreview: content.slice(0, 50),
                messages:
                  countUserMessages(created.messages) > 0
                    ? created.messages
                    : [...created.messages, optimisticMessage],
              } satisfies Chat;
              selectedChatRef.current = visibleCreatedChat;
              setSelectedChat(visibleCreatedChat);
              scrollToBottomReliable(true);
              setActivity({ tone: 'running', title: 'Working' });
              bumpRunWatchdog();
            }
          },
          onTurnStarted: registerTurnStarted,
        });
        const resolvedUpdated =
          mergeChatWithPendingOptimisticMessages(updated);
        const autoEnabledPlan =
          shouldAutoEnablePlanModeFromChat(resolvedUpdated);
        const isStillVisible = isCreatedChatVisible();
        if (autoEnabledPlan && isStillVisible) {
          setSelectedCollaborationMode('plan');
        }
        rememberChatModelPreference(
          createdChatId,
          activeModelId,
          selectedEffort ?? activeEffort,
          activeServiceTier
        );
        submissionController.succeed(submission);
        if (!isStillVisible) {
          attachmentController.finishSubmission(false);
        }
        if (isStillVisible) {
          setSelectedChat(resolvedUpdated);
          attachmentController.finishSubmission(true);
          setError(null);
          if (resolvedUpdated.status === 'complete') {
            setActivity({
              tone: 'complete',
              title: 'Turn completed',
              detail:
                autoEnabledPlan && selectedCollaborationMode !== 'plan'
                  ? 'Plan mode enabled for the next turn'
                  : undefined,
            });
            clearRunWatchdog();
          } else if (resolvedUpdated.status === 'error') {
            setActivity({
              tone: 'error',
              title: 'Turn failed',
              detail: resolvedUpdated.lastError ?? undefined,
            });
            clearRunWatchdog();
          } else {
            // 'running' or 'idle' (server may not have started yet) — keep working
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            bumpRunWatchdog();
          }
        }
      } catch (err) {
        const currentDraft = draftController.snapshot();
        const shouldRestoreDraft = !createdChatId || submissionController.fail(
          submission,
          currentDraft
        ) || Boolean(
          createdChatId &&
          adoptedCreatedChat &&
          selectedChatIdRef.current === createdChatId &&
          currentDraft.value === ''
        );
        attachmentController.finishSubmission(false, shouldRestoreDraft);
        if (shouldRestoreDraft) {
          setDraft(submission.draft);
        }
        if (createdChatId) {
          discardOptimisticUserMessage(createdChatId, optimisticMessage.id);
        }
        if (!createdChatId && selectedChatIdRef.current === optimisticChatId) {
          selectedChatIdRef.current = null;
          selectedChatRef.current = null;
          setSelectedChatId(null);
          setSelectedChat(null);
        }
        if (isCreatedChatVisible()) {
          handleTurnFailure(err);
        }
      } finally {
        if (isCreatedChatVisible()) {
          setCreating(false);
        }
      }
    }, [
      turnExecutionController,
      attachmentController,
      draft,
      draftController,
      activeEffort,
      activeAgentId,
      activeModelId,
      activeApprovalPolicy,
      activeServiceTier,
      handleSlashCommand,
      pendingMentionPaths,
      pendingLocalImagePaths,
      preferredStartCwd,
      selectedCollaborationMode,
      registerTurnStarted,
      handleTurnFailure,
      discardOptimisticUserMessage,
      bumpRunWatchdog,
      clearRunWatchdog,
      mergeChatWithPendingOptimisticMessages,
      onLastUsedThreadSettingsChange,
      queueOptimisticUserMessage,
      rememberChatModelPreference,
      scrollToBottomReliable,
      submissionController,
    ]);

    const sendMessageContent = useCallback(
      async (
        rawContent: string,
        options?: {
          allowSlashCommands?: boolean;
          collaborationMode?: CollaborationMode;
          mentions?: MentionInput[];
          localImages?: LocalImageInput[];
          clearComposer?: boolean;
          preservePlan?: boolean;
          suppressPlanModeAutoEnable?: boolean;
          submission?: ComposerSubmission;
        }
      ) => {
        const content = rawContent.trim();
        if (!selectedChatId || !content) {
          return false;
        }
        const targetChatId = selectedChatId;

        const shouldClearComposer = options?.clearComposer ?? true;
        const shouldPreservePlan = options?.preservePlan ?? false;
        if (options?.allowSlashCommands && (await handleSlashCommand(content))) {
          if (shouldClearComposer) {
            setDraft('');
          }
          return true;
        }
        const resolvedCollaborationMode =
          options?.collaborationMode ?? selectedCollaborationMode;
        const turnMentions =
          options?.mentions ??
          pendingMentionPaths.map((path) => toMentionInput(path, selectedChat?.cwd));
        const turnLocalImages =
          options?.localImages ?? pendingLocalImagePaths.map((path) => ({ path }));
        const submission =
          options?.submission ??
          submissionController.begin(
            { ...draftController.snapshot(), value: rawContent },
            {
              mentions: turnMentions.map((mention) => mention.path),
              localImages: turnLocalImages.map((image) => image.path),
            }
          );
        const selectedThreadSnapshot = threadRuntimeSnapshotsRef.current[targetChatId] ?? null;
        const goalObjective = supportsGoal ? parseGoalSlashObjective(content) : null;
        const optimisticGoalSurface = goalObjective
          ? buildOptimisticGoalBridgeUiSurface(
              targetChatId,
              goalObjective,
              new Date().toISOString()
            )
          : null;
        const previousBridgeUiSurfaces = optimisticGoalSurface
          ? [
              ...(selectedThreadSnapshot?.bridgeUiSurfaces ??
                activeBridgeUiSurfaces.filter((surface) => surface.threadId === targetChatId)),
            ]
          : null;
        const replaceGoalSurfaces = (surface: BridgeUiSurface) => {
          const nextSurfaces = [
            ...(previousBridgeUiSurfaces ?? []).filter(
              (entry) => entry.kind !== 'goal' && !entry.id.startsWith('goal-')
            ),
            surface,
          ];
          replaceThreadBridgeUiSurfaces(targetChatId, nextSurfaces);
          if (selectedChatIdRef.current === targetChatId) {
            setActiveBridgeUiSurfaces(nextSurfaces);
          }
        };
        const restoreGoalSurfaces = () => {
          if (!previousBridgeUiSurfaces) {
            return;
          }
          replaceThreadBridgeUiSurfaces(targetChatId, previousBridgeUiSurfaces);
          if (selectedChatIdRef.current === targetChatId) {
            setActiveBridgeUiSurfaces(previousBridgeUiSurfaces);
          }
        };
        const knownQueuedMessages = selectedThreadSnapshot?.queuedMessages ?? [];
        const likelyQueuesLocally =
          knownQueuedMessages.length > 0 ||
          (Boolean(activeTurnIdRef.current) ||
            Boolean(selectedThreadSnapshot?.activeTurnId) ||
            Boolean(selectedChatRef.current && isChatLikelyRunning(selectedChatRef.current)) ||
            Boolean(selectedThreadSnapshot?.pendingApproval?.requestId) ||
            Boolean(selectedThreadSnapshot?.pendingUserInputRequest?.requestId) ||
            Boolean(pendingApproval?.requestId) ||
            Boolean(pendingUserInputRequest?.requestId));
        const shouldShowOptimisticQueuedMessage =
          knownQueuedMessages.length === 0 && likelyQueuesLocally;
        const optimisticSentContent = !shouldShowOptimisticQueuedMessage
          ? toOptimisticUserContent(content, turnMentions, turnLocalImages)
          : null;
        const optimisticSentMessage = optimisticSentContent
          ? ({
              id: `msg-${Date.now()}`,
              role: 'user',
              content: optimisticSentContent,
              createdAt: new Date().toISOString(),
            } satisfies ChatTranscriptMessage)
          : null;
        const previousSelectedChatPreview =
          selectedChatRef.current?.id === targetChatId
            ? selectedChatRef.current.lastMessagePreview
            : selectedChat?.id === targetChatId
              ? selectedChat.lastMessagePreview
              : null;
        const optimisticQueuedMessage = shouldShowOptimisticQueuedMessage
          ? queueOptimisticQueuedMessage(targetChatId, content)
          : null;
        const clearOptimisticSentMessage = () => {
          if (!optimisticSentMessage) {
            return;
          }
          discardOptimisticUserMessage(targetChatId, optimisticSentMessage.id);
          setSelectedChat((prev) => {
            if (!prev || prev.id !== targetChatId) {
              return prev;
            }

            const nextMessages = prev.messages.filter(
              (message) => message.id !== optimisticSentMessage.id
            );
            if (nextMessages.length === prev.messages.length) {
              return prev;
            }

            const fallbackPreview =
              normalizeChatMessageMatchContent(
                nextMessages.length > 0 ? getMessageText(nextMessages[nextMessages.length - 1]) : ''
              ).slice(0, 120) || '';
            return {
              ...prev,
              lastMessagePreview:
                previousSelectedChatPreview ??
                (fallbackPreview.length > 0 ? fallbackPreview : prev.lastMessagePreview),
              messages: nextMessages,
            };
          });
        };

        try {
          setSending(true);
          setActivity({
            tone: 'running',
            title: 'Sending message',
          });
          bumpRunWatchdog();
          if (shouldClearComposer) {
            attachmentController.beginSubmission();
            setDraft('');
            submissionController.markCleared(submission, draftController.snapshot().revision);
          }
          if (optimisticGoalSurface) {
            replaceGoalSurfaces(optimisticGoalSurface);
          }
          if (optimisticSentMessage) {
            queueOptimisticUserMessage(targetChatId, optimisticSentMessage);
            setSelectedChat((prev) => {
              const baseChat =
                selectedChat?.id === targetChatId
                  ? selectedChat
                  : prev?.id === targetChatId
                    ? prev
                    : prev;
              if (!baseChat) {
                return prev;
              }
              const nowIso = new Date().toISOString();
              return {
                ...baseChat,
                status: 'running',
                updatedAt: nowIso,
                statusUpdatedAt: nowIso,
                lastError: undefined,
                lastMessagePreview:
                  normalizeChatMessageMatchContent(optimisticSentMessage.content).slice(0, 120) ||
                  baseChat.lastMessagePreview,
                messages: [...baseChat.messages, optimisticSentMessage],
              };
            });
            scrollToBottomReliable(true);
          }

          const result = await turnExecutionController.sendOrQueue(
            targetChatId,
            {
              content,
              mentions: turnMentions,
              localImages: turnLocalImages,
              cwd: selectedChat?.cwd,
              model: activeModelId ?? undefined,
              effort: activeEffort ?? undefined,
              serviceTier: activeServiceTier ?? undefined,
              approvalPolicy: activeApprovalPolicy,
              collaborationMode: resolvedCollaborationMode,
            },
            likelyQueuesLocally,
            submission.id
          );

          discardOptimisticQueuedMessage(targetChatId, optimisticQueuedMessage?.id);
          cacheThreadQueueState(targetChatId, result.queue);
          rememberChatModelPreference(
            targetChatId,
            activeModelId,
            selectedEffort ?? activeEffort,
            activeServiceTier
          );

          const isStillSelectedForResult = selectedChatIdRef.current === targetChatId;
          if (shouldClearComposer) {
            attachmentController.finishSubmission(isStillSelectedForResult);
          }
          submissionController.succeed(submission);

          if (isStillSelectedForResult) {
            setError(null);
          }

          if (result.disposition === 'queued') {
            clearOptimisticSentMessage();
            if (
              selectedChatIdRef.current === targetChatId &&
              (!selectedChatRef.current || !isChatLikelyRunning(selectedChatRef.current))
            ) {
              setActivity({
                tone: 'idle',
                title: 'Message queued',
              });
              clearRunWatchdog();
            }
            return true;
          }

          registerTurnStarted(targetChatId, result.turnId);
          const isStillSelected = selectedChatIdRef.current === targetChatId;
          if (isStillSelected) {
            setStoppingTurn(false);
            stopRequestedRef.current = false;
          }
          if (!shouldPreservePlan) {
            if (isStillSelected) {
              setActivePlan(null);
            }
            cacheThreadPlan(targetChatId, null);
          }
          if (isStillSelected) {
            setPendingUserInputRequest(null);
            setUserInputDrafts({});
            setUserInputError(null);
            setResolvingUserInput(false);
          }
          const resolvedUpdated = mergeChatWithPendingOptimisticMessages(result.chat);
          const autoEnabledPlan =
            !options?.suppressPlanModeAutoEnable &&
            shouldAutoEnablePlanModeFromChat(resolvedUpdated);
          if (autoEnabledPlan && isStillSelected) {
            setSelectedCollaborationMode('plan');
          }
          if (isStillSelected) {
            setSelectedChat(resolvedUpdated);
            if (resolvedUpdated.status === 'complete') {
              setActivity({
                tone: 'complete',
                title: 'Turn completed',
                detail:
                  autoEnabledPlan && resolvedCollaborationMode !== 'plan'
                    ? 'Plan mode enabled for the next turn'
                    : undefined,
              });
              clearRunWatchdog();
            } else if (resolvedUpdated.status === 'error') {
              restoreGoalSurfaces();
              setActivity({
                tone: 'error',
                title: 'Turn failed',
                detail: resolvedUpdated.lastError ?? undefined,
              });
              clearRunWatchdog();
            } else {
              // 'running' or 'idle' (server may not have started yet) — keep working
              setActivity({
                tone: 'running',
                title: 'Working',
              });
              bumpRunWatchdog();
            }
          }
        } catch (err) {
          if (shouldClearComposer) {
            const shouldRestoreDraft = submissionController.fail(
              submission,
              draftController.snapshot()
            );
            attachmentController.finishSubmission(false, shouldRestoreDraft);
            if (shouldRestoreDraft) {
              setDraft(submission.draft);
            }
          }
          restoreGoalSurfaces();
          clearOptimisticSentMessage();
          discardOptimisticQueuedMessage(targetChatId, optimisticQueuedMessage?.id);
          if (selectedChatIdRef.current === targetChatId) {
            handleTurnFailure(err);
          }
          return false;
        } finally {
          if (selectedChatIdRef.current === targetChatId) {
            setSending(false);
          }
        }

        return true;
      },
      [
        activeAgentId,
        activeEffort,
        activeModelId,
        activeApprovalPolicy,
        activeServiceTier,
        api,
        attachmentController,
        activeBridgeUiSurfaces,
        draftController,
        cacheThreadPlan,
        cacheThreadQueueState,
        handleSlashCommand,
        pendingMentionPaths,
        pendingLocalImagePaths,
        pendingApproval?.requestId,
        pendingUserInputRequest?.requestId,
        selectedCollaborationMode,
        selectedChat,
        selectedChatId,
        handleTurnFailure,
        bumpRunWatchdog,
        clearRunWatchdog,
        discardOptimisticUserMessage,
        discardOptimisticQueuedMessage,
        mergeChatWithPendingOptimisticMessages,
        queueOptimisticUserMessage,
        queueOptimisticQueuedMessage,
        registerTurnStarted,
        replaceThreadBridgeUiSurfaces,
        rememberChatModelPreference,
        scrollToBottomReliable,
        submissionController,
      ]
    );

    const sendMessageContentRef = useRef(sendMessageContent);
    useEffect(() => {
      sendMessageContentRef.current = sendMessageContent;
    }, [sendMessageContent]);

    const sendMessage = useCallback(async () => {
      const draftSnapshot = draftController.snapshot();
      const content = draftSnapshot.value.trim();
      if (!content) {
        return;
      }

      if (uploadingAttachment) {
        setError('Please wait for attachments to finish uploading.');
        return;
      }

      if (hasFailedAttachmentUploads) {
        setError('Retry or remove failed attachments before sending.');
        return;
      }

      if (await handleSlashCommand(content)) {
        setDraft('');
        return;
      }

      const submission = submissionController.begin(draftSnapshot, {
        mentions: pendingMentionPaths,
        localImages: pendingLocalImagePaths,
      });
      await sendMessageContent(content, { allowSlashCommands: false, submission });
    }, [
      draft,
      draftController,
      handleSlashCommand,
      sendMessageContent,
      submissionController,
      pendingMentionPaths,
      pendingLocalImagePaths,
      uploadingAttachment,
      hasFailedAttachmentUploads,
    ]);

    const handleSteerQueuedMessage = useCallback(async () => {
      const threadId = selectedChatId?.trim();
      const queuedItems = threadId
        ? threadRuntimeSnapshotsRef.current[threadId]?.queuedMessages ?? []
        : [];
      const nextQueuedMessage = queuedItems[0] ?? null;
      const canSteer =
        Boolean(threadId) &&
        Boolean(nextQueuedMessage) &&
        !pendingApproval?.requestId &&
        !pendingUserInputRequest?.requestId;

      if (!threadId || !nextQueuedMessage || !canSteer) {
        return;
      }

      try {
        setError(null);
        bumpRunWatchdog();
        setQueueActionItemId(nextQueuedMessage.id);
        setQueueActionKind('steer');
        const response = await turnExecutionController.steer(threadId, nextQueuedMessage.id);
        cacheThreadQueueState(threadId, response.queue);
        scrollToBottomReliable(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setQueueActionItemId((previous) =>
          previous === nextQueuedMessage.id ? null : previous
        );
        setQueueActionKind((previous) => (previous === 'steer' ? null : previous));
      }
    }, [
      turnExecutionController,
      bumpRunWatchdog,
      cacheThreadQueueState,
      pendingApproval?.requestId,
      pendingUserInputRequest?.requestId,
      scrollToBottomReliable,
      selectedChatId,
    ]);

    const handleCancelQueuedMessage = useCallback(async (messageId: string) => {
      const threadId = selectedChatId?.trim();
      const normalizedMessageId = messageId.trim();
      if (!threadId || !normalizedMessageId) {
        return;
      }

      try {
        setError(null);
        setQueueActionItemId(normalizedMessageId);
        setQueueActionKind('cancel');
        const response = await turnExecutionController.cancelQueued(threadId, normalizedMessageId);
        cacheThreadQueueState(threadId, response.queue);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setQueueActionItemId((previous) =>
          previous === normalizedMessageId ? null : previous
        );
        setQueueActionKind((previous) => (previous === 'cancel' ? null : previous));
      }
    }, [
      selectedChatId,
      turnExecutionController,
      cacheThreadQueueState,
    ]);

    useEffect(() => {
      setQueueActionItemId(null);
      setQueueActionKind(null);
    }, [selectedChat?.id]);

    const handleInlineOptionSelect = useCallback(
      (value: string) => {
        const option = value.trim();
        if (!option) {
          return;
        }

        const cannotAutoSend =
          !selectedChatIdRef.current ||
          sendingRef.current ||
          creatingRef.current ||
          stoppingTurnRef.current;
        if (cannotAutoSend) {
          setDraft(option);
          return;
        }

        void sendMessageContentRef.current(option, { allowSlashCommands: false });
      },
      []
    );

    const installReplayRecoverySnapshot = useCallback(
      (snapshot: ReplayRecoverySnapshot) => {
        const approvalsByThread = new Map(
          snapshot.approvals.map((approval) => [approval.threadId, approval] as const)
        );
        const userInputsByThread = new Map(
          snapshot.userInputs.map((request) => [request.threadId, request] as const)
        );
        setBridgeCapabilities(snapshot.capabilities);
        setLiveAssistantByThread({});

        for (const { chat, queue } of snapshot.threads) {
          api.rememberChat(chat);
          const pendingThreadApproval = approvalsByThread.get(chat.id) ?? null;
          const pendingThreadUserInput = userInputsByThread.get(chat.id) ?? null;
          const running = isChatLikelyRunning(chat);
          const plan = chat.latestPlan
            ? toPersistedActivePlanState(chat.latestPlan, chat.updatedAt)
            : null;
          threadRuntimeSnapshotsRef.current[chat.id] = {
            activity: pendingThreadApproval
              ? { tone: 'idle', title: 'Waiting for approval' }
              : pendingThreadUserInput
                ? { tone: 'idle', title: 'Waiting for input' }
                : running
                  ? { tone: 'running', title: 'Working' }
                  : chat.status === 'error'
                    ? { tone: 'error', title: 'Turn failed', detail: chat.lastError }
                    : chat.status === 'complete'
                      ? { tone: 'complete', title: 'Turn completed' }
                      : { tone: 'idle', title: 'Ready' },
            activeCommands: [],
            latestCommand: null,
            streamingText: null,
            pendingApproval: pendingThreadApproval,
            pendingUserInputRequest: pendingThreadUserInput,
            bridgeUiSurfaces: [],
            queuedMessages: [...queue.pendingSteers, ...queue.items],
            pendingSteerMessageIds: queue.pendingSteers.map((item) => item.id),
            waitingForToolCalls: queue.waitingForToolCalls,
            steeringInFlight: queue.steeringInFlight,
            queuedMessageError: queue.lastError,
            contextUsage: readThreadContextUsage(chat.acpUsage),
            plan,
            activeTurnId: chat.activeTurnId ?? chat.acpActive?.sourceTurnId ?? null,
            runWatchdogUntil: running ? Date.now() + RUN_WATCHDOG_MS : 0,
            updatedAtMs: Date.now(),
          };
          if (plan) {
            chatPlanSnapshotsRef.current[chat.id] = plan;
          } else {
            delete chatPlanSnapshotsRef.current[chat.id];
          }
          bridgeUiSurfaceSnapshotsRef.current[chat.id] = [];
        }

        const selectedId = chatIdRef.current;
        const selectedSnapshot = snapshot.threads.find(({ chat }) => chat.id === selectedId);
        if (selectedSnapshot) {
          const selected = mergeChatWithPendingOptimisticMessages(selectedSnapshot.chat);
          setSelectedChat((previous) =>
            previous?.id === selected.id ? resolveEquivalentChat(previous, selected) : selected
          );
          setTranscriptContinuationState(getTranscriptContinuationState(selected));
          setStoppingTurn(false);
          setError(null);
          applyThreadRuntimeSnapshot(selected.id);
        } else {
          setActiveCommands([]);
          setStreamingText(null);
          setPendingApproval(null);
          setPendingUserInputRequest(null);
          setUserInputDrafts({});
          setActivePlan(null);
          setActiveBridgeUiSurfaces([]);
          setActiveTurnId(null);
        }
        bumpAgentRuntimeRevision();
      },
      [
        api,
        applyThreadRuntimeSnapshot,
        bumpAgentRuntimeRevision,
        mergeChatWithPendingOptimisticMessages,
        readThreadContextUsage,
      ]
    );

    const recoverReplayGap = useCallback(
      (resumeAfterEventId: number | null, acknowledge: boolean) => {
        const generation = replayRecoveryGenerationRef.current + 1;
        replayRecoveryGenerationRef.current = generation;
        replayRecoveryAbortControllerRef.current?.abort();
        const abortController = new AbortController();
        replayRecoveryAbortControllerRef.current = abortController;
        if (replayRecoveryRetryTimerRef.current) {
          clearTimeout(replayRecoveryRetryTimerRef.current);
          replayRecoveryRetryTimerRef.current = null;
        }

        const trackedThreadIds = () => [
          chatIdRef.current,
          agentDetailThreadId,
          agentRootThreadIdRef.current,
          ...relatedAgentThreads.map((thread) => thread.id),
          ...(api.peekChats()?.map((thread) => thread.id) ?? []),
          ...(api.peekAllChats()?.map((thread) => thread.id) ?? []),
          ...Object.keys(threadRuntimeSnapshotsRef.current),
          ...Object.keys(pendingOptimisticUserMessagesRef.current),
          ...Object.keys(pendingOptimisticQueuedMessagesRef.current),
        ];

        const attempt = async () => {
          try {
            const snapshot = await fetchReplayRecoverySnapshot(
              api,
              trackedThreadIds(),
              abortController.signal
            );
            if (generation !== replayRecoveryGenerationRef.current) return;
            installReplayRecoverySnapshot(snapshot);
            replayRecoveryEpochResetPendingRef.current = false;
            if (acknowledge && resumeAfterEventId !== null) {
              ws.acknowledgeSnapshotRecovery(resumeAfterEventId);
            }
          } catch (recoveryError) {
            if (generation !== replayRecoveryGenerationRef.current) return;
            if (recoveryError instanceof ReplayRecoveryProtocolError) {
              replayRecoveryGenerationRef.current += 1;
              replayRecoveryAbortControllerRef.current = null;
              if (replayRecoveryEpochResetPendingRef.current) {
                setError(
                  'Replay recovery exceeded the bridge protocol limit after reconnect. Reopen the connection after reducing loaded thread history.'
                );
                return;
              }
              replayRecoveryEpochResetPendingRef.current = true;
              ws.resetRecoveryEpoch();
              return;
            }
            replayRecoveryRetryTimerRef.current = setTimeout(() => {
              replayRecoveryRetryTimerRef.current = null;
              void attempt();
            }, 1_000);
          }
        };
        void attempt();
      },
      [
        agentDetailThreadId,
        api,
        installReplayRecoverySnapshot,
        relatedAgentThreads,
        ws,
      ]
    );

    useEffect(() => {
      const pendingApprovalId = pendingApproval?.requestId;
      const pendingUserInputRequestId = pendingUserInputRequest?.requestId;

      return ws.onEvent((event: RpcNotification) => {
        const currentId = chatIdRef.current;

        const agUiEnvelope = parseAgUiEventNotification(event);
        if (agUiEnvelope) {
          const agUiEvent = agUiEnvelope.event;
          setLiveAssistantByThread((previous) =>
            updateAgUiLiveAssistantMessages(previous, agUiEnvelope)
          );
          if (
            agUiEvent.type === 'CUSTOM' &&
            agUiEvent.name === 'tethercode.dev/subagent'
          ) {
            scheduleAgentThreadsRefresh(agUiEnvelope.threadId);
            if (agUiEnvelope.threadId === currentId) {
              schedulePinnedScrollToBottom(true);
            }
            return;
          }
          if (agUiEvent.type === 'TEXT_MESSAGE_CONTENT') {
            if (agUiEnvelope.threadId === currentId) {
              schedulePinnedScrollToBottom(true);
            }
            return;
          }
          if (agUiEvent.type === 'RUN_STARTED') {
            const sourceTurnId = agUiEnvelope.sourceTurnId ?? agUiEnvelope.runId;
            clearLiveReasoningMessage(agUiEnvelope.threadId);
            delete planItemTurnIdByThreadRef.current[agUiEnvelope.threadId];
            upsertThreadRuntimeSnapshot(agUiEnvelope.threadId, () => ({
              activeCommands: [],
              streamingText: null,
            }));
            if (agUiEnvelope.threadId === currentId) {
              registerTurnStarted(agUiEnvelope.threadId, sourceTurnId);
              setError(null);
              setActiveTurnId(sourceTurnId);
              setActiveCommands([]);
              setActivity({ tone: 'running', title: 'Working' });
              bumpRunWatchdog();
            } else {
              cacheThreadTurnState(agUiEnvelope.threadId, {
                activeTurnId: sourceTurnId,
                runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
              });
              cacheThreadActivity(agUiEnvelope.threadId, {
                tone: 'running',
                title: 'Working',
              });
            }
            return;
          }
          if (agUiEvent.type === 'RUN_FINISHED' || agUiEvent.type === 'RUN_ERROR') {
            const failed = agUiEvent.type === 'RUN_ERROR';
            const interruptedByUser = failed &&
              ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(agUiEvent.code ?? '') &&
              stopRequestedRef.current;
            const planTurnId = planItemTurnIdByThreadRef.current[agUiEnvelope.threadId] ?? null;
            delete planItemTurnIdByThreadRef.current[agUiEnvelope.threadId];
            clearLiveReasoningMessage(agUiEnvelope.threadId);
            delete threadReasoningBuffersRef.current[agUiEnvelope.threadId];
            const terminalActivity: ActivityState = failed
              ? interruptedByUser
                ? { tone: 'complete', title: 'Turn stopped' }
                : { tone: 'error', title: 'Turn failed', detail: agUiEvent.message }
              : { tone: 'complete', title: 'Turn completed' };
            upsertThreadRuntimeSnapshot(agUiEnvelope.threadId, () => ({
              activity: terminalActivity,
              activeCommands: [],
              streamingText: null,
              pendingUserInputRequest: null,
              activeTurnId: null,
              runWatchdogUntil: 0,
            }));
            bumpAgentRuntimeRevision();
            if (agUiEnvelope.threadId === currentId) {
              clearRunWatchdog();
              setActiveCommands([]);
              setStreamingText(null);
              setPendingUserInputRequest(null);
              setUserInputDrafts({});
              setUserInputError(null);
              setResolvingUserInput(false);
              setActiveTurnId(null);
              setStoppingTurn(false);
              stopRequestedRef.current = false;
              hadCommandRef.current = false;
              reasoningSummaryRef.current = {};
              reasoningBufferRef.current = '';
              setError(failed && !interruptedByUser ? agUiEvent.message : null);
              if (interruptedByUser) {
                appendStopSystemMessageIfNeeded();
              }
              setActivity(terminalActivity);
              const terminalStatusAt = new Date().toISOString();
              setSelectedChat((previous) =>
                previous?.id === agUiEnvelope.threadId
                  ? {
                      ...previous,
                      status: failed && !interruptedByUser ? 'error' : 'complete',
                      updatedAt: terminalStatusAt,
                      statusUpdatedAt: terminalStatusAt,
                      lastError: failed && !interruptedByUser ? agUiEvent.message : undefined,
                    }
                  : previous
              );
              if (!failed && planTurnId) {
                setPendingPlanImplementationPrompts((previous) => ({
                  ...previous,
                  [agUiEnvelope.threadId]: {
                    threadId: agUiEnvelope.threadId,
                    turnId: planTurnId,
                  },
                }));
              } else {
                clearPendingPlanImplementationPrompt(agUiEnvelope.threadId);
              }
              loadChat(agUiEnvelope.threadId).catch(() => {});
            } else if (agentDetailThreadId === agUiEnvelope.threadId) {
              void loadAgentDetail(agUiEnvelope.threadId);
            }
            return;
          }
          return;
        }

        if (event.method === 'bridge/events/snapshotRequired') {
          const params = toRecord(event.params);
          const resumeAfterEventId = readNumber(params?.resumeAfterEventId);
          const reason = readString(params?.reason);
          clearRunWatchdog();
          setActiveCommands([]);
          setStreamingText(null);
          setLiveAssistantByThread({});
          setActiveTurnId(null);
          setPendingApproval(null);
          setPendingUserInputRequest(null);
          setActivePlan(null);
          setActiveBridgeUiSurfaces([]);
          if (currentId) {
            replaceThreadBridgeUiSurfaces(currentId, []);
          }
          reasoningSummaryRef.current = {};
          reasoningBufferRef.current = '';
          recoverReplayGap(resumeAfterEventId, reason !== 'recoveryOverflow');
          if (agentDetailThreadId) {
            scheduleAgentThreadsRefresh(agentDetailThreadId);
          }
          return;
        }


        if (event.method === 'thread/name/updated') {
          const params = toRecord(event.params);
          const threadId = extractNotificationThreadId(params);
          if (!threadId || threadId !== currentId) {
            return;
          }

          const threadName =
            readString(params?.threadName) ?? readString(params?.thread_name);
          if (threadName && threadName.trim()) {
            setSelectedChat((prev) =>
              prev
                ? {
                    ...prev,
                    title: threadName,
                  }
                : prev
            );
          } else {
            loadChat(threadId, { preserveRuntimeState: true }).catch(() => {});
          }
          return;
        }


        if (event.method === 'thread/tokenUsage/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          const contextUsage = readThreadContextUsage(params);
          if (!threadId || !contextUsage) {
            return;
          }
          cacheThreadContextUsage(threadId, contextUsage);
          if (threadId === currentId) {
          }
          return;
        }

        if (event.method === 'item/started') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          const item = toRecord(params?.item);
          const itemType = readString(item?.type);
          const itemTurnId =
            readString(params?.turnId) ?? readString(params?.turn_id) ?? null;
          if (itemType === 'plan' && itemTurnId) {
            planItemTurnIdByThreadRef.current[threadId] = itemTurnId;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            const startedToolEvent = describeStartedToolEvent(item);
            if (startedToolEvent) {
              cacheThreadActiveCommand(
                threadId,
                startedToolEvent.eventType,
                startedToolEvent.detail
              );
            }
            if (itemType === 'commandExecution') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }

            if (itemType === 'fileChange') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }

            if (itemType === 'mcpToolCall') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }

            if (itemType === 'plan') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Planning',
              });
              return;
            }

            if (itemType === 'reasoning') {
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
              return;
            }
            return;
          }

          bumpRunWatchdog();
          const startedToolEvent = describeStartedToolEvent(item);
          if (startedToolEvent) {
            cacheThreadActiveCommand(
              threadId,
              startedToolEvent.eventType,
              startedToolEvent.detail
            );
            pushActiveCommand(
              threadId,
              startedToolEvent.eventType,
              startedToolEvent.detail
            );
          }

          if (itemType === 'commandExecution') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'fileChange') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'mcpToolCall') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'toolCall') {
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'plan') {
            setSelectedCollaborationMode('plan');
            setActivity({
              tone: 'running',
              title: 'Planning',
            });
            return;
          }

          if (itemType === 'reasoning') {
            upsertLiveReasoningMessage(threadId);
            setActivity({
              tone: 'running',
              title: 'Working',
            });
            return;
          }
        }

        if (event.method === 'item/plan/delta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          const turnId = readString(params?.turnId) ?? 'unknown-turn';
          planItemTurnIdByThreadRef.current[threadId] = turnId;
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Planning',
            });
            const rawDelta = readString(params?.delta) ?? '';
            cacheThreadPlan(threadId, (previous) =>
              buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
            );
            return;
          }

          setSelectedCollaborationMode('plan');
          bumpRunWatchdog();
          const rawDelta = readString(params?.delta) ?? '';
          setActivePlan((prev) =>
            buildNextPlanStateFromDelta(prev, threadId, turnId, rawDelta)
          );
          cacheThreadPlan(threadId, (previous) =>
            buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
          );
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Planning'
              ? prev
              : {
                  tone: 'running',
                  title: 'Planning',
                }
          );
          return;
        }

        if (event.method === 'item/reasoning/summaryPartAdded') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            return;
          }

          bumpRunWatchdog();
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;
          if (summaryKey && reasoningSummaryRef.current[summaryKey] === undefined) {
            reasoningSummaryRef.current[summaryKey] = '';
          }

          return;
        }

        if (event.method === 'item/reasoning/summaryTextDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          const delta = readString(params?.delta);
          if (threadId !== currentId) {
            if (delta) {
              const buffer = `${threadReasoningBuffersRef.current[threadId] ?? ''}${delta}`;
              threadReasoningBuffersRef.current[threadId] = buffer;
              const heading = extractFirstBoldSnippet(buffer, 56);
              const detail = heading
                ? undefined
                : toReasoningActivityDetail(buffer, heading, 64);
              const title = heading ?? 'Working';
              cacheThreadTurnState(threadId, {
                runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
              });
              cacheThreadActivity(threadId, {
                tone: 'running',
                title,
                detail,
              });
            }
            return;
          }

          bumpRunWatchdog();
          const itemId = readString(params?.itemId);
          const summaryIndex = readNumber(params?.summaryIndex);
          const summaryKey =
            itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;

          let heading = extractFirstBoldSnippet(delta, 56);
          let detail = heading ? undefined : toReasoningActivityDetail(delta ?? '', heading, 64);
          if (summaryKey) {
            const accumulated = (reasoningSummaryRef.current[summaryKey] ?? '') + (delta ?? '');
            reasoningSummaryRef.current[summaryKey] = accumulated;
            heading = extractFirstBoldSnippet(accumulated, 56) ?? heading;
            detail = heading ? undefined : toReasoningActivityDetail(accumulated, heading, 64);
          }

          setActivity((prev) => {
            const title =
              heading ?? (prev.tone === 'running' && prev.title.trim() ? prev.title : 'Working');
            if (
              prev.tone === 'running' &&
              prev.title === title &&
              prev.detail === detail
            ) {
              return prev;
            }
            return {
              tone: 'running',
              title,
              detail,
            };
          });
          return;
        }

        if (event.method === 'item/reasoning/textDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            return;
          }

          bumpRunWatchdog();
          const delta = readString(params?.delta);
          if (delta) {
            upsertLiveReasoningMessage(threadId, delta);
          }
          setActivity((prev) =>
            prev.tone === 'running'
              ? prev
              : {
                  tone: 'running',
                  title: 'Working',
                }
          );
          return;
        }

        if (event.method === 'item/commandExecution/outputDelta') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Working'
              ? prev
              : {
                  tone: 'running',
                  title: 'Working',
                }
          );
          return;
        }

        if (event.method === 'item/mcpToolCall/progress') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' && prev.title === 'Working'
              ? prev
              : {
                  tone: 'running',
                  title: 'Working',
                }
          );
          return;
        }

        if (event.method === 'item/commandExecution/terminalInteraction') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (event.method === 'turn/plan/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id) ?? currentId;
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Planning',
            });
            const planUpdate = toTurnPlanUpdate(params, threadId);
            if (planUpdate) {
              cacheThreadPlan(threadId, (previous) =>
                buildNextPlanStateFromUpdate(previous, planUpdate)
              );
            }
            return;
          }

          setSelectedCollaborationMode('plan');
          bumpRunWatchdog();
          const planUpdate = toTurnPlanUpdate(params, threadId);
          if (planUpdate) {
            setActivePlan((prev) => buildNextPlanStateFromUpdate(prev, planUpdate));
            cacheThreadPlan(threadId, (previous) =>
              buildNextPlanStateFromUpdate(previous, planUpdate)
            );
          }
          setActivity({
            tone: 'running',
            title: 'Planning',
          });
          return;
        }

        if (event.method === 'turn/diff/updated') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }
          if (threadId !== currentId) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          bumpRunWatchdog();
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        // Command completion blocks
        if (event.method === 'item/completed') {
          const params = toRecord(event.params);
          const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
          if (!threadId) {
            return;
          }

          const item = toRecord(params?.item);
          const itemType = readString(item?.type);
          if (threadId !== currentId) {
            const completedToolEvent = describeCompletedToolEvent(item);
            if (completedToolEvent) {
              cacheThreadActiveCommand(
                threadId,
                completedToolEvent.eventType,
                completedToolEvent.detail
              );
            }
            if (itemType === 'commandExecution') {
              const status = readString(item?.status);
              const failed = status === 'failed' || status === 'error';
              cacheThreadActivity(threadId, {
                tone: failed ? 'error' : 'running',
                title: failed ? 'Turn failed' : 'Working',
              });
            }
            return;
          }

          const completedToolEvent = describeCompletedToolEvent(item);
          if (completedToolEvent) {
            cacheThreadActiveCommand(
              threadId,
              completedToolEvent.eventType,
              completedToolEvent.detail
            );
            pushActiveCommand(
              threadId,
              completedToolEvent.eventType,
              completedToolEvent.detail
            );
          }

          if (itemType === 'commandExecution') {
            const status = readString(item?.status);
            const failed = status === 'failed' || status === 'error';
            hadCommandRef.current = true;
            setActivity({
              tone: failed ? 'error' : 'running',
              title: failed ? 'Turn failed' : 'Working',
            });
          }
          if (itemType === 'toolCall') {
          }
          return;
        }

        if (event.method === 'bridge/thread/queue/updated') {
          const parsed = parseBridgeThreadQueueState(event.params);
          if (!parsed) {
            return;
          }

          cacheThreadQueueState(parsed.threadId, parsed);
          return;
        }

        if (event.method === 'bridge/approval.requested') {
          const parsed = toPendingApproval(event.params);
          if (parsed) {
            cacheThreadPendingApproval(parsed.threadId, parsed);
            cacheThreadActivity(parsed.threadId, {
              tone: 'idle',
              title: 'Waiting for approval',
              detail: parsed.command ?? parsed.kind,
            });

            if (parsed.threadId === currentId) {
              clearRunWatchdog();
              setPendingApproval(parsed);
              setActivity({
                tone: 'idle',
                title: 'Waiting for approval',
                detail: parsed.command ?? parsed.kind,
              });
            }
          }
          return;
        }

        if (event.method === 'bridge/userInput.requested') {
          const parsed = toPendingUserInputRequest(event.params);
          if (parsed) {
            cacheThreadPendingUserInputRequest(parsed.threadId, parsed);
            cacheThreadActivity(parsed.threadId, {
              tone: 'idle',
              title: 'Clarification needed',
              detail: parsed.questions[0]?.header ?? 'Answer required',
            });

            if (parsed.threadId === currentId) {
              setSelectedCollaborationMode('plan');
              clearRunWatchdog();
              setPendingUserInputRequest(parsed);
              setUserInputDrafts(buildUserInputDrafts(parsed));
              setUserInputError(null);
              setResolvingUserInput(false);
              setActivity({
                tone: 'idle',
                title: 'Clarification needed',
                detail: parsed.questions[0]?.header ?? 'Answer required',
              });
            }
          }
          return;
        }

        if (event.method === 'bridge/userInput.resolved') {
          const params = toRecord(event.params);
          const resolvedId = readString(params?.id);
          const selectedPendingUserInputId = currentId
            ? threadRuntimeSnapshotsRef.current[currentId]?.pendingUserInputRequest?.requestId ??
              pendingUserInputRequestId
            : pendingUserInputRequestId;
          if (resolvedId) {
            for (const [threadId, snapshot] of Object.entries(
              threadRuntimeSnapshotsRef.current
            )) {
              if (snapshot.pendingUserInputRequest?.requestId !== resolvedId) {
                continue;
              }
              cacheThreadPendingUserInputRequest(threadId, null);
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Input submitted',
              });
            }
          }
          if (selectedPendingUserInputId && resolvedId === selectedPendingUserInputId) {
            bumpRunWatchdog();
            setPendingUserInputRequest(null);
            setUserInputDrafts({});
            setUserInputError(null);
            setResolvingUserInput(false);
            setActivity({
              tone: 'running',
              title: 'Input submitted',
            });
          }
          return;
        }

        if (event.method === 'bridge/ui.present' || event.method === 'bridge/ui.update') {
          const surface = toBridgeUiSurface(event.params);
          if (!surface) {
            return;
          }

          cacheThreadBridgeUiSurface(surface.threadId, surface);
          if (surface.threadId === currentId) {
            setActiveBridgeUiSurfaces((previous) =>
              upsertBridgeUiSurfaceList(previous, surface)
            );
          }
          return;
        }

        if (event.method === 'bridge/ui.dismiss') {
          const params = toRecord(event.params);
          const surfaceId = readString(params?.id);
          const threadId = readString(params?.threadId);
          if (!surfaceId) {
            return;
          }

          removeThreadBridgeUiSurface(surfaceId, threadId);
          setActiveBridgeUiSurfaces((previous) =>
            removeBridgeUiSurfaceFromList(previous, surfaceId)
          );
          return;
        }

        if (event.method === 'bridge/approval.resolved') {
          const params = toRecord(event.params);
          const resolvedId = readString(params?.id);
          const selectedPendingApprovalId = currentId
            ? threadRuntimeSnapshotsRef.current[currentId]?.pendingApproval?.requestId ??
              pendingApprovalId
            : pendingApprovalId;
          if (resolvedId) {
            for (const [threadId, snapshot] of Object.entries(
              threadRuntimeSnapshotsRef.current
            )) {
              if (snapshot.pendingApproval?.requestId !== resolvedId) {
                continue;
              }
              cacheThreadPendingApproval(threadId, null);
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Approval resolved',
              });
            }
          }
          if (selectedPendingApprovalId && resolvedId === selectedPendingApprovalId) {
            bumpRunWatchdog();
            setPendingApproval(null);
            setActivity({
              tone: 'running',
              title: 'Approval resolved',
            });
          }
          return;
        }

        // Externally-started turns (e.g. from CLI) broadcast this event.
        // Do a lightweight status check — don't call loadChat() which would
        // wipe streaming text, active commands, and the watchdog.
        if (event.method === 'thread/status/changed') {
          const params = toRecord(event.params);
          const threadId = extractNotificationThreadId(params);
          const statusHint = extractExternalStatusHint(params);
          const hasExplicitRunningStatus = Boolean(
            statusHint && EXTERNAL_RUNNING_STATUS_HINTS.has(statusHint)
          );
          const hasExplicitTerminalStatus = Boolean(
            statusHint &&
              (EXTERNAL_ERROR_STATUS_HINTS.has(statusHint) ||
                EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint))
          );
          if (threadId && threadId === currentId) {
            if (!hasExplicitTerminalStatus) {
              bumpRunWatchdog();
              setActivity((prev) =>
                prev.tone === 'running'
                  ? prev
                  : { tone: 'running', title: 'Working' }
              );
            }

            api
              .getChatSummary(threadId)
              .then((summary) => {
                if (chatIdRef.current !== threadId) {
                  return; // user switched away
                }

                setSelectedChat((prev) => {
                  if (!prev || prev.id !== summary.id) {
                    return prev;
                  }
                  return mergeChatSummaryPreservingMessages(prev, summary);
                });

                const shouldPreserveRunning =
                  !hasExplicitTerminalStatus &&
                  runWatchdogUntilRef.current > Date.now();
                const shouldShowRunning =
                  hasExplicitRunningStatus ||
                  isChatSummaryLikelyRunning(summary) ||
                  shouldPreserveRunning;

                if (shouldShowRunning) {
                  bumpRunWatchdog();
                  setActivity((prev) =>
                    prev.tone === 'running'
                      ? prev
                      : { tone: 'running', title: 'Working' }
                  );
                } else {
                  clearRunWatchdog();
                  cacheThreadTurnState(threadId, {
                    activeTurnId: null,
                    runWatchdogUntil: 0,
                  });
                  setActiveTurnId(null);
                  setStoppingTurn(false);
                  if (!pendingApprovalId && !pendingUserInputRequestId) {
                    setActiveCommands([]);
                    setStreamingText(null);
                    reasoningSummaryRef.current = {};
                    reasoningBufferRef.current = '';
                    hadCommandRef.current = false;
                    setActivity(() => {
                      if (statusHint && EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint)) {
                        return {
                          tone: 'complete',
                          title: 'Turn completed',
                        };
                      }

                      return summary.status === 'error'
                        ? {
                            tone: 'error',
                            title: 'Turn failed',
                            detail: summary.lastError ?? undefined,
                          }
                        : summary.status === 'complete'
                          ? {
                              tone: 'complete',
                              title: 'Turn completed',
                            }
                          : {
                              tone: 'idle',
                              title: 'Ready',
                            };
                    });
                  }
                }
              })
              .catch(() => {});

            scheduleExternalStatusFullSync(threadId);
          } else if (threadId) {
            if (!hasExplicitTerminalStatus) {
              cacheThreadTurnState(threadId, {
                runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
              });
              cacheThreadActivity(threadId, {
                tone: 'running',
                title: 'Working',
              });
            }
            void refreshPendingApprovalsForThread(threadId);
          }
          return;
        }

        if (event.method === 'bridge/connection/state') {
          const params = toRecord(event.params);
          const status = readString(params?.status);
          if (status === 'connected') {
            clearDeferredDisconnectActivity();
            setBridgeRecoveryBannerVisible(false);
            if (!currentId) {
              return;
            }
            setActivity((prev) =>
              prev.tone === 'running'
                ? prev
                : {
                    tone: 'idle',
                    title: 'Connected',
                  }
            );
            clearRunWatchdog();
            loadChat(currentId, { preserveRuntimeState: true }).catch(() => {});
            return;
          }

          if (status === 'disconnected') {
            clearRunWatchdog();
            if (appStateRef.current !== 'active') {
              clearDeferredDisconnectActivity();
              return;
            }
            scheduleDisconnectActivity();
          }
        }
      });
    }, [
      ws,
      api,
      pendingApproval?.requestId,
      pendingUserInputRequest?.requestId,
      recoverReplayGap,
      loadChat,
      loadAgentDetail,
      scheduleAgentThreadsRefresh,
      appendStopSystemMessageIfNeeded,
      agentDetailThreadId,
      bumpRunWatchdog,
      bumpAgentRuntimeRevision,
      clearDeferredDisconnectActivity,
      cacheThreadActiveCommand,
      cacheThreadActivity,
      cacheThreadContextUsage,
      cacheThreadBridgeUiSurface,
      cacheThreadPendingApproval,
      cacheThreadPendingUserInputRequest,
      cacheThreadPlan,
      cacheThreadStreamingDelta,
      cacheThreadTurnState,
      clearPendingPlanImplementationPrompt,
      clearLiveReasoningMessage,
      clearRunWatchdog,
      readThreadContextUsage,
      replaceThreadBridgeUiSurfaces,
      refreshPendingApprovalsForThread,
      removeThreadBridgeUiSurface,
      scheduleDisconnectActivity,
      scheduleExternalStatusFullSync,
      registerTurnStarted,
      pushActiveCommand,
      scrollToBottomIfPinned,
      upsertLiveReasoningMessage,
      upsertThreadRuntimeSnapshot,
    ]);

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

    const dismissUserInputRequest = useCallback(
      async (action: 'decline' | 'cancel') => {
        if (!pendingUserInputRequest || resolvingUserInput) return;
        setResolvingUserInput(true);
        try {
          await approvalController.dismissUserInput(pendingUserInputRequest, action);
          cacheThreadPendingUserInputRequest(pendingUserInputRequest.threadId, null);
          setPendingUserInputRequest(null);
          setUserInputDrafts({});
          setUserInputError(null);
        } catch (err) {
          setUserInputError((err as Error).message);
        } finally {
          setResolvingUserInput(false);
        }
      },
      [
        approvalController,
        cacheThreadPendingUserInputRequest,
        pendingUserInputRequest,
        resolvingUserInput,
      ]
    );

    const dismissBridgeUiSurface = useCallback(
      async (surface: BridgeUiSurface) => {
        removeThreadBridgeUiSurface(surface.id, surface.threadId);
        setActiveBridgeUiSurfaces((previous) =>
          removeBridgeUiSurfaceFromList(previous, surface.id)
        );
        try {
          await api.dismissBridgeUiSurface(surface.id, surface.threadId);
        } catch (err) {
          setError((err as Error).message);
        }
      },
      [api, removeThreadBridgeUiSurface]
    );

    const handleBridgeUiAction = useCallback(
      async (surface: BridgeUiSurface, action: BridgeUiAction) => {
        try {
          await api.resolveBridgeUiSurface(surface.id, {
            threadId: surface.threadId,
            turnId: surface.turnId ?? null,
            actionId: action.id,
          });
          if (action.dismissesSurface !== false) {
            removeThreadBridgeUiSurface(surface.id, surface.threadId);
            setActiveBridgeUiSurfaces((previous) =>
              removeBridgeUiSurfaceFromList(previous, surface.id)
            );
          }
        } catch (err) {
          setError((err as Error).message);
        }
      },
      [api, removeThreadBridgeUiSurface]
    );

    const handleOpenGit = useCallback(() => {
      if (!selectedChat) {
        return;
      }
      onOpenGit(selectedChat);
    }, [onOpenGit, selectedChat]);

    const handleComposerFocus = useCallback(() => {
      requestAnimationFrame(() => {
        scrollToBottomReliable(true);
      });
    }, [scrollToBottomReliable]);

    const handleSubmit = selectedChat ? sendMessage : createChat;
    const isTurnLoading = sending || creating;
    const isLoading = isTurnLoading || uploadingAttachment;
    const isOpeningChat = Boolean(openingChatId);
    const shouldShowComposer = !isOpeningChat;
    const isTurnLikelyRunning =
      Boolean(activeTurnId) || (selectedChat ? isChatLikelyRunning(selectedChat) : false);
    const hasRunWatchdog = runWatchdogUntilRef.current > runWatchdogNow;

    useEffect(() => {
      if (activity.tone !== 'running') {
        return;
      }

      const title = activity.title.trim() || 'Working';
      const detail = activity.detail?.trim() ?? '';
      const shouldHold = Boolean(detail) || !GENERIC_RUNNING_ACTIVITY_TITLES.has(title.toLowerCase());
      if (!shouldHold) {
        return;
      }

      const nextHeldActivity: ActivityState = {
        tone: 'running',
        title,
        detail: detail || undefined,
      };
      setHeldActivity(nextHeldActivity);
      if (heldActivityTimeoutRef.current) {
        clearTimeout(heldActivityTimeoutRef.current);
      }
      heldActivityTimeoutRef.current = setTimeout(() => {
        heldActivityTimeoutRef.current = null;
        setHeldActivity(null);
      }, ACTIVITY_DETAIL_HOLD_MS);
    }, [activity.detail, activity.title, activity.tone]);

    useEffect(() => {
      clearHeldActivity();
    }, [clearHeldActivity, openingChatId, selectedChat?.id]);

    useEffect(
      () => () => {
        if (heldActivityTimeoutRef.current) {
          clearTimeout(heldActivityTimeoutRef.current);
          heldActivityTimeoutRef.current = null;
        }
      },
      []
    );

    useEffect(() => {
      if (
        activity.tone !== 'running' ||
        isLoading ||
        isOpeningChat ||
        pendingApproval ||
        pendingUserInputRequest ||
        isTurnLikelyRunning ||
        hasRunWatchdog
      ) {
        return;
      }

      setActivity((prev) => {
        if (prev.tone !== 'running') {
          return prev;
        }

        if (selectedChat?.status === 'complete') {
          return {
            tone: 'complete',
            title: 'Turn completed',
          };
        }

        return {
          tone: 'idle',
          title: 'Ready',
        };
      });
    }, [
      activity.tone,
      hasRunWatchdog,
      isLoading,
      isOpeningChat,
      isTurnLikelyRunning,
      pendingApproval,
      pendingUserInputRequest,
      selectedChat,
    ]);

    const showBridgeRecoveryBanner = bridgeRecoveryBannerVisible && !ws.isConnected;
    const turnFailureDetail =
      error?.trim() ||
      (selectedChat?.status === 'error' ? selectedChat.lastError?.trim() ?? null : null) ||
      (activity.tone === 'error' ? activity.detail?.trim() ?? null : null);
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
    const renderComposer = (overlay: boolean) => (
      <View
        onLayout={
          overlay
            ? (event) => {
                const nextHeight = Math.ceil(event.nativeEvent.layout.height);
                setComposerHeight((previous) => (previous === nextHeight ? previous : nextHeight));
              }
            : undefined
        }
        style={[
          styles.composerContainer,
          overlay ? styles.composerContainerOverlay : null,
          overlay ? { bottom: composerOverlayInset } : null,
          !overlay && !keyboardVisible ? styles.composerContainerResting : null,
        ]}
      >
        {visibleError ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorText}>{visibleError}</Text> : null}
        {showBridgeRecoveryBanner ? (
          <View style={styles.bridgeRecoveryBanner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
            <View style={styles.bridgeRecoveryBannerTopRow}>
              <View style={styles.bridgeRecoveryBannerIconWrap}>
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="warning-outline"
                  size={16}
                  color={theme.colors.warning}
                />
              </View>
              <View style={styles.bridgeRecoveryBannerCopy}>
                <Text style={styles.bridgeRecoveryBannerTitle}>
                  Bridge disconnected
                </Text>
                <Text style={styles.bridgeRecoveryBannerBody}>
                  Start the bridge on your computer to continue. The app will reconnect automatically.
                </Text>
              </View>
            </View>
            {onOpenBridgeRecoveryGuide ? (
              <Pressable
                onPress={onOpenBridgeRecoveryGuide}
                style={({ pressed }) => [
                  styles.bridgeRecoveryBannerButton,
                  pressed && styles.bridgeRecoveryBannerButtonPressed,
                ]}
              >
                <Text style={styles.bridgeRecoveryBannerButtonText}>
                  How to start bridge
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {!showBridgeRecoveryBanner
          ? bannerBridgeUiSurfaces.map((surface) => (
              <BridgeUiBanner
                key={surface.id}
                surface={surface}
                onAction={(nextSurface, action) => {
                  void handleBridgeUiAction(nextSurface, action);
                }}
                onDismiss={(nextSurface) => {
                  void dismissBridgeUiSurface(nextSurface);
                }}
              />
            ))
          : null}
        {pendingApproval ? (
          <ApprovalBanner
            approval={pendingApproval}
            onResolve={handleResolveApproval}
          />
        ) : null}
        {showQueuedMessageDock && oldestQueuedMessage ? (
          <QueuedMessageDock
            queuedMessage={oldestQueuedMessage}
            remainingQueuedMessagesCount={remainingQueuedMessagesCount}
            pendingSubmission={showingOptimisticQueuedMessage}
            steerEnabled={canSteerQueuedMessage}
            cancelEnabled={canCancelQueuedMessage}
            steeringActive={queueActionKind === 'steer' && queueActionItemId === oldestQueuedMessage.id}
            steerPending={oldestQueuedMessageIsPendingSteer}
            waitingForToolCalls={selectedThreadRuntimeSnapshot?.waitingForToolCalls === true}
            steeringInFlight={selectedThreadRuntimeSnapshot?.steeringInFlight === true}
            steerDisabledReason={queuedMessageSteerDisabledReason}
            onCancelQueuedMessage={(messageId) => {
              void handleCancelQueuedMessage(messageId);
            }}
            onSteerQueuedMessage={() => {
              void handleSteerQueuedMessage();
            }}
          />
        ) : null}
        {showSlashSuggestions ? (
          <ScrollView
            style={[
              styles.slashSuggestions,
              { maxHeight: slashSuggestionsMaxHeight },
            ]}
            contentContainerStyle={styles.slashSuggestionsContent}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {slashSuggestions.map((command, index) => {
              const suffix = command.argsHint ? ` ${command.argsHint}` : '';
              return (
                <Pressable
                  key={`${command.name}-${String(index)}`}
                  onPress={() => setDraft(`/${command.name}${command.argsHint ? ' ' : ''}`)}
                  style={({ pressed }) => [
                    styles.slashSuggestionItem,
                    index === slashSuggestions.length - 1 &&
                      styles.slashSuggestionItemLast,
                    pressed && styles.slashSuggestionItemPressed,
                  ]}
                >
                  <Text style={styles.slashSuggestionTitle}>{`/${command.name}${suffix}`}</Text>
                  <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                    {command.mobileSupported
                      ? command.summary
                      : `${command.summary} · CLI only`}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        ) : null}
        {!showSlashSuggestions && mentionQuery !== null ? (
          loadingAttachmentFileCandidates && mentionPathSuggestions.length === 0 ? (
            <View style={styles.inlineMentionStatus}>
              <Text accessibilityLiveRegion="polite" style={styles.workspaceModalLoading}>Indexing files…</Text>
            </View>
          ) : mentionPathSuggestions.length > 0 ? (
            <ScrollView
              style={[
                styles.slashSuggestions,
                { maxHeight: slashSuggestionsMaxHeight },
              ]}
              contentContainerStyle={styles.slashSuggestionsContent}
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
            >
              {mentionPathSuggestions.map((path, index) => (
                <Pressable
                  key={`${path}-${String(index)}`}
                  onPress={() => selectMentionSuggestion(path)}
                  style={({ pressed }) => [
                    styles.slashSuggestionItem,
                    index === mentionPathSuggestions.length - 1 &&
                      styles.slashSuggestionItemLast,
                    pressed && styles.slashSuggestionItemPressed,
                  ]}
                >
                  <Text style={styles.slashSuggestionTitle} numberOfLines={1}>
                    {toPathBasename(path)}
                  </Text>
                  <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                    {path}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : mentionQuery.trim().length > 0 ? (
            <View style={styles.inlineMentionStatus}>
              <Text style={styles.workspaceModalLoading}>No matching files found.</Text>
            </View>
          ) : null
        ) : null}
        {overlay && showFloatingActivity ? (
          <View pointerEvents="none" style={styles.activityDock}>
            <ActivityBar
              title={displayedActivity.title}
              detail={activityDetail}
              tone={displayedActivity.tone}
            />
          </View>
        ) : null}
        <ChatInput
          value={draft}
          onChangeText={setDraft}
          onFocus={handleComposerFocus}
          onSubmit={() => void handleSubmit()}
          onStop={() => handleStopTurn()}
          showStopButton={isTurnLoading || isTurnLikelyRunning || stoppingTurn}
          isStopping={stoppingTurn}
          onAttachPress={openAttachmentMenu}
          attachDisabled={attachmentControlsDisabled}
          attachments={composerAttachments}
          onRemoveAttachment={removeComposerAttachment}
          isLoading={isLoading}
          placeholder={selectedChat ? 'Reply...' : `Message ${activeAgentLabel}...`}
          safeAreaBottomInset={composerSafeAreaBottomInset}
          keyboardVisible={keyboardVisible}
          reserveFooterSpace={false}
          footer={null}
        />
      </View>
    );

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

    return (
      <View style={styles.container}>
        <ChatHeader
          onOpenDrawer={onOpenDrawer}
          title={headerTitle}
          agent={activeAgent}
          onOpenTitleMenu={selectedChat ? openTitleEditor : undefined}
          rightIconName={selectedChat ? 'git-branch-outline' : undefined}
          onRightActionPress={selectedChat ? handleOpenGit : undefined}
        />

        {selectedChat && !isOpeningChat ? (
          <View style={styles.sessionMetaRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.sessionMetaRowContent}
            >
              {modelOptions.length > 0 ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.modelChip,
                    pressed && styles.modelChipPressed,
                  ]}
                  onPress={openModelModal}
                  accessibilityRole="button"
                  accessibilityLabel={`Model, ${activeModelLabel}`}
                >
                  <Ionicons {...decorativeAccessibilityProps} name="sparkles-outline" size={12} color={theme.colors.textMuted} />
                  <Text style={styles.modelChipText} numberOfLines={1}>
                    {activeModelLabel}
                  </Text>
                </Pressable>
              ) : null}
              {activeModelEffortOptions.length > 0 ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.modelChip,
                    pressed && styles.modelChipPressed,
                  ]}
                  onPress={() => openEffortModal()}
                  accessibilityRole="button"
                  accessibilityLabel={`Thinking level, ${activeEffortLabel}`}
                >
                  <Ionicons {...decorativeAccessibilityProps} name="pulse-outline" size={12} color={theme.colors.textMuted} />
                  <Text style={styles.modelChipText} numberOfLines={1}>
                    {activeEffortLabel}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                style={({ pressed }) => [
                  styles.modeChip,
                  pressed && styles.modelChipPressed,
                ]}
                onPress={openCollaborationModeMenu}
                accessibilityRole="button"
                accessibilityLabel={`Agent mode, ${collaborationModeLabel}`}
              >
                <Ionicons {...decorativeAccessibilityProps} name="map-outline" size={12} color={theme.colors.textMuted} />
                <Text style={styles.modelChipText} numberOfLines={1}>
                  {collaborationModeLabel}
                </Text>
              </Pressable>
              {showAgentThreadChip ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.modeChip,
                    pressed && styles.modelChipPressed,
                  ]}
                  onPress={() => {
                    void openAgentThreadSelector();
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={agentThreadChipLabel}
                >
                  <Ionicons {...decorativeAccessibilityProps} name="people-outline" size={12} color={theme.colors.textMuted} />
                  <Text style={styles.modelChipText} numberOfLines={1}>
                    {agentThreadChipLabel}
                  </Text>
                </Pressable>
              ) : null}
              {supportsFastMode ? (
                <Pressable
                  style={({ pressed }) => [
                    styles.fastChip,
                    fastModeEnabled && styles.fastChipEnabled,
                    pressed && styles.modelChipPressed,
                    fastModeControlDisabled && styles.sessionMetaChipDisabled,
                  ]}
                  onPress={() => {
                    void toggleFastMode();
                  }}
                  disabled={fastModeControlDisabled}
                  accessibilityRole="switch"
                  accessibilityLabel="Fast mode"
                  accessibilityState={{ checked: fastModeEnabled, disabled: fastModeControlDisabled }}
                >
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name={fastModeEnabled ? 'flash' : 'flash-outline'}
                    size={12}
                    color={fastModeEnabled ? theme.colors.textPrimary : theme.colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.modelChipText,
                      fastModeEnabled && styles.fastChipTextEnabled,
                    ]}
                    numberOfLines={1}
                  >
                    Fast
                  </Text>
                </Pressable>
              ) : null}
            </ScrollView>
          </View>
        ) : null}

        {modelModalVisible ? (
          <InlineOptionsGroup
            title="Model"
            options={modelPickerOptions}
            loading={loadingModels}
            loadingLabel="Refreshing available models..."
            onClose={closeModelModal}
          />
        ) : null}
        {effortModalVisible ? (
          <InlineOptionsGroup
            title="Thinking level"
            options={effortPickerSheetOptions}
            onClose={closeEffortModal}
          />
        ) : null}

        {showTopCardsRow ? (
          <View style={styles.topCardsRow}>
            {workflowBridgeUiSurfaces.map((surface) => (
              <BridgeUiWorkflowCard
                key={surface.id}
                surface={surface}
                scrollMaxHeight={Math.max(176, Math.min(Math.floor(windowHeight * 0.4), 360))}
                onAction={(nextSurface, action) => {
                  void handleBridgeUiAction(nextSurface, action);
                }}
                onDismiss={(nextSurface) => {
                  void dismissBridgeUiSurface(nextSurface);
                }}
              />
            ))}
            {workflowCardMode ? (
              <WorkflowCard
                mode={workflowCardMode}
                plan={selectedThreadPlan}
                collapsed={planPanelCollapsed}
                scrollMaxHeight={Math.max(
                  176,
                  Math.min(
                    Math.floor(windowHeight * (workflowCardMode === 'approval' ? 0.34 : 0.4)),
                    workflowCardMode === 'approval' ? 280 : 360
                  )
                )}
                actionDisabled={sending || creating || stoppingTurn}
                onToggleCollapse={toggleSelectedPlanPanel}
                onImplement={() => void implementPlan()}
                onStayInPlanMode={stayInPlanMode}
              />
            ) : null}
          </View>
        ) : null}

        {showLiveAgentPanel ? (
          <View style={styles.agentPanelWrap}>
            <AgentThreadsPanel
              rows={liveAgentRows}
              runningCount={liveRunningAgentCount}
              collapsed={agentPanelCollapsed}
              onToggleCollapse={() => {
                setAgentPanelCollapsed((previous) => !previous);
              }}
              onSelectThread={(threadId) => {
                openAgentDetail(threadId);
              }}
            />
          </View>
        ) : null}

        {Platform.OS === 'android' ? (
          <View style={styles.bodyContainer}>
            <KeyboardAvoidingView style={styles.keyboardAvoiding} enabled={false}>
              {selectedChat && !isOpeningChat ? (
                <ChatTranscriptView
                  key={selectedChat.id}
                  chat={selectedChat}
                  parentChat={selectedParentChat}
                  bridgeUrl={bridgeUrl}
                  bridgeToken={bridgeToken}
                  onOpenLocalPreview={onOpenLocalPreviewHandler}
                  onOpenSubAgentThread={openAgentDetail}
                  showToolCalls={showToolCalls}
                  agentThreadStatusById={agentThreadStatusById}
                  scrollRef={scrollRef}
                  inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
                  onInlineOptionSelect={handleInlineOptionSelect}
                  onPinnedAutoScroll={scrollToBottomIfPinned}
                  onJumpToLatest={handleJumpToLatest}
                  onScrollInteractionStart={clearPendingScrollRetries}
                  autoScrollStateRef={autoScrollStateRef}
                  bottomInset={androidComposerReservedInset}
                  liveMessageState={liveAssistantByThread[selectedChat.id] ?? null}
                  continuationState={transcriptContinuationState}
                  onLoadEarlier={() => {
                    void handleLoadEarlier();
                  }}
                />
              ) : isOpeningChat ? (
                <ChatOpeningView />
              ) : (
                <ComposeView
                  startWorkspaceLabel={defaultStartWorkspaceLabel}
                  showAgentPicker={readyAgents.length > 1}
                  agentLabel={activeAgentLabel}
                  showModelControls={modelOptions.length > 0}
                  modelLabel={activeModelLabel}
                  showThinkingControls={activeModelEffortOptions.length > 0}
                  thinkingLabel={activeEffortLabel}
                  collaborationModeLabel={collaborationModeLabel}
                  showFastMode={supportsFastMode}
                  fastModeEnabled={fastModeEnabled}
                  fastModeLabel={fastModeLabel}
                  keyboardVisible={keyboardVisible}
                  bottomInset={androidComposerReservedInset}
                  onSuggestion={(s) => setDraft(s)}
                  onOpenWorkspacePicker={openWorkspaceModal}
                  onOpenAgentPicker={openAgentModal}
                  onOpenModelPicker={openModelModal}
                  onOpenThinkingPicker={() => openEffortModal()}
                  onOpenCollaborationModePicker={openCollaborationModeMenu}
                  onToggleFastMode={() => {
                    void toggleFastMode();
                  }}
                />
              )}
            </KeyboardAvoidingView>

            {shouldShowComposer ? renderComposer(true) : null}
          </View>
        ) : (
          <KeyboardAvoidingView
            style={styles.keyboardAvoiding}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            enabled={Platform.OS === 'ios'}
          >
            {selectedChat && !isOpeningChat ? (
              <ChatTranscriptView
                key={selectedChat.id}
                chat={selectedChat}
                parentChat={selectedParentChat}
                bridgeUrl={bridgeUrl}
                bridgeToken={bridgeToken}
                onOpenLocalPreview={onOpenLocalPreviewHandler}
                onOpenSubAgentThread={openAgentDetail}
                showToolCalls={showToolCalls}
                agentThreadStatusById={agentThreadStatusById}
                scrollRef={scrollRef}
                inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
                onInlineOptionSelect={handleInlineOptionSelect}
                onPinnedAutoScroll={scrollToBottomIfPinned}
                onJumpToLatest={handleJumpToLatest}
                onScrollInteractionStart={clearPendingScrollRetries}
                autoScrollStateRef={autoScrollStateRef}
                bottomInset={chatBottomInset}
                liveMessageState={liveAssistantByThread[selectedChat.id] ?? null}
                continuationState={transcriptContinuationState}
                onLoadEarlier={() => {
                  void handleLoadEarlier();
                }}
              />
            ) : isOpeningChat ? (
              <ChatOpeningView />
            ) : (
              <ComposeView
                startWorkspaceLabel={defaultStartWorkspaceLabel}
                showAgentPicker={readyAgents.length > 1}
                agentLabel={activeAgentLabel}
                showModelControls={modelOptions.length > 0}
                modelLabel={activeModelLabel}
                showThinkingControls={activeModelEffortOptions.length > 0}
                thinkingLabel={activeEffortLabel}
                collaborationModeLabel={collaborationModeLabel}
                showFastMode={supportsFastMode}
                fastModeEnabled={fastModeEnabled}
                fastModeLabel={fastModeLabel}
                keyboardVisible={false}
                bottomInset={0}
                onSuggestion={(s) => setDraft(s)}
                onOpenWorkspacePicker={openWorkspaceModal}
                onOpenAgentPicker={openAgentModal}
                onOpenModelPicker={openModelModal}
                onOpenThinkingPicker={() => openEffortModal()}
                onOpenCollaborationModePicker={openCollaborationModeMenu}
                onToggleFastMode={() => {
                  void toggleFastMode();
                }}
              />
            )}

            {showFloatingActivity ? (
              <View pointerEvents="none" style={styles.activityDock}>
                <ActivityBar
                  title={displayedActivity.title}
                  detail={activityDetail}
                  tone={displayedActivity.tone}
                />
              </View>
            ) : null}

            {shouldShowComposer ? renderComposer(false) : null}
          </KeyboardAvoidingView>
        )}

        <SubAgentDetailView
          visible={Boolean(agentDetailThreadId)}
          chat={agentDetailChat}
          parentChat={agentDetailParentChat}
          runtime={agentDetailRuntime}
          liveMessageState={
            agentDetailThreadId ? liveAssistantByThread[agentDetailThreadId] ?? null : null
          }
          display={agentDetailDisplay}
          title={agentDetailTitle}
          role={agentDetailSummary?.agentRole}
          loading={agentDetailLoading}
          error={agentDetailError}
          bridgeUrl={bridgeUrl}
          bridgeToken={bridgeToken}
          showToolCalls={showToolCalls}
          agentThreadStatusById={agentThreadStatusById}
          onOpenLocalPreview={onOpenLocalPreviewHandler}
          onClose={closeAgentDetail}
          onRefresh={() => {
            if (agentDetailThreadId) {
              void loadAgentDetail(agentDetailThreadId, true);
            }
          }}
          onOpenAsChat={() => {
            const threadId = agentDetailThreadId;
            closeAgentDetail();
            if (threadId) {
              openChatThread(threadId, agentDetailChat);
            }
          }}
        />

        <SelectionSheet
          visible={attachmentMenuVisible}
          eyebrow="Attachments"
          title="Add context"
          subtitle="Bring in a workspace path, a file, a saved image, or a fresh photo."
          options={attachmentMenuOptions}
          presentation="expanded"
          onClose={attachmentController.closeMenu}
        />

        <SelectionSheet
          visible={agentThreadMenuVisible}
          eyebrow="Agents"
          title="Agent threads"
          subtitle="Switch between the main thread and spawned sub-agent threads."
          options={agentThreadMenuOptions}
          loading={loadingAgentThreads}
          loadingLabel="Loading agent threads…"
          emptyLabel="No spawned agent threads for this chat yet."
          presentation="expanded"
          onClose={() => setAgentThreadMenuVisible(false)}
        />

        <SelectionSheet
          visible={collaborationModeMenuVisible}
          eyebrow="Agent"
          title="Agent mode"
          subtitle={`Choose a mode supported by ${activeAgentLabel}.`}
          options={collaborationModeOptions}
          onClose={() => setCollaborationModeMenuVisible(false)}
        />

        <SelectionSheet
          visible={agentModalVisible}
          eyebrow="Agent"
          title="Select agent"
          subtitle="Choose which installed ACP agent should start the new chat."
          options={agentPickerOptions}
          onClose={closeAgentModal}
        />

        <Modal
          visible={titleModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeTitleEditor}
        >
          <KeyboardAvoidingView
            style={styles.renameModalKeyboardAvoider}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <View style={styles.renameModalBackdrop}>
              <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.renameModalCard}>
                <Text style={styles.renameModalTitle}>Rename session</Text>
                <TextInput
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  style={styles.renameModalInput}
                  accessibilityLabel="Session title"
                  autoFocus
                  maxLength={256}
                  editable={!titleSaving}
                  returnKeyType="done"
                  onSubmitEditing={() => { void saveTitle(); }}
                />
                <View style={styles.renameModalActions}>
                  <Pressable
                    onPress={closeTitleEditor}
                    style={[styles.renameModalButton, styles.renameModalButtonSecondary]}
                    disabled={titleSaving}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel rename"
                  >
                    <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => { void saveTitle(); }}
                    style={[
                      styles.renameModalButton,
                      styles.renameModalButtonPrimary,
                      (!titleDraft.trim() || titleSaving) && styles.renameModalButtonDisabled,
                    ]}
                    disabled={!titleDraft.trim() || titleSaving}
                    accessibilityRole="button"
                    accessibilityLabel="Save session title"
                  >
                    <Text style={styles.renameModalButtonPrimaryText}>
                      {titleSaving ? 'Saving...' : 'Save'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <WorkspacePickerModal
          visible={workspaceModalVisible}
          selectedPath={
            workspacePickerPurpose === 'git-checkout-destination'
              ? gitCheckoutParentPath
              : preferredStartCwd
          }
          bridgeRoot={workspaceBridgeRoot}
          recentWorkspaces={workspaceRoots}
          favoriteWorkspacePaths={favoriteWorkspacePaths}
          currentPath={workspaceBrowsePath}
          parentPath={workspaceBrowseParentPath}
          entries={workspaceBrowseEntries}
          loadingEntries={loadingWorkspaceBrowse}
          error={workspaceBrowseError}
          truncationMessage={workspaceBrowseTruncation}
          onBrowsePath={(path) => void browseWorkspacePath(path)}
          onSelectPath={handleWorkspaceSelection}
          onToggleFavorite={toggleWorkspaceFavorite}
          actionLabel={
            workspacePickerPurpose === 'default-start' ? 'Clone Repo' : null
          }
          actionDescription={
            workspacePickerPurpose === 'default-start'
              ? 'Into this workspace'
              : null
          }
          onActionPress={
            workspacePickerPurpose === 'default-start'
              ? (path) => {
                  setWorkspaceModalVisible(false);
                  openGitCheckoutModal(path);
                }
              : undefined
          }
          onClose={closeWorkspaceModal}
        />

        <Modal
          visible={gitCheckoutModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeGitCheckoutModal}
        >
          <KeyboardAvoidingView
            style={styles.renameModalKeyboardAvoider}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? safeAreaInsets.bottom : 0}
          >
            <View style={styles.renameModalBackdrop}>
              <View
                style={[
                  styles.renameModalKeyboardContent,
                  styles.renameModalKeyboardContentBottom,
                  { paddingBottom: theme.spacing.md },
                ]}
              >
                <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.renameModalCard}>
                  <Text style={styles.renameModalTitle}>Git checkout</Text>
                  <Text style={styles.gitCheckoutHint}>
                    Paste an SSH or HTTPS repository URL, choose where to clone it, then start
                    the new chat in that workspace.
                  </Text>
                  <TextInput
                    value={gitCheckoutRepoUrl}
                    onChangeText={handleGitCheckoutRepoUrlChange}
                    keyboardAppearance={theme.keyboardAppearance}
                    placeholder="git@github.com:org/repo.git"
                    placeholderTextColor={theme.colors.textMuted}
                    style={styles.renameModalInput}
                    accessibilityLabel="Repository URL"
                    autoFocus
                    editable={!gitCheckoutCloning}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="next"
                  />
                  <Pressable
                    onPress={openGitCheckoutDestinationPicker}
                    style={({ pressed }) => [
                      styles.gitCheckoutPathButton,
                      pressed && styles.gitCheckoutPathButtonPressed,
                    ]}
                    disabled={gitCheckoutCloning}
                    accessibilityRole="button"
                    accessibilityLabel={`Clone into ${gitCheckoutDestinationLabel}`}
                  >
                    <Ionicons
                      {...decorativeAccessibilityProps}
                      name="folder-open-outline"
                      size={16}
                      color={theme.colors.textMuted}
                    />
                    <View style={styles.gitCheckoutPathCopy}>
                      <Text style={styles.gitCheckoutPathLabel}>Clone into</Text>
                      <Text style={styles.gitCheckoutPathValue} numberOfLines={1}>
                        {gitCheckoutDestinationLabel}
                      </Text>
                    </View>
                    <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
                  </Pressable>
                  <TextInput
                    value={gitCheckoutDirectoryName}
                    onChangeText={handleGitCheckoutDirectoryNameChange}
                    keyboardAppearance={theme.keyboardAppearance}
                    placeholder="repo-folder"
                    placeholderTextColor={theme.colors.textMuted}
                    style={styles.renameModalInput}
                    accessibilityLabel="Clone directory name"
                    editable={!gitCheckoutCloning}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={() => void submitGitCheckout()}
                  />
                  {gitCheckoutTargetPath ? (
                    <Text style={styles.gitCheckoutSummary} numberOfLines={2}>
                      {`Will clone into ${gitCheckoutTargetPath}`}
                    </Text>
                  ) : null}
                  {gitCheckoutError ? (
                    <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.gitCheckoutErrorText}>{gitCheckoutError}</Text>
                  ) : null}
                  <View style={styles.renameModalActions}>
                    <Pressable
                      onPress={closeGitCheckoutModal}
                      style={({ pressed }) => [
                        styles.renameModalButton,
                        styles.renameModalButtonSecondary,
                        pressed && styles.renameModalButtonPressed,
                      ]}
                      disabled={gitCheckoutCloning}
                    >
                      <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => void submitGitCheckout()}
                      style={({ pressed }) => [
                        styles.renameModalButton,
                        styles.renameModalButtonPrimary,
                        pressed && styles.renameModalButtonPrimaryPressed,
                        (!gitCheckoutRepoUrl.trim() ||
                          !normalizeCloneDirectoryName(gitCheckoutDirectoryName) ||
                          gitCheckoutCloning) &&
                          styles.renameModalButtonDisabled,
                      ]}
                      disabled={
                        !gitCheckoutRepoUrl.trim() ||
                        !normalizeCloneDirectoryName(gitCheckoutDirectoryName) ||
                        gitCheckoutCloning
                      }
                    >
                      <Text style={styles.renameModalButtonPrimaryText}>
                        {gitCheckoutCloning ? 'Cloning...' : 'Clone and use'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>

        <Modal
          visible={attachmentModalVisible}
          transparent
          animationType="fade"
          onRequestClose={closeAttachmentModal}
        >
          <View style={styles.renameModalBackdrop}>
            <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.renameModalCard}>
              <Text style={styles.renameModalTitle}>Attach file</Text>
              <Text style={styles.attachmentModalHint}>
                Enter a workspace-relative path to include as context.
              </Text>
              <TextInput
                value={attachmentPathDraft}
                onChangeText={setAttachmentPathDraft}
                keyboardAppearance={theme.keyboardAppearance}
                placeholder="apps/mobile/src/screens/MainScreen.tsx"
                placeholderTextColor={theme.colors.textMuted}
                style={styles.renameModalInput}
                autoFocus
                editable={!isLoading}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={submitAttachmentPath}
                returnKeyType="done"
                accessibilityLabel="Workspace file path"
              />
              {loadingAttachmentFileCandidates ? (
                <Text style={styles.workspaceModalLoading}>Indexing files…</Text>
              ) : null}
              {attachmentPathSuggestions.length > 0 ? (
                <ScrollView
                  style={styles.attachmentSuggestionsList}
                  contentContainerStyle={styles.attachmentSuggestionsListContent}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                >
                  {attachmentPathSuggestions.map((path, index) => (
                    <Pressable
                      key={`${path}-${String(index)}`}
                      onPress={() => selectAttachmentSuggestion(path)}
                      style={({ pressed }) => [
                        styles.attachmentSuggestionItem,
                        index === attachmentPathSuggestions.length - 1 &&
                          styles.attachmentSuggestionItemLast,
                        pressed && styles.attachmentSuggestionItemPressed,
                      ]}
                    >
                      <Text style={styles.attachmentSuggestionText} numberOfLines={1}>
                        {path}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : attachmentPathDraft.trim() && !loadingAttachmentFileCandidates ? (
                <Text style={styles.workspaceModalLoading}>No matching files found.</Text>
              ) : null}
              {pendingMentionPaths.length > 0 ? (
                <View style={styles.attachmentListColumn}>
                  {pendingMentionPaths.map((path, index) => (
                    <View key={`${path}-${String(index)}`} style={styles.attachmentListRow}>
                      <Text style={styles.attachmentListPath} numberOfLines={1}>
                        {path}
                      </Text>
                      <Pressable
                        onPress={() => removePendingMentionPath(path)}
                        style={({ pressed }) => [
                          styles.attachmentRemoveButton,
                          pressed && styles.attachmentRemoveButtonPressed,
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove ${path}`}
                      >
                        <Ionicons {...decorativeAccessibilityProps} name="close" size={14} color={theme.colors.textMuted} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ) : null}
              <View style={styles.renameModalActions}>
                <Pressable
                  onPress={closeAttachmentModal}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonSecondary,
                    pressed && styles.renameModalButtonPressed,
                  ]}
                  disabled={isLoading}
                >
                  <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submitAttachmentPath}
                  style={({ pressed }) => [
                    styles.renameModalButton,
                    styles.renameModalButtonPrimary,
                    pressed && styles.renameModalButtonPrimaryPressed,
                    (!attachmentPathDraft.trim() || isLoading) &&
                      styles.renameModalButtonDisabled,
                  ]}
                  disabled={!attachmentPathDraft.trim() || isLoading}
                >
                  <Text style={styles.renameModalButtonPrimaryText}>Attach</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal
          visible={Boolean(pendingUserInputRequest)}
          transparent
          animationType="fade"
          onRequestClose={() => {
            // This prompt requires a reply; keep it visible until submitted.
          }}
        >
          <View style={styles.userInputModalBackdrop}>
            <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.userInputModalCard}>
              <Text style={styles.userInputModalTitle}>Clarification needed</Text>
              <ScrollView
                style={styles.userInputQuestionsList}
                contentContainerStyle={styles.userInputQuestionsListContent}
                showsVerticalScrollIndicator={false}
              >
                {(pendingUserInputRequest?.questions ?? []).map((question, questionIndex) => {
                  const answer = userInputDrafts[question.id] ?? '';
                  const hasPresetOptions =
                    Array.isArray(question.options) && question.options.length > 0;
                  const needsFreeformInput = !hasPresetOptions || question.isOther;
                  return (
                    <View
                      key={`${question.id}-${String(questionIndex)}`}
                      style={styles.userInputQuestionCard}
                    >
                      <Text style={styles.userInputQuestionHeader}>{question.header}</Text>
                      <Text style={styles.userInputQuestionText}>{question.question}</Text>
                      {hasPresetOptions ? (
                        <View style={styles.userInputOptionsColumn}>
                          {question.options?.map((option, index) => (
                            <Pressable
                              key={`${question.id}-${String(index)}-${option.value}`}
                              style={({ pressed }) => [
                                styles.userInputOptionButton,
                                answer.trim() === option.value.trim() &&
                                  styles.userInputOptionButtonSelected,
                                pressed && styles.userInputOptionButtonPressed,
                              ]}
                              onPress={() => setUserInputDraft(question.id, option.value)}
                              accessibilityRole="radio"
                              accessibilityState={{ checked: answer.trim() === option.value.trim() }}
                              accessibilityLabel={option.label}
                              accessibilityHint={option.description || undefined}
                            >
                              <View style={styles.userInputOptionHeaderRow}>
                                <Text style={styles.userInputOptionIndex}>
                                  {`${String(index + 1)}.`}
                                </Text>
                                <Text style={styles.userInputOptionLabel}>{option.label}</Text>
                              </View>
                              {option.description.trim() ? (
                                <Text style={styles.userInputOptionDescription}>
                                  {option.description}
                                </Text>
                              ) : null}
                            </Pressable>
                          ))}
                        </View>
                      ) : null}
                      {needsFreeformInput ? (
                        <TextInput
                          value={answer}
                          onChangeText={(value) => setUserInputDraft(question.id, value)}
                          keyboardAppearance={theme.keyboardAppearance}
                          placeholder={
                            question.isOther
                              ? 'Or enter a custom answer…'
                              : 'Type your answer…'
                          }
                          placeholderTextColor={theme.colors.textMuted}
                          secureTextEntry={question.isSecret}
                          editable={!resolvingUserInput}
                          multiline={!question.isSecret && question.fieldType !== 'boolean'}
                          keyboardType={
                            question.fieldType === 'integer'
                              ? 'number-pad'
                              : question.fieldType === 'number'
                                ? 'decimal-pad'
                                : 'default'
                          }
                          style={[
                            styles.userInputAnswerInput,
                            question.isSecret && styles.userInputAnswerInputSecret,
                          ]}
                          accessibilityLabel={question.header || question.question}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
              {userInputError ? (
                <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.userInputErrorText}>{userInputError}</Text>
              ) : null}
              <View style={styles.userInputModalActions}>
                <Pressable
                  onPress={() => void dismissUserInputRequest('cancel')}
                  style={({ pressed }) => [styles.userInputSecondaryButton, pressed && styles.userInputSubmitButtonPressed]}
                  disabled={resolvingUserInput}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel request"
                >
                  <Text style={styles.userInputSecondaryButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void dismissUserInputRequest('decline')}
                  style={({ pressed }) => [styles.userInputSecondaryButton, pressed && styles.userInputSubmitButtonPressed]}
                  disabled={resolvingUserInput}
                  accessibilityRole="button"
                  accessibilityLabel="Decline request"
                >
                  <Text style={styles.userInputSecondaryButtonText}>Decline</Text>
                </Pressable>
                <Pressable
                  onPress={() => void submitUserInputRequest()}
                  style={({ pressed }) => [
                    styles.userInputSubmitButton,
                    pressed && styles.userInputSubmitButtonPressed,
                    resolvingUserInput && styles.userInputSubmitButtonDisabled,
                  ]}
                  disabled={resolvingUserInput}
                  accessibilityRole="button"
                  accessibilityState={controlAccessibilityState({ disabled: resolvingUserInput, busy: resolvingUserInput })}
                >
                  <Text style={styles.userInputSubmitButtonText}>
                    {resolvingUserInput ? 'Submitting…' : 'Submit answers'}
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
        {modalBridgeUiSurface ? (
          <BridgeUiModal
            surface={modalBridgeUiSurface}
            onAction={(nextSurface, action) => {
              void handleBridgeUiAction(nextSurface, action);
            }}
            onDismiss={(surface) => {
              void dismissBridgeUiSurface(surface);
            }}
          />
        ) : null}
      </View>
    );
  }
);

function InlineOptionsGroup({
  title,
  options,
  loading = false,
  loadingLabel = 'Loading options...',
  onClose,
}: {
  title: string;
  options: SelectionSheetOption[];
  loading?: boolean;
  loadingLabel?: string;
  onClose: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.inlineOptionsGroup} accessibilityRole="menu" accessibilityLabel={title}>
      <View style={styles.inlineOptionsHeader}>
        <Text style={styles.inlineOptionsTitle}>{title}</Text>
        <Pressable
          onPress={onClose}
          style={styles.inlineOptionsClose}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="close" size={16} color={theme.colors.textMuted} />
        </Pressable>
      </View>
      {loading ? (
        <View style={styles.inlineOptionsLoading} accessibilityRole="progressbar">
          <ActivityIndicator size="small" color={theme.colors.textPrimary} />
          <Text style={styles.inlineOptionsDescription}>{loadingLabel}</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.inlineOptionsScroll}
          contentContainerStyle={styles.inlineOptionsContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {options.map((option) => (
            <Pressable
              key={option.key}
              onPress={option.onPress}
              disabled={option.disabled}
              style={({ pressed }) => [
                styles.inlineOption,
                option.selected && styles.inlineOptionSelected,
                option.disabled && styles.inlineOptionDisabled,
                pressed && !option.disabled && styles.inlineOptionPressed,
              ]}
              accessibilityRole="menuitem"
              accessibilityLabel={option.title}
              accessibilityHint={option.description}
              accessibilityState={controlAccessibilityState({
                disabled: option.disabled,
                selected: option.selected,
              })}
            >
              {option.icon ? (
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name={option.icon}
                  size={15}
                  color={option.selected ? theme.colors.textPrimary : theme.colors.textMuted}
                />
              ) : null}
              <View style={styles.inlineOptionCopy}>
                <Text style={styles.inlineOptionTitle}>{option.title}</Text>
                {option.description ? (
                  <Text style={styles.inlineOptionsDescription}>{option.description}</Text>
                ) : null}
              </View>
              {option.selected ? (
                <Ionicons {...decorativeAccessibilityProps} name="checkmark" size={16} color={theme.colors.textPrimary} />
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ── Compose View ───────────────────────────────────────────────────

function ComposeView({
  startWorkspaceLabel,
  showAgentPicker,
  agentLabel,
  showModelControls,
  modelLabel,
  showThinkingControls,
  thinkingLabel,
  collaborationModeLabel,
  showFastMode,
  fastModeEnabled,
  fastModeLabel,
  keyboardVisible,
  bottomInset,
  onSuggestion,
  onOpenWorkspacePicker,
  onOpenAgentPicker,
  onOpenModelPicker,
  onOpenThinkingPicker,
  onOpenCollaborationModePicker,
  onToggleFastMode,
}: {
  startWorkspaceLabel: string;
  showAgentPicker: boolean;
  agentLabel: string;
  showModelControls: boolean;
  modelLabel: string;
  showThinkingControls: boolean;
  thinkingLabel: string;
  collaborationModeLabel: string;
  showFastMode: boolean;
  fastModeEnabled: boolean;
  fastModeLabel: string;
  keyboardVisible: boolean;
  bottomInset: number;
  onSuggestion: (s: string) => void;
  onOpenWorkspacePicker: () => void;
  onOpenAgentPicker: () => void;
  onOpenModelPicker: () => void;
  onOpenThinkingPicker: () => void;
  onOpenCollaborationModePicker: () => void;
  onToggleFastMode: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const contentContainerStyle =
    Platform.OS === 'android'
      ? [
          styles.composeContainer,
          keyboardVisible ? styles.composeContainerKeyboardOpen : null,
          { paddingBottom: bottomInset },
        ]
      : styles.composeContainer;

  return (
    <ScrollView
      style={styles.composeScroll}
      contentContainerStyle={contentContainerStyle}
      showsVerticalScrollIndicator={false}
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      keyboardShouldPersistTaps="handled"
      onScrollBeginDrag={Keyboard.dismiss}
      alwaysBounceVertical
      overScrollMode="always"
    >
      <View style={styles.composeIcon}>
        <BrandMark size={52} />
      </View>
      <Text style={styles.composeTitle}>Let's build</Text>
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          styles.workspacePathSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenWorkspacePicker}
        accessibilityRole="button"
        accessibilityLabel={`Workspace, ${startWorkspaceLabel}`}
      >
        <Ionicons {...decorativeAccessibilityProps} name="folder-open-outline" size={16} color={theme.colors.textMuted} />
        <Text style={[styles.workspaceSelectLabel, styles.workspacePathSelectLabel]}>
          {startWorkspaceLabel}
        </Text>
        <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      {showAgentPicker ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenAgentPicker}
          accessibilityRole="button"
          accessibilityLabel={`Agent, ${agentLabel}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="layers-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {agentLabel}
          </Text>
          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      {showModelControls ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenModelPicker}
          accessibilityRole="button"
          accessibilityLabel={`Model, ${modelLabel}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="sparkles-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {modelLabel}
          </Text>
          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      {showThinkingControls ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onOpenThinkingPicker}
          accessibilityRole="button"
          accessibilityLabel={`Thinking level, ${thinkingLabel}`}
        >
          <Ionicons {...decorativeAccessibilityProps} name="pulse-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {thinkingLabel}
          </Text>
          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
      <Pressable
        style={({ pressed }) => [
          styles.workspaceSelectBtn,
          pressed && styles.workspaceSelectBtnPressed,
        ]}
        onPress={onOpenCollaborationModePicker}
        accessibilityRole="button"
        accessibilityLabel={`Agent mode, ${collaborationModeLabel}`}
      >
        <Ionicons {...decorativeAccessibilityProps} name="map-outline" size={16} color={theme.colors.textMuted} />
        <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
          {collaborationModeLabel}
        </Text>
        <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
      </Pressable>
      {showFastMode ? (
        <Pressable
          style={({ pressed }) => [
            styles.workspaceSelectBtn,
            pressed && styles.workspaceSelectBtnPressed,
          ]}
          onPress={onToggleFastMode}
          accessibilityRole="switch"
          accessibilityLabel="Fast mode"
          accessibilityState={{ checked: fastModeEnabled }}
        >
          <Ionicons {...decorativeAccessibilityProps} name="flash-outline" size={16} color={theme.colors.textMuted} />
          <Text style={styles.workspaceSelectLabel} numberOfLines={1}>
            {fastModeLabel}
          </Text>
          <Ionicons
            {...decorativeAccessibilityProps}
            name={fastModeEnabled ? 'checkmark-circle' : 'ellipse-outline'}
            size={14}
            color={theme.colors.textMuted}
          />
        </Pressable>
      ) : null}
      <View style={styles.suggestions}>
        {SUGGESTIONS.map((s, index) => (
          <Pressable
            key={`${s}-${String(index)}`}
            style={({ pressed }) => [
              styles.suggestionCard,
              pressed && styles.suggestionCardPressed,
            ]}
            onPress={() => onSuggestion(s)}
            accessibilityRole="button"
            accessibilityLabel={`Use suggestion: ${s}`}
          >
            <Text style={styles.suggestionText}>{s}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

interface AgentThreadPanelRow {
  chat: ChatSummary;
  title: string;
  description: string;
  runtime: AgentThreadDisplayState;
  selected: boolean;
  latestCommand?: RunEvent | null;
}


function AgentThreadsPanel({
  rows,
  runningCount,
  collapsed,
  onToggleCollapse,
  onSelectThread,
}: {
  rows: AgentThreadPanelRow[];
  runningCount: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  const theme = useAppTheme();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(theme), [theme]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <View style={styles.agentPanelCard}>
      <Pressable
        onPress={onToggleCollapse}
        style={({ pressed }) => [
          styles.agentPanelHeader,
          styles.agentPanelHeaderPressable,
          pressed && styles.agentPanelHeaderPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Agents, ${String(runningCount)} running`}
        accessibilityState={controlAccessibilityState({ expanded: !collapsed })}
      >
        <View style={styles.agentPanelHeaderCopy}>
          <Text style={styles.agentPanelEyebrow}>Agents</Text>
          <Text style={styles.agentPanelSummary}>
            {runningCount === 1
              ? '1 running now'
              : `${String(runningCount)} running now`}
          </Text>
        </View>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={collapsed ? 'chevron-down' : 'chevron-up'}
          size={16}
          color={theme.colors.textMuted}
        />
      </Pressable>

      {!collapsed ? (
        <ScrollView
          style={[
            styles.agentPanelScroll,
            { maxHeight: Math.max(180, Math.floor(windowHeight * 0.5)) },
          ]}
          contentContainerStyle={styles.agentPanelList}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
        >
          {rows.map((row) => (
            <Pressable
              key={row.chat.id}
              onPress={() => onSelectThread(row.chat.id)}
              style={({ pressed }) => [
                styles.agentPanelRow,
                { borderColor: row.runtime.statusBorderColor },
                row.selected && styles.agentPanelRowSelected,
                pressed && styles.agentPanelRowPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`${row.title}, ${row.runtime.label}. ${row.description}`}
              accessibilityState={controlAccessibilityState({ selected: row.selected, busy: row.runtime.isActive })}
            >
              <View
                style={[
                  styles.agentPanelAccent,
                  { backgroundColor: row.runtime.accentColor },
                ]}
              />
              <View style={styles.agentPanelCopy}>
                <View style={styles.agentPanelTitleRow}>
                  <Text
                    style={[
                      styles.agentPanelTitle,
                      { color: row.runtime.accentColor },
                    ]}
                    numberOfLines={1}
                  >
                    {row.title}
                  </Text>
                  {row.selected ? (
                    <Text style={styles.agentPanelSelectedLabel}>Current</Text>
                  ) : null}
                </View>
                <Text style={styles.agentPanelDescription} numberOfLines={1}>
                  {row.description}
                </Text>
              </View>
              <View
                style={[
                  styles.agentPanelStatusBadge,
                  {
                    backgroundColor: row.runtime.statusSurfaceColor,
                    borderColor: row.runtime.statusBorderColor,
                  },
                ]}
              >
                {row.runtime.isActive ? (
                  <ActivityIndicator size="small" color={row.runtime.statusColor} />
                ) : (
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name={row.runtime.icon}
                    size={12}
                    color={row.runtime.statusColor}
                  />
                )}
                <Text
                  style={[
                    styles.agentPanelStatusText,
                    { color: row.runtime.statusColor },
                  ]}
                  numberOfLines={1}
                >
                  {row.runtime.label}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

// ── Chat View ──────────────────────────────────────────────────────

function ChatOpeningView() {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.chatOpeningShell} accessibilityRole="progressbar" accessibilityLabel="Opening chat" accessibilityLiveRegion="polite">
      <View style={styles.chatOpeningCard}>
        <View style={styles.chatOpeningTopRow}>
          <ActivityIndicator size="small" color={theme.colors.textMuted} />
          <Text style={styles.chatOpeningTitle}>Opening chat</Text>
        </View>
        <View style={styles.chatOpeningBubbleWide} />
        <View style={styles.chatOpeningBubbleShort} />
      </View>
    </View>
  );
}


function areChatStatusMapsEquivalent(
  previous: ReadonlyMap<string, Chat['status']>,
  next: ReadonlyMap<string, Chat['status']>
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.size !== next.size) {
    return false;
  }

  for (const [key, value] of previous) {
    if (next.get(key) !== value) {
      return false;
    }
  }

  return true;
}

function resolveEquivalentChat(previous: Chat, next: Chat): Chat {
  const stabilizedNext = preserveRecentUserTurnTranscript(previous, next);
  return areChatsEquivalent(previous, stabilizedNext) ? previous : stabilizedNext;
}

function mergeChatSummaryPreservingMessages(previous: Chat, summary: ChatSummary): Chat {
  const next = {
    ...previous,
    ...summary,
    messages: previous.messages,
  };
  return areChatsEquivalent(previous, next) ? previous : next;
}

function preserveRecentUserTurnTranscript(previous: Chat, next: Chat): Chat {
  if (previous.id !== next.id) {
    return next;
  }

  const previousUserCount = countUserMessages(previous.messages);
  const nextUserCount = countUserMessages(next.messages);
  if (nextUserCount >= previousUserCount) {
    return next;
  }

  const shouldPreserveTranscript =
    hasRecentUnansweredUserTurn(previous) ||
    previous.status === 'running' ||
    next.status === 'running';
  if (!shouldPreserveTranscript) {
    return next;
  }

  return {
    ...next,
    lastMessagePreview: previous.lastMessagePreview,
    messages: previous.messages,
  };
}

function areChatsEquivalent(previous: Chat | null, next: Chat | null): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    areChatSummariesEquivalent(previous, next) &&
    areChatPlansEquivalent(previous.latestPlan, next.latestPlan) &&
    areChatPlansEquivalent(previous.latestTurnPlan, next.latestTurnPlan) &&
    previous.latestTurnStatus === next.latestTurnStatus &&
    areChatMessagesEquivalent(previous.messages, next.messages)
  );
}

function areChatSummariesEquivalent(
  previous: ChatSummary | null,
  next: ChatSummary | null
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return previous === next;
  }

  return (
    previous.id === next.id &&
    previous.title === next.title &&
    previous.status === next.status &&
    previous.createdAt === next.createdAt &&
    previous.updatedAt === next.updatedAt &&
    previous.statusUpdatedAt === next.statusUpdatedAt &&
    previous.lastMessagePreview === next.lastMessagePreview &&
    previous.cwd === next.cwd &&
    previous.agentId === next.agentId &&
    previous.modelProvider === next.modelProvider &&
    previous.agentNickname === next.agentNickname &&
    previous.agentRole === next.agentRole &&
    previous.sourceKind === next.sourceKind &&
    previous.parentThreadId === next.parentThreadId &&
    previous.subAgentDepth === next.subAgentDepth &&
    previous.lastRunStartedAt === next.lastRunStartedAt &&
    previous.lastRunFinishedAt === next.lastRunFinishedAt &&
    previous.lastRunDurationMs === next.lastRunDurationMs &&
    previous.lastRunExitCode === next.lastRunExitCode &&
    previous.lastRunTimedOut === next.lastRunTimedOut &&
    previous.lastError === next.lastError
  );
}

function areChatPlansEquivalent(
  previous: Chat['latestPlan'],
  next: Chat['latestPlan']
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  if (
    previous.threadId !== next.threadId ||
    previous.turnId !== next.turnId ||
    previous.explanation !== next.explanation ||
    previous.steps.length !== next.steps.length
  ) {
    return false;
  }

  for (let index = 0; index < previous.steps.length; index += 1) {
    const previousStep = previous.steps[index];
    const nextStep = next.steps[index];
    if (
      previousStep.step !== nextStep.step ||
      previousStep.status !== nextStep.status
    ) {
      return false;
    }
  }

  return true;
}

function modelOptionsFromAcpConfig(config: AcpConfigOption[]): ModelOption[] {
  const model = config.find((option) => option.category === 'model');
  const effort = config.find((option) => option.category === 'thought_level');
  if (!model?.options?.length) {
    return EMPTY_MODEL_OPTIONS;
  }
  const selectedId = normalizeModelId(model.value);
  const reasoningEffort = (effort?.options ?? [])
    .map((option) => {
      const normalized = normalizeReasoningEffort(option.value);
      return normalized
        ? { effort: normalized, description: option.description ?? option.name }
        : null;
    })
    .filter((option): option is NonNullable<typeof option> => option !== null);
  const defaultReasoningEffort = normalizeReasoningEffort(effort?.value);
  return model.options.map((option) => {
    const [providerId, ...modelParts] = option.value.split('/');
    const displayName = option.name.includes('/')
      ? option.name.split('/').at(-1) ?? option.name
      : option.name;
    return {
      id: option.value,
      displayName,
      description: option.description,
      providerId: modelParts.length > 0 ? providerId : undefined,
      providerName: modelParts.length > 0 ? option.name.split('/')[0] : undefined,
      isDefault: option.value === selectedId,
      defaultReasoningEffort: defaultReasoningEffort ?? undefined,
      reasoningEffort: reasoningEffort.length > 0 ? reasoningEffort : undefined,
    } satisfies ModelOption;
  });
}

function mergeModelOptions(
  catalog: ModelOption[] | null | undefined,
  configured: ModelOption[]
): ModelOption[] {
  const safeCatalog = catalog ?? EMPTY_MODEL_OPTIONS;
  const catalogById = new Map(safeCatalog.map((model) => [model.id, model]));
  const mergedConfigured = configured.map((model) => {
    const catalogEntry = catalogById.get(model.id);
    return {
      ...catalogEntry,
      ...model,
      contextWindow: catalogEntry?.contextWindow ?? model.contextWindow,
      reasoningEffort: model.reasoningEffort ?? catalogEntry?.reasoningEffort,
    };
  });
  const configuredIds = new Set(configured.map((model) => model.id));
  return [...mergedConfigured, ...safeCatalog.filter((model) => !configuredIds.has(model.id))];
}

function areChatMessagesEquivalent(
  previous: ChatTranscriptMessage[],
  next: ChatTranscriptMessage[]
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index];
    const right = next[index];
    if (
      left.id !== right.id ||
      left.role !== right.role ||
      JSON.stringify(left.content) !== JSON.stringify(right.content) ||
      left.createdAt !== right.createdAt ||
      (left.role === 'activity' && right.role === 'activity' &&
        left.activityType !== right.activityType) ||
      !areChatMessageSubAgentMetaEquivalent(getSubAgentMeta(left), getSubAgentMeta(right))
    ) {
      return false;
    }
  }

  return true;
}

function areChatMessageSubAgentMetaEquivalent(
  previous: ReturnType<typeof getSubAgentMeta>,
  next: ReturnType<typeof getSubAgentMeta>
): boolean {
  if (previous === next) {
    return true;
  }
  if (!previous || !next) {
    return !previous && !next;
  }
  if (
    previous.tool !== next.tool ||
    previous.prompt !== next.prompt ||
    previous.senderThreadId !== next.senderThreadId ||
    previous.agentStatus !== next.agentStatus
  ) {
    return false;
  }

  const previousReceiverThreadIds = previous.receiverThreadIds ?? [];
  const nextReceiverThreadIds = next.receiverThreadIds ?? [];
  if (previousReceiverThreadIds.length !== nextReceiverThreadIds.length) {
    return false;
  }

  for (let index = 0; index < previousReceiverThreadIds.length; index += 1) {
    if (previousReceiverThreadIds[index] !== nextReceiverThreadIds[index]) {
      return false;
    }
  }

  return true;
}

function areChatSummaryListsEquivalent(
  previous: ChatSummary[],
  next: ChatSummary[]
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (!areChatSummariesEquivalent(previous[index], next[index])) {
      return false;
    }
  }

  return true;
}

function WorkflowCard({
  mode,
  plan,
  collapsed,
  scrollMaxHeight,
  actionDisabled,
  onToggleCollapse,
  onImplement,
  onStayInPlanMode,
}: {
  mode: 'plan' | 'approval' | 'execution';
  plan: ActivePlanState | null;
  collapsed: boolean;
  scrollMaxHeight: number;
  actionDisabled: boolean;
  onToggleCollapse: () => void;
  onImplement: () => void;
  onStayInPlanMode: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const workflowMarkdownStyles = useMemo(() => createWorkflowMarkdownStyles(theme), [theme]);
  const hasStructuredPlan = hasStructuredPlanCardContent(plan);
  const hasSteps = (plan?.steps.length ?? 0) > 0;
  const totalStepCount = plan?.steps.length ?? 0;
  const completedStepCount =
    plan?.steps.filter((step) => step.status === 'completed').length ?? 0;
  const inProgressStepCount =
    plan?.steps.filter((step) => step.status === 'inProgress').length ?? 0;
  const pendingStepCount =
    plan?.steps.filter((step) => step.status === 'pending').length ?? 0;
  const activeStep = plan
    ? (plan.steps.find((step) => step.status === 'inProgress') ??
      plan.steps.find((step) => step.status === 'pending') ??
      plan.steps[plan.steps.length - 1] ??
      null)
    : null;
  const collapsedSummaryRaw =
    mode === 'approval'
      ? activeStep?.step ??
        plan?.explanation?.trim() ??
        'Start coding now or keep refining the plan.'
      : mode === 'execution'
        ? activeStep?.step ??
          plan?.explanation?.trim() ??
          '(no execution details yet)'
        : activeStep?.step ?? plan?.explanation?.trim() ?? '(no steps provided)';
  const collapsedSummary = stripMarkdownInline(collapsedSummaryRaw)
    .replace(/\s*#{1,6}\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const isCollapsible = hasStructuredPlan || mode === 'approval';
  const title =
    mode === 'approval'
      ? PLAN_IMPLEMENTATION_TITLE
      : mode === 'execution'
        ? 'Execution'
        : 'Plan';
  const iconName =
    mode === 'approval'
      ? 'rocket-outline'
      : mode === 'execution'
        ? 'construct-outline'
        : 'map-outline';
  const planProgressSummary =
    totalStepCount > 0
      ? [
          `${String(completedStepCount)}/${String(totalStepCount)} done`,
          inProgressStepCount > 0 ? `${String(inProgressStepCount)} active` : null,
          pendingStepCount > 0 ? `${String(pendingStepCount)} pending` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  if (!hasStructuredPlan && mode !== 'approval') {
    return null;
  }

  const stepListContent = hasSteps ? (
    <View style={styles.planStepsList}>
      {plan?.steps.map((step, index) => (
        <View key={`${plan.turnId}-${index}-${step.step}`} style={styles.planStepRow}>
          <Text
            style={[
              styles.planStepStatus,
              step.status === 'completed'
                ? styles.planStepStatusCompleted
                : step.status === 'inProgress'
                  ? styles.planStepStatusInProgress
                  : styles.planStepStatusPending,
            ]}
          >
            {renderPlanStatusGlyph(step.status)}
          </Text>
          <View style={styles.planStepMarkdownWrap}>
            <Markdown
              style={workflowMarkdownStyles}
            >
              {step.step}
            </Markdown>
          </View>
        </View>
      ))}
    </View>
  ) : (
    <Text style={styles.planDeltaText}>(no steps provided)</Text>
  );

  const planSections = hasStructuredPlan ? (
    mode === 'execution' ? (
      <>
        <View style={styles.workflowSection}>
          <Text style={styles.workflowSectionEyebrow}>Plan summary</Text>
          {plan?.explanation ? (
            <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
          ) : activeStep ? (
            <Markdown style={workflowMarkdownStyles}>{activeStep.step}</Markdown>
          ) : null}
          {planProgressSummary ? (
            <Text style={styles.workflowMetaText}>{planProgressSummary}</Text>
          ) : null}
        </View>
        <View style={styles.workflowSection}>
          <Text style={styles.workflowSectionEyebrow}>Tasks</Text>
          {stepListContent}
        </View>
      </>
    ) : (
      <>
        {plan?.explanation ? (
          <Markdown style={workflowMarkdownStyles}>{plan.explanation}</Markdown>
        ) : null}
        {stepListContent}
      </>
    )
  ) : null;

  const header = isCollapsible ? (
    <Pressable
      style={({ pressed }) => [
        styles.planCardHeader,
        styles.planCardHeaderPressable,
        pressed && styles.modelChipPressed,
      ]}
      onPress={onToggleCollapse}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${collapsedSummary}`}
      accessibilityState={controlAccessibilityState({ expanded: !collapsed })}
    >
      <Ionicons {...decorativeAccessibilityProps} name={iconName} size={14} color={theme.colors.textPrimary} />
      <View style={styles.planCardHeaderText}>
        <Text style={styles.planCardTitle}>{title}</Text>
        {collapsed ? (
          <Text style={styles.planCardSummary} numberOfLines={1}>
            {collapsedSummary}
          </Text>
        ) : null}
      </View>
      <Ionicons
        {...decorativeAccessibilityProps}
        name={collapsed ? 'chevron-down-outline' : 'chevron-up-outline'}
        size={16}
        color={theme.colors.textMuted}
      />
    </Pressable>
  ) : (
    <View style={styles.planCardHeader}>
      <Ionicons {...decorativeAccessibilityProps} name={iconName} size={14} color={theme.colors.textPrimary} />
      <View style={styles.planCardHeaderText}>
        <Text style={styles.planCardTitle}>{title}</Text>
        <Text style={styles.planCardSummary} numberOfLines={2}>
          {collapsedSummary}
        </Text>
      </View>
    </View>
  );

  return (
    <View style={[styles.planCard, styles.planOverlayCard]}>
      {header}

      {collapsed && isCollapsible ? null : (
        <>
          {planSections ? (
            <ScrollView
              nestedScrollEnabled
              bounces={false}
              style={[styles.workflowScrollViewport, { maxHeight: scrollMaxHeight }]}
              contentContainerStyle={styles.workflowScrollContent}
              showsVerticalScrollIndicator
            >
              {planSections}
            </ScrollView>
          ) : null}

          {mode === 'approval' ? (
            <View style={styles.planPromptOptionsColumn}>
              <Pressable
                onPress={onImplement}
                disabled={actionDisabled}
                style={({ pressed }) => [
                  styles.planPromptOptionButton,
                  actionDisabled && styles.planPromptOptionButtonDisabled,
                  pressed && !actionDisabled && styles.planPromptOptionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={controlAccessibilityState({ disabled: actionDisabled })}
              >
                <Text
                  style={[
                    styles.planPromptOptionTitle,
                    actionDisabled && styles.planPromptOptionTitleDisabled,
                  ]}
                >
                  {PLAN_IMPLEMENTATION_YES}
                </Text>
                <Text
                  style={[
                    styles.planPromptOptionDescription,
                    actionDisabled && styles.planPromptOptionDescriptionDisabled,
                  ]}
                >
                  Switch to Default mode and start coding.
                </Text>
              </Pressable>
              <Pressable
                onPress={onStayInPlanMode}
                disabled={actionDisabled}
                style={({ pressed }) => [
                  styles.planPromptOptionButton,
                  actionDisabled && styles.planPromptOptionButtonDisabled,
                  pressed && !actionDisabled && styles.planPromptOptionButtonPressed,
                ]}
                accessibilityRole="button"
                accessibilityState={controlAccessibilityState({ disabled: actionDisabled })}
              >
                <Text
                  style={[
                    styles.planPromptOptionTitle,
                    actionDisabled && styles.planPromptOptionTitleDisabled,
                  ]}
                >
                  {PLAN_IMPLEMENTATION_NO}
                </Text>
                <Text
                  style={[
                    styles.planPromptOptionDescription,
                    actionDisabled && styles.planPromptOptionDescriptionDisabled,
                  ]}
                >
                  Stay in Plan mode and keep refining the approach.
                </Text>
              </Pressable>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function QueuedMessageDock({
  queuedMessage,
  remainingQueuedMessagesCount,
  pendingSubmission,
  steerEnabled,
  cancelEnabled,
  steeringActive,
  steerPending,
  waitingForToolCalls,
  steeringInFlight,
  steerDisabledReason,
  onCancelQueuedMessage,
  onSteerQueuedMessage,
}: {
  queuedMessage: BridgeQueuedMessage;
  remainingQueuedMessagesCount: number;
  pendingSubmission: boolean;
  steerEnabled: boolean;
  cancelEnabled: boolean;
  steeringActive: boolean;
  steerPending: boolean;
  waitingForToolCalls: boolean;
  steeringInFlight: boolean;
  steerDisabledReason: string | null;
  onCancelQueuedMessage: (messageId: string) => void;
  onSteerQueuedMessage: () => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <View style={styles.queuedMessageDock} accessibilityLiveRegion="polite">
      <View style={[styles.planCard, styles.planOverlayCard, styles.queuedMessageCard]}>
        <View style={styles.queuedMessageHeader}>
          <View style={styles.queuedMessageHeaderText}>
            <Text style={styles.planCardTitle}>
              {queuedMessageStatusLabel({
                pendingSubmission,
                steeringActive,
                steeringInFlight,
                steerPending,
                waitingForToolCalls,
              })}
            </Text>
            {remainingQueuedMessagesCount > 0 ? (
              <Text style={styles.queuedMessageSummary}>
                {`+${String(remainingQueuedMessagesCount)} more queued`}
              </Text>
            ) : null}
          </View>
          <View style={styles.queuedMessageActions}>
            <Pressable
              onPress={() => onCancelQueuedMessage(queuedMessage.id)}
              disabled={!cancelEnabled}
              style={({ pressed }) => [
                styles.queuedMessageActionButton,
                styles.queuedMessageActionButtonDestructive,
                !cancelEnabled && styles.queuedMessageActionButtonDisabled,
                pressed && cancelEnabled && styles.queuedMessageActionButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Cancel queued message"
              accessibilityState={controlAccessibilityState({ disabled: !cancelEnabled })}
            >
              <Text
                style={[
                  styles.queuedMessageActionLabel,
                  styles.queuedMessageActionLabelDestructive,
                  !cancelEnabled && styles.queuedMessageActionLabelDisabled,
                ]}
              >
                Cancel
              </Text>
            </Pressable>
            {!steerPending ? <Pressable
              onPress={onSteerQueuedMessage}
              disabled={!steerEnabled}
              style={({ pressed }) => [
                styles.queuedMessageActionButton,
                !steerEnabled && styles.queuedMessageActionButtonDisabled,
                pressed && steerEnabled && styles.queuedMessageActionButtonPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={steeringActive ? 'Steering queued message' : 'Steer queued message'}
              accessibilityHint={steerDisabledReason ?? undefined}
              accessibilityState={controlAccessibilityState({ disabled: !steerEnabled, busy: steeringActive })}
            >
              <Text
                style={[
                  styles.queuedMessageActionLabel,
                  !steerEnabled && styles.queuedMessageActionLabelDisabled,
                ]}
              >
                {steeringActive ? 'Steering…' : 'Steer'}
              </Text>
            </Pressable> : null}
          </View>
        </View>
        <Text numberOfLines={3} style={styles.queuedMessageBody}>
          {queuedMessage.content}
        </Text>
        {steerDisabledReason ? (
          <Text style={styles.queuedMessageHint}>{steerDisabledReason}</Text>
        ) : null}
      </View>
    </View>
  );
}
