import type { Chat } from '../api/types';
import * as FileSystem from 'expo-file-system/legacy';
import {
  CHAT_SNAPSHOT_CACHE_MAX_BYTES,
  CHAT_SNAPSHOT_CACHE_MAX_ENTRIES,
  createEmptyChatSnapshotCache,
  deleteChatSnapshotCache,
  getChatSnapshotCachePath,
  loadChatSnapshotCache,
  parseChatSnapshotCache,
  saveChatSnapshotCache,
  updateChatSnapshotCache,
} from '../chatSnapshotCache';

function chat(id: string, message = id): Chat {
  return {
    id,
    title: `Chat ${id}`,
    status: 'idle',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    statusUpdatedAt: '2026-07-01T00:00:00.000Z',
    lastMessagePreview: message,
    messages: [
      {
        id: `message-${id}`,
        role: 'assistant',
        content: message,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  };
}

describe('chatSnapshotCache', () => {
  it('round trips exact-version snapshots for one profile', () => {
    const typedChat = chat('thread-1');
    typedChat.messages[0].parts = [
      { type: 'text', text: 'A' },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      { type: 'text', text: 'B' },
      { type: 'resourceLink', uri: 'file:///linked.txt', name: 'linked.txt', size: 7 },
      {
        type: 'resource',
        resource: {
          uri: 'file:///embedded.txt',
          text: 'payload',
          mimeType: 'text/plain',
          metadata: { source: 'fixture' },
        },
      },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
    ];
    const updated = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'thread-1',
      typedChat,
      '2026-07-17T00:00:00.000Z'
    );

    expect(
      parseChatSnapshotCache(
        JSON.stringify(updated),
        'profile-a',
        Date.parse('2026-07-18T00:00:00.000Z')
      )
    ).toEqual(updated);
    expect(updated.entries[0]?.chat.messages[0]?.parts).toEqual(typedChat.messages[0].parts);
    expect(parseChatSnapshotCache(JSON.stringify(updated), 'profile-b').entries).toEqual([]);
  });

  it('rejects old schemas and malformed chats', () => {
    expect(
      parseChatSnapshotCache(JSON.stringify({ version: 0, profileId: 'profile-a', entries: [] }), 'profile-a')
    ).toEqual(expect.objectContaining({ entries: [], selectedChatId: null }));
    expect(
      parseChatSnapshotCache(
        JSON.stringify({
          version: 1,
          profileId: 'profile-a',
          entries: [{ chat: { id: 'bad' }, cachedAt: 'bad', lastAccessedAt: 'bad' }],
        }),
        'profile-a'
      ).entries
    ).toEqual([]);
    expect(parseChatSnapshotCache('{', 'profile-a').entries).toEqual([]);
  });

  it('bounds entries while retaining the selected snapshot', () => {
    let cache = createEmptyChatSnapshotCache('profile-a');
    for (let index = 0; index < CHAT_SNAPSHOT_CACHE_MAX_ENTRIES + 5; index += 1) {
      cache = updateChatSnapshotCache(
        cache,
        index === 0 ? 'thread-0' : cache.selectedChatId,
        chat(`thread-${String(index)}`),
        new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
      );
    }

    expect(cache.entries).toHaveLength(CHAT_SNAPSHOT_CACHE_MAX_ENTRIES);
    expect(cache.entries.some((entry) => entry.chat.id === 'thread-0')).toBe(true);
  });

  it('drops expired snapshots', () => {
    const stored = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'),
      'thread-old',
      chat('thread-old'),
      '2026-01-01T00:00:00.000Z'
    );

    expect(
      parseChatSnapshotCache(
        JSON.stringify(stored),
        'profile-a',
        Date.parse('2026-07-17T00:00:00.000Z')
      ).entries
    ).toEqual([]);
  });

  it('uses only the profile id in the cache path', () => {
    const path = getChatSnapshotCachePath('profile-a', 'file:///documents/');
    expect(path).toBe('file:///documents/tethercode-chat-cache/profile-a/snapshots.json');
    expect(path).not.toContain('token');
    expect(path).not.toContain('http');
    expect(getChatSnapshotCachePath('', 'file:///documents/')).toBeNull();
    expect(getChatSnapshotCachePath('profile', null)).toBeNull();
    expect(getChatSnapshotCachePath('a/b', 'file:///documents/')).toContain('a%2Fb');
  });

  it('normalizes metadata, selection, and malformed entries', () => {
    const valid = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'), 'one', chat('one'), '2026-07-17T00:00:00.000Z'
    );
    const parsed = parseChatSnapshotCache(JSON.stringify({
      ...valid,
      selectedChatId: 'missing',
      updatedAt: 'invalid',
      entries: [
        null,
        { chat: chat('bad-role'), cachedAt: 'bad', lastAccessedAt: 'bad' },
        ...valid.entries,
      ],
    }), 'profile-a', Date.parse('2026-07-18T00:00:00.000Z'));
    expect(parsed.selectedChatId).toBeNull();
    expect(parsed.updatedAt).toBe('2026-07-18T00:00:00.000Z');
    expect(parsed.entries).toHaveLength(1);
  });

  it('updates access time without replacing an existing snapshot', () => {
    const initial = updateChatSnapshotCache(
      createEmptyChatSnapshotCache('profile-a'), 'one', chat('one'), '2026-07-17T00:00:00.000Z'
    );
    const updated = updateChatSnapshotCache(initial, 'one', null, '2026-07-18T00:00:00.000Z');
    expect(updated.entries[0]?.lastAccessedAt).toBe('2026-07-18T00:00:00.000Z');
    expect(updated.entries[0]?.chat).not.toBe(initial.entries[0]?.chat);
    expect(updateChatSnapshotCache(initial, ' missing ', null).selectedChatId).toBeNull();
  });

  it('rejects malformed chat fields and messages', () => {
    const base = chat('one');
    const invalidChats = [
      null,
      {},
      { ...base, id: '' },
      { ...base, title: 1 },
      { ...base, status: 1 },
      { ...base, createdAt: 1 },
      { ...base, updatedAt: 1 },
      { ...base, statusUpdatedAt: 1 },
      { ...base, lastMessagePreview: 1 },
      { ...base, messages: 'invalid' },
      { ...base, messages: [null] },
      { ...base, messages: [{ ...base.messages[0], role: 'tool' }] },
      { ...base, messages: [{ ...base.messages[0], content: 1 }] },
      { ...base, messages: [{ ...base.messages[0], createdAt: 1 }] },
    ];
    const raw = JSON.stringify({
      version: 1,
      profileId: 'profile-a',
      entries: invalidChats.map((value) => ({
        chat: value, cachedAt: '2026-07-17T00:00:00.000Z', lastAccessedAt: '2026-07-17T00:00:00.000Z',
      })),
    });
    expect(parseChatSnapshotCache(raw, 'profile-a').entries).toEqual([]);
  });

  it('skips snapshots that exceed the byte budget', () => {
    const huge = chat('huge', 'x'.repeat(CHAT_SNAPSHOT_CACHE_MAX_BYTES));
    const cache = updateChatSnapshotCache(createEmptyChatSnapshotCache('profile-a'), 'huge', huge);
    expect(cache.entries).toEqual([]);
    expect(cache.selectedChatId).toBeNull();
  });

  it('loads, saves, serializes writes, and deletes snapshots', async () => {
    const originalDirectory = FileSystem.documentDirectory;
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: 'file:///documents/',
    });
    const read = jest.spyOn(FileSystem, 'readAsStringAsync');
    const mkdir = jest.spyOn(FileSystem, 'makeDirectoryAsync').mockResolvedValue(undefined);
    const write = jest.spyOn(FileSystem, 'writeAsStringAsync').mockResolvedValue(undefined);
    const remove = jest.spyOn(FileSystem, 'deleteAsync').mockResolvedValue(undefined);
    const cache = updateChatSnapshotCache(createEmptyChatSnapshotCache('profile-a'), 'one', chat('one'));
    read.mockResolvedValueOnce(JSON.stringify(cache));
    await expect(loadChatSnapshotCache('profile-a')).resolves.toMatchObject({ selectedChatId: 'one' });
    read.mockRejectedValueOnce(new Error('missing'));
    await expect(loadChatSnapshotCache('profile-a')).resolves.toMatchObject({ entries: [] });
    await Promise.all([saveChatSnapshotCache(cache), saveChatSnapshotCache(cache)]);
    expect(mkdir).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledTimes(2);
    await deleteChatSnapshotCache('profile-a');
    expect(remove).toHaveBeenCalledWith(expect.stringContaining('profile-a'), { idempotent: true });
    remove.mockRejectedValueOnce(new Error('missing'));
    await expect(deleteChatSnapshotCache('profile-a')).resolves.toBeUndefined();
    Object.defineProperty(FileSystem, 'documentDirectory', {
      configurable: true,
      value: originalDirectory,
    });
  });
});
