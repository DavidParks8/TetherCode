import { useCallback, useEffect } from 'react';
import type { Chat, ChatMessage as ChatTranscriptMessage } from '../api/types';
import { type PendingOptimisticQueuedMessage, countUserMessages, reconcileChatWithPendingOptimisticMessages, parseMentionQuery, parseSlashQuery, filterSlashCommands } from './mainScreenHelpers';
import type { MainScreenChatSessionStateContext, MainScreenChatSessionStateResult } from './mainScreenChatSessionState';






export type MainScreenLocalTranscriptActionsContext = MainScreenChatSessionStateContext & MainScreenChatSessionStateResult;

export function useMainScreenLocalTranscriptActions(context: MainScreenLocalTranscriptActionsContext) {
  const {
    activeSlashCommands,
    attachmentController,
    bumpAgentRuntimeRevision,
    draft,
    parentChatCacheRef,
    pendingOptimisticQueuedMessagesRef,
    pendingOptimisticUserMessagesRef,
    selectedChat,
    selectedChatRef,
    windowHeight,
  } = context;

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

  return {
    slashQuery,
    slashSuggestions,
    mentionQuery,
    mentionPathSuggestions,
    slashSuggestionsMaxHeight,
    queueOptimisticUserMessage,
    discardOptimisticUserMessage,
    mergeChatWithPendingOptimisticMessages,
    queueOptimisticQueuedMessage,
    discardOptimisticQueuedMessage,
  };
}

export type MainScreenLocalTranscriptActionsResult = ReturnType<typeof useMainScreenLocalTranscriptActions>;
