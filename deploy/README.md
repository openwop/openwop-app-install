# Deploying the OpenWOP app — choose your host

The app is **one portable container** plus a small per-host deploy pack. The
backend has no hard cloud dependency: storage, secret-wrapping (KMS), identity
(OIDC), and object storage are all selected by environment variables, and the
cloud SDKs are optional dependencies loaded only when their backend is chosen
(see `../backend/typescript/.env.example`). Pick the pack that matches where you
want to run it — every pack ships the **same** app.

## Pick a pack

| Pack | Best for | Managed DB | Secret wrap | Edge / SSE |
|---|---|---|---|---|
| **[`compose/`](compose/)** | laptop, VPS, on-prem, evaluation (the default) | bundled Postgres | local-AES | nginx (no buffering) |
| **[`fly/`](fly/)** | fastest self-serve cloud deploy | Fly Postgres | local-AES or KMS | Fly proxy |
| **[`render/`](render/)** | low-config PaaS (Render / Railway) | managed Postgres | local-AES | platform edge |
| **[`aws/`](aws/)** | enterprise on AWS | RDS Postgres | AWS KMS | CloudFront/ALB |
| **[`azure/`](azure/)** | enterprise on Azure / Microsoft shops | Azure Database for PostgreSQL | Azure Key Vault | Container Apps ingress |
| **[`gcp/`](gcp/)** | the steward's reference deployment | Cloud SQL | Cloud KMS | Firebase Hosting → Cloud Run |

Not sure? Start with **`compose/`** — it runs anywhere Docker runs and is the
reference the cloud packs are measured against.

## The host contract

Every pack provides the same set of capabilities; only the platform primitives
differ. A host is "OpenWOP-ready" when it can supply these:

| Capability | Required? | Default (portable) | Production option | Env knob |
|---|---|---|---|---|
| Container runtime on `$PORT` | **yes** | — | any OCI runtime | `PORT` |
| Relational store | for `auth`/persistence | sqlite file | any Postgres | `OPENWOP_STORAGE_DSN` |
| BYOK secret wrap | for `auth` | ephemeral / local-AES | managed KMS | `OPENWOP_BYOK_*` |
| Identity | for sign-in | anon cookie | any OIDC issuer | `OPENWOP_OIDC_*` |
| Durable host surfaces | optional | in-memory | Postgres-backed | `OPENWOP_SURFACE_*` |
| Object storage (`host.blob`) | optional | local | any S3-compatible | `OPENWOP_BLOB_S3_*` |
| Streaming edge for `/api` (SSE) | **yes** | — | non-buffering proxy/CDN | per pack |

The two hard requirements are a container runtime and a **non-buffering edge**
for `/api` (Server-Sent Events power run streaming; a buffering CDN delays
output until a run finishes). Everything else has a portable default and a
managed upgrade.

## Deploy postures

`OPENWOP_DEPLOY_POSTURE` selects the security envelope, independent of host:

- **`cookie-per-visitor`** (default) — anonymous per-visitor tenants, in-memory
  secrets. No DB or KMS required. Non-durable; suitable for evaluation and demo deployments.
- **`bearer-shared`** — a single shared API/admin token.
- **`auth`** — signed-in (OIDC) tenants with persistent, KMS-wrapped secrets.
  Requires `OPENWOP_STORAGE_DSN` **and** a real `OPENWOP_BYOK_KMS_KEY`; the
  server refuses to boot in `auth` without KMS.

See each pack's `README.md` for the exact platform steps, and
`../backend/typescript/.env.example` for the full capability-keyed env surface.
