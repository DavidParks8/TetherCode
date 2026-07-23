import { HostBridgeApiClientTurnLifecycleLayer } from "./HostBridgeApiClientTurnLifecycleLayer";
import * as FileSystem from "expo-file-system/legacy";
import { normalizeCwd } from "./clientChatListInternals";
import { readString, toRecord } from "./chatMapping";
import {
  type BridgeThreadQueueActionResponse,
  type DismissBridgeUiSurfaceResponse,
  type GitBranchesResponse,
  type GitCloneRequest,
  type GitCloneResponse,
  type GitCommitRequest,
  type GitCommitResponse,
  type GitDiffResponse,
  type GitFileRequest,
  type GitHistoryResponse,
  type GitHubAuthGrantInput,
  type GitHubAuthInstallResponse,
  type GitStageAllResponse,
  type GitStageResponse,
  type GitStatusResponse,
  type GitSwitchRequest,
  type GitSwitchResponse,
  type GitUnstageAllResponse,
  type GitUnstageResponse,
  type PendingApproval,
  type PendingUserInputRequest,
  type ResolveApprovalResponse,
  type ResolveBridgeUiSurfaceRequest,
  type ResolveBridgeUiSurfaceResponse,
  type ResolveUserInputRequest,
  type ResolveUserInputResponse,
  type TerminalExecRequest,
  type TerminalExecResponse,
  type UploadAttachmentRequest,
  type UploadAttachmentResponse,
} from "./types";

export abstract class HostBridgeApiClientBridgeActionsLayer extends HostBridgeApiClientTurnLifecycleLayer {
  steerQueuedThreadMessage(
    threadId: string,
    itemId: string,
  ): Promise<BridgeThreadQueueActionResponse> {
    return this.ws.request<BridgeThreadQueueActionResponse>(
      "bridge/thread/queue/steer",
      { threadId: threadId.trim(), itemId: itemId.trim() },
    );
  }
  cancelQueuedThreadMessage(
    threadId: string,
    itemId: string,
  ): Promise<BridgeThreadQueueActionResponse> {
    return this.ws.request<BridgeThreadQueueActionResponse>(
      "bridge/thread/queue/cancel",
      {
        threadId: threadId.trim(),
        itemId: itemId.trim(),
      },
    );
  }
  async uploadAttachment(
    body: UploadAttachmentRequest,
  ): Promise<UploadAttachmentResponse> {
    if (!this.bridgeUrl) {
      throw new Error("Bridge URL is required for attachment uploads");
    }
    const parameters: Record<string, string> = { kind: body.kind };
    if (body.fileName?.trim()) parameters.fileName = body.fileName.trim();
    if (body.mimeType?.trim()) parameters.mimeType = body.mimeType.trim();
    if (body.threadId?.trim()) parameters.threadId = body.threadId.trim();
    const result = await FileSystem.uploadAsync(
      `${this.bridgeUrl}/attachments`,
      body.uri,
      {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "file",
        mimeType: body.mimeType,
        parameters,
        headers: this.authToken
          ? { Authorization: `Bearer ${this.authToken}` }
          : undefined,
        sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      },
    );
    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch {
      payload = null;
    }
    if (result.status < 200 || result.status >= 300) {
      const record = toRecord(payload);
      throw new Error(
        readString(record?.message) ??
          `Attachment upload failed (${String(result.status)})`,
      );
    }
    return payload as UploadAttachmentResponse;
  }
  listApprovals(): Promise<PendingApproval[]> {
    return this.ws.request<PendingApproval[]>("bridge/approvals/list");
  }
  listPendingUserInputs(): Promise<PendingUserInputRequest[]> {
    return this.ws.request<PendingUserInputRequest[]>("bridge/userInput/list");
  }
  resolveApproval(
    id: string,
    decision: string,
    resolutionId: string,
  ): Promise<ResolveApprovalResponse> {
    return this.ws.request<ResolveApprovalResponse>(
      "bridge/approvals/resolve",
      { id, decision, resolutionId },
    );
  }
  resolveUserInput(
    id: string,
    body: ResolveUserInputRequest,
  ): Promise<ResolveUserInputResponse> {
    return this.ws.request<ResolveUserInputResponse>(
      "bridge/userInput/resolve",
      { id, answers: body.answers, action: body.action },
    );
  }
  resolveBridgeUiSurface(
    id: string,
    body: ResolveBridgeUiSurfaceRequest,
  ): Promise<ResolveBridgeUiSurfaceResponse> {
    return this.ws.request<ResolveBridgeUiSurfaceResponse>(
      "bridge/ui/resolve",
      {
        id,
        threadId: body.threadId,
        turnId: body.turnId ?? null,
        actionId: body.actionId,
      },
    );
  }
  dismissBridgeUiSurface(
    id: string,
    threadId?: string | null,
  ): Promise<DismissBridgeUiSurfaceResponse> {
    return this.ws.request<DismissBridgeUiSurfaceResponse>(
      "bridge/ui/dismiss",
      { id, threadId: threadId ?? null },
    );
  }
  execTerminal(body: TerminalExecRequest): Promise<TerminalExecResponse> {
    return this.ws.request<TerminalExecResponse>("bridge/terminal/exec", body);
  }
  installGitHubAuth(
    body:
      | { accessToken: string; repositories?: string[] }
      | { grants: GitHubAuthGrantInput[] },
  ): Promise<GitHubAuthInstallResponse> {
    const grants =
      "grants" in body
        ? body.grants
        : [
            {
              accessToken: body.accessToken,
              repositories: body.repositories ?? [],
            },
          ];
    const normalizedGrants = grants
      .map((grant) => ({
        accessToken: grant.accessToken.trim(),
        repositories: (grant.repositories ?? [])
          .map((repository) => repository.trim())
          .filter((repository) => repository.length > 0),
      }))
      .filter((grant) => grant.accessToken.length > 0);
    if (normalizedGrants.length === 0) {
      return Promise.reject(
        new Error("At least one GitHub auth grant is required"),
      );
    }
    return this.ws.request<GitHubAuthInstallResponse>(
      "bridge/github/auth/install",
      { grants: normalizedGrants },
    );
  }
  gitStatus(cwd?: string): Promise<GitStatusResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitStatusResponse>("bridge/git/status", {
      cwd: normalizedCwd ?? null,
    });
  }
  gitDiff(cwd?: string): Promise<GitDiffResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitDiffResponse>("bridge/git/diff", {
      cwd: normalizedCwd ?? null,
    });
  }
  gitHistory(cwd?: string, limit = 12): Promise<GitHistoryResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitHistoryResponse>("bridge/git/history", {
      cwd: normalizedCwd ?? null,
      limit,
    });
  }
  gitBranches(cwd?: string): Promise<GitBranchesResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitBranchesResponse>("bridge/git/branches", {
      cwd: normalizedCwd ?? null,
    });
  }
  gitClone(body: GitCloneRequest): Promise<GitCloneResponse> {
    const url = body.url.trim();
    const directoryName = body.directoryName.trim();
    if (!url) {
      return Promise.reject(new Error("url must not be empty"));
    }
    if (!directoryName) {
      return Promise.reject(new Error("directoryName must not be empty"));
    }
    return this.ws.request<GitCloneResponse>("bridge/git/clone", {
      url,
      parentPath: normalizeCwd(body.parentPath) ?? null,
      directoryName,
    });
  }
  gitStage(body: GitFileRequest): Promise<GitStageResponse> {
    const path = body.path.trim();
    if (!path) {
      return Promise.reject(new Error("path must not be empty"));
    }
    return this.ws.request<GitStageResponse>("bridge/git/stage", {
      path,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }
  gitStageAll(cwd?: string): Promise<GitStageAllResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitStageAllResponse>("bridge/git/stageAll", {
      cwd: normalizedCwd ?? null,
    });
  }
  gitUnstage(body: GitFileRequest): Promise<GitUnstageResponse> {
    const path = body.path.trim();
    if (!path) {
      return Promise.reject(new Error("path must not be empty"));
    }
    return this.ws.request<GitUnstageResponse>("bridge/git/unstage", {
      path,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }
  gitUnstageAll(cwd?: string): Promise<GitUnstageAllResponse> {
    const normalizedCwd = normalizeCwd(cwd);
    return this.ws.request<GitUnstageAllResponse>("bridge/git/unstageAll", {
      cwd: normalizedCwd ?? null,
    });
  }
  gitCommit(body: GitCommitRequest): Promise<GitCommitResponse> {
    return this.ws.request<GitCommitResponse>("bridge/git/commit", {
      ...body,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }
  gitSwitch(body: GitSwitchRequest): Promise<GitSwitchResponse> {
    const branch = body.branch.trim();
    if (!branch) {
      return Promise.reject(new Error("branch must not be empty"));
    }
    return this.ws.request<GitSwitchResponse>("bridge/git/switch", {
      branch,
      cwd: normalizeCwd(body.cwd) ?? null,
    });
  }
}
