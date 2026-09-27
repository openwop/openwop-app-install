# ADR 0512 — Navigation-source telemetry (the DSA-028 evidence gate)

Status: Accepted (2026-08-02, maintainer acceptance of the corrected scope,
with the ownership rider below)
Date: 2026-08-02

## Context

The design-system assessment's one deliberately-open structural finding is
DSA-028: the top-level IA reads as an application catalog (17+ peer nav
sections). The closure plan (and ADR 0510 §8) gates any reorganization on
EVIDENCE: *"Research current user tasks with route/navigation analytics and
moderated tests. Do not reorganize solely from feature names."* No such
evidence exists — the analytics feature records page paths (`topPaths`) but
not HOW a destination was reached, so we cannot distinguish "nobody uses this
section" from "everyone reaches it through the command palette."

This ADR decides the telemetry that produces the evidence — and, because
navigation telemetry is the kind of instrumentation that can quietly become
surveillance, it decides the privacy posture FIRST and is deliberately left
`Proposed` for an explicit maintainer acceptance rather than self-accepted
with the implementation.

## Correction note (2026-08-02, at implementation start — premise falsified)

This ADR was written on the premise that the analytics feature already records
in-app page views and only needed one extra dimension. Implementation discovery
falsified that: analytics ingest is the PUBLIC beacon
(`/public-analytics/:orgId/collect`, ADR 0018/0236) for published sites, gated
by the ADR 0020 visitor-consent check — **the authenticated workspace shell
emits no page events at all.** The sidebar/palette/admin-rail navigation this
evidence gate needs is exactly the uninstrumented surface.

The real decision is therefore bigger than "a dimension": it is *whether to
record signed-in users' in-app navigation at all* — a workforce-analytics
consent surface (the people being measured are your members, not anonymous
visitors), which the Gate-0 visitor posture cited below does not cover. The
proposal below stands with these corrections:

- Recording requires a NEW, explicit, per-tenant admin opt-in
  (`workspace-nav-telemetry`, default OFF everywhere including the demo), with
  in-product disclosure to members while it is on — not inheritance of the
  visitor-consent gate.
- Events are counts-only as designed (destination route × source enum), keyed
  to the tenant, holding NO user id — aggregation happens at write time, so a
  per-user trail never exists to leak.
- Everything else (closed enum, aggregate-only reporting, retention lanes, the
  ≥4-week + moderated-tests gate on the IA program) is unchanged.
- **Ownership rider (acceptance condition):** the counter store, routes, and
  report live INSIDE `features/analytics` — a sub-toggle
  (`workspace-nav-telemetry`, `extraToggleDefaults` per ADR 0404 §P4, AND-ed
  with the parent `analytics` toggle) — never a second analytics system with
  its own consent/reporting chrome.

Left `Proposed`: the corrected scope — measuring members, even anonymously —
deserves a deliberate maintainer acceptance, not an inferred one.

## Decision (proposed)

### 1. What is recorded — counts of SOURCES, never content

One additional dimension on the analytics feature's EXISTING page event: the
navigation source, a closed enum —
`sidebar | palette | hub | breadcrumb | deep-link | in-app-link | admin-rail`.
Nothing else: no search queries, no palette input text, no element-level
click-stream, no dwell times, no per-user trails surfaced anywhere.

### 2. Consent + storage ride the existing rails

- The dimension is recorded ONLY when the analytics feature already records
  the page view — it inherits the analytics toggle and the ADR 0262 Gate-0
  consent posture verbatim. No analytics consent ⇒ no navigation source.
- Retention: identical to the page events it decorates (the ADR 0380 lanes);
  no new store, no new retention class.
- Reporting is AGGREGATE-only: an admin report of destination × source counts
  over a window. No per-user drill-down is built, deliberately.

### 3. What the evidence must show before DSA-028 proceeds

The IA program (plan Stream 3.3) starts only when the report can answer, over
≥4 weeks of real usage: which nav sections are reached primarily through
search/palette rather than the sidebar (candidates for demotion to hubs);
which destinations dominate (candidates for the job model's top level); and
which sections are effectively unvisited. Moderated task tests then validate
the proposed model — the ADR for the reorganization itself cites both.

### 4. Explicitly rejected

1. **Full click-stream / heatmap instrumentation** — answers the same question
   with radically more surveillance; rejected.
2. **Third-party analytics** — the data never needs to leave the host; the
   in-app feature already owns consent + retention.
3. **Skipping evidence and reorganizing from taxonomy** — the plan's own
   prohibition; a nav re-org that guesses wrong costs every user their muscle
   memory twice.

## Implementation sketch (lands only after acceptance)

- `frontend/react/src/chrome/` nav components stamp the source on the existing
  page-event emit (one field, closed enum, typed).
- `features/analytics`: the destination × source admin report (aggregate
  table + the existing date-window controls).
- Tests: the enum is closed (unknown sources dropped, not recorded); consent
  OFF records nothing; the report renders from aggregates only.

## RFC verdict

No OpenWOP RFC — host-extension analytics data only; the wire is untouched.

## Implementation record

| Piece | Status | Evidence |
|---|---|---|
| `workspace-nav-telemetry` sub-toggle (default OFF everywhere) | implemented | `features/analytics/feature.ts` `extraToggleDefaults` |
| Counts-only aggregation + report (`analytics:nav-counts`) | implemented | `navTelemetryService.ts` — (tenant, ISO week, source, route PATTERN) → count; closed enum; junk dropped; distinct-row cap; tenant-teardown-keyed like `workflow:spend-day` |
| Routes (AND-gated with parent per ADR 0404 §P4; uniform 404 when off) | implemented | `analytics/routes.ts` + `test/analytics-nav-telemetry.test.ts` (default-off 404, parent-off 404, aggregation, closed enum, tenant isolation) |
| Nav-source stamping (sidebar / palette / admin-rail; hub/breadcrumb enum reserved) | implemented | `chrome/navSource.ts` + click handlers; consumed once per route change |
| Beacon + member disclosure | implemented | `chrome/NavTelemetry.tsx` — posts the matched manifest PATTERN only; dismissible disclosure banner while on (4 locales) |
| Member-visible aggregate report | implemented | `AnalyticsPage` §Workspace navigation (toggle-gated) |

## Correction note — 2026-09-20 admin-taxonomy scope

The ≥4-week telemetry + moderated-test gate above remains binding for the
**primary workspace navigation** program tracked as DSA-028. It does not prevent
a reversible reclassification inside the already role-gated Admin rail when a
focused inventory has established a concrete structural defect: 44 visible
destinations, an 18-item Platform bucket, mixed everyday/cross-tenant Operations,
and an Access & data bucket spanning unrelated authority and job models.

The admin remediation preserves every URL, route tier, scope, feature gate, hub
alias, and explicit tenant/user menu override. It changes only the declared
default `nav.group` projection and the Admin landing composition. The decision
uses the 2026-09-20 static/live audit plus current official admin guidance:
Shopify's navigation guidance says to organize around user tasks, use the fewest
coherent categories, and reserve hub/interstitial navigation for deeper settings;
Microsoft 365's admin center pairs a searchable expandable directory with a home
of frequently used task cards. Sources:
https://shopify.dev/docs/apps/design/navigation,
https://shopify.dev/docs/api/app-home/latest/patterns/compositions/interstitial-nav,
and https://learn.microsoft.com/en-us/microsoft-365/admin/admin-overview/admin-center-overview.

This is a scope clarification, not permission to bypass the evidence gate for a
workspace-wide IA rewrite. Navigation-source telemetry remains the owner of
aggregate usage evidence and no second analytics store is introduced.
