import { useCallback } from 'react';
import type { AgentId } from '../api/types';
import { normalizeWorkspacePath } from './mainScreenHelpers';
import type { MainScreenModelCatalogStateContext, MainScreenModelCatalogStateResult } from './mainScreenModelCatalogState';






export type MainScreenCapabilityFlagsContext = MainScreenModelCatalogStateContext & MainScreenModelCatalogStateResult;

export function useMainScreenCapabilityFlags(context: MainScreenCapabilityFlagsContext) {
  const {
    agentSettings,
    api,
    attachmentController,
    clearExternalStatusFullSync,
    clearRunWatchdog,
    defaultServiceTier,
    hadCommandRef,
    loadChatRequestRef,
    openingChatStartedAtRef,
    reasoningSummaryRef,
    selectedChat,
    selectedChatRef,
    selectedNewAgentId,
    setActiveCommands,
    setActivePlan,
    setActiveTurnId,
    setActivity,
    setAgentThreadMenuVisible,
    setCollaborationModeMenuVisible,
    setEffortModalVisible,
    setError,
    setLoadingWorkspaceRoots,
    setModelModalVisible,
    setOpeningChatId,
    setPendingAgentId,
    setPendingApproval,
    setPendingUserInputRequest,
    setQueueActionItemId,
    setQueueActionKind,
    setResolvingUserInput,
    setSelectedAcpModeId,
    setSelectedChat,
    setSelectedChatId,
    setSelectedCollaborationMode,
    setSelectedServiceTier,
    setStoppingTurn,
    setStreamingText,
    setTitleDraft,
    setTitleModalVisible,
    setTitleSaving,
    setUserInputDrafts,
    setUserInputError,
    setWorkspaceBridgeRoot,
    setWorkspaceBrowseError,
    setWorkspaceModalVisible,
    setWorkspaceRoots,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    titleDraft,
    titleSaving,
  } = context;


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

  return {
    resetComposerState,
    startNewChat,
    openTitleEditor,
    closeTitleEditor,
    saveTitle,
    refreshWorkspaceRoots,
  };
}

export type MainScreenCapabilityFlagsResult = ReturnType<typeof useMainScreenCapabilityFlags>;
