# ADR 0836 — CMS publishing integrity and exits

Status: implemented (feature loop 2026-10 row 22, `feat/fl2-22-cms`)

Feature loop 2026-10 row 22 (CMS + page builder + publishing/SEO). Extends ADR 0009
(CMS), 0012 (publishing), 0204 (orchestration composition, scheduled publish),
0593 (approval gate / live-edit lane), 0748 (live-tier delete) and 0832 (the
surface org floor). No new toggle: `cms` is always-on (ADR 0027), `publishing` and
`custom-domains` keep their ids.

## Context

The row-22 grade (`docs/steward/WORKFLOWS-ASSESSMENT.md` § CMS, ids `CMS2WF-`) and
two code audits of the same baseline (`48fcab3b2`) found that the CMS's
features are mostly present. The competitive scan
(`docs/research/cms-gap-analysis.md`) confirms that version history, preview links,
scheduling, shared sections, translator grants, per-locale publish, a pre-publish
checklist, sitemap/robots/feed, canonical/hreflang and JSON-LD have all shipped. The
defects are in whether those features hold their promises:

1. **A scheduled publish publishes content nobody scheduled** (`CMS2WF-1`).
   `setScheduledPublish` (`cms/cmsService.ts:2027`) stores a time only. The sweep
   (`cms/publishSweep.ts:65`) publishes the page as it is at fire time. Editors
   (`workspace:write`), the content-editor agent and `cms.localize-and-submit` may all
   change a draft after an admin scheduled it. With the gate OFF (the default) that
   content goes live, which is publish authority the editor does not hold
   (`publish` is `host:members:manage`).
2. **Page writes are check-then-act.** `updatePage` (`:999-1053`), `transitionPage`
   (`:1682-1721`) and `restoreVersion` (`:1537-1544`) read the page, compare
   `expectedVersion`, then `pages.put`. The kernel adapter already exposes `cas`
   (`entities/kernelAdapter.ts:61`); nothing in CMS calls it. The comment at
   `transitionPage` claims the pin is "a precondition on the write". It is not.
   A transition spreads a stale copy and can revert an edit that landed in the window.
3. **Authorization decided on a different read from the one written.** The page PATCH
   route picks the editor vs admin tier from `current.status` (`cms/routes.ts:190`),
   and `updatePage` re-reads. A publish landing between the two lets an editor edit
   live content. `deletePage` already fixed this exact race with an `authorize`
   callback on its own read (`:1238-1251`).
4. **Cross-tenant rows keyed by `pageId` alone** (`CMS2WF-3`). Page ids are per
   tenant (`pages.get(tenantId, id)`), and `/v1/content` lets a caller choose one
   (`PROTOCOL_CONTENT_ID_RE`, `:1074`). Several stores filter by `pageId` only:
   - version history: dedupe/promote (`:1432`), cap-delete (`:1467`), seed offer (`:1489`);
   - the schedule markers (`cms:scheduled`, `cms:scheduled-unpublish`, `:346,352`).
   Tenant B can therefore promote, delete or overwrite tenant A's rows, including
   the system site's (`page:host-site-home` is a legal protocol id).
5. **Live content reachable at editor tier.** Page PATCH and delete need the admin
   tier for any non-draft page, whatever the gate setting (ADR 0748). Two writes
   that change what a live page's readers see need only `workspace:write` while the
   gate is OFF:
   - SEO PUT (`publishing/routes.ts:70`): title, description, og image, `noindex`,
     and the canonical URL, which can point at another site;
   - shared-section PATCH (`cms/routes.ts:756`).
6. **The workflow surface asks less than the routes** (`CMS2WF-2`). `cms` registers no
   `orgPolicy`, so the ADR 0832 floor asks `workspace:read` for the three writer verbs.
7. **Public exits.**
   - The prerender HTML memo is keyed by (org, slug, locale) only
     (`publishing/prerenderService.ts:404`). `baseUrl` comes from
     `X-Forwarded-Host` when `OPENWOP_PUBLIC_BASE_URL` is unset, so one forged request
     poisons every visitor's canonical, og and image URLs for the TTL. This affects
     white-label installs only; prod sets the variable.
   - The internal-link test `/^\/(?![/\\])/` (`publishing/sectionHtml.ts:53`,
     `cms/cmsService.ts:367`, `frontend/.../cms/SectionRenderer.tsx:87`) accepts
     `"/\t/evil.com"`, which a URL parser resolves to `https://evil.com/`.
   - A `$'` in a post title duplicates the page body, because
     `String.replace` treats it as a replacement pattern (`prerenderService.ts:300`).
8. **Competitive gaps with a trust angle.**
   - G2: restoring a version takes a published page offline with no `unpublished`
     event, so the docs KB keeps citing a 404. Restore also has no version pin.
   - G3: publish blockers (empty title, `[TODO …]` markers) exist only in the
     browser (`frontend/.../cms/publishChecks.ts`). The API, agents, the protocol
     lane and the sweep can publish past them.
   - `CMS2WF-4`: an agent's write to a shared-section reference reports
     `updated:true`, but the write is silently lost.
   - `CMS2WF-5`: the translate→store path writes locale overlays with
     `cms-localization` OFF.

## Boundaries audit

- **Single owners, composed, not forked:**
  - page state: `cmsService` over the kernel adapter;
  - the gate predicate: `contentApproval.ts` (`isApprovalGateOn`,
    `liveEditGateActive`, `blockingLiveEditPages`);
  - org authority: `requireCmsScope` / `requireOrgScope`;
  - the surface floor: `host/featureSurfaces.ts` `orgPolicy.methodScopes`
    (precedent: `app-builder/feature.ts:28`).
- **No new stores and no new toggles.** One new optional page field,
  `scheduledPublishVersion`. Marker keys are re-keyed, with a legacy read.
- **No route namespace changes.** All routes stay under `/v1/host/openwop-app/*`. The
  `/v1/content` protocol lane keeps its wire shape; only its internal
  storage keying changes.

## Decision

> **Revised before code by the adversarial `/architect` pass (2026-10-06).** It found
> 1 Blocker and 7 Highs in the first draft of this section. Each correction is
> tagged `[AR-n]` and listed in § "Adversarial review" below. The first draft's
> reasoning is kept there, not here.

**D1 — One CAS page write.**
- A private `casPage(expected, next)` wraps `pages.cas`. On a miss it re-reads:
  - a missing row is `404 not_found`;
  - otherwise the miss is the existing typed `409 conflict` with
    `{ pageId, currentVersion }`.
- `put` retried its internal CAS four times. `cas` does not retry, and the extra 409s
  are accepted: the 409 is the honest outcome of a race `put` used to hide [AR-M2].
- It replaces `pages.put` in:
  - `updatePage`, `transitionPage` and `restoreVersion`;
  - the four schedule set/clear functions;
  - `setLocalePublishState`;
  - `eraseCmsSubject` [AR-M1], which writes from a whole-tenant list snapshot, so it
    re-reads and retries once per page.
- **Side effects move after the CAS** [AR-H3]. Redirect writes in `updatePage` and the
  version snapshot in `transitionPage` run only after `cas === true`. Before, a lost
  race left a redirect to a slug the page never got, or promoted a submit row to
  `origin:'publish'`, the marker the experiment gate trusts.
- Seeds that create pages keep `create`/`put`.

**D2 — Authorize on the read that is written, in EVERY lane that decides on status**
[AR-H1/H2].
- `transitionPage` never bumps `version`, so an `expectedVersion` pin cannot see
  draft→published. Authority has to be decided on the CAS's own read.
- `updatePage` takes an optional `authorize(current)`, called on its read before the
  CAS (the `deletePage` / `upsertProtocolSection` shape). Three callers move their
  status-dependent checks into it:
  - the PATCH route: the tier decision, the gate refusal and the translator-grant
    diff (`assertLocaleScopedSectionsPatch`);
  - `upsertProtocolSection`: it already has an `authorize`, now threaded through to
    `updatePage` instead of run on a prior read;
  - `surface.updateSectionDraft`: draft-only, as the callback.
- `putSeo` takes an `authorize(page)` callback too [AR-M7]. Boot seeds call it with
  no request, so the tier check cannot live only at the route.

**D3 — A scheduled publish is pinned to the version that was scheduled.**
- `setScheduledPublish` stamps `scheduledPublishVersion = page.version`.
- `updatePage` on a page with a pending publish schedule either re-pins
  (`keepSchedule: true`) or clears the schedule **in the same CAS write**, auditing
  `schedule-cleared` with reason `content-changed`. The route decides `keepSchedule`
  with a NON-throwing probe of `host:members:manage` [AR-M4], so an admin who fixes a
  typo keeps the schedule. Any other writer cancels it at edit time:
  - an editor;
  - the content-editor agent and `cms.localize-and-submit`;
  - the submit-time auto-translate merge. This one is intended: machine content
    changed what was scheduled.
- `setLocalePublishState` is admin tier, so it re-pins [AR-M3].
- `restoreVersion` clears both schedules.
- The sweep calls `transitionPage('publish', { expectedVersion:
  scheduledPublishVersion })`. On a mismatch it clears the schedule with reason
  `content-changed`.
- A legacy schedule with no `scheduledPublishVersion` fires as before and logs
  `scheduled_publish_unpinned`. Cancelling every pending schedule on deploy would
  break launches that were set correctly. The prod count decides whether this needs
  a backfill (open question 1).
- **What the page version does not cover** [AR-H4]: shared-section content and SEO
  rows change a scheduled page's live output without bumping its version. D6 closes
  that by treating a scheduled draft as live tier.

**D4 — Tenant-qualified keys.**
- Version-history filters add `tenantId` + `orgId`: `snapshotPage` dedupe/promote,
  the cap, and `offerSeedVersion`.
- Schedule markers and their claim keys use
  `${encodeURIComponent(tenantId)}/${encodeURIComponent(pageId)}`.
  - Both ids may contain `:`, so the components are encoded.
  - The first draft's `\u0000` separator was a Blocker [AR-B1]: Postgres `TEXT`
    rejects NUL, so vitest would pass while prod failed on the first schedule write.
    **No NUL in a durable key.**
- Legacy markers keyed by bare `pageId` drain on read. They are deleted by legacy key
  only after a `get` confirms the row's `tenantId`/`orgId` [AR-H7]; a blind delete
  would let tenant B delete tenant A's legacy marker.
- `migratePagesToKernel` writes the new key.

**D5 — Surface floor matches the routes.** `cms/feature.ts` declares
`orgPolicy.methodScopes = { createDraftPage, updateSectionDraft, submitPage:
'workspace:write' }`. These are the only three writers of the six methods.

**D6 — Live tier is one rule: `isLiveTierPage(p) = p.status !== 'draft' ||
!!p.scheduledPublishAt`.**
- A write that changes what such a page's readers will see needs
  `host:members:manage`, whatever the gate setting. Page PATCH and delete already
  follow this rule for non-draft pages (ADR 0748).
- It now applies to:
  - SEO PUT, decided on `putSeo`'s read;
  - shared-section PATCH of `data`/`localizations` when any referencing page is
    live-tier (a `name`-only rename stays editor tier).
- Page PATCH of a scheduled draft stays editor tier, because D3 cancels the schedule
  on that write. An SEO or shared write cannot cancel it, since it does not touch the
  page row.
- The gate-ON refusal (`blockingLiveEditPages`) still runs after the tier check.
- `PUT /language-settings` is already admin tier (`routes.ts:877`) and is listed here
  so the inventory is whole [AR-M7b].
- The system-site org is unaffected: `requireCmsScope` short-circuits a superadmin
  there (`cmsScope.ts:42-58`).

**D7 — Public exits.**
- The prerender memo caches only when `baseUrl` comes from trusted config
  (`configuredPublicBaseUrl()`). A request-derived base renders fresh and stores
  nothing (the PUB2-B1 precedent). Putting `baseUrl` in the key would let forged hosts
  evict the 500-entry LRU [AR-M8].
- One exported `isInternalHref` (`publishing/sectionHtml.ts`) is used by the
  write-time `safeLink` and the server renderer. It refuses:
  - any ASCII control character or whitespace;
  - `//` and `/\`.
  The two frontend copies (`cms/SectionRenderer.tsx` and
  `funnels/viewer/FunnelViewerPage.tsx:73`) mirror it, pinned by one vector table.
  Stored bad links degrade to plain text at render, so no data repair is needed.
- The post-title splice uses a replacer function.

**D8 — Restore is honest (G2).**
- `restoreVersion` takes `expectedVersion`.
- From `published`/`archived` it fires the `unpublished` lifecycle and event.
- It clears pending schedules.
- The `LIFECYCLE_FOR_ACTION` comment is corrected.
- `republishing: true` suppresses that signal for experiment promote [AR-H5], which
  restores and republishes in one operation. Without it, a fire-and-forget
  `unpublished` racing the `published` could evict a live docs page from the KB.
- The editor's restore confirm warns, in all four locales, that a live page comes down.

**D9 — Server-side publish blockers (G3), named honestly.**
- `publishBlockers(page)` checks a `[TODO` marker in any own-section `data` string,
  matching `/\[TODO\b/i` as the browser does: refs and `localizations` are ignored.
- The browser's empty-title rule is NOT ported [AR-M6]. Server titles fall back to
  `'Untitled page'`, so a witness for it could never go red.
- It refuses `422 publish_blocked` (`details.blockers[]`) on transitions INTO
  published or review: `submit`, `approve`, `publish`. The browser checklist already
  runs before submit [AR-M5]. That covers the routes, the agent `submitPage`, the
  sweep (clears with reason `publish-blocked`) and experiment promote.
- Approval decide runs it BEFORE `resolveApproval`, so the row is not resolved and
  then reopened.
- Promote runs it on the variant snapshot BEFORE `restoreVersion` [AR-H5]. A 422
  after the restore would leave a live page offline.
- The protocol create-plus-publish evaluates it before `createProtocolPage` [AR-M10].
- In-place edits of a PUBLISHED page (admin PATCH, protocol section PUT) also run it
  in `updatePage` [AR-H6]. The first draft's "covers every lane" was false.
- A test pins every boot-published system seed as blocker-free, because a seed 422
  inside `ensureSystemSite` would take `/` down.
- A parity test pins the server rule to the browser's `block` rule.

**D10 — Surface honesty**, both in `surface.updateSectionDraft` [AR-M9]:
- It refuses a shared-section reference with the existing typed `409` (`CMS2WF-4`).
- On a `locale` overlay write, it refuses `host_capability_disabled` when
  `cms-localization` is OFF. Not in `updatePage`, where it would fail every PATCH
  that carries existing overlays. The seam's toggle gate skips always-on `cms`, so it
  does not cover this.

## Alternatives weighed

- **D3, clearing at fire time only.** Rejected: the editor never learns the schedule
  died. Edit-time clearing is visible; fire-time pinning is the backstop.
- **D3, publishing the scheduled snapshot rather than refusing a moved page.**
  Rejected: it would publish content the page no longer holds, a split between live
  and editor state that every other lane avoids.
- **D6, gating SEO/shared edits on the approval toggle only.** That is today's
  behaviour, and it is why the default-OFF org lets an editor rewrite a live
  canonical URL.
- **D9, moving the whole browser checklist server-side.** Only `block` rules are
  authority; warnings stay advisory and client-side.

## Deferred (filed, with reasons)

- **G1, rich draft preview.** The share link renders markdown. Rendering sections
  needs a decision on whether unpublished media tokens may resolve on the public
  share lane. That is its own ADR.
- **G4, real 404 / 301 for crawlers.** Canonical already names the target. A 301
  needs a per-door Location (custom domain `/p/…` vs platform prerender path).
- **G7, approve-now-publish-later**, and **G8, per-locale crawlable URLs.** Each
  needs an ADR; G8 may need an RFC 0206 check.
- **`CMS2WF-6`** (campaign-channels fork duplicate), **`-7`** (self-approval; needs
  a product call), **`-8`** (pack bump), and **`-9`** (sweep flag wedge).
- **Audit findings:**
  - custom-domain squatting (toggle default OFF; needs pending expiry + reclaim);
  - CSP on prerendered HTML;
  - trailing-dot Host normalization;
  - all-tenant scans on versions/redirects/SEO;
  - in-request auto-translate latency;
  - SEO rows not erased on DSAR / page delete.

## RFC verdict

Host extension. No wire change. The `/v1/content` admin lane is **RFC 0103 §D**; RFC
0206 is the locale-key grammar, and the first draft cited it wrongly [AR-M10]. The
lane keeps its request and response shapes, and the new `422 publish_blocked` rides
the existing error envelope. Conformance creates published pages with non-empty names
and empty `fields` sections (`../openwop/conformance/src/scenarios/v2-content-locale-keys.test.ts:79`),
so the 422 is unreachable there.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 + D2 + D4 (CAS, authorize-on-read, tenant keys) | lost-update + PATCH-race + cross-tenant history/marker witnesses, RED on `origin/main` |
| P2 | D3 + D8 + D9 (schedule pin, honest restore, server blockers) | editor-edit-cancels-schedule, sweep pin, restore lifecycle, blocker parity |
| P3 | D5 + D6 + D10 (surface floor, live tier, surface honesty) | read-only member run refused; editor SEO/shared edit on a live page 403 |
| P4 | D7 (public exits) + frontend (restore confirm, schedule-cleared notice, `publish_blocked` copy) | memo key, href vector table + FE parity, `$'` title |

## Adversarial review (pre-code, 2026-10-06)

An independent `/architect` pass read the first draft against the code at
`48fcab3b2`. Findings and the correction each produced:

| Id | Sev | Finding | Correction |
|---|---|---|---|
| AR-B1 | Blocker | `\u0000` in a durable key; Postgres `TEXT` rejects NUL, so tests pass and prod fails | encoded `/` separator (D4) |
| AR-H1 | High | `upsertProtocolSection` and `updateSectionDraft` also decide authority on a prior read; `transitionPage` never bumps `version`, so the pin cannot see a publish | `authorize` threaded into `updatePage` for all three (D2) |
| AR-H2 | High | translator-grant diff ran on the route's read | moved into the callback (D2) |
| AR-H3 | High | redirects and snapshot run before the write, so a CAS miss leaves residue | after the CAS (D1) |
| AR-H4 | High | shared-section and SEO edits change a scheduled draft without a version bump | scheduled draft is live tier (D6) |
| AR-H5 | High | promote = restore + publish: a 422 after the restore leaves a live page offline, and `unpublished` races `published` in the docs KB | blockers before the restore; `republishing` flag (D8/D9) |
| AR-H6 | High | in-place edits of a published page never reach `transitionPage` | blockers also in `updatePage` on published (D9) |
| AR-H7 | High | legacy-key drain deletes another tenant's marker | get → check → delete (D4) |
| AR-M1..M10 | Med | erasure lost update; `cas` no retry; locale-state re-pin; throwing scope probe; submit parity; untestable title rule; SEO authorize callback; LRU flood; toggle check placement; wrong RFC | folded into D1–D10 |

## Corrections made during implementation (2026-10-06)

Each is a place where the decision text above was wrong or incomplete. The text
above is left as written, so the reasoning trail is visible.

- **D9, `submit` — REVERSED.** The pre-code review (AR-M5) asked the server to
  block `submit` as well. Implemented that way, it contradicted ADR 0828, which
  keeps submit open with blockers on purpose ("a reviewer can help finish the
  page"). The checklist told the editor "you can still send it for review" and
  the server then refused it (`CMS2UX-1`, a Blocker). The server now blocks only
  transitions INTO `published` (publish, approve, the sweep), plus experiment
  start, experiment promote, and in-place edits of a published page.
- **D9, error code.** The refusal is `422 validation_error` with
  `details.reason: 'publish_blocked'`, not a new `publish_blocked` code. A new
  code would have been a wire-registry change, because v2 vendor-namespaces
  unknown codes, for what is one more refusal of an existing shape.
- **D9, a missed lane: experiment START.** Starting an experiment serves the
  variant snapshot to visitors, and a version row can carry a `[TODO]`. Start now
  runs the blockers too.
- **D9 / AR-M10.** The protocol create-plus-publish creates only empty `fields`
  sections, so a blocker cannot trigger there. No change was needed.
- **D7, where the predicate lives.** `isInternalHref` is in `host/internalHref.ts`,
  not `publishing/sectionHtml.ts`, because `cms` would otherwise import from
  `publishing` (which imports `cms`). A fifth copy of the old regex,
  `funnels/funnelsService.ts`, now uses it too.
- **D6, the refusal's shape.** The live-tier 403 carries
  `details.reason: 'live_tier'` (`requireLiveTier`). The first cut keyed the
  editor copy on `requiredScope`, which every admin-tier action shares
  (`CMS2CD-17`).
- **D1, the commit point (`CMS2CD-14`).** Moving the snapshot after the CAS
  introduced a new failure. If the snapshot write threw after the page was
  already published, approval decide reopened its row against a live page, and
  the lifecycle event was lost. The CAS is now the commit point: post-commit
  writes (snapshot, redirects, schedule markers) log and never throw.
- **D3, the auto-translate merge.** The first draft let it cancel the schedule
  ("intended"). That was wrong. The merge only adds missing locale overlays under
  the org's own policy and leaves the base content the schedule was set against
  unchanged, so it re-pins (`CMS2CD-16`).
- **D3, a paired unpublish.** When a non-admin edit cancels the publish half of an
  embargo pair on a page that is not yet live, the unpublish half is now
  cancelled in the same write. Before, it was an orphan that no control showed
  (`CMS2UX-7`).
- **D3, the sweep's conflict.** Only a version move clears the schedule. A CAS
  race with an unrelated write retries on the next tick (`CMS2CD-18`).
- **D2 witness.** The first witness raced a publish against a draft-only edit,
  and it passed under sabotage: the CAS alone already closes that shape. It was
  replaced by a deterministic one in which the caller's check ran on an earlier
  read and a publish landed before the write.
- **Frontend (grade-ux).** The first frontend cut offered every member the
  admin-only controls this ADR's refusals guard. `useCmsOrgAccess` (the
  `kb/useKbOrgAccess` precedent, tri-state) now hides or locks them, with the
  reason shown, for a caller KNOWN not to be an admin. A scheduled draft shows a
  standing warning to such a caller, does not autosave for them, and Save asks
  before cancelling the launch (`CMS2UX-2/3`).

- **D4 and teardown (DSAR) behaviour.** Re-keying the schedule markers by
  `encodeURIComponent(tenantId)/…` made `cms:scheduled` and
  `cms:scheduled-unpublish` reachable for tenant teardown by KEY, so their
  residual classification in `teardown-reachability-coverage.test.ts` became dead
  and was removed (the gate found it). Being reachable on paper is not the same
  as being erased, so a test leg (`adr0836-tenant-key-ratchet.test.ts`) gives two
  tenants a page with the same id, purges one with `purgeTenantHostExt`, and
  checks that its markers and version rows are gone while the other tenant's
  remain. **Prod: 0 marker rows and 0 cross-tenant page ids (measured
  2026-10-06), so the legacy-marker path covers 0 rows.**

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| RED | `test(cms): ADR 0836 witnesses — 10/10 RED on origin/main 48fcab3b2` | `test/adr0836-cms-integrity.test.ts` |
| P1–P4 | `fix(cms): ADR 0836 — CAS page writes, schedule pinned …` | the RED file, green; `adr0836-cms-integrity-lanes.test.ts`, `adr0836-internal-href.test.ts` |
| D2 witness | `test(cms): ADR 0836 D2 — deterministic authorize-on-own-read witness …` | sabotage: authorize ignored → red |
| grade-code | `fix(cms): ADR 0836 grade-code pass — commit point is the CAS …` | configured-base caching, `live_tier` reason |
| grade-ux | `fix(cms): ADR 0836 grade-ux pass — role-aware CMS editor …` | `frontend/…/cms/__tests__/adr0836Schedule.test.tsx`, `adr0836Integrity.test.tsx` |

Every new guard was sabotage-witnessed on committed code (13 backend legs + 3
frontend legs, each red with its guard removed). The ten headline witnesses were
RED on `origin/main` `48fcab3b2`.

## Open questions

1. How many legacy, unpinned pending schedules exist in prod? (Asked of the
   orchestrator; it sizes D3's legacy branch.)
2. How many cross-tenant `pageId` collisions exist in `cms:pageversion`? (Asked; it
   sizes D4. No repair is planned unless the count is non-zero.)
