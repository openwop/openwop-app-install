# ADR 0594 — a live-reference section is governed by the REFERENCED store, not by the page's approval

Status: Accepted

Supersedes nothing. Extends **ADR 0593** (the read-time-indirection class) and
**ADR 0407 D1/D3** (entity-backed sections + the content-section resolver
registry). Resolves the **write-gate half of `CMSA-12`**, the one member of the
ADR 0593 class that was deliberately left open pending a cross-feature authority
ruling.

## Context

ADR 0593 closed a class: *content that public delivery resolves LIVE, invisible
to the approve-what-you-saw pin (`page.version`)*. Four lanes were found and
gated through one shared rule — `GATED_LIVE_EDIT_STATES` + `refuseLiveEdit()` +
`liveEditRefusal()`, fanned out over the deliverable-section union
(`deliverableSectionsForPage`, live sections ∪ every bound running-variant
snapshot).

`CMSA-12` is the fifth member and the only one found by call-graph rather than by
category. It has two halves:

- **The cross-tenant half — FIXED** (`dedaad63b`, #3428, ADR 0593 §C9). The
  `entityList`/`entityDetail` resolvers took the tenant from `data.tenantId` — a
  field a `workspace:write` editor controls — while `ContentResolveContext.pageTenantId`
  was threaded in by `prerenderService.ts` and never read. Both resolvers now
  refuse a foreign tenant (`publicRead.ts:147-150`), and `validateSection`
  refuses one at the write. An adversarial review established this needed no
  product ruling and that the original severity was inflated: `readPublicEntities`
  already gates `published + publicRead`, so it was a cross-tenant **embed of
  already-public rows**, not a data leak.

- **The write-gate half — THIS ADR.** An entity row's content reaches an
  anonymous, approved, published page's crawler HTML (`prerenderService.ts:253-265`)
  and its `schema.org` `ItemList` (`:301-305`) through the resolver at
  `workspace:write` (`entities/routes.ts:272, 342, 369, 395`), with no CMS
  approval row and no `page.version` movement. The approve-what-you-saw pin is
  blind to it exactly as it was for `CMSA-1`.

The tracker row framed the objection to the naive cure as cross-feature coupling:
*gating entity writes on CMS page state would refuse a CRM edit merely because
some marketing page lists that entity.* Reading the code, **that framing is
wrong in one direction and much too weak in the other**, and both corrections
matter to the ruling.

### Verified mechanism (four findings that move the decision)

**F1 — the "refuses a CRM edit" objection is structurally impossible.** CRM
companies/deals, service-desk tickets and every other record store are minted
`neverPublic: true` (`crm/entities/companies.ts:42`, `crm/entities/deals.ts:80`,
`service-desk/tickets.ts:42`). `gatePublicType` — the ONE anonymous funnel —
refuses `neverPublic` outright (`publicRead.ts:66`), and `updateEntityType`
refuses setting `publicRead` on such a type (`entitiesService.ts:323`, ADR 0409
Phase 1, two locks). A CRM record can never appear in an `entityList` /
`entityDetail` section. **The population actually at risk is only entity types an
admin has deliberately designated as public website content** — the ADR 0407
motivating cases: events, job postings, team rosters.

**F2 — the privilege split the ruling rests on holds.** `publicRead` is settable
**only** through `PATCH …/types/:name`, which requires `host:members:manage`
(`entities/routes.ts:219-221`); `POST …/types` does not accept the field at all
(`:192-197`). So the **channel** (a publicly-readable type) is opened by an
admin, and only the **rows** flow at `workspace:write`. Low-privilege writers can
fill a public channel; they cannot create one.

**F3 — option (b), gating at the projection, is VACUOUS.** The entity content is
not reachable only through the page. `GET /v1/host/openwop-app/public-entities/:tenantId/types/:typeName/entities`
(`entities/routes.ts:572, 605`) is an **independent anonymous delivery lane with
no page context whatsoever**, and the SPA renders `entityList`/`entityDetail`
from it directly, client-side (`SectionRenderer.tsx:398-435` → `EntityListSection`
/ `EntityDetailSection`). A gate applied at the prerender resolver would hold
**only the crawler HTML** while every human browser — and anyone with `curl` —
still sees the new rows. That is the inversion §C9 already rejected in the other
direction ("a read-only cure would make the crawler see less than a human"), now
compounded into a gate that does not gate (the ADR 0582 family). Pushing the gate
down into `readPublicEntities` to close the bypass fails too: that function has
no page context, cannot acquire one (its whole contract is page-independent), and
is shared by a **fourth consumer** — `kicktodo-community/communityService.ts:331`
— which would be silently changed. *A shared predicate needs reachability proved
per lane.*

**F4 — option (a) is not merely costly, it is NOT COMPUTABLE.** An `entityList`
section stores a **query** (`filters`, `sortKey`, `sortDir`, `termId`, `limit`),
not a row id. "Does page P reference row R" therefore cannot be answered by an
index; it requires *evaluating* every candidate section's query — and because
`limit` defaults to 6 with a sort, **creating an unrelated row can silently change
which rows a page shows**, so even a perfect entity→page index would not capture
the dependency. On top of that the entity write route is tenant-scoped and
org-less, so the candidate set is every org in the tenant × up to
`MAX.perOrgPages` = 2000 pages (`cmsService.ts:71`) × their running-variant
snapshots, per row written — and the NDJSON import (`:342`) writes N rows in one
request over `DurableCollection`, whose `list()` is a full scan.

## Options considered

| Option | Cost now | Debt left | Forecloses | Reversible |
|---|---|---|---|---|
| **(a)** Gate the entity WRITE on referencing-page state | Not computable (F4); O(orgs × 2000 × variants) durable reads per row | A gate that is wrong by construction for query-shaped references | Bulk import; the entities store as a shared substrate | Hard — inverts authority |
| **(b)** Gate/degrade at the PROJECTION | Small | **Vacuous** (F3): holds the crawler, not the SPA or the public route | Nothing — because it achieves nothing | Easy |
| **(c)** Snapshot/pin entity content at approve time | Medium (storage per version × section) | A second copy of entity truth inside CMS versions | Reverses ADR 0407 D1's explicit live-reference contract | Medium |
| **(d)** Accept the lane; make the boundary explicit + disclosed at signing | Small | The lane stays open, by design and in writing | Nothing | Easy |

Notes on **(b)** and **(c)** that the table cannot carry:

- **(b)** would also be *undetectable when it fires*. `resolveContentSection`
  swallows every resolver failure and degrades to chrome
  (`contentDataSources.ts:73-77`), so a deliberately "held" projection is
  byte-indistinguishable from a resolver bug. A refusal nobody can observe is not
  a refusal — and there is no exit for the data editor, who is not the page
  owner and may not know the page exists.
- **(c)** is the only option that would genuinely make the signature cover the
  content, and it is rejected on **product contract**, not on cost. ADR 0407 D1
  states the section is "a stored QUERY REFERENCE resolved live at render time …
  never stale copied data — the productGrid model." Freezing it at approve time
  makes an events list show last quarter's events until someone republishes the
  page: the section becomes worse at the only job it has. A narrower variant —
  pin `entityDetail` (a true single-id reference) and leave `entityList` (a
  query) live — is coherent but splits the section contract with no principle
  behind the split, so it is recorded as the fallback under Falsifiability, not
  the decision.

## Decision

**Adopt (d), with disclosure — and state the boundary as a standing rule.**

> **The CMS approval gate's closed world is the PAGE. A live-reference section
> is not page content; it is a pointer into a second store that carries its own
> publication gate. Approving the page approves the POINTER — the query, its
> chrome, its placement — never the rows it will resolve to. Publication of
> those rows is governed by the referenced store's own editorial controls
> (`status: published` + `publicRead` + `!neverPublic`), which is where it stays.**

This is not a new position; it is ADR 0407 D3's own header made binding:
*"the correct cloaking anchor for REFERENCED content is the referenced store's
public read, not the page projection."* `CMSA-12` is what it looks like when that
anchor is read as a **coverage claim** rather than as a **boundary**.

Two obligations make (d) honest rather than a shrug:

**D1 — the approval row must DISCLOSE its live-reference sections.** A reviewer
who signs a page containing an `entityList` must be told, on the card, that those
sections resolve live and that their signature does not freeze them. This rides
the mechanism that already exists: `queueContentApproval` (`contentApproval.ts:379-428`)
already derives `aiDraftedLocales` from the page's sections for exactly this
purpose — a machine-draft disclosure on the approval card. A `liveReferenceSections`
derivation is the identical shape, the identical lifecycle (recomputed on every
repin, so it clears honestly when the section is removed), and lands in the same
four callers (`cms/routes.ts:425, 453`, `cms/surface.ts:158`,
`pageExperimentsService.ts:463`) for free.

**D2 — the entities publication gate is the SOLE authority for this lane, and
stays admin-tier.** The `neverPublic` lock (both locks, ADR 0409 Phase 1) and the
`host:members:manage` tier on `publicRead` (F2) are what make (d) defensible; a
test must pin that no CMS lane can widen either.

### Interaction with `deliverableSectionsForPage`

**Yes — D1's derivation MUST use `deliverableSectionsForPage(page)`, not
`page.sections`.** This is the §C9 F1 root cause one level down: a page bound to a
running experiment serves `version.snapshot.sections` to a variant-arm visitor
(`publishingService.ts:186-196`), so a live-reference section **dropped from the
live page but surviving in a bound snapshot** still reaches readers — and a
disclosure derived from `page.sections` alone would tell the reviewer there are
none. The union is required on the **disclose/write** side.

It is **not** required on the read side, and that asymmetry is worth recording so
a later reader does not "fix" it: the prerender loop iterates the sections of the
page `publicPageBySlug` already returned (`prerenderService.ts:256`), which has
**already** substituted the variant snapshot. The delivered page *is* the arm.
(Bots send no `vk`, so crawlers always get the live page; the snapshot lane is
human-only.)

### Interaction with the `published + publicRead` gate

That gate is the **entire** mitigation and it should be named as such rather than
treated as a happy accident. It is why this ruling is "accept" and not "escalate":
the content an unapproved write can move onto a live page is confined to rows of a
type an **admin** has explicitly designated public, that are themselves
`published` (not draft — `excludeDrafts: true`, `publicRead.ts:95`), and are
scalar-projected (`toPublicEntity`). What `CMSA-12` describes is a public-content
editor changing public content. What it is **not** — and what the row's original
severity implied — is a low-privilege writer opening a new public channel.

## Consequences

**The trade-off accepted, stated plainly.** An approved, published page's
crawler HTML, JSON-LD and human-visible body **can change after approval**, at
`workspace:write`, with no new approval row and no `page.version` movement —
permanently, by design. We accept that in exchange for keeping the live-reference
contract that makes entity sections worth having, keeping ONE anonymous-entity
gate, and keeping the entity write path computable. An approver's signature on a
page with an `entityList` means *"I approve this page showing a live list of
published X"* — never *"I approve these six rows."* After D1, the card says so.

**What this ADR does NOT license.** It is a ruling about *referenced* content in
a *second store with its own publication gate*. It is not a general licence to
leave read-time indirections ungated — the four lanes ADR 0593 closed were page
state (sections, SEO, shared sections, locale release), all of which the page
genuinely owns. When the next class-enumeration finds a sixth indirection, the
question this ADR answers is: **does a second store's own editorial gate govern
it?** If yes, disclose and leave it. If no — if the page is the only authority —
it belongs in `GATED_LIVE_EDIT_STATES` with the rest.

## Implementation plan

| Phase | Work | Gate |
|---|---|---|
| 1 | **D1 disclosure** — derive `liveReferenceSections` in `queueContentApproval` from `await deliverableSectionsForPage(page)`; surface it on the ApprovalsInbox card beside the machine-draft disclosure | A route test proving the field appears for a page whose entity section lives **only** in a bound running-variant snapshot (the §C9 F1 shape) |
| 2 | **D2 pin** — a test asserting `neverPublic` cannot be widened by any CMS lane and that `publicRead` remains `host:members:manage` | The test is the tripwire for the falsifier below |
| 3 | **Stale-comment fix** — `contentDataSources.ts:38-45` still calls `pageTenantId` "informational … the entities resolver relies on the public-read gate instead", which §C9 falsified when it made the resolver enforce it | Grep-level; filed as `CMSA-D6` |

**First concrete step: Phase 1's derivation**, because it is the only change that
alters what a human is told before they sign, and it reuses a mechanism that is
already correct — `aiDraftedLocales` is a working, repin-safe disclosure and
`liveReferenceSections` is the same computation over the same input. Phase 1 also
requires `queueContentApproval` to become `async` over the deliverable union
rather than the raw `sections` array it takes today, which is the only real
design decision in the phase and should not be smuggled in behind Phase 2.

## Falsifiability — what would change this ruling

1. **`publicRead` becoming settable below `host:members:manage`** (F2 inverts).
   If a `workspace:write` actor could both designate a type public and fill it,
   "an admin opened this channel deliberately" evaporates and the gate belongs on
   the `publicRead` flip — not on the row write, and not on the projection.
   Phase 2's test is the tripwire.
2. **`neverPublic` gaining a bypass**, or a record store (CRM, service-desk)
   being minted without it. F1 is doing load-bearing work; if a genuine record
   store becomes publicly readable, the "public-content editor changes public
   content" characterisation is no longer true.
3. **An operator reporting that a reviewer believed the approval covered entity
   content even after the D1 disclosure.** That would mean disclosure is
   insufficient and freeze semantics are actually wanted — at which point adopt
   the narrow (c): pin `entityDetail` only (a true single-id reference, one row,
   cheap), and leave `entityList` live with the disclosure. Do not adopt (c)
   wholesale; the query lane's staleness cliff is the reason.
4. **A second page-context-free delivery lane appearing for CMS-owned content**
   (F3's shape generalising). If page-referenced content routinely escapes the
   page, the boundary in this ADR is right but the *disclosure* is too weak, and
   the reviewer needs a standing list of what their signature never covers.

## Notes

- Docs-only ADR: no backend/frontend source changed, so `npm run ci` was not run
  for this commit. Phases 1–3 are gated normally.
- The `--next`/`--reserve` tool minted 0594 and the reservation was committed
  before the content was written (DEBT-4).
