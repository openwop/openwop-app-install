# Deploy pack: Render / Railway

Low-config PaaS. The [`render.yaml`](render.yaml) Blueprint provisions all three
pieces — backend (Docker), managed Postgres, and the static SPA — from this
repo. Good for a hobby/eval deploy with almost no infra work.

> Status: syntax-reviewed scaffold (YAML validates). Validate against a live
> Render Blueprint apply — see [`../README.md`](../README.md).

## Render (Blueprint)

1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, point it at the repo. Render reads
   `deploy/render.yaml`? No — Render looks for `render.yaml` at the repo root.
   Either move/symlink it to the root, or paste its contents when creating the
   Blueprint. (Kept here so all packs live under `deploy/`.)
3. Render creates `openwop-db`, `openwop-backend`, `openwop-frontend` and
   generates `OPENWOP_SESSION_SECRET` + `OPENWOP_BYOK_ENCRYPTION_KEY`.
4. **Manual wiring after the first deploy** (the two service URLs aren't known
   until they exist, and Render's `fromService` doesn't expose a ready-made full
   URL):
   - On `openwop-frontend`, set `VITE_OPENWOP_BASE_URL` and
     `VITE_OPENWOP_SSE_BASE_URL` to the backend URL
     (`https://openwop-backend.onrender.com`), then redeploy so the SPA bundle
     picks them up.
   - On `openwop-backend`, set `OPENWOP_CORS_ORIGINS` to the frontend URL.

The SPA calls the backend cross-origin; Render web services stream SSE without
buffering, so run output streams correctly. The backend strips the `/api`
prefix itself, so `VITE_OPENWOP_BASE_URL` pointed at the backend root works.

## Railway

Railway has no blueprint equivalent here, but the same image deploys cleanly:

1. **New Project → Deploy from Repo**, set the Dockerfile to `./Dockerfile`.
2. Add a **Postgres** plugin; Railway injects `DATABASE_URL` — map it to
   `OPENWOP_STORAGE_DSN`.
3. Set variables: `NODE_ENV=production`, `OPENWOP_DEPLOY_POSTURE=cookie-per-visitor`,
   `OPENWOP_SURFACE_BACKEND=durable`, `OPENWOP_SESSION_SECRET` and
   `OPENWOP_BYOK_ENCRYPTION_KEY` (`openssl rand -base64 32` each).
4. Deploy the SPA as a second service (static) or via the compose nginx image,
   pointing `VITE_OPENWOP_BASE_URL` at the backend service URL.

## Upgrading to signed-in tenants (`auth` posture)

Neither Render nor Railway has managed KMS. Use the portable local-AES key for a
single-tenant install, or point `OPENWOP_BYOK_KMS_KEY` at AWS KMS / Azure Key
Vault cross-cloud (`aws-kms:…` / `azure-keyvault:…`). Wire `OPENWOP_OIDC_*` to
any OIDC issuer.

## Host contract

| Capability | Provided by |
|---|---|
| Container runtime | Render/Railway web service (root Dockerfile) |
| Relational store | managed Postgres → `OPENWOP_STORAGE_DSN` |
| BYOK secret wrap | local-AES (default) or cross-cloud KMS |
| Identity | anon cookie, or any OIDC issuer |
| Edge / SPA / SSE | platform edge (non-buffering); SPA static, CORS-allowed |
