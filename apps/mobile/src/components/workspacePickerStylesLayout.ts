import { StyleSheet } from 'react-native';

import type { AppTheme } from '../theme';

export const createWorkspacePickerLayoutStyles = (theme: AppTheme) => ({
  backdrop: {
    flex: 1,
    backgroundColor: theme.colors.overlayBackdrop,
  },
  outer: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'flex-end' as const,
  },
  outerLarge: {
    justifyContent: 'center' as const,
  },
  panel: {
    width: '100%' as const,
    minHeight: 0,
    overflow: 'hidden' as const,
    backgroundColor: theme.colors.bgElevated,
  },
  panelPhone: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderCurve: 'continuous' as const,
    boxShadow: theme.isDark
      ? '0 -12px 44px rgba(0, 0, 0, 0.46)'
      : '0 -10px 32px rgba(15, 23, 42, 0.16)',
  },
  panelLarge: {
    borderRadius: 28,
    borderCurve: 'continuous' as const,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    boxShadow: theme.isDark
      ? '0 24px 52px rgba(0, 0, 0, 0.42)'
      : '0 20px 46px rgba(15, 23, 42, 0.15)',
  },
  handle: {
    alignSelf: 'center' as const,
    width: 36,
    height: 5,
    marginTop: theme.spacing.sm,
    marginBottom: 3,
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.borderHighlight,
  },
  screen: {
    flex: 1,
    minHeight: 0,
  },
  homeToolbar: {
    minHeight: 45,
    paddingHorizontal: theme.spacing.md,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.borderLight,
  },
  toolbarButton: {
    minWidth: 68,
    minHeight: 44,
    justifyContent: 'center' as const,
  },
  toolbarButtonText: {
    ...theme.typography.body,
    color: theme.colors.accent,
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '500' as const,
  },
  toolbarSpacer: {
    width: 80,
    marginLeft: 'auto' as const,
  },
  homeScroll: {
    flex: 1,
  },
  homeContent: {
    paddingTop: theme.spacing.sm,
    paddingHorizontal: theme.spacing.lg,
  },
  largeTitle: {
    ...theme.typography.largeTitle,
    marginTop: theme.spacing.xs,
    marginBottom: theme.spacing.xl,
    color: theme.colors.textPrimary,
    fontSize: 28,
    lineHeight: 33,
    fontWeight: '700' as const,
    letterSpacing: -0.5,
  },
  section: {
    marginTop: theme.spacing.xl,
  },
  sectionTitle: {
    ...theme.typography.caption,
    marginHorizontal: theme.spacing.xs,
    marginBottom: 7,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '600' as const,
  },
  plainList: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderLight,
  },
  buttonDisabled: {
    opacity: 0.42,
  },
  pressed: {
    opacity: 0.62,
  },
  rowPressed: {
    backgroundColor: theme.colors.bgCanvasAccent,
  },
});
