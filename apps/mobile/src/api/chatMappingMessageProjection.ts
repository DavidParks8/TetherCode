import {
  COMPACTION_ACTIVITY_TYPE,
  createActivityMessage,
  SUBAGENT_ACTIVITY_TYPE,
} from "./messages";
import {
  generateLocalId,
  isChatMessagePart,
  parseSnapshotTaskSubagent,
  stringifyStructuredMessageContent,
} from "./chatMappingPlanParsing";
import {
  normalizeType,
  toSubAgentMeta,
} from "./chatMappingToolArgumentParsers";
import { renderAgUiCustomContent } from "./agUi";
import { toToolLikeMessage } from "./chatMappingToolMessageProjection";
import { type ChatMessage } from "./types";
import {
  type RawAcpSnapshot,
  type RawThread,
  readString,
  toRecord,
} from "./chatMappingRawTypesAndReaders";

export function mapMessages(
  raw: RawThread,
  fallbackCreatedAt: string,
): ChatMessage[] {
  if (raw.acpSnapshot) {
    const baseTs = new Date(fallbackCreatedAt).getTime();
    const messagesById = new Map(
      raw.acpSnapshot.messages.map((message) => [message.id, message]),
    );
    const toolsById = new Map(
      raw.acpSnapshot.tools.map((tool) => [tool.id, tool]),
    );
    const timeline = raw.acpSnapshot.timeline ?? [
      ...raw.acpSnapshot.messages.map((message, sequence) => ({
        sequence,
        kind:
          message.role === "thought"
            ? ("reasoning" as const)
            : ("message" as const),
        canonicalId: message.id,
      })),
      ...raw.acpSnapshot.tools.map((tool, index) => ({
        sequence: raw.acpSnapshot!.messages.length + index,
        kind: "tool" as const,
        canonicalId: tool.id,
      })),
    ];
    const mapped = [...timeline]
      .sort((left, right) => left.sequence - right.sequence)
      .flatMap<ChatMessage>((entry, index) => {
        if (entry.kind === "tool") {
          const tool = toolsById.get(entry.canonicalId);
          if (!tool) return [];
          const taskSubagent = parseSnapshotTaskSubagent(
            tool.content,
            raw.acpSnapshot?.session.agentId,
          );
          if (taskSubagent || isSnapshotSubagentTool(tool)) {
            const state =
              taskSubagent?.state ??
              (["failed", "error"].includes(tool.status.toLowerCase())
                ? "failed"
                : ["completed", "complete", "succeeded"].includes(
                      tool.status.toLowerCase(),
                    )
                  ? "completed"
                  : "running");
            const text = [
              state === "completed"
                ? "• Sub-agent completed"
                : state === "failed"
                  ? "• Sub-agent failed"
                  : "• Sub-agent working",
              taskSubagent?.threadId
                ? `  Thread: ${taskSubagent.threadId}`
                : null,
              `  Status: ${state}`,
              taskSubagent?.result ? `  Latest: ${taskSubagent.result}` : null,
            ]
              .filter(Boolean)
              .join("\n");
            return [
              createActivityMessage(
                `subagent:${tool.id}`,
                SUBAGENT_ACTIVITY_TYPE,
                {
                  text,
                  subAgent: {
                    toolCallId: tool.id,
                    tool: "spawnAgent",
                    senderThreadId: raw.id,
                    receiverThreadIds: taskSubagent?.threadId
                      ? [taskSubagent.threadId]
                      : [],
                    agentStatus: state,
                    navigable: Boolean(taskSubagent?.threadId),
                  },
                },
                new Date(baseTs + index * 1000).toISOString(),
              ),
            ];
          }
          const structured = renderAgUiCustomContent({
            content: tool.structuredContent,
            locations: tool.locations,
          });
          const details = [tool.title || tool.kind, tool.content, structured]
            .filter(Boolean)
            .join("\n");
          return [
            {
              id: `tool:${tool.id}`,
              role: "tool" as const,
              toolCallId: tool.id,
              content: `${details || tool.id}${tool.truncated ? "\n[tool content truncated]" : ""}`,
              createdAt: new Date(baseTs + index * 1000).toISOString(),
            },
          ];
        }
        const message = messagesById.get(entry.canonicalId);
        if (!message) return [];
        const parts = message.parts.filter(isChatMessagePart);
        const content = parts
          .map((part) => renderAgUiCustomContent(part))
          .filter(Boolean)
          .join("\n");
        if (!content) {
          return [];
        }
        const common = {
          id: message.id,
          content: `${content}${message.truncated ? "\n[message content truncated]" : ""}`,
          parts,
          createdAt: new Date(baseTs + index * 1000).toISOString(),
        };
        return [
          message.role === "agent"
            ? { ...common, role: "assistant" as const }
            : message.role === "user"
              ? { ...common, role: "user" as const }
              : { ...common, role: "reasoning" as const },
        ];
      });
    const collections = [
      ["messages", raw.acpSnapshot.messageCollection],
      ["reasoning", raw.acpSnapshot.reasoningCollection],
      ["tools", raw.acpSnapshot.toolCollection],
    ] as const;
    const truncated = collections
      .filter(([, collection]) => collection?.truncated)
      .map(
        ([name, collection]) =>
          `${name}: ${String(collection?.omittedCount ?? 0)} omitted`,
      );
    if ((raw.acpSnapshot.continuation?.unavailableCount ?? 0) > 0) {
      truncated.push(
        `older history unavailable: ${String(raw.acpSnapshot.continuation?.unavailableCount)}`,
      );
    }
    if (truncated.length > 0) {
      mapped.unshift({
        id: `${raw.id ?? "thread"}::snapshot-truncated`,
        role: "system",
        content: `Snapshot truncated (${truncated.join(", ")})`,
        createdAt: new Date(baseTs - 1).toISOString(),
      });
    }
    return mapped;
  }
  const turns = Array.isArray(raw.turns) ? raw.turns : [];
  if (turns.length === 0) {
    return [];
  }
  const baseTs = new Date(fallbackCreatedAt).getTime();
  const messages: ChatMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const item of items) {
      const itemRecord = toRecord(item);
      if (!itemRecord) {
        continue;
      }
      const itemType = readString(itemRecord.type);
      const normalizedItemType = normalizeType(itemType ?? "");
      if (normalizedItemType === "usermessage") {
        const text = stringifyStructuredMessageContent(itemRecord);
        if (!text.trim()) {
          continue;
        }
        messages.push({
          id: readString(itemRecord.id) ?? generateLocalId(),
          role: "user",
          content: text,
          createdAt: new Date(baseTs + messages.length * 1000).toISOString(),
        });
        continue;
      }
      if (normalizedItemType === "agentmessage") {
        const text =
          stringifyStructuredMessageContent(itemRecord) ||
          readString(itemRecord.text) ||
          "";
        if (!text.trim()) {
          continue;
        }
        messages.push({
          id: readString(itemRecord.id) ?? generateLocalId(),
          role: "assistant",
          content: text,
          createdAt: new Date(baseTs + messages.length * 1000).toISOString(),
        });
        continue;
      }
      const toolLikeMessage = toToolLikeMessage(itemRecord);
      if (toolLikeMessage) {
        const id = readString(itemRecord.id) ?? generateLocalId();
        const createdAt = new Date(
          baseTs + messages.length * 1000,
        ).toISOString();
        if (normalizedItemType === "reasoning") {
          messages.push({
            id,
            role: "reasoning",
            content: toolLikeMessage,
            createdAt,
          });
        } else if (normalizedItemType === "collabtoolcall") {
          messages.push(
            createActivityMessage(
              id,
              SUBAGENT_ACTIVITY_TYPE,
              { text: toolLikeMessage, subAgent: toSubAgentMeta(itemRecord) },
              createdAt,
            ),
          );
        } else if (normalizedItemType === "contextcompaction") {
          messages.push(
            createActivityMessage(
              id,
              COMPACTION_ACTIVITY_TYPE,
              { text: toolLikeMessage },
              createdAt,
            ),
          );
        } else {
          messages.push({
            id,
            role: "tool",
            toolCallId:
              readString(itemRecord.callId) ??
              readString(itemRecord.call_id) ??
              id,
            content: toolLikeMessage,
            createdAt,
          });
        }
      }
    }
  }
  return messages;
}

export function isSnapshotSubagentTool(
  tool: RawAcpSnapshot["tools"][number],
): boolean {
  const title = tool.title.trim().toLowerCase().replace(/[-_ ]/g, "");
  return title === "task" || title === "spawnagent" || title === "subagent";
}
