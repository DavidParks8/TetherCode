import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import type { BridgeProfile } from '../bridgeProfiles';
import { createBridgeProfileManagerStyles } from './bridge-profile-manager-styles';
import { useAppTheme } from '../theme';
import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useAccessibilityAnnouncement,
  useModalAccessibilityFocus,
} from '../accessibility';

interface BridgeProfileManagerSheetProps {
  visible: boolean;
  profiles: BridgeProfile[];
  activeProfileId?: string | null;
  onClose: () => void;
  onActivate?: (profileId: string) => void | Promise<void>;
  onRename?: (profileId: string, nextName: string) => void | Promise<void>;
  onDelete?: (profileId: string) => void | Promise<void>;
}

export function BridgeProfileManagerSheet({
  visible,
  profiles,
  activeProfileId = null,
  onClose,
  onActivate,
  onRename,
  onDelete,
}: BridgeProfileManagerSheetProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createBridgeProfileManagerStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDeleteProfileId, setPendingDeleteProfileId] = useState<string | null>(null);
  const [actionProfileId, setActionProfileId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const modalFocusRef = useModalAccessibilityFocus(visible);
  useAccessibilityAnnouncement(visible ? actionError : null);

  useEffect(() => {
    if (!visible) {
      setEditingProfileId(null);
      setRenameDraft('');
      setPendingDeleteProfileId(null);
      setActionProfileId(null);
      setActionError(null);
    }
  }, [visible]);

  const cardMaxHeight = Math.min(
    Math.max(420, Math.round(windowHeight * 0.76)),
    windowHeight - Math.max(insets.top + theme.spacing.xl, 72) - Math.max(insets.bottom + theme.spacing.xl, 72)
  );

  const beginRename = (profile: BridgeProfile) => {
    setActionError(null);
    setPendingDeleteProfileId(null);
    setEditingProfileId(profile.id);
    setRenameDraft(profile.name);
  };

  const cancelInlineState = () => {
    setEditingProfileId(null);
    setRenameDraft('');
    setPendingDeleteProfileId(null);
    setActionError(null);
  };

  const activateProfile = async (profileId: string) => {
    if (!onActivate) {
      return;
    }
    setActionProfileId(profileId);
    setActionError(null);
    try {
      await onActivate(profileId);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionProfileId(null);
    }
  };

  const saveRename = async () => {
    if (!editingProfileId || !onRename) {
      return;
    }
    setActionProfileId(editingProfileId);
    setActionError(null);
    try {
      await onRename(editingProfileId, renameDraft.trim());
      setEditingProfileId(null);
      setRenameDraft('');
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionProfileId(null);
    }
  };

  const deleteProfile = async (profileId: string) => {
    if (!onDelete) {
      return;
    }
    setActionProfileId(profileId);
    setActionError(null);
    try {
      await onDelete(profileId);
      setPendingDeleteProfileId(null);
      setEditingProfileId((current) => (current === profileId ? null : current));
      setRenameDraft('');
      if (profiles.length <= 1) {
        onClose();
      }
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setActionProfileId(null);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      presentationStyle="overFullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close connection manager" />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.keyboardAvoider}
        >
          <SafeAreaView edges={['bottom']} style={styles.safeArea}>
            <View accessibilityViewIsModal importantForAccessibility="yes" style={[styles.sheetCard, { maxHeight: cardMaxHeight }]}>
              <View {...decorativeAccessibilityProps} style={styles.handle} />
              <View style={styles.header}>
                <Text style={styles.eyebrow}>Saved Connections</Text>
                <Text ref={modalFocusRef} accessibilityRole="header" style={styles.title}>Manage connections</Text>
                <Text style={styles.subtitle}>
                  Switch the active connection, rename it, or remove old entries.
                </Text>
              </View>

              {actionError ? (
                <View accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorBanner}>
                  <Ionicons {...decorativeAccessibilityProps} name="alert-circle-outline" size={16} color={theme.colors.error} />
                  <Text selectable style={styles.errorBannerText}>
                    {actionError}
                  </Text>
                </View>
              ) : null}

              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listContent}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {profiles.length > 0 ? (
                  profiles.map((profile) => {
                    const isActive = profile.id === activeProfileId;
                    const isEditing = profile.id === editingProfileId;
                    const isPendingDelete = profile.id === pendingDeleteProfileId;
                    const isBusy = profile.id === actionProfileId;

                    return (
                      <View
                        key={profile.id}
                        style={[styles.profileRow, isActive && styles.profileRowActive]}
                        accessible
                        accessibilityLabel={`${profile.name}. ${profile.bridgeUrl}. ${isActive ? 'Active connection' : 'Saved connection'}`}
                      >
                        <View style={styles.profileHeader}>
                          <View style={styles.profileCopy}>
                            <View style={styles.profileTitleRow}>
                              <Text style={styles.profileTitle} numberOfLines={1}>
                                {profile.name}
                              </Text>
                              {isActive ? (
                                <View style={styles.activeBadge}>
                                  <Text style={styles.activeBadgeText}>Active</Text>
                                </View>
                              ) : null}
                            </View>
                            <View style={styles.profileMetaRow}>
                              <View style={styles.metaBadge}>
                                <Text style={styles.metaBadgeText}>Private connection</Text>
                              </View>
                            </View>
                            <Text selectable style={styles.profileUrl} numberOfLines={2}>
                              {profile.bridgeUrl}
                            </Text>
                          </View>

                          {isBusy ? (
                            <View style={styles.activateButton} accessibilityRole="progressbar" accessibilityLabel={`Updating ${profile.name}`}>
                              <ActivityIndicator size="small" color={theme.colors.textPrimary} />
                            </View>
                          ) : isActive ? (
                            <View style={styles.activeState}>
                              <Ionicons
                                {...decorativeAccessibilityProps}
                                name="checkmark-circle-outline"
                                size={18}
                                color={theme.colors.statusComplete}
                              />
                            </View>
                          ) : (
                            <Pressable
                              onPress={() => {
                                void activateProfile(profile.id);
                              }}
                              style={({ pressed }) => [
                                styles.activateButton,
                                pressed && styles.activateButtonPressed,
                              ]}
                              accessibilityRole="button"
                              accessibilityLabel={`Use ${profile.name}`}
                            >
                              <Text style={styles.activateButtonText}>Use</Text>
                            </Pressable>
                          )}
                        </View>

                        {!isEditing && !isPendingDelete ? (
                          <View style={styles.profileToolsRow}>
                            <Pressable
                              onPress={() => beginRename(profile)}
                              style={({ pressed }) => [
                                styles.toolButton,
                                pressed && styles.toolButtonPressed,
                              ]}
                              accessibilityRole="button"
                              accessibilityLabel={`Rename ${profile.name}`}
                            >
                              <Ionicons
                                {...decorativeAccessibilityProps}
                                name="create-outline"
                                size={14}
                                color={theme.colors.textPrimary}
                              />
                              <Text style={styles.toolButtonText}>Rename</Text>
                            </Pressable>
                            <Pressable
                              onPress={() => {
                                setActionError(null);
                                setEditingProfileId(null);
                                setPendingDeleteProfileId(profile.id);
                              }}
                              style={({ pressed }) => [
                                styles.toolButton,
                                styles.toolButtonDanger,
                                pressed && styles.toolButtonDangerPressed,
                              ]}
                              accessibilityRole="button"
                              accessibilityLabel={`Delete ${profile.name}`}
                            >
                              <Ionicons {...decorativeAccessibilityProps} name="trash-outline" size={14} color={theme.colors.error} />
                              <Text style={styles.toolButtonDangerText}>Delete</Text>
                            </Pressable>
                          </View>
                        ) : null}

                        {isEditing ? (
                          <View style={styles.inlineEditor}>
                            <Text style={styles.inlineLabel}>Profile name</Text>
                            <TextInput
                              value={renameDraft}
                              onChangeText={setRenameDraft}
                              placeholder="Name this connection"
                              placeholderTextColor={theme.colors.textMuted}
                              autoFocus
                              returnKeyType="done"
                              onSubmitEditing={() => {
                                void saveRename();
                              }}
                              style={styles.inlineInput}
                              accessibilityLabel="Connection name"
                            />
                            <View style={styles.inlineActions}>
                              <Pressable
                                onPress={cancelInlineState}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.inlineButtonSecondary,
                                  pressed && styles.inlineButtonPressed,
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel="Cancel rename"
                              >
                                <Text style={styles.inlineButtonSecondaryText}>Cancel</Text>
                              </Pressable>
                              <Pressable
                                onPress={() => {
                                  void saveRename();
                                }}
                                disabled={!renameDraft.trim() || isBusy}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.inlineButtonPrimary,
                                  pressed && !isBusy && styles.inlineButtonPrimaryPressed,
                                  (!renameDraft.trim() || isBusy) && styles.inlineButtonDisabled,
                                ]}
                                accessibilityRole="button"
                                accessibilityState={controlAccessibilityState({ disabled: !renameDraft.trim() || isBusy, busy: isBusy })}
                              >
                                <Text style={styles.inlineButtonPrimaryText}>Save name</Text>
                              </Pressable>
                            </View>
                          </View>
                        ) : null}

                        {isPendingDelete ? (
                          <View style={styles.deleteConfirm} accessibilityLiveRegion="assertive">
                            <Text style={styles.deleteConfirmTitle}>Delete this profile?</Text>
                            <Text style={styles.deleteConfirmBody}>
                              This removes the saved connection from the device. If it is active,
                              TetherCode will switch to another saved connection or return to
                              onboarding.
                            </Text>
                            <View style={styles.inlineActions}>
                              <Pressable
                                onPress={cancelInlineState}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.inlineButtonSecondary,
                                  pressed && styles.inlineButtonPressed,
                                ]}
                                accessibilityRole="button"
                              >
                                <Text style={styles.inlineButtonSecondaryText}>Keep profile</Text>
                              </Pressable>
                              <Pressable
                                onPress={() => {
                                  void deleteProfile(profile.id);
                                }}
                                disabled={isBusy}
                                style={({ pressed }) => [
                                  styles.inlineButton,
                                  styles.deleteButton,
                                  pressed && !isBusy && styles.deleteButtonPressed,
                                  isBusy && styles.inlineButtonDisabled,
                                ]}
                                accessibilityRole="button"
                                accessibilityLabel={`Delete ${profile.name}`}
                                accessibilityState={controlAccessibilityState({ disabled: isBusy, busy: isBusy })}
                              >
                                <Text style={styles.deleteButtonText}>Delete</Text>
                              </Pressable>
                            </View>
                          </View>
                        ) : null}
                      </View>
                    );
                  })
                ) : (
                  <View style={styles.emptyState}>
                    <Text style={styles.emptyStateTitle}>No saved connections</Text>
                    <Text style={styles.emptyStateBody}>
                      Add a private connection to create one.
                    </Text>
                  </View>
                )}
              </ScrollView>

              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}
                accessibilityRole="button"
              >
                <Text style={styles.closeButtonText}>Done</Text>
              </Pressable>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
