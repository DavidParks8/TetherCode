import {
  createActivityMessage,
  getMessageText,
  getSubAgentMeta,
  getToolCallDisplayLines,
  SUBAGENT_ACTIVITY_TYPE,
} from './messages';
import type { ChatMessage } from './types';

describe('messages', () => {
  it('extracts text from user, assistant, tool, and activity messages', () => {
    const messages = [
      { id: 'assistant', role: 'assistant', content: 'Answer', createdAt: 'now' },
      {
        id: 'user',
        role: 'user',
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'image', url: 'image.png' },
          { type: 'text', text: 'world' },
        ],
        createdAt: 'now',
      },
      { id: 'tool', role: 'tool', content: 'Tool result', toolCallId: 'tool-1', createdAt: 'now' },
      createActivityMessage('activity', 'status', { text: 'Working' }, 'now'),
    ] as ChatMessage[];

    expect(messages.map(getMessageText)).toEqual([
      'Answer',
      'Hello world',
      'Tool result',
      'Working',
    ]);
  });

  it('reads sub-agent metadata only from matching activity messages', () => {
    const subAgent = { tool: 'spawnAgent', receiverThreadIds: ['child'] };
    const activity = createActivityMessage(
      'subagent',
      SUBAGENT_ACTIVITY_TYPE,
      { text: 'Spawned reviewer', subAgent },
      'now'
    );
    const otherActivity = createActivityMessage(
      'other',
      'status',
      { text: 'Working', subAgent },
      'now'
    );

    expect(getSubAgentMeta(activity)).toEqual(subAgent);
    expect(getSubAgentMeta(otherActivity)).toBeUndefined();
    expect(getSubAgentMeta({
      id: 'assistant', role: 'assistant', content: 'Answer', createdAt: 'now',
    })).toBeUndefined();
  });

  it('formats assistant tool calls and omits empty arguments', () => {
    const message = {
      id: 'assistant',
      role: 'assistant',
      content: '',
      createdAt: 'now',
      toolCalls: [
        {
          id: 'read',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' },
        },
        {
          id: 'status',
          type: 'function',
          function: { name: 'status', arguments: '{}' },
        },
      ],
    } as ChatMessage;

    expect(getToolCallDisplayLines(message)).toEqual([
      '• Called tool `read_file`\n  {"path":"README.md"}',
      '• Called tool `status`',
    ]);
    expect(getToolCallDisplayLines({
      id: 'user', role: 'user', content: 'Hello', createdAt: 'now',
    })).toEqual([]);
  });
});
