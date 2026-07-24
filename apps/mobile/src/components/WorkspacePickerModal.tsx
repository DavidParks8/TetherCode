import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../accessibility';
import { useAppTheme } from '../theme';
import {
  getWorkspacePickerPresentation,
  matchesSearch,
  toPathBasename,
} from './workspacePickerHelpers';
import { WorkspacePickerModalView } from './WorkspacePickerModalView';
import { createWorkspacePickerStyles } from './workspacePickerStyles';
import type {
  WorkspacePickerModalProps,
  WorkspacePickerScreen,
} from './workspacePickerTypes';

export function WorkspacePickerModal({
  visible,
  selectedPath = null,
  bridgeRoot = null,
  recentWorkspaces,
  currentPath = null,
  parentPath = null,
  entries,
  loadingEntries = false,
  error = null,
  truncationMessage = null,
  onBrowsePath,
  onSelectPath,
  actionLabel = null,
  actionDescription = null,
  actionDisabled = false,
  onActionPress,
  onClose,
}: WorkspacePickerModalProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [screen, setScreen] = useState<WorkspacePickerScreen>('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [browserRootPath, setBrowserRootPath] = useState<string | null>(null);
  const wasVisibleRef = useRef(false);
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);
  const presentation = useMemo(
    () =>
      getWorkspacePickerPresentation({
        width: windowWidth,
        height: windowHeight,
        topInset: insets.top,
        bottomInset: insets.bottom,
      }),
    [insets.bottom, insets.top, windowHeight, windowWidth]
  );

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible && !wasVisible) {
      setScreen('home');
      setSearchQuery('');
      setBrowserRootPath(null);
    } else if (!visible) {
      setSearchQuery('');
    }
  }, [visible]);

  useEffect(() => {
    if (screen === 'browser') {
      setSearchQuery('');
    }
  }, [currentPath, screen]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredEntries = useMemo(
    () =>
      entries.filter((entry) =>
        matchesSearch([entry.name, entry.path], normalizedSearch)
      ),
    [entries, normalizedSearch]
  );
  const recentWorkspaceList = useMemo(() => {
    const seen = new Set<string>();
    return recentWorkspaces
      .filter((workspace) => {
        if (seen.has(workspace.path)) return false;
        seen.add(workspace.path);
        return true;
      })
      .slice(0, 6);
  }, [recentWorkspaces]);

  const currentFolderPath = currentPath ?? bridgeRoot;
  const currentFolderTitle = currentFolderPath
    ? toPathBasename(currentFolderPath)
    : 'Computer folders';
  const canBrowseUp =
    screen === 'browser' &&
    Boolean(parentPath) &&
    currentFolderPath !== browserRootPath;
  const browserBackLabel =
    canBrowseUp && parentPath ? toPathBasename(parentPath) : 'Workspaces';
  const actionPath = selectedPath ?? currentPath ?? bridgeRoot;
  const modalFocusRef = useModalAccessibilityFocus(visible);

  useAccessibilityAnnouncement(visible ? error ?? truncationMessage : null);
  useAccessibilityAnnouncement(
    visible && loadingEntries && screen === 'browser'
      ? `Loading folders in ${currentFolderTitle}`
      : null
  );
  useAccessibilityAnnouncement(
    visible && screen === 'browser' ? `Browsing ${currentFolderTitle}` : null
  );

  const handleOpenBrowser = () => {
    const startPath = currentPath ?? selectedPath ?? bridgeRoot;
    setBrowserRootPath(startPath);
    setSearchQuery('');
    setScreen('browser');
    if (
      !loadingEntries &&
      (currentPath !== startPath || entries.length === 0)
    ) {
      onBrowsePath(startPath);
    }
  };

  const handleBrowsePath = (path: string | null) => {
    setSearchQuery('');
    onBrowsePath(path);
  };

  const handleBrowserBack = () => {
    if (canBrowseUp && parentPath) {
      handleBrowsePath(parentPath);
      return;
    }
    setSearchQuery('');
    setScreen('home');
  };

  return (
    <WorkspacePickerModalView
      visible={visible}
      screen={screen}
      styles={styles}
      theme={theme}
      presentation={presentation}
      bottomSafeInset={insets.bottom}
      modalFocusRef={modalFocusRef}
      onClose={onClose}
      selectedPath={selectedPath}
      bridgeRoot={bridgeRoot}
      recentWorkspaces={recentWorkspaceList}
      browseStartPath={currentPath ?? selectedPath ?? bridgeRoot}
      onOpenBrowser={handleOpenBrowser}
      onSelectPath={onSelectPath}
      actionLabel={actionLabel}
      actionDescription={actionDescription}
      actionDisabled={actionDisabled}
      onActionPress={
        onActionPress ? () => onActionPress(actionPath) : undefined
      }
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      parentPath={parentPath}
      browserBackLabel={browserBackLabel}
      onBrowserBack={handleBrowserBack}
      currentFolderTitle={currentFolderTitle}
      currentFolderPath={currentFolderPath}
      loadingEntries={loadingEntries}
      entries={filteredEntries}
      normalizedSearch={normalizedSearch}
      onBrowsePath={handleBrowsePath}
      error={error}
      truncationMessage={truncationMessage}
    />
  );
}
