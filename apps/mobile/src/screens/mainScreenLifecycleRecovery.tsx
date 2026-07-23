import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import type { AppStateStatus } from 'react-native';
import { type AutoScrollState, APP_FOCUS_DISCONNECT_GRACE_MS, STREAMING_SCROLL_THROTTLE_MS } from './mainScreenHelpers';
import type { MainScreenCoreBootstrapContext, MainScreenCoreBootstrapResult } from './mainScreenCoreBootstrap';






export type MainScreenLifecycleRecoveryContext = MainScreenCoreBootstrapContext &
  MainScreenCoreBootstrapResult & {
    appStateRef?: MutableRefObject<AppStateStatus>;
    deferredDisconnectActivityTimeoutRef?: MutableRefObject<
      ReturnType<typeof setTimeout> | null
    >;
    lastAppForegroundedAtRef?: MutableRefObject<number>;
  };

export function useMainScreenLifecycleRecovery(context: MainScreenLifecycleRecoveryContext) {
  const {
    foregroundAgentRefreshHandleRef,
    genericRunningActivityTimeoutRef,
    heldActivityTimeoutRef,
    lastPinnedScrollAtRef,
    scheduledPinnedScrollTimeoutRef,
    scrollRef,
    scrollRetryTimeoutsRef,
    setActivity,
    setAgentRuntimeRevision,
    setBridgeRecoveryBannerVisible,
    setHeldActivity,
    setShowDelayedGenericRunningActivity,
    ws,
  } = context;

  const autoScrollStateRef = useRef<AutoScrollState>({
    shouldStickToBottom: true,
    isUserInteracting: false,
    isMomentumScrolling: false,
  });
  const loadChatRequestRef = useRef(0);
  const modelOptionsRequestRef = useRef(0);
  const agentThreadsRequestRef = useRef(0);
  const agentDetailRequestRef = useRef(0);
  const agentThreadsRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replayRecoveryGenerationRef = useRef(0);
  const replayRecoveryRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const replayRecoveryAbortControllerRef = useRef<AbortController | null>(null);
  const replayRecoveryEpochResetPendingRef = useRef(false);
  const openAgentThreadSelectorRef = useRef<(query?: string | null) => Promise<boolean>>(
    async () => false
  );
  const bumpAgentRuntimeRevision = useCallback(() => {
    setAgentRuntimeRevision((previous) => previous + 1);
  }, []);

  const clearDeferredDisconnectActivity = useCallback(() => {
    const deferredDisconnectActivityTimeoutRef =
      context.deferredDisconnectActivityTimeoutRef;
    if (!deferredDisconnectActivityTimeoutRef) {
      return;
    }
    if (deferredDisconnectActivityTimeoutRef.current) {
      clearTimeout(deferredDisconnectActivityTimeoutRef.current);
      deferredDisconnectActivityTimeoutRef.current = null;
    }
  }, []);

  const clearHeldActivity = useCallback(() => {
    if (heldActivityTimeoutRef.current) {
      clearTimeout(heldActivityTimeoutRef.current);
      heldActivityTimeoutRef.current = null;
    }
    setHeldActivity(null);
  }, []);

  const clearGenericRunningActivityDelay = useCallback(() => {
    if (genericRunningActivityTimeoutRef.current) {
      clearTimeout(genericRunningActivityTimeoutRef.current);
      genericRunningActivityTimeoutRef.current = null;
    }
    setShowDelayedGenericRunningActivity(false);
  }, []);

  const clearForegroundAgentRefresh = useCallback(() => {
    foregroundAgentRefreshHandleRef.current?.cancel?.();
    foregroundAgentRefreshHandleRef.current = null;
  }, []);

  const scheduleDisconnectActivity = useCallback(() => {
    clearDeferredDisconnectActivity();
    const appStateRef = context.appStateRef;
    const deferredDisconnectActivityTimeoutRef =
      context.deferredDisconnectActivityTimeoutRef;
    const lastAppForegroundedAtRef = context.lastAppForegroundedAtRef;
    if (
      !appStateRef ||
      !deferredDisconnectActivityTimeoutRef ||
      !lastAppForegroundedAtRef
    ) {
      return;
    }

    if (appStateRef.current !== 'active') {
      return;
    }

    const elapsedSinceForeground = Date.now() - lastAppForegroundedAtRef.current;
    const remainingGraceMs = Math.max(0, APP_FOCUS_DISCONNECT_GRACE_MS - elapsedSinceForeground);

    const showDisconnected = () => {
      deferredDisconnectActivityTimeoutRef.current = null;
      if (appStateRef.current !== 'active' || ws.isConnected) {
        return;
      }
      setBridgeRecoveryBannerVisible(true);
      setActivity({
        tone: 'error',
        title: 'Bridge disconnected',
        detail: 'Start the bridge to continue.',
      });
    };

    if (remainingGraceMs <= 0) {
      showDisconnected();
      return;
    }

    deferredDisconnectActivityTimeoutRef.current = setTimeout(showDisconnected, remainingGraceMs);
  }, [clearDeferredDisconnectActivity, ws]);

  const clearPendingScrollRetries = useCallback(() => {
    for (const timeoutId of scrollRetryTimeoutsRef.current) {
      clearTimeout(timeoutId);
    }
    scrollRetryTimeoutsRef.current = [];
    if (scheduledPinnedScrollTimeoutRef.current) {
      clearTimeout(scheduledPinnedScrollTimeoutRef.current);
      scheduledPinnedScrollTimeoutRef.current = null;
    }
  }, []);

  const scrollToBottomReliable = useCallback(
    (animated = true) => {
      clearPendingScrollRetries();
      const delays = [0, 70, 180, 320];
      scrollRetryTimeoutsRef.current = delays.map((delay, index) =>
        setTimeout(() => {
          requestAnimationFrame(() => {
            scrollRef.current?.scrollToOffset({
              offset: 0,
              animated: index === 0 ? animated : false,
            });
          });
        }, delay)
      );
    },
    [clearPendingScrollRetries]
  );

  const scrollToBottomIfPinned = useCallback(
    (animated = true) => {
      const autoScrollState = autoScrollStateRef.current;
      if (
        autoScrollState.isUserInteracting ||
        autoScrollState.isMomentumScrolling ||
        !autoScrollState.shouldStickToBottom
      ) {
        return;
      }
      scrollToBottomReliable(animated);
    },
    [scrollToBottomReliable]
  );

  const handleJumpToLatest = useCallback(() => {
    scrollToBottomReliable(true);
  }, [scrollToBottomReliable]);

  const schedulePinnedScrollToBottom = useCallback(
    (animated = true) => {
      const autoScrollState = autoScrollStateRef.current;
      if (
        autoScrollState.isUserInteracting ||
        autoScrollState.isMomentumScrolling ||
        !autoScrollState.shouldStickToBottom
      ) {
        return;
      }

      const now = Date.now();
      const elapsed = now - lastPinnedScrollAtRef.current;
      if (elapsed >= STREAMING_SCROLL_THROTTLE_MS) {
        lastPinnedScrollAtRef.current = now;
        scrollToBottomReliable(animated);
        return;
      }

      if (scheduledPinnedScrollTimeoutRef.current) {
        return;
      }

      scheduledPinnedScrollTimeoutRef.current = setTimeout(() => {
        scheduledPinnedScrollTimeoutRef.current = null;
        lastPinnedScrollAtRef.current = Date.now();
        scrollToBottomReliable(animated);
      }, STREAMING_SCROLL_THROTTLE_MS - elapsed);
    },
    [scrollToBottomReliable]
  );

  useEffect(() => {
    return () => {
      clearPendingScrollRetries();
    };
  }, [clearPendingScrollRetries]);

  useEffect(() => {
    return () => {
      const timerId = agentThreadsRefreshTimerRef.current;
      if (timerId) {
        clearTimeout(timerId);
        agentThreadsRefreshTimerRef.current = null;
      }
    };
  }, []);

  return {
    autoScrollStateRef,
    loadChatRequestRef,
    modelOptionsRequestRef,
    agentThreadsRequestRef,
    agentDetailRequestRef,
    agentThreadsRefreshTimerRef,
    replayRecoveryGenerationRef,
    replayRecoveryRetryTimerRef,
    replayRecoveryAbortControllerRef,
    replayRecoveryEpochResetPendingRef,
    openAgentThreadSelectorRef,
    bumpAgentRuntimeRevision,
    clearDeferredDisconnectActivity,
    clearHeldActivity,
    clearGenericRunningActivityDelay,
    clearForegroundAgentRefresh,
    scheduleDisconnectActivity,
    clearPendingScrollRetries,
    scrollToBottomReliable,
    scrollToBottomIfPinned,
    handleJumpToLatest,
    schedulePinnedScrollToBottom,
  };
}

export type MainScreenLifecycleRecoveryResult = ReturnType<typeof useMainScreenLifecycleRecovery>;
