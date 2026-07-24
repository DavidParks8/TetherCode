import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  PendingApproval,
  PendingUserInputRequest,
  RpcNotification,
} from '../api/types';
import type { HostBridgeApiClient } from '../api/client';
import type { HostBridgeWsClient } from '../api/ws';

const ATTENTION_REQUEST_EVENT_METHODS = new Set([
  'bridge/approval.requested',
  'bridge/approval.resolved',
  'bridge/userInput.requested',
  'bridge/userInput.resolved',
  'bridge/events/snapshotRequired',
]);

export function useDrawerAttentionRequests(
  api: HostBridgeApiClient,
  ws: HostBridgeWsClient,
  active: boolean
) {
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [pendingUserInputs, setPendingUserInputs] = useState<PendingUserInputRequest[]>([]);
  const [attentionRequestError, setAttentionRequestError] = useState<string | null>(null);
  const [refreshingAttentionRequests, setRefreshingAttentionRequests] = useState(false);
  const activeRef = useRef(active);
  const mountedRef = useRef(true);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      refreshQueuedRef.current = false;
    };
  }, []);

  const refreshAttentionRequests = useCallback((): Promise<void> => {
    if (!activeRef.current || !mountedRef.current) {
      return Promise.resolve();
    }
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return refreshInFlightRef.current;
    }

    setRefreshingAttentionRequests(true);
    const request = Promise.allSettled([
      Promise.resolve().then(() => api.listApprovals()),
      Promise.resolve().then(() => api.listPendingUserInputs()),
    ])
      .then(([approvalResult, userInputResult]) => {
        if (!mountedRef.current || !activeRef.current) {
          return;
        }
        if (approvalResult.status === 'fulfilled') {
          setPendingApprovals(approvalResult.value);
        }
        if (userInputResult.status === 'fulfilled') {
          setPendingUserInputs(userInputResult.value);
        }
        if (approvalResult.status === 'rejected' && userInputResult.status === 'rejected') {
          setAttentionRequestError('Could not refresh pending requests.');
        } else if (approvalResult.status === 'rejected') {
          setAttentionRequestError('Could not refresh pending approvals.');
        } else if (userInputResult.status === 'rejected') {
          setAttentionRequestError('Could not refresh pending input requests.');
        } else {
          setAttentionRequestError(null);
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setRefreshingAttentionRequests(false);
        }
        refreshInFlightRef.current = null;
        const shouldRefreshAgain = refreshQueuedRef.current;
        refreshQueuedRef.current = false;
        if (shouldRefreshAgain && activeRef.current && mountedRef.current) {
          void refreshAttentionRequests();
        }
      });
    refreshInFlightRef.current = request;
    return request;
  }, [api]);

  useEffect(() => {
    if (active) {
      void refreshAttentionRequests();
    }
  }, [active, refreshAttentionRequests]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return ws.onEvent((event: RpcNotification) => {
      if (ATTENTION_REQUEST_EVENT_METHODS.has(event.method)) {
        void refreshAttentionRequests();
      }
    });
  }, [active, refreshAttentionRequests, ws]);

  useEffect(() => {
    if (!active) {
      return;
    }
    return ws.onStatus((connected) => {
      if (connected) {
        void refreshAttentionRequests();
      }
    });
  }, [active, refreshAttentionRequests, ws]);

  return {
    pendingApprovals,
    pendingUserInputs,
    attentionRequestError,
    refreshingAttentionRequests,
    refreshAttentionRequests,
  };
}
