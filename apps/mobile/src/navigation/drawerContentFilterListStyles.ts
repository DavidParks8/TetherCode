import { StyleSheet } from 'react-native';
import type { AppTheme } from '../theme';
import { DRAWER_ROW_RADIUS, DRAWER_WORKSPACE_ROW_HEIGHT } from './drawerContentStyleConstants';

export function createDrawerContentFilterListStyles(theme: AppTheme) {
  return StyleSheet.create({
  sectionCountBadge: {
    minWidth: 24,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionCountText: {
    ...theme.typography.caption,
    color: theme.colors.textSecondary,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  filterMenuAnchor: {
    position: 'relative',
  },
  filterTriggerButton: {
    width: 30,
    height: 30,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterTriggerButtonOpen: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  filterTriggerButtonActive: {
    borderColor: theme.colors.borderHighlight,
  },
  filterTriggerButtonPressed: {
    opacity: 0.9,
  },
  filterPanel: {
    marginHorizontal: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    padding: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  filterChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  filterChip: {
    minHeight: 34,
    paddingHorizontal: theme.spacing.md,
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  filterChipSelected: {
    borderColor: theme.colors.borderHighlight,
    backgroundColor: theme.colors.bgInput,
  },
  filterChipPressed: {
    opacity: 0.9,
  },
  filterChipText: {
    ...theme.typography.body,
    color: theme.colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  filterChipTextSelected: {
    color: theme.colors.textPrimary,
  },
  searchField: {
    minHeight: 40,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgInput,
    paddingLeft: theme.spacing.md,
    paddingRight: theme.spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  searchInput: {
    flex: 1,
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    paddingVertical: 0,
    fontSize: 14,
  },
  searchClearButton: {
    width: 28,
    height: 28,
    borderRadius: theme.radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearButtonPressed: {
    backgroundColor: theme.colors.bgItem,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: theme.spacing.lg,
  },
  loader: {
    marginBottom: theme.spacing.xs,
  },
  loadingMoreFooter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: theme.spacing.xs,
    paddingBottom: theme.spacing.lg,
  },
  emptyStateCard: {
    marginHorizontal: theme.spacing.md,
    marginTop: theme.spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgItem,
    padding: theme.spacing.md,
    alignItems: 'center',
    gap: theme.spacing.xs + 2,
  },
  emptyStateIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.bgInput,
  },
  emptyTitle: {
    ...theme.typography.body,
    color: theme.colors.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  emptyHint: {
    ...theme.typography.caption,
    color: theme.colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
  },
  workspaceGroupHeader: {
    minHeight: DRAWER_WORKSPACE_ROW_HEIGHT,
    marginHorizontal: theme.spacing.md,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 8,
    borderRadius: DRAWER_ROW_RADIUS,
    borderWidth: 1,
    borderColor: theme.colors.borderLight,
    backgroundColor: theme.colors.bgElevated,
    justifyContent: 'center',
  },
  workspaceGroupHeaderExpanded: {
    marginTop: 4,
    marginBottom: 5,
  },
  });
}
