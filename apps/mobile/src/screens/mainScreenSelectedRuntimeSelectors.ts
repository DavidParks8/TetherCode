import { useCallback, useEffect } from 'react';
import { buildUserInputDrafts, resolveSnapshotCollaborationMode, appendRunEventHistory, upsertBridgeUiSurfaceList } from './mainScreenHelpers';
import type { MainScreenThreadRuntimeMutationsContext, MainScreenThreadRuntimeMutationsResult } from './mainScreenThreadRuntimeMutations';






export type MainScreenSelectedRuntimeSelectorsContext = MainScreenThreadRuntimeMutationsContext & MainScreenThreadRuntimeMutationsResult;

export function useMainScreenSelectedRuntimeSelectors(context: MainScreenSelectedRuntimeSelectorsContext) {
  const {
    api,
    approvalController,
    bridgeUiSurfaceSnapshotsRef,
    cacheThreadPendingApproval,
    chatIdRef,
    chatPlanSnapshotsRef,
    onChatContextChange,
    onChatOpeningStateChange,
    openingChatId,
    persistenceController,
    runWatchdogUntilRef,
    scheduleRunWatchdogExpiry,
    selectedChat,
    setActiveBridgeUiSurfaces,
    setActiveCommands,
    setActivePlan,
    setActiveTurnId,
    setActivity,
    setBridgeCapabilities,
    setChatPlanSnapshotsLoaded,
    setPendingApproval,
    setPendingUserInputRequest,
    setResolvingUserInput,
    setRunWatchdogNow,
    setSelectedCollaborationMode,
    setStreamingText,
    setUserInputDrafts,
    setUserInputError,
    threadRuntimeSnapshotsRef,
    upsertThreadRuntimeSnapshot,
  } = context;


  const applyThreadRuntimeSnapshot = useCallback(
    (threadId: string) => {
      if (!threadId) {
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        setSelectedCollaborationMode('default');
        return;
      }

      const snapshot = threadRuntimeSnapshotsRef.current[threadId];
      if (!snapshot) {
        setActivePlan(null);
        setActiveBridgeUiSurfaces([]);
        setSelectedCollaborationMode('default');
        return;
      }

      setSelectedCollaborationMode(resolveSnapshotCollaborationMode(snapshot));
      if (snapshot.activeCommands !== undefined) {
        setActiveCommands(snapshot.activeCommands);
      }
      if (snapshot.streamingText !== undefined) {
        setStreamingText(snapshot.streamingText);
      }
      if (snapshot.pendingApproval !== undefined) {
        setPendingApproval(snapshot.pendingApproval);
      }
      if (snapshot.pendingUserInputRequest !== undefined) {
        setPendingUserInputRequest(snapshot.pendingUserInputRequest);
        setUserInputDrafts(
          snapshot.pendingUserInputRequest
            ? buildUserInputDrafts(snapshot.pendingUserInputRequest)
            : {}
        );
        setUserInputError(null);
        setResolvingUserInput(false);
      }
      setActivePlan(snapshot.plan ?? null);
      setActiveBridgeUiSurfaces(snapshot.bridgeUiSurfaces ?? []);
      if (snapshot.activeTurnId !== undefined) {
        setActiveTurnId(snapshot.activeTurnId);
      }
      if (snapshot.activity) {
        setActivity(snapshot.activity);
      }
      if (
        typeof snapshot.runWatchdogUntil === 'number' &&
        snapshot.runWatchdogUntil > runWatchdogUntilRef.current
      ) {
        runWatchdogUntilRef.current = snapshot.runWatchdogUntil;
        setRunWatchdogNow(Date.now());
        scheduleRunWatchdogExpiry(snapshot.runWatchdogUntil);
      }
    },
    [scheduleRunWatchdogExpiry]
  );

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const snapshots = await persistenceController.loadPlanSnapshots();
      if (cancelled) return;
      chatPlanSnapshotsRef.current = snapshots;
      for (const [threadId, plan] of Object.entries(snapshots)) {
        upsertThreadRuntimeSnapshot(threadId, () => ({ plan }));
      }
      if (chatIdRef.current) applyThreadRuntimeSnapshot(chatIdRef.current);
      setChatPlanSnapshotsLoaded(true);
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyThreadRuntimeSnapshot, persistenceController, upsertThreadRuntimeSnapshot]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
        const persisted = await persistenceController.loadBridgeUiSurfaces();
        if (cancelled) return;
        const nextSnapshots = { ...persisted };
        for (const [threadId, surfaces] of Object.entries(
          bridgeUiSurfaceSnapshotsRef.current
        )) {
          nextSnapshots[threadId] = surfaces.reduce(
            (merged, surface) => upsertBridgeUiSurfaceList(merged, surface),
            nextSnapshots[threadId] ?? []
          );
        }

        bridgeUiSurfaceSnapshotsRef.current = nextSnapshots;
        for (const [threadId, surfaces] of Object.entries(nextSnapshots)) {
          upsertThreadRuntimeSnapshot(threadId, (previous) => ({
            bridgeUiSurfaces: (previous.bridgeUiSurfaces ?? []).reduce(
              (merged, surface) => upsertBridgeUiSurfaceList(merged, surface),
              surfaces
            ),
          }));
        }
        if (chatIdRef.current) {
          applyThreadRuntimeSnapshot(chatIdRef.current);
        }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [applyThreadRuntimeSnapshot, persistenceController, upsertThreadRuntimeSnapshot]);

  const refreshPendingApprovalsForThread = useCallback(
    async (threadId: string) => {
      try {
        const match = await approvalController.findForThread(threadId);
        cacheThreadPendingApproval(threadId, match);
        if (chatIdRef.current === threadId) {
          setPendingApproval(match);
          if (match) {
            setActivity({
              tone: 'idle',
              title: 'Waiting for approval',
              detail: match.command ?? match.kind,
            });
          }
        }
      } catch {
        // Best effort hydration for externally-started turns.
      }
    },
    [approvalController, cacheThreadPendingApproval]
  );

  const pushActiveCommand = useCallback(
    (threadId: string, eventType: string, detail: string) => {
      setActiveCommands((prev) =>
        appendRunEventHistory(prev, threadId, eventType, detail)
      );
    },
    []
  );

  useEffect(() => {
    onChatContextChange?.(selectedChat);
  }, [onChatContextChange, selectedChat]);

  useEffect(() => {
    onChatOpeningStateChange?.(openingChatId);
  }, [onChatOpeningStateChange, openingChatId]);

  useEffect(() => {
    let cancelled = false;

    const loadBridgeCapabilities = async () => {
      try {
        const capabilities = await api.readBridgeCapabilities();
        if (!cancelled) {
          setBridgeCapabilities(capabilities);
        }
      } catch {
        if (!cancelled) {
          setBridgeCapabilities(null);
        }
      }
    };

    void loadBridgeCapabilities();
    return () => {
      cancelled = true;
    };
  }, [api]);

  return {
    applyThreadRuntimeSnapshot,
    refreshPendingApprovalsForThread,
    pushActiveCommand,
  };
}

export type MainScreenSelectedRuntimeSelectorsResult = ReturnType<typeof useMainScreenSelectedRuntimeSelectors>;
