# ADR 0236 — Visitor-scoped CMS page experiments (campaign gap D1)

Status: implemented (2026-07-03)

## Context

The campaign gap analysis (docs/research/campaign-gap-analysis.md §5D D1) names
visitor-scoped experimentation + page variants (E6/E7) as "the one place a
genuinely new primitive is justified", with a deliberately small floor: an
**assignment seam on the public read path** over content and measurement that
already exist. Everything this needs is already built:

- **Variant content** — the CMS PageVersion store (ADR 0009 Phase 3): every
  submit/publish captures a `{title, slug, sections}` snapshot, and
  `restoreVersion` already reads one back into the draft.
- **Sticky weighted assignment** — the feature-toggle engine's salted
  `hashString → %10000` bucket walk (`host/featureToggles/bucketing.ts`).
- **The anonymous visitor identity + its consent rule** — the analytics beacon
  `sessionKey`, gated by the ONE `consentService.isAllowed(tenant, key,
  'analytics')` helper (ADR 0018/0020).
- **Measurement** — the append-only analytics event store, which already grew
  an additive bounded field once before (the `owx` email-click token, ADR 0226).
- **Publish machinery** — the CMS editorial verbs (`restoreVersion`, the
  `publish`/`submit` transitions) and the `cms-approval-gate` inbox (ADR 0066).

## Decision

Build the D1 floor as one small entity + four seams, composing the above.
**Hard boundaries (restated from the plan — these are scope walls, not
deferrals to revisit casually):**

- **The floor ONLY.** No client-side visual editor, no multivariate testing,
  no stats engine beyond a two-proportion z-test. This is explicitly NOT
  Optimizely (§6 non-goal: "a second experimentation product").
- **Assignment is by the CONSENT-GATED anonymous visitor key** — the analytics
  beacon `sessionKey`, passed as an optional `vk` query param on the public
  page read. No key ⇒ the plain published page. No consent ⇒ the plain
  published page. **Honest degradation: no experiment exposure without a
  consented key**, and the no-vk response is byte-identical to before
  (regression-tested).
- **Variants are EXISTING CMS page versions** (the PageVersion store) — no new
  content type. The **holdout** is a reserved variant (`versionId: null`)
  serving the current published content but still stamped/tracked.
- **Promote-winner = the EXISTING CMS verbs** (`restoreVersion` → the `publish`
  transition), then the experiment stops. No republish machinery.
- **EXTRACT, never fork, the toggle engine's bucketing** into a shared pure
  helper used by both consumers — byte-identical behavior for toggles.

### 1. Shared bucketing helper — `src/host/variantAssignment.ts` (extraction)

`hashString` / `bucketOf` / `assignWeightedVariant<V extends {key, weight}>`
moved verbatim from `host/featureToggles/bucketing.ts`; `bucketing.ts` is now a
re-export shim whose `assignVariant(unitId, toggleId, salt, variants)` keeps
its exact signature over the toggle `Variant` type. The toggle engine's
behavior is byte-identical (its tests run unmodified, plus a new test asserts
`assignWeightedVariant` ≡ `assignVariant` across inputs). Experiments call the
same math keyed `(visitorKey, experimentId, salt)` — sticky for the
experiment's life because the salt is fixed at creation.

### 2. Entity + service — `features/cms/pageExperimentsService.ts` (a content concern)

`PageExperiment { experimentId, tenantId, orgId, pageId, name, status:
draft|running|stopped|promoted, salt, variants: [{key, versionId|null,
weight 1..100}], createdBy, createdAt, updatedAt, startedAt?, stoppedAt? }` in a
`cms:pageexperiment` DurableCollection.

Validation: 2..6 variants; bounded unique keys; integer weights summing to
**exactly 100**; every non-null `versionId` must be an existing version **of
this page** (IDOR-guarded via the new `cmsService.getVersion`, re-checked at
start because snapshots age out of the 50-per-page cap). **ONE running
experiment per page** (start 409s otherwise — concurrent assignments would
contaminate each other's measurement). Running experiments are immutable
(edit/delete 409) — editing weights mid-flight silently reshuffles visitors.

Promote (running-only, takes `{variantKey}`): holdout ⇒ nothing to publish,
the experiment just ends `promoted`. Version variant ⇒ `restoreVersion` (page →
draft; the existing verb, which audits `cms.restore` itself) then:

- gate OFF ⇒ the `publish` transition (snapshot + lifecycle event as always);
- **gate ON ⇒ `submit` + the shared approval queue, and the response reports
  `pendingApproval: true` honestly** — the inbox stays the only publish path
  for a gated org (never a bypass). Known consequence, accepted: the page
  leaves the public surface (draft → in_review) until the reviewer decides —
  the same behavior as any manual restore-then-submit.

Audit: `cms.experiment.{create,update,delete,start,stop,promote}` rows via the
same best-effort `appendAudit` bookkeeping as `recordCmsAction`, with
**`payload.tenantId` REQUIRED** (the tenant-scoped governance read withholds
rows without it).

### 3. Routes — org-scoped under the CMS base (`pageExperimentsRoutes.ts`)

`/v1/host/openwop-app/cms/orgs/:orgId/pages/:pageId/experiments` (+ `/:id`,
`/:id/{start,stop,promote}`, `/:id/results`). Scopes mirror the CMS tiering:
list/get/results `workspace:read`; create/edit/delete `workspace:write`
(translator grant-holders 403 — ADR 0205 D1, an experiment steers base content
on the public surface); **start/stop/promote `host:members:manage`** (they
change what the public surface serves — the publish tier).

### 4. Public assignment seam — `publishing.publicPageBySlug` (+ `?vk=`)

Publishing COMPOSES (never stores): when the public page read carries a bounded
`vk` **and** a running experiment covers the resolved page **and**
`isAllowed(tenantId, vk, 'analytics')` passes (the beacon's exact gate), assign
the sticky variant. A version variant serves **that PageVersion's snapshot**
(title + sections — the restoreVersion read; live slug/status/SEO retained;
shared refs resolved; then the normal RFC 0103 localization). The holdout
serves the published content. Either way the response gains an **additive**
`experiment: {experimentId, variant}` stamp for the renderer. A snapshot that
aged out mid-experiment degrades to the published page **without** a stamp
(never attribute content the visitor didn't see). No vk / no consent / no
running experiment / oversized vk ⇒ **exactly today's behavior** (tested as a
deep-equal response comparison).

### 5. Beacon stamp — analytics (the `owx` additive-field precedent)

`AnalyticsEvent.experiment?: {id, variant}` — optional, bounded, dropped whole
unless both parts are non-empty strings. `recordEvent` parses it from the raw
beacon body; the renderer echoes the page-read stamp onto its events. The
results read goes through a new `listEventsForExperiment` export — the
cross-feature READ through the owning service (the `resolveClickToken`
precedent), never a direct store read.

### 6. Results — a read-time projection (no second store, no stats engine)

`GET …/results`: per variant — distinct stamped sessions, distinct converting
sessions (`conversion` events), conversion rate, and a pooled **two-proportion
z-test vs the FIRST variant** (pure math, ~10 lines, no dependency): `zScore`,
`significant` = |z| ≥ 1.96 (95%, two-sided), and an honest
`insufficientSample: true` below **30 sessions** on the variant or the
baseline — in which case `significant` is `null`, never a fake verdict.
Sample-size honesty over fake precision.

### 7. Frontend

- **Editor**: `features/cms/PageExperimentsPanel.tsx` — a lazy `<details
  className="surface-card">` sibling of the History panel on `/cms` (the
  ADR 0206 panel pattern): list + create (variant pickers over the page's
  captured versions + the holdout option), start/stop/promote, results readout
  (chips + `formatNumber`/`formatPercent` — never `toFixed`). i18n keys in all
  four locales (en/es/fr/pt-BR). No new tab machinery.
- **Public renderer** (adaptation, discovered during implementation): the SPA
  renders only the front page (`features/site/FrontPage.tsx`); **there was no
  SPA analytics beacon at all** (ingest is the backend collect endpoint,
  normally embedded by externally-served published sites). The front page now
  carries the beacon contract's anonymous key: `visitorBeacon.ts` mints a
  localStorage `sessionKey` once, `fetchPublicPage` passes it as `vk`, and
  **only when the response carries an experiment stamp** does the page fire ONE
  stamped pageview at the collect endpoint. Consent stays enforced
  SERVER-side on both the read and the collect (the one ADR 0020 rule — the
  client never implements a second consent copy). Non-experiment visitors
  generate zero beacon traffic (today's behavior). Conversion stamping is the
  embedding site's beacon's job; the SPA front page has no conversion events.

## Alternatives weighed

- **A new experiment content type / draft-copy variants** — rejected: the
  PageVersion store already is the content history; a second content store
  drifts (the build-on-orchestration lesson).
- **Reusing toggle variants directly (`bucketUnit: 'session'` toggles)** —
  rejected: toggles are tenant/user-scoped config with FE assignment payloads,
  not per-page anonymous-visitor config; forcing pages in would leak experiment
  config into every `/assignments` read. Extracting the pure math shares the
  behavior without coupling the stores.
- **Client-side assignment (renderer picks the variant)** — rejected: the
  consent gate and the snapshot read are server concerns; client assignment
  can't serve a different PageVersion without shipping every variant.
- **A stats library / sequential testing / CUPED** — rejected per the §6
  non-goal; the pooled z-test is the floor's honest ceiling.

## Explicit deferrals (per §6 — recorded, not forgotten)

- No MVT (multi-section factorial testing), no client-side visual editor, no
  stats engine beyond the two-proportion z — "a second experimentation
  product" is a named non-goal.
- No experiment scheduling/auto-stop rules; no minimum-runtime enforcement
  (the results endpoint reports honesty flags; the human decides).
- Conversion stamping on arbitrary published-site pages rides the embedding
  site's beacon (it already can send `experiment` — documented shape), not a
  shipped snippet.
- C5 attribution integration (per-variant revenue) waits for C5's projection.

## Verification

- `test/cms-page-experiments.test.ts` — 17 tests: extraction identity +
  stickiness + distribution; z-math; validation (weights/one-running/version-
  exists); public seam (no-vk deep-equal, variant snapshot + stamp, holdout,
  oversized vk, consent regime deny→grant); promote (publish path, holdout
  no-op, gated `pendingApproval` honesty + inbox row); results (dedupe,
  insufficientSample, significant verdict); audit rows with `payload.tenantId`.
- `test/analytics-route.test.ts` — extended: the beacon persists the full
  stamp and drops partial ones.
- Toggle-engine tests (`feature-toggles*.test.ts`) pass unmodified — the
  extraction is behavior-identical.
- Frontend: `tsc --noEmit`, `eslint --max-warnings=0`, `npm run build`
  (i18n/CSS/token gates) — all green.
