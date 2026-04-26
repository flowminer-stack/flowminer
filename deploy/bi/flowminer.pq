// FlowMiner connector for Power BI / Power Query
//
// Usage:
//   1. In Power BI Desktop: Home → Transform data → New Source → Blank Query
//   2. Home → Advanced Editor → paste this entire file
//   3. Call FlowMiner.Contents("https://your-flowminer.example.com", "fmk_YOUR_API_KEY")
//   4. Expand the returned record to browse tables
//
// Requires: a FlowMiner API key with read access (generate one at
// Settings → API Keys in FlowMiner). Keys are scoped to your user's
// projects — this connector cannot see anything you cannot see in the
// web UI.

let
    FlowMiner.Contents = (baseUrl as text, apiKey as text) as record =>
        let
            // Pull the flat event log ID from a query so callers can pick one.
            // For the first call we just build a top-level folder with the
            // six BI tables. User picks an event_log_id and we return rows.
            headers = [
                #"Authorization" = "Bearer " & apiKey,
                #"Accept" = "application/json"
            ],

            GetTable = (tableName as text, eventLogId as text) =>
                let
                    url = baseUrl & "/api/v1/bi/" & tableName & "?event_log_id=" & eventLogId,
                    raw = Web.Contents(url, [Headers = headers]),
                    parsed = Json.Document(raw),
                    table = if List.Count(parsed) = 0
                            then #table({}, {})
                            else Table.FromRecords(parsed)
                in
                    table,

            ListEventLogs = () =>
                let
                    url = baseUrl & "/api/v1/event-logs",
                    raw = Web.Contents(url, [Headers = headers]),
                    parsed = Json.Document(raw),
                    table = Table.FromRecords(parsed)
                in
                    table,

            // One record per table, plus a function each.
            result = [
                EventLogs = ListEventLogs(),
                GetStatistics = (eventLogId as text) => GetTable("statistics", eventLogId),
                GetVariants = (eventLogId as text) => GetTable("variants", eventLogId),
                GetBottlenecks = (eventLogId as text) => GetTable("bottlenecks", eventLogId),
                GetActivities = (eventLogId as text) => GetTable("activities", eventLogId),
                GetCases = (eventLogId as text) => GetTable("cases", eventLogId),
                GetEvents = (eventLogId as text) => GetTable("events", eventLogId)
            ]
        in
            result,

    // Convenience: one-shot fetch for a specific table + log id
    FlowMiner.Table = (baseUrl as text, apiKey as text, tableName as text, eventLogId as text) as table =>
        let
            headers = [
                #"Authorization" = "Bearer " & apiKey,
                #"Accept" = "application/json"
            ],
            url = baseUrl & "/api/v1/bi/" & tableName & "?event_log_id=" & eventLogId,
            raw = Web.Contents(url, [Headers = headers]),
            parsed = Json.Document(raw),
            table = if List.Count(parsed) = 0 then #table({}, {}) else Table.FromRecords(parsed)
        in
            table,

    Module = [
        Contents = FlowMiner.Contents,
        Table = FlowMiner.Table
    ]
in
    Module
