# flowminer-sdk

Async Python client for [FlowMiner](https://github.com/flowminer/flowminer), the open-source process mining platform.

## Install

```bash
pip install flowminer-sdk
```

## Quick start

```python
import asyncio
from flowminer import Client

async def main():
    async with Client("https://flowminer.example.com", token="your-jwt") as client:
        # List your projects
        projects = await client.list_projects()
        print(f"You have {len(projects)} projects")

        # Upload an event log
        log = await client.upload_event_log(
            project_id=projects[0]["id"],
            file_path="./orders.csv",
        )

        # Set column mapping
        await client.set_column_mapping(
            event_log_id=log["id"],
            case_id_column="order_id",
            activity_column="status",
            timestamp_column="updated_at",
        )

        # Run discovery
        graph = await client.discover(event_log_id=log["id"], algorithm="inductive")
        print(f"Discovered {len(graph['nodes'])} activities")

        # Get plain-language insights
        insights = await client.insights(event_log_id=log["id"])
        for insight in insights["insights"]:
            print(f"- [{insight['severity']}] {insight['title']}")

asyncio.run(main())
```

## Features

- Full async via `httpx.AsyncClient`
- Type hints throughout
- All ~80 FlowMiner API endpoints covered via thin wrappers
- Retry with exponential backoff on transient 5xx errors
- Automatic JWT refresh (when implemented server-side)

## License

MIT
