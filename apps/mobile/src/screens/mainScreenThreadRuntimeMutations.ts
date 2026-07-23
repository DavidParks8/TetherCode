import { useCallback } from 'react';
import type { BridgeUiSurface, BridgeThreadQueueState } from '../api/types';
import { type ActivePlanState, type ThreadContextUsage, mergeThreadContextUsage, upsertBridgeUiSurfaceList, removeBridgeUiSurfaceFromList } from './mainScreenHelpers';
import type { MainScreenRuntimeWatchdogSyncContext, MainScreenRuntimeWatchdogSyncResult } from './mainScreenRuntimeWatchdogSync';






export type MainScreenThreadRuntimeMutationsContext = MainScreenRuntimeWatchdogSyncContext & MainScreenRuntimeWatchdogSyncResult;

export function useMainScreenThreadRuntimeMutations(context: MainScreenThreadRuntimeMutationsContext) {
  const {
    bumpAgentRuntimeRevision,
    rememberBridgeUiSurfaceSnapshots,
    rememberChatPlanSnapshot,
    setPendingPlanImplementationPrompts,
    threadRuntimeSnapshotsRef,
    upsertThreadRuntimeSnapshot,
  } = context;


  const cacheThreadBridgeUiSurface = useCallback(
    (threadId: string, surface: BridgeUiSurface) => {
      upsertThreadRuntimeSnapshot(threadId, (previous) => ({
        bridgeUiSurfaces: upsertBridgeUiSurfaceList(
          previous.bridgeUiSurfaces ?? [],
          surface
        ),
      }));
      rememberBridgeUiSurfaceSnapshots(threadId, (previous) =>
        upsertBridgeUiSurfaceList(previous, surface)
      );
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot]
  );

  const removeThreadBridgeUiSurface = useCallback(
    (surfaceId: string, threadId?: string | null) => {
      if (threadId) {
        upsertThreadRuntimeSnapshot(threadId, (previous) => ({
          bridgeUiSurfaces: removeBridgeUiSurfaceFromList(
            previous.bridgeUiSurfaces ?? [],
            surfaceId
          ),
        }));
        rememberBridgeUiSurfaceSnapshots(threadId, (previous) =>
          removeBridgeUiSurfaceFromList(previous, surfaceId)
        );
      } else {
        for (const [snapshotThreadId, snapshot] of Object.entries(
          threadRuntimeSnapshotsRef.current
        )) {
          if (!snapshot.bridgeUiSurfaces?.some((surface) => surface.id === surfaceId)) {
            continue;
          }
          upsertThreadRuntimeSnapshot(snapshotThreadId, (previous) => ({
            bridgeUiSurfaces: removeBridgeUiSurfaceFromList(
              previous.bridgeUiSurfaces ?? [],
              surfaceId
            ),
          }));
          rememberBridgeUiSurfaceSnapshots(snapshotThreadId, (previous) =>
            removeBridgeUiSurfaceFromList(previous, surfaceId)
          );
        }
      }
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot]
  );

  const replaceThreadBridgeUiSurfaces = useCallback(
    (threadId: string, surfaces: BridgeUiSurface[]) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        bridgeUiSurfaces: surfaces,
      }));
      rememberBridgeUiSurfaceSnapshots(threadId, () => surfaces);
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, rememberBridgeUiSurfaceSnapshots, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadQueueState = useCallback(
    (threadId: string, queueState: BridgeThreadQueueState | null) => {
      upsertThreadRuntimeSnapshot(threadId, () => ({
        queuedMessages: queueState
          ? [...queueState.pendingSteers, ...queueState.items]
          : [],
        pendingSteerMessageIds: queueState?.pendingSteers.map((item) => item.id) ?? [],
        waitingForToolCalls: queueState?.waitingForToolCalls ?? false,
        steeringInFlight: queueState?.steeringInFlight ?? false,
        queuedMessageError: queueState?.lastError ?? null,
      }));
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadTurnState = useCallback(
    (
      threadId: string,
      options: {
        activeTurnId?: string | null;
        runWatchdogUntil?: number;
      }
    ) => {
      upsertThreadRuntimeSnapshot(threadId, () => options);
      bumpAgentRuntimeRevision();
    },
    [bumpAgentRuntimeRevision, upsertThreadRuntimeSnapshot]
  );

  const cacheThreadContextUsage = useCallback(
    (threadId: string, contextUsage: ThreadContextUsage | null) => {
      if (!contextUsage) {
        upsertThreadRuntimeSnapshot(threadId, () => ({
          contextUsage: null,
        }));
        return;
      }

      const previousContextUsage =
        threadRuntimeSnapshotsRef.current[threadId]?.contextUsage ?? null;
      const mergedContextUsage = mergeThreadContextUsage(previousContextUsage, contextUsage);

      upsertThreadRuntimeSnapshot(threadId, (previous) => {
        return {
          contextUsage: mergeThreadContextUsage(previous.contextUsage ?? null, mergedContextUsage),
        };
      });
    },
    [upsertThreadRuntimeSnapshot]
  );

  const cacheThreadPlan = useCallback(
    (
      threadId: string,
      nextPlan:
        | ActivePlanState
        | null
        | ((previous: ActivePlanState | null) => ActivePlanState | null)
    ) => {
      upsertThreadRuntimeSnapshot(threadId, (previous) => ({
        plan:
          typeof nextPlan === 'function'
            ? (
                nextPlan as (previous: ActivePlanState | null) => ActivePlanState | null
              )(previous.plan ?? null)
            : nextPlan,
      }));
      rememberChatPlanSnapshot(
        threadId,
        threadRuntimeSnapshotsRef.current[threadId]?.plan ?? null
      );
    },
    [rememberChatPlanSnapshot, upsertThreadRuntimeSnapshot]
  );

  const clearPendingPlanImplementationPrompt = useCallback((threadId: string) => {
    if (!threadId) {
      return;
    }

    setPendingPlanImplementationPrompts((prev) => {
      if (!(threadId in prev)) {
        return prev;
      }

      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  }, []);

  return {
    cacheThreadBridgeUiSurface,
    removeThreadBridgeUiSurface,
    replaceThreadBridgeUiSurfaces,
    cacheThreadQueueState,
    cacheThreadTurnState,
    cacheThreadContextUsage,
    cacheThreadPlan,
    clearPendingPlanImplementationPrompt,
  };
}

export type MainScreenThreadRuntimeMutationsResult = ReturnType<typeof useMainScreenThreadRuntimeMutations>;
