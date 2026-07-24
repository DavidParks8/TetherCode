import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';

export function createDrawerContentFilterListStyles(theme: AppTheme) {
  return StyleSheet.create({
    list: {
      flex: 1,
    },
    listContent: {
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.lg,
    },
    emptyListContent: {
      flexGrow: 1,
      paddingHorizontal: theme.spacing.md,
      paddingTop: theme.spacing.xs,
      paddingBottom: theme.spacing.lg,
    },
    loader: {
      marginBottom: theme.spacing.xs,
    },
    loadingMoreFooter: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: theme.spacing.lg,
    },
    emptyState: {
      flex: 1,
      paddingHorizontal: theme.spacing.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    emptyTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '600',
      textAlign: 'center',
    },
    emptyHint: {
      ...theme.typography.caption,
      maxWidth: 250,
      color: theme.colors.textMuted,
      fontSize: 11,
      lineHeight: 15,
      textAlign: 'center',
    },
    notice: {
      minHeight: 58,
      marginBottom: theme.spacing.sm,
      paddingVertical: theme.spacing.sm,
      paddingHorizontal: theme.spacing.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderLight,
    },
    noticePressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    noticeCopy: {
      flex: 1,
      minWidth: 0,
    },
    noticeTitle: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontSize: 11.5,
      lineHeight: 15,
      fontWeight: '600',
    },
    noticeMessage: {
      ...theme.typography.caption,
      marginTop: 2,
      color: theme.colors.textMuted,
      fontSize: 9.5,
      lineHeight: 13,
    },
    noticeAction: {
      ...theme.typography.caption,
      color: theme.colors.accent,
      fontSize: 10.5,
      lineHeight: 14,
      fontWeight: '600',
    },
    folderPickerRoot: {
      flex: 1,
      justifyContent: 'flex-end',
    },
    folderPickerBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: theme.colors.overlayBackdrop,
    },
    folderPickerSheet: {
      maxHeight: '72%',
      paddingTop: 6,
      paddingBottom: theme.spacing.lg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      borderWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: 0,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.bgElevated,
      boxShadow: theme.isDark
        ? '0 -10px 34px rgba(0, 0, 0, 0.34)'
        : '0 -10px 28px rgba(15, 31, 54, 0.16)',
    },
    folderPickerHeader: {
      minHeight: 48,
      paddingHorizontal: theme.spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    folderPickerTitle: {
      ...theme.typography.body,
      color: theme.colors.textPrimary,
      fontSize: 16,
      lineHeight: 20,
      fontWeight: '600',
    },
    folderPickerDone: {
      ...theme.typography.body,
      color: theme.colors.accent,
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '600',
    },
    folderPickerDoneButton: {
      minWidth: 44,
      height: 44,
      alignItems: 'flex-end',
      justifyContent: 'center',
    },
    folderPickerList: {
      paddingHorizontal: theme.spacing.lg,
    },
    folderPickerRow: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    folderPickerRowPressed: {
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    folderPickerRowCopy: {
      minWidth: 0,
      flex: 1,
    },
    folderPickerRowTitle: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
      fontSize: 13,
      lineHeight: 17,
      fontWeight: '600',
    },
    folderPickerRowSubtitle: {
      ...theme.typography.caption,
      marginTop: 2,
      color: theme.colors.textMuted,
      fontSize: 9.5,
      lineHeight: 12,
    },
    folderPickerRowCount: {
      ...theme.typography.caption,
      color: theme.colors.textMuted,
      fontSize: 10,
      lineHeight: 13,
      fontVariant: ['tabular-nums'],
    },
    folderPickerCheckPlaceholder: {
      width: 18,
      height: 18,
    },
  });
}
