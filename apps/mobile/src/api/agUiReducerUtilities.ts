import { renderAgUiCustomContent } from "./agUiContent";
import { toolCall } from "./agUiStructuredAndTerminalReducers";
import { type ChatMessagePart } from "./types";
import { type ToolCall } from "@ag-ui/core";

export function upsertToolCall(
  calls: ToolCall[],
  id: string,
  name: string,
  args: string,
): ToolCall[] {
  const next = toolCall(id, name, args);
  const index = calls.findIndex((call) => call.id === id);
  return index >= 0
    ? calls.map((call, callIndex) => (callIndex === index ? next : call))
    : [...calls, next];
}

export function appendOrderedPart(
  parts: ChatMessagePart[],
  part: unknown,
): ChatMessagePart[] {
  const partRecord = record(part);
  const text =
    partRecord?.type === "text" && typeof partRecord.text === "string"
      ? partRecord.text
      : null;
  if (text === null || text.length === 0) {
    return text === null && isChatMessagePart(part) ? [...parts, part] : parts;
  }
  const previous = record(parts.at(-1));
  return previous?.type === "text" && typeof previous.text === "string"
    ? [...parts.slice(0, -1), { type: "text", text: `${previous.text}${text}` }]
    : [...parts, { type: "text", text }];
}

export function renderOrderedParts(parts: ChatMessagePart[]): string {
  return parts.map(renderAgUiCustomContent).filter(Boolean).join("\n");
}

export function isChatMessagePart(value: unknown): value is ChatMessagePart {
  const part = record(value);
  if (!part || typeof part.type !== "string") return false;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type === "image" || part.type === "audio") return true;
  if (part.type === "resourceLink") return typeof part.uri === "string";
  return part.type === "resource" && record(part.resource) !== null;
}

export function applyJsonPatch(value: unknown, operations: unknown[]): unknown {
  let next: unknown = cloneJson(value ?? {});
  for (const operation of operations) {
    const patch = record(operation);
    const op = nonEmptyString(patch?.op);
    const path = typeof patch?.path === "string" ? patch.path : null;
    if (!op || path === null) continue;
    const segments = path.split("/").slice(1).map(unescapePointer);
    if (segments.length === 0) {
      if (op === "replace" || op === "add") next = cloneJson(patch?.value);
      if (op === "remove") next = null;
      continue;
    }
    const parent = getPatchParent(next, segments.slice(0, -1));
    if (!parent) continue;
    const key = segments.at(-1)!;
    if (Array.isArray(parent)) {
      const index = key === "-" ? parent.length : Number.parseInt(key, 10);
      if (!Number.isFinite(index)) continue;
      if (op === "remove") parent.splice(index, 1);
      else if (op === "add") parent.splice(index, 0, cloneJson(patch?.value));
      else if (op === "replace") parent[index] = cloneJson(patch?.value);
    } else if (typeof parent === "object") {
      if (op === "remove") delete (parent as Record<string, unknown>)[key];
      else if (op === "add" || op === "replace")
        (parent as Record<string, unknown>)[key] = cloneJson(patch?.value);
    }
  }
  return next;
}

export function getPatchParent(root: unknown, segments: string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number.parseInt(segment, 10)];
    else if (current && typeof current === "object")
      current = (current as Record<string, unknown>)[segment];
    else return null;
  }
  return current;
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function unescapePointer(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function timestampIso(timestamp?: number): string {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date().toISOString();
}

export function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
