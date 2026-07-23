import {
  normalizeInline,
  normalizeMultiline,
  normalizeType,
  parseMcpFunctionToolName,
  readFunctionCommand,
  readFunctionSearchQuery,
  readFunctionToolArguments,
  readFunctionToolInput,
  readPatchTargetPaths,
  readReceiverThreadIds,
  reasoningTextFromItem,
  toFileChangeTargetLabel,
  toNestedOutput,
} from "./chatMappingToolArgumentParsers";
import {
  readFileChangePaths,
  readNumber,
  readString,
  toRecord,
} from "./chatMappingRawTypesAndReaders";
import {
  toStructuredPreview,
  withNestedDetail,
} from "./chatMappingStructuredContentPreview";

export function toToolLikeMessage(
  item: Record<string, unknown>,
): string | null {
  const rawType = readString(item.type);
  if (!rawType) {
    return null;
  }
  const type = normalizeType(rawType);
  if (type === "plan") {
    const text = normalizeMultiline(readString(item.text), 1800);
    return text || null;
  }
  if (type === "reasoning") {
    const text = normalizeMultiline(reasoningTextFromItem(item), 2400);
    return withNestedDetail("• Reasoning", text);
  }
  if (type === "commandexecution") {
    const command = normalizeInline(readString(item.command), 240) ?? "command";
    const status = normalizeType(readString(item.status) ?? "");
    const output =
      normalizeMultiline(readString(item.aggregatedOutput), 2400) ??
      normalizeMultiline(readString(item.aggregated_output), 2400);
    const exitCode = readNumber(item.exitCode) ?? readNumber(item.exit_code);
    const title =
      status === "failed" || status === "error"
        ? `• Command failed \`${command}\``
        : `• Ran \`${command}\``;
    const outputPreview = output ? toNestedOutput(output, 8, 1600) : null;
    const detail =
      outputPreview ??
      (exitCode !== null ? `exit code ${String(exitCode)}` : null);
    return withNestedDetail(title, detail);
  }
  if (type === "mcptoolcall") {
    const server = normalizeInline(readString(item.server), 120);
    const tool = normalizeInline(readString(item.tool), 120);
    const label = [server, tool].filter(Boolean).join(" / ") || "MCP tool call";
    const status = normalizeType(readString(item.status) ?? "");
    const errorRecord = toRecord(item.error);
    const errorDetail =
      normalizeInline(readString(errorRecord?.message), 240) ??
      normalizeInline(readString(item.error), 240);
    const resultDetail = toStructuredPreview(item.result, 240);
    const detail =
      status === "failed" || status === "error"
        ? (errorDetail ?? resultDetail)
        : resultDetail;
    const title =
      status === "failed" || status === "error"
        ? `• Tool failed \`${label}\``
        : `• Called tool \`${label}\``;
    return withNestedDetail(title, detail);
  }
  if (type === "functioncall" || type === "customtoolcall") {
    return toFunctionToolLikeMessage(item);
  }
  if (type === "functioncalloutput" || type === "customtoolcalloutput") {
    const output =
      normalizeMultiline(readString(item.output), 2400) ??
      toStructuredPreview(item.output, 1200);
    if (!output) {
      return null;
    }
    const callId = normalizeInline(
      readString(item.call_id) ?? readString(item.callId),
      120,
    );
    const title = callId ? `• Tool output \`${callId}\`` : "• Tool output";
    return withNestedDetail(title, toNestedOutput(output, 8, 1600));
  }
  if (type === "collabtoolcall") {
    const tool = normalizeType(readString(item.tool) ?? "");
    const status = normalizeType(readString(item.status) ?? "");
    const prompt = normalizeInline(readString(item.prompt), 220);
    const receiverThreadIds = readReceiverThreadIds(item);
    const primaryReceiverThreadId = normalizeInline(receiverThreadIds[0], 120);
    const newThreadId = normalizeInline(
      readString(item.newThreadId) ??
        readString(item.new_thread_id) ??
        primaryReceiverThreadId,
      120,
    );
    const senderThreadId = normalizeInline(
      readString(item.senderThreadId) ?? readString(item.sender_thread_id),
      120,
    );
    const agentStatus = normalizeInline(
      readString(item.agentStatus) ?? readString(item.agent_status),
      120,
    );
    const title = (() => {
      if (tool === "spawnagent") {
        if (status === "failed" || status === "error") {
          return "• Sub-agent spawn failed";
        }
        if (
          status === "completed" ||
          status === "complete" ||
          status === "succeeded"
        ) {
          return "• Spawned sub-agent";
        }
        return "• Spawning sub-agent";
      }
      if (tool === "sendinput") {
        return status === "failed" || status === "error"
          ? "• Sub-agent update failed"
          : "• Sent follow-up to sub-agent";
      }
      if (tool === "wait") {
        return status === "failed" || status === "error"
          ? "• Waiting on sub-agent failed"
          : "• Waiting on sub-agent";
      }
      if (tool === "closeagent") {
        return status === "failed" || status === "error"
          ? "• Closing sub-agent failed"
          : "• Closed sub-agent thread";
      }
      return status === "failed" || status === "error"
        ? "• Sub-agent action failed"
        : "• Updated sub-agent thread";
    })();
    const detailParts = [
      prompt ? `Prompt: ${prompt}` : null,
      newThreadId ? `Thread: ${newThreadId}` : null,
      primaryReceiverThreadId ? `Target: ${primaryReceiverThreadId}` : null,
      senderThreadId ? `From: ${senderThreadId}` : null,
      agentStatus ? `Status: ${agentStatus}` : null,
    ].filter(Boolean);
    return withNestedDetail(title, detailParts.join("\n") || null);
  }
  if (type === "websearch") {
    const query = normalizeInline(readString(item.query), 180);
    const actionRecord = toRecord(item.action);
    const actionType = normalizeType(readString(actionRecord?.type) ?? "");
    let detail: string | null = query;
    if (actionType === "openpage") {
      detail = normalizeInline(readString(actionRecord?.url), 240) ?? detail;
    } else if (actionType === "findinpage") {
      const url = normalizeInline(readString(actionRecord?.url), 180);
      const pattern = normalizeInline(readString(actionRecord?.pattern), 120);
      detail =
        [url, pattern ? `pattern: ${pattern}` : null]
          .filter(Boolean)
          .join(" | ") || detail;
    }
    const title = query ? `• Searched web for "${query}"` : "• Searched web";
    return withNestedDetail(title, detail && detail !== query ? detail : null);
  }
  if (type === "filechange") {
    const status = normalizeType(readString(item.status) ?? "");
    const changedPaths = readFileChangePaths(item);
    const changeCount = changedPaths.length;
    const detail = changeCount > 0 ? changedPaths.join("\n") : null;
    const titleSuffix =
      changeCount === 0
        ? ""
        : changeCount === 1
          ? ` to ${toFileChangeTargetLabel(changedPaths[0])}`
          : ` to ${toFileChangeTargetLabel(changedPaths[0])} +${String(changeCount - 1)} more`;
    const title =
      status === "failed" || status === "error"
        ? `• File changes failed${titleSuffix}`
        : `• Applied file changes${titleSuffix}`;
    return withNestedDetail(title, detail);
  }
  if (type === "imageview") {
    const path = normalizeInline(readString(item.path), 220);
    if (!path) {
      return null;
    }
    return withNestedDetail(
      `• Viewed image ${toFileChangeTargetLabel(path)}`,
      path,
    );
  }
  if (type === "enteredreviewmode") {
    return "• Entered review mode";
  }
  if (type === "exitedreviewmode") {
    return "• Exited review mode";
  }
  if (type === "contextcompaction") {
    return "• Compacted conversation context";
  }
  return null;
}

export function toFunctionToolLikeMessage(
  item: Record<string, unknown>,
): string | null {
  const rawName =
    readString(item.name) ??
    readString(item.tool) ??
    readString(item.function) ??
    readString(item.function_name);
  const toolName = normalizeInline(rawName, 160) ?? "tool";
  const normalizedToolName = toolName.replace(/^functions\./, "");
  const status = normalizeType(readString(item.status) ?? "");
  const args = readFunctionToolArguments(item);
  const inputPreview = args
    ? toStructuredPreview(args, 900)
    : readFunctionToolInput(item);
  if (normalizedToolName === "exec_command") {
    const command =
      readFunctionCommand(args) ??
      normalizeInline(readFunctionToolInput(item), 240);
    const title =
      status === "failed" || status === "error"
        ? `• Command failed \`${command ?? "command"}\``
        : status === "running" || status === "inprogress"
          ? `• Running command \`${command ?? "command"}\``
          : `• Ran \`${command ?? "command"}\``;
    const workdir = normalizeInline(readString(args?.workdir), 220);
    return withNestedDetail(title, workdir ? `cwd: ${workdir}` : null);
  }
  const mcpToolName = parseMcpFunctionToolName(normalizedToolName);
  if (mcpToolName) {
    const title =
      status === "failed" || status === "error"
        ? `• Tool failed \`${mcpToolName.server} / ${mcpToolName.tool}\``
        : status === "running" || status === "inprogress"
          ? `• Calling tool \`${mcpToolName.server} / ${mcpToolName.tool}\``
          : `• Called tool \`${mcpToolName.server} / ${mcpToolName.tool}\``;
    return withNestedDetail(
      title,
      inputPreview ? `Input: ${inputPreview}` : null,
    );
  }
  if (
    normalizedToolName === "search_query" ||
    normalizedToolName === "image_query"
  ) {
    const query = normalizeInline(readFunctionSearchQuery(args), 180);
    const title = query ? `• Searched web for "${query}"` : "• Searched web";
    return withNestedDetail(title, null);
  }
  if (normalizedToolName === "apply_patch") {
    const patchInput = readFunctionToolInput(item);
    const changedPaths = patchInput ? readPatchTargetPaths(patchInput) : [];
    const detail = changedPaths.length > 0 ? changedPaths.join("\n") : null;
    const title =
      changedPaths.length === 0
        ? "• Applied file changes"
        : changedPaths.length === 1
          ? `• Applied file changes to ${toFileChangeTargetLabel(changedPaths[0])}`
          : `• Applied file changes to ${toFileChangeTargetLabel(changedPaths[0])} +${String(changedPaths.length - 1)} more`;
    return withNestedDetail(title, detail);
  }
  const title =
    status === "failed" || status === "error"
      ? `• Tool failed \`${normalizedToolName}\``
      : status === "running" || status === "inprogress"
        ? `• Calling tool \`${normalizedToolName}\``
        : `• Called tool \`${normalizedToolName}\``;
  return withNestedDetail(
    title,
    inputPreview ? `Input: ${inputPreview}` : null,
  );
}
