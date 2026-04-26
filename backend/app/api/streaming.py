"""
Real-time streaming process monitoring via WebSocket.

Supports:
- Live event ingestion (clients push events)
- Live KPI broadcasting (clients subscribe to updates)
- Operational dashboard data

Protocol:
  Client → Server: {"type": "event", "case_id": str, "activity": str, "timestamp": str, "resource"?: str}
  Client → Server: {"type": "subscribe", "event_log_id": str}
  Server → Client: {"type": "kpi_update", "data": {...}}
  Server → Client: {"type": "event_ack", "count": int}
"""

import asyncio
import logging
import json
from collections import defaultdict
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, Query
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)


class LiveMetrics:
    """In-memory buffer for real-time metrics per event log."""

    def __init__(self):
        self._buffers: dict[str, list[dict]] = defaultdict(list)
        self._subscribers: dict[str, list[WebSocket]] = defaultdict(list)
        self._kpis: dict[str, dict] = {}

    def add_event(self, event_log_id: str, event: dict):
        self._buffers[event_log_id].append(event)
        # Update live KPIs
        buf = self._buffers[event_log_id]
        cases = set(e.get("case_id") for e in buf)
        activities = set(e.get("activity") for e in buf)
        self._kpis[event_log_id] = {
            "total_events": len(buf),
            "active_cases": len(cases),
            "unique_activities": len(activities),
            "events_per_minute": self._events_per_minute(buf),
            "last_event_at": event.get("timestamp", ""),
            "last_activity": event.get("activity", ""),
        }

    def _events_per_minute(self, buf: list[dict]) -> float:
        if len(buf) < 2:
            return 0
        try:
            first = datetime.fromisoformat(buf[0]["timestamp"])
            last = datetime.fromisoformat(buf[-1]["timestamp"])
            elapsed = (last - first).total_seconds()
            if elapsed > 0:
                return round(len(buf) / (elapsed / 60), 1)
        except Exception:
            pass
        return 0

    def get_kpis(self, event_log_id: str) -> dict:
        return self._kpis.get(event_log_id, {
            "total_events": 0,
            "active_cases": 0,
            "unique_activities": 0,
            "events_per_minute": 0,
        })

    def get_buffer(self, event_log_id: str) -> list[dict]:
        return self._buffers.get(event_log_id, [])

    def subscribe(self, event_log_id: str, ws: WebSocket):
        self._subscribers[event_log_id].append(ws)

    def unsubscribe(self, event_log_id: str, ws: WebSocket):
        subs = self._subscribers.get(event_log_id, [])
        if ws in subs:
            subs.remove(ws)

    async def broadcast(self, event_log_id: str, message: dict):
        subs = self._subscribers.get(event_log_id, [])
        dead = []
        for ws in subs:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            subs.remove(ws)


live_metrics = LiveMetrics()


# ─── Dashboard collaboration channel ──────────────────────────────────────
#
# Separate in-memory presence + broadcast registry for dashboard editing.
# When two users have the same dashboard open, every "I just edited widget X"
# message is re-broadcast to every subscriber on that dashboard.

class DashboardHub:
    def __init__(self):
        self._subs: dict[str, list[dict]] = defaultdict(list)

    async def connect(self, dashboard_id: str, websocket: WebSocket, user_label: str):
        entry = {"ws": websocket, "user": user_label}
        self._subs[dashboard_id].append(entry)
        await self._broadcast_presence(dashboard_id)

    async def disconnect(self, dashboard_id: str, websocket: WebSocket):
        self._subs[dashboard_id] = [s for s in self._subs[dashboard_id] if s["ws"] is not websocket]
        await self._broadcast_presence(dashboard_id)

    async def _broadcast_presence(self, dashboard_id: str):
        subs = list(self._subs.get(dashboard_id, []))
        payload = {
            "type": "presence",
            "viewers": [s["user"] for s in subs],
            "count": len(subs),
        }
        for s in subs:
            try:
                await s["ws"].send_json(payload)
            except Exception:
                pass

    async def broadcast(self, dashboard_id: str, message: dict, sender: WebSocket | None = None):
        for s in list(self._subs.get(dashboard_id, [])):
            if sender is not None and s["ws"] is sender:
                continue
            try:
                await s["ws"].send_json(message)
            except Exception:
                pass


dashboard_hub = DashboardHub()


@router.websocket("/dashboards/{dashboard_id}")
async def dashboard_collab_ws(websocket: WebSocket, dashboard_id: str, user: str = "anonymous"):
    """Real-time collaboration channel for a single dashboard.

    Every message a client sends is rebroadcast to all other clients on the
    same dashboard. The server also announces presence changes (who joined,
    who left) as ``{"type": "presence", "viewers": [...]}``.
    """
    await websocket.accept()
    await dashboard_hub.connect(dashboard_id, websocket, user)
    logger.info("Dashboard collab WS connected: dashboard=%s user=%s", dashboard_id, user)
    try:
        while True:
            try:
                message = await websocket.receive_json()
            except Exception:
                break
            # Rebroadcast as-is to peers. The server is a pure fan-out;
            # widget state lives on the clients until they PATCH the
            # dashboard over the regular REST API.
            await dashboard_hub.broadcast(
                dashboard_id,
                {"type": message.get("type", "edit"), "from": user, "payload": message},
                sender=websocket,
            )
    except WebSocketDisconnect:
        pass
    finally:
        await dashboard_hub.disconnect(dashboard_id, websocket)
        logger.info("Dashboard collab WS disconnected: dashboard=%s user=%s", dashboard_id, user)


@router.websocket("/ws/{event_log_id}")
async def websocket_endpoint(websocket: WebSocket, event_log_id: str):
    """WebSocket for real-time event streaming and KPI subscription."""
    await websocket.accept()
    live_metrics.subscribe(event_log_id, websocket)
    logger.info(f"WebSocket connected for event_log {event_log_id}")

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                await websocket.send_json({"type": "error", "message": "Invalid JSON"})
                continue

            msg_type = msg.get("type")

            if msg_type == "event":
                # Ingest a new event
                event = {
                    "case_id": msg.get("case_id", ""),
                    "activity": msg.get("activity", ""),
                    "timestamp": msg.get("timestamp", datetime.now(timezone.utc).isoformat()),
                    "resource": msg.get("resource"),
                }
                live_metrics.add_event(event_log_id, event)

                # Acknowledge
                await websocket.send_json({
                    "type": "event_ack",
                    "count": live_metrics.get_kpis(event_log_id)["total_events"],
                })

                # Broadcast KPI update to all subscribers
                await live_metrics.broadcast(event_log_id, {
                    "type": "kpi_update",
                    "data": live_metrics.get_kpis(event_log_id),
                })

            elif msg_type == "subscribe":
                # Client just wants to listen for updates
                await websocket.send_json({
                    "type": "kpi_update",
                    "data": live_metrics.get_kpis(event_log_id),
                })

            elif msg_type == "get_buffer":
                # Return recent events
                limit = msg.get("limit", 100)
                buf = live_metrics.get_buffer(event_log_id)[-limit:]
                await websocket.send_json({
                    "type": "buffer",
                    "events": buf,
                })

            else:
                await websocket.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})

    except WebSocketDisconnect:
        live_metrics.unsubscribe(event_log_id, websocket)
        logger.info(f"WebSocket disconnected for event_log {event_log_id}")


@router.get("/live-kpis/{event_log_id}")
async def get_live_kpis(event_log_id: str):
    """REST fallback: get current live KPIs for an event log."""
    return live_metrics.get_kpis(event_log_id)


@router.post("/ingest/{event_log_id}")
async def ingest_event(event_log_id: str, event: dict):
    """REST fallback: ingest a single event via HTTP POST."""
    live_metrics.add_event(event_log_id, {
        "case_id": event.get("case_id", ""),
        "activity": event.get("activity", ""),
        "timestamp": event.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "resource": event.get("resource"),
    })
    return {"status": "ok", "kpis": live_metrics.get_kpis(event_log_id)}
