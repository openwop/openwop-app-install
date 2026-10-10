# ADR 0861 — CMS localization: a withheld locale stays withheld, the gate runs on the written row, and translations know when they are outdated

Status: implemented (2026-10-07, feature loop row 35)
Date: 2026-10-07
Toggle: rides `cms-localization` (no new toggle). Feature loop round 2, row 35.
Extends: ADR 0064 (localization core), ADR 0205 (per-locale publish state, translator grants),
ADR 0592 (fix batch, `aiDrafted`), ADR 0593 §C2/§C8/§C9 (the settings live-edit gate),
ADR 0668 (tenant axis), ADR 0836 D2 (the gate runs inside `authorize` on the CAS row),
ADR 0859 (review cycles).
Inputs: `docs/steward/WORKFLOWS-ASSESSMENT.md` § "CMS content localization — round 2 re-grade
(feature loop row 35)", ids `CMSL2WF-1..6`, opening ref `90b75353b`.

## Context

It.23 (ADR 0668) fixed what a reader is served from *another workspace*. This pass graded what
a reader is served that *the admin withheld*, and found the one thing the row's brief names as
an invariant — an unpublished locale variant must never reach the public — broken by a
derivation, not by a missing check.

### The Blocker, measured (`CMSL2WF-1`)

`localizePage` derives the withheld set from the org's configuration, not from the page:

```ts
const withheld = settings.supportedLocales.filter((l) => state[l] === 'draft'); // cmsService.ts:2529
```

So a `localePublishState` entry only bites while its locale is *also* configured. A `pt`
overlay held at `draft` reaches a `pt-BR` reader through the RFC 0103 language-family step
(`host/i18n/resolveSection.ts:69-75`) as soon as `pt` is no longer in `supportedLocales`.
Two ways to get there:

1. **Narrowing the org's locales** — `['pt','pt-BR'] → ['pt-BR']`. The settings route runs its
   live-edit diff only when `widening` (`features/cms/routes.ts:1004`), because removing a
   locale is the documented fail-safe direction. The diff's model makes the same
   `supported.filter` (`:1042`), so even a diff on narrowing would have answered "nothing
   released".
2. **Withholding a locale that was never configured** — ADR 0593 §C8 deliberately allows it
   (the withhold direction is open). It has no effect on the family reach.

**MEASURED RED on `90b75353b`** (`test/cms-withheld-locale-never-served.test.ts`, legs 1 and 2).
One settings write publishes a withheld, typically machine-drafted translation with no review
row and `page.version` unmoved.

**The evidence that this is a defect and not a design choice is in the SPA.** The editor's
preview mirror derives withheld from the page alone —
`Object.entries(selected?.localePublishState ?? {}).filter(([, v]) => v === 'draft')`
(`frontend/react/src/features/cms/CmsPage.tsx:1107`) — and its header says *"the preview must
show what delivery will serve, so any divergence here is a preview lie"*
(`resolvePreviewLocale.ts:7-9`). The two disagreed: the admin's preview showed base, the
public served the withheld overlay. The client modelled the intent; the server did not.

### The gate checked on one row, written on another (`CMSL2WF-2`, `-3`, `-4`)

ADR 0836 D2 closed this class for page PATCH by moving every check into
`authorize(current)`, which runs on the row the CAS compares. Three localization lanes were
left on the old shape:

- **Locale release** — the route calls `refuseLiveEdit` on its own read (`routes.ts:889-896`);
  `setLocalePublishState` re-reads and CASes against that (`cmsService.ts:2557,2591`).
  `transitionPage` never bumps `version`, so an approve landing between the reads leaves the
  CAS valid and the withheld overlay goes live on a now-`published` page.
- **The submit-time auto-translate merge** — `updatePage(…, { expectedVersion })` with no
  `authorize` (`routes.ts:430`). During the sweep (up to 20 provider calls) the page is
  `in_review` with no approval row; an approve takes the lazy backfill (`:503-511`), pins
  version N, publishes. The merge's version check still passes: N+1 with AI overlays is live,
  unreviewed.
- **Language settings** — the widening gate decides on the route's read `cur` (`:939`);
  `updateContentLanguageSettings` re-reads and blind-`put`s (`host/contentLocales.ts:65,99`).
  A concurrent stale write puts a removed locale back without the gate seeing it.

### hreflang (`CMSL2WF-5`) and translation status (`CMSL2WF-6`)

The prerender advertises an `hreflang` alternate for every org locale
(`features/publishing/prerenderService.ts:374-377`), including ones this page withholds.

And the competitive gap. Contentful (locale-aware entries + workflow apps), Sanity
(document-internationalization; field-level translation metadata), Webflow Localization
(per-locale page status) and every TMS share one feature this CMS lacks: **a translation knows
which source it translated, and says "outdated" when the source moves.** Here an overlay is a
shallow replace with no record of its source (`Section.localizations`, `cmsService.ts`). An
editor who rewrites the English hero cannot learn that the Spanish hero now says something
else, and neither can the reviewer who approves it.

## Boundaries audit

| Concern | Single owner (reused, not forked) | Evidence |
|---|---|---|
| Withheld-set derivation | `localizePage` (`cmsService.ts:2516`) — today the ONLY server derivation; the settings diff (`routes.ts:1039`) re-implements it | grep `localePublishState` → 2 readers + 1 writer |
| Normative resolution | `host/i18n/resolveSection.ts` (RFC 0103 §C) — untouched | spec `localized-content.md` §C |
| Row-checked writes | `updatePage`'s `authorize` (`cmsService.ts:1151-1155`), ADR 0836 | used by PATCH, surface |
| Settings store | `host/contentLocales.ts` (`DurableCollection.compareAndSwap`, `hostExtPersistence.ts:774`) | core module; must not import features |
| Section metadata precedent | `Section.aiDrafted` (ADR 0592 §3): advisory, server-cleaned, dropped when orphaned | `cmsService.ts:127, 914, 928` |
| Translator grant diff | `assertLocaleScopedSectionsPatch` (`cmsService.ts:2110-2135`) already diffs `localizations` and `aiDrafted` per locale | a new per-locale field must join it |
| Public projection | delivery shape is `{sectionId,type,data}` (`localizePage`), so section metadata never reaches a reader | `DeliverySection` |
| Editor preview mirror | `resolvePreviewLocale.ts` — already state-derived | `CmsPage.tsx:1107` |

No new route prefix, store, toggle, envelope, or capability. One new route (D6 confirm) under
the existing `${BASE}/pages/:pageId/…` family.

## Decisions

### D1 (Blocker, `CMSL2WF-1`) — withheld is a property of the page, read in ONE place

- New exported helper `withheldLocales(page): string[]` = every key of `localePublishState`
  whose value is `'draft'`, regardless of configuration.
- `localizePage` strips those overlays before resolution and removes them from the negotiable
  set (`deliverable = supportedLocales − withheld`, unchanged).
- The settings route's `reachableOverlayKeys` takes the page's withheld set from the same
  helper, not from `supported`.
- The settings diff runs on **every** `supportedLocales` change, not only on widening. With
  D1 the diff of a genuine narrowing is empty by construction, so the fail-safe direction stays
  open. A "narrowing" that releases content is refused with the same remedy text.
- A withheld key that is not configured stays stored and keeps working. That is what the admin
  asked for, and it is what the preview already shows.

**Why not "drop withheld keys when a locale is removed"?** That would turn an explicit
admin hold into an implicit release later (re-adding the locale would find no hold).

**D1 deliberately overturns ADR 0593 §C9's model** (review H1). §C9 ruled that "withholding a
locale that is not in `supportedLocales` has no delivery effect, so it must not be credited
with one", and `test/cms-live-edit-language-settings.test.ts:343-369` pins it. That test asserts
a 409 and then a public `pt-BR` read serving the withheld text. §C9 described the code
accurately; the code was wrong about the admin's intent. The test is INVERTED, not deleted: the
same widening now returns 200 and the public read serves base. A sabotage check confirms the
old `supported.filter` model turns it red again. A correction note goes under ADR 0593 §C9 and
at `routes.ts:1031`.

**Exit for a stale hold** (review L2): a withheld key for a locale that is no longer configured
can't be released, because releasing an unconfigured locale returns 400 (`cmsService.ts:2570`).
The exit is to re-add the locale, which is a widening that releases nothing, then release
through review.

**Second resolver** (review L1): the kernel `blocks` field-kind `resolveLocale`
(`cmsService.ts:257-260`) has no caller. It is deleted, so "read in ONE place" is true.

### D2 (`CMSL2WF-2`) — the release gate runs on the CAS row

`setLocalePublishState(…, opts?: { authorize?: (current: Page) => Promise<void> })`, invoked on
the read the CAS compares. The publish route moves its `refuseLiveEdit` into it. The withhold
route passes none (fail-safe direction, unchanged).

### D3 (`CMSL2WF-3`) — the auto-translate merge lands only on the review it belongs to

The merge's `updatePage` gets an `authorize` that THROWS
`OpenwopError('conflict', …, { reason: 'review-moved' })` unless
`cur.status === 'in_review' && cur.reviewCycle === updated.reviewCycle`. `authorize` refuses
only by throwing; any other code would fall into the outer `catch {}` and drop the drafts with
no flag, the failure ADR 0592 §9 F6 closed (review H6).

- A `review-moved` conflict does NOT take the one re-read-and-retry (it could never succeed).
  It breaks with `autoTranslateDegraded.conflict` set. Reusing `conflict` avoids new FE copy,
  and it is accurate: the page moved under the sweep.
- **The queue after the sweep re-reads** (review H6). `queueContentApproval` used to run on
  the stale in-review `updated`. After a backfilled approve it would open a fresh pending row
  for a page that is already published. Now the route re-reads, and queues only while the page
  is still `in_review` in the same cycle.
- **A draft whose base moved is dropped** (review M1). On the conflict re-merge onto `fresh`, a
  drafted overlay is applied only where `fresh`'s section `data` is stable-equal to the `data`
  that was translated. This is the sweep's missing-only rule extended to its source, so D6
  never stamps an old-base translation `current`.

**Alternative weighed:** translate *before* the `submit` transition, so the page is still a
draft. Rejected: it moves a 20-call sweep in front of the state change, and the draft is
then open to the editor's own autosave racing it. That trades one race for a likelier one.

### D4 (`CMSL2WF-4`) — settings writes CAS against the row the gate read

`updateContentLanguageSettings(…, opts?: { expected?: ContentLanguageSettings | null })`.
When `expected` is given, the write is `compareAndSwap(expected, next)`, and a miss is a typed
409. The compare is a byte match of the stored JSON; `null` means insert-if-absent
(`hostExtPersistence.ts:774`).

- The route reads the STORED row (`getStoredContentLanguageSettings`, null when never
  configured) and passes it as `expected`. Every gate decides on `stored ?? skeleton`
  (review L3). The service builds `next` from `expected ?? skeleton`, never from a second
  read.
- Callers without `expected` (seeders, tests) keep `put`.
- **The erasure rewrite joins it** (review H7): `eraseContentLanguageSettingsSubject` listed
  rows and blind-`put` `{...s, updatedBy}` (`contentLocales.ts:119-123`), the same stale-write
  race. It now CASes against the listed row, with one re-read on a miss.

### D5 (`CMSL2WF-5`) — hreflang names only what the page serves

The prerender alternates are the locales the page actually serves. They are emitted only
when more than one remains. Backend-only; the public renderer is not touched.

**Correction from review H2:** `prerenderPage` only sees `projectPublic`'s `PublicPage`
(`prerenderService.ts:311`, `publishingService.ts:671-689`), which carries no
`localePublishState`. A helper typed over `{localePublishState?}` would accept it and always
return `[]`, so the test would be green and the hole open. Instead `localizePage` returns the
`deliverable` locale list beside `{page, locale}`, computed from the stored page.
`publicPageBySlug` passes it through and the prerender uses it. The witness withholds a
CONFIGURED locale.

### D6 (`CMSL2WF-6`, competitive) — translation status: an overlay records its source

- **Data.** `Section.sourceDigest?: Record<locale, string>` and the same field on
  `SharedSection` (review M3). Each value is a 16-hex SHA-256 prefix of a key-sorted canonical
  stringify of the base `data` **at the keys that locale's overlay overrides**. It is
  recorded when that overlay was last written or confirmed.
  - Why the overridden keys only (review M2): digesting all of `data` would mark every locale
    outdated when an image, URL or number changes, or when a sanitizer starts adding a field.
    "Outdated" means the text this translation replaces has changed, and nothing else.
- **Kept by validation** (review H4): every kernel page write re-runs `validateSections`
  (`cmsService.ts:256`, via `buildSystemExt`). So `validateSection` keeps a CLEANED
  `sourceDigest` (BCP-47 key, overlay present, `/^[0-9a-f]{16}$/`, orphans dropped), as
  `cleanAiDrafted` does. Otherwise the façade's stamp would be stripped at the kernel.
- **Server-owned.** Client values are discarded. The façade stamps, in ONE helper
  `stampSourceDigests(prev: Section[] | undefined, next: Section[], confirm?)`, which runs
  after validation in `createPage`, `updatePage`, the surface draft writer (`updateSectionDraft`,
  `cmsService.ts:~1400`), `createSharedSection` and `updateSharedSection`. The shared writers
  call `buildSectionData`/`validateLocalizations` directly, not `validateSection`
  (review M3).
  - For each locale overlay in `next`: if the same section's previous overlay for that locale
    is stable-equal, **whatever was there carries over, including absence** (review H3). A
    legacy overlay stays `unknown` until someone actually writes or confirms it. Otherwise the
    first boot-seeder save would stamp every untouched legacy overlay `current` with no
    evidence.
  - A changed or new overlay is stamped from the base in `next`.
  - A digest without an overlay is dropped, as with `aiDrafted`.
  - `restoreVersion` writes the snapshot's sections as they were, digests included.
  - Lanes that write sections without going through these writers keep the incoming value
    as validated: the seeders (they rewrite the base and keep the overlay, so it is correctly
    `outdated` or `unknown`) and the kernel migration.
- **Status** (pure function `translationStatus(section, locale)`):
  - `missing`: no overlay.
  - `current`: the digest equals the digest of the current base.
  - `outdated`: the digests differ.
  - `unknown`: an overlay with no digest, meaning a legacy row. There is no backfill: absence
    makes no claim, the `aiDrafted` posture.
- **Confirm.** `POST ${BASE}/pages/:pageId/sections/:sectionId/locales/:locale/confirm-source`
  re-stamps one digest without changing the overlay ("still accurate"). The PATCH `authorize`
  is an inline closure (`routes.ts:269-275`), so there is nothing to reuse (review M4). The
  confirm route spells out its own closure:
  - `workspace:write`;
  - the live tier for non-drafts (`requireLiveTier`);
  - `gateRefusal` on a `published` page under the gate;
  - for a translator, `grant.locales.includes(locale)`.

  `updatePage` gains `confirmSource?: { sectionId, locale }`. It is a page write, so it bumps
  `version`; on an `in_review` page that invalidates the pending approval pin until the page
  is resubmitted. That is disclosed, and consistent with every other edit.
- **Translator grant: no new diff** (review H5). The digest is recomputed server-side, so a
  client-sent value protects nothing. Diffing it would 403 every translator whose client omits
  the field. The protection is already structural: a translator can't touch another locale's
  overlay (`cmsService.ts:2115-2119`) or the base (`:2113`), and confirm checks the grant.
- **Never public.** `DeliverySection` carries `data` only; snapshots carry the field
  (restore keeps the status that version had).
- **Surfaces.**
  - Editor: a per-locale status line in the locale switcher ("es — 2 outdated, 1 missing").
  - Section editor: a per-section `Outdated` chip with a *Mark up to date* action while
    editing a locale.
  - Agent read: `getDraftPage` / `get-draft-page` (`surface.ts:57-72`) gains a
    `translationStatus` map, so the localizer agent can target outdated sections. It is
    read-only, with no envelope and no new tool. The PUBLISHED read `getPage` (`surface.ts:240`)
    stays `{sectionId, sectionType, data}` (review M5).
  - Ref sections: status comes from the shared row (review M3), never from the ref's empty
    `localizations`.
  - Approval proposal: no change in this ADR.

### D7 — witnesses carried from it.23

- `CMSLWF-11`: one SUCCESSFUL chat-lane translate (the agent tool with a mocked
  `resolveHeadlessAi`).
- `CMSLWF-3`: the chain through the REAL executor (`from-chain` → `startWorkflowRun`, `callAI`
  faked), asserting overlay + `in_review` + one review row.

## Deferred — with reasons, not silently

| Item | Why deferred |
|---|---|
| **Per-locale URLs** (`/es/slug`), and hreflang to distinct URLs (row 22's G8) | Changes the public renderer's routing, canonical and cache keys. The public renderer is being changed concurrently (consent / visitor identity). Without distinct URLs, D5's alternates still point at one canonical: honest but weak SEO. |
| **Custom per-locale fallback chains** (Contentful's "fall back to `es` for `es-MX`") | The chain is normative RFC 0103 §C behaviour on `/v1/content`. A host-only divergence on the org lane would make the two lanes disagree. Needs an RFC 0103 revision first. |
| `CMSLWF-17` public fallback disclosure | Public renderer, concurrently owned; UX-owned since ADR 0668 D6. |
| Re-translate outdated overlays in the sweep or chain | Today both are missing-only, so they never overwrite a human. Overwriting an outdated *human* overlay needs a product call. D6 makes the target visible first. |
| `/v1/content` negotiates over the host's locale set, not the org's | Protocol lane for the home org; changing it moves a conformance-pinned behaviour. D1 already removes the withheld half. |
| `CMSLWF-6`, `-12`, `-18`, `-19` | Unchanged since it.23; owned by core approvals and other features. |

## Matrix

1. Feature-package: `features/cms` only (+ `host/contentLocales.ts` for D4, core-pure).
2. Toggle: `cms-localization`. No new toggle. D1/D5 are delivery fixes and apply regardless of
   the toggle (delivery never read it, ADR 0668 D4).
3. Workflow surface: `ctx.features.cms.getDraftPage` gains a read-only `translationStatus`.
4. Node pack: no new node. `get-draft-page` output gains the map: an additive output, so a
   patch version bump with the QUAD synced.
5. Envelopes: none.
6. Agent pack: none. The localizer prompt may mention outdated status; if it does,
   `promptCatalogParity` must pin it.
7. Public surface: no new route; D1 and D5 narrow what is served.
8. RBAC: the confirm route has PATCH-lane authority, translator grants enforced, and the gate
   inside `authorize`. Org from `requireCmsScope` (`ext.page.orgId` via `kernelToPage`).
9. Replay: no node classification change; `get-draft-page` stays a read.
10. Frontend: inside the lazy CMS chunk and the lazy `cms` namespace, 4 locales. The entry chunk
    is untouched.

## RFC verdict

Host-extension throughout. D1 makes the host's ADR 0205 extension (`localePublishState`,
beyond `localized-content.md` §E) consistent with itself. The normative chain is unchanged,
and on `/v1/content` it now simply never sees a withheld overlay. D6's `sourceDigest` is host
metadata that never reaches the wire. No new RFC, and none is ridden.

## Phases

| Phase | Scope | Gap |
|---|---|---|
| P1 | `withheldLocales` + `localizePage` + settings diff on every change; RED-first | `CMSL2WF-1` |
| P2 | `authorize` on release + merge; settings CAS | `CMSL2WF-2/3/4` |
| P3 | hreflang filter | `CMSL2WF-5` |
| P4 | `sourceDigest` stamping + status + confirm route + agent read + editor UI | `CMSL2WF-6` |
| P5 | chat-success + real-executor witnesses | `CMSLWF-11`, `CMSLWF-3` |

## Open questions

- **OQ-1 (owner):** should a page with outdated translations be *flagged* on its approval card?
  Recommendation: yes, in a follow-up. Today's card already discloses AI-drafted locales.
  Deferred here to keep the review lifecycle (ADR 0859) unchanged.
- **OQ-2:** confirm-source on a `published` page under the gate is refused, the same as any
  live edit. That is consistent, but a translator cannot clear "outdated" on a live page
  without unpublishing. Recommendation: keep it consistent for now, because the flag is
  advisory.

## What the pre-implementation review changed (recorded, not silently fixed)

The `/architect` pass on the decision text returned **0 Blockers and 7 Highs**. Every one would
have either shipped green with the hole open or overturned a pinned decision unannounced:

1. **H1:** D1 reverses ADR 0593 §C9 and a sabotage-found test; the ADR now says so and inverts
   the test.
2. **H2:** D5 would have read withheld state off a projection that does not carry it, so it
   would always return `[]` and the test would still pass. The served set now comes from
   `localizePage`.
3. **H3:** the carry-over rule stamped every untouched legacy overlay `current` on the next
   seeder save. Absence now carries over.
4. **H4:** the kernel re-validation would have stripped the stamp.
5. **H5:** a translator-grant diff on a server-owned field would have 403'd translators and
   protected nothing.
6. **H6:** D3's refusal was a boolean the code can't express, the retry could never succeed,
   and the queue after the sweep opened a row for an already-published page.
7. **H7:** the erasure rewrite was a second blind settings write.

Mediums M1–M5 are folded in above: stamping against the base actually translated, digesting
only the overridden keys, shared sections, the confirm closure, and the draft-not-published
agent read.

**Transferable lesson.** H2 has the same shape as ADR 0668's Blocker 1: a parameter whose type
admits a value that makes the check a no-op. A `withheldLocales({localePublishState?})` accepts
any object, so the absence of state reads as "nothing withheld". The cure is the same too:
take the answer from the one function that holds the real row, not from a type that cannot
tell "none withheld" from "not known".

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1 D1 | fix(cms): a withheld locale stays withheld; locale gates run on the CAS row | `cms-withheld-locale-never-served`, `cms-live-edit-language-settings` (narrowing + inverted §C9) |
| P2 D2–D4 | same commit | `cms-locale-gate-on-cas-row` (D2, D3 ×3, D4 ×2) |
| P3 D5 | same commit | `cms-locale-gate-on-cas-row` (D5) |
| P4 D6 | feat(cms): translation status — server-owned source digests, confirm-source, agent read; feat(cms): translation status in the editor | `cms-translation-status`, FE `translationStatus.test.tsx` |
| P5 D7 | test(cms): real-executor chain + chat translate success witnesses | `cms-chain-real-executor`, `cms-agent-translate-success` |
| review | fix(cms): confirm-source pins the editor's version (grade-ux CMSL2UX-1..7); one live-edit refusal (CMSL2CD-2) | the 409 leg in `cms-translation-status` |

**Corrections found after the pre-code review (recorded, not silently fixed).** `/grade-ux` found a
Blocker in D6's own client half: "Mark up to date" pinned the CAS to the route's fresh read, and the
SPA then stamped the new version onto its stale copy, so the editor's next autosave could overwrite
another editor's save without a 409. D6's confirm now pins the version the editor holds, and the SPA
refuses with unsaved edits. This is the loop's recurring lesson again: the defect is in the fix's
own write path, one layer away from where the decision text looked.
