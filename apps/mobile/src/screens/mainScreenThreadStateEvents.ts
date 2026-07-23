import type { RpcNotification } from '../api/types';
import { RUN_WATCHDOG_MS, toRecord, readString, readNumber, describeStartedToolEvent, extractNotificationThreadId } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';


export function processThreadStateEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null
): void {
  const {
    clearRunWatchdog,
    setActiveCommands,
    setStreamingText,
    setLiveAssistantByThread,
    setActiveTurnId,
    setPendingApproval,
    setPendingUserInputRequest,
    setActivePlan,
    setActiveBridgeUiSurfaces,
    replaceThreadBridgeUiSurfaces,
    reasoningSummaryRef,
    reasoningBufferRef,
    recoverReplayGap,
    agentDetailThreadId,
    scheduleAgentThreadsRefresh,
    setSelectedChat,
    loadChat,
    agentDetailChat,
    loadAgentDetail,
    readThreadContextUsage,
    cacheThreadContextUsage,
    planItemTurnIdByThreadRef,
    cacheThreadTurnState,
    cacheThreadActiveCommand,
    cacheThreadActivity,
    bumpRunWatchdog,
    pushActiveCommand,
    setActivity,
    setSelectedCollaborationMode,
    upsertLiveReasoningMessage,
  } = context;

      if (event.method === 'bridge/events/snapshotRequired') {
        const params = toRecord(event.params);
        const resumeAfterEventId = readNumber(params?.resumeAfterEventId);
        const reason = readString(params?.reason);
        clearRunWatchdog();
        setActiveCommands([]);
        setStreamingText(null);
        setLiveAssistantByThread({});
        setActiveTurnId(null);
        setPendingApproval(null);
        setPendingUserInputRequest(null);
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        if (currentId) {
          replaceThreadBridgeUiSurfaces(currentId, []);
        }
        reasoningSummaryRef.current = {};
        reasoningBufferRef.current = '';
        recoverReplayGap(resumeAfterEventId, reason !== 'recoveryOverflow');
        if (agentDetailThreadId) {
          scheduleAgentThreadsRefresh(agentDetailThreadId);
        }
        return;
      }


      if (event.method === 'thread/name/updated') {
        const params = toRecord(event.params);
        const threadId = extractNotificationThreadId(params);
        if (!threadId || threadId !== currentId) {
          return;
        }

        const threadName =
          readString(params?.threadName) ?? readString(params?.thread_name);
        if (threadName && threadName.trim()) {
          setSelectedChat((prev) =>
            prev
              ? {
                  ...prev,
                  title: threadName,
                }
              : prev
          );
        } else {
          loadChat(threadId, { preserveRuntimeState: true }).catch(() => {});
        }
        return;
      }

      if (event.method === 'thread/subagent/adopted') {
        const params = toRecord(event.params);
        const threadId = extractNotificationThreadId(params);
        if (threadId && threadId === agentDetailThreadId && !agentDetailChat) {
          void loadAgentDetail(threadId, true);
        }
        return;
      }


      if (event.method === 'thread/tokenUsage/updated') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        const contextUsage = readThreadContextUsage(params);
        if (!threadId || !contextUsage) {
          return;
        }
        cacheThreadContextUsage(threadId, contextUsage);
        if (threadId === currentId) {
        }
        return;
      }

      if (event.method === 'item/started') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        const item = toRecord(params?.item);
        const itemType = readString(item?.type);
        const itemTurnId =
          readString(params?.turnId) ?? readString(params?.turn_id) ?? null;
        if (itemType === 'plan' && itemTurnId) {
          planItemTurnIdByThreadRef.current[threadId] = itemTurnId;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          const startedToolEvent = describeStartedToolEvent(item);
          if (startedToolEvent) {
            cacheThreadActiveCommand(
              threadId,
              startedToolEvent.eventType,
              startedToolEvent.detail
            );
          }
          if (itemType === 'commandExecution') {
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'fileChange') {
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'mcpToolCall') {
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }

          if (itemType === 'plan') {
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Planning',
            });
            return;
          }

          if (itemType === 'reasoning') {
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
            return;
          }
          return;
        }

        bumpRunWatchdog();
        const startedToolEvent = describeStartedToolEvent(item);
        if (startedToolEvent) {
          cacheThreadActiveCommand(
            threadId,
            startedToolEvent.eventType,
            startedToolEvent.detail
          );
          pushActiveCommand(
            threadId,
            startedToolEvent.eventType,
            startedToolEvent.detail
          );
        }

        if (itemType === 'commandExecution') {
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (itemType === 'fileChange') {
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (itemType === 'mcpToolCall') {
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (itemType === 'toolCall') {
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        if (itemType === 'plan') {
          setSelectedCollaborationMode('plan');
          setActivity({
            tone: 'running',
            title: 'Planning',
          });
          return;
        }

        if (itemType === 'reasoning') {
          upsertLiveReasoningMessage(threadId);
          setActivity({
            tone: 'running',
            title: 'Working',
          });
          return;
        }
      }
}
