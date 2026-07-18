import type { HostBridgeApiClient } from '../../api/client';
import type {
  ApprovalDecision,
  PendingApproval,
  PendingUserInputRequest,
} from '../../api/types';
import { normalizeQuestionAnswers } from '../mainScreenHelpers';

type ApprovalApi = Pick<
  HostBridgeApiClient,
  'listApprovals' | 'resolveApproval' | 'resolveUserInput'
>;

export function buildUserInputAnswers(
  request: PendingUserInputRequest,
  drafts: Readonly<Record<string, string>>
): { answers: Record<string, { answers: string[] }> } | { error: string } {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of request.questions) {
    const normalized = normalizeQuestionAnswers((drafts[question.id] ?? '').trim());
    if (normalized.length === 0) {
      return { error: `Please answer "${question.header}"` };
    }
    answers[question.id] = { answers: normalized };
  }
  return { answers };
}

export class ApprovalController {
  private readonly failedResolutionIds = new Map<string, string>();
  private resolutionCounter = 0;

  constructor(private readonly api: ApprovalApi) {}

  async findForThread(threadId: string): Promise<PendingApproval | null> {
    const approvals = await this.api.listApprovals();
    return approvals.find((approval) => approval.threadId === threadId) ?? null;
  }

  async resolveApproval(id: string, decision: ApprovalDecision): Promise<void> {
    const key = `${id}:${JSON.stringify(decision)}`;
    const resolutionId =
      this.failedResolutionIds.get(key) ??
      `approval-${Date.now().toString(36)}-${(++this.resolutionCounter).toString(36)}`;
    try {
      await this.api.resolveApproval(id, decision, resolutionId);
      this.failedResolutionIds.delete(key);
    } catch (error) {
      this.failedResolutionIds.set(key, resolutionId);
      throw error;
    }
  }

  async resolveUserInput(
    request: PendingUserInputRequest,
    drafts: Readonly<Record<string, string>>
  ): Promise<string | null> {
    const result = buildUserInputAnswers(request, drafts);
    if ('error' in result) return result.error;
    await this.api.resolveUserInput(request.id, { answers: result.answers });
    return null;
  }
}
