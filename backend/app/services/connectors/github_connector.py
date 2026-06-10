"""
GitHub connector.
Extracts pull request and issue lifecycle events via the GitHub REST API v3.
"""

import asyncio
import logging
import os
import uuid

import httpx
import pandas as pd

from app.services.connectors.base import BaseConnector, ConnectorMeta

logger = logging.getLogger(__name__)

UPLOAD_DIR = os.environ.get("UPLOAD_DIR", "/tmp/flowminer/uploads")
CONNECTOR_DIR = os.path.join(UPLOAD_DIR, "connectors")

_TIMEOUT = 30
_GH_API = "https://api.github.com"

# Timeline event types that are meaningful for process mining
_PR_TIMELINE_ACTIVITIES = {
    "reviewed":             "Reviewed",
    "committed":            "Committed",
    "labeled":              "Labeled",
    "unlabeled":            "Unlabeled",
    "merged":               "Merged",
    "closed":               "Closed",
    "reopened":             "Reopened",
    "assigned":             "Assigned",
    "review_requested":     "Review Requested",
    "changes_requested":    "Changes Requested",
}

_ISSUE_TIMELINE_ACTIVITIES = {
    "labeled":    "Labeled",
    "unlabeled":  "Unlabeled",
    "assigned":   "Assigned",
    "unassigned": "Unassigned",
    "closed":     "Closed",
    "reopened":   "Reopened",
    "milestoned": "Milestoned",
}


class GitHubConnector(BaseConnector):
    """Connector for GitHub — extracts PR and issue lifecycle events."""

    meta = ConnectorMeta(id="github", label="GitHub", category="devops", mapping_mode="auto", supports_write_back=True, write_back_label="Create GitHub issue")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _headers(self, config: dict) -> dict:
        token = config.get("token")
        if not token:
            raise ValueError("Config must include 'token'.")
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def _paginate(self, client: httpx.AsyncClient, url: str, headers: dict, params: dict | None = None) -> list[dict]:
        """Follow GitHub's Link header pagination and return all items."""
        results: list[dict] = []
        next_url: str | None = url
        extra_params = dict(params or {})

        while next_url:
            for attempt in range(2):
                resp = await client.get(next_url, headers=headers, params=extra_params, timeout=_TIMEOUT, follow_redirects=False)
                if resp.status_code == 429 and attempt == 0:
                    retry_after = int(resp.headers.get("Retry-After", 5))
                    logger.warning(f"GitHubConnector: rate limited, retrying in {retry_after}s")
                    await asyncio.sleep(retry_after)
                    continue
                break

            resp.raise_for_status()
            page = resp.json()
            if isinstance(page, list):
                results.extend(page)
            else:
                results.append(page)

            # Parse Link header for next page
            link_header = resp.headers.get("Link", "")
            next_url = None
            extra_params = {}  # params already baked into next URL from Link header
            for part in link_header.split(","):
                part = part.strip()
                if 'rel="next"' in part:
                    next_url = part.split(";")[0].strip().strip("<>")
                    break

        return results

    async def _fetch_pr_events(self, client: httpx.AsyncClient, config: dict) -> list[dict]:
        """Fetch all PR events with timeline details."""
        owner = config["owner"]
        repo = config["repo"]
        max_items = config.get("max_items", 500)
        headers = self._headers(config)

        pulls = await self._paginate(
            client,
            f"{_GH_API}/repos/{owner}/{repo}/pulls",
            headers,
            {"state": "all", "per_page": 100},
        )
        pulls = pulls[:max_items]

        events: list[dict] = []
        for pr in pulls:
            pr_number = pr["number"]
            case_id = str(pr_number)
            title = pr.get("title", "")

            # Opened event
            events.append({
                "PR/Issue Number": case_id,
                "Title": title,
                "Activity": "Opened",
                "Timestamp": pr.get("created_at", ""),
                "Resource": (pr.get("user") or {}).get("login", ""),
            })

            # Timeline events
            try:
                timeline = await self._paginate(
                    client,
                    f"{_GH_API}/repos/{owner}/{repo}/issues/{pr_number}/timeline",
                    {**headers, "Accept": "application/vnd.github.mockingbird-preview+json"},
                    {"per_page": 100},
                )
            except httpx.HTTPStatusError as e:
                logger.warning(f"GitHubConnector: could not fetch timeline for PR #{pr_number}: {e}")
                timeline = []

            for event in timeline:
                event_type = event.get("event", "")
                activity = _PR_TIMELINE_ACTIVITIES.get(event_type)
                if activity is None:
                    continue

                actor = event.get("actor") or event.get("user") or {}
                resource = actor.get("login", "")

                # Prefer event-specific timestamp fields
                timestamp = (
                    event.get("submitted_at")
                    or event.get("created_at")
                    or event.get("committed_date")
                    or ""
                )
                events.append({
                    "PR/Issue Number": case_id,
                    "Title": title,
                    "Activity": activity,
                    "Timestamp": timestamp,
                    "Resource": resource,
                })

            # Merged / closed closing events
            if pr.get("merged_at"):
                events.append({
                    "PR/Issue Number": case_id,
                    "Title": title,
                    "Activity": "Merged",
                    "Timestamp": pr["merged_at"],
                    "Resource": (pr.get("merged_by") or {}).get("login", ""),
                })
            elif pr.get("closed_at"):
                events.append({
                    "PR/Issue Number": case_id,
                    "Title": title,
                    "Activity": "Closed",
                    "Timestamp": pr["closed_at"],
                    "Resource": "",
                })

        return events

    async def _fetch_issue_events(self, client: httpx.AsyncClient, config: dict) -> list[dict]:
        """Fetch all issue lifecycle events."""
        owner = config["owner"]
        repo = config["repo"]
        max_items = config.get("max_items", 500)
        headers = self._headers(config)

        issues = await self._paginate(
            client,
            f"{_GH_API}/repos/{owner}/{repo}/issues",
            headers,
            {"state": "all", "per_page": 100},
        )
        # Filter out pull requests (GitHub issues endpoint returns both)
        issues = [i for i in issues if "pull_request" not in i][:max_items]

        events: list[dict] = []
        for issue in issues:
            issue_number = issue["number"]
            case_id = str(issue_number)
            title = issue.get("title", "")

            # Opened event
            events.append({
                "PR/Issue Number": case_id,
                "Title": title,
                "Activity": "Opened",
                "Timestamp": issue.get("created_at", ""),
                "Resource": (issue.get("user") or {}).get("login", ""),
            })

            # Timeline events
            try:
                timeline = await self._paginate(
                    client,
                    f"{_GH_API}/repos/{owner}/{repo}/issues/{issue_number}/timeline",
                    {**headers, "Accept": "application/vnd.github.mockingbird-preview+json"},
                    {"per_page": 100},
                )
            except httpx.HTTPStatusError as e:
                logger.warning(f"GitHubConnector: could not fetch timeline for issue #{issue_number}: {e}")
                timeline = []

            for event in timeline:
                event_type = event.get("event", "")
                activity = _ISSUE_TIMELINE_ACTIVITIES.get(event_type)
                if activity is None:
                    continue
                actor = event.get("actor") or {}
                events.append({
                    "PR/Issue Number": case_id,
                    "Title": title,
                    "Activity": activity,
                    "Timestamp": event.get("created_at", ""),
                    "Resource": actor.get("login", ""),
                })

            if issue.get("closed_at"):
                events.append({
                    "PR/Issue Number": case_id,
                    "Title": title,
                    "Activity": "Closed",
                    "Timestamp": issue["closed_at"],
                    "Resource": "",
                })

        return events

    # ------------------------------------------------------------------
    # BaseConnector interface
    # ------------------------------------------------------------------

    def get_default_column_mapping(self, config: dict) -> dict | None:
        return {
            "case_id_column": "PR/Issue Number",
            "activity_column": "Activity",
            "timestamp_column": "Timestamp",
            "resource_column": "Resource",
        }

    async def test_connection(self, config: dict) -> dict:
        """
        Test connectivity by fetching the repository metadata.

        Required config keys: token, owner, repo
        """
        for key in ("token", "owner", "repo"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        try:
            headers = self._headers(config)
            owner = config["owner"]
            repo = config["repo"]
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{_GH_API}/repos/{owner}/{repo}",
                    headers=headers,
                    timeout=_TIMEOUT,
                    follow_redirects=False,
                )
            if resp.status_code == 200:
                full_name = resp.json().get("full_name", f"{owner}/{repo}")
                return {"success": True, "message": f"Connected to repository '{full_name}'."}
            return {
                "success": False,
                "message": f"GitHub API returned HTTP {resp.status_code}.",
            }
        except Exception as e:
            logger.error(f"GitHubConnector.test_connection error: {e}", exc_info=True)
            return {"success": False, "message": f"Connection failed: {e}"}

    async def fetch_data(self, config: dict, column_mapping: dict) -> str:
        """
        Fetch PR or issue lifecycle events and save as CSV.

        Required config keys: token, owner, repo
        Optional: event_type ("pull_requests" | "issues"), max_items

        Returns:
            Path to the saved CSV file.
        """
        for key in ("token", "owner", "repo"):
            if not config.get(key):
                raise ValueError(f"Config must include '{key}'.")

        event_type = config.get("event_type", "pull_requests")
        if event_type not in ("pull_requests", "issues"):
            raise ValueError("Config 'event_type' must be 'pull_requests' or 'issues'.")

        try:
            async with httpx.AsyncClient() as client:
                if event_type == "pull_requests":
                    events = await self._fetch_pr_events(client, config)
                else:
                    events = await self._fetch_issue_events(client, config)
        except Exception as e:
            logger.error(f"GitHubConnector.fetch_data error: {e}", exc_info=True)
            raise

        if not events:
            raise ValueError(f"No {event_type} events found for {config['owner']}/{config['repo']}.")

        df = pd.DataFrame(events)

        os.makedirs(CONNECTOR_DIR, exist_ok=True)
        dest_name = f"{uuid.uuid4().hex}_github_export.csv"
        dest_path = os.path.join(CONNECTOR_DIR, dest_name)
        df.to_csv(dest_path, index=False)

        logger.info(
            f"GitHubConnector: saved {len(df)} events to {dest_path}"
        )
        return dest_path

    async def create_record(self, config: dict, payload: dict) -> dict:
        """Create a GitHub issue and return its external reference."""
        from app.services.connectors.http_base import request_with_retries

        owner = config["owner"]
        repo = config["repo"]
        url = f"{_GH_API}/repos/{owner}/{repo}/issues"
        headers = self._headers(config)

        body: dict = {
            "title": payload["title"],
            "body": payload["description"],
        }
        fields = payload.get("fields") or {}
        if fields.get("labels"):
            body["labels"] = fields["labels"]
        if fields.get("assignees"):
            body["assignees"] = fields["assignees"]

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await request_with_retries(client, "POST", url, headers=headers, json=body)

        if resp.status_code >= 300:
            raise RuntimeError(
                f"GitHubConnector.create_record failed — HTTP {resp.status_code}: {resp.text[:300]}"
            )

        data = resp.json()
        return {
            "external_id": f"#{data['number']}",
            "url": data["html_url"],
            "raw": data,
        }

    async def get_schema(self, config: dict) -> dict:
        """Return the fixed column schema for GitHub event exports."""
        event_type = config.get("event_type", "pull_requests")
        table_name = "Pull Requests" if event_type == "pull_requests" else "Issues"
        columns = [
            {"name": "PR/Issue Number", "type": "string"},
            {"name": "Title",           "type": "string"},
            {"name": "Activity",        "type": "string"},
            {"name": "Timestamp",       "type": "datetime"},
            {"name": "Resource",        "type": "string"},
        ]
        return {"tables": [{"name": table_name, "columns": columns}]}
