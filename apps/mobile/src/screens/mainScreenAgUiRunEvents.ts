import { parseAgUiEventNotification, updateAgUiLiveAssistantMessages } from '../api/agUi';
import type { RpcNotification } from '../api/types';
import { type ActivityState, RUN_WATCHDOG_MS } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';


export function processAgUiRunEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null
): void {
  const {
    setLiveAssistantByThread,
    scheduleAgentThreadsRefresh,
    schedulePinnedScrollToBottom,
    clearLiveReasoningMessage,
    planItemTurnIdByThreadRef,
    upsertThreadRuntimeSnapshot,
    registerTurnStarted,
    setError,
    setActiveTurnId,
    setActiveCommands,
    setActivity,
    bumpRunWatchdog,
    cacheThreadTurnState,
    cacheThreadActivity,
    stopRequestedRef,
    threadReasoningBuffersRef,
    bumpAgentRuntimeRevision,
    clearRunWatchdog,
    setStreamingText,
    setPendingUserInputRequest,
    setUserInputDrafts,
    setUserInputError,
    setResolvingUserInput,
    setStoppingTurn,
    hadCommandRef,
    reasoningSummaryRef,
    reasoningBufferRef,
    appendStopSystemMessageIfNeeded,
    setSelectedChat,
    setPendingPlanImplementationPrompts,
    clearPendingPlanImplementationPrompt,
    loadChat,
  } = context;

      const agUiEnvelope = parseAgUiEventNotification(event);
      if (agUiEnvelope) {
        const agUiEvent = agUiEnvelope.event;
        setLiveAssistantByThread((previous) =>
          updateAgUiLiveAssistantMessages(previous, agUiEnvelope)
        );
        if (
          agUiEvent.type === 'CUSTOM' &&
          agUiEvent.name === 'tethercode.dev/subagent'
        ) {
          scheduleAgentThreadsRefresh(agUiEnvelope.threadId);
          if (agUiEnvelope.threadId === currentId) {
            schedulePinnedScrollToBottom(true);
          }
          return;
        }
        if (agUiEvent.type === 'TEXT_MESSAGE_CONTENT') {
          if (agUiEnvelope.threadId === currentId) {
            schedulePinnedScrollToBottom(true);
          }
          return;
        }
        if (agUiEvent.type === 'RUN_STARTED') {
          const sourceTurnId = agUiEnvelope.sourceTurnId ?? agUiEnvelope.runId;
          clearLiveReasoningMessage(agUiEnvelope.threadId);
          delete planItemTurnIdByThreadRef.current[agUiEnvelope.threadId];
          upsertThreadRuntimeSnapshot(agUiEnvelope.threadId, () => ({
            activeCommands: [],
            streamingText: null,
          }));
          if (agUiEnvelope.threadId === currentId) {
            registerTurnStarted(agUiEnvelope.threadId, sourceTurnId);
            setError(null);
            setActiveTurnId(sourceTurnId);
            setActiveCommands([]);
            setActivity({ tone: 'running', title: 'Working' });
            bumpRunWatchdog();
          } else {
            cacheThreadTurnState(agUiEnvelope.threadId, {
              activeTurnId: sourceTurnId,
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(agUiEnvelope.threadId, {
              tone: 'running',
              title: 'Working',
            });
          }
          return;
        }
        if (agUiEvent.type === 'RUN_FINISHED' || agUiEvent.type === 'RUN_ERROR') {
          const failed = agUiEvent.type === 'RUN_ERROR';
          const interruptedByUser = failed &&
            ['interrupted', 'cancelled', 'canceled', 'aborted'].includes(agUiEvent.code ?? '') &&
            stopRequestedRef.current;
          const planTurnId = planItemTurnIdByThreadRef.current[agUiEnvelope.threadId] ?? null;
          delete planItemTurnIdByThreadRef.current[agUiEnvelope.threadId];
          clearLiveReasoningMessage(agUiEnvelope.threadId);
          delete threadReasoningBuffersRef.current[agUiEnvelope.threadId];
          const terminalActivity: ActivityState = failed
            ? interruptedByUser
              ? { tone: 'complete', title: 'Turn stopped' }
              : { tone: 'error', title: 'Turn failed', detail: agUiEvent.message }
            : { tone: 'complete', title: 'Turn completed' };
          upsertThreadRuntimeSnapshot(agUiEnvelope.threadId, () => ({
            activity: terminalActivity,
            activeCommands: [],
            streamingText: null,
            pendingUserInputRequest: null,
            activeTurnId: null,
            runWatchdogUntil: 0,
          }));
          bumpAgentRuntimeRevision();
          if (agUiEnvelope.threadId === currentId) {
            clearRunWatchdog();
            setActiveCommands([]);
            setStreamingText(null);
            setPendingUserInputRequest(null);
            setUserInputDrafts({});
            setUserInputError(null);
            setResolvingUserInput(false);
            setActiveTurnId(null);
            setStoppingTurn(false);
            stopRequestedRef.current = false;
            hadCommandRef.current = false;
            reasoningSummaryRef.current = {};
            reasoningBufferRef.current = '';
            setError(failed && !interruptedByUser ? agUiEvent.message : null);
            if (interruptedByUser) {
              appendStopSystemMessageIfNeeded();
            }
            setActivity(terminalActivity);
            const terminalStatusAt = new Date().toISOString();
            setSelectedChat((previous) =>
              previous?.id === agUiEnvelope.threadId
                ? {
                    ...previous,
                    status: failed && !interruptedByUser ? 'error' : 'complete',
                    updatedAt: terminalStatusAt,
                    statusUpdatedAt: terminalStatusAt,
                    lastError: failed && !interruptedByUser ? agUiEvent.message : undefined,
                  }
                : previous
            );
            if (!failed && planTurnId) {
              setPendingPlanImplementationPrompts((previous) => ({
                ...previous,
                [agUiEnvelope.threadId]: {
                  threadId: agUiEnvelope.threadId,
                  turnId: planTurnId,
                },
              }));
            } else {
              clearPendingPlanImplementationPrompt(agUiEnvelope.threadId);
            }
            loadChat(agUiEnvelope.threadId).catch(() => {});
          }
          return;
        }
        return;
      }
}
