import type { RpcNotification } from '../api/types';
import { mergeChatSummaryPreservingMessages } from './mainScreenChatState';
import {
  RUN_WATCHDOG_MS,
  EXTERNAL_RUNNING_STATUS_HINTS,
  EXTERNAL_ERROR_STATUS_HINTS,
  EXTERNAL_COMPLETE_STATUS_HINTS,
  toRecord,
  readString,
  buildNextPlanStateFromUpdate,
  toTurnPlanUpdate,
  describeCompletedToolEvent,
  extractNotificationThreadId,
  extractExternalStatusHint,
  isChatSummaryLikelyRunning,
} from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';
export function processTurnLifecycleEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null,
  pendingApprovalId: string | undefined,
  pendingUserInputRequestId: string | undefined
): void {
  const {
    cacheThreadTurnState,
    cacheThreadActivity,
    cacheThreadPlan,
    setSelectedCollaborationMode,
    bumpRunWatchdog,
    setActivePlan,
    setActivity,
    reasoningSummaryRef,
    cacheThreadActiveCommand,
    pushActiveCommand,
    hadCommandRef,
    api,
    chatIdRef,
    setSelectedChat,
    runWatchdogUntilRef,
    clearRunWatchdog,
    setActiveTurnId,
    setStoppingTurn,
    setActiveCommands,
    setStreamingText,
    reasoningBufferRef,
    scheduleExternalStatusFullSync,
    refreshPendingApprovalsForThread,
  } = context;

      if (event.method === 'item/commandExecution/outputDelta') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        bumpRunWatchdog();
        setActivity((prev) =>
          prev.tone === 'running' && prev.title === 'Working'
            ? prev
            : {
                tone: 'running',
                title: 'Working',
              }
        );
        return;
      }

      if (event.method === 'item/mcpToolCall/progress') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        bumpRunWatchdog();
        setActivity((prev) =>
          prev.tone === 'running' && prev.title === 'Working'
            ? prev
            : {
                tone: 'running',
                title: 'Working',
              }
        );
        return;
      }

      if (event.method === 'item/commandExecution/terminalInteraction') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        bumpRunWatchdog();
        setActivity({
          tone: 'running',
          title: 'Working',
        });
        return;
      }

      if (event.method === 'turn/plan/updated') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id) ?? currentId;
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Planning',
          });
          const planUpdate = toTurnPlanUpdate(params, threadId);
          if (planUpdate) {
            cacheThreadPlan(threadId, (previous) =>
              buildNextPlanStateFromUpdate(previous, planUpdate)
            );
          }
          return;
        }

        setSelectedCollaborationMode('plan');
        bumpRunWatchdog();
        const planUpdate = toTurnPlanUpdate(params, threadId);
        if (planUpdate) {
          setActivePlan((prev) => buildNextPlanStateFromUpdate(prev, planUpdate));
          cacheThreadPlan(threadId, (previous) =>
            buildNextPlanStateFromUpdate(previous, planUpdate)
          );
        }
        setActivity({
          tone: 'running',
          title: 'Planning',
        });
        return;
      }

      if (event.method === 'turn/diff/updated') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Working',
          });
          return;
        }

        bumpRunWatchdog();
        setActivity({
          tone: 'running',
          title: 'Working',
        });
        return;
      }

      // Command completion blocks
      if (event.method === 'item/completed') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }

        const item = toRecord(params?.item);
        const itemType = readString(item?.type);
        if (threadId !== currentId) {
          const completedToolEvent = describeCompletedToolEvent(item);
          if (completedToolEvent) {
            cacheThreadActiveCommand(
              threadId,
              completedToolEvent.eventType,
              completedToolEvent.detail
            );
          }
          if (itemType === 'commandExecution') {
            const status = readString(item?.status);
            const failed = status === 'failed' || status === 'error';
            cacheThreadActivity(threadId, {
              tone: failed ? 'error' : 'running',
              title: failed ? 'Turn failed' : 'Working',
            });
          }
          return;
        }

        const completedToolEvent = describeCompletedToolEvent(item);
        if (completedToolEvent) {
          cacheThreadActiveCommand(
            threadId,
            completedToolEvent.eventType,
            completedToolEvent.detail
          );
          pushActiveCommand(
            threadId,
            completedToolEvent.eventType,
            completedToolEvent.detail
          );
        }

        if (itemType === 'commandExecution') {
          const status = readString(item?.status);
          const failed = status === 'failed' || status === 'error';
          hadCommandRef.current = true;
          setActivity({
            tone: failed ? 'error' : 'running',
            title: failed ? 'Turn failed' : 'Working',
          });
        }
        if (itemType === 'toolCall') {
        }
        return;
      }

      // Externally-started turns (e.g. from CLI) broadcast this event.
      // Do a lightweight status check — don't call loadChat() which would
      // wipe streaming text, active commands, and the watchdog.
      if (event.method === 'thread/status/changed') {
        const params = toRecord(event.params);
        const threadId = extractNotificationThreadId(params);
        const statusHint = extractExternalStatusHint(params);
        const hasExplicitRunningStatus = Boolean(
          statusHint && EXTERNAL_RUNNING_STATUS_HINTS.has(statusHint)
        );
        const hasExplicitTerminalStatus = Boolean(
          statusHint &&
            (EXTERNAL_ERROR_STATUS_HINTS.has(statusHint) ||
              EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint))
        );
        if (threadId && threadId === currentId) {
          if (!hasExplicitTerminalStatus) {
            bumpRunWatchdog();
            setActivity((prev) =>
              prev.tone === 'running'
                ? prev
                : { tone: 'running', title: 'Working' }
            );
          }

          api
            .getChatSummary(threadId)
            .then((summary) => {
              if (chatIdRef.current !== threadId) {
                return; // user switched away
              }

              setSelectedChat((prev) => {
                if (!prev || prev.id !== summary.id) {
                  return prev;
                }
                return mergeChatSummaryPreservingMessages(prev, summary);
              });

              const shouldPreserveRunning =
                !hasExplicitTerminalStatus &&
                runWatchdogUntilRef.current > Date.now();
              const shouldShowRunning =
                hasExplicitRunningStatus ||
                isChatSummaryLikelyRunning(summary) ||
                shouldPreserveRunning;

              if (shouldShowRunning) {
                bumpRunWatchdog();
                setActivity((prev) =>
                  prev.tone === 'running'
                    ? prev
                    : { tone: 'running', title: 'Working' }
                );
              } else {
                clearRunWatchdog();
                cacheThreadTurnState(threadId, {
                  activeTurnId: null,
                  runWatchdogUntil: 0,
                });
                setActiveTurnId(null);
                setStoppingTurn(false);
                if (!pendingApprovalId && !pendingUserInputRequestId) {
                  setActiveCommands([]);
                  setStreamingText(null);
                  reasoningSummaryRef.current = {};
                  reasoningBufferRef.current = '';
                  hadCommandRef.current = false;
                  setActivity(() => {
                    if (statusHint && EXTERNAL_COMPLETE_STATUS_HINTS.has(statusHint)) {
                      return {
                        tone: 'complete',
                        title: 'Turn completed',
                      };
                    }

                    return summary.status === 'error'
                      ? {
                          tone: 'error',
                          title: 'Turn failed',
                          detail: summary.lastError ?? undefined,
                        }
                      : summary.status === 'complete'
                        ? {
                            tone: 'complete',
                            title: 'Turn completed',
                          }
                        : {
                            tone: 'idle',
                            title: 'Ready',
                          };
                  });
                }
              }
            })
            .catch(() => {});

          scheduleExternalStatusFullSync(threadId);
        } else if (threadId) {
          if (!hasExplicitTerminalStatus) {
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Working',
            });
          }
          void refreshPendingApprovalsForThread(threadId);
        }
        return;
      }
}
