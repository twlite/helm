import { useCallback, useEffect, useRef, useState } from 'react';
import { getWebSocketUrl } from '../api';
import type { ConnectionState, HelmEvent } from '../types';

const MAX_RECONNECT_DELAY_MS = 12_000;

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
  const eventHandlerRef = useRef(onEvent);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | undefined>(undefined);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    eventHandlerRef.current = onEvent;
  }, [onEvent]);

  const connect = useCallback(() => {
    stoppedRef.current = false;
    if (reconnectTimerRef.current !== undefined) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    setState((current) => (current === 'connecting' ? current : 'reconnecting'));

    const socket = new WebSocket(getWebSocketUrl());
    socketRef.current = socket;

    socket.addEventListener('open', () => {
      attemptRef.current = 0;
      setAttempt(0);
      setState('connected');
    });

    socket.addEventListener('message', (message) => {
      try {
        const event = parseEvent(JSON.parse(message.data) as unknown);
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
    connect();
    return () => {
      stoppedRef.current = true;
      if (reconnectTimerRef.current !== undefined) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      const activeSocket = socketRef.current;
      socketRef.current = null;
      activeSocket?.close();
    };
  }, [connect]);

  return {
    state,
    attempt,
    reconnect: connect,
  };
}
