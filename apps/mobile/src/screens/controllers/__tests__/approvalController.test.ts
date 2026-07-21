import type { PendingUserInputRequest } from '../../../api/types';
import { ApprovalController, buildUserInputAnswers } from '../approvalController';

const request: PendingUserInputRequest = {
  requestId: 'input-1',
  agentId: 'agent-alpha',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  message: 'Which?',
  requestedAt: 'now',
  questions: [
    {
      id: 'choice',
      header: 'Choose',
      question: 'Which?',
      options: [],
      isOther: false,
      isSecret: false,
      required: true,
      fieldType: 'string-array',
    },
  ],
};

describe('approvalController', () => {
  it('validates and normalizes user-input answers', () => {
    expect(buildUserInputAnswers(request, {})).toEqual({ error: 'Please answer "Choose"' });
    expect(buildUserInputAnswers(request, { choice: 'one, two' })).toEqual({
      answers: { choice: ['one', 'two'] },
    });
  });

  it('finds the approval for the requested thread', async () => {
    const api = {
      listApprovals: jest.fn().mockResolvedValue([
        { id: 'a', threadId: 'other' },
        { id: 'b', threadId: 'thread-1' },
      ]),
      resolveApproval: jest.fn(),
      resolveUserInput: jest.fn(),
    };
    const controller = new ApprovalController(api as never);
    await expect(controller.findForThread('thread-1')).resolves.toMatchObject({ id: 'b' });
    await expect(controller.findForThread('missing')).resolves.toBeNull();
  });

  it('reuses the resolution id after a failed approval attempt', async () => {
    const api = {
      listApprovals: jest.fn(),
      resolveApproval: jest
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ ok: true }),
      resolveUserInput: jest.fn(),
    };
    const controller = new ApprovalController(api as never);
    await expect(controller.resolveApproval('a', 'allow-project')).rejects.toThrow('offline');
    await controller.resolveApproval('a', 'allow-project');
    expect(api.resolveApproval.mock.calls[1]?.[2]).toBe(api.resolveApproval.mock.calls[0]?.[2]);
  });

  it('resolves valid user input and returns validation errors without calling the API', async () => {
    const api = {
      listApprovals: jest.fn(),
      resolveApproval: jest.fn(),
      resolveUserInput: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new ApprovalController(api as never);

    await expect(controller.resolveUserInput(request, {})).resolves.toBe('Please answer "Choose"');
    expect(api.resolveUserInput).not.toHaveBeenCalled();
    await expect(controller.resolveUserInput(request, { choice: 'yes' })).resolves.toBeNull();
    expect(api.resolveUserInput).toHaveBeenCalledWith('input-1', {
      answers: { choice: ['yes'] },
    });
  });

  it('parses typed values and forwards decline without answers', async () => {
    const typed = {
      ...request,
      questions: [
        { ...request.questions[0], id: 'count', header: 'Count', fieldType: 'integer' as const },
        { ...request.questions[0], id: 'enabled', header: 'Enabled', fieldType: 'boolean' as const },
      ],
    };
    expect(buildUserInputAnswers(typed, { count: '3', enabled: 'true' })).toEqual({ answers: { count: 3, enabled: true } });
    const api = { listApprovals: jest.fn(), resolveApproval: jest.fn(), resolveUserInput: jest.fn() };
    const controller = new ApprovalController(api as never);
    await controller.dismissUserInput(request, 'decline');
    expect(api.resolveUserInput).toHaveBeenCalledWith('input-1', { answers: {}, action: 'decline' });
  });
});
