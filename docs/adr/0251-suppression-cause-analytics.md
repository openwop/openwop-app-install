# ADR 0251 — Suppression-cause analytics

|            |                                                                    |
| ---------- | ------------------------------------------------------------------ |
| **Status** | implemented (2026-07-04) — the ADR 0241 §"Open items" bounce/complaint analytics follow-on |
| **Deciders** | openwop-app maintainers |
| **Relates** | ADR 0241 (bounce/complaint ingestion — one source of suppressions), ADR 0249 (soft-bounce escalation — another), ADR 0217 (suppression owner + reasons), ADR 0210 (CRM reports — the "one endpoint, no dashboard fan-out" discipline), ADR 0208 (host verbs → node packs) |

## Context

ADR 0241 recorded a deferred open item:

> "Bounce/complaint analytics (a dashboard of suppression causes) — the
> suppression list already records the reason + note; a read projection is a
> future UX follow-on."

With ADR 0249 adding soft-bounce escalation, suppressions now arrive from several
causes (unsubscribe, hard bounce, complaint, soft-escalation, manual). An operator
wants to see *why* their do-not-contact list is growing. The data already exists in
the `crm:suppression` store; this is purely a read projection + surfacing.

## Decision

Add a `suppressionSummary(tenantId)` projection to `suppressionService` (the ADR
0217 owner) and surface it two ways — **not as a new dashboard**:

- **An authed route** `GET /crm/suppressions/summary` beside the existing
  `GET /crm/suppressions`, same `requireEnabled` + `tenantOf` gate.
- **A chat-drivable CRM node** `feature.crm.nodes.suppression-summary` over a new
  `ctx.features.crm.suppressionSummary` surface method — so "why is my suppression
  list growing?" is answerable through the EXISTING chat (agent + node), the
  [[build-on-orchestration-not-parallel-surfaces]] pattern.

The projection groups the SAME rows `listSuppressions` returns:

- **`byReason`** — the cause, all four reasons with a zero baseline
  (unsubscribed/bounced/complaint/manual).
- **`bySource`** — a coarse origin bucket derived from the actor
  (`webhook` / `soft-escalation` / `campaign` / `manual` / `user` / …), highest
  count first. `soft-escalation` is special-cased (its actor is
  `webhook:<provider>:soft-escalation`) so it reads distinctly from an immediate
  hard-bounce `webhook:<provider>`.
- **`total`** + **`newestAt`**.

**Counts + timestamps only — NO addresses.** The summary carries no PII; the
full per-address list stays behind the authed `GET /crm/suppressions`.

### No bespoke dashboard (the deliberate anti-parallel-surface call)

ADR 0241 called the open item "a dashboard of suppression causes." We explicitly
**decline a bespoke dashboard**:

- The CRM `ReportsTab` (ADR 0210) has a strict "one `/reports/pipeline` endpoint,
  no fan-out" discipline; grafting a suppression card there would violate it and
  add a second fetch. There is no other existing suppression FE surface.
- Per [[build-on-orchestration-not-parallel-surfaces]], a feature is a node +
  read projection surfaced through the existing chat/API — never a new read model
  + dashboard. The node makes the analytics answerable in chat; the route serves
  programmatic/UI consumers. If a dedicated FE surface is later justified, it
  consumes this one projection — it does not fork a parallel read model.

## Alternatives weighed

- **A suppression card in CRM ReportsTab.** Rejected — breaks the tab's one-endpoint
  discipline (ADR 0210) and doesn't fit its pipeline focus.
- **A new "List hygiene" CRM tab/page.** Rejected — a bespoke dashboard + surface
  for a projection that chat + the route already deliver (the /insights-suite
  anti-pattern the memory warns against).
- **Include recent addresses/examples in the summary.** Rejected — needless PII in
  an analytics rollup; the full list is one authed read away.

## Boundaries / wire

- **No wire change, no RFC.** Host-ext read (route under `/v1/host/openwop-app/*`
  + a node over the CRM surface); adding a surface method + node is additive.
- **Single source of truth.** The projection reads `listSuppressions` — the same
  rows, no parallel store. Suppression stays owned by `suppressionService`.
- **Tenant isolation.** Keyed by the caller tenant throughout; the node reads
  `ctx.features.crm` (tenant-scoped surface).

## Implementation

| Change | File |
| --- | --- |
| `SuppressionSummary` + `sourceOf` + `suppressionSummary(tenantId)` projection | `backend/typescript/src/features/crm/suppressionService.ts` |
| `GET /crm/suppressions/summary` route | `backend/typescript/src/features/crm/routes.ts` |
| `suppressionSummary` surface method | `backend/typescript/src/features/crm/surface.ts` |
| `suppression-summary` node + manifest entry (pack v1.4.0) | `packs/feature.crm.nodes/{index.mjs,pack.json}` |
| Tests — projection (reason + source buckets, empty-safe, no PII), node wrapper, route (auth + toggle gate) | `backend/typescript/test/crm-suppression-summary.test.ts` |

## Open items (deferred)

- **A dedicated FE surface** — only if a real operator need appears; it would
  consume this projection, not fork a read model (see the anti-dashboard call).
- **Time-bucketed trend** (suppressions/week by cause) — needs windowing over the
  rows; a later refinement if the point-in-time summary proves insufficient.
