import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppTheme, type AppTheme } from '../theme';

interface ToolBlockProps {
  command: string;
  status: 'running' | 'complete' | 'error';
  icon?: keyof typeof Ionicons.glyphMap;
}

export function ToolBlock({
  command,
  status,
  icon = 'terminal-outline',
}: ToolBlockProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const statusIcon: keyof typeof Ionicons.glyphMap | null =
    status === 'running'
      ? null
      : status === 'complete'
        ? 'checkmark'
        : 'close';

  const statusColor = status === 'running'
    ? colors.statusRunning
    : status === 'complete'
      ? colors.statusComplete
      : colors.statusError;
  const [contentWidth, setContentWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [offsetX, setOffsetX] = useState(0);
  const maxOffset = Math.max(0, contentWidth - viewportWidth);

  return (
    <View style={styles.container}>
      <Ionicons name={icon} size={14} color={colors.textSecondary} />
      <View style={styles.commandViewport}>
        <ScrollView
          horizontal
          bounces={false}
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
          onContentSizeChange={(width) => setContentWidth(width)}
          onScroll={(event) => setOffsetX(event.nativeEvent.contentOffset.x)}
        >
          <Text style={styles.command}>{command}</Text>
        </ScrollView>
        {offsetX > 1 ? (
          <LinearGradient
            pointerEvents="none"
            colors={[colors.toolBlockBg, colors.transparent]}
            style={[styles.commandFade, styles.commandFadeLeft]}
          />
        ) : null}
        {maxOffset > 1 && offsetX < maxOffset - 1 ? (
          <LinearGradient
            pointerEvents="none"
            colors={[colors.transparent, colors.toolBlockBg]}
            style={[styles.commandFade, styles.commandFadeRight]}
          />
        ) : null}
      </View>
      {status === 'running' ? (
        <ActivityIndicator size="small" color={statusColor} />
      ) : statusIcon ? (
        <Ionicons name={statusIcon} size={14} color={statusColor} />
      ) : null}
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      backgroundColor: theme.colors.toolBlockBg,
      borderLeftWidth: 2,
      borderLeftColor: theme.colors.toolBlockBorder,
      borderRadius: theme.radius.sm,
      marginVertical: theme.spacing.xs,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: theme.spacing.xs,
    },
    commandViewport: {
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
    },
    command: {
      ...theme.typography.mono,
      fontSize: 12,
      color: theme.colors.textPrimary,
      lineHeight: 18,
      paddingRight: theme.spacing.lg,
    },
    commandFade: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: 24,
    },
    commandFadeLeft: {
      left: 0,
    },
    commandFadeRight: {
      right: 0,
    },
  });
