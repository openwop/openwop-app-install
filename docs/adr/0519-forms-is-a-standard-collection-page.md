# ADR 0519 — Forms is a standard collection page, and a form opens at its own URL

Status: implemented

**Date:** 2026-08-03
**Depends on:** ADR 0017 (Forms), ADR 0131 (collection-view canon — the Grid⇄List
scoping decision), ADR 0079/0058 (the routing-correction canon), ADR 0510 (design
system — `<Button>`, page archetypes), ADR 0516 (form templates as a pack).
**RFC gate:** host UI only — **no RFC**. No wire shape, capability, or endpoint
contract changes; the one client addition (`getForm`) calls an endpoint the
backend already exposed (`GET …/forms/:formId`).

## Context

`/forms` was a stacked master–detail page: a create toolbar, then a bordered list
of forms, then — under it, on the same route — the builder for whichever form was
selected, then that form's submissions. Selection lived in component state and was
mirrored to `?form=<id>`.

That shape was *sanctioned*. DESIGN.md §4.5 rule 12 has two lanes, and Forms was
named in both of the ones that excused it: it was listed as a "builder-selector
page" whose selection mirrors to search params, and the editor nav-rail exemption
named Forms when scoping the Grid⇄List toggle out.

The review that prompted this ADR rejected that reading, and the rejection is
correct. **Forms is not an editor rail.** It is a full-width page listing
homogeneous entities — the same shape as Projects, Documents, and Strategy. The
exemptions were written for a ~280px selector column inside an editor, and Forms
had been filed under them by resemblance rather than by fit.

## What was actually wrong

Three canon violations followed from the stacked shape, none of which look like
defects in a screenshot:

1. **The cells were not links.** Each row was an `onClick` button, so cmd-click,
   middle-click, "copy link address", and browser history did nothing. Rule 12
   requires collection cells to be real `<Link>`s.
2. **Delete lived on the collection cell.** A trash icon sat on every row, one
   mis-aimed click from the row the user meant to open. Rule 12 puts destructive
   actions on the entity's own surface.
3. **The list had no Grid⇄List toggle and no designed states.** Empty and
   no-match rendered as bare `<span>` text (rules 11 and 13).

A fourth is structural: with the builder stacked below, **the URL could not name
what was open** beyond a query param the page had to re-consume one-shot after the
list loaded — a mechanism that exists only because the route itself refused to
carry the identity.

## Decision

**`/forms` becomes a standard collection page and `/forms/:formId` becomes a real
detail route.** Concretely:

- **`/forms`** (`archetype: 'standard-index'`, which the route already declared
  and now genuinely is): `PageHeader` → create toolbar (blank + ADR 0516
  templates) → ONE `.filterbar` row (search + status facet + `<ViewToggle>`) → a
  `.card-grid` of `<FormCard>` or a `.surface-card.list-view` of `<FormRow>` →
  designed `<StateCard>` loading / failed / empty / no-match states.
- **`/forms/:formId`** (`archetype: 'detail'`): the builder, publish controls +
  shareable URLs, submissions, and Delete. Leads with a `PageHeader` whose `h1` is
  the form title, plus a "Back to Forms" ghost link.
- **`FormViews.tsx`** supplies the Card and the Row from ONE set of helpers
  (`formSubLine`, `formHref`, `statusChipClass`), so the two views cannot diverge
  — the `primaryAction`/`subLine` precedent from `/agents`.
- **The detail page loads its own form** via a new `getForm(orgId, formId)` client
  call. It is reachable by bookmark, shared link, or reload with no list in
  memory, so reading a list the collection page happened to fetch would be wrong.
  A 404 renders the designed not-found state, never an empty builder.
- **`?org=` rides on every cell href** and is written back by the workspace
  picker, so a shared link resolves the same workspace for the recipient.

### Corrections to DESIGN.md this ADR lands

Two lists in §4.5 named Forms as exempt. Both are amended in the same commit:

- **rule 11** (editor nav-rails out of scope for Grid⇄List): Forms removed.
- **rule 12** (stacked master–detail mirrors selection to search params): Forms
  removed from the example list; the entry now says a page qualifies for that
  lane by being a narrow in-editor selector, **not** by having an editor behind
  the selection.

CMS, Email, Publishing, and Sharing stay exempt — they are genuinely rails inside
an editor. See § Open questions.

## Alternatives weighed

- **Keep the stack, fix only the cells.** Making the rows `<Link>`s while the
  builder stayed below would mean a link that scrolls rather than navigates —
  the worst of both, and delete would still have no home but the cell.
- **Quick-look drawer (rule 9) instead of a detail route.** A drawer suits
  *reviewing* an entity without leaving the list. The forms builder is a
  long-lived editing surface with unsaved state; rule 9 explicitly says the
  drawer must not grow a second copy of a full surface.
- **Keep `?form=` and add the path route.** Two URL shapes for one concept, with
  the query param as a legacy alias. Rejected: nothing external links `?form=`
  (verified by grep across `src/`), so there is no compatibility debt to carry.

## Trade-offs accepted

- **An extra navigation to edit.** Opening a form is now a route change rather
  than an in-page selection. This is the cost of a URL that names what is open,
  and it buys back/forward, sharing, and bookmarks.
- **One extra request on the detail page.** `getForm` re-reads the form the list
  already had. Deliberate: the alternative couples the detail page to a list it
  cannot assume exists.
- **Unsaved edits now survive a browser-level navigation only.** The detail page
  wires `useUnsavedChangesWarning` (a `beforeunload` guard) and shows an "unsaved
  changes" chip; in-app router navigation is still not blocked, matching every
  other editing surface in the app.

## What this preserved (verified, not assumed)

This work was rebased onto `origin/main` mid-flight after it emerged that the
branch was 132 commits behind. Both of the following landed there in the interim
and are carried through intact:

- **ADR 0516's template picker** — `listFormTemplates` / `createFormFromTemplate`
  in the create toolbar, including the `templatesFailed` read-honesty state.
  Creating from a template now navigates to the new form's URL like every other
  create path.
- **The UX-WS-1 failed-read honesty** — every read keeps its own FAILED flag,
  distinct from `null` (loading) and `[]` (genuinely none). The submissions read
  in particular must never render as "No submissions yet" after a 404: that is
  precisely how the ADR 0508 shared-workspace outage stayed invisible.

## Implementation record

| Phase | What | Where |
| --- | --- | --- |
| 1 | `getForm` client call | `features/forms/formsClient.ts` |
| 2 | Card + Row cells from one helper set | `features/forms/FormViews.tsx` (new) |
| 3 | Collection page rewritten to the canon | `features/forms/FormsPage.tsx` |
| 4 | Detail page (builder + submissions + delete) | `features/forms/FormDetailPage.tsx` (new) |
| 5 | `/forms/:formId` route, `archetype: 'detail'` | `features/forms/routes.tsx` |
| 6 | i18n × 4 locales | `features/forms/i18n/{en,es,fr,pt-BR}.ts` |
| 7 | Behaviour tests | `features/forms/__tests__/FormsRouting.test.tsx` (new) |
| 8 | DESIGN.md §4.5 rules 11 + 12 corrections | `DESIGN.md` |

Gates: `npm run build` green (all 26 checks incl. the ADR 0510 design-system
ratchets — `check-unwrapped-buttons` baseline lowered 291 → 290), `npm run lint`
clean, 25/25 forms tests.

## Open questions

1. **The remaining rail exemptions.** CMS, Email, Publishing, and Sharing keep
   the rule 11/12 exemption. Each should be re-checked against the same question
   this ADR asked — *is this a narrow selector inside an editor, or a full-page
   collection wearing a rail?* — rather than inheriting the exemption by name.
2. **Submission detail.** A submission is still a text row. If submissions grow
   their own view, they get their own URL under `/forms/:formId/submissions/:id`
   by the same rule, not a modal.
