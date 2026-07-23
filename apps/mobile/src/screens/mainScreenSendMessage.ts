import type {
  BridgeUiSurface,
  ChatMessage as ChatTranscriptMessage,
  CollaborationMode,
  LocalImageInput,
  MentionInput,
} from '../api/types';
import { getMessageText } from '../api/messages';
import { toMentionInput, toOptimisticUserContent, normalizeChatMessageMatchContent, shouldAutoEnablePlanModeFromChat, isChatLikelyRunning, parseGoalSlashObjective, buildOptimisticGoalBridgeUiSurface } from './mainScreenHelpers';
import type { MainScreenSendMessageHandlerContext } from './mainScreenSendMessageHandler';
import type { ComposerSubmission } from './controllers/submissionController';

export interface SendMessageOptions {
  allowSlashCommands?: boolean;
  collaborationMode?: CollaborationMode;
  mentions?: MentionInput[];
  localImages?: LocalImageInput[];
  clearComposer?: boolean;
  preservePlan?: boolean;
  suppressPlanModeAutoEnable?: boolean;
  submission?: ComposerSubmission;
}

export async function executeSendMessage(context: MainScreenSendMessageHandlerContext, rawContent: string, options?: SendMessageOptions): Promise<boolean> {
  const {
    selectedChatId,
    handleSlashCommand,
    setDraft,
    selectedCollaborationMode,
    pendingMentionPaths,
    selectedChat,
    pendingLocalImagePaths,
    submissionController,
    draftController,
    threadRuntimeSnapshotsRef,
    supportsGoal,
    activeBridgeUiSurfaces,
    replaceThreadBridgeUiSurfaces,
    selectedChatIdRef,
    setActiveBridgeUiSurfaces,
    activeTurnIdRef,
    selectedChatRef,
    pendingApproval,
    pendingUserInputRequest,
    queueOptimisticQueuedMessage,
    discardOptimisticUserMessage,
    setSelectedChat,
    setSending,
    setActivity,
    bumpRunWatchdog,
    attachmentController,
    queueOptimisticUserMessage,
    scrollToBottomReliable,
    turnExecutionController,
    activeModelId,
    activeEffort,
    activeServiceTier,
    activeApprovalPolicy,
    discardOptimisticQueuedMessage,
    cacheThreadQueueState,
    rememberChatModelPreference,
    selectedEffort,
    setError,
    clearRunWatchdog,
    registerTurnStarted,
    setStoppingTurn,
    stopRequestedRef,
    setActivePlan,
    cacheThreadPlan,
    setPendingUserInputRequest,
    setUserInputDrafts,
    setUserInputError,
    setResolvingUserInput,
    mergeChatWithPendingOptimisticMessages,
    setSelectedCollaborationMode,
    setShowDelayedGenericRunningActivity,
    handleTurnFailure,
  } = context;

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
            setShowDelayedGenericRunningActivity(true);
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


}
