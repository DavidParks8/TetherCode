import { useCallback, useEffect, useMemo } from 'react';
import type { AgentId, ServiceTier } from '../api/types';
import { type SelectionSheetOption } from '../components/SelectionSheet';
import { normalizeModelId } from './mainScreenHelpers';
import { agentModelPreferenceKey } from './mainScreenHelperPreferences';
import { ATTACHMENT_MAX_LABEL } from './controllers/attachmentController';
import type { MainScreenModeConfigurationSessionContext, MainScreenModeConfigurationSessionResult } from './mainScreenModeConfigurationSession';






export type MainScreenComposerControlActionsContext = MainScreenModeConfigurationSessionContext & MainScreenModeConfigurationSessionResult;

export function useMainScreenComposerControlActions(context: MainScreenComposerControlActionsContext) {
  const {
    activeServiceTier,
    activeAgentId,
    chatModelPreferencesRef,
    agentSettings,
    applyAcpConfigOption,
    attachmentController,
    attachmentPickerBusy,
    ensureModeConfigurationSession,
    hasFailedAttachmentUploads,
    modelConfig,
    modelOptions,
    refreshModelOptions,
    rememberChatModelPreference,
    saveChatModelPreferences,
    retryFailedUploads,
    selectedChatId,
    setActivity,
    setAgentModalVisible,
    setCollaborationModeMenuVisible,
    setEffortModalVisible,
    setEffortPickerModelId,
    setError,
    setModelModalVisible,
    setPendingAgentId,
    setSelectedAcpModeId,
    setSelectedCollaborationMode,
    setSelectedEffort,
    setSelectedModelId,
    setSelectedServiceTier,
    supportsFastMode,
    uploadingAttachment,
    ws,
  } = context;


  const selectModel = useCallback(
    async (modelId: string | null) => {
      const normalizedModelId = normalizeModelId(modelId);
      if (normalizedModelId && modelConfig) {
        const updated = await applyAcpConfigOption(modelConfig, normalizedModelId);
        if (!updated) {
          return;
        }
      }
      setSelectedModelId(normalizedModelId);
      setSelectedEffort(null);
      setModelModalVisible(false);
      setError(null);
      if (selectedChatId) {
        rememberChatModelPreference(
          selectedChatId,
          normalizedModelId,
          null,
          activeServiceTier
        );
      } else if (activeAgentId) {
        const key = agentModelPreferenceKey(activeAgentId);
        const nextPreferences = {
          ...chatModelPreferencesRef.current,
          [key]: {
            modelId: normalizedModelId,
            effort: null,
            serviceTier: activeServiceTier,
            updatedAt: new Date().toISOString(),
          },
        };
        chatModelPreferencesRef.current = nextPreferences;
        void saveChatModelPreferences(nextPreferences);
      }

      if (normalizedModelId) {
        const model = modelOptions.find((entry) => entry.id === normalizedModelId) ?? null;
        if ((model?.reasoningEffort?.length ?? 0) > 0) {
          setEffortPickerModelId(normalizedModelId);
          setEffortModalVisible(true);
        }
      }
    },
    [
      activeServiceTier,
      activeAgentId,
      applyAcpConfigOption,
      chatModelPreferencesRef,
      modelConfig,
      modelOptions,
      rememberChatModelPreference,
      saveChatModelPreferences,
      selectedChatId,
    ]
  );

  const selectPendingAgent = useCallback((agentId: AgentId) => {
    if (selectedChatId) {
      return;
    }

    const rememberedSettings = agentSettings?.[agentId];
    setPendingAgentId(agentId);
    setSelectedModelId(null);
    setSelectedEffort(null);
    setSelectedServiceTier(undefined);
    setSelectedAcpModeId(null);
    setSelectedCollaborationMode(
      rememberedSettings?.collaborationMode === 'plan'
        ? rememberedSettings.collaborationMode
        : 'default'
    );
    setAgentModalVisible(false);
    setError(null);
  }, [agentSettings, selectedChatId]);

  useEffect(() => {
    if (ws.isConnected) {
      void refreshModelOptions();
    }
    return ws.onStatus((connected) => {
      if (connected) {
        void refreshModelOptions();
      }
    });
  }, [refreshModelOptions, ws]);

  const openCollaborationModeMenu = useCallback(() => {
    setCollaborationModeMenuVisible(true);
    if (!selectedChatId) {
      void ensureModeConfigurationSession();
    }
  }, [ensureModeConfigurationSession, selectedChatId]);

  const toggleFastMode = useCallback(() => {
    if (!supportsFastMode) {
      return;
    }
    const nextServiceTier: ServiceTier | null =
      activeServiceTier === 'fast' ? null : 'fast';
    const enablingFastMode = nextServiceTier === 'fast';
    const nextTitle = enablingFastMode ? 'Fast mode enabled' : 'Fast mode disabled';
    setSelectedServiceTier(nextServiceTier);
    setError(null);
    setActivity({
      tone: 'complete',
      title: nextTitle,
      detail: selectedChatId ? 'Applies to the next message' : 'Applies to the next new chat',
    });
  }, [activeServiceTier, selectedChatId, supportsFastMode]);

  const attachmentControlsDisabled = attachmentPickerBusy || uploadingAttachment;

  const attachmentMenuOptions = useMemo<SelectionSheetOption[]>(
    () => [
      ...(hasFailedAttachmentUploads
        ? [
            {
              key: 'retry-uploads',
              title: 'Retry failed uploads',
              description: `Retry prepared files without selecting them again. ${ATTACHMENT_MAX_LABEL} each.`,
              icon: 'refresh-outline' as const,
              disabled: attachmentControlsDisabled,
              onPress: () => {
                attachmentController.closeMenu();
                retryFailedUploads();
              },
            },
          ]
        : []),
      {
        key: 'workspace-path',
        title: 'Attach from workspace path',
        description: 'Reference a file or folder from the current repo.',
        icon: 'folder-open-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('workspace-path');
        },
      },
      {
        key: 'phone-file',
        title: 'Pick file from phone',
        description: `Import a document or asset, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'document-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-file');
        },
      },
      {
        key: 'phone-image',
        title: 'Pick image from phone',
        description: `Resize and compress an image, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'image-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-image');
        },
      },
      {
        key: 'phone-camera',
        title: 'Take photo',
        description: `Capture, resize, and compress a photo, up to ${ATTACHMENT_MAX_LABEL}.`,
        icon: 'camera-outline',
        disabled: attachmentControlsDisabled,
        onPress: () => {
          attachmentController.requestMenuAction('phone-camera');
        },
      },
    ],
    [attachmentController, attachmentControlsDisabled, hasFailedAttachmentUploads, retryFailedUploads]
  );

  return {
    selectModel,
    selectPendingAgent,
    openCollaborationModeMenu,
    toggleFastMode,
    attachmentControlsDisabled,
    attachmentMenuOptions,
  };
}

export type MainScreenComposerControlActionsResult = ReturnType<typeof useMainScreenComposerControlActions>;
