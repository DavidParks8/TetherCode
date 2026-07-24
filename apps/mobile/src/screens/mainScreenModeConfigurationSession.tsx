import { useCallback, useRef } from 'react';
import type { AcpConfigOption, Chat, ReasoningEffort } from '../api/types';
import { normalizeModelId } from './mainScreenHelpers';
import { agentModelPreferenceKey } from './mainScreenHelperPreferences';
import { mergeModelOptions, modelOptionsFromAcpConfig } from './mainScreenChatState';
import type { MainScreenWorkspaceCheckoutActionsContext, MainScreenWorkspaceCheckoutActionsResult } from './mainScreenWorkspaceCheckoutActions';
import { EMPTY_MODEL_OPTIONS } from './mainScreenConstants';






export type MainScreenModeConfigurationSessionContext = MainScreenWorkspaceCheckoutActionsContext & MainScreenWorkspaceCheckoutActionsResult;

export function useMainScreenModeConfigurationSession(context: MainScreenModeConfigurationSessionContext) {
  const {
    activeAgentId,
    activeApprovalPolicy,
    activeModelId,
    activeServiceTier,
    api,
    chatModelPreferencesRef,
    effortConfig,
    loadingModels,
    modelOptionsRequestRef,
    preferredStartCwd,
    rememberChatModelPreference,
    saveChatModelPreferences,
    selectedAcpModeId,
    selectedChatId,
    selectedChatIdRef,
    selectedChatRef,
    selectedCollaborationMode,
    selectedEffort,
    setAgentModalVisible,
    setEffortModalVisible,
    setEffortPickerModelId,
    setError,
    setLoadingModels,
    setModelModalVisible,
    setModelOptionsByAgent,
    setSelectedChat,
    setSelectedChatId,
    setSelectedEffort,
  } = context;


  const refreshModelOptions = useCallback(async () => {
    const requestId = modelOptionsRequestRef.current + 1;
    modelOptionsRequestRef.current = requestId;
    setLoadingModels(true);
    try {
      const catalogModels = await api.listModelOptions(activeAgentId);
      if (modelOptionsRequestRef.current !== requestId) {
        return;
      }
      if (activeAgentId) {
        setModelOptionsByAgent((previous) => ({
          ...previous,
          [activeAgentId]: Array.isArray(catalogModels) ? catalogModels : EMPTY_MODEL_OPTIONS,
        }));
      }
    } catch (err) {
      if (modelOptionsRequestRef.current === requestId) {
        setError((err as Error).message);
      }
    } finally {
      if (modelOptionsRequestRef.current === requestId) {
        setLoadingModels(false);
      }
    }
  }, [activeAgentId, api]);

  const configurationSessionRef = useRef<Promise<Chat | null> | null>(null);
  const ensureModeConfigurationSession = useCallback(async (): Promise<Chat | null> => {
    if (selectedChatRef.current?.id) {
      return selectedChatRef.current;
    }
    if (configurationSessionRef.current) {
      return configurationSessionRef.current;
    }
    const request = api.createChat({
      agentId: activeAgentId ?? undefined,
      cwd: preferredStartCwd ?? undefined,
      model: activeModelId ?? undefined,
      effort: selectedEffort ?? undefined,
      serviceTier: activeServiceTier ?? undefined,
      approvalPolicy: activeApprovalPolicy,
      collaborationMode: selectedCollaborationMode,
      agentMode: selectedAcpModeId,
    }).then((chat) => {
      selectedChatIdRef.current = chat.id;
      selectedChatRef.current = chat;
      setSelectedChatId(chat.id);
      setSelectedChat(chat);
      const models = modelOptionsFromAcpConfig(chat.acpConfig ?? []);
      if (chat.agentId && models.length > 0) {
        setModelOptionsByAgent((previous) => ({
          ...previous,
          [chat.agentId!]: mergeModelOptions(previous[chat.agentId!] ?? EMPTY_MODEL_OPTIONS, models),
        }));
      }
      return chat;
    }).catch((err) => {
      setError((err as Error).message);
      return null;
    }).finally(() => {
      configurationSessionRef.current = null;
    });
    configurationSessionRef.current = request;
    return request;
  }, [
    activeAgentId,
    activeApprovalPolicy,
    activeModelId,
    activeServiceTier,
    api,
    preferredStartCwd,
    selectedAcpModeId,
    selectedCollaborationMode,
    selectedEffort,
  ]);

  const openModelModal = useCallback(() => {
    setModelModalVisible(true);
    void refreshModelOptions();
  }, [refreshModelOptions]);

  const closeModelModal = useCallback(() => {
    if (loadingModels) {
      return;
    }
    setModelModalVisible(false);
  }, [loadingModels]);

  const openAgentModal = useCallback(() => {
    if (selectedChatId) {
      return;
    }
    setAgentModalVisible(true);
    setError(null);
  }, [selectedChatId]);

  const closeAgentModal = useCallback(() => {
    setAgentModalVisible(false);
  }, []);

  const openEffortModal = useCallback(
    (modelId?: string | null) => {
      const resolvedModelId = normalizeModelId(modelId ?? activeModelId);
      if (!resolvedModelId) {
        setError('Select a model first');
        return;
      }

      setEffortPickerModelId(resolvedModelId);
      setEffortModalVisible(true);
      setError(null);
    },
    [activeModelId]
  );

  const closeEffortModal = useCallback(() => {
    setEffortModalVisible(false);
  }, []);

  const applyAcpConfigOption = useCallback(
    async (config: AcpConfigOption | null, value: string): Promise<Chat | null> => {
      if (!selectedChatId || !config) {
        return null;
      }
      try {
        const updated = await api.setThreadConfigOption(selectedChatId, config.id, value);
        selectedChatRef.current = updated;
        setSelectedChat(updated);
        return updated;
      } catch (err) {
        setError((err as Error).message);
        return null;
      }
    },
    [api, selectedChatId]
  );

  const selectEffort = useCallback(
    async (effort: ReasoningEffort | null) => {
      const value = effort ?? effortConfig?.value;
      if (effortConfig && value) {
        const updated = await applyAcpConfigOption(effortConfig, value);
        if (!updated) {
          return;
        }
      }
      setSelectedEffort(effort);
      setEffortModalVisible(false);
      setError(null);
      if (selectedChatId) {
        rememberChatModelPreference(
          selectedChatId,
          activeModelId,
          effort,
          activeServiceTier
        );
      } else if (activeAgentId) {
        const key = agentModelPreferenceKey(activeAgentId);
        const previous = chatModelPreferencesRef.current[key];
        const nextPreferences = {
          ...chatModelPreferencesRef.current,
          [key]: {
            modelId: activeModelId,
            effort,
            serviceTier: activeServiceTier,
            updatedAt: new Date().toISOString(),
            ...(previous?.modelId && !activeModelId ? { modelId: previous.modelId } : {}),
          },
        };
        chatModelPreferencesRef.current = nextPreferences;
        void saveChatModelPreferences(nextPreferences);
      }
    },
    [
      activeModelId,
      activeServiceTier,
      activeAgentId,
      applyAcpConfigOption,
      chatModelPreferencesRef,
      effortConfig,
      rememberChatModelPreference,
      saveChatModelPreferences,
      selectedChatId,
    ]
  );

  return {
    refreshModelOptions,
    configurationSessionRef,
    ensureModeConfigurationSession,
    openModelModal,
    closeModelModal,
    openAgentModal,
    closeAgentModal,
    openEffortModal,
    closeEffortModal,
    applyAcpConfigOption,
    selectEffort,
  };
}

export type MainScreenModeConfigurationSessionResult = ReturnType<typeof useMainScreenModeConfigurationSession>;
