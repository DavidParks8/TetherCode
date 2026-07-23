export type RawThreadStatus = { type?: string } | string | null | undefined;

export interface RawTurn {
  id?: string;
  status?: string;
  error?: unknown;
  message?: unknown;
  errorMessage?: unknown;
  error_message?: unknown;
  detail?: unknown;
  details?: unknown;
  reason?: unknown;
  description?: unknown;
  stderr?: unknown;
  items?: RawThreadItem[];
}

export type RawThreadItem =
  | {
      type?: "userMessage";
      id?: string;
      content?: Array<{
        type?: string;
        text?: string;
        path?: string;
        url?: string;
      }>;
    }
  | {
      type?: "agentMessage";
      id?: string;
      text?: string;
      content?: Array<{
        type?: string;
        text?: string;
        path?: string;
        url?: string;
      }>;
    }
  | { type?: string; id?: string; text?: string };

export interface RawThread {
  id?: string;
  agentId?: unknown;
  name?: string;
  title?: string;
  preview?: string;
  modelProvider?: string;
  agentNickname?: string;
  agentRole?: string;
  createdAt?: number;
  updatedAt?: number;
  status?: RawThreadStatus;
  cwd?: string;
  source?: unknown;
  turns?: RawTurn[];
  acpSnapshot?: RawAcpSnapshot;
}

export interface RawAcpSnapshot {
  version: number;
  messages: Array<{
    id: string;
    role: string;
    parts: unknown[];
    truncated: boolean;
  }>;
  timeline?: Array<{
    sequence: number;
    kind: "message" | "reasoning" | "tool";
    canonicalId: string;
  }>;
  tools: Array<{
    id: string;
    generation?: number | null;
    kind: string;
    status: string;
    title: string;
    content: string;
    structuredContent: unknown[];
    locations: unknown[];
    truncated: boolean;
  }>;
  messageCollection?: RawSnapshotCollectionMetadata;
  reasoningCollection?: RawSnapshotCollectionMetadata;
  toolCollection?: RawSnapshotCollectionMetadata;
  continuation?: RawSnapshotContinuation;
  plan: Array<{ content: string; priority: string; status: string }>;
  usage: { used?: number | null; size?: number | null; cost?: string | null };
  mode?: string | null;
  config: Array<{
    id: string;
    value: string;
    name?: string;
    description?: string;
    category?: string;
    options?: Array<{ value: string; name: string; description?: string }>;
  }>;
  commands: Array<{ name: string; description: string }>;
  session: {
    agentId: string;
    threadId: string;
    title?: string | null;
    updatedAt?: string | null;
    historyReconstruction: boolean;
  };
  active: {
    runId?: string | null;
    sourceTurnId?: string | null;
    generation?: number | null;
    toolIds: string[];
  };
}

export interface RawSnapshotCollectionMetadata {
  truncated: boolean;
  omittedCount: number;
  oldestAvailableSequence?: number | null;
  newestSequence?: number | null;
  beforeCursor?: string | null;
  revision: number;
}

export interface RawSnapshotContinuation {
  revision: number;
  unavailableCount: number;
  earliestAvailableSequence?: number | null;
  latestAvailableSequence?: number | null;
  maxPageSize: number;
  maxHistoryEntries: number;
  maxHistoryBytes: number;
}

export interface ThreadSourceMetadata {
  kind?: string;
  parentThreadId?: string;
  subAgentDepth?: number;
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readString(entry)?.trim() ?? "")
    .filter((entry): entry is string => entry.length > 0);
}

export function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value.trim());
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

export function readFileChangePaths(item: Record<string, unknown>): string[] {
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const change of rawChanges) {
    const path =
      readString(change)?.trim() ??
      readString(toRecord(change)?.path)?.trim() ??
      readString(toRecord(change)?.filePath)?.trim() ??
      readString(toRecord(change)?.file_path)?.trim();
    if (!path) {
      continue;
    }
    const normalized = path.replace(/\\/g, "/");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

export function toPreview(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 180) {
    return collapsed;
  }
  return `${collapsed.slice(0, 177)}...`;
}

export function unixSecondsToIso(value: number): string {
  return new Date(value * 1000).toISOString();
}

export function readTimestampSeconds(value: unknown): number | null {
  const numeric = readNumber(value);
  if (numeric !== null && Number.isFinite(numeric) && numeric > 0) {
    return numeric > 1_000_000_000_000 ? numeric / 1000 : numeric;
  }
  const text = readString(value)?.trim();
  if (!text) {
    return null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed / 1000 : null;
}

export function normalizeLifecycleStatus(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return normalized.length > 0 ? normalized : null;
}
