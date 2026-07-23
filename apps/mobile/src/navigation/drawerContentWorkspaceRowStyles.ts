import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';
import { DRAWER_ACTION_HEIGHT, DRAWER_CHAT_ROW_HEIGHT, DRAWER_FOOTER_ACTION_HEIGHT, DRAWER_ICON_TILE_SIZE, DRAWER_ROW_RADIUS } from './drawerContentStyleConstants';

export function createDrawerContentWorkspaceRowStyles(theme: AppTheme) {
  const connectionDotConnected = theme.colors.success;
  return StyleSheet.create({
  workspaceGroupHeaderCollapsed: {
    marginTop: 4,
    marginBottom: 6,
  },
  workspaceGroupHeaderPinned: {
    borderColor: theme.colors.borderHighlight,
  },
  workspaceGroupHeaderPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  workspaceGroupHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  workspaceGroupTitleBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 2,
  },
  workspaceGroupPinIcon: {
    opacity: 0.75,
  },
  workspaceGroupIconTile: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  workspaceGroupIcon: {
    opacity: 0.82,
  },
  workspaceGroupLiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: connectionDotConnected,
    flexShrink: 0,
  },
  workspaceGroupTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 14,
    lineHeight: 17,
    fontWeight: '700',
  },
  workspaceGroupSubtitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    lineHeight: 13,
  },
  workspaceGroupCountBadge: {
    minWidth: 22,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workspaceGroupCountText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  workspaceGroupHeaderMeta: {
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  workspaceShowMoreRow: {
    marginLeft: theme.spacing.md,
    marginRight: theme.spacing.md,
    marginTop: theme.spacing.xs,
    marginBottom: 6,
    minHeight: DRAWER_ACTION_HEIGHT,
    borderRadius: DRAWER_ROW_RADIUS,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
    paddingVertical: 6,
  },
  workspaceShowMoreRowPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  workspaceShowMoreText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  chatItemFrame: {
    marginLeft: theme.spacing.md,
    marginRight: theme.spacing.md,
    marginBottom: 5,
  },
  chatItem: {
    minHeight: DRAWER_CHAT_ROW_HEIGHT,
    borderRadius: DRAWER_ROW_RADIUS - 1,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm + 1,
    paddingVertical: 6,
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
  },
  chatItemSubAgent: {
    backgroundColor: theme.colors.bgElevated,
  },
  chatItemLast: {
    marginBottom: 8,
  },
  chatItemSelected: {
    backgroundColor: theme.colors.bgInput,
    borderColor: theme.colors.borderHighlight,
    borderWidth: 1.5,
  },
  chatItemPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  chatItemAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 999,
    backgroundColor: theme.colors.bgCanvasAccent,
    opacity: 0.72,
  },
  chatItemAccentSubAgent: {
    backgroundColor: theme.colors.warningBorder,
  },
  chatItemAccentSelected: {
    width: 4,
    backgroundColor: theme.colors.textPrimary,
    opacity: 1,
  },
  chatItemAccentRunning: {
    backgroundColor: theme.colors.statusRunning,
    opacity: 1,
  },
  chatItemAccentError: {
    backgroundColor: theme.colors.statusError,
    opacity: 1,
  },
  chatItemContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chatItemTextBlock: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    gap: 3,
  },
  chatItemMeta: {
    minWidth: 28,
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 4,
    flexShrink: 0,
  },
  chatIconTile: {
    width: DRAWER_ICON_TILE_SIZE,
    height: DRAWER_ICON_TILE_SIZE,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  chatIconTileSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgItem,
  },
  chatIconTileRunning: {
    borderColor: theme.colors.borderHighlight,
  },
  chatIconTileError: {
    borderColor: theme.colors.statusError,
    backgroundColor: theme.colors.errorBg,
  },
  chatPinnedIcon: {
    flexShrink: 0,
    opacity: 0.72,
  },
  chatAgentIcon: {
    opacity: 0.92,
  },
  chatTitle: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '700',
  },
  chatTitleSubAgent: {
    color: theme.colors.textSecondary,
  },
  chatTitleSelected: {
    color: theme.colors.textPrimary,
    fontWeight: '700',
  },
  chatSubtitle: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 10,
    lineHeight: 13,
  },
  chatSubtitleSelected: {
    color: theme.colors.textSecondary,
  },
  chatAge: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 10,
    lineHeight: 12,
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  chatAgeSelected: {
    color: theme.colors.textPrimary,
  },
  footer: {
    marginTop: 'auto',
    paddingHorizontal: theme.spacing.md,
    paddingTop: theme.spacing.xs,
    paddingBottom: 0,
  },
  footerSettingsButton: {
    height: DRAWER_FOOTER_ACTION_HEIGHT,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.xs,
  },
  footerSettingsButtonPressed: {
    backgroundColor: theme.colors.bgInput,
  },
  footerSettingsText: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
  },
  });
}
