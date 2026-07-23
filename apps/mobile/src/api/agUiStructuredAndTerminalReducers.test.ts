import { EventType } from '@ag-ui/core';

import { createAgUiThreadMessageState, type AgUiEventEnvelope } from './agUi';
import {
  findMessage,
  markRunTerminal,
  markTerminal,
  reduceStructuredMessageContent,
  reduceSubagentActivity,
  reduceToolContent,
  reduceToolText,
  toolCall,
  updateEncryptedValue,
} from './agUiStructuredAndTerminalReducers';
import type { AgUiThreadMessageState } from './agUiMessagesState';
import type { ChatMessage } from './types';

function createState(overrides: Partial<AgUiThreadMessageState> = {}): AgUiThreadMessageState {
  return {
    ...createAgUiThreadMessageState(),
    ...overrides,
  };
}

function createEnvelope(
  overrides: Partial<AgUiEventEnvelope> = {}
): AgUiEventEnvelope {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    event: {
      type: EventType.CUSTOM,
      name: 'test/custom',
      value: {},
      timestamp: 1_700_000_000_000,
    },
    ...overrides,
  } as AgUiEventEnvelope;
}

describe('agUiStructuredAndTerminalReducers', () => {
  describe('reduceStructuredMessageContent', () => {
    it('uses fallback id and assistant role when messageId and role are missing', () => {
      const next = reduceStructuredMessageContent(
        createState(),
        createEnvelope({ runId: 'run-fallback' }),
        { content: { type: 'text', text: 'hello' } }
      );

      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({
        id: 'run-fallback:content',
        role: 'assistant',
        content: 'hello',
      });
    });

    it('maps thought to reasoning and appends/merges ordered parts', () => {
      const state = createState({
        messages: [{
          id: 'm1',
          role: 'reasoning',
          content: 'alpha',
          createdAt: '2024-01-01T00:00:00.000Z',
          parts: [{ type: 'text', text: 'alpha' }],
        } as ChatMessage],
      });

      const next = reduceStructuredMessageContent(
        state,
        createEnvelope(),
        { messageId: 'm1', role: 'thought', content: { type: 'text', text: ' + beta' } }
      );

      expect(next.messages[0]).toMatchObject({
        id: 'm1',
        role: 'reasoning',
        content: 'alpha + beta',
      });
      expect(next.messages[0]?.parts).toEqual([{ type: 'text', text: 'alpha + beta' }]);
    });

    it('maps user role and preserves non-text structured parts', () => {
      const next = reduceStructuredMessageContent(
        createState(),
        createEnvelope(),
        {
          messageId: 'user-1',
          role: 'user',
          content: { type: 'resourceLink', uri: 'file:///tmp/a.txt', name: 'a.txt' },
        }
      );

      expect(next.messages[0]).toMatchObject({
        id: 'user-1',
        role: 'user',
        content: '[file: file:///tmp/a.txt] a.txt',
      });
      expect(next.messages[0]?.parts).toEqual([
        { type: 'resourceLink', uri: 'file:///tmp/a.txt', name: 'a.txt' },
      ]);
    });
  });

  describe('reduceToolText', () => {
    it('returns unchanged state for invalid payloads and subagent tool calls', () => {
      const state = createState({ subagentToolCallIds: { sub: true } });
      const envelope = createEnvelope();

      expect(reduceToolText(state, envelope, null)).toBe(state);
      expect(reduceToolText(state, envelope, { toolCallId: 't1', revision: 'r1', content: 4 })).toBe(state);
      expect(reduceToolText(state, envelope, { toolCallId: 'sub', revision: 'r1', content: 'x' })).toBe(state);
    });

    it('returns unchanged state for duplicate revision', () => {
      const state = createState({ toolTextRevisionByCallId: { tc1: 'rev-1' } });

      const next = reduceToolText(state, createEnvelope(), {
        toolCallId: 'tc1',
        revision: 'rev-1',
        content: 'ignored',
      });

      expect(next).toBe(state);
    });

    it('creates a new tool result and appends structured text when available', () => {
      const state = createState({ structuredTextByCallId: { tc2: '[terminal]\nout' } });

      const next = reduceToolText(state, createEnvelope(), {
        toolCallId: 'tc2',
        revision: 'rev-2',
        content: 'plain',
      });

      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({
        id: 'tool-result:tc2',
        role: 'tool',
        toolCallId: 'tc2',
        content: 'plain\n[terminal]\nout',
      });
      expect(next.toolTextRevisionByCallId.tc2).toBe('rev-2');
    });

    it('updates an existing mapped tool-result message', () => {
      const state = createState({
        messages: [{
          id: 'msg-tool-1',
          role: 'tool',
          toolCallId: 'tc3',
          content: 'old',
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
        toolResultMessageIdByCallId: { tc3: 'msg-tool-1' },
      });

      const next = reduceToolText(state, createEnvelope(), {
        toolCallId: 'tc3',
        revision: 'rev-3',
        content: 'new',
      });

      expect(next.messages[0]).toMatchObject({ id: 'msg-tool-1', content: 'new' });
      expect(next.toolTextRevisionByCallId.tc3).toBe('rev-3');
    });
  });

  describe('reduceToolContent', () => {
    it('returns unchanged state for subagent tool calls and duplicate revisions', () => {
      const subagentState = createState({ subagentToolCallIds: { tcA: true } });
      expect(
        reduceToolContent(subagentState, createEnvelope(), {
          toolCallId: 'tcA',
          revision: 'rev-a',
          content: [{ type: 'text', text: 'ignored' }],
        })
      ).toBe(subagentState);

      const duplicateState = createState({ structuredRevisionByCallId: { tcB: 'rev-b' } });
      expect(
        reduceToolContent(duplicateState, createEnvelope(), {
          toolCallId: 'tcB',
          revision: 'rev-b',
          content: [{ type: 'text', text: 'ignored' }],
        })
      ).toBe(duplicateState);
    });

    it('handles unknown toolCallId, missing revision, and empty structured payload', () => {
      const next = reduceToolContent(createState(), createEnvelope(), {
        content: [],
        locations: [],
      });

      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({
        id: 'tool-result:unknown',
        role: 'tool',
        toolCallId: 'unknown',
        content: '',
      });
      expect(next.structuredRevisionByCallId.unknown).toBe(JSON.stringify({ content: [], locations: [] }));
      expect(next.structuredTextByCallId.unknown).toBe('');
    });

    it('replaces prior structured suffix when revising structured content', () => {
      const state = createState({
        messages: [{
          id: 'tool-result:tc4',
          role: 'tool',
          toolCallId: 'tc4',
          content: 'base line\nold structured',
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
        toolResultMessageIdByCallId: { tc4: 'tool-result:tc4' },
        structuredTextByCallId: { tc4: 'old structured' },
      });

      const next = reduceToolContent(state, createEnvelope(), {
        toolCallId: 'tc4',
        revision: 'rev-4',
        content: [{ type: 'text', text: 'new structured' }],
      });

      expect(next.messages[0]).toMatchObject({ content: 'base line\nnew structured' });
      expect(next.structuredTextByCallId.tc4).toBe('new structured');
      expect(next.structuredRevisionByCallId.tc4).toBe('rev-4');
    });

    it('keeps existing text unchanged when previous structured suffix does not match', () => {
      const state = createState({
        messages: [{
          id: 'tool-result:tc5',
          role: 'tool',
          toolCallId: 'tc5',
          content: 'existing text',
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
        toolResultMessageIdByCallId: { tc5: 'tool-result:tc5' },
        structuredTextByCallId: { tc5: 'different previous structured' },
      });

      const next = reduceToolContent(state, createEnvelope(), {
        toolCallId: 'tc5',
        revision: 'rev-5',
        content: [{ type: 'text', text: 'next structured' }],
      });

      expect(next.messages[0]).toMatchObject({ content: 'existing text\nnext structured' });
    });
  });

  describe('reduceSubagentActivity', () => {
    it('returns unchanged state when receiver ids are invalid or empty', () => {
      const state = createState();
      const next = reduceSubagentActivity(state, createEnvelope(), {
        toolCallId: 'tc-sub-1',
        receiverThreadIds: ['', null, 3],
      });
      expect(next).toBe(state);
    });

    it('deduplicates receiver ids, removes generic tool messages, and marks subagent tool', () => {
      const state = createState({
        messages: [
          {
            id: 'tool-call:tc-sub-2',
            role: 'assistant',
            content: '',
            toolCalls: [toolCall('tc-sub-2', 'spawnAgent', '{}')],
            createdAt: '2024-01-01T00:00:00.000Z',
          } as ChatMessage,
          {
            id: 'tool-result:tc-sub-2',
            role: 'tool',
            toolCallId: 'tc-sub-2',
            content: 'old',
            createdAt: '2024-01-01T00:00:01.000Z',
          } as ChatMessage,
          {
            id: 'subagent:tc-sub-2',
            role: 'activity',
            activityType: 'tethercode.subagent',
            content: { text: 'stale' },
            createdAt: '2024-01-01T00:00:02.000Z',
          } as ChatMessage,
        ],
      });

      const next = reduceSubagentActivity(state, createEnvelope(), {
        toolCallId: 'tc-sub-2',
        tool: 'spawnAgent',
        senderThreadId: 'sender-1',
        receiverThreadIds: ['receiver-1', 'receiver-1', 'receiver-2', ''],
        agentStatus: 'completed',
        resultPreview: 'done',
      });

      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({
        id: 'subagent:tc-sub-2',
        role: 'activity',
        activityType: 'tethercode.subagent',
      });
      const content = next.messages[0]?.role === 'activity' ? next.messages[0].content.text : '';
      expect(content).toContain('Spawned sub-agent');
      expect(content).toContain('Status: completed');
      expect(content).toContain('Result: done');
      expect(next.subagentToolCallIds['tc-sub-2']).toBe(true);

      const meta = next.messages[0]?.role === 'activity' ? next.messages[0].content.subAgent : undefined;
      expect(meta).toMatchObject({
        senderThreadId: 'sender-1',
        receiverThreadIds: ['receiver-1', 'receiver-2'],
        toolCallId: 'tc-sub-2',
      });
    });

    it('uses unknown tool id fallback and spawning text for non-completed status', () => {
      const next = reduceSubagentActivity(createState(), createEnvelope(), {
        receiverThreadIds: ['receiver-x'],
        agentStatus: 'running',
      });

      expect(next.subagentToolCallIds.unknown).toBe(true);
      const message = next.messages[0];
      expect(message).toMatchObject({ id: 'subagent:unknown', role: 'activity' });
      if (message?.role === 'activity') {
        expect(message.content.text).toContain('Spawning sub-agent');
      }
    });
  });

  describe('markTerminal and markRunTerminal', () => {
    it('marks terminal ids once and avoids duplicates', () => {
      const state = createState({ terminalMessageIds: ['m1'] });
      expect(markTerminal(state, 'm1')).toBe(state);
      expect(markTerminal(state, 'm2').terminalMessageIds).toEqual(['m1', 'm2']);
    });

    it('marks all messages for a run and no-ops when run has no messages', () => {
      const state = createState({
        runByMessageId: { m1: 'run-a', m2: 'run-a', m3: 'run-b' },
        terminalMessageIds: ['m2'],
      });

      const marked = markRunTerminal(state, 'run-a');
      expect(marked.terminalMessageIds).toEqual(['m2', 'm1']);
      expect(markRunTerminal(state, 'run-missing')).toBe(state);
    });
  });

  describe('updateEncryptedValue', () => {
    it('updates message encryptedValue for existing messages and no-ops when missing', () => {
      const state = createState({
        messages: [{
          id: 'msg-enc',
          role: 'assistant',
          content: 'hi',
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
        runByMessageId: { 'msg-enc': 'run-enc' },
      });

      const next = updateEncryptedValue(state, 'msg-enc', 'cipher-1', 'message');
      expect(next.messages[0]).toMatchObject({ id: 'msg-enc', encryptedValue: 'cipher-1' });
      expect(updateEncryptedValue(state, 'missing', 'cipher-2', 'message')).toBe(state);
    });

    it('updates matching tool call encryptedValue and no-ops on missing or non-assistant container', () => {
      const assistantState = createState({
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          toolCalls: [
            toolCall('tool-1', 'search', '{}'),
            toolCall('tool-2', 'open', '{}'),
          ],
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
        toolCallMessageIdByCallId: { 'tool-1': 'assistant-1' },
        runByMessageId: { 'assistant-1': 'run-a' },
      });

      const updated = updateEncryptedValue(assistantState, 'tool-1', 'enc-tool-1', 'tool-call');
      const calls = updated.messages[0]?.role === 'assistant' ? updated.messages[0].toolCalls : [];
      expect(calls?.find((call) => call.id === 'tool-1')?.encryptedValue).toBe('enc-tool-1');
      expect(calls?.find((call) => call.id === 'tool-2')?.encryptedValue).toBeUndefined();

      expect(updateEncryptedValue(assistantState, 'missing', 'x', 'tool-call')).toBe(assistantState);

      const nonAssistantState = createState({
        messages: [{
          id: 'tool-container',
          role: 'tool',
          toolCallId: 'tool-9',
          content: '',
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
        toolCallMessageIdByCallId: { 'tool-9': 'tool-container' },
      });
      expect(updateEncryptedValue(nonAssistantState, 'tool-9', 'enc-tool-9', 'tool-call')).toBe(nonAssistantState);
    });
  });

  describe('findMessage and toolCall', () => {
    it('finds existing messages and returns undefined for misses', () => {
      const state = createState({
        messages: [{
          id: 'find-me',
          role: 'assistant',
          content: 'hello',
          createdAt: '2024-01-01T00:00:00.000Z',
        } as ChatMessage],
      });

      expect(findMessage(state, 'find-me')?.id).toBe('find-me');
      expect(findMessage(state, 'missing')).toBeUndefined();
    });

    it('builds a function tool call payload', () => {
      expect(toolCall('id-1', 'search', '{"q":"term"}')).toEqual({
        id: 'id-1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"term"}' },
      });
    });
  });
});