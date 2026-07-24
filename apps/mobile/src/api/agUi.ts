import { EventSchemas, EventType, type AGUIEvent } from '@ag-ui/core';

import type { RpcNotification } from './types';
import { SUPPORTED_AG_UI_EVENT_TYPES } from './agUiMessagesState';

export { renderAgUiCustomContent } from './agUiContent';
export {
  createAgUiThreadMessageState,
  reduceAgUiMessageState as updateAgUiLiveAssistantMessages,
} from './agUiMessages';
export type {
  AgUiMessageState as AgUiLiveAssistantMessages,
  AgUiThreadMessageState as AgUiLiveAssistantMessage,
} from './agUiMessages';

export interface AgUiEventEnvelope {
  threadId: string;
  runId: string;
  sourceTurnId?: string;
  event: AGUIEvent;
}

export function parseAgUiEventNotification(
  notification: RpcNotification
): AgUiEventEnvelope | null {
  if (notification.method !== 'bridge/agui.event') return null;
  const params = record(notification.params);
  const threadId = nonEmptyString(params?.threadId);
  const runId = nonEmptyString(params?.runId);
  const sourceTurnId = nonEmptyString(params?.sourceTurnId) ?? undefined;
  const parsedEvent = EventSchemas.safeParse(params?.event);
  if (!threadId || !runId || !parsedEvent.success) return null;
  const event = parsedEvent.data;
  if (!SUPPORTED_AG_UI_EVENT_TYPES.has(event.type)) return null;
  if (
    (event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED) &&
    (event.threadId !== threadId || event.runId !== runId)
  ) {
    return null;
  }
  return { threadId, runId, sourceTurnId, event };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
