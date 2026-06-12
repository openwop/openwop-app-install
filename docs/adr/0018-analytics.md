# ADR 0018 — Analytics (public-surface measurement + Conversions API)

**Status:** implemented (Phase 1 + frontend + the core-app extension surface; Phases 2–3 — UTM/session client + Conversions API — follow-on)
**Date:** 2026-06-10 (backend implemented 2026-06-11)
**Depends on:** ADR 0001 (feature-package), ADR 0006 (RBAC), ADR 0012 (Publishing —
the public surface measured), ADR 0014 (feature workflow surfaces), ADR 0020 (Consent — gates ingest, **shipped first**)
**Toggle:** `analytics` · **Surfaces:** authed `/v1/host/sample/analytics/orgs/:orgId/*`
+ **public (unauthed) beacon** `/v1/host/sample/public-analytics/:orgId/collect`
(host-extension, NON-NORMATIVE — no RFC)
**MyndHyve §:** Analytics · **Baseline:** `src/features/analytics/{AnalyticsService,
ABTestingService,WebVitalsService}.ts` + `src/features/tracking/clickIdCapture.ts`
+ `functions/src/conversions-api/` (Meta / TikTok / Google Offline)

---

## Context (boundaries audit first)

The **measure** leg of the Growth & Engagement loop. Publishing (0012) and Sharing
(0013) put pages on a public surface; nothing records who reaches them. Analytics
ingests page/event/conversion hits from that surface and reports on them.

**Pre-existing-surface audit:**
- **`analytics` namespace is free** — no `src/features/analytics`, no analytics
  route (the broad grep only hits unrelated `authRoutes`/`workforces` substrings).
- **The public surface to instrument already exists** — Publishing serves pages at
  `/v1/host/sample/public/:orgId/*` via `publicPageBySlug` (`publishing/routes.ts:51`).
  Analytics adds a sibling **public beacon** (`/public-analytics`), reusing the
  `PUBLIC_PATH_PREFIXES` + tenant-from-org pattern (0012/0013), not a new mechanism.
- **A/B already exists host-side — do NOT re-port `ABTestingService`.** The
  feature-toggle system is the experiment engine: sticky `% 10000` bucketing,
  weighted variants, replay-safe `run.metadata.featureVariant` (FEATURES.md). The
  baseline's standalone A/B service would be a **second** experiment system — the
  exact duplication this skill guards against. Analytics only **reports** on the
  existing variant assignments.

What is **new**: the event store, the public beacon ingest, the authed org-scoped
reporting surface, and the server-side Conversions API forwarder.

## Decision

An `analytics` feature-package (toggle `analytics`, default OFF, `bucketUnit:
tenant`) with a **public unauthed beacon** that records events and an **authed,
org-scoped, RBAC reporting** surface. Ingest is **consent-gated** (ADR 0020) and
rate-limited; the server records and validates — nothing trusted is derived from
the client beyond the event payload.

### The model

```
AnalyticsEvent { eventId, tenantId, orgId, type('pageview'|'event'|'conversion'),
                 path?, name?, ts, sessionKey?, referrer?,
                 utm?: { source, medium, campaign, term, content },
                 clickIds?: { fbclid?, gclid?, ttclid?, li_fat_id? },
                 props?: Record<string, string|number|boolean> }   // APPEND-ONLY
```

`DurableCollection<AnalyticsEvent>('analytics:event')`. Aggregates (views, sessions,
conversions, UTM/variant breakdowns) are computed on read in v1; a rollup is the
scale path (open question).

### Phase 1 — event store + public beacon + authed reporting

- **Public ingest** `POST /v1/host/sample/public-analytics/:orgId/collect`
  `{ type, path?, name?, utm?, clickIds?, props? }` — unauthed; tenant from the org
  (`getOrg`); gated on the org-tenant's `analytics` toggle **and** Consent (0020,
  `analytics` category — deny-by-default in regulated regions); per-IP rate-limited;
  payload-capped; appends one event. (Add `/v1/host/sample/public-analytics` to
  `PUBLIC_PATH_PREFIXES`.)
- **Authed reporting** `GET /v1/host/sample/analytics/orgs/:orgId/{summary,events}`
  (`authorizeOrgScope`, `workspace:read`) — counts, top paths, UTM + variant
  breakdowns, recent events; tenant+org IDOR-guarded.

### Phase 2 — UTM + click-id capture + sessionization

Port `clickIdCapture.ts` (fbclid/gclid/ttclid/li_fat_id) and UTM parsing as a thin
client helper feeding the beacon; derive a `sessionKey` (opaque, non-PII) for
session/bounce metrics.

### Phase 3 — server-side Conversions API

`POST /v1/host/sample/analytics/orgs/:orgId/conversions/forward` (`workspace:write`)
— forwards a conversion to Meta / TikTok / Google Offline **behind the host's
egress/SSRF policy** with **BYOK** provider tokens. Honest capability: a provider is
advertised/forwardable only when its credentials are configured (else a structured
`501`/clear error, mirroring the baseline's `provider_not_backend_routed`).

### Phase 4 — frontend

`AnalyticsPage` (nav-gated on `analytics`): org picker → summary cards (views,
sessions, conversions), UTM + variant tables, recent-events list. `analyticsClient.ts`.
The `npm run build` gate must pass.

## Core-app extension surface (node packs, agent packs, API)

Per **ADR 0014** (feature workflow surfaces), a feature is not only its REST + UI
faces — it must also **extend the core app's automation surface**. The surface below
is a committed phase (after the REST + UI phases), gated by the **same `analytics`
toggle** (all faces flip together), with signed `feature.analytics.*` packs published
to `packs.openwop.dev` (decoupled from toggle state for replay).

- **Node pack `feature.analytics.nodes`** — `feature.analytics.nodes.track` (emit an
  event from a workflow), `…query` (read a metric/summary into a run — e.g. gate a
  branch on conversion rate), `…conversion-forward` (server-side Conversions API
  forward, behind the egress/SSRF policy + BYOK).
- **Agent pack `feature.analytics.agents`** — `feature.analytics.agents.insights`
  (summarizes a period's metrics + variant performance into findings).
- **`ctx.analytics` workflow surface** — typed `track` / `query`, behind the same
  toggle + RBAC, advertised at `/.well-known/openwop`.
- **Envelope type** — `analytics.report` (an AI-generated metrics summary).
- **API endpoints** — the public beacon + authed reporting + conversions routes
  above, reachable over MCP/A2A via the well-known advertisement.

## Architectural constraints honored

- **Reuse, don't duplicate, A/B (the headline boundary):** experiments stay in the
  toggle/variant engine; Analytics reports on `run.metadata.featureVariant` /
  assignment, never re-implements bucketing.
- **Consent-gated ingest:** the beacon calls `consentService.isAllowed(...)` (ADR
  0020) — fail-closed for `analytics` in regulated regions.
- **Server records, client doesn't assert:** tenant from the org, events validated +
  capped; the public surface 404s on toggle-off; opaque `sessionKey` (non-PII).
- **Egress discipline (Conversions):** outbound forwards run through the SSRF guard;
  provider tokens are BYOK, host-side, never on a result boundary.
- **No wire surface → no RFC:** entirely `/v1/host/sample/*`.

## Alternatives considered

1. **Re-port `ABTestingService`.** Rejected — the host already owns sticky-bucketing
   experiments; a second system would drift. Analytics consumes the existing one.
2. **Trust client-sent metrics / a third-party analytics SDK.** Rejected —
   zero-runtime-dep host; the server records + validates its own first-party events.
3. **Pre-aggregate on write (rollup tables now).** Deferred — v1 computes on read;
   rollup is the scale path once event volume warrants it (open question).
4. **Skip consent in v1.** Rejected — public visitor tracking without a consent gate
   is the exact compliance gap ADR 0020 exists to close; they ship as a pair.

## Open questions

- [ ] **Rollup + retention** — read-time aggregation over `list()` is a full scan;
  add a periodic rollup + event TTL when volume grows.
- [ ] **Bot/spam filtering** on the public beacon (UA heuristics, rate-limit tuning).
- [ ] **Geo/IP handling** — IP-derived geo is PII and consent-sensitive; default to
  not storing raw IP; decide coarse-geo policy with ADR 0020.
- [ ] **Core Web Vitals** (baseline `WebVitalsService`) — defer; needs the public
  client helper to report LCP/INP/CLS.
- [ ] **Sampling** for high-traffic orgs.
- [ ] **Beacon idempotency** — `collect` takes no idempotency key, so a client/network
  retry duplicates an event. Acceptable at the sample tier (analytics is inherently
  approximate, unlike a duplicate CRM lead); an `Idempotency-Key` is the fix if a
  consumer needs exactly-once counting.
- [~] **Anonymous events under an opt-in consent regime** — a beacon with no
  `sessionKey` resolves `subjectKey=''`, so under `consent` ON + opt-in it is
  **dropped** (no subject can bear consent). Intentional (fail-closed: no identity ⇒
  no tracking), so anonymous pageviews are lost under a strict regime; revisit if a
  "necessary-category aggregate count" is wanted.
- [x] **GDPR erasure reaches analytics events** — **Done 2026-06-11.** Analytics
  registers a purge handler on the host subject-erasure seam, so a consent
  data-subject delete also erases the subject's events (`deleteSubjectEvents`, keyed
  by the same `sessionKey`). See ADR 0020.

## Implementation record

| Aspect | Evidence |
|---|---|
| Backend service | `src/features/analytics/analyticsService.ts` — append-only `AnalyticsEvent` (pageview/event/conversion) + read-time `summarize` (counts, sessions, top paths, UTM sources); string/props caps |
| Routes | `src/features/analytics/routes.ts` — PUBLIC beacon (`/public-analytics/:orgId/collect`, tenant-from-org, toggle-gated, **consent-gated** → `202 {recorded:false}` when not consented) + authed reporting (`summary`/`events`, `authorizeOrgScope`); one core edit: `public-analytics` added to `PUBLIC_PATH_PREFIXES` |
| Consent pairing (ADR 0020) | the beacon calls the **real** `consentService.isAllowed(tenantId, sessionKey, 'analytics')` — the one consent rule, never re-implemented. This is why Consent (0020) shipped first |
| A/B reuse | `summarize` reports first-party events; experiments stay in the host toggle/variant engine — **no `ABTestingService` re-port** |
| Extension surface (ADR 0014) | `src/features/analytics/surface.ts` (`ctx.features.analytics`, read-only: summary/events) + `packs/feature.analytics.nodes/` (query) + `packs/feature.analytics.agents/` (insights, read-only) |
| Registration | appended to `BACKEND_FEATURES`; toggle `analytics` (off, tenant) |
| Tests | `test/analytics-route.test.ts` — 5/5 (beacon records, **consent gate 202→201**, reporting aggregation, toggle-off 404, well-known advert, surface/node smoke) |
| Verify | `tsc --noEmit` clean; full suite green apart from the known pre-existing pack/env failures (+ a load-induced `run-timeout` timing flake that passes in isolation — not analytics-coupled) |
| Frontend (Phase 4) | `frontend/react/src/features/analytics/` — `AnalyticsPage` (org picker → summary cards → top paths + UTM sources → recent events) + `analyticsClient.ts` + `routes.tsx`; appended to `FRONTEND_FEATURES`. `npm run build` gate green |
| Follow-on | Phase 2 (UTM/click-id client helper + sessionization + a `track` node), Phase 3 (Conversions API forward behind egress + BYOK) |
