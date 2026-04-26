# FlowMiner Helm chart

Deploys the backend, Celery worker + beat, frontend, PostgreSQL, and
Redis as a single release.

## Quick start

```bash
helm install flowminer ./deploy/helm/flowminer \
  --set ingress.host=flowminer.example.com \
  --set-string secrets.secretKey="$(openssl rand -hex 32)" \
  --set-string secrets.encryptionKey="$(openssl rand -base64 32)"
```

In production, override secrets via an external secret manager (Vault,
AWS Secrets Manager, Sealed Secrets). The baseline chart uses stock
dev values, and the backend's `config.validate_production_secrets()`
refuses to start on the insecure defaults when `ENV=production`.

## Air-gapped

Set `image.repository` to your private registry and
`secrets.llmProvider=ollama` to run without any outbound LLM calls.

## What's deployed

- `*-backend` Deployment (FastAPI, replicas: 2)
- `*-worker`  Deployment (Celery worker, replicas: 2)
- `*-beat`    Deployment (Celery beat, 1 replica)
- `*-frontend` Deployment (React + Nginx, 1 replica)
- `*-uploads` PersistentVolumeClaim (100Gi RWX)
- `*-secrets` Secret (override in production!)
- Ingress wiring `/api` → backend, `/` → frontend

## Extending

The chart is intentionally simple — sub-chart the PostgreSQL /
Redis dependencies or pair them with a managed service by setting
`database.externalUrl` / `redis.externalUrl`.
