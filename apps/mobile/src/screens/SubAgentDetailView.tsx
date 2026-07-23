import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  type FlatList,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { Chat, RunEvent } from '../api/types';
import type { AutoScrollState, ThreadRuntimeSnapshot } from './mainScreenHelpers';
import type { AgentThreadDisplayState } from './agentThreadDisplay';
import type { AgUiThreadMessageState } from '../api/agUiMessages';
import type { TranscriptDisplayItem } from './transcriptMessages';
import { ChatTranscriptView } from './ChatTranscriptView';
import { useAppTheme, type AppTheme } from '../theme';
import {
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '../accessibility';

interface SubAgentDetailViewProps {
  visible: boolean;
  chat: Chat | null;
  parentChat: Chat | null;
  runtime: ThreadRuntimeSnapshot | null;
  liveMessageState: AgUiThreadMessageState | null;
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
}

export function SubAgentDetailView({
  visible,
  chat,
  parentChat,
  runtime,
  liveMessageState,
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
}: SubAgentDetailViewProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { width: viewportWidth } = useWindowDimensions();
  const transition = useRef(new Animated.Value(1)).current;
  const [mounted, setMounted] = useState(visible);
  const closingRef = useRef(false);
  const scrollRef = useRef<FlatList<TranscriptDisplayItem>>(null);
  const autoScrollStateRef = useRef<AutoScrollState>({
    shouldStickToBottom: true,
    isUserInteracting: false,
    isMomentumScrolling: false,
  });
  const latestCommand: RunEvent | null =
    runtime?.latestCommand ?? runtime?.activeCommands?.at(-1) ?? null;
  const resolvedLiveMessageState =
    liveMessageState ??
    (runtime?.streamingText?.trim()
      ? {
          messages: [{
            id: `live-assistant-${chat?.id ?? 'sub-agent'}`,
            role: 'assistant' as const,
            content: runtime.streamingText,
            createdAt: new Date().toISOString(),
          }],
          authoritativeSnapshot: false,
          runByMessageId: {}, terminalMessageIds: [], replacesMessageIdByMessageId: {},
          toolCallMessageIdByCallId: {}, toolResultMessageIdByCallId: {},
          subagentToolCallIds: {},
          toolTextRevisionByCallId: {}, structuredRevisionByCallId: {},
          structuredTextByCallId: {}, chunkAssemblies: {}, state: null, steps: {}, rawEvents: [],
          customMetadata: {}, customMetadataOrder: [],
        }
      : null);
  const activityDetail = display?.detail ?? latestCommand?.detail ?? role?.trim() ?? null;
  const modalFocusRef = useModalAccessibilityFocus(visible);
  useAccessibilityAnnouncement(visible ? error ?? (loading ? 'Loading agent transcript' : null) : null);

  useEffect(() => {
    if (visible) {
      closingRef.current = false;
      setMounted(true);
      transition.stopAnimation();
      transition.setValue(1);
      Animated.timing(transition, {
        toValue: 0,
        duration: 240,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
      return;
    }
    if (mounted && !closingRef.current) {
      Animated.timing(transition, {
        toValue: 1,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setMounted(false));
    }
  }, [mounted, transition, visible]);

  const navigateBack = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(transition, {
      toValue: 1,
      duration: 200,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      setMounted(false);
      closingRef.current = false;
      onClose();
    });
  }, [onClose, transition]);

  if (!mounted) return null;

  return (
    <Animated.View
      style={[
        styles.page,
        {
          transform: [{
            translateX: transition.interpolate({
              inputRange: [0, 1],
              outputRange: [0, Math.max(viewportWidth, 1)],
            }),
          }],
        },
      ]}
    >
      <SafeAreaView accessibilityViewIsModal importantForAccessibility="yes" style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={navigateBack} hitSlop={8} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Back from sub-agent transcript">
            <Ionicons {...decorativeAccessibilityProps} name="chevron-back" size={22} color={theme.colors.textPrimary} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>Sub-agent</Text>
            <Text ref={modalFocusRef} accessibilityRole="header" style={styles.title} numberOfLines={1}>{title}</Text>
          </View>
          <View style={styles.iconButton} />
        </View>

        <View style={styles.statusBar} accessibilityLiveRegion="polite">
          <View style={styles.statusCopy}>
            <View style={styles.statusTitleRow}>
              {display?.isActive ? (
                <ActivityIndicator size="small" color={display.statusColor} />
              ) : (
                <Ionicons
                  {...decorativeAccessibilityProps}
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
        </View>

        {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorText}>{error}</Text> : null}

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
              liveMessageState={resolvedLiveMessageState}
            />
          ) : (
            <View style={styles.loadingShell} accessibilityRole="progressbar" accessibilityLabel="Loading agent transcript">
              <ActivityIndicator color={theme.colors.textMuted} />
              <Text style={styles.loadingText}>Loading agent transcript…</Text>
            </View>
          )}
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
  page: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    elevation: 24,
    backgroundColor: theme.colors.bgMain,
  },
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
