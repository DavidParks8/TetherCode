import { useEffect } from 'react';
import type { RpcNotification } from '../api/types';
import { parseAgUiEventNotification } from '../api/agUi';
import { toRecord, extractNotificationThreadId, extractNotificationParentThreadId } from './mainScreenHelpers';
import type { MainScreenAgentThreadSelectorStateContext, MainScreenAgentThreadSelectorStateResult } from './mainScreenAgentThreadSelectorState';






export type MainScreenAgentThreadEventBootstrapContext = MainScreenAgentThreadSelectorStateContext & MainScreenAgentThreadSelectorStateResult;

export function useMainScreenAgentThreadEventBootstrap(context: MainScreenAgentThreadEventBootstrapContext) {
  const {
    agentRootThreadIdRef,
    chatIdRef,
    scheduleAgentThreadsRefresh,
    ws,
  } = context;


  useEffect(() => {
    return ws.onEvent((event: RpcNotification) => {
      const agUi = parseAgUiEventNotification(event);
      const agUiLifecycle = agUi &&
        (agUi.event.type === 'RUN_STARTED' ||
          agUi.event.type === 'RUN_FINISHED' ||
          agUi.event.type === 'RUN_ERROR');
      if (
        event.method !== 'thread/started' &&
        event.method !== 'thread/name/updated' &&
        event.method !== 'thread/status/changed' &&
        !agUiLifecycle
      ) {
        return;
      }

      const currentThreadId = chatIdRef.current;
      const currentRootThreadId = agentRootThreadIdRef.current;
      if (!currentThreadId || !currentRootThreadId) {
        return;
      }

      const params = toRecord(event.params);
      const eventThreadId = agUi?.threadId ?? extractNotificationThreadId(params);
      const eventParentThreadId = extractNotificationParentThreadId(params);
      if (
        eventThreadId &&
        eventThreadId !== currentThreadId &&
        eventThreadId !== currentRootThreadId &&
        eventParentThreadId !== currentThreadId &&
        eventParentThreadId !== currentRootThreadId
      ) {
        return;
      }

      scheduleAgentThreadsRefresh(currentThreadId);
    });
  }, [scheduleAgentThreadsRefresh, ws]);

  return {};
}

export type MainScreenAgentThreadEventBootstrapResult = ReturnType<typeof useMainScreenAgentThreadEventBootstrap>;
