import type { AppTheme } from '../theme';
import { createDrawerContentShellStyles } from './drawerContentShellStyles';
import { createDrawerContentFilterListStyles } from './drawerContentFilterListStyles';
import { createDrawerContentWorkspaceRowStyles } from './drawerContentWorkspaceRowStyles';

export type DrawerContentStyles =
  & ReturnType<typeof createDrawerContentShellStyles>
  & ReturnType<typeof createDrawerContentFilterListStyles>
  & ReturnType<typeof createDrawerContentWorkspaceRowStyles>;

export function createDrawerContentStyles(theme: AppTheme): DrawerContentStyles {
  return {
    ...createDrawerContentShellStyles(theme),
    ...createDrawerContentFilterListStyles(theme),
    ...createDrawerContentWorkspaceRowStyles(theme),
  } as DrawerContentStyles;
}