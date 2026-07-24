import type { ChatSummary } from '../api/types';
import {
  dedupeChatsById,
  mergeDrawerChatBatch,
} from './drawerContentHelpers';

function chat(
  title: string,
  updatedAt: string,
  statusUpdatedAt = updatedAt
): ChatSummary {
  return {
    id: 'thread',
    title,
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt,
    statusUpdatedAt,
    lastMessagePreview: '',
  };
}

describe('drawer chat summary merging', () => {
  it('does not let a late stale batch overwrite a newer live summary', () => {
    const current = chat('New title', '2026-07-20T00:30:00.000Z');
    const stale = chat('Old title', '2026-07-20T00:20:00.000Z');

    expect(mergeDrawerChatBatch([current], [stale])).toEqual([current]);
    expect(dedupeChatsById([current, stale])).toEqual([current]);
  });

  it('uses status time to break equal update-time ties', () => {
    const current = chat(
      'Old status',
      '2026-07-20T00:30:00.000Z',
      '2026-07-20T00:29:00.000Z'
    );
    const incoming = chat(
      'New status',
      '2026-07-20T00:30:00.000Z',
      '2026-07-20T00:30:00.000Z'
    );

    expect(mergeDrawerChatBatch([current], [incoming])).toEqual([incoming]);
  });
});
