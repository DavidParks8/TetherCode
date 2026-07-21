import { Ionicons } from '@expo/vector-icons';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { HostBridgeApiClient } from '../api/client';
import type { AgentDescriptor, ApprovalMode, BridgeCapabilities } from '../api/types';
import type { HostBridgeWsClient } from '../api/ws';
import type { AppStatePersistenceError, AppStateStore, PushSettingsState } from '../appState';
import type { BridgeProfile } from '../bridgeProfiles';
import { AgentIcon } from '../components/AgentIcon';
import { DEFAULT_WORKSPACE_CHAT_LIMIT, type WorkspaceChatLimit } from '../appSettings';
import { disablePush, enablePush, updatePushEvents } from '../pushController';
import { DEFAULT_FONT_PREFERENCE, type FontPreference } from '../fonts';
import { useAppTheme, type AppearancePreference, type DarkUiPalette } from '../theme';

interface SettingsScreenProps {
  api: HostBridgeApiClient;
  ws: HostBridgeWsClient;
  activeBridgeProfileId?: string | null;
  appStateStore: AppStateStore;
  pushSettings: PushSettingsState;
  bridgeProfileName: string;
  bridgeProfiles: BridgeProfile[];
  approvalMode?: ApprovalMode;
  showToolCalls?: boolean;
  workspaceChatLimit?: WorkspaceChatLimit;
  appearancePreference?: AppearancePreference;
  darkUiPalette?: DarkUiPalette;
  fontPreference?: FontPreference;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  onShowToolCallsChange?: (value: boolean) => void;
  onWorkspaceChatLimitChange?: (limit: WorkspaceChatLimit) => void;
  onAppearancePreferenceChange?: (preference: AppearancePreference) => void;
  onDarkUiPaletteChange?: (palette: DarkUiPalette) => void;
  onFontPreferenceChange?: (preference: FontPreference) => void;
  onEditBridgeProfile?: () => void;
  onAddBridgeProfile?: () => void;
  onSwitchBridgeProfile?: (profileId: string) => void | Promise<void>;
  onRenameBridgeProfile?: (profileId: string, nextName: string) => void | Promise<void>;
  onDeleteBridgeProfile?: (profileId: string) => void | Promise<void>;
  onClearSavedBridges?: () => void | Promise<void>;
  persistenceError?: AppStatePersistenceError | null;
  onRetryPersistence?: () => void | Promise<void>;
  onOpenDrawer: () => void;
  onDrawerGestureEnabledChange?: (enabled: boolean) => void;
  onOpenPrivacy: () => void;
  onOpenTerms: () => void;
}

export function SettingsScreen({
  api,
  ws,
  activeBridgeProfileId = null,
  appStateStore,
  pushSettings,
  bridgeProfileName,
  bridgeProfiles,
  approvalMode = 'normal',
  showToolCalls = true,
  workspaceChatLimit = DEFAULT_WORKSPACE_CHAT_LIMIT,
  appearancePreference = 'system',
  darkUiPalette = 'classic',
  fontPreference = DEFAULT_FONT_PREFERENCE,
  onApprovalModeChange,
  onShowToolCallsChange,
  onWorkspaceChatLimitChange,
  onAppearancePreferenceChange,
  onDarkUiPaletteChange,
  onFontPreferenceChange,
  onEditBridgeProfile,
  onAddBridgeProfile,
  onSwitchBridgeProfile,
  onRenameBridgeProfile,
  onDeleteBridgeProfile,
  onClearSavedBridges,
  persistenceError,
  onRetryPersistence,
  onOpenDrawer,
  onDrawerGestureEnabledChange,
  onOpenPrivacy,
  onOpenTerms,
}: SettingsScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const [capabilities, setCapabilities] = useState<BridgeCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
  onDrawerGestureEnabledChange?.(true);
  let cancelled = false;
  setLoading(true);
    api.readBridgeCapabilities().then((value) => {
      if (!cancelled) setCapabilities(value);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not read bridge capabilities.');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [api, onDrawerGestureEnabledChange]);

  const updatePush = async (enabled: boolean) => {
    if (!activeBridgeProfileId || pushBusy) return;
    setPushBusy(true);
    setError(null);
    try {
      if (enabled) await enablePush(api, appStateStore, activeBridgeProfileId);
      else await disablePush(api, appStateStore, activeBridgeProfileId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update notifications.');
    } finally {
      setPushBusy(false);
    }
  };

  const updatePushEvent = async (key: 'turnCompleted' | 'approvalRequested', value: boolean) => {
    if (!activeBridgeProfileId) return;
    await updatePushEvents(api, appStateStore, activeBridgeProfileId, { ...pushSettings.events, [key]: value });
  };

  void appearancePreference;
  void darkUiPalette;
  void fontPreference;
  void onAppearancePreferenceChange;
  void onDarkUiPaletteChange;
  void onFontPreferenceChange;
  void onRenameBridgeProfile;
  void onDeleteBridgeProfile;
  void onClearSavedBridges;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable onPress={onOpenDrawer} accessibilityRole="button" accessibilityLabel="Open navigation drawer">
          <Ionicons name="menu" size={22} color={theme.colors.textPrimary} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
  {persistenceError ? <Notice text={persistenceError.message} action="Retry" onPress={onRetryPersistence} /> : null}
  {error ? <Notice text={error} /> : null}

  <Section title="Connection">
          <Row label={bridgeProfileName} value={ws.isConnected ? 'Connected' : 'Disconnected'} onPress={onEditBridgeProfile} />
          <Row label="Add bridge" onPress={onAddBridgeProfile} />
          {bridgeProfiles.map((profile) => (
            <Row key={profile.id} label={profile.name} value={profile.id === activeBridgeProfileId ? 'Active' : undefined} onPress={() => void onSwitchBridgeProfile?.(profile.id)} />
          ))}
        </Section>

        <Section title="Installed ACP agents">
          {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
          {!loading && (capabilities?.agents.length ?? 0) === 0 ? <Text style={styles.muted}>No agents reported by this bridge.</Text> : null}
          {capabilities?.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} capabilities={capabilities} />
          ))}
        </Section>

        <Section title="Chat">
          <Toggle label="Require approvals" value={approvalMode !== 'yolo'} onChange={(value) => onApprovalModeChange?.(value ? 'normal' : 'yolo')} />
          <Toggle label="Show tool calls" value={showToolCalls} onChange={(value) => onShowToolCallsChange?.(value)} />
          <Row label="Chats per workspace" value={workspaceChatLimit === null ? 'All' : String(workspaceChatLimit)} onPress={() => onWorkspaceChatLimitChange?.(workspaceChatLimit === 5 ? 10 : workspaceChatLimit === 10 ? 25 : workspaceChatLimit === 25 ? null : 5)} />
        </Section>

        <Section title="Notifications">
          <Toggle label="Push notifications" value={!pushSettings.optedOut} disabled={pushBusy} onChange={(value) => void updatePush(value)} />
          <Toggle label="Turn completed" value={pushSettings.events.turnCompleted} onChange={(value) => void updatePushEvent('turnCompleted', value)} />
          <Toggle label="Approval requested" value={pushSettings.events.approvalRequested} onChange={(value) => void updatePushEvent('approvalRequested', value)} />
        </Section>

        <Section title="Legal">
          <Row label="Privacy policy" onPress={onOpenPrivacy} />
          <Row label="Terms of service" onPress={onOpenTerms} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function AgentRow({ agent, capabilities }: { agent: AgentDescriptor; capabilities: BridgeCapabilities }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const statuses = [
    agent.agentId === capabilities.preferredAgentId ? 'Preferred' : null,
    agent.agentId === capabilities.activeAgentId ? 'Active' : null,
    agent.lifecycle,
  ].filter(Boolean).join(' · ');
  return (
    <View style={styles.agentRow}>
      <AgentIcon agent={agent} size={28} />
      <View style={styles.agentText}>
        <Text style={styles.rowLabel}>{agent.displayName}</Text>
        <Text style={styles.muted}>{statuses} · {agent.version} · {agent.provenance}</Text>
        {agent.lastError ? <Text style={styles.error}>Agent unavailable (details redacted)</Text> : null}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <Pressable disabled={!onPress} onPress={onPress} style={styles.row}><Text style={styles.rowLabel}>{label}</Text>{value ? <Text style={styles.muted}>{value}</Text> : null}</Pressable>;
}

function Toggle({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <View style={styles.row}><Text style={styles.rowLabel}>{label}</Text><Switch value={value} disabled={disabled} onValueChange={onChange} /></View>;
}

function Notice({ text, action, onPress }: { text: string; action?: string; onPress?: () => void | Promise<void> }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <View style={styles.notice}><Text style={styles.error}>{text}</Text>{action ? <Pressable onPress={() => void onPress?.()}><Text style={styles.action}>{action}</Text></Pressable> : null}</View>;
}

function createStyles(colors: ReturnType<typeof useAppTheme>['colors']) {
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.bgMain },
    header: { minHeight: 52, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 16 },
    title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
    content: { padding: 18, gap: 24, paddingBottom: 48 },
    section: { gap: 4 },
    sectionTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6 },
    row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    rowLabel: { color: colors.textPrimary, fontSize: 15, flexShrink: 1 },
    muted: { color: colors.textMuted, fontSize: 13 },
    error: { color: colors.error, fontSize: 13 },
    action: { color: colors.accent, fontWeight: '700' },
    notice: { padding: 12, borderWidth: 1, borderColor: colors.error, gap: 8 },
    agentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    agentText: { flex: 1, gap: 3 },
  });
}
