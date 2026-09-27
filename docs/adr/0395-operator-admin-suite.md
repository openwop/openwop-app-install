# ADR 0395 — Operator admin suite (observability hub · system-health · webhook health · DLQ dashboard · admin tail)

**Status:** implemented (2026-07-17 — Phases A–D + E-partial; see § Implementation record)

**Date:** 2026-07-17

**Lane:** operator-facing admin UI over EXISTING backend primitives — one feature area, host-extension routes, no new wire, no new collectors/stores.

**RFC verdict:** **host-extension — NO new RFC.** Every panel reads host-internal data (readiness checks, delivery rows, DLQ state, usage rollups, span signals) and renders it. Routes live under `/v1/host/openwop-app/operations/*` (non-normative). Nothing is advertised on `/.well-known/openwop`. The one thing that would earn an RFC — a *cross-host* operator-metrics capability — is explicitly not proposed. See § RFC verdict.

> **Origin.** `docs/steward/MYNDHYVE-GAP-ANALYSIS.md` Executive-summary theme 5 ("Operator/admin surface breadth") + Platform-Core top-gap 4 ("Operator-facing admin UIs over existing backends … Mostly UI over data that already exists — cheap parity wins") and its § Cross-cutting theme: *"openwop consistently has stronger backend enforcement primitives than MyndHyve (durable webhook delivery, DLQ state machine, hard token caps, capability firewall, OTel, MCP/A2A servers) but lacks the operator-facing admin dashboards."* This ADR gathers that whole cluster into ONE program — the high-ROI "UI over existing backend" wins — and draws the boundary against the L-sized net-new subsystems (entity system, environments) which are NOT part of it.

---

## Context — the primitives exist, the panels don't (boundaries audit MANDATORY)

The gap analysis is unusually explicit: on the operator spine openwop-app is *ahead* of MyndHyve on backend enforcement and *behind* on the panels that make it legible to an operator. The naive build — "stand up an observability stack + a metrics store + admin dashboards" — is a `no-parallel-architecture` violation on the same footing ADR 0118 already resisted. Every datum these panels need already flows somewhere; the corrected scope is **compose + render existing signals, add zero collectors and zero authoritative stores.**

Per-sub-surface boundaries audit — each panel names the existing backend it reads and the honest v1 limit:

| Panel (this ADR) | Existing backend owner (file:line) | What it reads | Honest v1 limit (no new collector) |
|---|---|---|---|
| **(c) Webhook-delivery health** | `host/webhookDeliveryWorker.ts` — `WEBHOOK_MAX_ATTEMPTS=5` (:38), `webhookBackoffMs` (:58), `processDueWebhookDeliveries` (:111, marks `dead` after budget) + `host/triggerBridgeService.ts` `listDeliveries` (:226, `DeliveryAttempt[]`), `setSubscriptionState` pause/resume (:232) | Per-subscription delivery attempts, state (`active`/`dead`), backoff schedule, dead-letter markers | Manual retry = re-enqueue via the EXISTING reschedule path; no new retry mechanic. No circuit-breaker (doesn't exist server-side → out of scope). |
| **(d) DLQ / pipeline dashboard** | `host/inMemorySurfaces.ts` — RFC 0017 ack/nack/dlq state machine, `deadLetter` (:993) routing to `${subject}.dlq` (:999) + CDP program **ADR 0262 / 0269** (`features/cdp/surface.ts`) | DLQ subject depths, dead-letter reason, original payload envelope | Depth = point-in-time count from the surface; NO historical depth time-series (no metrics store). Replay = re-publish through the existing surface, gated. |
| **(b) System-health panel** | `routes/health.ts` `/readiness` (:62 — `checks.managedProviders`/`config`/`storage`, 503-on-degrade) + `host/sseChannel.ts` `streamCounts` (:37, `OPENWOP_SSE_MAX_STREAMS_PER_TENANT`) + `host/sql/pgSql.ts` pool shape (:39) + `middleware/rateLimit.ts` per-IP budget + `routes/daemonStatus.ts` `buildDaemonStatus` (:27) | Liveness/readiness + per-check status, SSE stream counts, DB pool total/idle/waiting, rate-limit config, daemon liveness | **Per-instance, point-in-time only.** `streamCounts` is an in-process `Map` and the pool is per-process — under Cloud Run multi-instance these are per-revision-instance, NOT a global fleet total (no shared metrics store). v1 states this honestly; a fleet aggregate is out of scope (would need a new collector). |
| **(a) Unified observability hub** | `features/usage-analytics/UsageDashboardPage.tsx` + `getUsageRollupWithCost` (ADR 0118, token/USD by model/user, `costUsd`) + OTel span tree (`observability/tracer.ts`, ADR 0118) + `runs/` inspector (`RunTimeline`/`RunStepInspector`/`RunComparePage`/`RunDetailPage`) + `host/approvalService.ts` audit + ADR 0029 health index | Existing panels, composed into one navigable console | Composition, not new data. OTel deep-traces live in the operator's collector/Langfuse (ADR 0118) — the hub links out, it does not re-store spans. No "Performance" p50/p95 for infra (only LLM latency exists in the rollup). |
| **(e-1) Governance console** | `features/heartbeat-admin/` (ADR 0318) + `memory-auto-extract`/`profile-memory` + `advisory-board`/`twin` + usage-analytics | Links/embeds the existing surfaces into one console | Composition only (the gap-analysis "compose governance console — S"). |
| **(e-2) Sitemap admin** | `features/publishing` `sitemapXml`/`robotsTxt` (ADR 0012) | Surfaces the existing SEO output as a standalone admin panel | Read + priority hint; generation unchanged. |
| **(e-3) Imagegen quota / moderation** | `providers/dispatchImages.ts` + media budget caps (ADR 0106) + provider safety-filter handling (ADR 0115) | Config panel over existing caps/filters | Config surface over existing knobs; no new quota engine. |
| **(e-4) Model-allowlist surface** | `features/model-router/` (ADR 0130, already an admin surface at `/model-router`, graduated always-on) + ADR 0104 tool-allowlist | Per-workspace model-allowlist config | Extends the existing router config UI; no new router. |

**Net new (small, and only this):** (1) thin read-panel feature-packages for webhook-health, DLQ, and system-health; (2) ONE batched operator-summary read endpoint per hub load (see § Rate-limit discipline); (3) an `operations` **hub console** that composes these plus the existing usage/runs/governance panels as tabs; (4) two write actions — webhook *manual retry* and DLQ *replay* — each riding an EXISTING enqueue/publish path behind a gate. No new store, no new collector, no new metrics pipeline, no new event type.

**Explicitly OUT of scope v1 (a metric that doesn't exist server-side is not in scope — listed honestly):** fleet-global SSE/pool aggregation across Cloud Run instances (no shared metrics store); infra latency percentiles / historical depth time-series (no metrics collector — only the LLM `UsageRollup` has time-series); a webhook circuit-breaker (ADR-noted as absent); the L-sized net-new subsystems the gap analysis keeps SEPARATE — **entity/headless-content-modeling** and **environments (dev/staging/prod)** — which are their own ADR-first builds, not admin UI over an existing backend, and are NOT part of this program. Secrets-vault UI and MFA/break-glass (ADR 0002 deferrals) are the **security cluster**, tracked separately (they need backend, not just a panel).

---

## Decision

Ship the operator cluster as **one `operations` feature area composed through the existing ADR 0144 hub pattern**, not as panels scattered inside unrelated features.

### D1 — One `operations` hub console (ADR 0144 pattern), reusing the existing `Operations` nav group

The app already has (a) a top-level `Operations` nav group in `GROUP_ORDER` (`chrome/features.tsx:319`, admin tier, currently used by `ambient-work-graph` + `commerce-ucp`) and (b) a proven **hub-composition primitive** (ADR 0144 Access Hub; ADR 0145 Models console) where feature-package routes project into a tabbed console via `hubTab: { hub, order, featureId }` and the console renders `FEATURES.filter(r => r.hubTab?.hub === <hub>)`. We reuse both verbatim:

- A new `operations` hub at `/operations` renders tabs contributed by feature packages — exactly like `/access` and `/models`. **This is why it must be a hub, not one monolith page:** each panel stays its own feature package with its own toggle/gate/i18n/tests, and composition is data (`hubTab`), never a god-component. It also satisfies the **feature-package import-boundary rule** (ADR 0001): the hub does not import the panels' internals; it discovers their `hubTab` routes.
- The existing `usage-analytics` dashboard (ADR 0118) and the `runs/` inspector project in as tabs (no rebuild), joined by the new webhook-health / DLQ / system-health tabs. This directly realizes the gap-analysis "unified observability 5-tab hub — compose."
- Panels that are already their own admin surface (model-router `/model-router`, heartbeat-admin) are *linked/tab-projected*, not duplicated.

### D2 — Batched reads, bounded refresh (the rate-limit non-negotiable)

CLAUDE.md's rate-limit gotcha (a page that fans out many parallel reads on load blows a single real user past the per-IP budget → a wall of 429s) has bitten this app. Therefore: **each hub tab loads from ONE batched `GET /v1/host/openwop-app/operations/<panel>/summary` endpoint that fans in server-side** (e.g. webhook-health returns all subscriptions' rollups in one response; system-health returns readiness + SSE + pool + rate-limit config in one). No per-row / per-subscription client fetch (no N+1). Auto-refresh is a single bounded poll (default 30s, one request/tab) plus a manual refresh — orders of magnitude under the 300/min budget. Drill-down to a single subscription/run is an explicit user action, not fan-out.

### D3 — Two-tier gating: operator toggle for the surface, superadmin ENV for cross-tenant infra (a toggle is not an auth boundary)

These are **operator-private surfaces** (the ADR 0108 harness-witness precedent: some surfaces exist for the operator running the host, not for tenant end-users, and are gated to the operator identity). Gating is deliberately two-tier and **fail-closed**:

- **Cross-tenant / infra panels** (system-health, the fleet DLQ view, cross-tenant webhook health) read host-global state that is not tenant-scoped → **superadmin only** via `host/superadmin.ts` + env `OPENWOP_SUPERADMIN_TENANTS` (`requireSuperadmin`, the ADR 0118-prose / `features/assistant/routes.ts:294` health precedent). A non-superadmin gets a uniform **404** (no existence leak — the ADR 0088 posture).
- **Tenant-scoped panels** (a tenant's OWN usage rollup, a tenant's OWN webhook subscriptions/deliveries) are **`tier: 'admin'`** (tenant-admin), prefix-scoped to `tenantId`, IDOR-safe (a tenant admin reads only their tenant).
- The `operations` **feature toggle** (default **OFF**, `bucketUnit: tenant`) gates whether the hub renders at all — but it is a *product-surface* switch, **not** the auth boundary. The superadmin/tenant-admin checks are enforced on every route regardless of toggle state (defense-in-depth; a toggle-on never grants cross-tenant reach).

> **Reconcile the ADR 0118 surfacing-audit gotcha (do this in Phase A).** ADR 0118 §Correction records that its prose claimed `requireSuperadmin` but the usage dashboard shipped as `features/usage-analytics/` gated **`workspace:read`** (`tier: 'workspace'`), reachable by any workspace member — NOT admin-only. When usage-analytics projects into this operator hub, its **tab within `/operations` must carry the operator gate** (superadmin cross-tenant / admin own-tenant), even though its standalone `/usage` route keeps its current tier. The hub tab and the standalone route are gated independently (the ADR 0144 `hubTab.featureId` vs route-tier split makes this exact separation first-class). Flag: do not silently inherit `workspace:read` into an operator console.

### D4 — Write actions ride existing paths, gated + audited

Two panels have a write affordance; both reuse an existing mechanic and are audited:
- **Webhook manual retry** = re-enqueue a `dead`/failed `DeliveryAttempt` through the EXISTING `webhookDeliveryWorker` reschedule (resets attempt budget within `WEBHOOK_MAX_ATTEMPTS`); it does not bypass backoff policy or invent a new sender.
- **DLQ replay** = re-publish a dead-lettered message from `${subject}.dlq` back through the existing RFC 0017 surface `deliver`/publish; idempotency and dedup are the surface's, not new.
Both actions are superadmin-gated, logged to `host/approvalService.ts`/audit, and are the only mutations in the suite (everything else is read-only).

---

## Evaluation matrix

| # | Row | Verdict |
|---|---|---|
| 1 | **Feature-package architecture** (ADR 0001) | **Yes** — an `operations` area of thin read-panel feature-packages composed via the ADR 0144 hub; no god-component, import-boundary respected (hub discovers `hubTab`, never imports panel internals). |
| 2 | **Toggle / admin UI** | **Yes** — `operations` toggle default **OFF**, `bucketUnit: tenant`. The hub IS the admin UI. Toggle gates the surface; it is NOT the auth boundary (D3). |
| 3 | **Workflow + node packs** | **None — justified.** These are read/observe surfaces over host-internal operational state; there is no tenant-content workflow to author. (A future ops agent could get a `feature.operations.nodes` "query health/usage" read tool per ADR 0058 — noted as a follow-on, not v1, exactly as ADR 0118 §matrix row 3 scoped it.) |
| 4 | **AI-chat envelopes + agent packs** | **None — justified.** No in-run structured intent and no new envelope kind (RFC 0021 unaffected). An "ops analyst" agent reading these surfaces in chat is a clean follow-on via the ADR 0014 `ctx.features` read seam + a read tool — not a new exchange shape. No agent pack ships v1. |
| 5 | **RBAC** | **Yes, fail-closed** — two-tier: superadmin-env (`OPENWOP_SUPERADMIN_TENANTS`) for cross-tenant/infra; tenant-admin for own-tenant; uniform 404 for the unauthorized; IDOR-safe tenant-prefix scoping. ADR 0108 operator-private precedent; ADR 0118 gotcha reconciled (D3). |
| 6 | **Replay / fork** | **N/A — read-only aggregation.** Panels read recorded/live operational state; the two write actions (retry/replay) re-enqueue through existing idempotent paths and touch no run-event log, `run.metadata`, or fork behavior. No wire shape. |
| 7 | **Public surface** | **None** — every route is operator/admin-gated host-ext; nothing public, nothing on `/.well-known/openwop`. |
| 8 | **Reuse-not-recreate** | **Yes** — the ADR's spine. Reuses `webhookDeliveryWorker`, `triggerBridgeService`, `inMemorySurfaces` DLQ, `routes/health.ts`, `sseChannel`, `pgSql` pool, `usage-analytics`/OTel, `runs/`, ADR 0144 hub, `superadmin`, ADR 0029 index. Net-new = 3 thin panels + summary endpoints + hub. |
| 9 | **RFC gate honesty** | **Yes** — host-ext `/v1/host/openwop-app/operations/*`, no wire field/event/capability. Rides accepted RFC 0026/0084 + `observability.md` (via ADR 0118) and RFC 0017 (the DLQ surface). No RFC. |
| 10 | **Composes existing seams (not parallel)** | **Yes** — no second tracer, no second metrics store, no second delivery worker. `analytics` (ADR 0018, marketing/conversion lens) left untouched — a different lens, not collapsed (same discipline as ADR 0118). |

---

## Phased plan — ordered by ROI (smallest, most-self-contained first)

Sequenced so each phase ships + tests + reverts alone, cheapest-and-most-complete-backend first (the gap analysis rates (c)/(d) as the smallest S wins with the fullest backing data).

1. **Phase A — Webhook-delivery health (c).** ONE `operations/webhooks/summary` batched read over `listDeliveries` + `webhookDeliveryWorker` state; panel shows per-subscription attempt/backoff/dead-letter, pause/resume, and **manual retry** (re-enqueue). Reconcile the ADR 0118 usage-analytics tab gate here (D3). Tests: RBAC fail-closed + uniform-404, IDOR own-tenant, batched (no N+1), retry re-enqueues within `WEBHOOK_MAX_ATTEMPTS`, toggle-off 404 + self-hide.
2. **Phase B — DLQ / pipeline dashboard (d).** `operations/dlq/summary` over `inMemorySurfaces` `${subject}.dlq` depths + dead-letter reasons + CDP (ADR 0262/0269); **replay** action re-publishes through the existing surface. Tests: superadmin gate, replay idempotency, point-in-time depth honesty (no fabricated history).
3. **Phase C — System-health panel (b).** `operations/health/summary` fanning in `/readiness` checks + `sseChannel` counts + pool total/idle/waiting + rate-limit config + daemon status, in ONE response. **Superadmin-only.** Tests: per-instance-honesty caveat rendered (not a fleet total), 503-degrade surfaced, no secret/PII on the payload.
4. **Phase D — Unified observability hub (a).** Stand up the `operations` hub console; project usage-analytics + runs inspector + Phases A–C tabs into it via `hubTab: { hub: 'operations', order }`; add an audit-log view over `approvalService`. Tests: hub tab-projection, per-tab gating independent of standalone route tier, no import-boundary violation.
5. **Phase E — Admin tail (governance-console composition, sitemap admin, imagegen quota/moderation, model-allowlist surface).** Each an S composition/config panel projecting into the hub. Tests: config round-trips, links resolve, gates hold.

---

## Implementation record (2026-07-17)

| Phase | Landed as | Notes |
|---|---|---|
| A — Webhook health | `features/operations/` (toggle OFF, Admin, seedCoverage ACK) + Storage `listWebhookDeliveries`/`retryWebhookDelivery` (sqlite+postgres) + batched `webhooks/summary` (cross-tenant superadmin / org-scoped `webhooks:manage`) + manual retry + trigger pause/resume (audited) + `/operations/webhooks` panel (4 locales) | Safe projection test-pinned: delivery `secret`/`payload` never leave the module; URLs stripped to origin+path |
| B — DLQ dashboard | Backend-aware snapshot + gated replay: DURABLE bus (`hostsurf:bus` rows — fleet-shared; **OQ-3 resolved**: prod-durable replay survives restarts) AND the in-memory default (per-instance, said honestly in the response). Ids + reasons only — payloads never surface | Replay = kvDelete-as-atomic-claim then republish via the scheme's own counter; idempotent per message |
| C — System health | ONE `health/summary`: readiness primitives + SSE snapshot + effective rate limits + daemon status, `perInstance: true` rendered | No fleet aggregate fabricated (OQ-1 default taken) |
| D — Hub console | `/operations` hub page: inline Health + DLQ sections (operator-only state rendered honestly for non-superadmins) + console links | See correction note 1 (hubTab shape) |
| E — Admin tail | **Partial**: governance console + model-allowlist + usage + runs land as hub console-link composition. Sitemap-admin and imagegen-quota **dedicated config panels deferred** — trigger: first operator request; they are S-sized panels over existing knobs and slot into the hub as new cards | Honest partial, not silent |

**Correction notes:**

1. **D1 hub mechanism:** the ADR sketched `hubTab: { hub, order, featureId }` route
   projection; the as-built ADR 0144 pattern is per-path hubs with
   `hubTab: { group, order }`. The operations hub landed as a hub PAGE composing
   summary panels + links — each linked console keeps its own route + gate (the D3
   independence property holds by construction; usage-analytics deliberately LINKS
   OUT to its `workspace:read` standalone route rather than embedding, closing the
   ADR 0118 gate-inheritance concern without re-tiering the standalone).
2. **D3 tenant tier:** "tenant-admin" landed as the admin-tier `webhooks:manage`
   scope through `authorizeOrgScope` (no tenant-admin helper exists; the scope is
   the app's admin-tier webhook power — the natural gate for webhook health).
3. **Phase A storage additions** (`listWebhookDeliveries` read + `retryWebhookDelivery`
   re-arm) are reads/re-arms over the EXISTING queue table — consistent with the
   "no new store" boundary; recorded here because the ADR's sketch assumed reads
   already existed.

## Alternatives weighed

1. **External observability (Grafana / Datadog / Prometheus) instead of in-app panels.** Rejected as the *primary* surface, kept as complementary. openwop-app is a **white-label product** an operator ships to their own customers; "go read our Grafana" is not a deliverable an operator can hand to a downstream tenant-admin, and it presumes infra the white-label bundle can't assume. The OTel export (ADR 0118) already feeds any external stack for the deep-metrics case; these in-app panels give the *product* an operator console that ships in the bundle. Not either/or — the hub links out to the collector for deep traces (D-boundaries), owns the product-legible summary itself.
2. **Full APM integration (per-instance agent, fleet metrics store, historical time-series).** Rejected for v1 — it's precisely the "new metrics stack" the boundaries audit forbids, and it would drift from the ADR 0118 cost allowlist. The honest v1 limit (point-in-time, per-instance) is the correct scope for "UI over existing backend"; a fleet aggregate is a future collector decision (an ADR of its own), not smuggled in here.
3. **Panels inside each owning feature (webhook health inside triggers, DLQ inside CDP, etc.) — no unified hub.** Rejected — the gap-analysis pain is *"not one hub"*; scattering the operator surface is the status quo we're closing. The ADR 0144 hub already solved "many feature-package panels, one console" for credentials/models; reusing it gives cohesion without a god-component.
4. **Persist infra metrics in the host DB to power history/percentiles.** Rejected — a new authoritative store + write path (the ADR 0118 alt-3 rejection, reprised): storage cost, a second source of truth, and drift risk, for a v1 whose value is legibility of *current* state. History rides an external collector or a future explicit collector ADR.

## Open questions

1. **OQ-1 — Fleet aggregation.** System-health is per-instance under Cloud Run multi-instance. Is per-instance-honest sufficient for v1 (recommended), or is a shared read-side counter (Redis/DB) worth a follow-on collector ADR? Default: per-instance-honest + a rendered caveat.
2. **OQ-2 — Superadmin vs a distinct `operator` role.** Today cross-tenant reach = `OPENWOP_SUPERADMIN_TENANTS`. Do we want a narrower read-only `operator` role (health/webhook/DLQ read, no superadmin write powers)? Default: reuse superadmin for v1; a scoped operator role is a security-cluster follow-on.
3. **OQ-3 — DLQ store durability.** `inMemorySurfaces` is the RFC 0017 surface; confirm the DLQ view reads the DURABLE surface impl in prod (not a per-instance in-memory shadow) before promising replay across restarts.
4. **OQ-4 — Ops agent (matrix row 3/4 follow-on).** A `feature.operations.nodes` read tool + an ops-analyst agent reading the hub in chat — worth a follow-on ADR once the panels exist? Recommend: yes, after Phase D, via the ADR 0058 pattern.
5. **OQ-5 — Audit-log UI scope.** The hub's audit tab: reads `approvalService`/existing audit only, or does it fold the ADR 0118 "flight recorder" decision-record projection? Default: existing audit v1; flight recorder stays ADR 0118's follow-on.

## RFC verdict (explicit)

**Host-extension — NO new RFC.** All panels read host-internal operational data and render it; the two writes re-enqueue through existing idempotent paths. Routes are non-normative `/v1/host/openwop-app/operations/*`; no run-event field, event type, capability flag, endpoint contract, or normative MUST is added. It rides **already-accepted** RFC 0026/0084 + `observability.md` (through ADR 0118) and RFC 0017 (the DLQ surface). A new RFC would be warranted ONLY if a *cross-host* operator-metrics/health capability were later advertised on the wire — this ADR deliberately does not do that.
