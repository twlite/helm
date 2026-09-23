import { useCallback, useEffect, useRef, useState } from 'react';
import { getWebSocketUrl } from '../api';
import type { ConnectionState, HelmEvent } from '../types';

const MAX_RECONNECT_DELAY_MS = 12_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(value: unknown): HelmEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.timestamp !== 'string') {
    return null;
  }
  return {
    type: value.type as HelmEvent['type'],
    timestamp: value.timestamp,
    runId: typeof value.runId === 'string' ? value.runId : undefined,
    payload: value.payload,
  };
}

export function useHelmWebSocket(onEvent: (event: HelmEvent) => void) {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const eventHandlerRef = useRef(onEvent);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    eventHandlerRef.current = onEvent;
  }, [onEvent]);

  const connect = useCallback(() => {
    if (stoppedRef.current) return;
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    setState((current) => (current === 'connecting' ? current : 'reconnecting'));

    const socket = new WebSocket(getWebSocketUrl());
    socketRef.current = socket;
    let lastHeartbeatAt = Date.now();
    let heartbeatWatchdog: number | undefined;

    socket.addEventListener('open', () => {
      attemptRef.current = 0;
      setAttempt(0);
      setState('connected');
      lastHeartbeatAt = Date.now();
      setConnectionVersion((current) => current + 1);
      heartbeatWatchdog = window.setInterval(() => {
        if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          socket.close();
        }
      }, HEARTBEAT_CHECK_INTERVAL_MS);
    });

    socket.addEventListener('message', (message) => {
      lastHeartbeatAt = Date.now();
      try {
        const parsed = JSON.parse(message.data) as unknown;
        if (isRecord(parsed) && parsed.type === 'heartbeat') return;
        const event = parseEvent(parsed);
        if (event) {
          eventHandlerRef.current(event);
        }
      } catch {
        // An invalid event must not take down the live connection.
      }
    });

    socket.addEventListener('error', () => {
      setState('reconnecting');
    });

    socket.addEventListener('close', () => {
      if (heartbeatWatchdog !== undefined) {
        window.clearInterval(heartbeatWatchdog);
        heartbeatWatchdog = undefined;
      }
      if (stoppedRef.current || socketRef.current !== socket) {
        return;
      }
      setState('reconnecting');
      const nextAttempt = attemptRef.current + 1;
      attemptRef.current = nextAttempt;
      const delay = Math.min(500 * 2 ** Math.min(nextAttempt - 1, 5), MAX_RECONNECT_DELAY_MS);
      reconnectTimerRef.current = window.setTimeout(connect, delay);
      setAttempt(nextAttempt);
    });
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    // Deferring the first connection lets Strict Mode replay this effect's
    // setup and cleanup without opening a socket that cleanup immediately aborts.
    reconnectTimerRef.current = window.setTimeout(connect, 0);
    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current !== undefined) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = undefined;
      }
      const activeSocket = socketRef.current;
      socketRef.current = null;
      activeSocket?.close();
    };
  }, [connect]);

  return {
    state,
    attempt,
    connectionVersion,
    reconnect: connect,
  };
}
