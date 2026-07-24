import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  Text,
  View,
} from 'react-native';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import type { DrawerAttentionLane, DrawerAttentionRow } from './drawerAttention';
import { relativeTime } from './drawerContentHelpers';
import { useDrawerContentViewModel } from './drawerContentViewContext';

export function DrawerChatList() {
  const {
    collapsedLaneKeys,
    handleSelectChat,
    loading,
    loadingOlderChats,
    noticeMessages,
    refreshing,
    refreshDrawer,
    resolvedEmptyHint,
    resolvedEmptyTitle,
    retryDeepChatListRef,
    selectedChatId,
    styles,
    theme,
    toggleAttentionSection,
    visibleAttentionSections,
  } = useDrawerContentViewModel();
  const retryDrawerData = () => {
    void Promise.all([
      retryDeepChatListRef.current(),
      refreshDrawer(),
    ]);
  };
  const notice = noticeMessages.length > 0 ? (
    <Pressable
      accessibilityLabel={`${noticeMessages.join(' ')} Retry`}
      accessibilityRole="button"
      onPress={retryDrawerData}
      style={({ pressed }) => [
        styles.notice,
        pressed && styles.noticePressed,
      ]}
    >
      <Ionicons
        {...decorativeAccessibilityProps}
        name="alert-circle-outline"
        size={17}
        color={theme.colors.textMuted}
      />
      <View style={styles.noticeCopy}>
        <Text style={styles.noticeTitle}>Some drawer data may be stale</Text>
        <Text style={styles.noticeMessage} numberOfLines={2}>
          {noticeMessages.join(' ')}
        </Text>
      </View>
      <Text style={styles.noticeAction}>Retry</Text>
    </Pressable>
  ) : null;

  if (loading) {
    return (
      <View
        accessibilityLabel="Loading sessions"
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        style={styles.emptyState}
      >
        <ActivityIndicator color={theme.colors.textMuted} style={styles.loader} />
        <Text style={styles.emptyTitle}>Loading sessions</Text>
        <Text style={styles.emptyHint}>Syncing recent activity from your bridge.</Text>
      </View>
    );
  }

  if (visibleAttentionSections.length === 0) {
    return (
      <ScrollView
        contentContainerStyle={styles.emptyListContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refreshDrawer();
            }}
            tintColor={theme.colors.textMuted}
          />
        }
        style={styles.list}
      >
        {notice}
        <View accessibilityLiveRegion="polite" style={styles.emptyState}>
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chatbubbles-outline"
            size={21}
            color={theme.colors.textMuted}
          />
          <Text style={styles.emptyTitle}>{resolvedEmptyTitle}</Text>
          <Text style={styles.emptyHint}>{resolvedEmptyHint}</Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <SectionList
      sections={visibleAttentionSections}
      keyExtractor={(item) => item.chat.id}
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      stickySectionHeadersEnabled={false}
      removeClippedSubviews={false}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={9}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            void refreshDrawer();
          }}
          tintColor={theme.colors.textMuted}
        />
      }
      ListHeaderComponent={notice}
      ListFooterComponent={
        loadingOlderChats ? (
          <View style={styles.loadingMoreFooter}>
            <ActivityIndicator size="small" color={theme.colors.textMuted} />
          </View>
        ) : null
      }
      renderSectionHeader={({ section }) => {
        const collapsed = collapsedLaneKeys.has(section.key);
        return (
          <Pressable
            accessibilityLabel={`${section.title}, ${String(section.itemCount)} ${section.itemCount === 1 ? 'session' : 'sessions'}`}
            accessibilityHint="Toggles this activity section."
            accessibilityRole="button"
            accessibilityState={controlAccessibilityState({ expanded: !collapsed })}
            onPress={() => toggleAttentionSection(section.key)}
            style={({ pressed }) => [
              styles.laneHeader,
              pressed && styles.laneHeaderPressed,
            ]}
          >
            <View
              {...decorativeAccessibilityProps}
              style={[
                styles.laneDot,
                laneDotStyle(section.key, styles),
              ]}
            />
            <Text style={styles.laneTitle}>{section.title}</Text>
            <Text style={styles.laneCount}>{String(section.itemCount)}</Text>
            <Ionicons
              {...decorativeAccessibilityProps}
              name={collapsed ? 'chevron-forward' : 'chevron-down'}
              size={14}
              color={theme.colors.textMuted}
            />
          </Pressable>
        );
      }}
      renderSectionFooter={() => <View style={styles.laneFooter} />}
      renderItem={({ item, index, section }) => {
        const isSelected = item.chat.id === selectedChatId;
        const isLast = index === section.data.length - 1;
        const chatIndent = Math.min(item.indentLevel, 4) * 12;
        return (
          <Pressable
            accessibilityLabel={`${item.chat.title || 'Untitled session'}, ${item.workspaceLabel}, ${item.agentLabel}, ${item.stateLabel}`}
            accessibilityHint="Opens this session."
            accessibilityRole="button"
            accessibilityState={controlAccessibilityState({ selected: isSelected })}
            onPress={() => handleSelectChat(item.chat.id)}
            style={[
              styles.chatItemFrame,
              item.indentLevel > 0 && {
                marginLeft: theme.spacing.lg + chatIndent,
              },
              isLast && styles.chatItemLast,
            ]}
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.chatItem,
                  isSelected && styles.chatItemSelected,
                  pressed && styles.chatItemPressed,
                ]}
              >
                <View style={styles.chatItemTextBlock}>
                  <Text
                    style={[
                      styles.chatTitle,
                      isSelected && styles.chatTitleSelected,
                    ]}
                    numberOfLines={1}
                  >
                    {item.chat.title || 'Untitled'}
                  </Text>
                  <Text style={styles.chatContext} numberOfLines={1}>
                    {`${item.workspaceLabel} · ${item.agentLabel}`}
                  </Text>
                </View>
                <View style={styles.chatItemMeta}>
                  <Text style={styles.chatAge}>{relativeTime(item.chat.updatedAt)}</Text>
                  <View style={styles.chatState}>
                    <View
                      {...decorativeAccessibilityProps}
                      style={[
                        styles.chatStateDot,
                        rowStateDotStyle(item, styles),
                      ]}
                    />
                    <Text
                      style={[
                        styles.chatStateText,
                        item.attentionReason === 'error' && styles.chatStateTextError,
                      ]}
                      numberOfLines={1}
                    >
                      {item.stateLabel}
                    </Text>
                  </View>
                </View>
              </View>
            )}
          </Pressable>
        );
      }}
    />
  );
}

function laneDotStyle(
  lane: DrawerAttentionLane,
  styles: ReturnType<typeof useDrawerContentViewModel>['styles']
) {
  if (lane === 'attention') {
    return styles.laneDotAttention;
  }
  if (lane === 'working') {
    return styles.laneDotWorking;
  }
  return styles.laneDotRecent;
}

function rowStateDotStyle(
  row: DrawerAttentionRow,
  styles: ReturnType<typeof useDrawerContentViewModel>['styles']
) {
  if (row.attentionReason === 'error') {
    return styles.chatStateDotError;
  }
  if (row.lane === 'attention') {
    return styles.chatStateDotAttention;
  }
  if (row.lane === 'working') {
    return styles.chatStateDotWorking;
  }
  return styles.chatStateDotRecent;
}
