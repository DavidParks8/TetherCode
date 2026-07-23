import { forwardRef } from 'react';
import type { HostBridgeApiClient } from '../api/client';
import type {
  AgentDefaultSettingsMap,
  AgentId,
  ApprovalMode,
  Chat,
  CollaborationMode,
} from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import { useMainScreenCoreBootstrap } from './mainScreenCoreBootstrap';
import { useMainScreenLifecycleRecovery } from './mainScreenLifecycleRecovery';
import { useMainScreenChatSessionState } from './mainScreenChatSessionState';
import { useMainScreenLocalTranscriptActions } from './mainScreenLocalTranscriptActions';
import { useMainScreenThreadSnapshotStore } from './mainScreenThreadSnapshotStore';
import { useMainScreenChatHydration } from './mainScreenChatHydration';
import { useMainScreenRuntimeWatchdogSync } from './mainScreenRuntimeWatchdogSync';
import { useMainScreenThreadRuntimeMutations } from './mainScreenThreadRuntimeMutations';
import { useMainScreenSelectedRuntimeSelectors } from './mainScreenSelectedRuntimeSelectors';
import { useMainScreenModelCatalogState } from './mainScreenModelCatalogState';
import { useMainScreenCapabilityFlags } from './mainScreenCapabilityFlags';
import { useMainScreenWorkspaceBrowserState } from './mainScreenWorkspaceBrowserState';
import { useMainScreenAgentThreadsRefresh } from './mainScreenAgentThreadsRefresh';
import { useMainScreenWorkspaceCheckoutActions } from './mainScreenWorkspaceCheckoutActions';
import { useMainScreenModeConfigurationSession } from './mainScreenModeConfigurationSession';
import { useMainScreenComposerControlActions } from './mainScreenComposerControlActions';
import { useMainScreenPickerOptionBuilders } from './mainScreenPickerOptionBuilders';
import { useMainScreenLocalCommandChat } from './mainScreenLocalCommandChat';
import { useMainScreenReasoningAndInterrupt } from './mainScreenReasoningAndInterrupt';
import { useMainScreenTurnStopControl } from './mainScreenTurnStopControl';
import { useMainScreenSlashCommandHandler } from './mainScreenSlashCommandHandler';
import { useMainScreenChatLoadPipeline } from './mainScreenChatLoadPipeline';
import { useMainScreenChatNavigationAndAgentDetail } from './mainScreenChatNavigationAndAgentDetail';
import { useMainScreenAgentThreadSelectorState } from './mainScreenAgentThreadSelectorState';
import { useMainScreenAgentThreadEventBootstrap } from './mainScreenAgentThreadEventBootstrap';
import { useMainScreenChatCreationFlow } from './mainScreenChatCreationFlow';
import { useMainScreenSendMessageHandler } from './mainScreenSendMessageHandler';
import { useMainScreenComposerSubmitActions } from './mainScreenComposerSubmitActions';
import { useMainScreenReplayRecoveryEngine } from './mainScreenReplayRecoveryEngine';
import { useMainScreenWsEventRouter } from './mainScreenWsEventRouter';
import { useMainScreenApprovalAndUserInputResolution } from './mainScreenApprovalAndUserInputResolution';
import { useMainScreenUiActionHandlers } from './mainScreenUiActionHandlers';
import { useMainScreenHeaderActivityViewModel } from './mainScreenHeaderActivityViewModel';
import { useMainScreenWorkflowQueueState } from './mainScreenWorkflowQueueState';
import { useMainScreenComposerRenderer } from './mainScreenComposerRenderer';
import { useMainScreenPlanExecutionActions } from './mainScreenPlanExecutionActions';
import { useMainScreenPanelCollapseCoordinator } from './mainScreenPanelCollapseCoordinator';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './mainScreenPanelCollapseCoordinator';
import { MainScreenView } from './MainScreenView';

export interface MainScreenHandle {
  openChat: (id: string, optimisticChat?: Chat | null) => void;
  startNewChat: () => void;
}

export interface MainScreenProps {
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
    const mainScreenBaseContext = {
      api,
      ws,
      bridgeUrl,
      bridgeToken,
      bridgeProfileId,
      onOpenDrawer,
      onOpenGit,
      onOpenLocalPreview: onOpenLocalPreviewHandler ?? undefined,
      onOpenBridgeRecoveryGuide,
      defaultStartCwd,
      preferredAgentId,
      agentSettings,
      approvalMode,
      showToolCalls: showToolCalls ?? true,
      onDefaultStartCwdChange,
      onLastUsedThreadSettingsChange,
      onChatContextChange,
      onChatOpeningStateChange,
      pendingOpenChatId,
      pendingOpenChatSnapshot,
      onPendingOpenChatHandled,
      ref,
    };
    const coreBootstrapResult = useMainScreenCoreBootstrap(mainScreenBaseContext);
    const coreBootstrapContext = { ...mainScreenBaseContext, ...coreBootstrapResult };
    const lifecycleRecoveryResult = useMainScreenLifecycleRecovery(coreBootstrapContext);
    const lifecycleRecoveryContext = { ...coreBootstrapContext, ...lifecycleRecoveryResult };
    const chatSessionStateResult = useMainScreenChatSessionState(lifecycleRecoveryContext);
    const chatSessionStateContext = { ...lifecycleRecoveryContext, ...chatSessionStateResult };
    const localTranscriptActionsResult = useMainScreenLocalTranscriptActions(chatSessionStateContext);
    const localTranscriptActionsContext = { ...chatSessionStateContext, ...localTranscriptActionsResult };
    const threadSnapshotStoreResult = useMainScreenThreadSnapshotStore(localTranscriptActionsContext);
    const threadSnapshotStoreContext = { ...localTranscriptActionsContext, ...threadSnapshotStoreResult };
    const chatHydrationResult = useMainScreenChatHydration(threadSnapshotStoreContext);
    const chatHydrationContext = { ...threadSnapshotStoreContext, ...chatHydrationResult };
    const runtimeWatchdogSyncResult = useMainScreenRuntimeWatchdogSync(chatHydrationContext);
    const runtimeWatchdogSyncContext = { ...chatHydrationContext, ...runtimeWatchdogSyncResult };
    const threadRuntimeMutationsResult = useMainScreenThreadRuntimeMutations(runtimeWatchdogSyncContext);
    const threadRuntimeMutationsContext = { ...runtimeWatchdogSyncContext, ...threadRuntimeMutationsResult };
    const selectedRuntimeSelectorsResult = useMainScreenSelectedRuntimeSelectors(threadRuntimeMutationsContext);
    const selectedRuntimeSelectorsContext = { ...threadRuntimeMutationsContext, ...selectedRuntimeSelectorsResult };
    const modelCatalogStateResult = useMainScreenModelCatalogState(selectedRuntimeSelectorsContext);
    const modelCatalogStateContext = { ...selectedRuntimeSelectorsContext, ...modelCatalogStateResult };
    const capabilityFlagsResult = useMainScreenCapabilityFlags(modelCatalogStateContext);
    const capabilityFlagsContext = { ...modelCatalogStateContext, ...capabilityFlagsResult };
    const workspaceBrowserStateResult = useMainScreenWorkspaceBrowserState(capabilityFlagsContext);
    const workspaceBrowserStateContext = { ...capabilityFlagsContext, ...workspaceBrowserStateResult };
    const agentThreadsRefreshResult = useMainScreenAgentThreadsRefresh(workspaceBrowserStateContext);
    const agentThreadsRefreshContext = { ...workspaceBrowserStateContext, ...agentThreadsRefreshResult };
    const workspaceCheckoutActionsResult = useMainScreenWorkspaceCheckoutActions(agentThreadsRefreshContext);
    const workspaceCheckoutActionsContext = { ...agentThreadsRefreshContext, ...workspaceCheckoutActionsResult };
    const modeConfigurationSessionResult = useMainScreenModeConfigurationSession(workspaceCheckoutActionsContext);
    const modeConfigurationSessionContext = { ...workspaceCheckoutActionsContext, ...modeConfigurationSessionResult };
    const composerControlActionsResult = useMainScreenComposerControlActions(modeConfigurationSessionContext);
    const composerControlActionsContext = { ...modeConfigurationSessionContext, ...composerControlActionsResult };
    const pickerOptionBuildersResult = useMainScreenPickerOptionBuilders(composerControlActionsContext);
    const pickerOptionBuildersContext = { ...composerControlActionsContext, ...pickerOptionBuildersResult };
    const localCommandChatResult = useMainScreenLocalCommandChat(pickerOptionBuildersContext);
    const localCommandChatContext = { ...pickerOptionBuildersContext, ...localCommandChatResult };
    const reasoningAndInterruptResult = useMainScreenReasoningAndInterrupt(localCommandChatContext);
    const reasoningAndInterruptContext = { ...localCommandChatContext, ...reasoningAndInterruptResult };
    const turnStopControlResult = useMainScreenTurnStopControl(reasoningAndInterruptContext);
    const turnStopControlContext = { ...reasoningAndInterruptContext, ...turnStopControlResult };
    const slashCommandHandlerResult = useMainScreenSlashCommandHandler(turnStopControlContext);
    const slashCommandHandlerContext = { ...turnStopControlContext, ...slashCommandHandlerResult };
    const chatLoadPipelineResult = useMainScreenChatLoadPipeline(slashCommandHandlerContext);
    const chatLoadPipelineContext = { ...slashCommandHandlerContext, ...chatLoadPipelineResult };
    const chatNavigationAndAgentDetailResult = useMainScreenChatNavigationAndAgentDetail(chatLoadPipelineContext);
    const chatNavigationAndAgentDetailContext = { ...chatLoadPipelineContext, ...chatNavigationAndAgentDetailResult };
    const agentThreadSelectorStateResult = useMainScreenAgentThreadSelectorState(chatNavigationAndAgentDetailContext);
    const agentThreadSelectorStateContext = { ...chatNavigationAndAgentDetailContext, ...agentThreadSelectorStateResult };
    const agentThreadEventBootstrapResult = useMainScreenAgentThreadEventBootstrap(agentThreadSelectorStateContext);
    const agentThreadEventBootstrapContext = { ...agentThreadSelectorStateContext, ...agentThreadEventBootstrapResult };
    const chatCreationFlowResult = useMainScreenChatCreationFlow(agentThreadEventBootstrapContext);
    const chatCreationFlowContext = { ...agentThreadEventBootstrapContext, ...chatCreationFlowResult };
    const sendMessageHandlerResult = useMainScreenSendMessageHandler(chatCreationFlowContext);
    const sendMessageHandlerContext = { ...chatCreationFlowContext, ...sendMessageHandlerResult };
    const composerSubmitActionsResult = useMainScreenComposerSubmitActions(sendMessageHandlerContext);
    const composerSubmitActionsContext = { ...sendMessageHandlerContext, ...composerSubmitActionsResult };
    const replayRecoveryEngineResult = useMainScreenReplayRecoveryEngine(composerSubmitActionsContext);
    const replayRecoveryEngineContext = { ...composerSubmitActionsContext, ...replayRecoveryEngineResult };
    const wsEventRouterResult = useMainScreenWsEventRouter(replayRecoveryEngineContext);
    const wsEventRouterContext = { ...replayRecoveryEngineContext, ...wsEventRouterResult };
    const approvalAndUserInputResolutionResult = useMainScreenApprovalAndUserInputResolution(wsEventRouterContext);
    const approvalAndUserInputResolutionContext = { ...wsEventRouterContext, ...approvalAndUserInputResolutionResult };
    const uiActionHandlersResult = useMainScreenUiActionHandlers(approvalAndUserInputResolutionContext);
    const uiActionHandlersContext = { ...approvalAndUserInputResolutionContext, ...uiActionHandlersResult };
    const headerActivityViewModelResult = useMainScreenHeaderActivityViewModel(uiActionHandlersContext);
    const headerActivityViewModelContext = { ...uiActionHandlersContext, ...headerActivityViewModelResult };
    const workflowQueueStateResult = useMainScreenWorkflowQueueState(headerActivityViewModelContext);
    const workflowQueueStateContext = { ...headerActivityViewModelContext, ...workflowQueueStateResult };
    const composerRendererResult = useMainScreenComposerRenderer(workflowQueueStateContext);
    const composerRendererContext = { ...workflowQueueStateContext, ...composerRendererResult };
    const planExecutionActionsResult = useMainScreenPlanExecutionActions(composerRendererContext);
    const planExecutionActionsContext = { ...composerRendererContext, ...planExecutionActionsResult };
    const panelCollapseCoordinatorResult = useMainScreenPanelCollapseCoordinator(planExecutionActionsContext);
    const panelCollapseCoordinatorContext = { ...planExecutionActionsContext, ...panelCollapseCoordinatorResult };
    const mainScreenContext = panelCollapseCoordinatorContext as MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;
    return <MainScreenView context={mainScreenContext} />;
  }
);
