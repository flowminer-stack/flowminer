# FlowMiner Desktop Capture Agent

A lightweight reference agent that records active window / application titles on a configurable polling interval and streams them to a FlowMiner instance as task-mining events. It is the bridge between a live desktop and the task-mining pipeline (recordings -> n-gram miner -> patterns -> cross-link to process activities).

## Requirements

- Python 3.11+
- The FlowMiner SDK (`flowminer` package)
- One optional platform-specific capture library (see below)

## Installation

```bash
# 1. (Recommended) create a virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# 2. Install the FlowMiner SDK
pip install flowminer

# 3. Install the capture backend for your platform (pick one)

# Windows — choose one:
pip install pygetwindow       # preferred
pip install pywin32           # alternative

# macOS — usually ships with the system Python; if not:
pip install pyobjc-framework-Cocoa pyobjc-framework-Quartz

# Linux (X11):
pip install ewmh python-xlib
# OR install the xdotool system package:
sudo apt install xdotool      # Debian / Ubuntu
sudo dnf install xdotool      # Fedora
```

## Quick Start

```bash
# Obtain a JWT from the FlowMiner UI (Settings -> API tokens) or via:
#   curl -s -X POST http://localhost:8000/api/v1/auth/login \
#        -d "username=you@example.com&password=secret" | jq -r .access_token

python agent.py \
  --base-url     http://localhost:8000 \
  --token        <your-jwt-token> \
  --project-id   <your-project-uuid>
```

The agent will:
1. Create a recording in your project.
2. Poll the active window every 2 seconds (configurable).
3. Buffer events locally and POST them every 30 seconds.
4. On Ctrl-C (or SIGTERM): flush the remaining buffer and mark the recording complete.

## All Options

| Flag | Default | Description |
|---|---|---|
| `--base-url` | `http://localhost:8000` | FlowMiner server base URL |
| `--token` | *(required)* | Bearer token for authentication |
| `--project-id` | *(required)* | UUID of the target project |
| `--interval` | `2.0` | Window-poll interval in seconds |
| `--flush-interval` | `30.0` | How often to POST buffered events (seconds) |
| `--activity-source` | `window_title` | Primary label: `window_title` or `application` |
| `--hostname` | *(auto)* | Override the hostname stored in the recording |
| `--notes` | | Free-text note attached to the recording |
| `--log-level` | `INFO` | `DEBUG` / `INFO` / `WARNING` / `ERROR` |

## Mine Patterns After Recording

Once you have at least one recording, trigger the n-gram miner from Python or the FlowMiner UI:

```python
import asyncio
from flowminer.client import Client

async def mine():
    async with Client("http://localhost:8000", token="<jwt>") as client:
        result = await client.mine_task_patterns(project_id="<uuid>")
        print(f"Discovered {result['patterns']} patterns "
              f"({result['stored']} stored)")

asyncio.run(mine())
```

## Platform Notes

- **Windows**: `pygetwindow` is tried first; `pywin32` is the fallback. Both capture the foreground window title.
- **macOS**: Uses `AppKit.NSWorkspace` for the app name and `Quartz.CGWindowListCopyWindowInfo` for the front window title. Both modules ship with macOS Python (`/usr/bin/python3`) and are also available via `pyobjc` on pip.
- **Linux (X11)**: Uses `ewmh` / `python-xlib` if installed, otherwise shells out to `xdotool`. Wayland support requires `xdotool` compiled with Wayland support or a compatible compositor.
- **No backend**: The agent degrades gracefully — it emits one `heartbeat` event per poll tick so the recording remains live and can still be ended cleanly.

## SDK Methods Added

The `flowminer.client.Client` class exposes these new task-mining methods:

```python
# Start / feed / stop a recording
recording = await client.create_recording(project_id, agent_version, hostname, notes)
result    = await client.ingest_events(recording["id"], events)   # auto-chunks > 5000
result    = await client.end_recording(recording["id"])

# Browse recordings and patterns
recordings = await client.list_recordings(project_id)
patterns   = await client.list_task_patterns(project_id)

# Run the n-gram miner
result = await client.mine_task_patterns(project_id, min_frequency=3)
```
