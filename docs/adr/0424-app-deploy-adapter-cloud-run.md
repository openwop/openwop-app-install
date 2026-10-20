# ADR 0424 — App deploy-adapter seam + Cloud Run adapter (governed deployment v1)

Status: implemented (seam + mock + Cloud Run service ops, 2026-07-18) — source→image builds EXTERNAL-DEP-GATED (Cloud Build; see §Gates)

> **CORRECTED 2026-10-06 (ADR 0835 D1) — the adapter as shipped here could replace
> any service in the operator's project, the host's own backend included.** The
> caller named the Cloud Run service (any lowercase-kebab string), the adapter
> acted with the host's `run.admin` identity, and a failed `POST` fell back to
> `PATCH` with the caller's image; the spec set no `serviceAccount`, so the image
> ran as the project's default compute account; and any Editor (`runs:create`)
> could drive it. Now: the provider name is host-derived
> (`owa-<12 hex of sha256(tenant, org)>-<service>`) and every adapter verb refuses
> anything else; images must start with an `OPENWOP_APP_DEPLOY_IMAGE_PREFIXES`
> entry and revisions run as `OPENWOP_APP_DEPLOY_RUNTIME_SA` (each unset ⇒ 501);
> `deployApp` needs an acting user holding `host:app-deploy:manage` in the org.
> "Same project" (DECIDE-1) still holds; it is only safe with those three guards.

Decision source: **ADR 0349** (the deploy contract, deliberately consumer-less
"until a CONCRETE provider is chosen") + the ratified **DECIDE-1 memo**: Cloud
Run in the platform's own GCP project — native IAM/audit, revisions as the
rollback primitive, the ADR 0295 certificate-map tier for domains, no new
vendor custody.

## Decision

The activation slice, mock-first (the creative-video/computer-use discipline):

1. **The `DeployAdapter` contract** (`features/app-builder/deploy/adapter.ts`):
   `deploy({service, image, envKeys}) → {deploymentId, url, revision}` ·
   `rollback({service, toRevision})` · `status(service)`. Env is SYMBOLIC keys
   only (ADR 0343) — values bind in the deploy environment, never in canvas/
   artifact/adapter inputs (the 0349 invariant).
2. **Durable deploy records** (`app-deploy:deployment`, tenant-keyed,
   teardown-registered): idempotency key = `sha256(service|exportHash|image)`
   — a re-run/fork resolves the existing deployment, never re-deploys; CAS
   single-flight; every record carries the export lineage hash (auditable to
   canvas/export versions, the 0342 §84 requirement).
3. **The mock adapter** proves the whole loop with zero egress. The **Cloud Run
   adapter** drives the Admin API v2 (`projects.locations.services`
   create/patch + traffic-split rollback + get) via `guardedEgressFetch` with
   the host's metadata-server identity — the operator grants `run.admin`
   deliberately (the explicit opt-in). HONEST-OFF: no
   `OPENWOP_APP_DEPLOY_PROVIDER` ⇒ typed `capability_not_provided`; `mock`
   is explicit opt-in (test/dev).
4. **Sub-toggle `app-builder.deploy`** (OFF, tenant) gates the two new nodes in
   `feature.app-builder.nodes`: `deploy-app` (role:action, side-effectful) and
   `deployment-status` (read). The governed chain shape is COMPOSITION —
   `deploy-app` is designed to sit after `core.approvalGate` exactly like the
   repair chain's apply node; a packaged deploy chain ships when the first
   live provider deployment proves the flow (recorded, not speculative).

## Gates (recorded, honest)

- **Source→image builds**: a generated app exports SOURCE (ADR 0423's backend
  + the frontend targets); Cloud Run needs an IMAGE. v1 `deploy` takes an
  image reference (operator/CI-built); the in-host source→image lane needs the
  Cloud Build API — its own slice when an operator wants one-click builds
  (trigger recorded). Deploying with no image ⇒ typed `validation_error`,
  never a guessed build.
- **Custom hostnames**: the ADR 0295 GCLB certificate-map tier (operator
  infrastructure, per the memo) — not app code.
  > **CORRECTED 2026-10-17 (ADR 0906 P1):** only the ONE-TIME edge (global IP,
  > serverless NEG, URL map, HTTPS proxy, certificate map) stays operator
  > infrastructure, now codified as `scripts/custom-domain-edge.sh`. The
  > PER-DOMAIN certificate lifecycle (DNS authorization, managed certificate,
  > map entry) moved into the app behind the `host/edgeCertificates/` provider
  > port, active only when `OPENWOP_CUSTOM_DOMAIN_EDGE=gcp-certificate-manager`.
- A cross-host-normative `deploy-adapter` PACK KIND remains RFC-first
  (0349:43-45); this slice is host-internal.

**Residual (architect gate 2026-07-18):** the Cloud Run adapter's env mapping
(`env: [{name}]` from symbolic keys) and service create-vs-patch flow are
LIVE-VERIFICATION-PENDING — exercised only through the contract's mock until an
operator configures the provider (the recorded opt-in); first live deploy should
smoke the env/traffic shapes against the real Admin API. A crashed mid-deploy
record re-claims after a 15-minute stale window (CAS — no permanent tombstone).

## Implementation record

`deploy/adapter.ts` (contract + mock + Cloud Run REST adapter, honest-off
resolver) · `deploy/deployService.ts` (records/idempotency/CAS + the
env-symbolic guard) · nodes pack +`deploy-app`/`deployment-status`
(pack 1.8.0 + pin) · sub-toggle + seed ACK · `test/app-builder-deploy.test.ts`
(idempotent deploy, rollback, honest-off, env-value rejection, tenant
isolation, node honest-off).
