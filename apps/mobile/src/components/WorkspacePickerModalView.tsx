import type { RefObject } from 'react';
import type { Text } from 'react-native';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import type { FileSystemEntry, WorkspaceSummary } from '../api/types';
import type { AppTheme } from '../theme';
import { WorkspacePickerBrowser } from './WorkspacePickerBrowser';
import { WorkspacePickerHome } from './WorkspacePickerHome';
import type { WorkspacePickerPresentation } from './workspacePickerHelpers';
import type { WorkspacePickerStyles } from './workspacePickerStyles';
import type { WorkspacePickerScreen } from './workspacePickerTypes';

export interface WorkspacePickerModalViewProps {
  visible: boolean;
  screen: WorkspacePickerScreen;
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  presentation: WorkspacePickerPresentation;
  bottomSafeInset: number;
  modalFocusRef: RefObject<Text | null>;
  onClose: () => void;
  selectedPath: string | null;
  bridgeRoot: string | null;
  recentWorkspaces: WorkspaceSummary[];
  browseStartPath: string | null;
  onOpenBrowser: () => void;
  onSelectPath: (path: string | null) => void;
  actionLabel: string | null;
  actionDescription: string | null;
  actionDisabled: boolean;
  onActionPress?: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  parentPath: string | null;
  browserBackLabel: string;
  onBrowserBack: () => void;
  currentFolderTitle: string;
  currentFolderPath: string | null;
  loadingEntries: boolean;
  entries: FileSystemEntry[];
  normalizedSearch: string;
  onBrowsePath: (path: string | null) => void;
  error: string | null;
  truncationMessage: string | null;
}

export function WorkspacePickerModalView(props: WorkspacePickerModalViewProps) {
  const { presentation } = props;
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType={presentation.isLargeScreen ? 'fade' : 'slide'}
      presentationStyle="overFullScreen"
      onRequestClose={props.onClose}
    >
      <View style={props.styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={props.onClose}
          accessibilityRole="button"
          accessibilityLabel="Close workspace picker"
          accessibilityHint="Dismisses workspace selection"
        />
        <View
          style={[
            props.styles.outer,
            presentation.isLargeScreen && props.styles.outerLarge,
            {
              paddingHorizontal: presentation.horizontalPadding,
              paddingTop: presentation.topPadding,
              paddingBottom: presentation.bottomPadding,
            },
          ]}
        >
          <View
            accessibilityViewIsModal
            importantForAccessibility="yes"
            style={[
              props.styles.panel,
              presentation.isLargeScreen
                ? props.styles.panelLarge
                : props.styles.panelPhone,
              {
                height: presentation.panelHeight,
                maxWidth: presentation.panelMaxWidth,
              },
            ]}
          >
            {!presentation.isLargeScreen ? <View style={props.styles.handle} /> : null}
            {props.screen === 'home' ? (
              <WorkspacePickerHome
                styles={props.styles}
                theme={props.theme}
                modalFocusRef={props.modalFocusRef}
                bottomSafeInset={props.bottomSafeInset}
                bridgeRoot={props.bridgeRoot}
                browseStartPath={props.browseStartPath}
                selectedPath={props.selectedPath}
                onSelectPath={props.onSelectPath}
                onOpenBrowser={props.onOpenBrowser}
                actionLabel={props.actionLabel}
                actionDescription={props.actionDescription}
                actionDisabled={props.actionDisabled}
                onActionPress={props.onActionPress}
                recentWorkspaces={props.recentWorkspaces}
                onClose={props.onClose}
              />
            ) : (
              <WorkspacePickerBrowser
                styles={props.styles}
                theme={props.theme}
                bottomSafeInset={props.bottomSafeInset}
                browserBackLabel={props.browserBackLabel}
                onBack={props.onBrowserBack}
                currentFolderTitle={props.currentFolderTitle}
                currentFolderPath={props.currentFolderPath}
                searchQuery={props.searchQuery}
                setSearchQuery={props.setSearchQuery}
                entries={props.entries}
                loadingEntries={props.loadingEntries}
                normalizedSearch={props.normalizedSearch}
                error={props.error}
                truncationMessage={props.truncationMessage}
                onBrowsePath={props.onBrowsePath}
                onSelectPath={props.onSelectPath}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
