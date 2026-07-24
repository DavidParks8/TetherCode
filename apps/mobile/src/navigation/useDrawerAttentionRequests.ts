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
    const request = Promise.all([
      api.listApprovals(),
      api.listPendingUserInputs(),
    ])
      .then(([approvals, userInputs]) => {
        if (!mountedRef.current || !activeRef.current) {
          return;
        }
        setPendingApprovals(approvals);
        setPendingUserInputs(userInputs);
        setAttentionRequestError(null);
      })
      .catch(() => {
        if (mountedRef.current && activeRef.current) {
          setAttentionRequestError('Could not refresh pending requests.');
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
