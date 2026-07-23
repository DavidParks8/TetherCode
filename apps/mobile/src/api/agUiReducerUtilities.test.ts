import type { ToolCall } from '@ag-ui/core';

import {
  appendOrderedPart,
  applyJsonPatch,
  cloneJson,
  getPatchParent,
  isChatMessagePart,
  nonEmptyString,
  record,
  renderOrderedParts,
  timestampIso,
  unescapePointer,
  upsertToolCall,
} from './agUiReducerUtilities';
import type { ChatMessagePart } from './types';

describe('agUiReducerUtilities', () => {
  describe('upsertToolCall', () => {
    it('appends when id is not present', () => {
      const existing: ToolCall[] = [
        {
          id: 'existing',
          type: 'function',
          function: { name: 'alpha', arguments: '{"a":1}' },
        },
      ];

      const next = upsertToolCall(existing, 'new', 'beta', '{"b":2}');

      expect(next).toHaveLength(2);
      expect(next[0]).toEqual(existing[0]);
      expect(next[1]).toEqual({
        id: 'new',
        type: 'function',
        function: { name: 'beta', arguments: '{"b":2}' },
      });
    });

    it('replaces matching entry when id already exists', () => {
      const existing: ToolCall[] = [
        {
          id: 'keep',
          type: 'function',
          function: { name: 'alpha', arguments: '{"a":1}' },
        },
        {
          id: 'replace-me',
          type: 'function',
          function: { name: 'old', arguments: '{"old":true}' },
        },
      ];

      const next = upsertToolCall(existing, 'replace-me', 'newName', '{"x":1}');

      expect(next).toEqual([
        existing[0],
        {
          id: 'replace-me',
          type: 'function',
          function: { name: 'newName', arguments: '{"x":1}' },
        },
      ]);
    });
  });

  describe('appendOrderedPart', () => {
    it('returns unchanged for null, empty text, and invalid text part', () => {
      const initial: ChatMessagePart[] = [{ type: 'text', text: 'A' }];

      expect(appendOrderedPart(initial, null)).toEqual(initial);
      expect(appendOrderedPart(initial, { type: 'text', text: '' })).toEqual(initial);
      expect(appendOrderedPart(initial, { type: 'text', text: 3 })).toEqual(initial);
    });

    it('appends valid non-text part when text extraction is null', () => {
      const initial: ChatMessagePart[] = [{ type: 'text', text: 'A' }];

      expect(appendOrderedPart(initial, { type: 'image', uri: 'file:///img.png' })).toEqual([
        { type: 'text', text: 'A' },
        { type: 'image', uri: 'file:///img.png' },
      ]);
    });

    it('adds text as new part when previous part is non-text', () => {
      const initial: ChatMessagePart[] = [{ type: 'image', uri: 'file:///img.png' }];

      expect(appendOrderedPart(initial, { type: 'text', text: ' tail' })).toEqual([
        { type: 'image', uri: 'file:///img.png' },
        { type: 'text', text: ' tail' },
      ]);
    });

    it('merges text with previous trailing text part', () => {
      const initial: ChatMessagePart[] = [{ type: 'text', text: 'Hello' }];

      expect(appendOrderedPart(initial, { type: 'text', text: ' world' })).toEqual([
        { type: 'text', text: 'Hello world' },
      ]);
    });
  });

  describe('renderOrderedParts', () => {
    it('renders parts in order and filters falsey rendered values', () => {
      const parts = [
        undefined as unknown as ChatMessagePart,
        { type: 'text', text: 'first' } as ChatMessagePart,
        { type: 'resourceLink', uri: 'file:///tmp/a.txt', name: 'a.txt' } as ChatMessagePart,
      ];

      expect(renderOrderedParts(parts)).toBe('first\n[file: file:///tmp/a.txt] a.txt');
    });
  });

  describe('isChatMessagePart', () => {
    it('accepts every supported kind and rejects invalid shapes', () => {
      expect(isChatMessagePart({ type: 'text', text: 'ok' })).toBe(true);
      expect(isChatMessagePart({ type: 'text', text: 1 })).toBe(false);
      expect(isChatMessagePart({ type: 'image' })).toBe(true);
      expect(isChatMessagePart({ type: 'audio' })).toBe(true);
      expect(isChatMessagePart({ type: 'resourceLink', uri: 'file:///x' })).toBe(true);
      expect(isChatMessagePart({ type: 'resourceLink', uri: 9 })).toBe(false);
      expect(isChatMessagePart({ type: 'resource', resource: { uri: 'x' } })).toBe(true);
      expect(isChatMessagePart({ type: 'resource', resource: null })).toBe(false);
      expect(isChatMessagePart({ type: 'other' })).toBe(false);
      expect(isChatMessagePart('text')).toBe(false);
      expect(isChatMessagePart(null)).toBe(false);
    });
  });

  describe('applyJsonPatch', () => {
    it('handles root add/replace/remove and undefined root default', () => {
      expect(applyJsonPatch(undefined, [{ op: 'add', path: '/x', value: 1 }])).toEqual({ x: 1 });
      expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '', value: { b: 2 } }])).toEqual({ b: 2 });
      expect(applyJsonPatch({ a: 1 }, [{ op: 'add', path: '', value: [1, 2] }])).toEqual([1, 2]);
      expect(applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '' }])).toBeNull();
    });

    it('handles object and array add/replace/remove including array append', () => {
      const start = {
        obj: { a: 1, b: 2 },
        arr: [10, 20],
      };
      const patched = applyJsonPatch(start, [
        { op: 'add', path: '/obj/c', value: 3 },
        { op: 'replace', path: '/obj/a', value: 11 },
        { op: 'remove', path: '/obj/b' },
        { op: 'add', path: '/arr/-', value: 30 },
        { op: 'add', path: '/arr/1', value: 15 },
        { op: 'replace', path: '/arr/0', value: 5 },
        { op: 'remove', path: '/arr/2' },
      ]);

      expect(patched).toEqual({
        obj: { a: 11, c: 3 },
        arr: [5, 15, 30],
      });
      expect(start).toEqual({
        obj: { a: 1, b: 2 },
        arr: [10, 20],
      });
    });

    it('ignores invalid operations, paths, indices, and missing parents', () => {
      const start = { obj: { a: 1 }, arr: [1] };
      const patched = applyJsonPatch(start, [
        { op: 'move', path: '/obj/a', value: 2 },
        { op: 'add', path: null, value: 2 },
        { op: 'add', value: 2 },
        { op: 'add', path: '/missing/x', value: 2 },
        { op: 'add', path: '/arr/not-a-number', value: 2 },
        { op: 'replace', path: '/arr/not-a-number', value: 9 },
        { op: 'remove', path: '/arr/not-a-number' },
      ] as unknown[]);

      expect(patched).toEqual(start);
    });

    it('supports escaped pointer segments for object keys', () => {
      const start = { 'a/b': { 'til~de': 1 } };
      const patched = applyJsonPatch(start, [
        { op: 'replace', path: '/a~1b/til~0de', value: 2 },
        { op: 'add', path: '/a~1b/new~1key', value: 3 },
        { op: 'remove', path: '/a~1b/new~1key' },
      ]);

      expect(patched).toEqual({ 'a/b': { 'til~de': 2 } });
    });
  });

  describe('getPatchParent', () => {
    it('resolves parents in objects and arrays', () => {
      expect(getPatchParent({ a: { b: 1 } }, ['a'])).toEqual({ b: 1 });
      expect(getPatchParent([{ x: 1 }], ['0'])).toEqual({ x: 1 });
      expect(getPatchParent({ root: [1, 2] }, ['root'])).toEqual([1, 2]);
    });

    it('returns null when traversal encounters invalid parent chain', () => {
      expect(getPatchParent({ a: 1 }, ['a', 'b'])).toBeNull();
      expect(getPatchParent([], ['2', 'x'])).toBeNull();
      expect(getPatchParent(null, ['x'])).toBeNull();
    });
  });

  describe('cloneJson', () => {
    it('returns undefined as-is and deep clones json values', () => {
      expect(cloneJson(undefined)).toBeUndefined();

      const source = { a: { b: [1, 2] } };
      const cloned = cloneJson(source);
      expect(cloned).toEqual(source);
      expect(cloned).not.toBe(source);
      expect(cloned.a).not.toBe(source.a);
    });
  });

  describe('unescapePointer', () => {
    it('unescapes slash and tilde pointer tokens', () => {
      expect(unescapePointer('a~1b')).toBe('a/b');
      expect(unescapePointer('til~0de')).toBe('til~de');
      expect(unescapePointer('combo~1x~0y')).toBe('combo/x~y');
    });
  });

  describe('timestampIso', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2025-01-02T03:04:05.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('uses provided valid timestamp and falls back for invalid or undefined values', () => {
      expect(timestampIso(0)).toBe('1970-01-01T00:00:00.000Z');
      expect(timestampIso(Number.NaN)).toBe('2025-01-02T03:04:05.000Z');
      expect(timestampIso()).toBe('2025-01-02T03:04:05.000Z');
    });
  });

  describe('nonEmptyString', () => {
    it('trims and returns null for empty or non-string values', () => {
      expect(nonEmptyString('  hello  ')).toBe('hello');
      expect(nonEmptyString('   ')).toBeNull();
      expect(nonEmptyString(2)).toBeNull();
      expect(nonEmptyString(null)).toBeNull();
    });
  });

  describe('record', () => {
    it('returns object records and rejects arrays/primitives/null', () => {
      const value = { a: 1 };
      expect(record(value)).toBe(value);
      expect(record([])).toBeNull();
      expect(record('x')).toBeNull();
      expect(record(null)).toBeNull();
    });
  });
});