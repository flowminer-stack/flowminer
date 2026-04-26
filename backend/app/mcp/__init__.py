"""FlowMiner MCP server.

Exposes the mining-engine endpoints as Model Context Protocol tools so
external AI agents (Claude Desktop, Cursor, Zed, Bedrock agents, any
MCP-aware client) can query process-mining data about a FlowMiner
installation.

The server is a thin proxy: it does NOT reimplement mining logic. It
receives MCP tool calls, authenticates the caller against a shared
secret or API key, loads the requested event log via the same
``_load_event_log_and_df`` path the REST endpoints use, runs the
matching ``mining_engine`` function, and returns the result.

Running
-------
Stdio mode (what Claude Desktop expects):

    docker exec processmining-backend-1 python3 -m app.mcp.server

Or via a wrapper entry point outside Docker once installed as a
wheel:

    flowminer-mcp --token $FLOWMINER_MCP_TOKEN

See ``docs/mcp-claude-desktop.md`` for a full client-configuration
example.
"""
