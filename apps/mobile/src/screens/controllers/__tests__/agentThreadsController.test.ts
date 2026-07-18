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
});
