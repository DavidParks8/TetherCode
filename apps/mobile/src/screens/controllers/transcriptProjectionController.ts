import type { Chat, ChatMessage } from '../../api/types';
import { filterReasoningMessagesForEngine } from '../mainScreenHelpers';
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

export function projectTranscript({
  chat,
  parentChat,
  showToolCalls,
  threadStatuses,
  liveAssistantText,
  now = () => new Date().toISOString(),
}: {
  chat: Chat;
  parentChat: Chat | null;
  showToolCalls: boolean;
  threadStatuses: ReadonlyMap<string, Chat['status']>;
  liveAssistantText?: string | null;
  now?: () => string;
}): TranscriptProjection {
  const child = getVisibleTranscriptMessages(
    filterReasoningMessagesForEngine(chat.messages, chat.engine),
    showToolCalls
  );
  const inherited =
    chat.parentThreadId && parentChat
      ? trimInheritedParentMessages(
          getVisibleTranscriptMessages(
            filterReasoningMessagesForEngine(parentChat.messages, parentChat.engine),
            showToolCalls
          ),
          child,
          chat.id
        )
      : { messages: child, hiddenInheritedMessageCount: 0 };
  let messages = syncVisibleSubAgentStatuses(inherited.messages, threadStatuses);
  const liveText = liveAssistantText?.trim();
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (liveText && !latestAssistant?.content.trim().endsWith(liveText)) {
    messages = [
      ...messages,
      {
        id: `live-assistant-${chat.id}`,
        role: 'assistant',
        content: liveText,
        createdAt: now(),
      },
    ];
  }
  return {
    messages,
    items: buildTranscriptDisplayItems(messages),
    hiddenInheritedMessageCount: inherited.hiddenInheritedMessageCount,
  };
}
