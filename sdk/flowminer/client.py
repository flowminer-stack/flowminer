"""FlowMiner async client — thin async wrappers around the REST API.

Design notes:
  - Single ``Client`` class covers every endpoint group. We deliberately do
    not split it into ``ProjectsClient`` / ``MiningClient`` / etc. — one
    consistent surface is easier to discover, and the endpoint count (≈80)
    is small enough that a flat API reads cleanly.
  - All methods return ``dict`` / ``list`` — we don't wrap responses in
    TypedDict or pydantic models in the SDK itself, to keep deploy-time
    friction low. If callers want types, they can project into their own
    dataclasses.
  - Retries: 3 attempts with exponential backoff on 5xx and transient
    transport errors. 4xx errors are never retried.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import httpx

DEFAULT_TIMEOUT = 120.0


class FlowMinerError(Exception):
    """Raised when the server returns an error response."""

    def __init__(self, status_code: int, detail: Any):
        self.status_code = status_code
        self.detail = detail
        super().__init__(f"FlowMiner API error {status_code}: {detail}")


class Client:
    """Async client for the FlowMiner HTTP API.

    Use as an async context manager::

        async with Client("http://localhost:8000", token="...") as client:
            projects = await client.list_projects()
    """

    def __init__(
        self,
        base_url: str,
        token: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._base_url = base_url.rstrip("/") + "/api/v1"
        self._token = token
        headers = {"Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers=headers,
            timeout=timeout,
        )

    async def __aenter__(self) -> "Client":
        return self

    async def __aexit__(self, *args) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    # ── Core request helper with retry ──────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict | None = None,
        files: Any = None,
        data: Any = None,
        retries: int = 3,
    ) -> Any:
        attempt = 0
        while True:
            attempt += 1
            try:
                response = await self._client.request(
                    method, path, json=json, params=params, files=files, data=data,
                )
            except (httpx.TransportError, httpx.ReadError) as e:
                if attempt >= retries:
                    raise FlowMinerError(0, f"Transport error: {e}") from e
                await asyncio.sleep(0.5 * (2 ** (attempt - 1)))
                continue

            if 200 <= response.status_code < 300:
                if response.status_code == 204 or not response.content:
                    return None
                return response.json()

            if response.status_code >= 500 and attempt < retries:
                await asyncio.sleep(0.5 * (2 ** (attempt - 1)))
                continue

            try:
                detail = response.json().get("detail", response.text)
            except Exception:
                detail = response.text
            raise FlowMinerError(response.status_code, detail)

    # ── Auth ────────────────────────────────────────────────────────────────

    async def login(self, email: str, password: str) -> dict:
        """Log in and store the returned bearer token on the client."""
        # OAuth2 password form
        response = await self._client.post(
            "/auth/login",
            data={"username": email, "password": password},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
        body = response.json()
        self._token = body["access_token"]
        self._client.headers["Authorization"] = f"Bearer {self._token}"
        return body

    async def me(self) -> dict:
        return await self._request("GET", "/auth/me")

    # ── Projects ────────────────────────────────────────────────────────────

    async def list_projects(self, limit: int = 100, offset: int = 0) -> list[dict]:
        return await self._request("GET", "/projects", params={"limit": limit, "offset": offset})

    async def create_project(self, name: str, description: str | None = None, team_id: str | None = None) -> dict:
        return await self._request("POST", "/projects", json={"name": name, "description": description, "team_id": team_id})

    async def get_project(self, project_id: str) -> dict:
        return await self._request("GET", f"/projects/{project_id}")

    async def delete_project(self, project_id: str) -> None:
        await self._request("DELETE", f"/projects/{project_id}")

    async def seed_sample(self) -> dict:
        return await self._request("POST", "/projects/seed-sample")

    # ── Event logs ──────────────────────────────────────────────────────────

    async def list_event_logs(self, project_id: str, limit: int = 100, offset: int = 0) -> list[dict]:
        return await self._request("GET", "/event-logs", params={"project_id": project_id, "limit": limit, "offset": offset})

    async def get_event_log(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/event-logs/{event_log_id}")

    async def upload_event_log(self, project_id: str, file_path: str | Path) -> dict:
        path = Path(file_path)
        with path.open("rb") as fh:
            files = {"file": (path.name, fh, "application/octet-stream")}
            data = {"project_id": str(project_id)}
            # httpx requires the request to happen inside the `with` block
            return await self._request("POST", "/event-logs/upload", files=files, data=data)

    async def set_column_mapping(
        self,
        event_log_id: str,
        case_id_column: str,
        activity_column: str,
        timestamp_column: str,
        resource_column: str | None = None,
        cost_column: str | None = None,
    ) -> dict:
        body = {
            "case_id_column": case_id_column,
            "activity_column": activity_column,
            "timestamp_column": timestamp_column,
            "resource_column": resource_column,
            "cost_column": cost_column,
            "additional_columns": [],
        }
        return await self._request("POST", f"/event-logs/{event_log_id}/column-mapping", json=body)

    async def delete_event_log(self, event_log_id: str) -> None:
        await self._request("DELETE", f"/event-logs/{event_log_id}")

    # ── Mining ──────────────────────────────────────────────────────────────

    async def discover(
        self,
        event_log_id: str,
        algorithm: str = "inductive",
        parameters: dict | None = None,
    ) -> dict:
        body = {
            "event_log_id": event_log_id,
            "algorithm": algorithm,
            "parameters": parameters or {},
        }
        return await self._request("POST", "/mining/discover", json=body)

    async def variants(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/variants/{event_log_id}")

    async def bottlenecks(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/bottlenecks/{event_log_id}")

    async def conformance(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/conformance/{event_log_id}")

    async def rework(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/rework/{event_log_id}")

    async def insights(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/insights/{event_log_id}")

    async def statistics(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/statistics/{event_log_id}")

    async def cases(self, event_log_id: str, limit: int = 100) -> dict:
        return await self._request("GET", f"/mining/cases/{event_log_id}", params={"limit": limit})

    async def timeline(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/timeline/{event_log_id}")

    async def predict_remaining_time(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/predict/remaining-time/{event_log_id}")

    async def predict_outcome(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/mining/predict/outcome/{event_log_id}")

    # ── Analytics ───────────────────────────────────────────────────────────

    async def sustainability(self, event_log_id: str, factors: dict | None = None) -> dict:
        body = {"event_log_id": event_log_id}
        if factors:
            body["factors"] = factors
        return await self._request("POST", "/analytics/sustainability", json=body)

    async def agent_mining(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/analytics/agent-mining/{event_log_id}")

    async def benchmark(self, event_log_ids: list[str]) -> dict:
        return await self._request("POST", "/analytics/benchmark", json={"event_log_ids": event_log_ids})

    async def sql(self, event_log_id: str, query: str, limit: int = 1000) -> dict:
        return await self._request("POST", "/analytics/sql-sandbox", json={
            "event_log_id": event_log_id,
            "query": query,
            "limit": limit,
        })

    async def calendar_heatmap(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/analytics/calendar-heatmap/{event_log_id}")

    async def ask(self, event_log_id: str, question: str) -> dict:
        return await self._request("POST", "/analytics/text-to-widget", json={
            "event_log_id": event_log_id,
            "question": question,
        })

    # ── Lineage ─────────────────────────────────────────────────────────────

    async def lineage(self, event_log_id: str) -> dict:
        return await self._request("GET", f"/lineage/{event_log_id}")

    # ── Initiatives ─────────────────────────────────────────────────────────

    async def list_initiatives(self, project_id: str) -> list[dict]:
        return await self._request("GET", "/initiatives", params={"project_id": project_id})

    async def create_initiative(self, **body) -> dict:
        return await self._request("POST", "/initiatives", json=body)

    async def measure_initiative(self, initiative_id: str) -> dict:
        return await self._request("POST", f"/initiatives/{initiative_id}/measure")

    # ── Task mining ─────────────────────────────────────────────────────────

    async def create_recording(
        self,
        project_id: str,
        agent_version: str | None = None,
        hostname: str | None = None,
        notes: str | None = None,
    ) -> dict:
        """Start a new desktop-capture recording.

        Returns ``{"id": "<uuid>", "project_id": "<uuid>", "started_at": "..."}``.
        Pass the returned ``id`` to :meth:`ingest_events` and :meth:`end_recording`.
        """
        body: dict = {"project_id": project_id}
        if agent_version is not None:
            body["agent_version"] = agent_version
        if hostname is not None:
            body["hostname"] = hostname
        if notes is not None:
            body["notes"] = notes
        return await self._request("POST", "/task-mining/recordings", json=body)

    async def ingest_events(self, recording_id: str, events: list[dict]) -> dict:
        """Ingest a batch of desktop events into an active recording.

        Each event must contain ``ts`` (ISO-8601 string or Unix timestamp) and
        ``event_type``.  Optional fields: ``application``, ``window_title``,
        ``url``, ``details``.

        The backend caps batches at 5 000 events per call. This method
        automatically splits larger lists into sequential 5 000-event chunks
        and returns the aggregate count.

        Returns ``{"ingested": <n>, "total_on_recording": <n>}``.
        """
        BATCH_CAP = 5000
        total_ingested = 0
        last_response: dict = {"ingested": 0, "total_on_recording": 0}
        for start in range(0, max(len(events), 1), BATCH_CAP):
            chunk = events[start : start + BATCH_CAP]
            if not chunk:
                break
            last_response = await self._request(
                "POST",
                f"/task-mining/recordings/{recording_id}/events",
                json={"events": chunk},
            )
            total_ingested += last_response.get("ingested", 0)
        return {
            "ingested": total_ingested,
            "total_on_recording": last_response.get("total_on_recording", total_ingested),
        }

    async def end_recording(self, recording_id: str) -> dict:
        """Mark a recording as complete.

        Returns ``{"id": "<uuid>", "ended_at": "..."}``.
        """
        return await self._request(
            "POST", f"/task-mining/recordings/{recording_id}/end"
        )

    async def list_recordings(
        self, project_id: str, limit: int = 100, offset: int = 0
    ) -> list[dict]:
        return await self._request(
            "GET",
            "/task-mining/recordings",
            params={"project_id": project_id, "limit": limit, "offset": offset},
        )

    async def mine_task_patterns(
        self,
        project_id: str,
        min_frequency: int = 3,
        min_sequence_length: int = 3,
        max_sequence_length: int = 8,
    ) -> dict:
        """Run the n-gram pattern miner over all recordings in a project."""
        return await self._request(
            "POST",
            "/task-mining/mine",
            json={
                "project_id": project_id,
                "min_frequency": min_frequency,
                "min_sequence_length": min_sequence_length,
                "max_sequence_length": max_sequence_length,
            },
        )

    async def list_task_patterns(
        self, project_id: str, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        return await self._request(
            "GET",
            "/task-mining/patterns",
            params={"project_id": project_id, "limit": limit, "offset": offset},
        )
