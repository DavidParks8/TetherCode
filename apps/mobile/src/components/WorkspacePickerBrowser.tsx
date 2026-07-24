import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { FileSystemEntry } from '../api/types';
import { decorativeAccessibilityProps } from '../accessibility';
import type { AppTheme } from '../theme';
import { ENTRY_ROW_HEIGHT } from './workspacePickerHelpers';
import type { WorkspacePickerStyles } from './workspacePickerStyles';
import { WorkspacePickerFooter } from './WorkspacePickerFooter';

interface Props {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  bottomSafeInset: number;
  browserBackLabel: string;
  onBack: () => void;
  currentFolderTitle: string;
  currentFolderPath: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  entries: FileSystemEntry[];
  loadingEntries: boolean;
  normalizedSearch: string;
  error: string | null;
  truncationMessage: string | null;
  onBrowsePath: (path: string | null) => void;
  onSelectPath: (path: string | null) => void;
}

export function WorkspacePickerBrowser({
  styles,
  theme,
  bottomSafeInset,
  browserBackLabel,
  onBack,
  currentFolderTitle,
  currentFolderPath,
  searchQuery,
  setSearchQuery,
  entries,
  loadingEntries,
  normalizedSearch,
  error,
  truncationMessage,
  onBrowsePath,
  onSelectPath,
}: Props) {
  return (
    <View style={styles.screen}>
      <View style={styles.browserToolbar}>
        <Pressable
          onPress={onBack}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`Back to ${browserBackLabel}`}
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-back"
            size={21}
            color={theme.colors.accent}
          />
          <Text style={styles.backButtonText} numberOfLines={1}>
            {browserBackLabel}
          </Text>
        </Pressable>
        <Text accessibilityRole="header" style={styles.browserTitle} numberOfLines={1}>
          {currentFolderTitle}
        </Text>
        <View style={styles.toolbarSpacer} />
      </View>

      <View style={styles.browserSearchWrap}>
        <View style={styles.searchField}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="search"
            size={16}
            color={theme.colors.textMuted}
          />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            keyboardAppearance={theme.keyboardAppearance}
            placeholder="Search this folder"
            placeholderTextColor={theme.colors.textMuted}
            style={styles.searchInput}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search this folder"
          />
        </View>
      </View>

      <View style={styles.location}>
        <View style={styles.locationCopy}>
          <Text style={styles.locationTitle} numberOfLines={1}>
            {currentFolderTitle}
          </Text>
          <Text style={styles.locationPath} numberOfLines={1} ellipsizeMode="middle">
            {currentFolderPath ?? 'Loading computer folders'}
          </Text>
        </View>
        {loadingEntries ? (
          <ActivityIndicator
            accessibilityLabel={`Loading folders in ${currentFolderTitle}`}
            color={theme.colors.textMuted}
            size="small"
          />
        ) : null}
      </View>

      {error ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="assertive"
          style={styles.errorText}
        >
          {error}
        </Text>
      ) : null}
      {truncationMessage ? (
        <Text accessibilityLiveRegion="polite" style={styles.noticeText}>
          {truncationMessage}
        </Text>
      ) : null}

      <FlatList
        style={styles.entryList}
        contentContainerStyle={[
          styles.entryListContent,
          entries.length === 0 && styles.entryListEmptyContent,
        ]}
        data={entries}
        keyExtractor={(entry) => entry.path}
        initialNumToRender={18}
        maxToRenderPerBatch={24}
        removeClippedSubviews
        windowSize={7}
        getItemLayout={(_, index) => ({
          length: ENTRY_ROW_HEIGHT,
          offset: ENTRY_ROW_HEIGHT * index,
          index,
        })}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          <EmptyBrowserState
            styles={styles}
            loading={loadingEntries}
            searching={Boolean(normalizedSearch)}
          />
        }
        renderItem={({ item: entry, index }) => (
          <Pressable
            onPress={() => onBrowsePath(entry.path)}
            style={({ pressed }) => [
              styles.folderRow,
              index === entries.length - 1 && styles.rowLast,
              pressed && styles.rowPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Open folder ${entry.name}`}
          >
            <View style={styles.rowIcon}>
              <Ionicons
                {...decorativeAccessibilityProps}
                name={entry.isGitRepo ? 'git-branch-outline' : 'folder-outline'}
                size={21}
                color={theme.colors.textSecondary}
              />
            </View>
            <View style={styles.rowCopy}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {entry.name}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {entry.isGitRepo ? 'Git repository' : 'Folder'}
              </Text>
            </View>
            <View style={styles.rowAccessory}>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="chevron-forward"
                size={16}
                color={theme.colors.textMuted}
              />
            </View>
          </Pressable>
        )}
      />

      <WorkspacePickerFooter
        styles={styles}
        bottomSafeInset={bottomSafeInset}
        folderPath={currentFolderPath}
        folderTitle={currentFolderTitle}
        onSelectPath={onSelectPath}
      />
    </View>
  );
}

function EmptyBrowserState({
  styles,
  loading,
  searching,
}: {
  styles: WorkspacePickerStyles;
  loading: boolean;
  searching: boolean;
}) {
  if (loading) {
    return (
      <View
        style={styles.emptyState}
        accessibilityRole="progressbar"
        accessibilityLabel="Loading folders"
        accessibilityLiveRegion="polite"
      >
        <ActivityIndicator />
        <Text style={styles.emptyStateText}>Loading folders...</Text>
      </View>
    );
  }

  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyStateText}>
        {searching
          ? 'No folders match this search.'
          : 'No subfolders. You can choose this folder.'}
      </Text>
    </View>
  );
}
