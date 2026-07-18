import type { Chat } from '../../../api/types';
import { projectTranscript } from '../transcriptProjectionController';

const chat: Chat = {
  id: 'child', title: 'Child', status: 'running', createdAt: '', updatedAt: '',
  statusUpdatedAt: '', lastMessagePreview: '', parentThreadId: 'parent',
  messages: [{ id: 'u', role: 'user', content: 'child prompt', createdAt: '' }],
};

describe('transcriptProjectionController', () => {
  it('projects inherited messages and a non-duplicate live assistant message', () => {
    const parent = {
      ...chat,
      id: 'parent',
      parentThreadId: undefined,
      messages: [{ id: 'p', role: 'user' as const, content: 'parent prompt', createdAt: '' }],
    };
    const projection = projectTranscript({
      chat,
      parentChat: parent,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantText: 'live answer',
      now: () => 'now',
    });
    expect(projection.messages.at(-1)).toMatchObject({
      id: 'live-assistant-child',
      content: 'live answer',
      createdAt: 'now',
    });
    expect(projection.items).toHaveLength(projection.messages.length);
  });
});
