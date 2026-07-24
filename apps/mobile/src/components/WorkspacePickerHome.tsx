import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import type { WorkspaceSummary } from '../api/types';
import { controlAccessibilityState, decorativeAccessibilityProps } from '../accessibility';
import type { AppTheme } from '../theme';
import { formatWorkspaceMeta, toPathBasename } from './workspacePickerHelpers';
import type { WorkspacePickerStyles } from './workspacePickerStyles';

interface Props {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  modalFocusRef: RefObject<Text | null>;
  bottomSafeInset: number;
  bridgeRoot: string | null;
  browseStartPath: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  onOpenBrowser: () => void;
  actionLabel: string | null;
  actionDescription: string | null;
  actionDisabled: boolean;
  onActionPress?: () => void;
  recentWorkspaces: WorkspaceSummary[];
  onClose: () => void;
}

export function WorkspacePickerHome(props: Props) {
  const { styles, theme } = props;
  return (
    <View style={styles.screen}>
      <View style={styles.homeToolbar}>
        <Pressable
          onPress={props.onClose}
          style={({ pressed }) => [styles.toolbarButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Cancel workspace selection"
        >
          <Text style={styles.toolbarButtonText}>Cancel</Text>
        </Pressable>
        <View style={styles.toolbarSpacer} />
      </View>

      <ScrollView
        style={styles.homeScroll}
        contentContainerStyle={[
          styles.homeContent,
          { paddingBottom: Math.max(props.bottomSafeInset, theme.spacing.xxl) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text
          ref={props.modalFocusRef}
          accessibilityRole="header"
          style={styles.largeTitle}
        >
          Choose Workspace
        </Text>

        {props.recentWorkspaces.length > 0 ? (
          <WorkspaceSection title="Recent" styles={styles}>
            {props.recentWorkspaces.map((workspace, index) => (
              <WorkspaceRow
                key={workspace.path}
                styles={styles}
                theme={theme}
                iconName="git-branch-outline"
                title={toPathBasename(workspace.path)}
                subtitle={workspace.path}
                meta={formatWorkspaceMeta(workspace)}
                pathSubtitle
                selected={workspace.path === props.selectedPath}
                last={index === props.recentWorkspaces.length - 1}
                onPress={() => props.onSelectPath(workspace.path)}
                accessibilityLabel={`Use ${toPathBasename(workspace.path)} workspace`}
              />
            ))}
          </WorkspaceSection>
        ) : null}

        <WorkspaceSection title="On this computer" styles={styles}>
          <WorkspaceRow
            styles={styles}
            theme={theme}
            iconName="desktop-outline"
            title="Browse folders"
            subtitle={props.browseStartPath ?? props.bridgeRoot ?? 'Connected computer folders'}
            pathSubtitle
            showsDisclosure
            onPress={props.onOpenBrowser}
            accessibilityLabel="Browse workspace folders"
          />
        </WorkspaceSection>

        {props.actionLabel && props.onActionPress ? (
          <WorkspaceSection title="Create" styles={styles}>
            <WorkspaceRow
              styles={styles}
              theme={theme}
              iconName="git-branch-outline"
              title={props.actionLabel}
              subtitle={
                props.actionDescription ??
                'Choose a destination and start a session'
              }
              disabled={props.actionDisabled}
              showsDisclosure
              onPress={props.onActionPress}
              accessibilityLabel={props.actionLabel}
              accessibilityHint={
                props.actionDescription ?? 'Opens the repository clone flow'
              }
            />
          </WorkspaceSection>
        ) : null}

        <WorkspaceSection title="Automatic" styles={styles}>
          <WorkspaceRow
            styles={styles}
            theme={theme}
            iconName="folder-outline"
            title="Bridge default"
            subtitle="Use the workspace configured on the connected computer"
            selected={props.selectedPath === null}
            onPress={() => props.onSelectPath(null)}
            accessibilityLabel="Use default workspace"
          />
        </WorkspaceSection>
      </ScrollView>
    </View>
  );
}

function WorkspaceSection({
  title,
  styles,
  children,
}: {
  title: string;
  styles: WorkspacePickerStyles;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.plainList}>{children}</View>
    </View>
  );
}

function WorkspaceRow({
  styles,
  theme,
  iconName,
  title,
  subtitle,
  meta,
  pathSubtitle = false,
  showsDisclosure = false,
  selected = false,
  last = true,
  disabled = false,
  onPress,
  accessibilityLabel,
  accessibilityHint,
}: {
  styles: WorkspacePickerStyles;
  theme: AppTheme;
  iconName: ComponentProps<typeof Ionicons>['name'];
  title: string;
  subtitle: string;
  meta?: string;
  pathSubtitle?: boolean;
  showsDisclosure?: boolean;
  selected?: boolean;
  last?: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.workspaceRow,
        last && styles.rowLast,
        pressed && !disabled && styles.rowPressed,
        disabled && styles.buttonDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={controlAccessibilityState({ disabled, selected })}
    >
      <View style={styles.rowIcon}>
        <Ionicons
          {...decorativeAccessibilityProps}
          name={iconName}
          size={21}
          color={theme.colors.textSecondary}
        />
      </View>
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text
          style={[styles.rowSubtitle, pathSubtitle && styles.rowPath]}
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {subtitle}
        </Text>
      </View>
      <View style={styles.rowAccessory}>
        {meta ? <Text style={styles.rowMeta}>{meta}</Text> : null}
        {selected ? (
          <Ionicons
            {...decorativeAccessibilityProps}
            name="checkmark"
            size={18}
            color={theme.colors.accent}
          />
        ) : showsDisclosure ? (
          <Ionicons
            {...decorativeAccessibilityProps}
            name="chevron-forward"
            size={16}
            color={theme.colors.textMuted}
          />
        ) : null}
      </View>
    </Pressable>
  );
}