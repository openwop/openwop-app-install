# ADR 0206 — CMS editor surfacing: version history + snapshot-on-submit, page tags, media usage references, picker, preview fidelity

**Status:** implemented (2026-07-03)
**Numbering note:** originally authored as ADR 0202, then 0203 — renumbered to 0206 after #1175 and #1177 landed the canonical 0202/0203 (docs/adr duplicate-number policy: the unmerged, lower-churn ADR moves).
**Date:** 2026-07-03
**Toggle:** none new — everything rides the always-on `cms`/`media` features and existing RBAC scopes.
**Wire:** none — all host-extension (`/v1/host/openwop-app/*`); `/v1/content/*` untouched. No RFC needed.
**Depends on / composes:** ADR 0009 (CMS pages/versions), ADR 0007 (Media Library + opaque tokens), ADR 0064 (localization), ADR 0058/0073 (chat-drivability = agent + nodes; deep-link/embed the ONE chat), the CMS gap analysis (`docs/research/cms-gap-analysis.md` Phase B).

## Context

The gap analysis found the CMS backend ahead of its UI: version snapshots +
restore existed with **no UI** (dead client functions), preview had a
public-fidelity renderer used only by the host front-page panel, the page list
had no search/filter, the media integration was a bare token `<select>` with a
bare `usageCount` counter, and the shipped localizer agent was unreachable from
the CMS surface. Phase B surfaces what exists — composing existing primitives
only (the Phase-B architecture review rulings are inlined below).

## Decisions

### D1 — Snapshot-on-submit + distinct-content dedupe (B1)

`transitionPage` now captures a `PageVersion` on **submit** as well as publish,
and `snapshotPage` dedupes: **skip when the newest snapshot already captures
this `page.version`**. Semantics: snapshots are *content captures keyed by
version*, not status events — submit→publish of unchanged content, or
re-submit without edits, yields ONE capture. No `reason` label (it could
mislabel under dedupe). `publishedBy/publishedAt` field names are kept for
stored-row/editor-API compatibility but read as *capturedBy/capturedAt* — a
**correction note is added to ADR 0009**. Cap stays `MAX_VERSIONS = 50`
(faster churn accepted). The editor gains a lazy History panel
(`listVersions`/`restoreVersion` — the previously dead client functions) with a
**client-side field-level diff** (`sectionDiff.ts`: pairs sections by
`sectionId`, compares base `data` + per-locale overlay fields; no backend diff
endpoint).

### D2 — Page tags + list filters (B3)

`Page.tags?: string[]` cleaned via the shared `cleanTagList` (media precedent —
lowercased, deduped, capped 12×40). `GET /pages` accepts `?q=&tag=&status=`;
filters only **narrow** the already tenant+org-scoped set (no IDOR surface;
`status` validated against `PAGE_STATUSES`, 400 otherwise). A separate taxonomy
table was rejected as premature (revisit with the D-phase search work).

### D3 — Media usage references (B4): media owns the graph

A real "used by" graph supersedes the bare `usageCount` counter as the
asset-detail source of truth:

- **Owner: the media feature.** `media:usage` rows
  (`musage:${assetId}:${refKind}:${refId}` — deterministic keys, idempotent
  reconcile) + `syncUsageRefs`/`clearUsageForRef`/`listUsageForAsset` in
  `mediaService`, and `GET …/media/orgs/:orgId/assets/:assetId/usage`
  (workspace:read, uniform-404 IDOR). Token→asset resolution stays INSIDE
  media — consumers keep treating serve tokens as opaque (ADR 0007 boundary).
- **Writer: the CMS save path**, service-level (`createPage`/`updatePage`/
  `restoreVersion`/`deletePage` → `syncPageUsage`), covering every write path
  by construction, **best-effort** (usage bookkeeping never fails a save).
  Tokens are collected from base `data` AND per-locale overlays (locale image
  variants). Save-time **reconcile** (upsert/remove against the current token
  set) was chosen over an append-only event log (which double-counts and never
  shrinks). The legacy `POST /assets/:assetId/use` counter route is untouched
  (no callers found; retire later).
- **Correction note added to ADR 0007** (usage refs supersede the counter).

### D4 — Opaque-token cleaning: the secret-scrub bug (discovered during B4)

`cleanString` routes every value through `scrubSecretShaped`, which redacts any
bare `[A-Za-z0-9_-]{40,}` blob — and **media serve tokens are 43-char
base64url**, so every saved CMS image/hero token has been silently destroyed
as `[REDACTED:secret-shaped]` since the beginning (existing tests used short
tokens and never caught it; the demo front page uses non-token imagery).
Fix: new `cleanOpaqueToken` in `host/boundedStrings.ts` — trim + cap +
charset-validate (`^[A-Za-z0-9_.:-]+$`), **no secret scrub** — used for the
CMS `image.token` / `hero.imageToken` fields. Rationale: these are opaque
*references* rendered only as `/assets/:token` URLs, never as text, so the
paste-a-credential threat model doesn't apply; the free-text scrub stays on
every prose field. Covered by the B4 route test (a real 43-char token
round-trips end to end).

### D5 — Media picker dialog (B4 UI)

`features/media/MediaPickerDialog.tsx` — browse/search/upload/select, composing
media's own client (`listAssets`/`uploadAsset`) + the shared `Modal`. The CMS
editor threads an optional `onPickMedia` through `SectionsEditor` →
`MediaTokenField` (cms→media static import — the established cross-feature
direction; the duplicated `cmsClient.listMediaAssets` fetch is retired for
media's `listAssets`). The host front-page panel passes no `onPickMedia` and is
byte-identical (its superadmin cross-tenant context has no org media scope).
The Media Library gains a "Where is this used?" modal per asset over D3's read
route.

### D6 — Preview fidelity toggle (B2)

The org editor's preview card gains an Outline/Public segmented toggle;
`public` renders the SAME `RenderSections mode="public"` markup the live site
uses (the front-page panel precedent). Pure composition; no new renderer.

### D7 — Chat deep-link (B5)

`CmsPage` header gains "Ask the localizer" →
`navigate('/?agent=feature.cms.agents.localizer')` (shown when >1 locale is
configured) — the ADR 0058/0073 pattern; NO new chat surface. The submit
response's `autoTranslated` counts (ADR 0064 amendment) surface as a toast.

## Alternatives rejected

- Picker in `ui/` (design-system layer must not own feature logic) or grown
  inside cms (duplication drift — media owns media UX).
- Append-only usage events (unbounded growth, double counting).
- A `reason: submit|publish` label on snapshots (mislabels under dedupe).
- A backend diff endpoint (the editor already holds both trees).
- Separate taxonomy table for tags (premature).

## Tests

`backend/typescript/test/cms-editor-surfacing.test.ts` (route-level): tag
cleaning + `?q/&tag/&status` filters + invalid-status 400; snapshot-on-submit
dedupe (submit→publish = ONE capture; edit→resubmit = new; reject→resubmit
unchanged = none); usage reconcile (record/refresh-label/de-reference/overlay
tokens/delete-cleanup) + IDOR (foreign tenant 404). Token round-trip covers D4.

## Phase → artifact

| Item | Where |
|---|---|
| B1 backend | `cmsService.ts` `snapshotPage` dedupe + submit capture |
| B1 UI | `CmsPage.tsx` History panel + `sectionDiff.ts` + diff modal |
| B2 | `CmsPage.tsx` preview toggle (`RenderSections mode="public"`) |
| B3 | `cmsService.ts` tags + `PageListFilter`; `routes.ts` query params; `CmsPage.tsx` filter bar + tag chips |
| B4 backend | `mediaService.ts` usage refs + routes; `cmsService.ts` `collectMediaTokens`/`syncPageUsage`; `boundedStrings.ts` `cleanOpaqueToken` |
| B4 UI | `MediaPickerDialog.tsx`; `SectionsEditor.tsx` `onPickMedia`; `MediaLibraryPage.tsx`/`MediaViews.tsx` "used by" |
| B5 | `CmsPage.tsx` localizer deep-link + autoTranslated toast |
