# ADR 0205 — CMS locale governance: translator grants + per-locale publish state (and the Phase-D scope record)

**Status:** implemented (2026-07-03)
**Date:** 2026-07-03
**Toggle:** rides `cms-localization` (grant writes + per-locale publish routes are gated on it; grants and locale states are meaningless without authored locales). No new toggle.
**Wire:** none. Per-locale withholding keeps the `/v1/content` response shape untouched — a withheld locale simply falls through the **already-normative RFC 0103 fallback chain** (exact → family → base). Exposing per-locale state ON the wire would be an RFC conversation; deliberately not done.
**Depends on / composes:** ADR 0064 (localization core), ADR 0009 (CMS), ADR 0006 (RBAC — authority stays accessControl's), ADR 0132 (the narrowing-filter precedent), ADR 0204 (audit + events), the CMS gap analysis Phase D.

## D1 — Translator locale grants

The localization-ops whitespace closer (gap analysis §E9/E5): agencies and
translators need to work on `pt-BR` without being able to touch base content
or publish.

- **Model:** a `cms:localegrant` row per (tenant, org, subject) — a **NARROWING
  filter** over a member's existing CMS write authority, the ADR 0132
  conversation-scope precedent (narrowing filters live with the feature;
  authority itself — roles/scopes — stays `accessControlService`'s and is
  unchanged). No grant ⇒ full-editor behavior, byte-identical.
- **Enforcement, server-side and fail-closed** (route boundary):
  - page PATCH: `title`/`slug`/`tags` immutable; sections diffed against the
    stored page (`assertLocaleScopedSectionsPatch`) — structure
    (count/order/ids/types), shared refs, and base `data` immutable; overlay
    adds/changes/removals allowed ONLY for granted locales (403 otherwise);
  - workflow transitions: 403 on `submit` (overlay-only grant; an editor
    submits) — the admin-tier transitions were already out of reach;
  - AI translate: `targetLocale` must be granted.
- **Management:** `GET/PUT …/cms/orgs/:orgId/locale-grants`
  (`host:members:manage`; PUT toggle-gated; empty `locales` removes the
  grant). UI: a Translator-grants block in the Content-languages panel
  (admin-only — the list 403s and the panel hides).

## D2 — Per-locale publish state

- `Page.localePublishState?: Record<locale, 'draft' | 'published'>` — only
  non-base locales appear and an **absent key means published-with-the-page**,
  so every existing page behaves exactly as before (backward compatible; the
  republish path deletes the key rather than storing `'published'`).
- Delivery (`localizePage`): a `'draft'` locale is removed from the negotiable
  set AND its overlays are stripped before `resolveSection`, so the request
  falls through the normative RFC 0103 chain. **No wire-shape change.**
- Routes: `POST …/pages/:id/locales/:locale/{publish,unpublish}` (admin tier,
  toggle-gated, 400 for a non-configured locale). Audited
  (`cms.locale-publish-state`, ADR 0204 C5). Editor: a "withheld from
  delivery" chip + per-tab publish/withhold actions in the locale overlay row.

## Correction (2026-07-03 — CMSGAP-1): grants now bind the WORKFLOW path too

The `/grade-code` pass falsified this ADR's "translators cannot X" claim: the
`ctx.features.cms` write verbs were tenant-scoped only, so a granted member who
can start runs could bypass the narrowing via `cms.localize-and-submit`.
Closed by threading the run owner's durable principal (`run.metadata
.actingUserId`, ADR 0024 §4 — the same value as `ctx.actingUserId`, re-stamped
on `:fork`) into `BundleScope.actingUserId` at the executor's surface-bundle
build, and re-checking the grant in `createDraftPage`/`updateSectionDraft`/
`submitPage`. System runs (scheduler, inbound triggers) carry no principal ⇒
no grant lookup ⇒ unchanged — the correct fail-closed signal, since no human
is acting. Route-level regression: `cms-locale-governance.test.ts`.

## The Phase-D scope record (the architect options-evaluation rulings)

| Item | Ruling | Rationale |
|---|---|---|
| D3 releases | **Deferred** | Would compose the ADR 0204 C6 verbs as a workflow run — right shape, but the chain just shipped with zero usage; build on demand, own ADR then |
| D4 structured collections | **Explicit NON-GOAL** | Lowest value for a reference host, highest parallel-content-system drift risk; a normative collections delivery would need a new RFC. Revisit only if the roadmap makes openwop-app a general CMS demo |
| D5 personalization pilot | **Deferred (exploratory)** | Pilot on the multivariant system if ever; the gap analysis itself rates it optional |
| D6 content FTS | **Deferred** | ADR 0206 B3 filters cover the ≤2000-pages/org cap; don't build ahead of need |
| D7 image renditions | **Deferred** | `sharp` adds a native dep to the Cloud Run image — deploy risk without demonstrated need |
| D7 hreflang emission | **Deferred pending spec check** | `Link rel=alternate hreflang` on `/v1/content` needs an RFC 0103 erratum conversation in `../openwop` first |
| C1 follow-up: internal-event trigger source (`publish-on-event`) | **Deferred → Phase-D candidate ADR** | A real ADR 0034 extension (a `source:'internal'` ingestion variant), not a CMS-local hack |

## Tests

`test/cms-locale-governance.test.ts` — D1: grant management authority, the
allowed granted-locale overlay edit, and the 403 matrix (base data, foreign
locale, title, structure, submit, foreign-locale AI translate), grant removal
restoring full behavior; D2: withhold → base fallback with sibling locales
unaffected, republish restoring delivery + the absent-state compat, unknown
locale 400.
