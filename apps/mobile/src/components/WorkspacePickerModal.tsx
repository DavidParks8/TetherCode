import { useEffect, useMemo, useRef, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccessibilityAnnouncement, useModalAccessibilityFocus } from '../accessibility';
import { useAppTheme } from '../theme';
import { matchesSearch, toPathBasename } from './workspacePickerHelpers';
import { WorkspacePickerModalView } from './WorkspacePickerModalView';
import { createWorkspacePickerStyles } from './workspacePickerStyles';
import type { WorkspacePickerModalProps } from './workspacePickerTypes';

export function WorkspacePickerModal({
  visible, selectedPath = null, bridgeRoot = null, recentWorkspaces,
  favoriteWorkspacePaths = [], currentPath = null, parentPath = null, entries,
  loadingEntries = false, error = null, truncationMessage = null, onBrowsePath,
  onSelectPath, onToggleFavorite, actionLabel = null, actionDescription = null,
  actionDisabled = false, onActionPress, onClose,
}: WorkspacePickerModalProps) {
  const theme = useAppTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [searchQuery, setSearchQuery] = useState('');
  const [pendingSelectionPath, setPendingSelectionPath] = useState<string | null>(
    selectedPath ?? currentPath ?? bridgeRoot
  );
  const wasVisibleRef = useRef(false);
  const previousSelectedPathRef = useRef<string | null>(selectedPath);
  const styles = useMemo(() => createWorkspacePickerStyles(theme), [theme]);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!visible) {
      setSearchQuery('');
    } else if (!wasVisible) {
      setPendingSelectionPath(selectedPath ?? currentPath ?? bridgeRoot);
    }
  }, [bridgeRoot, currentPath, selectedPath, visible]);

  useEffect(() => {
    if (!visible || pendingSelectionPath !== null) return;
    const fallbackPath = selectedPath ?? currentPath ?? bridgeRoot;
    if (fallbackPath) setPendingSelectionPath(fallbackPath);
  }, [bridgeRoot, currentPath, pendingSelectionPath, selectedPath, visible]);

  useEffect(() => {
    const previousSelectedPath = previousSelectedPathRef.current;
    previousSelectedPathRef.current = selectedPath;
    if (!visible || previousSelectedPath === selectedPath) return;
    setPendingSelectionPath((current) =>
      current !== previousSelectedPath
        ? current
        : selectedPath ?? currentPath ?? bridgeRoot ?? null
    );
  }, [bridgeRoot, currentPath, selectedPath, visible]);

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const favoritePathSet = useMemo(() => new Set(favoriteWorkspacePaths), [favoriteWorkspacePaths]);
  const recentWorkspaceByPath = useMemo(
    () => new Map(recentWorkspaces.map((workspace) => [workspace.path, workspace])),
    [recentWorkspaces]
  );
  const favoriteWorkspaces = favoriteWorkspacePaths
    .map((path) => recentWorkspaceByPath.get(path) ?? { path, chatCount: 0 })
    .filter((workspace) => matchesSearch([workspace.path, toPathBasename(workspace.path)], normalizedSearch))
    .slice(0, 4);
  const filteredEntries = entries.filter((entry) =>
    matchesSearch([entry.name, entry.path], normalizedSearch)
  );
  const footerPath = pendingSelectionPath ?? currentPath ?? bridgeRoot ?? null;
  const footerTitle = footerPath ? toPathBasename(footerPath) : 'Default workspace';
  const currentFolderPath = currentPath ?? bridgeRoot ?? null;
  const currentFolderTitle = currentFolderPath ? toPathBasename(currentFolderPath) : 'Loading';
  const topInset = Math.max(insets.top + theme.spacing.lg, 72);
  const bottomInset = Math.max(insets.bottom + theme.spacing.lg, 72);
  const cardHeight = Math.min(
    Math.max(560, Math.round(windowHeight * 0.82)),
    windowHeight - topInset - bottomInset
  );
  const modalFocusRef = useModalAccessibilityFocus(visible);
  useAccessibilityAnnouncement(visible ? error ?? truncationMessage : null);
  useAccessibilityAnnouncement(
    visible && loadingEntries ? `Loading folders in ${currentFolderTitle}` : null
  );

  const handleBrowsePath = (path: string | null) => {
    setPendingSelectionPath(path);
    onBrowsePath(path);
  };

  return (
    <WorkspacePickerModalView
      visible={visible} styles={styles} theme={theme} topInset={topInset}
      bottomInset={bottomInset} cardHeight={cardHeight} modalFocusRef={modalFocusRef}
      onClose={onClose} selectedPath={selectedPath} bridgeRoot={bridgeRoot}
      searchQuery={searchQuery} setSearchQuery={setSearchQuery} onSelectPath={onSelectPath}
      actionLabel={actionLabel} actionDescription={actionDescription}
      actionDisabled={actionDisabled}
      onActionPress={onActionPress ? () => onActionPress(footerPath) : undefined}
      favoriteWorkspaces={favoriteWorkspaces} favoritePathSet={favoritePathSet}
      pendingSelectionPath={pendingSelectionPath} onBrowsePath={handleBrowsePath}
      onToggleFavorite={onToggleFavorite} parentPath={parentPath}
      loadingEntries={loadingEntries} filteredEntries={filteredEntries}
      normalizedSearch={normalizedSearch} currentFolderTitle={currentFolderTitle}
      currentFolderPath={currentFolderPath} error={error}
      truncationMessage={truncationMessage} footerPath={footerPath}
      footerTitle={footerTitle} footerSubtitle={footerPath ?? 'Bridge default workspace'}
      footerIsFavorite={footerPath ? favoritePathSet.has(footerPath) : false}
    />
  );
}