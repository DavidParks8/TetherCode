import { AgentThreadsController } from '../agentThreadsController';

describe('agentThreadsController', () => {
  it('merges loaded-only threads before projecting the related tree', async () => {
    const root = {
      id: 'root', title: 'Root', status: 'running', createdAt: '', updatedAt: '',
      statusUpdatedAt: '', lastMessagePreview: '',
    };
    const child = { ...root, id: 'child', title: 'Child', parentThreadId: 'root' };
    const api = {
      listChats: jest.fn().mockResolvedValue([root]),
      listLoadedChatIds: jest.fn().mockResolvedValue(['root', 'child']),
      getChatSummaries: jest.fn().mockResolvedValue([child]),
    };
    const controller = new AgentThreadsController(api as never);
    const result = await controller.loadRelated('root');
    expect(api.getChatSummaries).toHaveBeenCalledWith(['child']);
    expect(result.threads.map((thread) => thread.id)).toEqual(['root', 'child']);
  });

  it('falls back to the supplied focus and tolerates loaded-id lookup failure', async () => {
    const fallback = {
      id: 'fallback', title: 'Fallback', status: 'idle', createdAt: '', updatedAt: '',
      statusUpdatedAt: '', lastMessagePreview: '', messages: [],
    };
    const api = {
      listChats: jest.fn().mockResolvedValue([]),
      listLoadedChatIds: jest.fn().mockRejectedValue(new Error('offline')),
      getChatSummaries: jest.fn().mockResolvedValue([]),
    };
    const result = await new AgentThreadsController(api as never).loadRelated('fallback', fallback as never);
    expect(api.getChatSummaries).toHaveBeenCalledWith([]);
    expect(result.rootThreadId).toBe('fallback');
  });

  it('projects an empty result when neither the focus nor a fallback exists', async () => {
    const api = {
      listChats: jest.fn().mockResolvedValue([]),
      listLoadedChatIds: jest.fn().mockResolvedValue([]),
      getChatSummaries: jest.fn().mockResolvedValue([]),
    };
    await expect(new AgentThreadsController(api as never).loadRelated('missing')).resolves.toEqual({
      rootThreadId: null,
      threads: [],
    });
  });

  it('loads details with no parent, a cached parent, or a failed parent fetch', async () => {
    const child = { id: 'child', parentThreadId: undefined };
    const parent = { id: 'parent' };
    const api = {
      getChat: jest.fn().mockResolvedValueOnce(child),
      peekChat: jest.fn(),
    };
    const controller = new AgentThreadsController(api as never);
    await expect(controller.loadDetail('child')).resolves.toEqual({ chat: child, parent: null });

    const linked = { ...child, parentThreadId: 'parent' };
    api.getChat.mockResolvedValueOnce(linked);
    api.peekChat.mockReturnValueOnce(parent);
    await expect(controller.loadDetail('child')).resolves.toEqual({ chat: linked, parent });

    api.getChat.mockResolvedValueOnce(linked).mockRejectedValueOnce(new Error('missing'));
    api.peekChat.mockReturnValueOnce(null);
    await expect(controller.loadDetail('child')).resolves.toEqual({ chat: linked, parent: null });
  });
});
