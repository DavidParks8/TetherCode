import type { RpcNotification } from '../api/types';
import { RUN_WATCHDOG_MS, toRecord, readString, readNumber, buildNextPlanStateFromDelta, extractFirstBoldSnippet, toReasoningActivityDetail } from './mainScreenHelpers';
import type { MainScreenWsEventRouterContext } from './mainScreenWsEventRouter';


export function processPlanAndReasoningEvents(
  context: MainScreenWsEventRouterContext,
  event: RpcNotification,
  currentId: string | null
): void {
  const { planItemTurnIdByThreadRef, cacheThreadTurnState, cacheThreadActivity, cacheThreadPlan, setSelectedCollaborationMode, bumpRunWatchdog, setActivePlan, setActivity, reasoningSummaryRef, threadReasoningBuffersRef, upsertLiveReasoningMessage } = context;

      if (event.method === 'item/plan/delta') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        const turnId = readString(params?.turnId) ?? 'unknown-turn';
        planItemTurnIdByThreadRef.current[threadId] = turnId;
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          cacheThreadActivity(threadId, {
            tone: 'running',
            title: 'Planning',
          });
          const rawDelta = readString(params?.delta) ?? '';
          cacheThreadPlan(threadId, (previous) =>
            buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
          );
          return;
        }

        setSelectedCollaborationMode('plan');
        bumpRunWatchdog();
        const rawDelta = readString(params?.delta) ?? '';
        setActivePlan((prev) =>
          buildNextPlanStateFromDelta(prev, threadId, turnId, rawDelta)
        );
        cacheThreadPlan(threadId, (previous) =>
          buildNextPlanStateFromDelta(previous, threadId, turnId, rawDelta)
        );
        setActivity((prev) =>
          prev.tone === 'running' && prev.title === 'Planning'
            ? prev
            : {
                tone: 'running',
                title: 'Planning',
              }
        );
        return;
      }

      if (event.method === 'item/reasoning/summaryPartAdded') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          return;
        }

        bumpRunWatchdog();
        const itemId = readString(params?.itemId);
        const summaryIndex = readNumber(params?.summaryIndex);
        const summaryKey =
          itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;
        if (summaryKey && reasoningSummaryRef.current[summaryKey] === undefined) {
          reasoningSummaryRef.current[summaryKey] = '';
        }

        return;
      }

      if (event.method === 'item/reasoning/summaryTextDelta') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        const delta = readString(params?.delta);
        if (threadId !== currentId) {
          if (delta) {
            const buffer = `${threadReasoningBuffersRef.current[threadId] ?? ''}${delta}`;
            threadReasoningBuffersRef.current[threadId] = buffer;
            const heading = extractFirstBoldSnippet(buffer, 56);
            const detail = heading
              ? undefined
              : toReasoningActivityDetail(buffer, heading, 64);
            const title = heading ?? 'Working';
            cacheThreadTurnState(threadId, {
              runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
            });
            cacheThreadActivity(threadId, {
              tone: 'running',
              title,
              detail,
            });
          }
          return;
        }

        bumpRunWatchdog();
        const itemId = readString(params?.itemId);
        const summaryIndex = readNumber(params?.summaryIndex);
        const summaryKey =
          itemId && summaryIndex !== null ? `${itemId}:${String(summaryIndex)}` : null;

        let heading = extractFirstBoldSnippet(delta, 56);
        let detail = heading ? undefined : toReasoningActivityDetail(delta ?? '', heading, 64);
        if (summaryKey) {
          const accumulated = (reasoningSummaryRef.current[summaryKey] ?? '') + (delta ?? '');
          reasoningSummaryRef.current[summaryKey] = accumulated;
          heading = extractFirstBoldSnippet(accumulated, 56) ?? heading;
          detail = heading ? undefined : toReasoningActivityDetail(accumulated, heading, 64);
        }

        setActivity((prev) => {
          const title =
            heading ?? (prev.tone === 'running' && prev.title.trim() ? prev.title : 'Working');
          if (
            prev.tone === 'running' &&
            prev.title === title &&
            prev.detail === detail
          ) {
            return prev;
          }
          return {
            tone: 'running',
            title,
            detail,
          };
        });
        return;
      }

      if (event.method === 'item/reasoning/textDelta') {
        const params = toRecord(event.params);
        const threadId = readString(params?.threadId) ?? readString(params?.thread_id);
        if (!threadId) {
          return;
        }
        if (threadId !== currentId) {
          cacheThreadTurnState(threadId, {
            runWatchdogUntil: Date.now() + RUN_WATCHDOG_MS,
          });
          return;
        }

        bumpRunWatchdog();
        const delta = readString(params?.delta);
        if (delta) {
          upsertLiveReasoningMessage(threadId, delta);
        }
        setActivity((prev) =>
          prev.tone === 'running'
            ? prev
            : {
                tone: 'running',
                title: 'Working',
              }
        );
        return;
      }
}
