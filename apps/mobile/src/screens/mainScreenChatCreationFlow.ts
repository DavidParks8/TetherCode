import { useCallback, useEffect, useRef } from 'react';
import type { Chat, ChatMessage as ChatTranscriptMessage } from '../api/types';
import { toMentionInput, toOptimisticUserContent, countUserMessages, shouldAutoEnablePlanModeFromChat } from './mainScreenHelpers';
import type { MainScreenAgentThreadEventBootstrapContext, MainScreenAgentThreadEventBootstrapResult } from './mainScreenAgentThreadEventBootstrap';






export type MainScreenChatCreationFlowContext = MainScreenAgentThreadEventBootstrapContext & MainScreenAgentThreadEventBootstrapResult;

export function useMainScreenChatCreationFlow(context: MainScreenChatCreationFlowContext) {
  const {
    activeAgentId,
    activeApprovalPolicy,
    activeEffort,
    activeModelId,
    activeServiceTier,
    attachmentController,
    bumpRunWatchdog,
    clearRunWatchdog,
    discardOptimisticUserMessage,
    draft,
    draftController,
    handleSlashCommand,
    handleTurnFailure,
    mergeChatWithPendingOptimisticMessages,
    onLastUsedThreadSettingsChange,
    pendingLocalImagePaths,
    pendingMentionPaths,
    preferredAgentId,
    preferredStartCwd,
    queueOptimisticUserMessage,
    registerTurnStarted,
    rememberChatModelPreference,
    scrollToBottomReliable,
    selectedChatId,
    selectedAcpModeId,
    selectedChatIdRef,
    selectedChatRef,
    selectedCollaborationMode,
    selectedEffort,
    setActivePlan,
    setActiveTurnId,
    setActivity,
    setCreating,
    setDraft,
    setError,
    setPendingUserInputRequest,
    setResolvingUserInput,
    setSelectedChat,
    setSelectedChatId,
    setSelectedCollaborationMode,
    setStoppingTurn,
    setUserInputDrafts,
    setUserInputError,
    stopRequestedRef,
    submissionController,
    turnExecutionController,
  } = context;
  const pendingRestoredDraftRef = useRef<string | null>(null);

  useEffect(() => {
    if (pendingRestoredDraftRef.current === null) {
      return;
    }
    const restoredDraft = pendingRestoredDraftRef.current;
    pendingRestoredDraftRef.current = null;
    setDraft(restoredDraft);
  }, [selectedChatId, setDraft]);


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
        pendingRestoredDraftRef.current = submission.draft;
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

  return {
    createChat,
  };
}

export type MainScreenChatCreationFlowResult = ReturnType<typeof useMainScreenChatCreationFlow>;
