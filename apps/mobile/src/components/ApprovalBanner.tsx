import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useMemo, useState } from 'react';

import type { PendingApproval } from '../api/types';
import { useAppTheme, type AppTheme } from '../theme';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
} from '../accessibility';

interface ApprovalBannerProps {
  approval: PendingApproval;
  onResolve: (id: string, optionId: string) => Promise<void>;
}

export function ApprovalBanner({ approval, onResolve }: ApprovalBannerProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [resolving, setResolving] = useState<string | null>(null);

  const handleResolve = async (optionId: string) => {
    try {
      await runApprovalResolution(approval.requestId, optionId, onResolve, setResolving);
    } catch {
      // The parent surfaces the resolution error; this card only restores retry controls.
    }
  };

  const label = approval.kind === 'commandExecution'
    ? approval.command ?? 'Run command'
    : 'File change';
  useAccessibilityAnnouncement(
    resolving ? `Resolving approval: ${resolving}` : `Approval requested. ${label}`
  );

  return (
    <Animated.View
      entering={FadeInDown.duration(250)}
      style={styles.container}
      accessibilityLiveRegion="assertive"
    >
      <View style={styles.header}>
        <Ionicons {...decorativeAccessibilityProps} name="shield-checkmark-outline" size={16} color={colors.accent} />
        <Text style={styles.title}>Approval requested</Text>
      </View>

      <Text style={styles.command} numberOfLines={3}>
        {label}
      </Text>

      {approval.reason ? (
        <Text style={styles.reason} numberOfLines={2}>{approval.reason}</Text>
      ) : null}

      <View style={styles.actions}>
        {approval.options.map((option) => {
          const destructive = option.kind?.toLowerCase().includes('reject') ?? false;
          return (
          <Pressable
            key={option.id}
            style={({ pressed }) => [
              styles.btn,
              destructive ? styles.denyBtn : styles.acceptBtn,
              pressed && styles.btnPressed,
            ]}
            onPress={() => void handleResolve(option.id)}
            disabled={resolving !== null}
            accessibilityRole="button"
            accessibilityLabel={option.label}
            accessibilityState={controlAccessibilityState({ disabled: resolving !== null, busy: resolving === option.id })}
          >
            {resolving === option.id ? (
              <ActivityIndicator size="small" color={destructive ? colors.error : colors.textPrimary} />
            ) : (
              <>
                <Ionicons {...decorativeAccessibilityProps} name={destructive ? 'close' : 'checkmark'} size={14} color={destructive ? colors.error : colors.textPrimary} />
                <Text style={[styles.btnText, { color: destructive ? colors.error : colors.textPrimary }]}>{option.label}</Text>
              </>
            )}
          </Pressable>
          );
        })}
      </View>
    </Animated.View>
  );
}

export async function runApprovalResolution(
  id: string,
  optionId: string,
  resolve: (id: string, optionId: string) => Promise<void>,
  setResolving: (value: string | null) => void
): Promise<void> {
  setResolving(optionId);
  try {
    await resolve(id, optionId);
  } finally {
    setResolving(null);
  }
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      marginHorizontal: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      backgroundColor: theme.colors.bgItem,
      borderWidth: 1,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.md,
      padding: theme.spacing.md,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
    },
    title: {
      ...theme.typography.headline,
      color: theme.colors.accent,
      fontSize: 13,
    },
    command: {
      ...theme.typography.mono,
      fontSize: 12,
      color: theme.colors.textPrimary,
      lineHeight: 18,
      backgroundColor: theme.colors.bgItem,
      borderRadius: theme.radius.sm,
      padding: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      overflow: 'hidden',
    },
    reason: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      marginBottom: theme.spacing.sm,
    },
    actions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: theme.spacing.sm,
    },
    btn: {
      flexGrow: 1,
      minWidth: 112,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
      paddingVertical: theme.spacing.sm,
      borderRadius: theme.radius.sm,
      borderWidth: 1,
    },
    btnPressed: {
      opacity: 0.7,
    },
    denyBtn: {
      borderColor: theme.colors.errorBorder,
      backgroundColor: theme.colors.errorBg,
    },
    acceptBtn: {
      borderColor: theme.colors.borderHighlight,
      backgroundColor: theme.colors.bgInput,
    },
    allowSimilarBtn: {
      flexBasis: '100%',
    },
    btnText: {
      fontSize: 13,
      fontWeight: '600',
    },
  });
