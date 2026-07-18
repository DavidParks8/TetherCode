import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  type FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Chat, RunEvent } from '../api/types';
import type { AutoScrollState, ThreadRuntimeSnapshot } from './mainScreenHelpers';
import type { AgentThreadDisplayState } from './agentThreadDisplay';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { ChatTranscriptView } from './ChatTranscriptView';
import { useAppTheme, type AppTheme } from '../theme';

interface SubAgentDetailViewProps {
  visible: boolean;
  chat: Chat | null;
  parentChat: Chat | null;
  runtime: ThreadRuntimeSnapshot | null;
  display: AgentThreadDisplayState | null;
  title: string;
  role?: string | null;
  loading: boolean;
  error: string | null;
  bridgeUrl: string;
  bridgeToken: string | null;
  showToolCalls: boolean;
  agentThreadStatusById: ReadonlyMap<string, Chat['status']>;
  onOpenLocalPreview?: (targetUrl: string) => void;
  onClose: () => void;
  onOpenAsChat: () => void;
  onRefresh: () => void;
}

export function SubAgentDetailView({
  visible,
  chat,
  parentChat,
  runtime,
  display,
  title,
  role,
  loading,
  error,
  bridgeUrl,
  bridgeToken,
  showToolCalls,
  agentThreadStatusById,
  onOpenLocalPreview,
  onClose,
  onOpenAsChat,
  onRefresh,
}: SubAgentDetailViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const scrollRef = useRef<FlatList<TranscriptDisplayItem>>(null);
  const autoScrollStateRef = useRef<AutoScrollState>({
    shouldStickToBottom: true,
    isUserInteracting: false,
    isMomentumScrolling: false,
  });
  const latestCommand: RunEvent | null =
    runtime?.latestCommand ?? runtime?.activeCommands?.at(-1) ?? null;
  const activityDetail = display?.detail ?? latestCommand?.detail ?? role?.trim() ?? null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={8} style={styles.iconButton}>
            <Ionicons name="chevron-back" size={22} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>Sub-agent</Text>
            <Text style={styles.title} numberOfLines={1}>{title}</Text>
          </View>
          <Pressable onPress={onRefresh} hitSlop={8} style={styles.iconButton}>
            {loading ? (
              <ActivityIndicator size="small" color={theme.colors.textMuted} />
            ) : (
              <Ionicons name="refresh" size={18} color={theme.colors.textMuted} />
            )}
          </Pressable>
        </View>

        <View style={styles.statusBar}>
          <View style={styles.statusCopy}>
            <View style={styles.statusTitleRow}>
              {display?.isActive ? (
                <ActivityIndicator size="small" color={display.statusColor} />
              ) : (
                <Ionicons
                  name={display?.icon ?? 'ellipse-outline'}
                  size={15}
                  color={display?.statusColor ?? theme.colors.textMuted}
                />
              )}
              <Text
                style={[
                  styles.statusLabel,
                  { color: display?.statusColor ?? theme.colors.textMuted },
                ]}
              >
                {display?.label ?? (loading ? 'Loading' : 'Idle')}
              </Text>
            </View>
            {activityDetail ? (
              <Text style={styles.activityDetail} numberOfLines={2}>{activityDetail}</Text>
            ) : null}
          </View>
          <Pressable onPress={onOpenAsChat} style={styles.openChatButton}>
            <Text style={styles.openChatButtonText}>Open as chat</Text>
            <Ionicons name="open-outline" size={14} color={theme.colors.textPrimary} />
          </Pressable>
        </View>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        <View style={styles.transcript}>
          {chat ? (
            <ChatTranscriptView
              chat={chat}
              parentChat={parentChat}
              bridgeUrl={bridgeUrl}
              bridgeToken={bridgeToken}
              onOpenLocalPreview={onOpenLocalPreview}
              showToolCalls={showToolCalls}
              agentThreadStatusById={agentThreadStatusById}
              scrollRef={scrollRef}
              inlineChoicesEnabled={false}
              onInlineOptionSelect={() => {}}
              onPinnedAutoScroll={() => {
                if (autoScrollStateRef.current.shouldStickToBottom) {
                  scrollRef.current?.scrollToOffset({ offset: 0, animated: false });
                }
              }}
              onJumpToLatest={() => {
                scrollRef.current?.scrollToOffset({ offset: 0, animated: true });
              }}
              onScrollInteractionStart={() => {}}
              autoScrollStateRef={autoScrollStateRef}
              bottomInset={0}
              liveAssistantText={runtime?.streamingText ?? null}
            />
          ) : (
            <View style={styles.loadingShell}>
              <ActivityIndicator color={theme.colors.textMuted} />
              <Text style={styles.loadingText}>Loading agent transcript…</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.bgMain,
  },
  header: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    ...theme.typography.headline,
    color: theme.colors.textPrimary,
    fontSize: 17,
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.bgElevated,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  statusCopy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  statusTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  statusLabel: {
    ...theme.typography.caption,
    fontWeight: '700',
  },
  activityDetail: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
  },
  openChatButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    borderRadius: theme.radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderHighlight,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 7,
  },
  openChatButtonText: {
    ...theme.typography.caption,
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  errorText: {
    ...theme.typography.caption,
    color: theme.colors.error,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  transcript: {
    flex: 1,
  },
  loadingShell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.sm,
  },
  loadingText: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
  },
});
