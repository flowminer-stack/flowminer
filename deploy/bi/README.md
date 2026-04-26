# FlowMiner BI connectors

Live data connectors for **Power BI** and **Tableau Desktop**. Both pull
directly from the FlowMiner REST API (`/api/v1/bi/*`) using a standard
API key — no Power BI gateway, no Tableau extension, no row caps.

## What you get

Six flat tables per event log, hand-shaped for BI consumption:

| Table | Row shape | Typical use |
|---|---|---|
| `statistics` | 1 row | KPI headline cards |
| `variants` | One per process variant | Variant bar chart |
| `bottlenecks` | One per activity | Activity waiting-time chart |
| `activities` | One per distinct activity | Occurrence / cases-touching heatmap |
| `cases` | One per case | Histogram, drill-down table |
| `events` | One per event | Flat stream for custom modeling |

All tables include `event_log_id` as the join key so you can blend
multiple logs in one report. Every column has a fixed type — no nested
records, no variable keys.

## Power BI

1. Open Power BI Desktop → **Home** → **Transform data** → **New Source**
   → **Blank Query**.
2. **Home** → **Advanced Editor** → paste the full contents of
   [`flowminer.pq`](./flowminer.pq).
3. **Done** → in the formula bar, call:
   ```
   = FlowMiner.Contents("https://your-flowminer.example.com", "fmk_YOUR_API_KEY")
   ```
4. Expand the returned record — you'll see an `EventLogs` table plus a
   function per BI table. Call one function per table you want, passing
   the event log ID:
   ```
   = FlowMiner.Contents(...)[GetVariants]("00000000-0000-0000-0000-000000000000")
   ```

Generate an API key at **Settings → API Keys** inside FlowMiner. Keys
are scoped to your user's projects — this connector cannot see anything
you cannot see in the web UI.

### Refresh semantics
Mining results are cached in FlowMiner for 15 minutes per event log.
A Power BI scheduled refresh pulls fresh data — the cache key is per
event log, so refreshing one report does not invalidate another.

## Tableau Desktop

1. Host [`flowminer-wdc.html`](./flowminer-wdc.html) on any HTTPS endpoint
   Tableau can reach (S3, GitHub Pages, your own nginx).
2. In Tableau Desktop: **Connect** → **To a Server** → **Web Data
   Connector** → paste the URL of the hosted HTML file.
3. Fill the form — base URL, API key, event log ID, table — and click
   **Get Data**.
4. Tableau pulls rows into a fresh data source. Repeat for every table
   you want.

### Pagination
Tables with potentially huge row counts (`cases`, `events`) paginate
10,000 rows per request. The WDC auto-follows until the API returns an
empty page.

## Security notes

- Both connectors send the API key via `Authorization: Bearer fmk_…`
  headers. Use HTTPS in production.
- An API key is a bearer token with the owning user's access — rotate it
  at **Settings → API Keys** if it leaks.
- The `/api/v1/bi/*` routes reuse the same row-level authorization as
  the rest of FlowMiner's REST API — you cannot read a log you cannot
  access in the UI.

## Why not OData?

Power BI's native OData connector is convenient but forces a specific
envelope shape. A thin M-language wrapper gives exactly the column set
you want without paying OData's descriptive overhead, and it sidesteps
the `$metadata` round-trips that slow Celonis' connector down on large
Power BI refreshes.
