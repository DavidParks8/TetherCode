import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { BridgeUiWorkflowCard } from '../components/BridgeUiSurface';
import { ChatHeader } from '../components/ChatHeader';
import { InlineOptionsGroup } from './MainScreenInlineOptions';
import { decorativeAccessibilityProps } from '../accessibility';
import { AgentThreadsPanel } from './MainScreenPresentation';
import { WorkflowCard } from './MainScreenWorkflow';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';




type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenHeaderAndWorkflow({ context }: { context: Context }) {
  const {
    onOpenDrawer,
    headerTitle,
    activeAgent,
    selectedChat,
    openTitleEditor,
    handleOpenGit,
    isOpeningChat,
    styles,
    modelOptions,
    openModelModal,
    activeModelLabel,
    theme,
    activeModelEffortOptions,
    openEffortModal,
    activeEffortLabel,
    openCollaborationModeMenu,
    collaborationModeLabel,
    showAgentThreadChip,
    openAgentThreadSelector,
    agentThreadChipLabel,
    supportsFastMode,
    fastModeEnabled,
    fastModeControlDisabled,
    toggleFastMode,
    modelModalVisible,
    modelPickerOptions,
    loadingModels,
    closeModelModal,
    effortModalVisible,
    effortPickerSheetOptions,
    closeEffortModal,
    showTopCardsRow,
    workflowBridgeUiSurfaces,
    windowHeight,
    handleBridgeUiAction,
    dismissBridgeUiSurface,
    workflowCardMode,
    selectedThreadPlan,
    planPanelCollapsed,
    sending,
    creating,
    stoppingTurn,
    toggleSelectedPlanPanel,
    implementPlan,
    stayInPlanMode,
    showLiveAgentPanel,
    liveAgentRows,
    liveRunningAgentCount,
    agentPanelCollapsed,
    setAgentPanelCollapsed,
    openAgentDetail,
  } = context;

  return (
    <>
      <ChatHeader
                onOpenDrawer={onOpenDrawer}
                title={headerTitle}
                agent={activeAgent}
                onOpenTitleMenu={selectedChat ? openTitleEditor : undefined}
                rightIconName={selectedChat ? 'git-branch-outline' : undefined}
                onRightActionPress={selectedChat ? handleOpenGit : undefined}
              />
      {selectedChat && !isOpeningChat ? (
                <View style={styles.sessionMetaRow}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.sessionMetaRowContent}
                  >
                    {modelOptions.length > 0 ? (
                      <Pressable
                        style={({ pressed }) => [
                          styles.modelChip,
                          pressed && styles.modelChipPressed,
                        ]}
                        onPress={openModelModal}
                        accessibilityRole="button"
                        accessibilityLabel={`Model, ${activeModelLabel}`}
                      >
                        <Ionicons {...decorativeAccessibilityProps} name="sparkles-outline" size={12} color={theme.colors.textMuted} />
                        <Text style={styles.modelChipText} numberOfLines={1}>
                          {activeModelLabel}
                        </Text>
                      </Pressable>
                    ) : null}
                    {activeModelEffortOptions.length > 0 ? (
                      <Pressable
                        style={({ pressed }) => [
                          styles.modelChip,
                          pressed && styles.modelChipPressed,
                        ]}
                        onPress={() => openEffortModal()}
                        accessibilityRole="button"
                        accessibilityLabel={`Thinking level, ${activeEffortLabel}`}
                      >
                        <Ionicons {...decorativeAccessibilityProps} name="pulse-outline" size={12} color={theme.colors.textMuted} />
                        <Text style={styles.modelChipText} numberOfLines={1}>
                          {activeEffortLabel}
                        </Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      style={({ pressed }) => [
                        styles.modeChip,
                        pressed && styles.modelChipPressed,
                      ]}
                      onPress={openCollaborationModeMenu}
                      accessibilityRole="button"
                      accessibilityLabel={`Agent mode, ${collaborationModeLabel}`}
                    >
                      <Ionicons {...decorativeAccessibilityProps} name="map-outline" size={12} color={theme.colors.textMuted} />
                      <Text style={styles.modelChipText} numberOfLines={1}>
                        {collaborationModeLabel}
                      </Text>
                    </Pressable>
                    {showAgentThreadChip ? (
                      <Pressable
                        style={({ pressed }) => [
                          styles.modeChip,
                          pressed && styles.modelChipPressed,
                        ]}
                        onPress={() => {
                          void openAgentThreadSelector();
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={agentThreadChipLabel}
                      >
                        <Ionicons {...decorativeAccessibilityProps} name="people-outline" size={12} color={theme.colors.textMuted} />
                        <Text style={styles.modelChipText} numberOfLines={1}>
                          {agentThreadChipLabel}
                        </Text>
                      </Pressable>
                    ) : null}
                    {supportsFastMode ? (
                      <Pressable
                        style={({ pressed }) => [
                          styles.fastChip,
                          fastModeEnabled && styles.fastChipEnabled,
                          pressed && styles.modelChipPressed,
                          fastModeControlDisabled && styles.sessionMetaChipDisabled,
                        ]}
                        onPress={() => {
                          void toggleFastMode();
                        }}
                        disabled={fastModeControlDisabled}
                        accessibilityRole="switch"
                        accessibilityLabel="Fast mode"
                        accessibilityState={{ checked: fastModeEnabled, disabled: fastModeControlDisabled }}
                      >
                        <Ionicons
                          {...decorativeAccessibilityProps}
                          name={fastModeEnabled ? 'flash' : 'flash-outline'}
                          size={12}
                          color={fastModeEnabled ? theme.colors.textPrimary : theme.colors.textMuted}
                        />
                        <Text
                          style={[
                            styles.modelChipText,
                            fastModeEnabled && styles.fastChipTextEnabled,
                          ]}
                          numberOfLines={1}
                        >
                          Fast
                        </Text>
                      </Pressable>
                    ) : null}
                  </ScrollView>
                </View>
              ) : null}
      {modelModalVisible ? (
                <InlineOptionsGroup
                  title="Model"
                  options={modelPickerOptions}
                  loading={loadingModels}
                  loadingLabel="Refreshing available models..."
                  onClose={closeModelModal}
                />
              ) : null}
      {effortModalVisible ? (
                <InlineOptionsGroup
                  title="Thinking level"
                  options={effortPickerSheetOptions}
                  onClose={closeEffortModal}
                />
              ) : null}
      {showTopCardsRow ? (
                <View style={styles.topCardsRow}>
                  {workflowBridgeUiSurfaces.map((surface) => (
                    <BridgeUiWorkflowCard
                      key={surface.id}
                      surface={surface}
                      scrollMaxHeight={Math.max(176, Math.min(Math.floor(windowHeight * 0.4), 360))}
                      onAction={(nextSurface, action) => {
                        void handleBridgeUiAction(nextSurface, action);
                      }}
                      onDismiss={(nextSurface) => {
                        void dismissBridgeUiSurface(nextSurface);
                      }}
                    />
                  ))}
                  {workflowCardMode ? (
                    <WorkflowCard
                      mode={workflowCardMode}
                      plan={selectedThreadPlan}
                      collapsed={planPanelCollapsed}
                      scrollMaxHeight={Math.max(
                        176,
                        Math.min(
                          Math.floor(windowHeight * (workflowCardMode === 'approval' ? 0.34 : 0.4)),
                          workflowCardMode === 'approval' ? 280 : 360
                        )
                      )}
                      actionDisabled={sending || creating || stoppingTurn}
                      onToggleCollapse={toggleSelectedPlanPanel}
                      onImplement={() => void implementPlan()}
                      onStayInPlanMode={stayInPlanMode}
                    />
                  ) : null}
                </View>
              ) : null}
      {showLiveAgentPanel ? (
                <View style={styles.agentPanelWrap}>
                  <AgentThreadsPanel
                    rows={liveAgentRows}
                    runningCount={liveRunningAgentCount}
                    collapsed={agentPanelCollapsed}
                    onToggleCollapse={() => {
                      setAgentPanelCollapsed((previous) => !previous);
                    }}
                    onSelectThread={(threadId) => {
                      openAgentDetail(threadId);
                    }}
                  />
                </View>
              ) : null}
    </>
  );
}
