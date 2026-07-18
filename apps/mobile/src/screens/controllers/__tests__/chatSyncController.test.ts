import type { Chat } from '../../../api/types';
import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  ChatSyncController,
  assessChatSync,
  getChatSyncInterval,
  useChatSynchronization,
} from '../chatSyncController';

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

  it('detects assistant progress and falls back to a running watchdog', () => {
    const previous = chat('idle', [
      { id: 'a', role: 'assistant', content: 'a', createdAt: '' },
    ]);
    const latest = chat('idle', [
      { id: 'a', role: 'assistant', content: 'answer', createdAt: '' },
    ]);
    expect(assessChatSync(previous, latest, false)).toMatchObject({
      terminal: false,
      shouldShowRunning: true,
      shouldRefreshWatchdog: true,
      watchdogDurationMs: 15_000,
    });
    expect(assessChatSync(latest, latest, true)).toMatchObject({
      shouldShowRunning: true,
      shouldRefreshWatchdog: false,
    });
  });

  it('delegates forced loads, polls, and queue reads', async () => {
    const api = {
      getChat: jest.fn().mockResolvedValue(chat('idle')),
      readThreadQueue: jest.fn().mockResolvedValue([]),
    };
    const controller = new ChatSyncController(api as never);
    await controller.load('thread');
    await controller.poll('thread');
    await controller.readQueue('thread');
    expect(api.getChat).toHaveBeenNthCalledWith(1, 'thread', { forceRefresh: true });
    expect(api.getChat).toHaveBeenNthCalledWith(2, 'thread');
  });

  it('polls immediately, schedules follow-up work, tolerates failures, and cleans up', async () => {
    jest.useFakeTimers();
    const snapshot = chat('idle');
    const poll = jest.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('offline'));
    const onSnapshot = jest.fn();
    function Probe({ threadId = 'thread', paused = false }: { threadId?: string | null; paused?: boolean }) {
      useChatSynchronization({
        controller: { poll } as never,
        threadId,
        paused,
        getPrevious: () => null,
        isWatchdogActive: () => false,
        isAppActive: () => true,
        isTurnActive: () => false,
        onSnapshot,
      });
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Probe)); });
    expect(onSnapshot).toHaveBeenCalledWith(snapshot, expect.any(Object));
    await act(async () => { jest.advanceTimersByTime(5_000); await Promise.resolve(); });
    expect(poll).toHaveBeenCalledTimes(2);
    act(() => tree!.unmount());
    act(() => { jest.runOnlyPendingTimers(); });
    expect(poll).toHaveBeenCalledTimes(2);

    await act(async () => { tree = renderer.create(React.createElement(Probe, { paused: true })); });
    expect(poll).toHaveBeenCalledTimes(2);
    act(() => tree!.unmount());
    await act(async () => { tree = renderer.create(React.createElement(Probe, { threadId: null })); });
    act(() => tree!.unmount());
    jest.useRealTimers();
  });
});
