"""
Real-time streaming process monitoring via WebSocket.

Supports:
- Live event ingestion (clients push events)
- Live KPI broadcasting (clients subscribe to updates)
- Operational dashboard data

Authentication:
  Every endpoint is authenticated. The REST endpoints use the standard
  ``get_current_active_user`` dependency and authorize the caller against the
  event log's parent project. The WebSocket endpoints cannot use header-based
  ``Depends`` cleanly, so they accept the JWT as a ``?token=`` query parameter
  and validate it with the SAME logic the rest of the app uses
  (``get_current_user`` → jose decode + token revocation / API-key lookup).
  An invalid or missing token closes the socket with code 1008 (policy
  violation) before any subscription is created.

Persistence:
  Live counters are backed by Redis so they survive a worker restart and are
  shared across multiple processes/workers. The same ``REDIS_URL`` the rest of
  the app uses is honoured. If Redis is unavailable we transparently fall back
  to an in-process buffer (single-worker only) so local development and tests
  keep working without a broker. The public KPI shape is identical in both
  paths.

Protocol:
  Client → Server: {"type": "event", "case_id": str, "activity": str, "timestamp": str, "resource"?: str}
  Client → Server: {"type": "subscribe", "event_log_id": str}
  Server → Client: {"type": "kpi_update", "data": {...}}
  Server → Client: {"type": "event_ack", "count": int}
"""

import logging
import json
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import assert_event_log_access, get_current_active_user, get_current_user
from app.database import async_session, get_db
from app.models import User

router = APIRouter()
logger = logging.getLogger(__name__)


# ─── Redis-backed counter store ────────────────────────────────────────────
#
# Live KPIs are kept in a Redis hash per event log
# (``flowminer:live:<event_log_id>``) plus two sets for distinct case / activity
# counts. This survives a restart and works under multiple workers. When Redis
# is unavailable we fall back to a process-local buffer (the original
# behaviour) — fine for dev/tests, single-worker only.

_LIVE_PREFIX = "flowminer:live:"
# Live counters age out after a day of inactivity so abandoned streams don't
# accumulate unbounded keys.
_LIVE_TTL_SECONDS = 60 * 60 * 24


class LiveMetrics:
    """Real-time metrics per event log, backed by Redis when available.

    The public KPI shape returned by :meth:`get_kpis` is identical regardless
    of backend so clients never observe a difference:

        {
            "total_events": int,
            "active_cases": int,
            "unique_activities": int,
            "events_per_minute": float,
            "last_event_at": str,
            "last_activity": str,
        }
    """

    def __init__(self):
        # In-process fallback state (used only when Redis is unavailable).
        self._buffers: dict[str, list[dict]] = defaultdict(list)
        self._subscribers: dict[str, list[WebSocket]] = defaultdict(list)
        self._kpis: dict[str, dict] = {}
        # Redis (``redis.asyncio``) client is created lazily on first use so we
        # never block module import or the event loop with a connectivity probe.
        # ``None`` means "not yet attempted"; ``_redis_disabled`` is set once we
        # decide to use the in-process fallback for the rest of the process.
        self._redis = None
        self._redis_disabled = False

    # ── Redis connection (lazy, async) ─────────────────────────────────
    async def _get_redis(self):
        """Return an async Redis client, or ``None`` for the in-process path.

        The client is built lazily and cached. ``redis.asyncio.from_url`` does
        not open a socket until the first command, so this never blocks; a
        single ``ping`` confirms connectivity off the import path. Any failure
        (missing redis-py, no broker, bad URL) permanently selects the
        in-process fallback for this process.
        """
        if self._redis is not None:
            return self._redis
        if self._redis_disabled:
            return None

        from app.config import settings

        if not getattr(settings, "REDIS_URL", ""):
            self._redis_disabled = True
            return None
        try:
            import redis.asyncio as redis  # lazy import so tests without redis-py still work

            client = redis.from_url(settings.REDIS_URL, decode_responses=True, socket_timeout=2)
            await client.ping()
            self._redis = client
            return client
        except Exception as e:
            logger.warning("Live metrics falling back to in-process buffer: %s", e)
            self._redis_disabled = True
            return None

    # ── Redis key helpers ──────────────────────────────────────────────
    def _hkey(self, event_log_id: str) -> str:
        return f"{_LIVE_PREFIX}{event_log_id}"

    def _cases_key(self, event_log_id: str) -> str:
        return f"{_LIVE_PREFIX}{event_log_id}:cases"

    def _acts_key(self, event_log_id: str) -> str:
        return f"{_LIVE_PREFIX}{event_log_id}:activities"

    # ── Mutation ────────────────────────────────────────────────────────
    async def add_event(self, event_log_id: str, event: dict):
        client = await self._get_redis()
        if client is not None:
            try:
                await self._add_event_redis(client, event_log_id, event)
                return
            except Exception as e:
                logger.warning("Live metrics redis write failed (%s) — using memory", e)
        self._add_event_memory(event_log_id, event)

    async def _add_event_redis(self, client, event_log_id: str, event: dict):
        hkey = self._hkey(event_log_id)
        cases_key = self._cases_key(event_log_id)
        acts_key = self._acts_key(event_log_id)
        ts = event.get("timestamp", "")
        activity = event.get("activity", "")

        pipe = client.pipeline()
        pipe.hincrby(hkey, "total_events", 1)
        if event.get("case_id"):
            pipe.sadd(cases_key, event["case_id"])
        if activity:
            pipe.sadd(acts_key, activity)
        # Track first/last timestamps so we can derive events_per_minute and
        # last_event_at without holding the full buffer in memory.
        pipe.hsetnx(hkey, "first_event_at", ts)
        pipe.hset(hkey, mapping={"last_event_at": ts, "last_activity": activity})
        pipe.expire(hkey, _LIVE_TTL_SECONDS)
        pipe.expire(cases_key, _LIVE_TTL_SECONDS)
        pipe.expire(acts_key, _LIVE_TTL_SECONDS)
        await pipe.execute()

    def _add_event_memory(self, event_log_id: str, event: dict):
        self._buffers[event_log_id].append(event)
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

    def _events_per_minute_from_span(self, total: int, first_ts: str, last_ts: str) -> float:
        if total < 2 or not first_ts or not last_ts:
            return 0
        try:
            first = datetime.fromisoformat(first_ts)
            last = datetime.fromisoformat(last_ts)
            elapsed = (last - first).total_seconds()
            if elapsed > 0:
                return round(total / (elapsed / 60), 1)
        except Exception:
            pass
        return 0

    # ── Reads ───────────────────────────────────────────────────────────
    async def get_kpis(self, event_log_id: str) -> dict:
        client = await self._get_redis()
        if client is not None:
            try:
                return await self._get_kpis_redis(client, event_log_id)
            except Exception as e:
                logger.warning("Live metrics redis read failed (%s) — using memory", e)
        return self._kpis.get(event_log_id, {
            "total_events": 0,
            "active_cases": 0,
            "unique_activities": 0,
            "events_per_minute": 0,
        })

    async def _get_kpis_redis(self, client, event_log_id: str) -> dict:
        hkey = self._hkey(event_log_id)
        h = await client.hgetall(hkey) or {}
        total = int(h.get("total_events", 0) or 0)
        if total == 0:
            return {
                "total_events": 0,
                "active_cases": 0,
                "unique_activities": 0,
                "events_per_minute": 0,
            }
        active_cases = await client.scard(self._cases_key(event_log_id))
        unique_activities = await client.scard(self._acts_key(event_log_id))
        return {
            "total_events": total,
            "active_cases": active_cases,
            "unique_activities": unique_activities,
            "events_per_minute": self._events_per_minute_from_span(
                total, h.get("first_event_at", ""), h.get("last_event_at", "")
            ),
            "last_event_at": h.get("last_event_at", ""),
            "last_activity": h.get("last_activity", ""),
        }

    def get_buffer(self, event_log_id: str) -> list[dict]:
        # The Redis backend keeps only aggregate counters, not the raw event
        # buffer, so the recent-events view is available on the in-process
        # fallback path only. Returns [] under Redis.
        return self._buffers.get(event_log_id, [])

    # ── Subscriptions (always in-process — sockets live in this worker) ──
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


# ─── WebSocket authentication helper ───────────────────────────────────────
#
# WebSockets can't carry an Authorization header through the browser API, so
# the client passes the JWT as a ``?token=`` query parameter. We validate it
# with the SAME ``get_current_user`` used by every REST route — jose decode,
# revocation blocklist, and the ``fmk_`` API-key path all apply identically.

async def _authenticate_ws(token: Optional[str]) -> Optional[User]:
    """Validate a WebSocket ``?token=`` value. Returns the active user or None.

    Opens its own DB session because WebSocket handlers can't use the
    request-scoped ``Depends(get_db)`` generator. Any auth failure (missing
    token, bad JWT, revoked jti, inactive user) collapses to ``None`` so the
    caller can close the socket with code 1008.
    """
    if not token:
        return None
    async with async_session() as db:
        try:
            user = await get_current_user(token=token, db=db)
        except Exception:
            return None
        if not user.is_active:
            return None
        return user


async def _ws_can_access_event_log(user: User, event_log_id: UUID) -> bool:
    """True if ``user`` may access the given event log's parent project."""
    async with async_session() as db:
        try:
            await assert_event_log_access(event_log_id, db, user)
        except Exception:
            return False
        return True


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
async def dashboard_collab_ws(
    websocket: WebSocket,
    dashboard_id: str,
    token: str | None = Query(default=None),
):
    """Real-time collaboration channel for a single dashboard.

    Authentication: requires a valid ``?token=`` JWT. The presence label is
    derived FROM the validated token (the user's email), never from a
    client-supplied ``?user=`` string, so a peer can't spoof another viewer's
    identity. An invalid token closes the socket with code 1008.

    Every message a client sends is rebroadcast to all other clients on the
    same dashboard. The server also announces presence changes (who joined,
    who left) as ``{"type": "presence", "viewers": [...]}``.
    """
    user = await _authenticate_ws(token)
    if user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # Presence label is the authenticated identity — NOT a query string.
    user_label = user.email

    await websocket.accept()
    await dashboard_hub.connect(dashboard_id, websocket, user_label)
    logger.info("Dashboard collab WS connected: dashboard=%s user=%s", dashboard_id, user_label)
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
                {"type": message.get("type", "edit"), "from": user_label, "payload": message},
                sender=websocket,
            )
    except WebSocketDisconnect:
        pass
    finally:
        await dashboard_hub.disconnect(dashboard_id, websocket)
        logger.info("Dashboard collab WS disconnected: dashboard=%s user=%s", dashboard_id, user_label)


@router.websocket("/ws/{event_log_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    event_log_id: UUID,
    token: str | None = Query(default=None),
):
    """WebSocket for real-time event streaming and KPI subscription.

    Authentication: requires a valid ``?token=`` JWT whose owner can access the
    event log's parent project. An invalid token / unauthorized caller closes
    the socket with code 1008 before any subscription is created.
    """
    user = await _authenticate_ws(token)
    if user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    if not await _ws_can_access_event_log(user, event_log_id):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    log_id = str(event_log_id)
    await websocket.accept()
    live_metrics.subscribe(log_id, websocket)
    logger.info(f"WebSocket connected for event_log {log_id}")

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
                await live_metrics.add_event(log_id, event)

                # Compute KPIs once, then reuse for both the ack and broadcast.
                kpis = await live_metrics.get_kpis(log_id)

                # Acknowledge
                await websocket.send_json({
                    "type": "event_ack",
                    "count": kpis["total_events"],
                })

                # Broadcast KPI update to all subscribers
                await live_metrics.broadcast(log_id, {
                    "type": "kpi_update",
                    "data": kpis,
                })

            elif msg_type == "subscribe":
                # Client just wants to listen for updates
                await websocket.send_json({
                    "type": "kpi_update",
                    "data": await live_metrics.get_kpis(log_id),
                })

            elif msg_type == "get_buffer":
                # Return recent events
                limit = msg.get("limit", 100)
                buf = live_metrics.get_buffer(log_id)[-limit:]
                await websocket.send_json({
                    "type": "buffer",
                    "events": buf,
                })

            else:
                await websocket.send_json({"type": "error", "message": f"Unknown type: {msg_type}"})

    except WebSocketDisconnect:
        live_metrics.unsubscribe(log_id, websocket)
        logger.info(f"WebSocket disconnected for event_log {log_id}")


@router.get("/live-kpis/{event_log_id}")
async def get_live_kpis(
    event_log_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """REST fallback: get current live KPIs for an event log."""
    await assert_event_log_access(event_log_id, db, current_user)
    return await live_metrics.get_kpis(str(event_log_id))


@router.post("/ingest/{event_log_id}")
async def ingest_event(
    event_log_id: UUID,
    event: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    """REST fallback: ingest a single event via HTTP POST."""
    await assert_event_log_access(event_log_id, db, current_user)
    log_id = str(event_log_id)
    await live_metrics.add_event(log_id, {
        "case_id": event.get("case_id", ""),
        "activity": event.get("activity", ""),
        "timestamp": event.get("timestamp", datetime.now(timezone.utc).isoformat()),
        "resource": event.get("resource"),
    })
    return {"status": "ok", "kpis": await live_metrics.get_kpis(log_id)}
