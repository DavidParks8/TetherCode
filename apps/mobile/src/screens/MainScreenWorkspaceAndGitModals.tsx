import { Ionicons } from '@expo/vector-icons';
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { WorkspacePickerModal } from '../components/WorkspacePickerModal';
import { decorativeAccessibilityProps } from '../accessibility';
import { normalizeCloneDirectoryName } from './mainScreenHelpers';
import type { MainScreenPanelCollapseCoordinatorContext, MainScreenPanelCollapseCoordinatorResult } from './mainScreenPanelCollapseCoordinator';




type Context = MainScreenPanelCollapseCoordinatorContext & MainScreenPanelCollapseCoordinatorResult;

export function MainScreenWorkspaceAndGitModals({ context }: { context: Context }) {
  const {
    titleModalVisible,
    closeTitleEditor,
    styles,
    titleDraft,
    setTitleDraft,
    titleSaving,
    saveTitle,
    workspaceModalVisible,
    workspacePickerPurpose,
    gitCheckoutParentPath,
    preferredStartCwd,
    workspaceBridgeRoot,
    workspaceRoots,
    favoriteWorkspacePaths,
    workspaceBrowsePath,
    workspaceBrowseParentPath,
    workspaceBrowseEntries,
    loadingWorkspaceBrowse,
    workspaceBrowseError,
    workspaceBrowseTruncation,
    browseWorkspacePath,
    handleWorkspaceSelection,
    toggleWorkspaceFavorite,
    setWorkspaceModalVisible,
    openGitCheckoutModal,
    closeWorkspaceModal,
    gitCheckoutModalVisible,
    closeGitCheckoutModal,
    safeAreaInsets,
    theme,
    gitCheckoutRepoUrl,
    handleGitCheckoutRepoUrlChange,
    gitCheckoutCloning,
    openGitCheckoutDestinationPicker,
    gitCheckoutDestinationLabel,
    gitCheckoutDirectoryName,
    handleGitCheckoutDirectoryNameChange,
    submitGitCheckout,
    gitCheckoutTargetPath,
    gitCheckoutError,
  } = context;

  return (
    <>
      <Modal
                visible={titleModalVisible}
                transparent
                animationType="fade"
                onRequestClose={closeTitleEditor}
              >
                <KeyboardAvoidingView
                  style={styles.renameModalKeyboardAvoider}
                  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                >
                  <View style={styles.renameModalBackdrop}>
                    <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.renameModalCard}>
                      <Text style={styles.renameModalTitle}>Rename session</Text>
                      <TextInput
                        value={titleDraft}
                        onChangeText={setTitleDraft}
                        style={styles.renameModalInput}
                        accessibilityLabel="Session title"
                        autoFocus
                        maxLength={256}
                        editable={!titleSaving}
                        returnKeyType="done"
                        onSubmitEditing={() => { void saveTitle(); }}
                      />
                      <View style={styles.renameModalActions}>
                        <Pressable
                          onPress={closeTitleEditor}
                          style={[styles.renameModalButton, styles.renameModalButtonSecondary]}
                          disabled={titleSaving}
                          accessibilityRole="button"
                          accessibilityLabel="Cancel rename"
                        >
                          <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => { void saveTitle(); }}
                          style={[
                            styles.renameModalButton,
                            styles.renameModalButtonPrimary,
                            (!titleDraft.trim() || titleSaving) && styles.renameModalButtonDisabled,
                          ]}
                          disabled={!titleDraft.trim() || titleSaving}
                          accessibilityRole="button"
                          accessibilityLabel="Save session title"
                        >
                          <Text style={styles.renameModalButtonPrimaryText}>
                            {titleSaving ? 'Saving...' : 'Save'}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                </KeyboardAvoidingView>
              </Modal>
      <WorkspacePickerModal
                visible={workspaceModalVisible}
                selectedPath={
                  workspacePickerPurpose === 'git-checkout-destination'
                    ? gitCheckoutParentPath
                    : preferredStartCwd
                }
                bridgeRoot={workspaceBridgeRoot}
                recentWorkspaces={workspaceRoots}
                favoriteWorkspacePaths={favoriteWorkspacePaths}
                currentPath={workspaceBrowsePath}
                parentPath={workspaceBrowseParentPath}
                entries={workspaceBrowseEntries}
                loadingEntries={loadingWorkspaceBrowse}
                error={workspaceBrowseError}
                truncationMessage={workspaceBrowseTruncation}
                onBrowsePath={(path) => void browseWorkspacePath(path)}
                onSelectPath={handleWorkspaceSelection}
                onToggleFavorite={toggleWorkspaceFavorite}
                actionLabel={
                  workspacePickerPurpose === 'default-start'
                    ? 'Clone Repository...'
                    : null
                }
                actionDescription={
                  workspacePickerPurpose === 'default-start'
                    ? 'Choose a destination and start a session'
                    : null
                }
                onActionPress={
                  workspacePickerPurpose === 'default-start'
                    ? (path) => {
                        setWorkspaceModalVisible(false);
                        openGitCheckoutModal(path);
                      }
                    : undefined
                }
                onClose={closeWorkspaceModal}
              />
      <Modal
                visible={gitCheckoutModalVisible}
                transparent
                animationType="fade"
                onRequestClose={closeGitCheckoutModal}
              >
                <KeyboardAvoidingView
                  style={styles.renameModalKeyboardAvoider}
                  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                  keyboardVerticalOffset={Platform.OS === 'ios' ? safeAreaInsets.bottom : 0}
                >
                  <View style={styles.renameModalBackdrop}>
                    <View
                      style={[
                        styles.renameModalKeyboardContent,
                        styles.renameModalKeyboardContentBottom,
                        { paddingBottom: theme.spacing.md },
                      ]}
                    >
                      <View accessibilityViewIsModal importantForAccessibility="yes" style={styles.renameModalCard}>
                        <Text style={styles.renameModalTitle}>Git checkout</Text>
                        <Text style={styles.gitCheckoutHint}>
                          Paste an SSH or HTTPS repository URL, choose where to clone it, then start
                          the new chat in that workspace.
                        </Text>
                        <TextInput
                          value={gitCheckoutRepoUrl}
                          onChangeText={handleGitCheckoutRepoUrlChange}
                          keyboardAppearance={theme.keyboardAppearance}
                          placeholder="git@github.com:org/repo.git"
                          placeholderTextColor={theme.colors.textMuted}
                          style={styles.renameModalInput}
                          accessibilityLabel="Repository URL"
                          autoFocus
                          editable={!gitCheckoutCloning}
                          autoCapitalize="none"
                          autoCorrect={false}
                          returnKeyType="next"
                        />
                        <Pressable
                          onPress={openGitCheckoutDestinationPicker}
                          style={({ pressed }) => [
                            styles.gitCheckoutPathButton,
                            pressed && styles.gitCheckoutPathButtonPressed,
                          ]}
                          disabled={gitCheckoutCloning}
                          accessibilityRole="button"
                          accessibilityLabel={`Clone into ${gitCheckoutDestinationLabel}`}
                        >
                          <Ionicons
                            {...decorativeAccessibilityProps}
                            name="folder-open-outline"
                            size={16}
                            color={theme.colors.textMuted}
                          />
                          <View style={styles.gitCheckoutPathCopy}>
                            <Text style={styles.gitCheckoutPathLabel}>Clone into</Text>
                            <Text style={styles.gitCheckoutPathValue} numberOfLines={1}>
                              {gitCheckoutDestinationLabel}
                            </Text>
                          </View>
                          <Ionicons {...decorativeAccessibilityProps} name="chevron-forward" size={14} color={theme.colors.textMuted} />
                        </Pressable>
                        <TextInput
                          value={gitCheckoutDirectoryName}
                          onChangeText={handleGitCheckoutDirectoryNameChange}
                          keyboardAppearance={theme.keyboardAppearance}
                          placeholder="repo-folder"
                          placeholderTextColor={theme.colors.textMuted}
                          style={styles.renameModalInput}
                          accessibilityLabel="Clone directory name"
                          editable={!gitCheckoutCloning}
                          autoCapitalize="none"
                          autoCorrect={false}
                          returnKeyType="done"
                          onSubmitEditing={() => void submitGitCheckout()}
                        />
                        {gitCheckoutTargetPath ? (
                          <Text style={styles.gitCheckoutSummary} numberOfLines={2}>
                            {`Will clone into ${gitCheckoutTargetPath}`}
                          </Text>
                        ) : null}
                        {gitCheckoutError ? (
                          <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.gitCheckoutErrorText}>{gitCheckoutError}</Text>
                        ) : null}
                        <View style={styles.renameModalActions}>
                          <Pressable
                            onPress={closeGitCheckoutModal}
                            style={({ pressed }) => [
                              styles.renameModalButton,
                              styles.renameModalButtonSecondary,
                              pressed && styles.renameModalButtonPressed,
                            ]}
                            disabled={gitCheckoutCloning}
                          >
                            <Text style={styles.renameModalButtonSecondaryText}>Cancel</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => void submitGitCheckout()}
                            style={({ pressed }) => [
                              styles.renameModalButton,
                              styles.renameModalButtonPrimary,
                              pressed && styles.renameModalButtonPrimaryPressed,
                              (!gitCheckoutRepoUrl.trim() ||
                                !normalizeCloneDirectoryName(gitCheckoutDirectoryName) ||
                                gitCheckoutCloning) &&
                                styles.renameModalButtonDisabled,
                            ]}
                            disabled={
                              !gitCheckoutRepoUrl.trim() ||
                              !normalizeCloneDirectoryName(gitCheckoutDirectoryName) ||
                              gitCheckoutCloning
                            }
                          >
                            <Text style={styles.renameModalButtonPrimaryText}>
                              {gitCheckoutCloning ? 'Cloning...' : 'Clone and use'}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
                    </View>
                  </View>
                </KeyboardAvoidingView>
              </Modal>
    </>
  );
}
