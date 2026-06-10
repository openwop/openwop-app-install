# Deploy pack: Fly.io

The fastest self-serve cloud deploy. Runs the shared backend image as a Fly
Machine with Fly Postgres and Fly secrets. Fly's proxy streams SSE natively, so
the SPA can talk to the backend over a single origin.

> Status: syntax-reviewed scaffold. Not yet validated against a live `fly`
> deploy — see [`../README.md`](../README.md) and verify in your account.

## Prerequisites

- [`flyctl`](https://fly.io/docs/flyctl/install/) and a Fly account.
- Run all commands from the **repo root** (the Dockerfile build context).

## Deploy the backend

```bash
# 1. Create the app (edit `app` in deploy/fly/fly.toml first, or pass --name).
fly apps create openwop-app

# 2. Managed Postgres, attached as DATABASE_URL.
fly postgres create --name openwop-db --region iad
fly postgres attach openwop-db --app openwop-app    # sets DATABASE_URL secret

# 3. Map DATABASE_URL → OPENWOP_STORAGE_DSN and set the required secrets.
fly secrets set --app openwop-app \
  OPENWOP_STORAGE_DSN="$(fly ssh console --app openwop-app -C 'printenv DATABASE_URL' 2>/dev/null | tr -d '\r')" \
  OPENWOP_SESSION_SECRET="$(openssl rand -base64 32)" \
  OPENWOP_BYOK_ENCRYPTION_KEY="$(openssl rand -base64 32)"
# (Simpler: read DATABASE_URL from `fly secrets list` / the attach output and
#  paste it into OPENWOP_STORAGE_DSN.)

# 4. Deploy.
fly deploy --config deploy/fly/fly.toml --dockerfile Dockerfile
```

Backend URL: `https://openwop-app.fly.dev`. Check `…/api/readiness`.

## Frontend (static SPA)

The backend image does not serve the SPA. Two options:

1. **Same-origin via a second Fly app** (recommended): build a tiny nginx app
   from [`../compose/frontend.Dockerfile`](../compose/frontend.Dockerfile) with
   `VITE_OPENWOP_BASE_URL=/api` and an nginx `proxy_pass` to the backend app —
   gives you one origin and no CORS.
2. **Any static host** (Fly static, Netlify, Cloudflare Pages, S3+CDN): build
   `frontend/react` with `VITE_OPENWOP_BASE_URL=https://openwop-app.fly.dev/api`
   and `VITE_OPENWOP_SSE_BASE_URL=https://openwop-app.fly.dev`, then set
   `OPENWOP_CORS_ORIGINS` on the backend to the SPA origin.

## Upgrading to signed-in tenants (`auth` posture)

Set `OPENWOP_DEPLOY_POSTURE=auth`, wire an OIDC issuer (`OPENWOP_OIDC_*`), and a
real KMS key. Fly has no managed KMS — use AWS KMS or Azure Key Vault
cross-cloud (`OPENWOP_BYOK_KMS_KEY=aws-kms:…` / `azure-keyvault:…`, see
[`../../backend/typescript/.env.example`](../../backend/typescript/.env.example))
or keep the portable local-AES key for a single-tenant install.

## Host contract

| Capability | Provided by |
|---|---|
| Container runtime | Fly Machine (root Dockerfile, `$PORT=8080`) |
| Relational store | Fly Postgres → `OPENWOP_STORAGE_DSN` |
| BYOK secret wrap | local-AES (default) or cross-cloud KMS |
| Identity | anon cookie, or any OIDC issuer |
| Edge / SPA / SSE | Fly proxy (non-buffering); SPA served per above |
