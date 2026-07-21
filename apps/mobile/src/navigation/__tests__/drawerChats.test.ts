import type { ChatSummary } from '../../api/types';
import { filterDrawerChatsByAgents } from '../drawerChats';

function chat(id: string, agentId: string | null): ChatSummary {
  return { id, agentId, title: id, status: 'idle', createdAt: '', updatedAt: '', statusUpdatedAt: '', lastMessagePreview: '' };
}

test('filters dynamically by arbitrary agent IDs and excludes unknown IDs', () => {
  const chats = [chat('alpha', 'agent-alpha'), chat('beta', 'agent-beta'), chat('unknown', null)];
  expect(filterDrawerChatsByAgents(chats, ['agent-beta']).map((item) => item.id)).toEqual(['beta']);
  expect(filterDrawerChatsByAgents(chats, []).map((item) => item.id)).toEqual(['alpha', 'beta', 'unknown']);
});
