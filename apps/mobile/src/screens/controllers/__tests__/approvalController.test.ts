import type { PendingUserInputRequest } from '../../../api/types';
import { ApprovalController, buildUserInputAnswers } from '../approvalController';

const request: PendingUserInputRequest = {
  id: 'input-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  requestedAt: 'now',
  questions: [
    {
      id: 'choice',
      header: 'Choose',
      question: 'Which?',
      options: [],
      isOther: false,
      isSecret: false,
    },
  ],
};

describe('approvalController', () => {
  it('validates and normalizes user-input answers', () => {
    expect(buildUserInputAnswers(request, {})).toEqual({ error: 'Please answer "Choose"' });
    expect(buildUserInputAnswers(request, { choice: 'one, two' })).toEqual({
      answers: { choice: { answers: ['one', 'two'] } },
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
  });
});
