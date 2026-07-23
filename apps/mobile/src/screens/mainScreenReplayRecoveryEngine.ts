import { useCallback } from 'react';
import { RUN_WATCHDOG_MS, toPersistedActivePlanState, isChatLikelyRunning } from './mainScreenHelpers';
import { fetchReplayRecoverySnapshot, ReplayRecoveryProtocolError, type ReplayRecoverySnapshot } from './controllers/replayRecoveryController';
import { getTranscriptContinuationState } from './controllers/transcriptContinuationController';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { MainScreenComposerSubmitActionsContext, MainScreenComposerSubmitActionsResult } from './mainScreenComposerSubmitActions';






export type MainScreenReplayRecoveryEngineContext = MainScreenComposerSubmitActionsContext & MainScreenComposerSubmitActionsResult;

export function useMainScreenReplayRecoveryEngine(context: MainScreenReplayRecoveryEngineContext) {
  const {
    agentDetailThreadId,
    agentRootThreadIdRef,
    api,
    applyThreadRuntimeSnapshot,
    bridgeUiSurfaceSnapshotsRef,
    bumpAgentRuntimeRevision,
    chatIdRef,
    chatPlanSnapshotsRef,
    mergeChatWithPendingOptimisticMessages,
    pendingOptimisticQueuedMessagesRef,
    pendingOptimisticUserMessagesRef,
    readThreadContextUsage,
    relatedAgentThreads,
    replayRecoveryAbortControllerRef,
    replayRecoveryEpochResetPendingRef,
    replayRecoveryGenerationRef,
    replayRecoveryRetryTimerRef,
    setActiveBridgeUiSurfaces,
    setActiveCommands,
    setActivePlan,
    setActiveTurnId,
    setBridgeCapabilities,
    setError,
    setLiveAssistantByThread,
    setPendingApproval,
    setPendingUserInputRequest,
    setSelectedChat,
    setStoppingTurn,
    setStreamingText,
    setTranscriptContinuationState,
    setUserInputDrafts,
    threadRuntimeSnapshotsRef,
    ws,
  } = context;


  const installReplayRecoverySnapshot = useCallback(
    (snapshot: ReplayRecoverySnapshot) => {
      const approvalsByThread = new Map(
        snapshot.approvals.map((approval) => [approval.threadId, approval] as const)
      );
      const userInputsByThread = new Map(
        snapshot.userInputs.map((request) => [request.threadId, request] as const)
      );
      setBridgeCapabilities(snapshot.capabilities);
      setLiveAssistantByThread({});

      for (const { chat, queue } of snapshot.threads) {
        api.rememberChat(chat);
        const pendingThreadApproval = approvalsByThread.get(chat.id) ?? null;
        const pendingThreadUserInput = userInputsByThread.get(chat.id) ?? null;
        const running = isChatLikelyRunning(chat);
        const plan = chat.latestPlan
          ? toPersistedActivePlanState(chat.latestPlan, chat.updatedAt)
          : null;
        threadRuntimeSnapshotsRef.current[chat.id] = {
          activity: pendingThreadApproval
            ? { tone: 'idle', title: 'Waiting for approval' }
            : pendingThreadUserInput
              ? { tone: 'idle', title: 'Waiting for input' }
              : running
                ? { tone: 'running', title: 'Working' }
                : chat.status === 'error'
                  ? { tone: 'error', title: 'Turn failed', detail: chat.lastError }
                  : chat.status === 'complete'
                    ? { tone: 'complete', title: 'Turn completed' }
                    : { tone: 'idle', title: 'Ready' },
          activeCommands: [],
          latestCommand: null,
          streamingText: null,
          pendingApproval: pendingThreadApproval,
          pendingUserInputRequest: pendingThreadUserInput,
          bridgeUiSurfaces: [],
          queuedMessages: [...queue.pendingSteers, ...queue.items],
          pendingSteerMessageIds: queue.pendingSteers.map((item) => item.id),
          waitingForToolCalls: queue.waitingForToolCalls,
          steeringInFlight: queue.steeringInFlight,
          queuedMessageError: queue.lastError,
          contextUsage: readThreadContextUsage(chat.acpUsage),
          plan,
          activeTurnId: chat.activeTurnId ?? chat.acpActive?.sourceTurnId ?? null,
          runWatchdogUntil: running ? Date.now() + RUN_WATCHDOG_MS : 0,
          updatedAtMs: Date.now(),
        };
        if (plan) {
          chatPlanSnapshotsRef.current[chat.id] = plan;
        } else {
          delete chatPlanSnapshotsRef.current[chat.id];
        }
        bridgeUiSurfaceSnapshotsRef.current[chat.id] = [];
      }

      const selectedId = chatIdRef.current;
      const selectedSnapshot = snapshot.threads.find(({ chat }) => chat.id === selectedId);
      if (selectedSnapshot) {
        const selected = mergeChatWithPendingOptimisticMessages(selectedSnapshot.chat);
        setSelectedChat((previous) =>
          previous?.id === selected.id ? resolveEquivalentChat(previous, selected) : selected
        );
        setTranscriptContinuationState(getTranscriptContinuationState(selected));
        setStoppingTurn(false);
        setError(null);
        applyThreadRuntimeSnapshot(selected.id);
      } else {
        setActiveCommands([]);
        setStreamingText(null);
        setPendingApproval(null);
        setPendingUserInputRequest(null);
        setUserInputDrafts({});
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        setActiveTurnId(null);
      }
      bumpAgentRuntimeRevision();
    },
    [
      api,
      applyThreadRuntimeSnapshot,
      bumpAgentRuntimeRevision,
      mergeChatWithPendingOptimisticMessages,
      readThreadContextUsage,
    ]
  );

  const recoverReplayGap = useCallback(
    (resumeAfterEventId: number | null, acknowledge: boolean) => {
      const generation = replayRecoveryGenerationRef.current + 1;
      replayRecoveryGenerationRef.current = generation;
      replayRecoveryAbortControllerRef.current?.abort();
      const abortController = new AbortController();
      replayRecoveryAbortControllerRef.current = abortController;
      if (replayRecoveryRetryTimerRef.current) {
        clearTimeout(replayRecoveryRetryTimerRef.current);
        replayRecoveryRetryTimerRef.current = null;
      }

      const trackedThreadIds = () => [
        chatIdRef.current,
        agentDetailThreadId,
        agentRootThreadIdRef.current,
        ...relatedAgentThreads.map((thread) => thread.id),
        ...(api.peekChats()?.map((thread) => thread.id) ?? []),
        ...(api.peekAllChats()?.map((thread) => thread.id) ?? []),
        ...Object.keys(threadRuntimeSnapshotsRef.current),
        ...Object.keys(pendingOptimisticUserMessagesRef.current),
        ...Object.keys(pendingOptimisticQueuedMessagesRef.current),
      ];

      const attempt = async () => {
        try {
          const snapshot = await fetchReplayRecoverySnapshot(
            api,
            trackedThreadIds(),
            abortController.signal
          );
          if (generation !== replayRecoveryGenerationRef.current) return;
          installReplayRecoverySnapshot(snapshot);
          replayRecoveryEpochResetPendingRef.current = false;
          if (acknowledge && resumeAfterEventId !== null) {
            ws.acknowledgeSnapshotRecovery(resumeAfterEventId);
          }
        } catch (recoveryError) {
          if (generation !== replayRecoveryGenerationRef.current) return;
          if (recoveryError instanceof ReplayRecoveryProtocolError) {
            replayRecoveryGenerationRef.current += 1;
            replayRecoveryAbortControllerRef.current = null;
            if (replayRecoveryEpochResetPendingRef.current) {
              setError(
                'Replay recovery exceeded the bridge protocol limit after reconnect. Reopen the connection after reducing loaded thread history.'
              );
              return;
            }
            replayRecoveryEpochResetPendingRef.current = true;
            ws.resetRecoveryEpoch();
            return;
          }
          replayRecoveryRetryTimerRef.current = setTimeout(() => {
            replayRecoveryRetryTimerRef.current = null;
            void attempt();
          }, 1_000);
        }
      };
      void attempt();
    },
    [
      agentDetailThreadId,
      api,
      installReplayRecoverySnapshot,
      relatedAgentThreads,
      ws,
    ]
  );

  return {
    installReplayRecoverySnapshot,
    recoverReplayGap,
  };
}

export type MainScreenReplayRecoveryEngineResult = ReturnType<typeof useMainScreenReplayRecoveryEngine>;
