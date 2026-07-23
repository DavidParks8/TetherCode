import { useCallback } from 'react';
import type { Chat } from '../api/types';
import type { MainScreenPickerOptionBuildersContext, MainScreenPickerOptionBuildersResult } from './mainScreenPickerOptionBuilders';






export type MainScreenLocalCommandChatContext = MainScreenPickerOptionBuildersContext & MainScreenPickerOptionBuildersResult;

export function useMainScreenLocalCommandChat(context: MainScreenLocalCommandChatContext) {
  const {
    activeAgentId,
    activeApprovalPolicy,
    activeEffort,
    activeModelId,
    activeServiceTier,
    api,
    preferredStartCwd,
    scrollToBottomIfPinned,
    selectedAcpModeId,
    selectedChatId,
    selectedChatIdRef,
    selectedChatRef,
    selectedCollaborationMode,
    setError,
    setSelectedChat,
    setSelectedChatId,
  } = context;


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

  return {
    appendLocalAssistantMessage,
    ensureLocalCommandChat,
    appendLocalSystemMessage,
  };
}

export type MainScreenLocalCommandChatResult = ReturnType<typeof useMainScreenLocalCommandChat>;
