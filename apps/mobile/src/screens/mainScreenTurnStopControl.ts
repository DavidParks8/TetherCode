import { useCallback } from 'react';
import type { MainScreenReasoningAndInterruptContext, MainScreenReasoningAndInterruptResult } from './mainScreenReasoningAndInterrupt';






export type MainScreenTurnStopControlContext = MainScreenReasoningAndInterruptContext & MainScreenReasoningAndInterruptResult;

export function useMainScreenTurnStopControl(context: MainScreenTurnStopControlContext) {
  const {
    activeTurnIdRef,
    chatIdRef,
    interruptActiveTurn,
    interruptLatestTurn,
    setActiveTurnId,
    setActivity,
    setCreating,
    setError,
    setSelectedChat,
    setSending,
    setShowDelayedGenericRunningActivity,
    setStoppingTurn,
    stopRequestedRef,
    stopSystemMessageLoggedRef,
    stoppingTurn,
  } = context;


  const registerTurnStarted = useCallback(
    (threadId: string, turnId: string) => {
      const currentChatId = chatIdRef.current;
      if (!threadId || !turnId || (currentChatId && currentChatId !== threadId)) {
        return;
      }

      const nowIso = new Date().toISOString();
      setSending(false);
      setCreating(false);
      setActiveTurnId(turnId);
      activeTurnIdRef.current = turnId;
      setActivity({ tone: 'running', title: 'Working' });
      setShowDelayedGenericRunningActivity(true);
      setSelectedChat((prev) => {
        if (!prev || prev.id !== threadId) {
          return prev;
        }

        return {
          ...prev,
          status: 'running',
          updatedAt: nowIso,
          statusUpdatedAt: nowIso,
          lastError: undefined,
        };
      });
      if (stopRequestedRef.current) {
        void interruptActiveTurn(threadId, turnId);
      }
    },
    [interruptActiveTurn]
  );

  const handleStopTurn = useCallback(() => {
    if (stoppingTurn) {
      return;
    }

    stopRequestedRef.current = true;
    stopSystemMessageLoggedRef.current = false;
    setStoppingTurn(true);
    setError(null);
    setActivity({
      tone: 'running',
      title: 'Stopping turn',
    });

    const threadId = chatIdRef.current;
    const turnId = activeTurnIdRef.current;
    if (threadId && turnId) {
      void interruptActiveTurn(threadId, turnId);
      return;
    }

    if (threadId) {
      void interruptLatestTurn(threadId);
      return;
    }

    setStoppingTurn(false);
    stopRequestedRef.current = false;
    setActivity({
      tone: 'idle',
      title: 'No active turn found',
    });
  }, [interruptActiveTurn, interruptLatestTurn, stoppingTurn]);

  return {
    registerTurnStarted,
    handleStopTurn,
  };
}

export type MainScreenTurnStopControlResult = ReturnType<typeof useMainScreenTurnStopControl>;
