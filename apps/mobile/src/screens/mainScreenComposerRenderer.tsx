import { Ionicons } from '@expo/vector-icons';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ActivityBar } from '../components/ActivityBar';
import { ApprovalBanner } from '../components/ApprovalBanner';
import { BridgeUiBanner } from '../components/BridgeUiSurface';
import { ChatInput } from '../components/ChatInput';
import { decorativeAccessibilityProps } from '../accessibility';
import { toPathBasename } from './mainScreenHelpers';
import { QueuedMessageDock } from './MainScreenWorkflow';
import type { MainScreenWorkflowQueueStateContext, MainScreenWorkflowQueueStateResult } from './mainScreenWorkflowQueueState';






export type MainScreenComposerRendererContext = MainScreenWorkflowQueueStateContext & MainScreenWorkflowQueueStateResult;

export function useMainScreenComposerRenderer(context: MainScreenComposerRendererContext) {
  const {
    activeAgentLabel,
    activityDetail,
    attachmentControlsDisabled,
    bannerBridgeUiSurfaces,
    canCancelQueuedMessage,
    canSteerQueuedMessage,
    composerAttachments,
    composerOverlayInset,
    composerSafeAreaBottomInset,
    dismissBridgeUiSurface,
    displayedActivity,
    draft,
    handleBridgeUiAction,
    handleCancelQueuedMessage,
    handleComposerFocus,
    handleResolveApproval,
    handleSteerQueuedMessage,
    handleStopTurn,
    handleSubmit,
    isLoading,
    isTurnLikelyRunning,
    isTurnLoading,
    keyboardVisible,
    loadingAttachmentFileCandidates,
    mentionPathSuggestions,
    mentionQuery,
    oldestQueuedMessage,
    oldestQueuedMessageIsPendingSteer,
    onOpenBridgeRecoveryGuide,
    openAttachmentMenu,
    pendingApproval,
    queueActionItemId,
    queueActionKind,
    queuedMessageSteerDisabledReason,
    remainingQueuedMessagesCount,
    removeComposerAttachment,
    selectMentionSuggestion,
    selectedChat,
    selectedThreadRuntimeSnapshot,
    setComposerHeight,
    setDraft,
    showBridgeRecoveryBanner,
    showFloatingActivity,
    showQueuedMessageDock,
    showSlashSuggestions,
    showingOptimisticQueuedMessage,
    slashSuggestions,
    slashSuggestionsMaxHeight,
    stoppingTurn,
    styles,
    theme,
    visibleError,
  } = context;

  const renderComposer = (overlay: boolean) => (
    <View
      onLayout={
        overlay
          ? (event) => {
              const nextHeight = Math.ceil(event.nativeEvent.layout.height);
              setComposerHeight((previous) => (previous === nextHeight ? previous : nextHeight));
            }
          : undefined
      }
      style={[
        styles.composerContainer,
        overlay ? styles.composerContainerOverlay : null,
        overlay ? { bottom: composerOverlayInset } : null,
        !overlay && !keyboardVisible ? styles.composerContainerResting : null,
      ]}
    >
      {visibleError ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorText}>{visibleError}</Text> : null}
      {showBridgeRecoveryBanner ? (
        <View style={styles.bridgeRecoveryBanner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <View style={styles.bridgeRecoveryBannerTopRow}>
            <View style={styles.bridgeRecoveryBannerIconWrap}>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="warning-outline"
                size={16}
                color={theme.colors.warning}
              />
            </View>
            <View style={styles.bridgeRecoveryBannerCopy}>
              <Text style={styles.bridgeRecoveryBannerTitle}>
                Bridge disconnected
              </Text>
              <Text style={styles.bridgeRecoveryBannerBody}>
                Start the bridge on your computer to continue. The app will reconnect automatically.
              </Text>
            </View>
          </View>
          {onOpenBridgeRecoveryGuide ? (
            <Pressable
              onPress={onOpenBridgeRecoveryGuide}
              style={({ pressed }) => [
                styles.bridgeRecoveryBannerButton,
                pressed && styles.bridgeRecoveryBannerButtonPressed,
              ]}
            >
              <Text style={styles.bridgeRecoveryBannerButtonText}>
                How to start bridge
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {!showBridgeRecoveryBanner
        ? bannerBridgeUiSurfaces.map((surface) => (
            <BridgeUiBanner
              key={surface.id}
              surface={surface}
              onAction={(nextSurface, action) => {
                void handleBridgeUiAction(nextSurface, action);
              }}
              onDismiss={(nextSurface) => {
                void dismissBridgeUiSurface(nextSurface);
              }}
            />
          ))
        : null}
      {pendingApproval ? (
        <ApprovalBanner
          approval={pendingApproval}
          onResolve={handleResolveApproval}
        />
      ) : null}
      {showQueuedMessageDock && oldestQueuedMessage ? (
        <QueuedMessageDock
          queuedMessage={oldestQueuedMessage}
          remainingQueuedMessagesCount={remainingQueuedMessagesCount}
          pendingSubmission={showingOptimisticQueuedMessage}
          steerEnabled={canSteerQueuedMessage}
          cancelEnabled={canCancelQueuedMessage}
          steeringActive={queueActionKind === 'steer' && queueActionItemId === oldestQueuedMessage.id}
          steerPending={oldestQueuedMessageIsPendingSteer}
          waitingForToolCalls={selectedThreadRuntimeSnapshot?.waitingForToolCalls === true}
          steeringInFlight={selectedThreadRuntimeSnapshot?.steeringInFlight === true}
          steerDisabledReason={queuedMessageSteerDisabledReason}
          onCancelQueuedMessage={(messageId) => {
            void handleCancelQueuedMessage(messageId);
          }}
          onSteerQueuedMessage={() => {
            void handleSteerQueuedMessage();
          }}
        />
      ) : null}
      {showSlashSuggestions ? (
        <ScrollView
          style={[
            styles.slashSuggestions,
            { maxHeight: slashSuggestionsMaxHeight },
          ]}
          contentContainerStyle={styles.slashSuggestionsContent}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
        >
          {slashSuggestions.map((command, index) => {
            const suffix = command.argsHint ? ` ${command.argsHint}` : '';
            return (
              <Pressable
                key={`${command.name}-${String(index)}`}
                onPress={() => setDraft(`/${command.name}${command.argsHint ? ' ' : ''}`)}
                style={({ pressed }) => [
                  styles.slashSuggestionItem,
                  index === slashSuggestions.length - 1 &&
                    styles.slashSuggestionItemLast,
                  pressed && styles.slashSuggestionItemPressed,
                ]}
              >
                <Text style={styles.slashSuggestionTitle}>{`/${command.name}${suffix}`}</Text>
                <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                  {command.mobileSupported
                    ? command.summary
                    : `${command.summary} · CLI only`}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {!showSlashSuggestions && mentionQuery !== null ? (
        loadingAttachmentFileCandidates && mentionPathSuggestions.length === 0 ? (
          <View style={styles.inlineMentionStatus}>
            <Text accessibilityLiveRegion="polite" style={styles.workspaceModalLoading}>Indexing files…</Text>
          </View>
        ) : mentionPathSuggestions.length > 0 ? (
          <ScrollView
            style={[
              styles.slashSuggestions,
              { maxHeight: slashSuggestionsMaxHeight },
            ]}
            contentContainerStyle={styles.slashSuggestionsContent}
            keyboardShouldPersistTaps="handled"
            nestedScrollEnabled
          >
            {mentionPathSuggestions.map((path, index) => (
              <Pressable
                key={`${path}-${String(index)}`}
                onPress={() => selectMentionSuggestion(path)}
                style={({ pressed }) => [
                  styles.slashSuggestionItem,
                  index === mentionPathSuggestions.length - 1 &&
                    styles.slashSuggestionItemLast,
                  pressed && styles.slashSuggestionItemPressed,
                ]}
              >
                <Text style={styles.slashSuggestionTitle} numberOfLines={1}>
                  {toPathBasename(path)}
                </Text>
                <Text style={styles.slashSuggestionSummary} numberOfLines={1}>
                  {path}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : mentionQuery.trim().length > 0 ? (
          <View style={styles.inlineMentionStatus}>
            <Text style={styles.workspaceModalLoading}>No matching files found.</Text>
          </View>
        ) : null
      ) : null}
      {overlay && showFloatingActivity ? (
        <View pointerEvents="none" style={styles.activityDock}>
          <ActivityBar
            title={displayedActivity.title}
            detail={activityDetail}
            tone={displayedActivity.tone}
          />
        </View>
      ) : null}
      <ChatInput
        value={draft}
        onChangeText={setDraft}
        onFocus={handleComposerFocus}
        onSubmit={() => void handleSubmit()}
        onStop={() => handleStopTurn()}
        showStopButton={isTurnLoading || isTurnLikelyRunning || stoppingTurn}
        isStopping={stoppingTurn}
        onAttachPress={openAttachmentMenu}
        attachDisabled={attachmentControlsDisabled}
        attachments={composerAttachments}
        onRemoveAttachment={removeComposerAttachment}
        isLoading={isLoading}
        placeholder={selectedChat ? 'Reply...' : `Message ${activeAgentLabel}...`}
        safeAreaBottomInset={composerSafeAreaBottomInset}
        keyboardVisible={keyboardVisible}
        reserveFooterSpace={false}
        footer={null}
      />
    </View>
  );

  return {
    renderComposer,
  };
}

export type MainScreenComposerRendererResult = ReturnType<typeof useMainScreenComposerRenderer>;
