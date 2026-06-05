# Recorded API cassettes (VCR)

Credential-scrubbed HTTP recordings for the `@pytest.mark.live` connector tests
(`test_live_connectors.py`). A committed cassette lets CI replay a real API
exchange deterministically — no live account, no network — while still catching
response-shape drift that respx hand-mocks miss.

## Recording (one-time, per connector)

1. Get a free account and credentials:
   - **GitHub** — a PAT (`public_repo` scope) against any public repo.
   - **Salesforce** — a free Developer Edition org (`developer.salesforce.com/signup`).
   - **ServiceNow** — a free Personal Developer Instance (`developer.servicenow.com`).
   - **Jira** — a free Cloud site + API token (`atlassian.com/try/cloud/signup`).
2. Export the config blob (see `test_live_connectors.py` for the keys), e.g.
   ```bash
   export FLOWMINER_TEST_GITHUB='{"token":"ghp_…","owner":"microsoft","repo":"vscode","event_type":"issues","max_items":20}'
   ```
3. Record:
   ```bash
   pytest tests/connectors/test_live_connectors.py -m live --record-mode=once
   ```

Secrets (auth headers, API keys, OAuth tokens, cookies) are redacted on write by
the `vcr_config` fixture in `../conftest.py`. **Skim the cassette before
committing** to confirm nothing sensitive remains.

## Replaying

With a cassette present and `record_mode="none"` (the default), the test replays
offline. Cassettes are safe to commit once scrubbed.
