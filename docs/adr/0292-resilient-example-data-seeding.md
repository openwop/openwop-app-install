# ADR 0292 — Resilient example-data seeding (streaming, batch budget, offline path, demo provisioning)

Status: Accepted

## Context

The 10-phase demo-tenant seeding program (ADR 0031 registry; PRs #1344–#1389)
shipped ten `demo-*` seeders and was deployed to `app.openwop.dev`. A live
light/dark sweep of a fresh tenant surfaced two production-delivery problems the
in-process unit tests (all green) could not:

1. **The heavy seeders exceed the HTTP request timeout.** `POST
   /v1/host/openwop-app/example-data/run` for `demo-crm` (≈280 real service
   calls) returns `{"error":"request_timeout"}` after the 30 s
   `middleware/requestTimeout.ts` backstop; `demo-cdp` (≈2 200 events) is worse.
   A full reseed also outruns the **~60 s Firebase Hosting `/api` proxy budget**
   (the same buffering that made SSE bypass `/api` for a direct `*.run.app`
   URL — see `config.sseBaseUrl`). The timer sends a 503 but does **not** abort
   the handler, so the work often completes server-side anyway — the client just
   can't tell. The silent auto-seed-on-entry hits the same wall (`seedExampleAgents
   returned 503`). Recorded as **DG-SEED-6** (raised N→I).

2. **A fresh tenant's headline surfaces are toggle-gated off.** Eight seeders are
   toggle-gated (`demoCrmSeed.ts:97` → `resolveOne('crm', {tenantId})?.enabled`);
   a seeder **never flips a toggle** (the SEEDING.md invariant). Correct behavior,
   but it means CRM / commerce / merchandising / CDP / territories stay empty and
   absent from nav until their features are enabled — which only a superadmin can
   do. Recorded as **DG-SEED-7**.

These are host concerns only: the routes are host-extension
(`/v1/host/openwop-app/*`) and the toggle admin surface is non-normative. **No
`../openwop` RFC is required.**

## Decision

Four coordinated changes, one seam:

1. **Stream the seed.** `runExampleDataSeed` gains an optional `onStep` emitter;
   `POST …/example-data/run` streams NDJSON (`{type:'step'}…{type:'summary'}`)
   when the client sends `Accept: application/x-ndjson`. The route flushes headers
   first, so the request-timeout timer becomes a no-op (it only fires while
   `!headersSent`) — exactly the SSE-safety already in `requestTimeout.ts`. The
   SPA consumes the stream from **`config.sseBaseUrl`** (direct Cloud Run),
   bypassing the buffering `/api` proxy, and renders live per-step progress.

2. **Batch timeout budget (fallback).** `resolveTimeoutForRequest` gives the
   `example-data/{seed,run,clear,provision-demo}` routes a 300 s budget (bounded
   by Cloud Run's outer timeout; env `OPENWOP_BATCH_REQUEST_TIMEOUT_MS`) so the
   plain-JSON path (curl, tests, the on-entry auto-seed) stops 503-ing at 30 s.

3. **Offline seed script (DG-SEED-6).** `scripts/seedTenant.ts` boots host-ext
   persistence + the compiled toggle defaults and calls `runExampleDataSeed`
   directly against a DSN (cloud-sql-proxy for prod) — no HTTP, no timeout, for
   ops/load-testing datasets.

4. **Demo provisioning (DG-SEED-7).** A new superadmin-gated `POST
   …/example-data/provision-demo` enables the demo feature toggles **for the
   calling tenant only** (a per-tenant `tenantOverrides[tenantId] = 'on'` — never
   the global default) via `host/demoProvision.ts`, then streams the full seed so
   the gated surfaces populate. **The toggle flip lives in the provisioning
   orchestration, above the pure seeders — a seeder still never flips a toggle.**

## Alternatives weighed

- **Just raise the timeout.** Rejected as the primary fix: the Firebase `/api`
  path caps ~60 s regardless of the middleware, and a multi-minute synchronous
  request gives no progress and dies on client disconnect. Kept only as the
  non-streaming fallback (#2).
- **Background job + poll.** More robust to disconnects but needs a job store,
  status polling, and lifecycle/GC. Streaming reuses the existing SSE-bypass
  precedent with far less surface; revisit if seeds grow past the 300 s Cloud Run
  budget.
- **Make the seeders flip their own toggles / default the demo features on.**
  Rejected — breaks the SEEDING.md "a seeder never flips a toggle" invariant and
  changes global posture for every tenant. Provisioning is an explicit,
  superadmin, per-tenant action instead.

## Trade-offs

- Streaming responses are `application/x-ndjson`, not the JSON envelope; the
  client branches on `Accept`. The non-stream path is preserved verbatim.
- `provisionDemoFeatures` read-modify-writes a shared toggle config to add a
  per-tenant override; concurrent provisions of the *same* toggle could race
  (acceptable for a low-frequency superadmin action).
- `DEMO_FEATURE_TOGGLE_IDS` is hand-maintained against the seeders' `resolveOne`
  calls (no per-seeder toggle declaration exists to derive it from) — a comment
  ties them together; drift shows up as an un-provisioned gated surface.

## Implementation

| Phase | Change | Files |
|---|---|---|
| B | `onStep` emitter | `host/exampleDataSeeders.ts` |
| B | batch timeout budget | `middleware/requestTimeout.ts` |
| B | streaming `/run` + superadmin `/provision-demo` | `routes/agentOps.ts` |
| B | per-tenant demo provisioning | `host/demoProvision.ts` |
| D | streaming client + provision action | `client/exampleDataClient.ts`, `settings/ExampleDataPage.tsx` (+4 i18n locales) |
| F | offline seed script | `scripts/seedTenant.ts` |
| E | tests + `data-gaps.md` DG-SEED-6/7 | `test/*`, `docs/research/data-gaps.md` |

## Open questions

- [ ] If a future seeder exceeds the 300 s Cloud Run outer timeout even streamed,
  move to a background job (alternative #2).
- [ ] Consider deriving `DEMO_FEATURE_TOGGLE_IDS` from a per-seeder `gatedBy`
  declaration to kill the hand-maintenance drift.
