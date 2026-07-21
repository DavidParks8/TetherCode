import type { SnapshotPageResponse } from '../../../api/client';
import type { RawAcpSnapshot } from '../../../api/chatMapping';
import type { Chat } from '../../../api/types';
import {
  TranscriptContinuationController,
  getTranscriptContinuationState,
} from '../transcriptContinuationController';

function snapshot(): RawAcpSnapshot {
  return {
    version: 2,
    timeline: [{ sequence: 3, kind: 'message', canonicalId: 'newest' }],
    messages: [{ id: 'newest', role: 'agent', parts: [{ type: 'text', text: 'newest' }], truncated: false }],
    tools: [],
    messageCollection: { truncated: true, omittedCount: 2, beforeCursor: 'cursor-3', revision: 7 },
    reasoningCollection: { truncated: false, omittedCount: 0, beforeCursor: null, revision: 7 },
    toolCollection: { truncated: false, omittedCount: 0, beforeCursor: null, revision: 7 },
    continuation: { revision: 7, unavailableCount: 0, maxPageSize: 50, maxHistoryEntries: 1024, maxHistoryBytes: 4194304 },
    plan: [],
    usage: {},
    config: [],
    commands: [],
    session: { agentId: 'agent', threadId: 'thread', historyReconstruction: false },
    active: { toolIds: [] },
  };
}

function chat(acpSnapshot = snapshot()): Chat {
  return {
    id: 'thread',
    title: 'Thread',
    status: 'complete',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    statusUpdatedAt: '2026-07-20T00:00:00.000Z',
    lastMessagePreview: 'newest',
    messages: [],
    acpSnapshot,
  };
}

function page(overrides: Partial<SnapshotPageResponse>): SnapshotPageResponse {
  return {
    entries: [],
    beforeCursor: null,
    afterCursor: null,
    hasMoreBefore: false,
    hasMoreAfter: true,
    unavailableCount: 0,
    earliestAvailableSequence: 1,
    latestAvailableSequence: 3,
    revision: 7,
    ...overrides,
  };
}

describe('TranscriptContinuationController', () => {
  it('merges pages chronologically until exhaustion and deduplicates repeated entries', async () => {
    const readSnapshotPage = jest.fn()
      .mockResolvedValueOnce(page({
        entries: [{ sequence: 2, kind: 'message', canonicalId: 'middle', message: { id: 'middle', role: 'agent', parts: [{ type: 'text', text: 'middle' }], truncated: false } }],
        beforeCursor: 'cursor-2',
        hasMoreBefore: true,
      }))
      .mockResolvedValueOnce(page({
        entries: [
          { sequence: 1, kind: 'message', canonicalId: 'oldest', message: { id: 'oldest', role: 'user', parts: [{ type: 'text', text: 'oldest' }], truncated: false } },
          { sequence: 2, kind: 'message', canonicalId: 'middle', message: { id: 'middle', role: 'agent', parts: [{ type: 'text', text: 'middle' }], truncated: false } },
        ],
      }));
    const controller = new TranscriptContinuationController({ readSnapshotPage });

    const first = await controller.loadEarlier(chat());
    expect(first.kind).toBe('merged');
    if (first.kind !== 'merged') return;
    expect(first.chat.acpSnapshot?.timeline?.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(first.state.exhausted).toBe(false);

    const second = await controller.loadEarlier(first.chat);
    expect(second.kind).toBe('merged');
    if (second.kind !== 'merged') return;
    expect(second.chat.acpSnapshot?.timeline?.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(second.chat.acpSnapshot?.messages.map((message) => message.id)).toEqual(['newest', 'middle', 'oldest']);
    expect(second.state.exhausted).toBe(true);
  });

  it('reports unavailable history at an exhausted boundary', () => {
    const unavailable = snapshot();
    unavailable.messageCollection = { ...unavailable.messageCollection!, beforeCursor: null, omittedCount: 4 };
    unavailable.continuation = { ...unavailable.continuation!, unavailableCount: 4 };
    expect(getTranscriptContinuationState(chat(unavailable))).toEqual({
      loading: false,
      error: null,
      exhausted: true,
      unavailableCount: 4,
    });
  });

  it('returns an error for retry and succeeds on the next request', async () => {
    const readSnapshotPage = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page({ entries: [{ sequence: 2, kind: 'reasoning', canonicalId: 'reasoning' }] }));
    const controller = new TranscriptContinuationController({ readSnapshotPage });
    const first = await controller.loadEarlier(chat());
    expect(first.state.error).toBe('offline');
    const retry = await controller.loadEarlier(chat());
    expect(retry.state.error).toBeNull();
    expect(readSnapshotPage).toHaveBeenCalledTimes(2);
  });

  it('requires a full refetch when the page revision is stale', async () => {
    const controller = new TranscriptContinuationController({
      readSnapshotPage: jest.fn().mockResolvedValue(page({ revision: 8 })),
    });
    await expect(controller.loadEarlier(chat())).resolves.toMatchObject({ kind: 'stale' });
  });
});
