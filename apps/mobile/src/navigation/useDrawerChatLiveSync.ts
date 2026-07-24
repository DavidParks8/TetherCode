import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { HostBridgeWsClient } from '../api/ws';
import {
  DRAWER_EVENT_REFRESH_DEBOUNCE_MS,
  DRAWER_REFRESH_CONNECTED_MS,
  DRAWER_REFRESH_DISCONNECTED_MS,
  drawerEventRequiresRefresh,
} from './drawerChatLoadingConfig';
import {
  pruneStaleDrawerRunIndicators,
  updateDrawerRunIndicatorsForEvent,
  type DrawerRunIndicatorMap,
} from './drawerRuntimeIndicators';

interface DrawerChatLiveSyncOptions {
  active: boolean;
  scheduleLoadChats: (delay?: number, forceRefresh?: boolean) => void;
  setRunIndicators: Dispatch<SetStateAction<DrawerRunIndicatorMap>>;
  setWsConnected: Dispatch<SetStateAction<boolean>>;
  ws: HostBridgeWsClient;
  wsConnected: boolean;
}

export function useDrawerChatLiveSync({
  active,
  scheduleLoadChats,
  setRunIndicators,
  setWsConnected,
  ws,
  wsConnected,
}: DrawerChatLiveSyncOptions): void {
  useEffect(() => {
    return ws.onEvent((event) => {
      if (event.method === 'bridge/events/snapshotRequired') {
        setRunIndicators({});
        scheduleLoadChats(0, true);
        return;
      }

      setRunIndicators((previous) =>
        updateDrawerRunIndicatorsForEvent(previous, event)
      );
      if (drawerEventRequiresRefresh(event)) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, setRunIndicators, ws]);

  useEffect(() => {
    return ws.onStatus((connected) => {
      setWsConnected(connected);
      if (connected) {
        scheduleLoadChats(DRAWER_EVENT_REFRESH_DEBOUNCE_MS, true);
      }
    });
  }, [scheduleLoadChats, setWsConnected, ws]);

  useEffect(() => {
    const timer = setInterval(() => {
      setRunIndicators((previous) => pruneStaleDrawerRunIndicators(previous));
    }, 5000);
    return () => clearInterval(timer);
  }, [setRunIndicators]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => {
      scheduleLoadChats();
    }, wsConnected ? DRAWER_REFRESH_CONNECTED_MS : DRAWER_REFRESH_DISCONNECTED_MS);
    return () => clearInterval(timer);
  }, [active, scheduleLoadChats, wsConnected]);
}
