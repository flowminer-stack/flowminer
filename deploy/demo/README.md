# demo.flowminer.io — VPS setup

This directory holds the bits needed to run the FlowMiner public demo
on a dedicated VPS. The demo is a full FlowMiner instance with:

- A pre-seeded **demo user** (`demo@demo.flowminer.io`, locked,
  role = `viewer`) that every anonymous visitor auto-logs in as.
- Three **preloaded event logs**: `running-example.csv`,
  `sample-order-management.jsonocel`, and `container_logistics.json`.
- A **write-guard middleware** that rejects every POST / PUT / PATCH
  / DELETE outside the analytics allowlist, so visitors can click
  through every mining view but can't upload, delete, or modify
  anything.
- A **Celery beat** job that purges and re-seeds the demo data every
  hour, so any oddness from a previous visitor is cleared.
- **Ask AI** backed by a project-owned **OpenRouter** key, so the
  chat panel works with no credentials.

None of this changes the normal self-host path: the demo is a single
env flag — `DEMO_MODE=1` in `.env` — on top of the stock
`docker-compose.yml`. No compose override, no extra files.

## Server sizing

- **2 vCPU / 4 GB RAM** is enough for the three preloaded logs and a
  handful of concurrent visitors. The biggest log
  (`container_logistics.json`) needs ~1 GB RAM during OCEL flattening.
- **20 GB disk**. Postgres + Redis + uploads + docker layers all sit
  comfortably below 10 GB; leave headroom for logs and backups.
- **Ubuntu 22.04 LTS** or **Debian 12** are the tested hosts.

## 1 · Bootstrap the VPS

SSH in as a user with sudo and run:

```bash
# Docker Engine + Compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker  # or log out/in

# Clone the repo
sudo mkdir -p /srv/flowminer && sudo chown "$USER":"$USER" /srv/flowminer
git clone https://github.com/flowminer-stack/flowminer /srv/flowminer
cd /srv/flowminer
```

## 2 · Fill in `.env`

Copy the template and set the required values:

```bash
cp .env.example .env
```

Required edits (every line below must be set, no defaults):

```ini
# ─ Secrets ───────────────────────────────────────────────────
SECRET_KEY=$(openssl rand -hex 32)
POSTGRES_PASSWORD=$(openssl rand -hex 16)
REDIS_PASSWORD=$(openssl rand -hex 16)
FLOWMINER_ENCRYPTION_KEY=$(openssl rand -hex 32)

# ─ Public-facing host ────────────────────────────────────────
CORS_ORIGINS=https://demo.flowminer.io

# ─ LLM for Ask AI (demo visitors don't bring their own key) ─
FLOWMINER_LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...replace-with-real-key...
OPENROUTER_MODEL=anthropic/claude-haiku-4-5

# ─ Production mode + demo behaviour ─────────────────────────
ENV=production
DEMO_MODE=1
```

`DEMO_MODE=1` is the only flag that turns this into a demo. It
arms the seeder, the write-guard middleware, and the anonymous
`/auth/demo` login. Leave it unset for a normal self-host stack.

The OpenRouter key owns all AI spend on the demo. Set a budget cap
in the OpenRouter dashboard to bound the monthly bill — a few dollars
is plenty for a demo that gets hundreds of chats a day, since every
turn goes through Haiku 4.5.

## 3 · First run

Launch the stack:

```bash
docker compose up -d --build
```

Watch the backend logs and wait for the seeder to finish:

```bash
docker compose logs -f backend
# …
# INFO  demo seeder: created demo user id=...
# INFO  demo seeder: loaded running-example.csv (...)
# INFO  demo seeder: loaded sample-order-management.jsonocel (...)
# INFO  demo seeder: loaded container_logistics.json (...)
# INFO  demo mode: seed complete
```

Smoke-test the API:

```bash
# Demo status endpoint should return demo_mode=true
curl -s http://127.0.0.1:8000/api/v1/demo/status

# Anonymous demo login returns a JWT
TOKEN=$(curl -sX POST http://127.0.0.1:8000/api/v1/auth/demo \
    | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# Writes are blocked
curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer $TOKEN" \
    http://127.0.0.1:8000/api/v1/projects \
    -H "Content-Type: application/json" \
    -d '{"name":"nope"}'
# → 403
```

## 4 · DNS + TLS

Point `demo.flowminer.io` at the VPS public IP (A record for IPv4,
optional AAAA for IPv6). Wait for the record to propagate (a minute
or two for most registrars).

Install Caddy for automatic Let's Encrypt certificates — it's the
lowest-friction TLS story and uses the same config file we ship here:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo cp /srv/flowminer/deploy/demo/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

That's it. Caddy handles cert issuance + renewal automatically, and
reverse-proxies `https://demo.flowminer.io` → the SPA container on
`127.0.0.1:3000`.

## 5 · Run under systemd

The compose stack is already set to restart containers on crash and
on host reboot (`restart: unless-stopped`). For defense-in-depth,
register the `flowminer-demo.service` unit so a full OS boot brings
the stack up even if the Docker daemon restart policy breaks:

```bash
sudo cp /srv/flowminer/deploy/demo/flowminer-demo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now flowminer-demo.service
```

Check it survived a reboot:

```bash
sudo reboot
# …after the VPS comes back…
curl -s https://demo.flowminer.io/api/v1/demo/status
```

## 6 · Operations

### Rotate the OpenRouter key
```bash
sudo -e /srv/flowminer/.env  # set new OPENROUTER_API_KEY
sudo systemctl restart flowminer-demo.service
```

### Force a demo reset (outside the hourly cron)
```bash
cd /srv/flowminer
docker compose exec backend python -c "\
import asyncio; \
from app.database import async_session; \
from app.services.demo_seeder import reset_demo_data; \
async def run():
    async with async_session() as s:
        await reset_demo_data(s)
asyncio.run(run())"
```

### Tail the write-guard 403s
```bash
docker compose logs -f backend | grep -i 'demo sessions are read-only'
```

### Back up the demo database
Not required — the seeder will rebuild everything from scratch on
every boot. Backups are only worth the effort on real customer
deployments.

## File map

| File | Role |
|---|---|
| `README.md` | This doc. |
| `Caddyfile` | Reverse-proxy config for Caddy — TLS + HTTP/2 + the demo hostname. |
| `flowminer-demo.service` | Systemd unit that runs `docker compose up` on boot. |

Demo behaviour is purely runtime — flip `DEMO_MODE=1` in `.env`
and the same `docker-compose.yml` everyone else uses turns into
the locked-down public demo.
