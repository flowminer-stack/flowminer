# FlowMiner MCP server — Claude Desktop setup

FlowMiner ships a Model Context Protocol server (`flowminer-mcp`) that
lets Claude Desktop, Cursor, Zed, or any other MCP-aware client query
your FlowMiner installation directly. You can ask *"what are the top
bottlenecks in the HR onboarding log?"* from inside Claude Desktop and
get a grounded answer without ever opening the web UI.

## What it exposes

Nine tools, all backed by the same mining engine the web UI uses:

| Tool | What it does |
|---|---|
| `list_event_logs` | Returns every log the user can see (id, name, project). |
| `get_log_summary` | Headline stats — cases, events, activities, date range, avg duration. |
| `get_bottlenecks` | Activities with the longest average duration. |
| `get_variants` | Most common execution paths ranked by case count. |
| `get_rework` | Per-activity rework rates and total rework cases. |
| `get_conformance` | Fitness + precision + deviations against an inductive model. |
| `get_dfg` | Directly-follows graph as a list of edges. |
| `get_insights` | Full automated plain-language insights (same set the web UI shows). |
| `ask_natural_language` | Open-ended question → delegates to FlowMiner's chat endpoint for a narrated answer. |

Every tool call respects the user's project permissions — the MCP
server can only see logs the configured user can see in the web UI.

## Running the server

### Option A — alongside an existing FlowMiner backend container

The simplest setup. The MCP server lives in the same container as the
FastAPI backend and talks to the same database. Claude Desktop
launches it over stdio via `docker exec`.

1. Pick a FlowMiner user whose logs you want to expose. The MCP
   server will act on behalf of that user and only return logs they
   can access.

2. Add a stanza to Claude Desktop's config file. On macOS the file
   lives at `~/Library/Application Support/Claude/claude_desktop_config.json`.
   On Windows it's `%APPDATA%\Claude\claude_desktop_config.json`. On
   Linux: `~/.config/Claude/claude_desktop_config.json`.

   ```json
   {
     "mcpServers": {
       "flowminer": {
         "command": "docker",
         "args": [
           "exec",
           "-i",
           "processmining-backend-1",
           "python3",
           "-m",
           "app.mcp.server"
         ],
         "env": {
           "FLOWMINER_MCP_USER_EMAIL": "admin@flowminer.io"
         }
       }
     }
   }
   ```

   The `-i` on `docker exec` is important — MCP is a stdio protocol
   and without interactive mode Claude won't be able to write to the
   server's stdin.

3. **Important:** the `env` block in Claude's config is passed to
   `docker exec`, not to the container process. To make it reach the
   Python code, add `-e FLOWMINER_MCP_USER_EMAIL=admin@flowminer.io`
   to the `args` list instead:

   ```json
   {
     "mcpServers": {
       "flowminer": {
         "command": "docker",
         "args": [
           "exec",
           "-i",
           "-e",
           "FLOWMINER_MCP_USER_EMAIL=admin@flowminer.io",
           "processmining-backend-1",
           "python3",
           "-m",
           "app.mcp.server"
         ]
       }
     }
   }
   ```

4. Restart Claude Desktop. The **flowminer** entry should appear in
   the MCP server list (click the hammer icon next to the message
   box). All nine tools should be listed.

### Option B — standalone

If you're running FlowMiner on a different machine from Claude, or
you want to ship `flowminer-mcp` to your laptop as a lightweight
process without launching the full stack, install the backend as a
package and run `python3 -m app.mcp.server` directly. You'll need
the same environment variables the main backend reads
(`DATABASE_URL`, `REDIS_URL`, `FLOWMINER_ENCRYPTION_KEY`, plus the
`FLOWMINER_MCP_USER_EMAIL`). This mode is mostly useful for CI or
embedding the MCP server into a bigger agent deployment; for day-to-
day use from Claude Desktop, option A is simpler.

## Example prompts

Once the server is wired up, you can ask Claude things like:

> *"List the event logs FlowMiner knows about."*
> *"Summarise the `container_logistics.json — Forklift (flattened)` log."*
> *"What are the top three bottlenecks for the HR onboarding log? Tell me which are real process issues versus inventory dwell."*
> *"Ask FlowMiner for a plain-English analysis of the biggest rework hotspots in the latest running-example upload."*

Claude will call the appropriate tools, get real numeric data back,
and ground its answer in that data. If you ask something open-ended
it will fall back to `ask_natural_language` which delegates to the
same narration pipeline the web UI uses (enriched context +
grounding rules).

## Troubleshooting

**"Server disconnected immediately" in Claude Desktop logs.** Check
that `FLOWMINER_MCP_USER_EMAIL` is set and points to a real user. The
server refuses to start without it (deliberate — we don't want to
silently expose all data).

**"User not found" at startup.** Double-check the email matches
exactly (case-sensitive, no trailing whitespace). List users:

```bash
docker exec processmining-db-1 psql -U flowminer -d flowminer \
  -c "select email, role from users order by created_at"
```

**Tools list is empty in Claude.** Make sure you ran `docker compose
build backend` after pulling the MCP code — the `mcp` package is
listed in `requirements.txt` and must be baked into the image for the
server to import. Or install it live:

```bash
docker exec processmining-backend-1 pip install mcp
```

**Slow responses.** The MCP server re-uses the same mining engine the
REST API uses, so any log that's slow in the web UI will also be slow
over MCP. Cache your improvement report by visiting the OCPM page
once first — many MCP tools pick up the cached result for free.

## Security notes

- The MCP server is designed to run as a subprocess of a trusted
  client on the same host (the standard MCP stdio model). Exposing
  it over the network would require wrapping it in an HTTPS gateway
  with its own authentication — out of scope for v1.
- Tool calls are authorised against the **single** user named by
  `FLOWMINER_MCP_USER_EMAIL`. The server cannot impersonate any
  other user. To serve multiple users, run multiple server instances
  (one per user) or wait for a future version that accepts a
  per-request bearer token.
- Every tool call is logged to stderr with the tool name and user
  email. Redirect stderr to a file if you want an audit trail:
  `2>> /var/log/flowminer-mcp.log`.

## What's next

v2 plans (tracked in `phases.md`):

- HTTP+SSE mode for remote MCP deployment.
- Per-request auth via bearer token so one running server can serve
  many users.
- Write-back tools (apply filters, tag cases, save dashboards) once
  the intra-app write-back surface lands in Phase 6.
