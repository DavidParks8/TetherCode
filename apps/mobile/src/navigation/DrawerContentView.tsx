import { Ionicons } from '@expo/vector-icons';
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import { getDrawerFolderPickerLabels } from './drawerAttention';
import { formatCompactCount } from './drawerContentHelpers';
import { DrawerChatList } from './DrawerChatList';
import { useDrawerContentViewModel } from './drawerContentViewContext';

export function DrawerContentView() {
  const {
    attentionCount,
    folderOptions,
    folderPickerVisible,
    handleDismissFolderPicker,
    handleNavigate,
    handleNewChat,
    handleOpenFolderPicker,
    handleSelectFolder,
    recentCount,
    selectedFolderKey,
    selectedFolderLabel,
    styles,
    theme,
    totalChatCount,
    workingCount,
    wsConnected,
  } = useDrawerContentViewModel();
  const attentionSummary =
    attentionCount === 0
      ? 'No requests'
      : attentionCount === 1
        ? '1 needs you'
        : `${String(attentionCount)} need you`;
  const folderPickerLabels = getDrawerFolderPickerLabels(folderOptions);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.mainContent}>
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View style={styles.titleCopy}>
                <Text style={styles.title}>Agent activity</Text>
                <Text style={styles.subtitle}>Ordered by what needs you next</Text>
              </View>
              <Pressable
                accessibilityLabel="New chat"
                accessibilityRole="button"
                hitSlop={4}
                onPress={handleNewChat}
                style={({ pressed }) => [
                  styles.headerIconButton,
                  pressed && styles.headerIconButtonPressed,
                ]}
              >
                <Ionicons
                  {...decorativeAccessibilityProps}
                  name="add"
                  size={24}
                  color={theme.colors.accent}
                />
              </Pressable>
            </View>

            <View style={styles.statusSummary} accessibilityLiveRegion="polite">
              <Text style={styles.statusSummaryAttention}>{attentionSummary}</Text>
              <View style={styles.statusSummarySeparator} />
              <Text style={styles.statusSummaryText}>{`${String(workingCount)} working`}</Text>
              <View style={styles.statusSummarySeparator} />
              <Text style={styles.statusSummaryText}>{`${String(recentCount)} recent`}</Text>
            </View>

            <Pressable
              accessibilityLabel={`Filter sessions by folder, ${selectedFolderLabel}`}
              accessibilityRole="button"
              accessibilityState={controlAccessibilityState({
                expanded: folderPickerVisible,
              })}
              onPress={handleOpenFolderPicker}
              style={({ pressed }) => [
                styles.folderFilter,
                pressed && styles.folderFilterPressed,
              ]}
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="folder-outline"
                size={16}
                color={theme.colors.textMuted}
              />
              <Text style={styles.folderFilterLabel}>Folder</Text>
              <Text style={styles.folderFilterValue} numberOfLines={1}>
                {selectedFolderLabel}
              </Text>
              <Ionicons
                {...decorativeAccessibilityProps}
                name="chevron-down"
                size={14}
                color={theme.colors.accent}
              />
            </Pressable>
          </View>

          <DrawerChatList />
        </View>

        <View style={styles.footer}>
          <View
            accessible
            accessibilityLabel={wsConnected ? 'Bridge connected' : 'Bridge offline'}
            accessibilityLiveRegion="polite"
            style={styles.connectionStatus}
          >
            <View
              style={[
                styles.connectionDot,
                wsConnected
                  ? styles.connectionDotConnected
                  : styles.connectionDotDisconnected,
              ]}
            />
            <View style={styles.connectionCopy}>
              <Text style={styles.connectionTitle}>
                {wsConnected ? 'Bridge connected' : 'Bridge offline'}
              </Text>
              <Text style={styles.connectionMeta}>
                {`${formatCompactCount(totalChatCount)} sessions`}
              </Text>
            </View>
          </View>
          <Pressable
            accessibilityLabel="Open preview browser"
            accessibilityRole="button"
            onPress={() => handleNavigate('Browser')}
            style={({ pressed }) => [
              styles.footerBrowserButton,
              pressed && styles.footerActionPressed,
            ]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="globe-outline"
              size={17}
              color={theme.colors.accent}
            />
            <Text style={styles.footerBrowserText}>Browser</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Open settings"
            accessibilityRole="button"
            onPress={() => handleNavigate('Settings')}
            style={({ pressed }) => [
              styles.footerIconButton,
              pressed && styles.footerActionPressed,
            ]}
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="settings-outline"
              size={18}
              color={theme.colors.accent}
            />
          </Pressable>
        </View>
      </SafeAreaView>

      <Modal
        animationType="fade"
        onRequestClose={handleDismissFolderPicker}
        transparent
        visible={folderPickerVisible}
      >
        <View style={styles.folderPickerRoot}>
          <Pressable
            accessibilityLabel="Close folder picker"
            onPress={handleDismissFolderPicker}
            style={styles.folderPickerBackdrop}
          />
          <View
            accessibilityViewIsModal
            style={styles.folderPickerSheet}
          >
            <View style={styles.folderPickerHeader}>
              <Text style={styles.folderPickerTitle}>Folder</Text>
              <Pressable
                accessibilityLabel="Close folder picker"
                onPress={handleDismissFolderPicker}
                style={styles.folderPickerDoneButton}
              >
                <Text style={styles.folderPickerDone}>Done</Text>
              </Pressable>
            </View>
            <ScrollView
              contentContainerStyle={styles.folderPickerList}
              showsVerticalScrollIndicator={false}
            >
              {folderOptions.map((option, index) => {
                const selected = option.key === selectedFolderKey;
                return (
                  <Pressable
                    key={option.key ?? 'all'}
                    accessibilityLabel={`${folderPickerLabels[index] ?? option.label}, ${String(option.itemCount)} ${option.itemCount === 1 ? 'session' : 'sessions'}`}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected }}
                    onPress={() => handleSelectFolder(option.key)}
                    style={({ pressed }) => [
                      styles.folderPickerRow,
                      pressed && styles.folderPickerRowPressed,
                    ]}
                  >
                    <Ionicons
                      {...decorativeAccessibilityProps}
                      name={option.key ? 'folder-outline' : 'albums-outline'}
                      size={17}
                      color={theme.colors.textMuted}
                    />
                    <View style={styles.folderPickerRowCopy}>
                      <Text style={styles.folderPickerRowTitle} numberOfLines={1}>
                        {option.label}
                      </Text>
                      {option.subtitle ? (
                        <Text style={styles.folderPickerRowSubtitle} numberOfLines={1}>
                          {option.subtitle}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.folderPickerRowCount}>
                      {formatCompactCount(option.itemCount)}
                    </Text>
                    {selected ? (
                      <Ionicons
                        {...decorativeAccessibilityProps}
                        name="checkmark"
                        size={18}
                        color={theme.colors.accent}
                      />
                    ) : (
                      <View style={styles.folderPickerCheckPlaceholder} />
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
