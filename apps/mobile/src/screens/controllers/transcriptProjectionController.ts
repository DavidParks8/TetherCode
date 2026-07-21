import type { Chat, ChatMessage } from '../../api/types';
import { filterReasoningMessages } from '../mainScreenHelpers';
import { trimInheritedParentMessages } from '../subAgentTranscript';
import {
  buildTranscriptDisplayItems,
  getVisibleTranscriptMessages,
  syncVisibleSubAgentStatuses,
  type TranscriptDisplayItem,
} from '../transcriptMessages';

export interface TranscriptProjection {
  messages: ChatMessage[];
  items: TranscriptDisplayItem[];
  hiddenInheritedMessageCount: number;
}

export interface LiveAssistantMessage {
  runId?: string;
  messageId: string;
  text: string;
  role?: 'assistant' | 'user' | 'system';
  systemKind?: 'tool' | 'reasoning';
  replacesMessageId?: string;
  terminal?: boolean;
  parts?: ChatMessage['parts'];
}

export function projectTranscript({
  chat,
  parentChat,
  showToolCalls,
  threadStatuses,
  liveAssistantMessages,
  now = () => new Date().toISOString(),
}: {
  chat: Chat;
  parentChat: Chat | null;
  showToolCalls: boolean;
  threadStatuses: ReadonlyMap<string, Chat['status']>;
  liveAssistantMessages?: readonly LiveAssistantMessage[] | null;
  now?: () => string;
}): TranscriptProjection {
  const child = getVisibleTranscriptMessages(
    filterReasoningMessages(chat.messages),
    showToolCalls
  );
  const inherited =
    chat.parentThreadId && parentChat
      ? trimInheritedParentMessages(
          getVisibleTranscriptMessages(
            filterReasoningMessages(parentChat.messages),
            showToolCalls
          ),
          child,
          chat.id
        )
      : { messages: child, hiddenInheritedMessageCount: 0 };
  let messages = syncVisibleSubAgentStatuses(inherited.messages, threadStatuses);
  const liveMessages = liveAssistantMessages ?? [];
  const replacedMessageIds = new Set(
    liveMessages
      .map((message) => message.replacesMessageId)
      .filter((messageId): messageId is string => Boolean(messageId))
  );
  const persistedMatches = liveMessages.map((liveAssistantMessage) =>
    messages.find(
      (message) =>
        message.role === 'assistant' &&
        (message.id === liveAssistantMessage.messageId ||
          liveAssistantMessage.messageId.endsWith(`::item::${message.id}`))
    )
  );
  for (const [index, liveAssistantMessage] of liveMessages.entries()) {
    const liveText = liveAssistantMessage.text.trim();
    if (!liveText) {
      continue;
    }
    if (replacedMessageIds.has(liveAssistantMessage.messageId)) {
      continue;
    }
    const persistedLiveMessage = persistedMatches[index];
    if (persistedLiveMessage) {
      const persistedText = persistedLiveMessage.content.trim();
      if (
        !liveAssistantMessage.terminal &&
        liveText !== persistedText &&
        liveText.startsWith(persistedText)
      ) {
        messages = messages.map((message) =>
          message === persistedLiveMessage
            ? { ...message, content: liveText, parts: liveAssistantMessage.parts ?? message.parts }
            : message
        );
      }
    } else {
      messages = [
        ...messages,
        {
          id: liveAssistantMessage.messageId,
          role: liveAssistantMessage.role ?? 'assistant',
          content: liveText,
          parts: liveAssistantMessage.parts,
          systemKind: liveAssistantMessage.systemKind,
          createdAt: now(),
        },
      ];
    }
  }
  return {
    messages,
    items: buildTranscriptDisplayItems(messages),
    hiddenInheritedMessageCount: inherited.hiddenInheritedMessageCount,
  };
}
