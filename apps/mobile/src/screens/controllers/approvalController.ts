import type { HostBridgeApiClient } from '../../api/client';
import type {
  PendingApproval,
  PendingUserInputRequest,
  UserInputValue,
} from '../../api/types';
import { normalizeQuestionAnswers } from '../mainScreenHelpers';

type ApprovalApi = Pick<
  HostBridgeApiClient,
  'listApprovals' | 'resolveApproval' | 'resolveUserInput'
>;

export function buildUserInputAnswers(
  request: PendingUserInputRequest,
  drafts: Readonly<Record<string, string>>
): { answers: Record<string, UserInputValue> } | { error: string } {
  const answers: Record<string, UserInputValue> = {};
  for (const question of request.questions) {
    const draft = (drafts[question.id] ?? '').trim();
    if (!draft && !question.required) continue;
    if (!draft) {
      return { error: `Please answer "${question.header}"` };
    }
    switch (question.fieldType ?? 'string') {
      case 'integer': {
        const value = Number(draft);
        if (!Number.isInteger(value)) return { error: `"${question.header}" must be an integer` };
        answers[question.id] = value;
        break;
      }
      case 'number': {
        const value = Number(draft);
        if (!Number.isFinite(value)) return { error: `"${question.header}" must be a number` };
        answers[question.id] = value;
        break;
      }
      case 'boolean':
        if (draft !== 'true' && draft !== 'false') return { error: `"${question.header}" must be true or false` };
        answers[question.id] = draft === 'true';
        break;
      case 'string-array':
        answers[question.id] = normalizeQuestionAnswers(draft);
        break;
      default:
        answers[question.id] = draft;
    }
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

  async resolveApproval(id: string, optionId: string): Promise<void> {
    const key = `${id}:${optionId}`;
    const resolutionId =
      this.failedResolutionIds.get(key) ??
      `approval-${Date.now().toString(36)}-${(++this.resolutionCounter).toString(36)}`;
    try {
      await this.api.resolveApproval(id, optionId, resolutionId);
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
    await this.api.resolveUserInput(request.requestId, { answers: result.answers });
    return null;
  }

  async dismissUserInput(request: PendingUserInputRequest, action: 'decline' | 'cancel'): Promise<void> {
    await this.api.resolveUserInput(request.requestId, { answers: {}, action });
  }
}
