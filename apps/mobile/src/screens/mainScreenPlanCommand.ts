import type { ChatMessage as ChatTranscriptMessage } from '../api/types';
import { getMessageText } from '../api/messages';
import { normalizeChatMessageMatchContent, shouldAutoEnablePlanModeFromChat } from './mainScreenHelpers';
import type { MainScreenSlashCommandHandlerContext } from './mainScreenSlashCommandHandler';

export async function executePlanCommand(context: MainScreenSlashCommandHandlerContext, argText: string): Promise<boolean> {
  const {
    setSelectedCollaborationMode,
    setActivity,
    setError,
    selectedChatId,
    submissionController,
    draftController,
    selectedChatIdRef,
    setDraft,
    setCreating,
    setActiveTurnId,
    setStoppingTurn,
    stopRequestedRef,
    setActivePlan,
    setPendingUserInputRequest,
    setUserInputDrafts,
    setUserInputError,
    setResolvingUserInput,
    turnExecutionController,
    activeAgentId,
    preferredStartCwd,
    activeModelId,
    activeEffort,
    activeServiceTier,
    activeApprovalPolicy,
    selectedAcpModeId,
    onLastUsedThreadSettingsChange,
    queueOptimisticUserMessage,
    setSelectedChatId,
    setSelectedChat,
    bumpRunWatchdog,
    registerTurnStarted,
    mergeChatWithPendingOptimisticMessages,
    rememberChatModelPreference,
    selectedEffort,
    clearRunWatchdog,
    discardOptimisticUserMessage,
    handleTurnFailure,
    setSending,
    cacheThreadPlan,
    selectedChat,
    scrollToBottomReliable,
  } = context;
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
