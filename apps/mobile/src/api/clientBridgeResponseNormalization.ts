import { normalizeCwd, readTimestampIso } from "./clientChatListInternals";
import { readString, toRecord } from "./chatMapping";
import {
  type ApprovalPolicy,
  type BrowserPreviewDiscoveryResponse,
  type BrowserPreviewSession,
  type FileSystemListResponse,
  type ReasoningEffort,
  type ServiceTier,
  type WorkspaceListResponse,
} from "./types";

export function readWorkspaceListResponse(
  value: unknown,
): WorkspaceListResponse {
  const record = toRecord(value) ?? {};
  const workspacesRaw = Array.isArray(record.workspaces)
    ? record.workspaces
    : [];
  return {
    bridgeRoot: normalizeCwd(readString(record.bridgeRoot)) ?? "",
    allowOutsideRootCwd: record.allowOutsideRootCwd === true,
    workspaces: workspacesRaw
      .map((entry) => {
        const workspace = toRecord(entry);
        if (!workspace) {
          return null;
        }
        const path = normalizeCwd(readString(workspace.path));
        if (!path) {
          return null;
        }
        const rawChatCount = workspace.chatCount;
        const chatCount =
          typeof rawChatCount === "number"
            ? Math.max(0, Math.trunc(rawChatCount))
            : typeof rawChatCount === "string"
              ? Math.max(0, Number.parseInt(rawChatCount, 10) || 0)
              : 0;
        const updatedAt = readTimestampIso(workspace.updatedAt);
        return { path, chatCount, ...(updatedAt ? { updatedAt } : {}) };
      })
      .filter(
        (entry): entry is WorkspaceListResponse["workspaces"][number] =>
          entry !== null,
      ),
  };
}

export function readFileSystemListResponse(
  value: unknown,
): FileSystemListResponse {
  const record = toRecord(value) ?? {};
  const entriesRaw = Array.isArray(record.entries) ? record.entries : [];
  return {
    bridgeRoot: normalizeCwd(readString(record.bridgeRoot)) ?? "",
    path: normalizeCwd(readString(record.path)) ?? "",
    parentPath: normalizeCwd(readString(record.parentPath)) ?? null,
    truncated: record.truncated === true,
    totalEntries: Math.max(
      0,
      Math.trunc(Number(record.totalEntries) || entriesRaw.length),
    ),
    omittedEntries: Math.max(0, Math.trunc(Number(record.omittedEntries) || 0)),
    maxEntries: Math.max(
      0,
      Math.trunc(Number(record.maxEntries) || entriesRaw.length),
    ),
    entries: entriesRaw
      .map((entry) => {
        const item = toRecord(entry);
        if (!item) {
          return null;
        }
        const path = normalizeCwd(readString(item.path));
        const name = normalizeCwd(readString(item.name));
        if (!path || !name) {
          return null;
        }
        return {
          name,
          path,
          kind: readString(item.kind) ?? "directory",
          hidden: item.hidden === true,
          selectable: item.selectable !== false,
          isGitRepo: item.isGitRepo === true,
        };
      })
      .filter(
        (entry): entry is FileSystemListResponse["entries"][number] =>
          entry !== null,
      ),
  };
}

export function readBrowserPreviewSession(
  value: unknown,
): BrowserPreviewSession | null {
  const record = toRecord(value);
  if (!record) {
    return null;
  }
  const sessionId = readString(record.sessionId)?.trim() ?? "";
  const targetUrl = readString(record.targetUrl)?.trim() ?? "";
  const bootstrapPath = readString(record.bootstrapPath)?.trim() ?? "";
  const previewBaseUrl = readString(record.previewBaseUrl)?.trim() || null;
  const previewPortRaw = record.previewPort;
  const previewPort =
    typeof previewPortRaw === "number"
      ? Math.max(1, Math.trunc(previewPortRaw))
      : typeof previewPortRaw === "string"
        ? Math.max(1, Number.parseInt(previewPortRaw, 10) || 0)
        : 0;
  const createdAt = readTimestampIso(record.createdAt);
  const lastAccessedAt = readTimestampIso(record.lastAccessedAt);
  const expiresAt = readTimestampIso(record.expiresAt);
  if (
    !sessionId ||
    !targetUrl ||
    !bootstrapPath ||
    previewPort <= 0 ||
    !createdAt ||
    !expiresAt
  ) {
    return null;
  }
  return {
    sessionId,
    targetUrl,
    previewPort,
    ...(previewBaseUrl ? { previewBaseUrl } : {}),
    bootstrapPath,
    createdAt,
    lastAccessedAt: lastAccessedAt ?? createdAt,
    expiresAt,
  };
}

export function readBrowserPreviewDiscoveryResponse(
  value: unknown,
): BrowserPreviewDiscoveryResponse {
  const record = toRecord(value) ?? {};
  const rawSuggestions = Array.isArray(record.suggestions)
    ? record.suggestions
    : [];
  return {
    scannedAt: readTimestampIso(record.scannedAt) ?? new Date(0).toISOString(),
    suggestions: rawSuggestions
      .map((entry) => {
        const item = toRecord(entry);
        if (!item) {
          return null;
        }
        const targetUrl = readString(item.targetUrl)?.trim() ?? "";
        const label = readString(item.label)?.trim() ?? "";
        const portRaw = item.port;
        const port =
          typeof portRaw === "number"
            ? Math.max(1, Math.trunc(portRaw))
            : typeof portRaw === "string"
              ? Math.max(1, Number.parseInt(portRaw, 10) || 0)
              : 0;
        if (!targetUrl || !label || port <= 0) {
          return null;
        }
        return { targetUrl, label, port };
      })
      .filter(
        (
          entry,
        ): entry is BrowserPreviewDiscoveryResponse["suggestions"][number] =>
          entry !== null,
      ),
  };
}

export function normalizeModel(
  model: string | null | undefined,
): string | null {
  if (typeof model !== "string") {
    return null;
  }
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeAcpMode(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const mode = value.trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(mode) ? mode : null;
}

export function readPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function normalizeEffort(
  effort: string | null | undefined,
): ReasoningEffort | null {
  if (typeof effort !== "string") {
    return null;
  }
  const normalized = effort.trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "minimal" ||
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "xhigh" ||
    normalized === "max"
  ) {
    return normalized;
  }
  return null;
}

export function normalizeServiceTier(
  serviceTier: ServiceTier | string | null | undefined,
): ServiceTier | null {
  if (typeof serviceTier !== "string") {
    return null;
  }
  const normalized = serviceTier.trim().toLowerCase();
  if (normalized === "flex" || normalized === "fast") {
    return normalized;
  }
  return null;
}

export function toThreadConfig(
  serviceTier: ServiceTier | null,
): Record<string, ServiceTier> | null {
  if (!serviceTier) {
    return null;
  }
  return { service_tier: serviceTier };
}

export function normalizeApprovalPolicy(
  policy: string | null | undefined,
): ApprovalPolicy | null {
  if (typeof policy !== "string") {
    return null;
  }
  const normalized = policy.trim().toLowerCase();
  if (
    normalized === "untrusted" ||
    normalized === "on-request" ||
    normalized === "on-failure" ||
    normalized === "never"
  ) {
    return normalized;
  }
  return null;
}

export function normalizeTurnStatus(status: string | null): string | null {
  if (!status) {
    return null;
  }
  const normalized = status.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}
