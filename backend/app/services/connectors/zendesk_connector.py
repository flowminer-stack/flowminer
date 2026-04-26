"""
Zendesk connector.
Extracts ticket lifecycle events via the Zendesk REST API.
"""

import asyncio
import base64
import logging
import os
import uuid

import httpx
import pandas as pd
import re

from app.services.connectors.base import BaseConnector
from app.services.url_guard import validate_public_url

# Zendesk subdomains are strict: letters, digits, hyphens only.
_ZENDESK_SUBDOMAIN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,62}$")

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
CONNECTOR_DIR = os.path.join(UPLOAD_DIR, "connectors")

_TIMEOUT = 30

# Zendesk audit event types that are meaningful for process mining
_RELEVANT_EVENT_TYPES = {
    "Change",
    "Create",
    "Notification",
}


def _basic_auth_header(email: str, api_token: str) -> str:
    credentials = f"{email}/token:{api_token}"
    encoded = base64.b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"


class ZendeskConnector(BaseConnector):
    """Connector for Zendesk Support — extracts ticket audit events."""

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _base_url(self, config: dict) -> str:
        subdomain = config.get("subdomain")
        if not subdomain:
            raise ValueError("Config must include 'subdomain'.")
        if not _ZENDESK_SUBDOMAIN_RE.match(subdomain):
            raise ValueError(
                f"Invalid Zendesk subdomain: {subdomain!r}. "
                f"Only letters, digits, and hyphens are allowed."
            )
        # Resolve against our SSRF guard — catches the edge case
        # where a compromised DNS lands zendesk.com on private space.
        return validate_public_url(
            f"https://{subdomain}.zendesk.com/api/v2/"
        ).rstrip("/")

    def _headers(self, config: dict) -> dict:
        email = config.get("email")
        api_token = config.get("api_token")
        if not email:
            raise ValueError("Config must include 'email'.")
        if not api_token:
            raise ValueError("Config must include 'api_token'.")
        return {
            "Authorization": _basic_auth_header(email, api_token),
            "Accept": "application/json",
        }

    async def _get(self, client: httpx.AsyncClient, url: str, headers: dict) -> dict:
        """GET with one retry on 429."""
        for attempt in range(2):
            resp = await client.get(url, headers=headers, timeout=_TIMEOUT, follow_redirects=False)
            if resp.status_code == 429 and attempt == 0:
                retry_after = int(resp.headers.get("Retry-After", 5))
                logger.warning(f"ZendeskConnector: rate limited, retrying in {retry_after}s")
                await asyncio.sleep(retry_after)
                continue
            break
        resp.raise_for_status()
        return resp.json()

    async def _fetch_tickets(self, client: httpx.AsyncClient, config: dict) -> list[dict]:
        """Paginate through all tickets up to max_tickets."""
        base_url = self._base_url(config)
        headers = self._headers(config)
        max_tickets = config.get("max_tickets", 1000)

        tickets: list[dict] = []
        next_url: str | None = f"{base_url}/tickets.json?per_page=100"

        while next_url and len(tickets) < max_tickets:
            data = await self._get(client, next_url, headers)
            page = data.get("tickets", [])
            tickets.extend(page)
            next_url = data.get("next_page")

        return tickets[:max_tickets]

    async def _fetch_audits(self, client: httpx.AsyncClient, base_url: str, headers: dict, ticket_id: int) -> list[dict]:
        """Fetch all audits for one ticket."""
        audits: list[dict] = []
        next_url: str | None = f"{base_url}/tickets/{ticket_id}/audits.json"

        while next_url:
            try:
                data = await self._get(client, next_url, headers)
            except httpx.HTTPStatusError as e:
                logger.warning(f"ZendeskConnector: could not fetch audits for ticket {ticket_id}: {e}")
                break
            audits.extend(data.get("audits", []))
            next_url = data.get("next_page")

        return audits

    @staticmethod
    def _extract_events_from_audits(ticket: dict, audits: list[dict]) -> list[dict]:
        """Flatten audits into process-mining event rows."""
        ticket_id = ticket["id"]
        priority = ticket.get("priority") or ""
        channel = (ticket.get("via") or {}).get("channel", "")

        events: list[dict] = []
        for audit in audits:
            author = audit.get("author_id", "")
            created_at = audit.get("created_at", "")

            for event in audit.get("events", []):
                event_type = event.get("type", "")

                if event_type == "Create":
                    activity = "Created"
                elif event_type == "Change":
                    field = event.get("field_name", "")
                    new_val = event.get("value", "")
                    if field == "status":
                        activity = str(new_val).capitalize()
                    elif field == "assignee_id":
                        activity = "Assigned"
                    elif field == "priority":
                        activity = f"Priority: {new_val}"
                    else:
                        activity = f"Changed {field}"
                elif event_type == "Notification":
                    body = event.get("subject", event.get("body", "Notification"))
                    activity = f"Notification: {str(body)[:80]}"
                else:
                    continue

                events.append({
                    "Ticket ID": str(ticket_id),
                    "Activity":  activity,
                    "Timestamp": created_at,
                    "Resource":  str(author),
                    "Priority":  priority,
                    "Channel":   channel,
                })

        return events

    # ------------------------------------------------------------------
    # BaseConnector interface
    # ------------------------------------------------------------------

    def get_default_column_mapping(self, config: dict) -> dict | None:
        return {
            "case_id_column": "Ticket ID",
            "activity_column": "Activity",
            "timestamp_column": "Timestamp",
            "resource_column": "Resource",
        }

    async def test_connection(self, config: dict) -> dict:
        """
        Test connectivity by calling /api/v2/users/me.json.

        Required config keys: subdomain, email, api_token
        """
        for key in ("subdomain", "email", "api_token"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        try:
            base_url = self._base_url(config)
            headers = self._headers(config)
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{base_url}/users/me.json",
                    headers=headers,
                    timeout=_TIMEOUT,
                    follow_redirects=False,
                )
            if resp.status_code == 200:
                user = resp.json().get("user", {})
                name = user.get("name", "")
                return {"success": True, "message": f"Authenticated as '{name}'."}
            return {
                "success": False,
                "message": f"Zendesk API returned HTTP {resp.status_code}.",
            }
        except Exception as e:
            logger.error(f"ZendeskConnector.test_connection error: {e}", exc_info=True)
            return {"success": False, "message": f"Connection failed: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Fetch all ticket audit events and save as CSV.

        Required config keys: subdomain, email, api_token
        Optional: max_tickets (default 1000)

        Returns:
            Path to the saved CSV file.
        """
        for key in ("subdomain", "email", "api_token"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        try:
            base_url = self._base_url(config)
            headers = self._headers(config)

            async with httpx.AsyncClient() as client:
                tickets = await self._fetch_tickets(client, config)

                all_events: list[dict] = []
                for ticket in tickets:
                    audits = await self._fetch_audits(client, base_url, headers, ticket["id"])
                    all_events.extend(self._extract_events_from_audits(ticket, audits))

        except Exception as e:
            logger.error(f"ZendeskConnector.fetch_data error: {e}", exc_info=True)
            raise

        if not all_events:
            raise ValueError("No audit events found.")

        df = pd.DataFrame(all_events)

        os.makedirs(CONNECTOR_DIR, exist_ok=True)
        dest_name = f"{uuid.uuid4().hex}_zendesk_export.csv"
        dest_path = os.path.join(CONNECTOR_DIR, dest_name)
        df.to_csv(dest_path, index=False)

        logger.info(
            f"ZendeskConnector: saved {len(df)} events from {len(tickets)} tickets to {dest_path}"
        )
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """Return the fixed column schema for Zendesk event exports."""
        columns = [
            {"name": "Ticket ID",  "type": "string"},
            {"name": "Activity",   "type": "string"},
            {"name": "Timestamp",  "type": "datetime"},
            {"name": "Resource",   "type": "string"},
            {"name": "Priority",   "type": "string"},
            {"name": "Channel",    "type": "string"},
        ]
        return {
            "tables": [
                {
                    "name": f"{config.get('subdomain', '')}.zendesk.com",
                    "columns": columns,
                }
            ]
        }
