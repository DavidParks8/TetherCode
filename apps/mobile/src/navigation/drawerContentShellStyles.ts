import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';

export function createDrawerContentShellStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.bgSidebar,
    },
    safeArea: {
      flex: 1,
    },
    mainContent: {
      flex: 1,
      minHeight: 0,
    },
    header: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
    },
    titleRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    titleCopy: {
      flex: 1,
      minWidth: 0,
    },
    title: {
      ...theme.typography.largeTitle,
      color: theme.colors.textPrimary,
      fontSize: 27,
      lineHeight: 31,
      fontWeight: '700',
      letterSpacing: -0.5,
    },
    subtitle: {
      ...theme.typography.caption,
      marginTop: 3,
      color: theme.colors.textMuted,
      fontSize: 11,
      lineHeight: 14,
    },
    headerIconButton: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerIconButtonPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    statusSummary: {
      minHeight: 30,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    statusSummaryAttention: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontSize: 10.5,
      lineHeight: 14,
      fontWeight: '600',
    },
    statusSummaryText: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 10.5,
      lineHeight: 14,
    },
    statusSummarySeparator: {
      width: 3,
      height: 3,
      borderRadius: 2,
      backgroundColor: theme.colors.borderHighlight,
    },
    folderFilter: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    folderFilterPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    folderFilterLabel: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 11,
      lineHeight: 14,
    },
    folderFilterValue: {
      ...theme.typography.body,
      flex: 1,
      minWidth: 0,
      color: theme.colors.accent,
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '600',
      textAlign: 'right',
    },
    footer: {
      minHeight: 56,
      paddingHorizontal: theme.spacing.md,
      paddingTop: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.borderLight,
    },
    connectionStatus: {
      minWidth: 0,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingLeft: theme.spacing.xs,
    },
    connectionDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    connectionDotConnected: {
      backgroundColor: theme.colors.success,
    },
    connectionDotDisconnected: {
      backgroundColor: theme.colors.warning,
    },
    connectionCopy: {
      minWidth: 0,
      flex: 1,
    },
    connectionTitle: {
      ...theme.typography.caption,
      color: theme.colors.textSecondary,
      fontSize: 10.5,
      lineHeight: 13,
      fontWeight: '600',
    },
    connectionMeta: {
      ...theme.typography.caption,
      marginTop: 2,
      color: theme.colors.textMuted,
      fontSize: 9,
      lineHeight: 11,
    },
    footerBrowserButton: {
      minWidth: 78,
      height: 44,
      paddingHorizontal: 7,
      borderRadius: theme.radius.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 5,
    },
    footerBrowserText: {
      ...theme.typography.caption,
      color: theme.colors.accent,
      fontSize: 10.5,
      lineHeight: 14,
      fontWeight: '600',
    },
    footerIconButton: {
      width: 44,
      height: 44,
      borderRadius: theme.radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    footerActionPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
  });
}
