import { useCallback, useEffect } from 'react';
import type { PendingApproval, PendingUserInputRequest } from '../api/types';
import { env } from '../config';
import { type ActivityState, type ThreadRuntimeSnapshot, mergeStreamingDelta, appendRunEventHistory, isChatLikelyRunning } from './mainScreenHelpers';
import { resolveEquivalentChat } from './mainScreenChatState';
import type { MainScreenChatHydrationContext, MainScreenChatHydrationResult } from './mainScreenChatHydration';






export type MainScreenRuntimeWatchdogSyncContext = MainScreenChatHydrationContext & MainScreenChatHydrationResult;

export function useMainScreenRuntimeWatchdogSync(context: MainScreenRuntimeWatchdogSyncContext) {
  const {
    api,
    bumpAgentRuntimeRevision,
    bumpRunWatchdog,
    chatIdRef,
    externalStatusFullSyncInFlightRef,
    externalStatusFullSyncNextAllowedAtRef,
    externalStatusFullSyncQueuedThreadRef,
    externalStatusFullSyncTimerRef,
    mergeChatWithPendingOptimisticMessages,
    setActivity,
    setSelectedChat,
    threadRuntimeSnapshotsRef,
  } = context;


  const clearExternalStatusFullSync = useCallback(() => {
    const timer = externalStatusFullSyncTimerRef.current;
    if (!timer) {
      externalStatusFullSyncQueuedThreadRef.current = null;
      return;
    }
    clearTimeout(timer);
    externalStatusFullSyncTimerRef.current = null;
    externalStatusFullSyncQueuedThreadRef.current = null;
  }, []);

  const drainExternalStatusFullSyncQueue = useCallback(() => {
    if (externalStatusFullSyncInFlightRef.current) {
      return;
    }

    const queuedThreadId = externalStatusFullSyncQueuedThreadRef.current;
    if (!queuedThreadId) {
      return;
    }

    if (chatIdRef.current !== queuedThreadId) {
      externalStatusFullSyncQueuedThreadRef.current = null;
      return;
    }

    const waitMs = Math.max(
      0,
      externalStatusFullSyncNextAllowedAtRef.current - Date.now()
    );
    if (waitMs > 0) {
      if (!externalStatusFullSyncTimerRef.current) {
        externalStatusFullSyncTimerRef.current = setTimeout(() => {
          externalStatusFullSyncTimerRef.current = null;
          drainExternalStatusFullSyncQueue();
        }, waitMs);
      }
      return;
    }

    externalStatusFullSyncQueuedThreadRef.current = null;
    externalStatusFullSyncInFlightRef.current = true;
    externalStatusFullSyncNextAllowedAtRef.current =
      Date.now() + env.externalStatusFullSyncDebounceMs;

    api
      .getChat(queuedThreadId)
      .then((latest) => {
        const resolvedLatest = mergeChatWithPendingOptimisticMessages(latest);
        if (chatIdRef.current !== queuedThreadId) {
          return;
        }
        setSelectedChat((prev) => {
          if (!prev || prev.id !== resolvedLatest.id) {
            return prev;
          }
          return resolveEquivalentChat(prev, resolvedLatest);
        });
        if (isChatLikelyRunning(resolvedLatest)) {
          bumpRunWatchdog();
          setActivity((prev) =>
            prev.tone === 'running' ? prev : { tone: 'running', title: 'Working' }
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        externalStatusFullSyncInFlightRef.current = false;
        drainExternalStatusFullSyncQueue();
      });
  }, [api, bumpRunWatchdog, mergeChatWithPendingOptimisticMessages]);

  const scheduleExternalStatusFullSync = useCallback(
    (threadId: string) => {
      if (chatIdRef.current !== threadId) {
        return;
      }
      externalStatusFullSyncQueuedThreadRef.current = threadId;
      drainExternalStatusFullSyncQueue();
    },
    [drainExternalStatusFullSyncQueue]
  );

  useEffect(
    () => () => {
      clearExternalStatusFullSync();
    },
    [clearExternalStatusFullSync]
  );

  const upsertThreadRuntimeSnapshot = useCallback(
    (
      threadId: string,
      updater: (previous: ThreadRuntimeSnapshot) => Partial<ThreadRuntimeSnapshot>
    ) => {
      if (!threadId) {
        return;
      }

      const previous =
        threadRuntimeSnapshotsRef.current[threadId] ??
        ({
          updatedAtMs: Date.now(),
        } as ThreadRuntimeSnapshot);
      const nextPatch = updater(previous);

      threadRuntimeSnapshotsRef.current[threadId] = {
        ...previous,
        ...nextPatch,
        updatedAtMs: Date.now(),
      };
    },
    []
  );

  const cacheThreadActivity = useCallback(
    (threadId: string, nextActivity: ActivityState) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({ activity: nextActivity }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadStreamingDelta = useCallback(
    (threadId: string, delta: string) => {
      const normalized = delta.trim();
      if (!normalized) {
        return;
      }

      upsertThreadRuntimeSnapshot(threadId, (previous) => {
        const merged = mergeStreamingDelta(previous.streamingText ?? null, delta);
        return { streamingText: merged };
      });
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadActiveCommand = useCallback(
    (threadId: string, eventType: string, detail: string) => {
      upsertThreadRuntimeSnapshot(threadId, (previous) => {
        const activeCommands = appendRunEventHistory(
          previous.activeCommands ?? [],
          threadId,
          eventType,
          detail
        );
        return {
          activeCommands,
          latestCommand: activeCommands[activeCommands.length - 1] ?? previous.latestCommand ?? null,
        };
      });
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadPendingApproval = useCallback(
    (threadId: string, approval: PendingApproval | null) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        pendingApproval: approval,
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadPendingUserInputRequest = useCallback(
    (threadId: string, request: PendingUserInputRequest | null) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        pendingUserInputRequest: request,
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  return {
    clearExternalStatusFullSync,
    drainExternalStatusFullSyncQueue,
    scheduleExternalStatusFullSync,
    upsertThreadRuntimeSnapshot,
    cacheThreadActivity,
    cacheThreadStreamingDelta,
    cacheThreadActiveCommand,
    cacheThreadPendingApproval,
    cacheThreadPendingUserInputRequest,
  };
}

export type MainScreenRuntimeWatchdogSyncResult = ReturnType<typeof useMainScreenRuntimeWatchdogSync>;
