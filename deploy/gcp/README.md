# Deploy pack: Google Cloud Platform (GCP)

The steward's reference deployment — the stack behind `app.openwop.dev`. Cloud
Run backend, Firebase Hosting frontend, Secret Manager, Cloud SQL (Postgres),
and Cloud KMS for production BYOK.

This is the most battle-tested pack, but also the most cloud-specific. If you
don't specifically want GCP, see [`../README.md`](../README.md) for lighter
options (the vendor-neutral [`../compose`](../compose) pack runs the same image
with no cloud account).

## Files

| File | Location | Why |
|---|---|---|
| `up.sh` | `deploy/gcp/up.sh` | the orchestrator (this pack) |
| `Dockerfile` | **repo root** | `gcloud run deploy --source .` builds it; shared by all packs |
| `firebase.json` | **repo root** | Firebase CLI resolves config + hosting `public` from the project root |
| `.firebaserc` | **repo root** | Firebase project/target binding |
| `DEPLOY.md` | **repo root** | the full GCP playbook (APIs, secrets, SQL, KMS, DNS) |

The Firebase configs and Dockerfile live at the repo root because the Firebase
CLI and Cloud Build expect them there; `up.sh` `cd`s to the repo root before
invoking `gcloud` / `firebase`, so it works unchanged from this subdirectory.

## Quick path

Dry-run first (prints every command without mutating cloud state):

```bash
OPENWOP_GCP_PROJECT=<project> \
OPENWOP_RUN_SERVICE=<cloud-run-service> \
OPENWOP_RUN_REGION=<region> \
OPENWOP_FIREBASE_TARGET=<firebase-hosting-target> \
OPENWOP_PUBLIC_BASE_URL=https://<your-domain> \
bash deploy/gcp/up.sh

# When the printed commands look right, execute:
OPENWOP_DEPLOY_CONFIRM=1 ... bash deploy/gcp/up.sh
```

See the root [`DEPLOY.md`](../../DEPLOY.md) for the full 16-step recipe and
[`DEPLOY-SMOKE.md`](../../DEPLOY-SMOKE.md) for the post-deploy verification.

## What this pack satisfies (host contract)

| Capability | Provided by |
|---|---|
| Container runtime | Cloud Run (`--source .` → root Dockerfile) |
| Relational store | Cloud SQL (Postgres) — `OPENWOP_STORAGE_DSN` |
| BYOK secret wrap | Cloud KMS — `OPENWOP_BYOK_KMS_KEY=projects/.../cryptoKeys/...` |
| Identity | Firebase Auth (OIDC) — `OPENWOP_OIDC_*` |
| Edge / SPA / SSE | Firebase Hosting; SSE bypasses the `/api` CDN to the Cloud Run origin |
| Object store | optional GCS (S3-interop) or any S3-compatible — `OPENWOP_BLOB_S3_*` |

## SSE note

Firebase Hosting buffers the `/api` rewrite, which breaks SSE. `up.sh` builds
the SPA with `VITE_OPENWOP_SSE_BASE_URL` pointed **directly** at the Cloud Run
service URL so run streams bypass the CDN. This is the GCP-specific shape of the
same non-buffering-edge requirement every pack documents.
