import type { Chat } from '../../../api/types';
import { assessChatSync, getChatSyncInterval } from '../chatSyncController';

const chat = (status: Chat['status'], messages: Chat['messages'] = []): Chat => ({
  id: 'thread-1',
  title: 'Thread',
  status,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  statusUpdatedAt: '2026-07-18T00:00:00.000Z',
  lastMessagePreview: '',
  messages,
});

describe('chatSyncController', () => {
  it('treats terminal snapshots as authoritative over a watchdog', () => {
    expect(assessChatSync(chat('running'), chat('complete'), true)).toMatchObject({
      terminal: true,
      shouldShowRunning: false,
    });
  });

  it('keeps recent unanswered user turns running', () => {
    const latest = chat('idle', [
      { id: 'u', role: 'user', content: 'work', createdAt: new Date().toISOString() },
    ]);
    expect(assessChatSync(null, latest, false).shouldShowRunning).toBe(true);
  });

  it('selects foreground and background polling intervals', () => {
    expect(getChatSyncInterval(false, true)).toBe(15_000);
    expect(getChatSyncInterval(true, true)).toBe(2_000);
    expect(getChatSyncInterval(true, false)).toBe(5_000);
  });
});
