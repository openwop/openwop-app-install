# Deploy pack: Docker Compose (vendor-neutral)

The **default** way to run the OpenWOP app. No cloud account, no `gcloud`, no
Firebase — just Docker. Runs the same backend image every cloud pack uses, with
a bundled Postgres and an nginx edge that serves the SPA and streams `/api`.

Good for: laptops, a single VPS, homelabs, air-gapped/on-prem, evaluation, and
as the reference any cloud pack is measured against.

## Quick start

```bash
cd deploy/compose
cp .env.example .env

# Generate the secrets (POSTGRES_PASSWORD is hex — it goes into the DSN, so it
# must be URL-safe; session/BYOK keys may be base64):
echo "OPENWOP_SESSION_SECRET=$(openssl rand -base64 32)" >> .env
echo "OPENWOP_BYOK_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env

docker compose up --build
open http://localhost:8080
```

Three services come up: `db` (Postgres), `backend` (the app container), and
`web` (nginx serving the SPA + proxying `/api`). The browser only ever talks to
`web`; `backend` and `db` stay on the internal network.

## What this pack satisfies (host contract)

| Capability | Provided by | Notes |
|---|---|---|
| Container runtime | `backend` service | the shared `../../Dockerfile`, `$PORT=8080` |
| Relational store | `db` (Postgres 16) | durable; `pgdata` volume survives restarts |
| Durable surfaces | Postgres | `OPENWOP_SURFACE_BACKEND=durable` (kv/table/cache/queue) |
| BYOK secret wrap | local-AES master key | `OPENWOP_BYOK_ENCRYPTION_KEY`; no cloud KMS |
| Identity | anon cookie (default) | or any OIDC issuer via `OPENWOP_OIDC_*` |
| Edge / SPA / SSE | nginx | `proxy_buffering off` → SSE streams on a single origin |
| Object store | optional MinIO | `--profile blob` (S3-compatible) |

## SSE note

OpenWOP run output streams over Server-Sent Events. The nginx config
(`nginx.conf`) sets `proxy_buffering off` on `/api`, so streams are delivered
incrementally over one same-origin `/api` path — no separate SSE origin and no
CORS. If you put your own CDN/proxy in front of this stack, it **must not
buffer** `/api`, or run output will arrive only after a run completes. Verify
with:

```bash
curl -N http://localhost:8080/api/v1/...   # -N = no buffering; tokens stream in
```

## Object storage (optional)

```bash
# Bring up MinIO and point host.blob at it:
OPENWOP_SURFACE_BLOB=s3 docker compose --profile blob up --build
# MinIO console: http://localhost:9001  (minioadmin / minioadmin by default)
```

## Going to production on your own host

- Put a TLS terminator in front (Caddy/Traefik/your LB) and set
  `OPENWOP_COOKIE_SECURE=true`.
- Use a managed Postgres instead of the bundled `db` by pointing
  `OPENWOP_STORAGE_DSN` at it and removing the `db` service.
- For signed-in tenants (`OPENWOP_DEPLOY_POSTURE=auth`) wire an OIDC issuer and
  a real KMS key — at that point a cloud pack (`../aws`, `../azure`, `../gcp`)
  is usually the better fit. See `../README.md`.
