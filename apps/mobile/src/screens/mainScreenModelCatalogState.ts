import { useEffect } from 'react';
import type { CollaborationMode } from '../api/types';
import { selectAgentId } from '../agents';
import { formatModelOptionLabel } from '../modelOptions';
import { normalizeServiceTier, toSelectedServiceTier, resolveSelectedServiceTier, formatCollaborationModeLabel, formatReasoningEffort } from './mainScreenHelpers';
import type { MainScreenSelectedRuntimeSelectorsContext, MainScreenSelectedRuntimeSelectorsResult } from './mainScreenSelectedRuntimeSelectors';






export type MainScreenModelCatalogStateContext = MainScreenSelectedRuntimeSelectorsContext & MainScreenSelectedRuntimeSelectorsResult;

export function useMainScreenModelCatalogState(context: MainScreenModelCatalogStateContext) {
  const {
    activity,
    bridgeCapabilities,
    chatModelPreferencesLoaded,
    chatModelPreferencesRef,
    defaultServiceTier,
    effortPickerModelId,
    modeConfig,
    modelOptions,
    pendingAgentId,
    preferredAgentId,
    preferredCollaborationMode,
    preferredDefaultEffort,
    preferredDefaultModelId,
    preferredServiceTier,
    selectedAcpModeId,
    selectedChatId,
    selectedCollaborationMode,
    selectedEffort,
    selectedModelId,
    selectedServiceTier,
    setActivity,
    setPendingAgentId,
    setSelectedCollaborationMode,
    setSelectedEffort,
    setSelectedModelId,
    setSelectedServiceTier,
    supportsFastMode,
  } = context;


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
    setSelectedCollaborationMode(preferredCollaborationMode as CollaborationMode);
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

  return {
    serverDefaultModel,
    serverDefaultModelId,
    selectedModel,
    preferredDefaultModel,
    activeModel,
    unresolvedDefaultModelId,
    activeModelId,
    effortPickerModel,
    effortPickerOptions,
    effortPickerDefault,
    activeModelEffortOptions,
    activeModelDefaultEffort,
    requestedEffort,
    appliedServiceTierForSelectedChat,
    activeServiceTier,
    fastModeEnabled,
    supportsSelectedEffort,
    activeEffort,
    activeModelLabel,
    activeEffortLabel,
    collaborationModeLabel,
    hasPendingServiceTierChange,
    fastModeLabel,
  };
}

export type MainScreenModelCatalogStateResult = ReturnType<typeof useMainScreenModelCatalogState>;
