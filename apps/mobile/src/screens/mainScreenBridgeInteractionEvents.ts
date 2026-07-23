import type { RpcNotification } from '../api/types';
import { toRecord, readString, toPendingUserInputRequest, buildUserInputDrafts, parseBridgeThreadQueueState, toPendingApproval, toBridgeUiSurface, upsertBridgeUiSurfaceList, removeBridgeUiSurfaceFromList } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';


export function processBridgeInteractionEvents(context: MainScreenWsEventRouterContext, event: RpcNotification, currentId: string | null, pendingApprovalId: string | undefined, pendingUserInputRequestId: string | undefined): void {
  const {
    cacheThreadQueueState,
    cacheThreadPendingApproval,
    cacheThreadActivity,
    clearRunWatchdog,
    setPendingApproval,
    setActivity,
    cacheThreadPendingUserInputRequest,
    setSelectedCollaborationMode,
    setPendingUserInputRequest,
    setUserInputDrafts,
    setUserInputError,
    setResolvingUserInput,
    threadRuntimeSnapshotsRef,
    bumpRunWatchdog,
    cacheThreadBridgeUiSurface,
    setActiveBridgeUiSurfaces,
    removeThreadBridgeUiSurface,
  } = context;

      if (event.method === 'bridge/thread/queue/updated') {
        const parsed = parseBridgeThreadQueueState(event.params);
        if (!parsed) {
          return;
        }

        cacheThreadQueueState(parsed.threadId, parsed);
        return;
      }

      if (event.method === 'bridge/approval.requested') {
        const parsed = toPendingApproval(event.params);
        if (parsed) {
          cacheThreadPendingApproval(parsed.threadId, parsed);
          cacheThreadActivity(parsed.threadId, {
            tone: 'idle',
            title: 'Waiting for approval',
            detail: parsed.command ?? parsed.kind,
          });

          if (parsed.threadId === currentId) {
            clearRunWatchdog();
            setPendingApproval(parsed);
            setActivity({
              tone: 'idle',
              title: 'Waiting for approval',
              detail: parsed.command ?? parsed.kind,
            });
          }
        }
        return;
      }

      if (event.method === 'bridge/userInput.requested') {
        const parsed = toPendingUserInputRequest(event.params);
        if (parsed) {
          cacheThreadPendingUserInputRequest(parsed.threadId, parsed);
          cacheThreadActivity(parsed.threadId, {
            tone: 'idle',
            title: 'Clarification needed',
            detail: parsed.questions[0]?.header ?? 'Answer required',
          });

          if (parsed.threadId === currentId) {
            setSelectedCollaborationMode('plan');
            clearRunWatchdog();
            setPendingUserInputRequest(parsed);
            setUserInputDrafts(buildUserInputDrafts(parsed));
            setUserInputError(null);
            setResolvingUserInput(false);
            setActivity({
              tone: 'idle',
              title: 'Clarification needed',
              detail: parsed.questions[0]?.header ?? 'Answer required',
            });
          }
        }
        return;
      }

      if (event.method === 'bridge/userInput.resolved') {
        const params = toRecord(event.params);
        const resolvedId = readString(params?.id);
        const selectedPendingUserInputId = currentId
          ? threadRuntimeSnapshotsRef.current[currentId]?.pendingUserInputRequest?.requestId ??
            pendingUserInputRequestId
          : pendingUserInputRequestId;
        if (resolvedId) {
          for (const [threadId, snapshot] of Object.entries(
            threadRuntimeSnapshotsRef.current
          )) {
            if (snapshot.pendingUserInputRequest?.requestId !== resolvedId) {
              continue;
            }
            cacheThreadPendingUserInputRequest(threadId, null);
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Input submitted',
            });
          }
        }
        if (selectedPendingUserInputId && resolvedId === selectedPendingUserInputId) {
          bumpRunWatchdog();
          setPendingUserInputRequest(null);
          setUserInputDrafts({});
          setUserInputError(null);
          setResolvingUserInput(false);
          setActivity({
            tone: 'running',
            title: 'Input submitted',
          });
        }
        return;
      }

      if (event.method === 'bridge/ui.present' || event.method === 'bridge/ui.update') {
        const surface = toBridgeUiSurface(event.params);
        if (!surface) {
          return;
        }

        cacheThreadBridgeUiSurface(surface.threadId, surface);
        if (surface.threadId === currentId) {
          setActiveBridgeUiSurfaces((previous) =>
            upsertBridgeUiSurfaceList(previous, surface)
          );
        }
        return;
      }

      if (event.method === 'bridge/ui.dismiss') {
        const params = toRecord(event.params);
        const surfaceId = readString(params?.id);
        const threadId = readString(params?.threadId);
        if (!surfaceId) {
          return;
        }

        removeThreadBridgeUiSurface(surfaceId, threadId);
        setActiveBridgeUiSurfaces((previous) =>
          removeBridgeUiSurfaceFromList(previous, surfaceId)
        );
        return;
      }

      if (event.method === 'bridge/approval.resolved') {
        const params = toRecord(event.params);
        const resolvedId = readString(params?.id);
        const selectedPendingApprovalId = currentId
          ? threadRuntimeSnapshotsRef.current[currentId]?.pendingApproval?.requestId ??
            pendingApprovalId
          : pendingApprovalId;
        if (resolvedId) {
          for (const [threadId, snapshot] of Object.entries(
            threadRuntimeSnapshotsRef.current
          )) {
            if (snapshot.pendingApproval?.requestId !== resolvedId) {
              continue;
            }
            cacheThreadPendingApproval(threadId, null);
            cacheThreadActivity(threadId, {
              tone: 'running',
              title: 'Approval resolved',
            });
          }
        }
        if (selectedPendingApprovalId && resolvedId === selectedPendingApprovalId) {
          bumpRunWatchdog();
          setPendingApproval(null);
          setActivity({
            tone: 'running',
            title: 'Approval resolved',
          });
        }
        return;
      }
}
