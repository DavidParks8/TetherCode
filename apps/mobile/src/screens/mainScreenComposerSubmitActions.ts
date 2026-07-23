import { useCallback, useEffect, useRef } from 'react';
import type { MainScreenSendMessageHandlerContext, MainScreenSendMessageHandlerResult } from './mainScreenSendMessageHandler';






export type MainScreenComposerSubmitActionsContext = MainScreenSendMessageHandlerContext & MainScreenSendMessageHandlerResult;

export function useMainScreenComposerSubmitActions(context: MainScreenComposerSubmitActionsContext) {
  const {
    bumpRunWatchdog,
    cacheThreadQueueState,
    creatingRef,
    draft,
    draftController,
    handleSlashCommand,
    hasFailedAttachmentUploads,
    pendingApproval,
    pendingLocalImagePaths,
    pendingMentionPaths,
    pendingUserInputRequest,
    scrollToBottomReliable,
    selectedChat,
    selectedChatId,
    selectedChatIdRef,
    sendMessageContent,
    sendingRef,
    setDraft,
    setError,
    setQueueActionItemId,
    setQueueActionKind,
    stoppingTurnRef,
    submissionController,
    threadRuntimeSnapshotsRef,
    turnExecutionController,
    uploadingAttachment,
  } = context;


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

  return {
    sendMessageContentRef,
    sendMessage,
    handleSteerQueuedMessage,
    handleCancelQueuedMessage,
    handleInlineOptionSelect,
  };
}

export type MainScreenComposerSubmitActionsResult = ReturnType<typeof useMainScreenComposerSubmitActions>;
