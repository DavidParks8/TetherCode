import type { Chat } from '../../../api/types';
import { projectTranscript } from '../transcriptProjectionController';

const chat: Chat = {
  id: 'child', title: 'Child', status: 'running', createdAt: '', updatedAt: '',
  statusUpdatedAt: '', lastMessagePreview: '', parentThreadId: 'parent',
  messages: [{ id: 'u', role: 'user', content: 'child prompt', createdAt: '' }],
};

describe('transcriptProjectionController', () => {
  it('projects inherited messages and a non-duplicate live assistant message', () => {
    const parent = {
      ...chat,
      id: 'parent',
      parentThreadId: undefined,
      messages: [{ id: 'p', role: 'user' as const, content: 'parent prompt', createdAt: '' }],
    };
    const projection = projectTranscript({
      chat,
      parentChat: parent,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{ messageId: 'live', text: 'live answer' }],
      now: () => 'now',
    });
    expect(projection.messages.at(-1)).toMatchObject({
      id: 'live',
      content: 'live answer',
      createdAt: 'now',
    });
    expect(projection.items).toHaveLength(projection.messages.length);
  });

  it('uses only child messages when no parent is available', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: false,
      threadStatuses: new Map(),
    });
    expect(projection.messages.map((message) => message.id)).toEqual(['u']);
    expect(projection.hiddenInheritedMessageCount).toBe(0);
  });

  it('renders live reasoning and tool projection entries', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [
        { messageId: 'reasoning', text: 'Thinking', role: 'system', systemKind: 'reasoning' },
        { messageId: 'tool:read', text: 'Read file\ndone', role: 'system', systemKind: 'tool' },
      ],
    });
    expect(projection.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reasoning', role: 'system', systemKind: 'reasoning' }),
      expect.objectContaining({ id: 'tool:read', role: 'system', systemKind: 'tool' }),
    ]));
  });

  it('does not append blank or duplicate live assistant text', () => {
    const withAssistant = {
      ...chat,
      parentThreadId: undefined,
      messages: [
        ...chat.messages,
        { id: 'a', role: 'assistant' as const, content: 'answer', createdAt: '' },
      ],
    };
    for (const liveAssistantMessage of [
      { messageId: 'live', text: '  ' },
      { messageId: 'a', text: 'answer' },
    ]) {
      expect(projectTranscript({
        chat: withAssistant,
        parentChat: null,
        showToolCalls: true,
        threadStatuses: new Map(),
        liveAssistantMessages: [liveAssistantMessage],
      }).messages).toHaveLength(2);
    }
  });

  it('replaces changing live text and suppresses it after persistence catches up', () => {
    const first = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{ messageId: 'live', text: 'Hello' }],
    });
    const second = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{ messageId: 'live', text: 'Hello there' }],
    });
    expect(first.messages.at(-1)?.content).toBe('Hello');
    expect(second.messages.at(-1)?.content).toBe('Hello there');
    expect(second.messages).toHaveLength(first.messages.length);

    const persisted = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'live', role: 'assistant', content: 'Hello there', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{ messageId: 'live', text: 'Hello there' }],
    });
    expect(persisted.messages.at(-1)?.id).toBe('live');
  });

  it('updates a matching persisted assistant message instead of appending a duplicate', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'assistant-1', role: 'assistant', content: 'Hello', createdAt: 'before' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{
        messageId: 'agent-alpha:run::item::assistant-1',
        text: 'Hello there',
        parts: [
          { type: 'text', text: 'Hello ' },
          { type: 'image', url: 'https://example.test/image.png' },
          { type: 'text', text: 'there' },
        ],
      }],
    });

    expect(projection.messages).toHaveLength(2);
    expect(projection.messages.at(-1)).toMatchObject({
      id: 'assistant-1',
      content: 'Hello there',
      createdAt: 'before',
      parts: [
        { type: 'text', text: 'Hello ' },
        { type: 'image', url: 'https://example.test/image.png' },
        { type: 'text', text: 'there' },
      ],
    });
  });

  it('does not regress a newer persisted message with stale live text', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'assistant-1', role: 'assistant', content: 'Hello there', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{
        runId: 'run-1',
        messageId: 'run-1::item::assistant-1',
        text: 'Hello',
      }],
    });

    expect(projection.messages.at(-1)?.content).toBe('Hello there');
  });

  it('suppresses only an explicitly replaced live message', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'final', role: 'assistant', content: 'Corrected', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [
        { runId: 'run-1', messageId: 'streamed', text: 'Stale' },
        {
          runId: 'run-1',
          messageId: 'final',
          text: 'Corrected',
          replacesMessageId: 'streamed',
        },
      ],
    });

    expect(projection.messages.map((message) => message.content)).toEqual([
      'child prompt',
      'Corrected',
    ]);
  });

  it('projects multiple live assistant messages from one run in order', () => {
    const projection = projectTranscript({
      chat: { ...chat, parentThreadId: undefined },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [
        { runId: 'run-1', messageId: 'first', text: 'First' },
        { runId: 'run-1', messageId: 'second', text: 'Second' },
      ],
    });

    expect(projection.messages.map((message) => message.content)).toEqual([
      'child prompt',
      'First',
      'Second',
    ]);
  });

  it('lets a terminal persisted snapshot override longer retained live text', () => {
    const projection = projectTranscript({
      chat: {
        ...chat,
        parentThreadId: undefined,
        messages: [
          ...chat.messages,
          { id: 'answer', role: 'assistant', content: 'Final', createdAt: '' },
        ],
      },
      parentChat: null,
      showToolCalls: true,
      threadStatuses: new Map(),
      liveAssistantMessages: [{
        runId: 'run-1',
        messageId: 'answer',
        text: 'Final stale suffix',
        terminal: true,
      }],
    });

    expect(projection.messages.at(-1)?.content).toBe('Final');
  });
});
