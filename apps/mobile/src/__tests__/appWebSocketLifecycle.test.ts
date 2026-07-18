import type { AppStateStatus } from 'react-native';

import type { HostBridgeWsClient } from '../api/ws';
import { bindAppWebSocketLifecycle } from '../appWebSocketLifecycle';

describe('bindAppWebSocketLifecycle', () => {
  it('uses the React Native AppState source by default', () => {
    const connect = jest.fn();
    const disconnect = jest.fn();
    const ws = {
      connect,
      disconnect,
    } as unknown as HostBridgeWsClient;
    const cleanup = bindAppWebSocketLifecycle(ws);
    expect(connect.mock.calls.length + disconnect.mock.calls.length).toBeGreaterThan(0);
    cleanup();
  });

  it('connects while active, suspends in background, and reconnects on foreground', () => {
    let listener: ((state: AppStateStatus) => void) | null = null;
    const remove = jest.fn();
    const appState = {
      currentState: 'active' as AppStateStatus,
      addEventListener: jest.fn(
        (_type: 'change', nextListener: (state: AppStateStatus) => void) => {
          listener = nextListener;
          return { remove };
        }
      ),
    };
    const ws = {
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as HostBridgeWsClient;

    const cleanup = bindAppWebSocketLifecycle(ws, appState);

    expect(ws.connect).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).not.toHaveBeenCalled();

    const emitState = listener as ((state: AppStateStatus) => void) | null;
    emitState?.('background');
    emitState?.('inactive');
    expect(ws.disconnect).toHaveBeenCalledTimes(2);

    emitState?.('active');
    expect(ws.connect).toHaveBeenCalledTimes(2);

    cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(ws.disconnect).toHaveBeenCalledTimes(3);
  });

  it('does not connect when initially backgrounded', () => {
    const ws = {
      connect: jest.fn(),
      disconnect: jest.fn(),
    } as unknown as HostBridgeWsClient;
    const appState = {
      currentState: 'background' as AppStateStatus,
      addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    };

    const cleanup = bindAppWebSocketLifecycle(ws, appState);

    expect(ws.connect).not.toHaveBeenCalled();
    expect(ws.disconnect).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
