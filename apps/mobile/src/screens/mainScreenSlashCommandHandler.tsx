import { useCallback } from 'react';
import type { MainScreenTurnStopControlContext, MainScreenTurnStopControlResult } from './mainScreenTurnStopControl';
import { executeSlashCommand } from './mainScreenSlashCommand';




export type MainScreenSlashCommandHandlerContext = MainScreenTurnStopControlContext & MainScreenTurnStopControlResult;

export function useMainScreenSlashCommandHandler(context: MainScreenSlashCommandHandlerContext) {
  const {
    activeAgentId,
    activeAgentLabel,
    activeApprovalPolicy,
    activeEffort,
    activeEffortLabel,
    activeModelId,
    activeModelLabel,
    activeServiceTier,
    activeSlashCommands,
    api,
    appendLocalAssistantMessage,
    bumpRunWatchdog,
    clearRunWatchdog,
    discardOptimisticUserMessage,
    ensureLocalCommandChat,
    fastModeEnabled,
    handleTurnFailure,
    mergeChatWithPendingOptimisticMessages,
    modelOptions,
    onLastUsedThreadSettingsChange,
    onOpenGit,
    openModelModal,
    preferredStartCwd,
    queueOptimisticUserMessage,
    registerTurnStarted,
    rememberChatModelPreference,
    scrollToBottomReliable,
    selectedChat,
    selectedChatId,
    selectedCollaborationMode,
    startNewChat,
    supportsFastMode,
    supportsGoal,
    supportsPlanMode,
    supportsReview,
  } = context;


  const handleSlashCommand = useCallback(
    (input: string): Promise<boolean> => executeSlashCommand(context, input),
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

  return {
    handleSlashCommand,
  };
}

export type MainScreenSlashCommandHandlerResult = ReturnType<typeof useMainScreenSlashCommandHandler>;
