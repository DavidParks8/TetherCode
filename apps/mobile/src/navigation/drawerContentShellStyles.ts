import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';
import { DRAWER_ACTION_HEIGHT } from './drawerContentStyleConstants';

export function createDrawerContentShellStyles(theme: AppTheme) {
  const connectionDotConnected = theme.colors.success;
  const connectionDotDisconnected = theme.colors.warning;
  const cardShadow = theme.isDark
    ? '0 10px 24px rgba(0, 0, 0, 0.22)'
    : '0 10px 20px rgba(15, 23, 42, 0.10)';
  const drawerPrimaryActionShadow = theme.isDark
    ? undefined
    : '0 10px 20px rgba(47, 57, 69, 0.12)';
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
    position: 'relative',
  },
  topDeck: {
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.sm,
    paddingBottom: theme.spacing.sm,
    gap: theme.spacing.xs + 2,
  },
  heroCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    paddingHorizontal: theme.spacing.sm + 2,
    paddingVertical: theme.spacing.sm,
    boxShadow: cardShadow,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  brandBadge: {
    width: 32,
    height: 32,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgItem,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
  },
  heroCopy: {
    flex: 1,
    gap: 2,
  },
  heroTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '700',
  },
  heroMeta: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 14,
  },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 999,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: theme.spacing.xs,
    borderWidth: 1,
  },
  connectionBadgeConnected: {
    backgroundColor: theme.colors.successBg,
    borderColor: theme.colors.successBorder,
  },
  connectionBadgeDisconnected: {
    backgroundColor: theme.colors.warningBg,
    borderColor: theme.colors.warningBorder,
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  connectionDotConnected: {
    backgroundColor: connectionDotConnected,
  },
  connectionDotDisconnected: {
    backgroundColor: connectionDotDisconnected,
  },
  connectionText: {
    ...theme.typography.caption,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0,
  },
  connectionTextConnected: {
    color: theme.colors.success,
  },
  connectionTextDisconnected: {
    color: theme.colors.warning,
  },
  secondaryActionButton: {
    flex: 1,
    height: DRAWER_ACTION_HEIGHT,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  secondaryActionButtonPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  secondaryActionText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  actionRow: {
    flexDirection: 'row',
    gap: theme.spacing.xs + 2,
  },
  primaryActionButton: {
    flex: 1,
    height: DRAWER_ACTION_HEIGHT,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    boxShadow: drawerPrimaryActionShadow,
  },
  primaryActionButtonPressed: {
    backgroundColor: theme.colors.accentPressed,
    borderColor: theme.colors.accentPressed,
  },
  primaryActionText: {
    ...theme.typography.body,
    color: theme.colors.accentText,
    fontWeight: '700',
    fontSize: 13,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
  },
  sectionHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    zIndex: 2,
  },
  sectionTitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0,
    fontWeight: '700',
  },
  });
}
