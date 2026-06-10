"""
Jira connector.
Extracts issue lifecycle events from Jira Cloud using the REST API v3.
"""

import asyncio
import base64
import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta
from app.services.connectors.http_base import request_with_retries
from app.services.infra.url_guard import validate_public_url

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
CONNECTOR_DIR = os.path.join(UPLOAD_DIR, "connectors")

_TIMEOUT = 30
_DEFAULT_BATCH = 50  # Jira max is 100; 50 is safer with changelog expansion


def _basic_auth_header(email: str, api_token: str) -> str:
    credentials = f"{email}:{api_token}"
    encoded = base64.b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"


class JiraConnector(BaseConnector):
    """Connector for Jira Cloud — extracts issue status-change events."""

    meta = ConnectorMeta(
        id="jira",
        label="Jira",
        category="itsm",
        mapping_mode="auto",
        supports_write_back=True,
        write_back_label="Create Jira issue",
    )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

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

    async def _fetch_issues(self, client: httpx.AsyncClient, config: dict) -> list[dict]:
        """Paginate through Jira search results with changelog expansion."""
        # SSRF-validate the base URL once so users can't point the
        # connector at IMDS or internal services.
        base_url = validate_public_url(config["url"].rstrip("/") + "/").rstrip("/")
        project_key = config["project_key"]
        max_results = config.get("max_results", 1000)
        headers = self._headers(config)

        jql = f"project={project_key} ORDER BY created ASC"
        search_url = f"{base_url}/rest/api/3/search"

        issues: list[dict] = []
        start_at = 0
        batch = min(_DEFAULT_BATCH, max_results)

        while len(issues) < max_results:
            params = {
                "jql": jql,
                "startAt": start_at,
                "maxResults": min(batch, max_results - len(issues)),
                "expand": "changelog",
            }
            for attempt in range(2):
                resp = await client.get(search_url, headers=headers, params=params, timeout=_TIMEOUT, follow_redirects=False)
                if resp.status_code == 429 and attempt == 0:
                    retry_after = int(resp.headers.get("Retry-After", 5))
                    logger.warning(f"JiraConnector: rate limited, retrying in {retry_after}s")
                    await asyncio.sleep(retry_after)
                    continue
                break

            resp.raise_for_status()
            data = resp.json()
            page = data.get("issues", [])
            issues.extend(page)

            if len(page) == 0 or start_at + len(page) >= data.get("total", 0):
                break
            start_at += len(page)

        return issues

    @staticmethod
    def _extract_events(issue: dict) -> list[dict]:
        """Flatten a single Jira issue into a list of process-mining event rows."""
        key = issue["key"]
        fields = issue.get("fields", {})
        issue_type = fields.get("issuetype", {}).get("name", "")
        priority = (fields.get("priority") or {}).get("name", "")

        events: list[dict] = []

        # Creation event
        creator_name = (fields.get("creator") or {}).get("displayName", "")
        created_at = fields.get("created", "")
        events.append({
            "Issue Key": key,
            "Activity": "Created",
            "Timestamp": created_at,
            "Resource": creator_name,
            "Issue Type": issue_type,
            "Priority": priority,
        })

        # Changelog events (status transitions)
        changelog = issue.get("changelog", {})
        for history in changelog.get("histories", []):
            author = history.get("author", {}).get("displayName", "")
            timestamp = history.get("created", "")
            for item in history.get("items", []):
                if item.get("field") == "status":
                    to_status = item.get("toString", "")
                    events.append({
                        "Issue Key": key,
                        "Activity": to_status,
                        "Timestamp": timestamp,
                        "Resource": author,
                        "Issue Type": issue_type,
                        "Priority": priority,
                    })

        # Resolution event (if resolved)
        resolved_at = fields.get("resolutiondate")
        if resolved_at:
            assignee = (fields.get("assignee") or {}).get("displayName", "")
            events.append({
                "Issue Key": key,
                "Activity": "Resolved",
                "Timestamp": resolved_at,
                "Resource": assignee,
                "Issue Type": issue_type,
                "Priority": priority,
            })

        return events

    # ------------------------------------------------------------------
    # BaseConnector interface
    # ------------------------------------------------------------------

    def get_default_column_mapping(self, config: dict) -> dict | None:
        return {
            "case_id_column": "Issue Key",
            "activity_column": "Activity",
            "timestamp_column": "Timestamp",
            "resource_column": "Resource",
        }

    async def test_connection(self, config: dict) -> dict:
        """
        Test connectivity by calling /rest/api/3/myself.

        Required config keys: url, email, api_token
        """
        for key in ("url", "email", "api_token"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        try:
            headers = self._headers(config)
            base_url = validate_public_url(
                config["url"].rstrip("/") + "/"
            ).rstrip("/")
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{base_url}/rest/api/3/myself",
                    headers=headers,
                    timeout=_TIMEOUT,
                    follow_redirects=False,
                )
            if resp.status_code == 200:
                display_name = resp.json().get("displayName", "")
                return {
                    "success": True,
                    "message": f"Authenticated as {display_name}.",
                }
            return {
                "success": False,
                "message": f"Authentication failed (HTTP {resp.status_code}).",
            }
        except Exception as e:
            logger.error(f"JiraConnector.test_connection error: {e}", exc_info=True)
            return {"success": False, "message": f"Connection failed: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Extract all issue lifecycle events and save as CSV.

        Required config keys: url, email, api_token, project_key
        Optional: max_results

        Returns:
            Path to the saved CSV file.
        """
        for key in ("url", "email", "api_token", "project_key"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        try:
            async with httpx.AsyncClient() as client:
                issues = await self._fetch_issues(client, config)
        except Exception as e:
            logger.error(f"JiraConnector.fetch_data error: {e}", exc_info=True)
            raise

        if not issues:
            raise ValueError(f"No issues found for project '{config['project_key']}'.")

        all_events: list[dict] = []
        for issue in issues:
            all_events.extend(self._extract_events(issue))

        df = pd.DataFrame(all_events)

        os.makedirs(CONNECTOR_DIR, exist_ok=True)
        dest_name = f"{uuid.uuid4().hex}_jira_export.csv"
        dest_path = os.path.join(CONNECTOR_DIR, dest_name)
        df.to_csv(dest_path, index=False)

        logger.info(
            f"JiraConnector: saved {len(df)} events from {len(issues)} issues to {dest_path}"
        )
        return dest_path

    async def get_schema(self, config: dict) -> dict:
        """Return the fixed column schema for Jira event exports."""
        columns = [
            {"name": "Issue Key",   "type": "string"},
            {"name": "Activity",    "type": "string"},
            {"name": "Timestamp",   "type": "datetime"},
            {"name": "Resource",    "type": "string"},
            {"name": "Issue Type",  "type": "string"},
            {"name": "Priority",    "type": "string"},
        ]
        return {
            "tables": [
                {
                    "name": f"Jira Project {config.get('project_key', '')}",
                    "columns": columns,
                }
            ]
        }

    async def create_record(self, config: dict, payload: dict) -> dict:
        """
        Write-back: create a Jira issue from an action payload.

        Required config keys: url, email, api_token, project_key
        Payload keys used: title, description, fields (dict of connector-specific overrides),
                           case_id, case, priority, rule_id.
        Returns {"external_id": <issue key>, "url": <browse url>, "raw": <response json>}.
        """
        url_base = config["url"].rstrip("/")
        endpoint = f"{url_base}/rest/api/3/issue"
        headers = {
            "Authorization": _basic_auth_header(config["email"], config["api_token"]),
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

        description_text = payload.get("description") or " "
        adf = {
            "type": "doc",
            "version": 1,
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": description_text}],
                }
            ],
        }

        fields_override = payload.get("fields") or {}
        issue_fields: dict = {
            "project": {"key": config["project_key"]},
            "summary": (payload.get("title") or "")[:255],
            "issuetype": {"name": fields_override.get("issue_type") or "Task"},
            "description": adf,
        }
        if fields_override.get("priority_name"):
            issue_fields["priority"] = {"name": fields_override["priority_name"]}

        body = {"fields": issue_fields}

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await request_with_retries(client, "POST", endpoint, headers=headers, json=body)

        if resp.status_code >= 300:
            raise RuntimeError(
                f"Jira create_record failed with HTTP {resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()
        issue_key = data["key"]
        return {
            "external_id": issue_key,
            "url": f"{url_base}/browse/{issue_key}",
            "raw": data,
        }
