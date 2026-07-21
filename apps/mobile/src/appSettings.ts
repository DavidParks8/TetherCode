import type {
  AgentDefaultSettingsMap,
  AgentId,
  ApprovalMode,
} from './api/types';
import { dedupeRecentPreviewTargets, normalizePreviewTargetInput } from './browserPreview';
import { normalizeBridgeUrlInput } from './bridgeUrl';
import {
  DEFAULT_FONT_PREFERENCE,
  normalizeFontPreference,
  type FontPreference,
} from './fonts';
import type { AppearancePreference, DarkUiPalette } from './theme';

export const APP_SETTINGS_VERSION = 13;
export const DEFAULT_WORKSPACE_CHAT_LIMIT = 5;
export const WORKSPACE_CHAT_LIMIT_OPTIONS = [5, 10, 25, null] as const;
export type WorkspaceChatLimit = (typeof WORKSPACE_CHAT_LIMIT_OPTIONS)[number];

export function parseAppSettings(raw: string): {
  bridgeUrl: string | null;
  bridgeToken: string | null;
  defaultStartCwd: string | null;
  preferredAgentId: AgentId | null;
  agentSettings: AgentDefaultSettingsMap;
  approvalMode: ApprovalMode;
  showToolCalls: boolean;
  appearancePreference: AppearancePreference;
  darkUiPalette: DarkUiPalette;
  fontPreference: FontPreference;
  workspaceChatLimit: WorkspaceChatLimit;
  recentBrowserTargetUrls: string[];
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      preferredAgentId: null,
      agentSettings: {},
      approvalMode: 'normal',
      showToolCalls: true,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
      recentBrowserTargetUrls: [],
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const parsedVersion = (parsed as { version?: unknown }).version;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsedVersion !== APP_SETTINGS_VERSION
    ) {
      return {
        bridgeUrl: null,
        bridgeToken: null,
        defaultStartCwd: null,
        preferredAgentId: null,
        agentSettings: {},
        approvalMode: 'normal',
        showToolCalls: true,
        appearancePreference: 'system',
        darkUiPalette: 'classic',
        fontPreference: DEFAULT_FONT_PREFERENCE,
        workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
        recentBrowserTargetUrls: [],
      };
    }

    return {
      bridgeUrl: normalizeBridgeUrl((parsed as { bridgeUrl?: unknown }).bridgeUrl),
      bridgeToken: normalizeBridgeToken((parsed as { bridgeToken?: unknown }).bridgeToken),
      defaultStartCwd: normalizeDefaultStartCwd(
        (parsed as { defaultStartCwd?: unknown }).defaultStartCwd
      ),
      preferredAgentId: normalizeAgentId(
        (parsed as { preferredAgentId?: unknown }).preferredAgentId
      ),
      agentSettings: normalizeAgentSettings(
        (parsed as { agentSettings?: unknown }).agentSettings
      ),
      approvalMode: normalizeStoredApprovalMode(
        (parsed as { approvalMode?: unknown }).approvalMode
      ),
      showToolCalls:
        typeof (parsed as { showToolCalls?: unknown }).showToolCalls === 'undefined'
          ? true
          : normalizeBoolean((parsed as { showToolCalls?: unknown }).showToolCalls),
      appearancePreference: normalizeStoredAppearancePreference(
        (parsed as { appearancePreference?: unknown }).appearancePreference,
        'system'
      ),
      darkUiPalette: normalizeStoredDarkUiPalette(
        (parsed as { darkUiPalette?: unknown }).darkUiPalette
      ),
      fontPreference: normalizeFontPreference(
        (parsed as { fontPreference?: unknown }).fontPreference
      ),
      workspaceChatLimit: normalizeWorkspaceChatLimit(
        (parsed as { workspaceChatLimit?: unknown }).workspaceChatLimit
      ),
      recentBrowserTargetUrls: normalizeBrowserTargetUrls(
        (parsed as { recentBrowserTargetUrls?: unknown }).recentBrowserTargetUrls
      ),
    };
  } catch {
    return {
      bridgeUrl: null,
      bridgeToken: null,
      defaultStartCwd: null,
      preferredAgentId: null,
      agentSettings: {},
      approvalMode: 'normal',
      showToolCalls: true,
      appearancePreference: 'system',
      darkUiPalette: 'classic',
      fontPreference: DEFAULT_FONT_PREFERENCE,
      workspaceChatLimit: DEFAULT_WORKSPACE_CHAT_LIMIT,
      recentBrowserTargetUrls: [],
    };
  }
}

export function formatWorkspaceChatLimit(value: WorkspaceChatLimit): string {
  return value === null ? 'All chats' : `${value} chats`;
}

function normalizeBridgeUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return normalizeBridgeUrlInput(value);
}

function normalizeBridgeToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDefaultStartCwd(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeWorkspaceChatLimit(value: unknown): WorkspaceChatLimit {
  if (value === null || value === 'all') {
    return null;
  }

  const numericValue =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value.trim(), 10)
        : Number.NaN;

  return numericValue === 10 || numericValue === 25
    ? numericValue
    : numericValue === 5
      ? 5
      : DEFAULT_WORKSPACE_CHAT_LIMIT;
}

function normalizeAgentId(value: unknown): AgentId | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeAgentSettings(value: unknown): AgentDefaultSettingsMap {
  const normalized: AgentDefaultSettingsMap = {};
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  if (!record) return normalized;
  for (const [rawAgentId, rawEntry] of Object.entries(record)) {
    const agentId = normalizeAgentId(rawAgentId);
    const entry = rawEntry && typeof rawEntry === 'object'
      ? (rawEntry as Record<string, unknown>)
      : null;
    if (!agentId || !entry) {
      continue;
    }
    normalized[agentId] = {
      collaborationMode: normalizeCollaborationMode(entry.collaborationMode),
    };
  }
  return normalized;
}

function normalizeCollaborationMode(value: unknown): 'default' | 'plan' {
  if (typeof value !== 'string') {
    return 'default';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'plan') {
    return normalized;
  }
  return 'default';
}

function normalizeBrowserTargetUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeRecentPreviewTargets(
    value
      .map((entry) => (typeof entry === 'string' ? normalizePreviewTargetInput(entry) : null))
      .filter((entry): entry is string => typeof entry === 'string')
  );
}

function normalizeStoredApprovalMode(value: unknown): ApprovalMode {
  return value === 'yolo' ? 'yolo' : 'normal';
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}

function normalizeStoredDarkUiPalette(value: unknown): DarkUiPalette {
  return value === 'grey' ? 'grey' : 'classic';
}

function normalizeStoredAppearancePreference(
  value: unknown,
  fallback: AppearancePreference
): AppearancePreference {
  return value === 'light' || value === 'dark' || value === 'system'
    ? value
    : fallback;
}
