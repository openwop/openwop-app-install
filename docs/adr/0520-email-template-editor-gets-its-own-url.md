# ADR 0520 — The email template editor gets its own URL

Status: implemented

**Date:** 2026-08-03
**Depends on:** ADR 0019 (Email Marketing), ADR 0519 (Forms is a standard
collection page — the reference implementation), ADR 0131 (collection-view
canon), ADR 0256 (safe-markdown body + server-authoritative preview),
ADR 0510 (`<Button>`, page archetypes).
**RFC gate:** host work only — **no RFC**. The one new endpoint is a
host-extension route under `/v1/host/openwop-app/*`, which is non-normative and
never touches the wire.

## Context

`docs/steward/COLLECTION-CANON-SWEEP.md` swept the app for the defect ADR 0519
fixed on Forms, and named `features/email/EmailPage.tsx` the **closest twin**:
a `?template=` query mirror, `<button>` selector cells toggling
`btn-accent`/`btn-ghost` with `aria-current`, delete on the collection cell, and
the editor rendered inline *inside the same card as the list*.

The sweep also found the root cause of the spread: DESIGN.md exempted "editor
nav-rails (CMS, Email, Forms, Publishing, Sharing)" from the canon, but **none of
those pages renders a rail**. Email's templates section is a full-width stacked
`surface-card` block. The exemption was being claimed by resemblance.

## What makes Email different from Forms

`/email` is **not** a collection page. It is a hub with four concerns on one
route: provider status, sender identity, templates, and campaigns. So this is not
a Forms-shaped page split — the hub stays a hub.

**Decision: move the LANE, not the page.** The templates lane adopts the canon
(link cells → a detail route, delete on the detail surface, designed states); the
hub keeps its other three sections exactly where they are.

## Decision

- **`/email`** keeps `archetype: 'standard-index'` and its four sections. Its
  templates section becomes a real collection: `.card-grid` of `<TemplateCard>`
  or `.surface-card.list-view` of `<TemplateRow>`, a `<ViewToggle>`
  (`useViewMode('email-templates')`), a name filter gated on the **unfiltered**
  total, and `<StateCard>` empty / no-match states with a clear-search action.
- **`/email/templates/:templateId`** (`archetype: 'detail'`) owns the editor —
  name, subject, format, body, the ADR 0256 server-rendered markdown preview —
  plus Save and Delete, a `PageHeader` whose `h1` is the template name, and a
  "Back to Email" ghost link.
- **`EmailTemplateViews.tsx`** supplies Card + Row from ONE helper set
  (`templateHref`, `templateSubLine`), so the two views cannot diverge.
- **New backend route `GET …/email/orgs/:orgId/templates/:templateId`.** The
  service already had `getTemplate` (and `routes.ts` already imported it) — only
  the route was missing. The detail page must load standalone from a bookmark,
  a shared link, or a reload, so reading a list the hub happened to fetch would
  be wrong.
- **`?org=` survives** on the hub, and is written back by the workspace picker.
  It is a *filter on the hub*, not an opened entity — the distinction ADR 0519's
  DESIGN.md correction turns on.
- **The sub-line is the subject line** — a real stored field, and the thing a
  recipient actually sees (rule 6: sub-lines compose from real fields only).

## Two defects this surfaced, and what happened to each

1. **A page-killing crash in the new cells.** `formatRelativeTime` throws a
   `RangeError` on an unparseable date, which unmounts the React tree — a
   template row with no `updatedAt` took down the entire Email hub, and the same
   exposure had just shipped in ADR 0519's `FormViews`. The existing
   `sendConfirm.test.tsx` caught it. Fixed at the right layer: a new
   `isDatable()` predicate in `i18n/format.ts`, and both cell files now render
   **no timestamp** rather than a broken page — which is what §4.5 rule 10 ("if
   the store can't date it, the UI doesn't claim it") already required.
   **Left open, deliberately:** `formatRelativeTime` still throws for its other
   **29 call sites**. Making the shared helper defensive means choosing a
   fallback string for all of them, which is a cross-cutting decision that does
   not belong in an Email change. Recorded in the sweep tracker.
2. **A wrong assumption in a new test.** The added backend test asserted the
   single-template route projects `tenantId` out, because the *surface* (the
   agent-facing consumer) does. The HTTP list and PATCH routes both return the
   stored row. The route was made consistent with its siblings and the test
   corrected — the projection claim was never true of this consumer.

## Trade-offs accepted

- **The hub gained a route but not a Grid⇄List toggle for campaigns.** Only the
  templates section adopted the canon (see below).
- **One extra request** on the detail page, for the same reason as ADR 0519: the
  alternative couples the editor to a list it cannot assume exists.
- **Unsaved edits** get the `beforeunload` guard + an "unsaved changes" chip, the
  same posture as every other editing surface; in-app navigation is not blocked.

## Explicitly NOT done: campaigns

The campaigns section on the same page still has `onClick` rows, a delete control
on the row, and an inline "Log" expansion with no URL. That is **not** an
oversight:

- a campaign has **no editor** — it is an operational row (send / resend /
  inspect), closer to a run than to a document;
- its "detail" is the send log, which rule 9 (quick-look) legitimately allows to
  stay in place, provided it becomes **deep-linkable via a URL param**;
- moving delete off the row therefore has nowhere to go until a campaign detail
  surface exists, and inventing one to satisfy a rule would be the wrong order.

Filed in `docs/steward/COLLECTION-CANON-SWEEP.md` as a separate, lower-severity
item with this reasoning, rather than silently counted as done.

## Implementation record

| Phase | What | Where |
| --- | --- | --- |
| 1 | `GET …/templates/:templateId` + route test (incl. IDOR) | `backend/.../features/email/routes.ts`, `test/email-route.test.ts` |
| 2 | `getTemplate` client call | `features/email/emailClient.ts` |
| 3 | Card + Row from one helper set | `features/email/EmailTemplateViews.tsx` (new) |
| 4 | The editor at its own URL | `features/email/EmailTemplateDetailPage.tsx` (new) |
| 5 | Hub templates section → canon; `?template=` mirror + inline editor + cell delete removed | `features/email/EmailPage.tsx` |
| 6 | `/email/templates/:templateId`, `archetype: 'detail'` | `features/email/routes.tsx` |
| 7 | `isDatable()` + both cell files guarded | `i18n/format.ts`, `EmailTemplateViews.tsx`, `forms/FormViews.tsx` |
| 8 | i18n × 4 locales (2 dead keys dropped) | `features/email/i18n/{en,es,fr,pt-BR}.ts` |
| 9 | Behaviour tests | `features/email/__tests__/EmailTemplateRouting.test.tsx` (new) |

Gates: frontend `npm run build` green (all 26 checks), `npm run lint` clean,
backend `email-route` 11/11, frontend email+forms 43/43.
