import { serializeDraftEntries, updateDraftEntries } from '../draftController';

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
    expect(JSON.parse(serializeDraftEntries(entries))).toEqual({ version: 1, entries: {} });
  });
});
