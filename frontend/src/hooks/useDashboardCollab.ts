import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '@/store';

export interface PresenceMessage {
  type: 'presence';
  viewers: string[];
  count: number;
}

export interface EditMessage {
  type: 'edit' | string;
  from?: string;
  payload?: any;
}

type Listener = (msg: EditMessage) => void;

/**
 * Hook that opens a WebSocket to the dashboard collaboration channel
 * and tracks presence + broadcasts local edits to peers.
 *
 * Server endpoint: /api/v1/streaming/dashboards/{dashboard_id}?token=<jwt>
 * Auth: the socket now requires a valid ?token= JWT (the same value stored
 * under `flowminer_token`); the server derives the presence label from the
 * token and closes unauthenticated sockets with code 1008. Protocol: the
 * server is a pure fan-out, so any JSON we send is echoed to every peer, and
 * presence updates come back as {type: "presence"}.
 */
export function useDashboardCollab(dashboardId: string | undefined) {
  const [viewers, setViewers] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const listenersRef = useRef<Set<Listener>>(new Set());
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!dashboardId) return;

    const token = localStorage.getItem('flowminer_token');
    if (!token) return; // backend closes tokenless sockets with 1008; don't churn

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${window.location.host}/api/v1/streaming/dashboards/${dashboardId}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'presence') {
          setViewers(msg.viewers || []);
          return;
        }
        listenersRef.current.forEach((fn) => fn(msg));
      } catch {
        // ignore malformed frames
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
      setConnected(false);
      setViewers([]);
    };
  }, [dashboardId, user?.email]);

  const broadcast = (message: any) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const subscribe = (fn: Listener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  };

  return { viewers, connected, broadcast, subscribe };
}
