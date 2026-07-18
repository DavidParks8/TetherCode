import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

jest.mock('../../mainScreenHelpers', () => ({
  ...jest.requireActual('../../mainScreenHelpers'),
  getChatDraftsPath: jest.fn(() => '/drafts.json'),
}));

import * as helpers from '../../mainScreenHelpers';
import {
  type DraftController,
  serializeDraftEntries,
  updateDraftEntries,
  useDraftController,
} from '../draftController';

describe('draftController', () => {
  it('updates one scope without overwriting another', () => {
    expect(updateDraftEntries({ first: 'keep' }, 'second', 'new draft')).toEqual({
      first: 'keep',
      second: 'new draft',
    });
  });

  it('removes blank drafts and serializes the current version', () => {
    const entries = updateDraftEntries({ first: 'draft' }, 'first', '  ');
    expect(entries).toEqual({});
    expect(JSON.parse(serializeDraftEntries(entries))).toEqual({ version: 2, entries: {} });
  });

  it('loads, updates, debounces, snapshots, switches scope, and flushes on unmount', async () => {
    jest.useFakeTimers();
    const firstKey = JSON.stringify(['profile', 'thread-1']);
    const secondKey = JSON.stringify(['profile', 'thread-2']);
    const storage = {
      read: jest.fn().mockResolvedValue(JSON.stringify({
        version: 2,
        entries: { [firstKey]: 'first', [secondKey]: 'second' },
      })),
      write: jest.fn().mockResolvedValue(undefined),
    };
    let current: DraftController;
    function Probe({ chatId }: { chatId: string }) {
      current = useDraftController('profile', chatId, storage);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Probe, { chatId: 'thread-1' })); });
    expect(current!.draft).toBe('first');
    act(() => current!.setDraft((value) => `${value}!`));
    act(() => current!.setDraft('first!'));
    expect(current!.snapshot()).toMatchObject({ scopeKey: firstKey, value: 'first!' });
    act(() => { jest.advanceTimersByTime(180); });
    expect(storage.write).toHaveBeenCalledWith('/drafts.json', expect.stringContaining('first!'));

    await act(async () => { tree!.update(React.createElement(Probe, { chatId: 'thread-2' })); });
    expect(current!.draft).toBe('second');
    act(() => current!.clearDraft());
    act(() => tree!.unmount());
    expect(storage.write).toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('tolerates read and write failures', async () => {
    jest.useFakeTimers();
    const storage = {
      read: jest.fn().mockRejectedValue(new Error('missing')),
      write: jest.fn().mockRejectedValue(new Error('disk full')),
    };
    let current: DraftController;
    function Probe() {
      current = useDraftController('profile', null, storage);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Probe)); });
    act(() => current!.setDraft('draft'));
    await act(async () => { jest.advanceTimersByTime(180); await Promise.resolve(); });
    act(() => tree!.unmount());
    jest.useRealTimers();
  });

  it('works without a persistence path and ignores cancelled reads', async () => {
    const path = helpers.getChatDraftsPath as jest.Mock;
    path.mockReturnValueOnce(null);
    let resolveRead: (value: string) => void = () => undefined;
    const storage = {
      read: jest.fn(() => new Promise<string>((resolve) => { resolveRead = resolve; })),
      write: jest.fn().mockResolvedValue(undefined),
    };
    function Probe() {
      useDraftController('profile', null, storage);
      return null;
    }
    let tree: ReactTestRenderer;
    await act(async () => { tree = renderer.create(React.createElement(Probe)); });
    expect(storage.read).not.toHaveBeenCalled();
    act(() => tree!.unmount());

    await act(async () => { tree = renderer.create(React.createElement(Probe)); });
    act(() => tree!.unmount());
    await act(async () => { resolveRead(JSON.stringify({ version: 2, entries: {} })); });
  });
});
