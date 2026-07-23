import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { ActivityBar } from '../components/ActivityBar';
import { SelectionSheet } from '../components/SelectionSheet';
import { ChatTranscriptView } from './ChatTranscriptView';
import { SubAgentDetailView } from './SubAgentDetailView';
import { ComposeView } from './MainScreenPresentation';
import { ChatOpeningView } from './MainScreenPresentation';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';




type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenTranscriptAndAgentDetail({ context }: { context: Context }) {
  const {
    styles,
    selectedChat,
    isOpeningChat,
    selectedParentChat,
    bridgeUrl,
    bridgeToken,
    onOpenLocalPreview,
    openAgentDetail,
    showToolCalls,
    agentThreadStatusById,
    scrollRef,
    pendingUserInputRequest,
    pendingApproval,
    isLoading,
    handleInlineOptionSelect,
    scrollToBottomIfPinned,
    handleJumpToLatest,
    clearPendingScrollRetries,
    autoScrollStateRef,
    androidComposerReservedInset,
    liveAssistantByThread,
    transcriptContinuationState,
    handleLoadEarlier,
    defaultStartWorkspaceLabel,
    readyAgents,
    activeAgentLabel,
    modelOptions,
    activeModelLabel,
    activeModelEffortOptions,
    activeEffortLabel,
    collaborationModeLabel,
    supportsFastMode,
    fastModeEnabled,
    fastModeLabel,
    keyboardVisible,
    setDraft,
    openWorkspaceModal,
    openAgentModal,
    openModelModal,
    openEffortModal,
    openCollaborationModeMenu,
    toggleFastMode,
    shouldShowComposer,
    renderComposer,
    chatBottomInset,
    showFloatingActivity,
    displayedActivity,
    activityDetail,
    agentDetailThreadId,
    agentDetailChat,
    agentDetailParentChat,
    agentDetailRuntime,
    agentDetailDisplay,
    agentDetailTitle,
    agentDetailSummary,
    agentDetailLoading,
    agentDetailError,
    closeAgentDetail,
    attachmentMenuVisible,
    attachmentMenuOptions,
    attachmentController,
    agentThreadMenuVisible,
    agentThreadMenuOptions,
    loadingAgentThreads,
    setAgentThreadMenuVisible,
    collaborationModeMenuVisible,
    collaborationModeOptions,
    setCollaborationModeMenuVisible,
    agentModalVisible,
    agentPickerOptions,
    closeAgentModal,
  } = context;

  return (
    <>
      {Platform.OS === 'android' ? (
                <View style={styles.bodyContainer}>
                  <KeyboardAvoidingView style={styles.keyboardAvoiding} enabled={false}>
                    {selectedChat && !isOpeningChat ? (
                      <ChatTranscriptView
                        key={selectedChat.id}
                        chat={selectedChat}
                        parentChat={selectedParentChat}
                        bridgeUrl={bridgeUrl}
                        bridgeToken={bridgeToken ?? null}
                        onOpenLocalPreview={onOpenLocalPreview}
                        onOpenSubAgentThread={openAgentDetail}
                        showToolCalls={showToolCalls ?? true}
                        agentThreadStatusById={agentThreadStatusById}
                        scrollRef={scrollRef}
                        inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
                        onInlineOptionSelect={handleInlineOptionSelect}
                        onPinnedAutoScroll={scrollToBottomIfPinned}
                        onJumpToLatest={handleJumpToLatest}
                        onScrollInteractionStart={clearPendingScrollRetries}
                        autoScrollStateRef={autoScrollStateRef}
                        bottomInset={androidComposerReservedInset}
                        liveMessageState={liveAssistantByThread[selectedChat.id] ?? null}
                        continuationState={transcriptContinuationState}
                        onLoadEarlier={() => {
                          void handleLoadEarlier();
                        }}
                      />
                    ) : isOpeningChat ? (
                      <ChatOpeningView />
                    ) : (
                      <ComposeView
                        startWorkspaceLabel={defaultStartWorkspaceLabel}
                        showAgentPicker={readyAgents.length > 1}
                        agentLabel={activeAgentLabel}
                        showModelControls={modelOptions.length > 0}
                        modelLabel={activeModelLabel}
                        showThinkingControls={activeModelEffortOptions.length > 0}
                        thinkingLabel={activeEffortLabel}
                        collaborationModeLabel={collaborationModeLabel}
                        showFastMode={supportsFastMode}
                        fastModeEnabled={fastModeEnabled}
                        fastModeLabel={fastModeLabel}
                        keyboardVisible={keyboardVisible}
                        bottomInset={androidComposerReservedInset}
                        onSuggestion={(s) => setDraft(s)}
                        onOpenWorkspacePicker={openWorkspaceModal}
                        onOpenAgentPicker={openAgentModal}
                        onOpenModelPicker={openModelModal}
                        onOpenThinkingPicker={() => openEffortModal()}
                        onOpenCollaborationModePicker={openCollaborationModeMenu}
                        onToggleFastMode={() => {
                          void toggleFastMode();
                        }}
                      />
                    )}
                  </KeyboardAvoidingView>

                  {shouldShowComposer ? renderComposer(true) : null}
                </View>
              ) : (
                <KeyboardAvoidingView
                  style={styles.keyboardAvoiding}
                  behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                  enabled={Platform.OS === 'ios'}
                >
                  {selectedChat && !isOpeningChat ? (
                    <ChatTranscriptView
                      key={selectedChat.id}
                      chat={selectedChat}
                      parentChat={selectedParentChat}
                      bridgeUrl={bridgeUrl}
                      bridgeToken={bridgeToken ?? null}
                      onOpenLocalPreview={onOpenLocalPreview}
                      onOpenSubAgentThread={openAgentDetail}
                      showToolCalls={showToolCalls ?? true}
                      agentThreadStatusById={agentThreadStatusById}
                      scrollRef={scrollRef}
                      inlineChoicesEnabled={!pendingUserInputRequest && !pendingApproval && !isLoading}
                      onInlineOptionSelect={handleInlineOptionSelect}
                      onPinnedAutoScroll={scrollToBottomIfPinned}
                      onJumpToLatest={handleJumpToLatest}
                      onScrollInteractionStart={clearPendingScrollRetries}
                      autoScrollStateRef={autoScrollStateRef}
                      bottomInset={chatBottomInset}
                      liveMessageState={liveAssistantByThread[selectedChat.id] ?? null}
                      continuationState={transcriptContinuationState}
                      onLoadEarlier={() => {
                        void handleLoadEarlier();
                      }}
                    />
                  ) : isOpeningChat ? (
                    <ChatOpeningView />
                  ) : (
                    <ComposeView
                      startWorkspaceLabel={defaultStartWorkspaceLabel}
                      showAgentPicker={readyAgents.length > 1}
                      agentLabel={activeAgentLabel}
                      showModelControls={modelOptions.length > 0}
                      modelLabel={activeModelLabel}
                      showThinkingControls={activeModelEffortOptions.length > 0}
                      thinkingLabel={activeEffortLabel}
                      collaborationModeLabel={collaborationModeLabel}
                      showFastMode={supportsFastMode}
                      fastModeEnabled={fastModeEnabled}
                      fastModeLabel={fastModeLabel}
                      keyboardVisible={false}
                      bottomInset={0}
                      onSuggestion={(s) => setDraft(s)}
                      onOpenWorkspacePicker={openWorkspaceModal}
                      onOpenAgentPicker={openAgentModal}
                      onOpenModelPicker={openModelModal}
                      onOpenThinkingPicker={() => openEffortModal()}
                      onOpenCollaborationModePicker={openCollaborationModeMenu}
                      onToggleFastMode={() => {
                        void toggleFastMode();
                      }}
                    />
                  )}

                  {showFloatingActivity ? (
                    <View pointerEvents="none" style={styles.activityDock}>
                      <ActivityBar
                        title={displayedActivity.title}
                        detail={activityDetail}
                        tone={displayedActivity.tone}
                      />
                    </View>
                  ) : null}

                  {shouldShowComposer ? renderComposer(false) : null}
                </KeyboardAvoidingView>
              )}
      <SubAgentDetailView
                visible={Boolean(agentDetailThreadId)}
                chat={agentDetailChat}
                parentChat={agentDetailParentChat}
                runtime={agentDetailRuntime}
                liveMessageState={
                  agentDetailThreadId ? liveAssistantByThread[agentDetailThreadId] ?? null : null
                }
                display={agentDetailDisplay}
                title={agentDetailTitle}
                role={agentDetailSummary?.agentRole}
                loading={agentDetailLoading}
                error={agentDetailError}
                bridgeUrl={bridgeUrl}
                bridgeToken={bridgeToken ?? null}
                showToolCalls={showToolCalls ?? true}
                agentThreadStatusById={agentThreadStatusById}
                onOpenLocalPreview={onOpenLocalPreview}
                onClose={closeAgentDetail}
              />
      <SelectionSheet
                visible={attachmentMenuVisible}
                eyebrow="Attachments"
                title="Add context"
                subtitle="Bring in a workspace path, a file, a saved image, or a fresh photo."
                options={attachmentMenuOptions}
                presentation="expanded"
                onClose={attachmentController.closeMenu}
              />
      <SelectionSheet
                visible={agentThreadMenuVisible}
                eyebrow="Agents"
                title="Agent threads"
                subtitle="Switch between the main thread and spawned sub-agent threads."
                options={agentThreadMenuOptions}
                loading={loadingAgentThreads}
                loadingLabel="Loading agent threads…"
                emptyLabel="No spawned agent threads for this chat yet."
                presentation="expanded"
                onClose={() => setAgentThreadMenuVisible(false)}
              />
      <SelectionSheet
                visible={collaborationModeMenuVisible}
                eyebrow="Agent"
                title="Agent mode"
                subtitle={`Choose a mode supported by ${activeAgentLabel}.`}
                options={collaborationModeOptions}
                onClose={() => setCollaborationModeMenuVisible(false)}
              />
      <SelectionSheet
                visible={agentModalVisible}
                eyebrow="Agent"
                title="Select agent"
                subtitle="Choose which installed ACP agent should start the new chat."
                options={agentPickerOptions}
                onClose={closeAgentModal}
              />
    </>
  );
}
