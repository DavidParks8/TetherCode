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
  constructor(private readonly api: ApprovalApi) {}

  async findForThread(threadId: string): Promise<PendingApproval | null> {
    const approvals = await this.api.listApprovals();
    return approvals.find((approval) => approval.threadId === threadId) ?? null;
  }

  async resolveApproval(id: string, decision: ApprovalDecision): Promise<void> {
    await this.api.resolveApproval(id, decision);
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
