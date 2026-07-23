import { useMemo } from 'react';
import type { CollaborationMode } from '../api/types';
import { type SelectionSheetOption } from '../components/SelectionSheet';
import { formatModelOptionDescription, formatModelOptionLabel } from '../modelOptions';
import { formatReasoningEffort } from './mainScreenHelpers';
import type { MainScreenComposerControlActionsContext, MainScreenComposerControlActionsResult } from './mainScreenComposerControlActions';






export type MainScreenPickerOptionBuildersContext = MainScreenComposerControlActionsContext & MainScreenComposerControlActionsResult;

export function useMainScreenPickerOptionBuilders(context: MainScreenPickerOptionBuildersContext) {
  const {
    activeAgentId,
    applyAcpConfigOption,
    effortPickerDefault,
    effortPickerModel,
    effortPickerOptions,
    modeConfig,
    modelOptions,
    readyAgents,
    selectEffort,
    selectModel,
    selectPendingAgent,
    selectedChatId,
    selectedCollaborationMode,
    selectedEffort,
    selectedModel,
    selectedModelId,
    serverDefaultModel,
    setCollaborationModeMenuVisible,
    setError,
    setSelectedAcpModeId,
    setSelectedCollaborationMode,
  } = context;


  const collaborationModeOptions = useMemo<SelectionSheetOption[]>(
    () => {
      const setMode = async (mode: CollaborationMode, acpMode: string) => {
        if (modeConfig) {
          const updated = await applyAcpConfigOption(modeConfig, acpMode);
          if (!updated) {
            return;
          }
        }
        setSelectedAcpModeId(acpMode);
        setSelectedCollaborationMode(mode);
        setCollaborationModeMenuVisible(false);
        setError(null);
      };

      const advertisedModes = modeConfig?.options ?? [];
      if (advertisedModes.length > 0) {
        return advertisedModes.map((option) => {
          const mode: CollaborationMode = option.value === 'plan' ? 'plan' : 'default';
          return {
            key: option.value,
            title: option.name,
            description: option.description ?? (
              mode === 'plan'
                ? 'Plan the work before execution.'
                : 'Use this primary OpenCode agent mode for the next turn.'
            ),
            icon: mode === 'plan' ? 'git-branch-outline' as const : 'chatbubble-ellipses-outline' as const,
            selected: modeConfig?.value === option.value,
            onPress: () => { void setMode(mode, option.value); },
          } satisfies SelectionSheetOption;
        });
      }
      if (selectedChatId) {
        return [];
      }
      return [
        {
          key: 'default',
          title: 'Default mode',
          description: 'Answer directly and keep the turn moving.',
          icon: 'chatbubble-ellipses-outline' as const,
          selected: selectedCollaborationMode === 'default',
          onPress: () => { void setMode('default', 'build'); },
        },
        {
          key: 'plan',
          title: 'Plan mode',
          description: 'Pause to ask structured follow-up questions before execution.',
          icon: 'git-branch-outline' as const,
          selected: selectedCollaborationMode === 'plan',
          onPress: () => { void setMode('plan', 'plan'); },
        },
      ];
    },
    [applyAcpConfigOption, modeConfig, selectedCollaborationMode]
  );

  const agentPickerOptions = useMemo<SelectionSheetOption[]>(
    () =>
      readyAgents.map((agent) => ({
        key: agent.agentId,
        title: agent.displayName,
        description: [agent.version, agent.provenance].filter(Boolean).join(' · '),
        icon: 'hardware-chip-outline' as const,
        selected: activeAgentId === agent.agentId,
        onPress: () => selectPendingAgent(agent.agentId),
      })),
    [activeAgentId, readyAgents, selectPendingAgent]
  );

  const modelPickerOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'server-default',
        title: 'Use server default',
        description: serverDefaultModel
          ? `Currently ${formatModelOptionLabel(serverDefaultModel)}.`
          : 'Follow the bridge default model.',
        icon: 'sparkles-outline',
        badge: 'Auto',
        selected: selectedModelId === null || selectedModel === null,
        onPress: () => { void selectModel(null); },
      },
      ...modelOptions.map((model) => ({
        key: model.id,
        title: formatModelOptionLabel(model),
        description: formatModelOptionDescription(model),
        icon: 'hardware-chip-outline' as const,
        badge: model.isDefault ? 'Default' : undefined,
        meta: model.defaultReasoningEffort
          ? formatReasoningEffort(model.defaultReasoningEffort)
          : undefined,
        selected: model.id === selectedModelId,
        onPress: () => { void selectModel(model.id); },
      })),
    ],
    [modelOptions, selectModel, selectedModel, selectedModelId, serverDefaultModel]
  );

  const effortPickerSheetOptions = useMemo<SelectionSheetOption[]>(
    () => [
      {
        key: 'model-default',
        title: effortPickerDefault
          ? `Use ${formatReasoningEffort(effortPickerDefault)}`
          : 'Use model default',
        description: effortPickerModel
          ? `Follow ${formatModelOptionLabel(effortPickerModel)}'s default reasoning.`
          : 'Follow the active model default.',
        icon: 'sparkles-outline',
        badge: 'Auto',
        selected: selectedEffort === null,
        onPress: () => { void selectEffort(null); },
      },
      ...effortPickerOptions.map((option) => ({
        key: option.effort,
        title: formatReasoningEffort(option.effort),
        description:
          option.description?.trim() ||
          'Override the model default for the next response.',
        icon: 'pulse-outline' as const,
        selected: option.effort === selectedEffort,
        onPress: () => { void selectEffort(option.effort); },
      })),
    ],
    [
      effortPickerDefault,
      effortPickerModel,
      effortPickerOptions,
      selectEffort,
      selectedEffort,
    ]
  );

  return {
    collaborationModeOptions,
    agentPickerOptions,
    modelPickerOptions,
    effortPickerSheetOptions,
  };
}

export type MainScreenPickerOptionBuildersResult = ReturnType<typeof useMainScreenPickerOptionBuilders>;
