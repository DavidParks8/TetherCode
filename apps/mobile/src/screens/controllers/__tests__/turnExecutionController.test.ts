import { TurnExecutionController } from '../turnExecutionController';

describe('turnExecutionController', () => {
  it('creates a thread, builds its message, and reports the started turn', async () => {
    const created = { id: 'thread-1', cwd: '/repo' };
    const api = {
      createChatIdempotent: jest.fn().mockResolvedValue(created),
      sendChatMessageIdempotent: jest.fn(async (_id, _message, _submissionId, options) => {
        options.onTurnStarted('turn-1');
        return { ...created, messages: [] };
      }),
    };
    const onCreated = jest.fn();
    const onTurnStarted = jest.fn();
    const controller = new TurnExecutionController(api as never);

    await controller.createAndStart({
      submissionId: 'submission-1',
      create: { cwd: '/repo' },
      message: (chat) => ({ content: 'hello', cwd: chat.cwd }),
      onCreated,
      onTurnStarted,
    });

    expect(onCreated).toHaveBeenCalledWith(created);
    expect(api.sendChatMessageIdempotent).toHaveBeenCalledWith(
      'thread-1',
      { content: 'hello', cwd: '/repo' },
      'submission-1',
      expect.any(Object)
    );
    expect(onTurnStarted).toHaveBeenCalledWith('thread-1', 'turn-1');
  });

  it('uses exact interruption when a turn id is known', async () => {
    const api = { interruptTurn: jest.fn(), interruptLatestTurn: jest.fn() };
    const controller = new TurnExecutionController(api as never);
    await expect(controller.interrupt('thread-1', 'turn-1')).resolves.toBe('turn-1');
    expect(api.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-1');
    expect(api.interruptLatestTurn).not.toHaveBeenCalled();
  });
});
