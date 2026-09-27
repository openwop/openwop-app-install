# ADR 0593 — CMS editorial approval gate: the shared-section lane, terminal row lifecycle, and reviewer-context honesty

Status: implemented

> Fix batch for feature 24/71 of the grade loop. Assessment merged as PR #3425
> (`f9067d05c`): code **B** (2 Blockers, `CMSA-`), UX **C** (5 Blockers,
> `CMSAU-`), workflows **B+** (0 Blockers, `CMSAWF-`).
> Trackers: `docs/steward/CODEBASE-ASSESSMENT.md` (feature-24 section),
> `docs/steward/UX-ASSESSMENT.md`, `docs/steward/WORKFLOWS-ASSESSMENT.md`.

## Context

ADR 0066 gates CMS publishing on a human review: `submit` queues ONE
`content-publish` row on the shared approval queue (unconditionally, since the
chat-first-port C1 correction), and every decide lane converges on
`decideContentPublish` (`features/cms/contentApproval.ts`). ADR 0592 §1 added the
approve-what-you-saw **version pin** (`approval.pageVersion` vs the live
`page.version`, checked before the CAS resolve).

Three lanes of the assessment found that the gate's promise — *nothing reaches a
published page without a human review* — has a hole, that a pending row can
outlive its subject with no exit, and that both human ends of the gate are
starved of context.

### The four findings this ADR decides

1. **`CMSA-1` (Blocker) — an ungated FOURTH lane to live content.**
   `updateSharedSection` requires only `workspace:write`, has no gate check, and
   delivery resolves `section.ref` to the shared row's **current** `data` /
   `localizations` at READ time (`resolveSharedRefs`, reached from
   `getPublishedBySlug`, `publishingService` and `sharingService`). So on a gated
   org an editor rewrites live published content instantly with the inbox empty —
   at a tier BELOW the admin bar the published-page PATCH gate (CMS2-B1) enforces.
   And because `page.version` never moves, the staleness 409 cannot fire for an
   `in_review` page whose shared section was rewritten: the pin is BLIND to
   reference indirection.

2. **`CMSA-2` / `CMSAWF-1` / `CMSAWF-2` (Blocker) — a pending row outlives its
   page with no exit.** Three producers strand a row (`deletePage`,
   `restoreVersion`, gate-OFF `promoteExperiment`). Both decide arms then
   CAS-resolve, fail the page transition, `reopenApproval`-compensate and
   404/409 — **forever**. Each attempt appends a GOVERNANCE_DECISION entry to the
   tamper-evident chain and then compensates, so retries durably pollute it. This
   is the documented DLR2-B3/B4 **unclearable-card** shape, already cured for
   dealer registrations by `closePendingDealerRegistrationApprovals`.

3. **`CMSA-3` / `CMSAWF-3` + `CMSAU-2` / `CMSAU-3` — the staleness family.** The
   pin is check-then-act (no version precondition travels into `transitionPage`),
   and its 409 renders in the inbox as the raw dev string
   `claimApproval returned 409` while the CMS header shows a different message —
   two decide surfaces disagreeing. Worse, the 409's own remedy is unreachable:
   the backend allows re-submit from `in_review` precisely so the pin can catch
   up, but the SPA offers only approve/reject, so **Reject** — a real rejection
   event + webhook — is the only exit. A gate with no exit.

4. **`CMSAU-1` / `CMSAU-4` / `CMSAU-5` — the two human ends are starved.** The
   reviewer gets a sentence and a timestamp with no link to the page they are
   signing off (the fields and the route both exist; ADR 0066 Phase 3 prescribed
   the link and it was never built). The durable `aiDrafted` stamps ADR 0592 §3
   shipped are read by NO approval surface, and the one-shot English AI note
   decays to nothing on resubmit. Rejection notifies nobody, collects no reason,
   renders no reason, and leaves the page reading `draft` — indistinguishable
   from never-submitted.

## Decision

### D1 — the shared-section gate lives at the ROUTE, mirroring CMS2-B1

Options weighed:

| Option | Closes the live bypass | Closes the pin blindness | Cost | New durable state |
|---|---|---|---|---|
| **(A) route-level gate** — 409 a shared-section PATCH whose referencing pages include `published`/`in_review` while the gate is ON | ✅ | ✅ (structurally — no shared edit can land while a referencing page is published or in review) | S | none |
| (B) the shared edit queues its OWN approval (new kind + staged copy + apply-on-approve) | ✅ | ✅ | L | new kind, new store, new decide handler, FE card, i18n ×4, erasure redactor, SLA classification |
| (C) narrow the tier to `host:members:manage` while the gate is ON | ❌ | ❌ | S | none |
| (D) fold shared-row versions into the approval pin (`sharedVersions` map) | ❌ | ✅ | M | a second pin artifact per row |

**Chosen: (A).**

- (C) is rejected hardest: it is a *gate that does not gate*. An admin — exactly
  the person the gate exists to constrain — could still rewrite live content with
  the inbox empty. It also copies the WRONG half of CMS2-B1: that rule's admin
  re-authorization ("editors edit drafts only") is a *separate* guard from its
  gate 409, and (C) copies the first while dropping the second.
- (D) closes only the pin blindness and leaves the more severe half — a live
  rewrite that needs no approval at all — wide open. It also fails on the
  share-link delivery surface (`sharingService.ts:261`), where there is no
  approval to pin against. And it adds a second artifact that must be recomputed
  on every repin and remembered by every future indirection.
- (B) is the right long-term answer *if* the product decides shared sections are
  first-class reviewable content. It is a product ruling and a second editorial
  lifecycle; **deferred** (see Deferred, below). (A) forecloses nothing — (B) can
  supersede it, (D) can be layered on it.

**Trade-off accepted:** shared sections become uneditable for a gated org while
any referencing page is `published` or `in_review`. That is the same
unpublish-first remedy CMS2-B1 already made the org perform to edit a published
page, so it is consistent rather than novel. Three things make it a refusal with
an exit rather than a dead end:

1. The 409's `details` **names the blocking pages** (id, title, slug, status) —
   `listPagesUsingSharedSection` already returns exactly that shape. A refusal
   that does not say what to unpublish is the gate-with-no-exit shape this same
   batch is closing elsewhere.
2. The `GET /shared-sections/:id/pages` impact list already exists and is what
   the editor reads before trying.
3. **The system-site org is exempt**, for the identical reason recorded at
   `routes.ts:200-209`: `SYSTEM_SITE_ORG` has no members and no approvers, nav
   and footer are exactly what a marketing site shares, and gating them without
   the exemption reproduces the outage CMS2-B1 had to be corrected for.
   *(This failure mode was not in the assessment; it came out of the
   options-evaluation pass.)*

### D2 — terminal row lifecycle: producer cleanup **and** a decide-arm backstop

Options: (A) producer-side cleanup only, (B) decide-arm terminal refusal only,
(C) both. **Chosen: (C), with the decide arm explicitly a BACKSTOP.**

- Producer cleanup is the *correct* place — it knows WHY, so it can attribute
  honestly ("Page deleted", "Superseded by a version restore", "Superseded by an
  experiment promote").
- But every producer cascade in `deletePage` is deliberately best-effort
  (`try`/`catch` + `log.warn`), so a cleanup failure is *expected* to happen
  sometimes. Under (A) alone a failed cleanup silently restores the old wedge,
  and any FUTURE producer reproduces it from scratch. The decide arm is where the
  guarantee lives: **a guard that cannot identify its subject must refuse, and
  must not leave an unclearable card.**

Mechanics, in this order inside `decideContentPublish`:

1. row lookup / kind / tenant guard → uniform `null`;
2. signed-in decider → typed 403;
3. org + IDOR (`host:members:manage` in the page's org) → uniform `null`;
4. **NEW — subject re-read.** `getPage`; if the page is gone, or is no longer
   `in_review`, terminally resolve the row and throw a typed 409
   (`reason: 'review_closed'`). **The re-read is placed AFTER the authority
   check on purpose** — before it, "this page was deleted" leaks to a
   non-manager who guesses an approvalId, where today they get a uniform null;
5. the existing staleness pin (approve only);
6. CAS resolve → `transitionPage`. The existing compensation stays as
   defence-in-depth.

**Attribution (a failure mode the assessment did not name):** the terminal
closure passes **no `decidedBy`**. Recording the clicking operator as having
"rejected" content that no longer exists would put a human's name on a decision
the system made. The note names the cause; the absent actor says the system did
it — the same shape `closePendingDealerRegistrationApprovals` uses.

**Why `rejected` and not a fourth status:** `ApprovalStatus` is read by the
reviews projection, both inboxes, the SLA rung, `pruneResolved`, the erasure walk
and the FE type, all of which switch on three values. A new value is a
cross-cutting change with a far larger blast radius than this fix warrants.
`rejected` + an authorless note is the least-wrong option and the established
house shape.

**Escalation check:** none. The closure happens only after the decider has been
proven to hold `host:members:manage` in the page's org — authority with which
they could reject the row outright anyway.

**Not moved into `transitionPage`.** The obvious "simplification" is to put the
cleanup at the one choke every publish/unpublish/archive goes through. It is
wrong: the approve arm calls `transitionPage('approve')` *while holding the row
already resolved*, so a cleanup there would reject the row it just approved.

### D3 — the staleness family is ONE seam, fixed on both sides

Backend: thread `{ expectedVersion: approval.pageVersion }` into
`transitionPage('approve')` so the pin becomes a precondition rather than a
check-then-act (`CMSA-3`). Frontend: give `approvalsClient` the same typed-error
treatment `CmsApiError` got in #3423, and map the approval codes through ONE
shared `approvalErrorInfo` so both decide surfaces render the SAME localized
message. Surface the remedy: `Submit again` is offered on `in_review`, so the
409's own instruction is reachable without firing a rejection nobody meant.

### D4 — reviewer context is derived from durable state, never from a sentence

`CMSAU-4`'s cure is not a better sentence. The `aiDrafted` stamps ADR 0592 §3
made durable are recomputed from the page's sections at queue AND repin time and
stored structurally on the row (`aiDraftedLocales`), so the disclosure survives
the reject → fix → resubmit loop that erased the one-shot English note. The card
renders it as a `chip--ai`, the same marker the editor already shows.

## Consequences

- A gated org must unpublish (or withdraw from review) every page referencing a
  shared section before editing it. Discoverable, named in the refusal, and
  exempt on the system site.
- A pending content-publish row is now always clearable: by its producer, or by
  the first decide attempt, which closes it authorlessly and says why.
- Exactly ONE governance-chain entry is appended per stranded row (the closure);
  repeat attempts hit the pre-existing non-pending 409 and append nothing.
- `queueContentApprovalIfGated` is retired — its last caller (the experiment
  promote lane) now queues unconditionally like every other submit lane, closing
  the double-toggle-read flip window (`CMSA-4` / `CMSAWF-2`).

## Corrections — adversarial review of PR #3426 (2026-08-21)

Nine findings; the two HIGH ones re-created the `CMSA-1` shape **inside this
ADR's own class-enumeration fix**. Appended, never rewritten — the reasoning
trail is the point.

### C1 (⇒ F1/F2) — enumerating a class is not covering each member's ARMS

D1 named three siblings that guard "state which reaches a published page but
never moves `page.version`". It got the members right and the **arms** wrong:

| site | shipped | should have been |
|---|---|---|
| shared-section write | `published` **or** `in_review` | ✅ correct |
| per-page SEO write | `published` only | both — identical pin blindness, so a `workspace:write` editor could rewrite the canonical URL / title / og / `noindex` of a page **already under review**, and the approve shipped them |
| per-locale publish flip | **ungated** | the `→ published` direction gated — delivery reads `localePublishState` live, so releasing a withheld (typically machine-drafted) overlay on a live page publishes it instantly |

Root cause: **three hand-written copies of one rule.** The rule now has ONE
owner — `GATED_LIVE_EDIT_STATES` + `refuseLiveEdit` + `liveEditRefusal` in
`contentApproval.ts` — and each site states only which page it is asking about.
This is the "my fix reintroduces the family it closes" lesson operating one level
down: not at the member level (which the enumeration caught) but at the arm level.

`CMSA-8`'s version bump was **only the `in_review` half** of the locale defect;
the live half was never addressed. The class table in
`docs/steward/CODEBASE-ASSESSMENT.md` said "PARTIAL member — FIXED", which was
**false**, and is corrected there. A falsified disposition is worse than an open
row: it tells the next reader to stop looking.

### C2 (⇒ F3) — a refusal must name a verb the product ships

D1's refusal told the editor to *"unpublish them (or withdraw them from
review)"*. `grep -rn withdraw` over the CMS backend and frontend returned exactly
ONE hit — that message. And `unpublish` is `{from:['published','archived']}`, so
it 409s for an `in_review` page. The refusal prescribed an exit that does not
exist: the gate-with-no-exit shape D3 fixes on the page lane, re-created in D1's
own message.

**One prescribed cure was REJECTED.** The review offered "narrow the refusal to
`published` only — the `in_review` half is covered by the pin once it
resubmits". It is not: the pin's closed world is `page.version`, and a shared
row is invisible to it no matter how many times the page resubmits. That *is*
`CMSA-1`'s second half. Taking that cure would have reopened the Blocker. The
message is now per-status instead, naming `unpublish` for a live page and
"a reviewer must approve or reject it" for one under review — and naming the
tier, since **both** remedies are admin-tier (the objection that the refused
editor lacks authority applies equally to the arm the review accepted).

### C3 (⇒ F4) — attribution only works if something reads it

D2 argued that an authorless closure "says the system did it". That holds only
while a reader distinguishes it. The one new reader this ADR built
(`CmsPage`'s rejection Notice) branched on `status === 'rejected'` alone and
rendered `decidedBy` nowhere — so a routine `restoreVersion`, a `deletePage`
cascade and the decide-arm backstop all read to the author as *a human reviewer
sent your page back*. Now: `decidedBy` present ⇒ the warning Notice naming the
reviewer; absent ⇒ a neutral **"This review was closed automatically"** info
Notice. This also resolves F6 — the `workspace:write` projection now buys
something. (For the record, the projection was never a widening: `Page.createdBy`
/ `Page.updatedBy` are userIds already returned at `workspace:read`.)

### C4 (⇒ F5) — the third vacuous witness in this batch

`promoteExperiment`'s gate-OFF cleanup was **dead code**: `restoreVersion` runs
first and unconditionally, and (per D2) now closes the pending row itself, so the
promote arm's own `rejectPendingApprovalForPage` hit an already-resolved row and
the CAS refused. The recorded cause was therefore the generic restore note, and
**deleting the line entirely left the suite 14/14 green — including the test that
claimed to witness it.** The true cause is now threaded through `restoreVersion`,
and the test asserts the closure **NOTE** rather than the row's absence
(absence was satisfied by the other cascade, which is exactly how it was vacuous).

Three vacuous witnesses in one batch — F5, the `CMSA-3` TOCTOU probe, and the
losing-concurrent-decide probe — all found by **sabotage**, none by reading. The
transferable rule: *when two mechanisms can produce the same observable, assert
the one that only the mechanism under test can produce.*

### C5 (⇒ F7/F8) — smaller corrections

- The `CMSAU-4` disclosure was `title`-only: a Blocker cure whose load-bearing
  sentence lived in a tooltip, invisible to keyboard, touch and most SR. Now real
  text in the accessibility tree.
- The rejection Notice announced its TITLE, not the reviewer's note — the entire
  point of `CMSAU-5` was never spoken. The pending Notice had no `announce` at
  all (a live region mounted with content announces nothing).
- Both reason steps dropped focus to `<body>` on Cancel/Send (WCAG 2.4.3), and
  unmounted **before** the request resolved, so a failed reject swapped the UI out
  from under its own error toast. They now close only on success, and restore
  focus after the re-render (the first cut called `.focus()` inline, where the
  ref is still null — it silently did nothing).
- `queueContentApproval`'s `sections` was optional while the repin sent
  `aiDraftedLocales` unconditionally and `[]` means delete-the-field: a future
  caller omitting `sections` would have silently erased an open row's
  machine-draft disclosure — `CMSAU-4`'s own defect, re-armed as a latent trap.
  `sections` is now required, closing it at the type level.


### C6 (closeout, 2026-08-21) — the class had a THIRD member, and it was ruled out by the sentence C1 had just discredited

C1 above corrects the arm-level miss and states the lesson. The closeout pass of
PR #3426 found that the **member** enumeration was also incomplete, and that the
verdict which excluded the missing member was the *same sentence shape* the
review had already falsified one row earlier.

The class table in `docs/steward/CODEBASE-ASSESSMENT.md` carried a single cell
reading *"Redirects, org content-language settings — **NOT members** — slug
routing and negotiation, not page content."* That is two independent claims:

- **Redirects — verdict CONFIRMED.** `getPublishedBySlug` returns the direct
  published hit first and consults `redirects` only on a MISS
  (`cmsService.ts:1713-1725`), so a redirect can never repoint a slug a live
  page already owns.
- **Org content-language settings — verdict FALSIFIED. A full member, still
  open, tracked as `CMSA-10` (Blocker).** `localizePage` derives its deliverable
  set as `settings.supportedLocales.filter(l => state[l] !== 'draft')`
  (`cmsService.ts:1768`). `supportedLocales` is therefore the **strict superset
  control over the very map D1/C1 gated** — read live at delivery, at the same
  `host:members:manage` tier as the flip that WAS gated, and with no gate check
  on `PUT …/language-settings`. Three facts make it reachable rather than
  theoretical: `validateLocalizations` (`cmsService.ts:672-691`) validates an
  overlay key as BCP-47-and-not-base and never against `supportedLocales`, so
  overlays for unconfigured locales are storable; removing a locale does not
  strip any overlay (`host/contentLocales.ts:72-99`); and an absent
  `localePublishState` **means published**, so a newly added locale is live by
  default with no withheld-by-default arm. One settings write therefore puts
  dormant, unreviewed, `aiDrafted`-stamped machine translations in front of the
  public on a gated org with the Approvals inbox empty.

The transferable point is narrower than "we missed one". Both falsified verdicts
— `localePublishState`'s "PARTIAL member (delivery state, not content)" and this
one's "NOT a member (negotiation, not page content)" — rest on the **same
distinction between *content* and *the machinery that selects which content is
served***, and that distinction is not load-bearing for this gate. The gate's
promise is about what a visitor receives. **A class enumeration must be run over
the DELIVERY FUNCTION's inputs, not over the reader's categories for them**: every
input to `localizePage` / `resolveSharedRefs` / `projectPublic` that is not
`page.version`-pinned is a member by construction, and the three the batch found
are exactly the three such inputs it happened to name.

The intended cure reuses machinery this route already has: the `baseLocale`-change
branch two blocks up (`routes.ts:860-870`) already walks every page and shared
section holding an overlay at a given locale. Call `refuseLiveEdit` over that same
set for each ADDED locale; removal stays ungated, the fail-safe direction, exactly
as `unpublish` and locale-withholding do.

A narrower sibling was minted at the same time — `CMSA-11` (Improvement):
`startExperiment` (`pageExperimentsService.ts:269-292`) checks neither page status
nor the gate, and `snapshotPage` fires on SUBMIT as well as on publish
(`cmsService.ts:1336`), so a submitted-and-**rejected** version's snapshot is
bindable as a live experiment variant. Bounded by the admin tier, the audit entry,
the immutability of a running experiment's variants, and the visitor-key +
analytics-consent requirement on the delivery path.

**Status of this ADR is unchanged.** D1–D4 stand as decided and implemented;
C6 records that the enumeration D1 performed was incomplete in the member
dimension as C1 recorded it incomplete in the arm dimension. Both fixes belong to
a follow-on batch, not to this one.

### C7 (follow-on batch, 2026-08-21) — the class table was wrong a THIRD time, and the fix for that is to stop writing verdicts about categories

C6 recorded that the member enumeration was incomplete and named the reason:
*"a class enumeration must be run over the DELIVERY FUNCTION's inputs, not over
the reader's categories for them."* This section records what happened when that
instruction was actually carried out, because **it found two more things and it
falsified two more prescriptions.**

Both C6 rows are now fixed (`CMSA-10` Blocker, `CMSA-11` Improvement). Neither
fix is what C6 prescribed.

#### The final enumeration, re-derived rather than transcribed

Method: enumerate every store read reachable from the anonymous delivery entry
points — `publicPageBySlug` (`features/publishing/publishingService.ts`), the
`/v1/host/openwop-app/public/:orgId/*` routes incl. the prerender/blog/feed/
sitemap lanes, `getPublishedBySlug` → `resolveSharedRefs` → `localizePage` →
`projectPublic`, `routes/contentDelivery.ts`, and `features/cms/surface.ts` —
and for each ask only: *can a write change what a visitor receives without
moving `page.version`?*

| Candidate (state a PUBLISHED page's public delivery reads live) | Server-resolved at delivery? | Writer + scope | Gated? |
|---|---|---|---|
| **Shared sections** (`section.ref` → `resolveSharedRefs`) | YES — `cmsService.ts:1752` | `PATCH …/shared-sections/:id`, `workspace:write` | ✅ D1 |
| **Per-page SEO** (title/description/canonical/og/`noindex`) | YES — `publishingService.ts:221` | `PUT …/pages/:id/seo`, `workspace:write` | ✅ C1 (both arms) |
| **`localePublishState`** | YES — `localizePage` | `POST …/locales/:l/publish`, `host:members:manage` | ✅ C1 — withhold arm open by design |
| **Org `supportedLocales`** | YES — `publishingService.ts:219`, `prerenderService.ts:280` (hreflang) | `PUT …/language-settings`, `host:members:manage` | ✅ **NEW, §C7 — widening only, CMS PAGES only.** The same settings row is read by `entities/publicRead.ts:43-50`, so a widening also newly serves unreviewed ENTITY overlays on the anonymous entity path; the scan walks `listPages` only, and the entities lane has no CMS-page authority to gate against (review F5, adjacent to `CMSA-12`) |
| **Experiment variant → which `PageVersion` live traffic gets** | YES — `publishingService.ts:191-214` | create/patch `workspace:write`; **start** `host:members:manage` | ⚠️ **NEW, §C7 — PARTIAL.** The `origin` stamp refuses a positively-unreviewed snapshot at create and at start. Page STATUS is deliberately not gated (no-exit), an UNKNOWN origin is allowed (§C8/F2), and a RUNNING experiment survives the gate being turned on — delivery re-reads nothing (`CMSA-15`, review F6) |
| **Entity rows behind `entityList` / `entityDetail`** | **YES — crawler HTML *and* `schema.org` ItemList JSON-LD** (`prerenderService.ts:257-265` → `entities/publicRead.ts:130-186`, emitted `sectionHtml.ts:229-241`, `prerenderService.ts:301-305`) | `POST/PATCH/DELETE …/entities/types/:name/entities[/:id]`, **`workspace:write`** — and in the tenant the SECTION names (`publicRead.ts:131` reads `data.tenantId`; `ContentResolveContext.pageTenantId` is documented "informational") | ❌ **NEW MEMBER → `CMSA-12` (Blocker)** |
| **`User.displayName`** → blog byline + `<dc:creator>` in the anonymous RSS feed | YES — `publishingService.ts:321-330`, emitted `:429`, `:554` | `PATCH /users/me` — **any active signed-in user, NO scope** (`users/routes.ts:112-123`) | ❌ **NEW MEMBER → `CMSA-13` (Improvement)** |
| **Org `name`** → `og:site_name` + JSON-LD `Organization`/`WebSite`/breadcrumb root | YES — `prerenderService.ts:243-251`, used `:112,:190-191,:209` | `PATCH /orgs/:orgId`, `host:org:manage` | ❌ **NEW MEMBER → `CMSA-14` (Improvement)** |
| **`baseLocale`** | YES (same reads) | same route | n/a — **NOT a member.** It relabels which locale base `data` answers to rather than releasing an overlay; the one way it could surface one (a page holding an overlay keyed at the NEW base) is already a 409 (ADR 0592 §9) |
| **Redirects** | Only on a MISS — `cmsService.ts:1748` finds the direct published hit and `:1752` returns before `:1753` reads `redirects` | **No write route exists.** The only `redirects.put` is `updatePage`'s slug-rename branch (`:929-941`), which bumps `version` | n/a — **NOT a member, verdict re-confirmed a second time and strengthened: there is no independent writer to gate** |
| **Media bytes** (`imageToken`, `ogImageToken`) | NO — the payload carries a URL, never bytes | Substitution is **structurally impossible**: tokens are minted `randomBytes(32)` (`inMemorySurfaces.ts:1808`), there is no `put(token, bytes)` and no replace-file route; `updateAsset` cannot touch `serveToken`/`storageRef`/`contentType` | n/a — **NOT a member, verdict upgraded from "cannot change" to "no rebind path exists".** `DELETE` remains destructive-only (fail-safe, like `unpublish`) |
| **Asset metadata** (`altText`, `renditions`) | NO — never read by any delivery lane; the page carries its own `alt`/`caption` | `PATCH …/assets/:id`, `workspace:write` | n/a |
| **`productGrid`, `form`, `pricing`, `comparison`, `faq`, `quotes`, `columns`** | **NO** — every one carries ids/config only and the FRONTEND resolves it in a separate anonymous call (`SectionRenderer.tsx:339-347,355-368,382-397`). `comparison`/`faq`/`quotes` are fully `page.sections`-resident | — | n/a — **NOT members.** `entityList`/`entityDetail` are the ONLY section types the backend resolves |
| **Consent record / `consent` toggle / policy default** | YES — decides whether the experiment lane engages at all (`publishingService.ts:196`) | consent routes + toggle admin | n/a — it widens the AUDIENCE for content that is itself gated, not the content |
| **Prerender / published-list memos** | Serve stale for up to `OPENWOP_SEO_PRERENDER_TTL_S` (**default 3600 s**) | Not writer-keyed | `CMSA-D5` — **a live-edit refusal is not retroactive**, and the two caches disagree on key hygiene |

**Running that method found THREE more members — so the count is now six, and
the two this batch fixed were not the last.** They are filed rather than fixed,
each with a stated reason:

- **`CMSA-12` (Blocker) — `entityList` / `entityDetail`.** The class table's
  "NOT a member" verdicts for the reference section types were derived from the
  JSON lane, which really does carry ids only. The **prerender lane does not**:
  `prerenderService.ts:257-265` resolves those two section types SERVER-SIDE
  into the anonymous crawler HTML and into a `schema.org` ItemList. So a
  `workspace:write` actor changes an approved, published, gated page's
  crawler-facing content by editing an entity row, inbox empty, `page.version`
  unmoved — `CMSA-1`'s shape at `CMSA-1`'s privilege tier, i.e. **below** the
  two this batch fixed. Worse, the resolver reads the tenant the SECTION names
  (`publicRead.ts:131`), and `ContentResolveContext.pageTenantId` is documented
  "informational", so the referenced rows need not even be the page's tenant.
  NOT fixed here because the cure is a cross-feature authority question — gating
  entity writes on the state of CMS pages that happen to list them would refuse
  a CRM record edit because a marketing page shows it, which is a product ruling
  and a blast radius this two-row batch has no mandate for.
- **`CMSA-13` (Improvement) — `User.displayName`** reaches the anonymous blog
  byline and the RSS `<dc:creator>` from `PATCH /users/me`, which **any active
  signed-in user can call with no scope at all**. It is XML-escaped and bounded,
  and a byline showing the author's current name is arguably correct behaviour —
  which is exactly why it needs a ruling rather than a reflex gate.
- **`CMSA-14` (Improvement) — org `name`** becomes `og:site_name` and the
  JSON-LD `Organization`/`WebSite` at `host:org:manage`, ungated.
- **`CMSA-D5` (Debt) — the refusal is not retroactive.** Neither public memo is
  invalidated on write, so already-rendered crawler HTML keeps serving for up to
  `OPENWOP_SEO_PRERENDER_TTL_S` (**default 3600 s**) after a gate refusal or an
  `unpublish`. The two memos also disagree on key hygiene — `publishingService.ts:288`
  joins with `\u0000` *and documents why*, while `prerenderService.ts:346` uses
  `\n`. Not exploitable today (`orgId` and the slug regex admit no newline), so
  it is recorded as drift from a stated invariant, not as a live hole.

That the *first* systematic pass over the delivery graph tripled the member count
is the finding. Three rounds of enumeration-by-category produced three wrong
verdicts; one round of enumeration-by-call-graph produced three new members and
re-confirmed every negative with a stronger reason than the one it replaced
(redirects: not "returns the direct hit first" but "**has no write route at
all**"; media: not "`updateAsset` cannot change the token" but "**no
`put(token, bytes)` exists anywhere**").

#### Prescription 1, falsified: reuse the `baseLocale` offender scan

C6 said the cure "reuses machinery this route already has: the `baseLocale`-change
branch two blocks up already walks every page and shared section holding an
overlay at a given locale." Built literally, that is wrong twice.

- That scan is keyed on the **new base locale** and asks a different question —
  *does an overlay exist* — while the gate must ask *would this write make an
  overlay DELIVERABLE*. Those differ exactly on `localePublishState`: a locale
  explicitly held in `'draft'` has an overlay and is not deliverable, so the
  prescribed scan would have refused a widening that releases nothing. That is
  the gate-with-no-exit shape, applied to the one lane an operator must be able
  to use to configure localization at all.
- It walks pages **and shared sections as two independent lists**, which answers
  "which rows hold an overlay" but not "which PAGES would change for a reader".
  Delivery resolves a `ref` into the shared row's `localizations`
  (`resolveSharedRefs`), so the shared row matters only *through* the pages that
  reference it — and the refusal has to name those pages, not the shared row.

What landed instead: for each **added** locale, walk pages once; a page is a
candidate when it holds an overlay at that locale **in its own sections or
through a shared ref** AND its own `localePublishState` does not already withhold
it; then the shared rule decides which candidates are protected. The fan-out
itself became a fourth shared owner — `blockingLiveEditPages` in
`contentApproval.ts` — because the shared-section lane had hand-written the same
loop, and *three hand-written copies of one predicate* is this feature's own
root cause (C1). **Widening only**: removing a locale takes content off the page,
the same fail-safe direction as `unpublish` and locale-withholding.

A `baseLocale` change is deliberately **not** in the scan: it relabels which
locale the base `data` answers to rather than releasing an overlay, and the only
way it could surface one — a page holding an overlay keyed at the NEW base — is
already refused by the ADR 0592 §9 guard.

#### Prescription 2, falsified twice: the experiment lane

`CMSA-11` was filed with two alternative cures. **Both are defects.**

- *"`refuseLiveEdit` on start when the page is `published`/`in_review`"* — page
  experiments only run on published pages (`getPublishedBySlug` is the delivery
  path), so this disables the entire feature for every gated org. C1's lesson at
  the member level.
- *"restrict variant `versionId` to versions with a `publishedBy` stamp"* — a
  **no-op**. `publishedBy` is the capturing actor and **every** row has one,
  submit-captured rows included; its own doc comment says it "reads as
  capturedBy". A fix built to this prescription would have shipped a test over
  unchanged behaviour, which is `CMSA-7`'s shape repeating.

What landed: a new optional `PageVersion.origin: 'publish' | 'submit'`, checked
at variant CREATE **and** again at START (the `CMSA-4` lesson — a decision taken
from a toggle read in an earlier request is not a decision; START is the moment
content reaches traffic), scoped to the gate (with the gate OFF the same admin
can publish the content outright in one click, so refusing the binding buys
nothing and only removes a legitimate "test the old content" workflow), and NOT
gated on the page's own status.

**The stamp is PROMOTED on publish, and that is the load-bearing half.**
`transitionPage` never bumps `page.version`, so an approve lands on exactly the
row SUBMIT captured and `snapshotPage`'s distinct-content dedupe returns early.
A capture-time-only stamp therefore marks the canonical *published* snapshot
`'submit'` — the gate would refuse the one version it must allow, on every gated
org. This was found by the witness, not by reading: the "binds the APPROVED
snapshot" control failed first, and deleting the promotion turns **all six**
cases in `test/cms-experiment-snapshot-gate.test.ts` red.

An **unknown** origin (a row written before the field existed) is REFUSED rather
than waved through — absence makes no claim, and a guard that cannot identify
its subject must refuse (`CMSA-7`). The residual is bounded and stated: history
is capped at 50 rows per page so unstamped rows age out, and the exit is the
right one — publish that version through the gate and its stamp is promoted.

#### What C6's own lesson still under-stated

C6 said to enumerate over the delivery function's inputs. Doing that surfaced a
sharper rule: **the delivery function's inputs include the inputs of everything
it CALLS.** `supportedLocales` is not an input to `getPublishedBySlug`; it is an
input to `localizePage`, which delivery calls. The shared-section overlays are
not an input to `localizePage`; they arrive through `resolveSharedRefs`, which
delivery calls first. Both misses in this batch — the member C6 found and the
shared-ref half of the fix C6 prescribed — are one level of indirection below
where the enumeration was being run. Enumerate the **transitive** read set, or
the next reader will find a fifth member.

**Status of this ADR is unchanged.** D1–D4 stand as decided and implemented; C7
records the follow-on batch that closed C6's two rows.

### C8 (adversarial review of the §C7 batch, 2026-08-21) — the fix reproduced the family it closes, twice, and neither witness caught it

The §C7 batch shipped a green suite with ten sabotage probes. An adversarial
review of the diff then found **two Blockers**, both inside the fix. Recorded in
full because the shape is the one this feature keeps producing.

**F1 — the widening scan was an EXACT-tag test, and delivery is not exact.**
`resolveSection` resolves `exact → language-FAMILY → base` (RFC 0103 §C,
`host/i18n/resolveSection.ts`), and `negotiateLocale` matches by family too. So
a dormant overlay keyed `pt` IS served to a visitor negotiated onto `pt-BR`, and
`held.has(l)` waved that through: **adding `pt-BR` published every dormant `pt`
overlay** — the CMSA-10 statement verbatim, reproduced inside the gate written
to close it, at the same tier, in the same request. Two clicks in the settings
UI ("remove `pt`, add `pt-BR`"), and the auto-translate sweep writes bare-language
overlays. The scan now closes `held` under the same fallback chain, in the same
direction delivery uses (an added region tag also matches its family; the reverse
never happens, because negotiating `pt` cannot reach a `pt-BR` overlay).

The lesson is sharper than "we missed a case". §C7 closed by saying *enumerate
the TRANSITIVE read set*. This was one level below even that: not another store,
but the **resolution ALGORITHM** applied to a store already in the set. A gate
that reproduces its own delivery function's inputs but not its delivery
function's MATCHING RULE is a gate over a different question.

**F2 — the CMSA-11 unknown-origin refusal was a gate with no exit, and the exit
it named did not work.** §C7 defended refusing an unstamped pre-field row on the
CMSA-7 rule ("a guard that cannot identify its subject must refuse"). Building
the exit falsified that: CMSA-7's refusal **repins the row in the same call**, so
it refuses once and can then succeed. This one cannot. Making a historic snapshot
bindable means publishing it; publishing it means `restoreVersion`; and
`restoreVersion` BUMPS `page.version`, so the publish mints a NEW row and the
bound `versionId` keeps its unstamped row forever. Worse, `updateExperiment`
refuses a non-`draft` experiment, so a STOPPED one could not be repointed — and
on the deploy that adds the field EVERY row is unstamped, so every gated org's
stopped experiment would have become unrestartable with `deleteExperiment`
(which discards the salt and orphans its analytics) as the only escape. The
guard now refuses only a positively-identified `'submit'` origin; the residual
is stated, bounded by the 50-row history cap, and transitional, which a
permanent dead end for a working feature is not.

**A precedent does not transfer without its mechanism.** Both §C7 and the batch
before it invoked CMSA-7 by name. CMSA-7's rule is sound *because it ships with a
self-heal*; quoted without one it becomes a licence to strand people.

**F3 — the CMSA-10 refusal's only exit was "unpublish the site".** The safe way
to add a locale is to withhold it per page first and release each page through
the already-gated publish route. That was impossible: `setLocalePublishState`
required the locale to be configured in BOTH directions, so you could not
withhold `pt-BR` before adding it and could not add it because it was not
withheld. A perfect circle whose only remaining exit was unpublishing every live
page holding an overlay — on a mature localized site, the whole site, offline, to
change one setting. The withhold direction is now open for any valid non-base
tag (it REMOVES content from delivery, the same fail-safe direction the whole
widening/narrowing split turns on); the release direction stays
configured-locales-only and gated. The 409 names this cheap remedy first.

This also means an existing test was re-pinned rather than silently changed:
`cms-locale-governance.test.ts` asserted `fr` → 400 under the heading "Unknown
locale", but `fr` is a valid tag that is merely unconfigured. The assertion is
inverted with the reasoning kept in-test, and the arms that must still 400
(malformed tag, base locale, and the RELEASE direction) are pinned beside it.

**F4 — the "one owner" fan-out resolved the toggle once per candidate PAGE.**
`blockingLiveEditPages` called `refuseLiveEdit` in a loop, and `refuseLiveEdit`
reads the toggle; `MAX.perOrgPages` is 2000. Beyond the cost, a flip mid-loop
produced a partially gated verdict — the CMSA-4 shape reduced from per-request to
per-ROW, inside the helper introduced to stop exactly that kind of drift. The
rule is now split into its page-independent half (`liveEditGateActive`) and its
page half (`isGatedLiveEditState`), with `refuseLiveEdit` composing them, so the
fan-out reads the toggle ONCE and the single-page callers are unchanged.

**Smaller, also landed.** An EMPTY overlay (`localizations.es = {}`, storable
because the presence check is a key count) resolves to base and now cannot block
a widening. The `void pageId` leftover is gone. `snapshotPage`'s promotion
branch records why it rewrites only `origin` and leaves `publishedBy` naming the
submitter.

**Filed, not fixed — `CMSA-15`.** A RUNNING experiment survives the gate being
turned on: delivery (`publishingService.ts:195-208`) re-reads no gate, so content
bound while the gate was OFF keeps reaching visitors afterwards. §C7's claim that
"START is the moment content reaches live traffic" is therefore **wrong, and is
corrected here** — start is the last moment we CHECK, which is not the same
thing. This is the memory-file's "a gate on the CREATION lane is not a gate on
the USE lane" shape; the cure is either a per-request gate read on an anonymous
hot path or a stop-running-experiments side effect on toggle flip, and both are
larger than this batch.

**Method note.** Ten sabotage probes did not find F1–F4, and could not have:
sabotage proves an assertion is load-bearing, it cannot invent the assertion that
was never written. Every one of these came from reading the diff against the code
it calls. Sabotage and adversarial review are not substitutes.

### C9 (second adversarial review of the §C7/§C8 batch, 2026-08-21) — the scans were reading the wrong sections all along

§C8 recorded two Blockers found inside the §C7 fix. A second, independent review
of the corrected branch found **two more**, and the first of them is the ROOT
CAUSE beneath both `CMSA-1` and `CMSA-10` — present since D1 shipped, and missed
by every pass including the two that were explicitly looking for missed members.

**F1 (Blocker) — every page-set scan read `page.sections`, and delivery does not
always serve `page.sections`.** `publicPageBySlug` (ADR 0236 D1) substitutes a
bound variant's snapshot for a visitor on a non-holdout arm —
`{...hit.page, title: version.snapshot.title, sections: version.snapshot.sections}`
— and BOTH `resolveSharedRefs` and `localizePage` then run over the SNAPSHOT. A
section dropped from the live page but surviving inside a bound snapshot was
therefore invisible to `listPagesUsingSharedSection`, to the §C2 widening scan,
to `deleteSharedSection`'s 409 guard, and to the ADR 0592 §9 baseLocale scan —
and was still delivered. Proven twice, anonymously, with the gate ON: a
`workspace:write` PATCH rewrote a live approved page's CTA to an attacker URL
with the inbox empty and `page.version` unmoved (`CMSA-1` verbatim, through the
gate written to close it), and a `PUT …/language-settings` released a snapshot's
`pt-BR` overlay to the public.

Cured with ONE shared `deliverableSectionsForPage(page)` — live sections ∪ every
section of every snapshot bound to a **running** experiment — now used by all
four scans. RUNNING only, because a draft or stopped arm serves nobody and
including it would refuse edits no reader can observe (the F2 mistake).

**This is the third level of the same instruction, and the sequence is the
finding.** §C7: the delivery function's inputs include the inputs of everything
it CALLS. §C8: *and its matching rule*. §C9: *and its substitution rule* — what
delivery serves need not be what the page currently holds. Three passes, three
levels, each found only after the previous one was written down as the lesson.
The honest generalisation is that "enumerate the inputs" is not a finite
instruction until you have named the function that consumes them, and this
feature has now been wrong about that function three times.

**F2 (Moderate) — the §C8 family cure re-introduced the over-refusal §C7 had
rejected Prescription 1 for.** Extending `held` to the family key while still
testing deliverability of the *added* tag refused two changes that release
nothing: a family locale ALREADY in `supportedLocales` (a `pt-BR` visitor
already negotiated to `pt` — delivery is byte-identical before and after), and a
family locale WITHHELD on the page (`localizePage` strips it before resolution,
so the reader still gets base). The predicate is now a genuine BEFORE/AFTER diff
over the same algorithm delivery runs. Two things fall out: the
widening/narrowing split needs no special case (a narrowing's `after` is a
subset of its `before`, so the diff is empty by construction), and the refusal
reports the MATCHED overlay keys — so it no longer names a locale that holds no
content while prescribing a remedy for it (F2b), which was the same class as the
"withdraw them from review" verb §C2 deleted.

**A sabotage probe then found what the review had not.** Modelling the withheld
set from every `localePublishState` key instead of from the scenario's
`supportedLocales` left all assertions green — and that is the UNDER-refusal
direction: `localizePage` derives `withheld` from `supportedLocales`, so a
`draft` marker on an UNCONFIGURED locale strips nothing. Since §C8 opened the
withhold direction to unconfigured tags, an operator can now easily create that
state and believe they are protected. Witnessed explicitly.

**Why the family cure is complete, and the constraint that makes it so.**
`LOCALE_RE` admits only `xx` and `xx-YY`, and it validates both
`supportedLocales` and every overlay key — so `zh-Hant-TW` is unrepresentable
and there is exactly ONE family hop to close. The cure is correct *because of* a
constraint this ADR never named, which makes it fragile to a future tag-format
widening. Recorded so that widening `LOCALE_RE` is known to require revisiting
this scan.

**F3 (Low) — a FOURTH hand-written composition of "is the gate in force", added
by the very PR that hoisted the one owner.** `assertVariantSnapshotReviewed`
called `isApprovalGateOn` directly rather than `liveEditGateActive`, making it
the only gate in the feature that did not exempt the reserved system site —
whose rationale (no members, no approvers, no route to one) applies unchanged.
Fail-safe, and still C1's own root cause recurring inside C1's own fix.

**F4 (Nit)** — `blockingLiveEditPages` hoisted the toggle read ABOVE the pure
status filter, adding a durable read to the all-drafts case where the loop it
replaced did none. Cheap-and-certain now precedes costly-and-remote.

**`CMSA-13` is CONFIRMED LIVE, and it is a DOUBLE-PREFIX bug.** The anonymous
blog feed emitted the raw internal principal in `<dc:creator>`. Root cause:
`userRef` is a naive `` `user:${id}` `` while `User.userId` is already
`user:<32-hex>`, so callers build `user:user:<hex>`; `fallbackName` stripped one
prefix and returned the other. `subjectDisplay.ts`'s header promises "raw refs
must never render as UI" and the seam upholds it — the CALLER broke it, and the
byline consequently never showed the author's real name either (a functional bug
hiding inside a security one). Note the trap: **the double prefix is
accidentally LOAD-BEARING**, because the users resolver is keyed on the full
`user:<hex>` userId, which is exactly what the single strip yields. "Stop
double-prefixing" would have broken name resolution everywhere. Fixed at the
seam (strip every kind prefix) plus removing the caller's `?? id`, which had
silently revoked the seam's guarantee on the one surface anyone on the internet
reads. Same class as the DSAR scoped-vs-raw subject-key defects.

**`CMSA-12`'s cross-tenant half needed no product ruling, and landed.**
`ContentResolveContext.pageTenantId` was threaded in by the prerenderer and
never read, while both resolvers took the tenant from editor-controlled
`data.tenantId`. The refusal is at the WRITE as well as the read, because the
SPA lane reads `data.tenantId` straight from the section and never passes
through the resolver — a read-only cure would have made the crawler see less
than a human, the exact cloaking mismatch the resolver's own comment exists to
avoid. The ADR 0408 kernel field-validator path has no page context and is
unchanged; that exemption is stated because unstated ones are how the last three
of these were missed. The row's remaining half (the `workspace:write` write-gate
question) stays filed, and its "data leak" framing is SOFTENED: `readPublicEntities`
gates `published + publicRead`, so this was a cross-tenant embed of already-public
rows, not an exfiltration.

**A REFUTED claim from §C8, corrected.** §C8 said the unknown-`origin` residual
is "bounded by the 50-row history cap … so unstamped rows age out". The cap
applies only inside `snapshotPage`'s CREATE branch, so a page that is never
snapshotted again keeps its unstamped rows **indefinitely**. The honest wording
is: bounded in COUNT, unbounded in TIME, and nothing closes it. The one-line
closure, named here so it is not rediscovered: stamp `origin:'publish'` on each
published page's version row where `version === page.version`. Not run in this
batch — a data migration is not a defect fix — but it is now a named task rather
than an assumed self-heal.

**Two stated costs of the §C8 withhold-then-add remedy.** On an `in_review` page
the withhold bumps `page.version` (`CMSA-8`) and therefore invalidates the
pending approval's pin, so the reviewer must re-read. And the withhold direction
now admits any valid non-base tag into `localePublishState`, i.e. ~457k
uncapped keys — bounded per page by editor effort, not by code.

**Method note, and the reviewer proved it twice.** This review ran NO sabotage
probes, because F1 is an assertion nobody had written and sabotaging existing
assertions cannot surface those. The complement also held: the withheld-set
modelling defect above was found ONLY by sabotage, and no reviewer flagged it.
Neither technique subsumes the other — derive what SHOULD be asserted from the
mechanism, then sabotage what you wrote.

**Filed, not fixed — `CMSA-16`.** Because `deliverableSectionsForPage` counts
only RUNNING experiments, STARTING one enlarges the deliverable set: a shared
section edited while referenced solely by a not-yet-running snapshot becomes live
without ever passing the gate. A start-time refusal is NOT built here, and the
reason is this ADR's most-repeated lesson: shared sections have no review lane
(that is Deferred item (B)), so a refusal at start would have no exit and would
be the shape §C8/F2 had just been corrected for. The exposure window closes the
moment the experiment is running, and the row records the ordering that opens it.

## Deferred (each a claim, stated honestly)

- **(B) shared sections as first-class reviewable content** — a second editorial
  lifecycle (new approval kind, staged copy, apply-on-approve). A product ruling,
  not a defect fix. (A) does not foreclose it.
- **`CMSAWF-5`** deterministic-id + CAS approval creation, **`CMSLWF-6`**
  cross-instance CAS witness, **`CMSLWF-7`** sweep-daemon wiring — host approval
  infrastructure, graded and owned elsewhere.
- **`CMSAU-6`** approver-side notification parity and **`CMSAU-10`** submitter
  withdraw — both add new dispatch/verb surface area; scoped out of a defect
  batch.
- **`CMSAU-16`** full localization of every backend English explanation on this
  flow — the code-driven arms this ADR adds cover the load-bearing ones
  (`stale_review`, `review_closed`, the gate 409s); the remainder is a
  localization program.

## Implementation record

| Decision | What landed | Witness |
|---|---|---|
| **D1** shared-section gate | `assertSharedSectionEditable` at the ONE composition owner (`features/cms/routes.ts`); refusal names the blocking pages; system-site exempt | `test/cms-gate-bypasses.test.ts` — 2 born-red positive arms + 2 negative controls (draft-only references; gate OFF, which also proves the ref really reaches delivery) |
| **D1** class enumeration | Per-page SEO metadata gated the same way (`features/publishing/publishingService.ts` `putSeo`) — a NEW member of the class, in no tracker | `test/cms-approval-hardening.test.ts` — ungated positive control, then the refusal, then the stored value unchanged |
| **D2** row lifecycle | Producer cascades (`deletePage`, `restoreVersion`, gate-OFF promote) + the decide-arm terminal backstop with authorless closure | `test/cms-approval-gate.test.ts` — 3 cases incl. a GOVERNANCE_DECISION entry COUNT across repeat attempts; sabotage-verified |
| **D3** pin precondition | `transitionPage(..., { expectedVersion })`, threaded on the approve arm; the 409 carries `phase:'transition'` | `test/cms-approval-hardening.test.ts` — deterministic (spied handler read; real store/route/transition), spy-call asserted, sabotage-verified |
| **D3** failure honesty | `ApprovalApiError` + `approvalErrorInfo`; `Submit again` on `in_review` | `src/notifications/__tests__/contentReviewCard.test.tsx` — the raw-string regression is asserted ABSENT, the conservative unmapped arm is pinned |
| **D4** reviewer + submitter | `ContentReviewContext` / `ContentReviewDecideBar` on both surfaces; `aiDraftedLocales`; `GET …/pages/:id/review` | 12 FE cases + 2 backend cases |

### Witness-contradicted prescriptions (recorded per the batch discipline)

1. **`CMSA-7`'s prescribed cure was a no-op as written.** "Add the pinning test +
   a repin-on-decide or lazy backfill" — but repin-and-proceed is behaviourally
   identical to today's silent fall-through: the reviewer still decides content
   they were never told the identity of. The guard now REFUSES once
   (`reason: 'unpinned_review'`) *and* pins in the same call, so the refusal has
   its own exit. Recorded because the prescription, followed literally, would
   have shipped a test over unchanged behaviour.
2. **The `CMSA-3` TOCTOU witness was VACUOUS in its first form.** A 409 + a still
   pending row is produced by BOTH the pre-CAS staleness read and the new
   transition precondition, so the test passed whether or not the fix existed.
   Fixed by stamping `phase: 'transition'` on the new error and asserting the
   spy actually intercepted — the assertion that the harness is not inert.
3. **One test PINNED THE DEFECT.** `cms-approval-gate.test.ts`'s "a failed
   transition (page deleted mid-approval) re-opens the approval" asserted the
   unclearable-card behaviour as if it were the guarantee. It was correct
   per-decide and wrong per-class; rewritten, with the reasoning kept in-test.

---

## DECISION NOTE (appended) — `CMSA-12`'s write-gate half is CLOSED as "governed elsewhere" → **ADR 0594**

*Appended, not rewritten: the reasoning trail above is the point, and nothing in
it is retracted. This records the disposition of the one class member that was
deliberately left open.*

`CMSA-12` was filed as a member of this ADR's class and its **cross-tenant half
was fixed here** (§C9). Its **write-gate half** — a `workspace:write` entity edit
rewriting an approved published page's crawler HTML with no approval row and no
`page.version` movement — was routed to `/architect` as a cross-feature authority
question rather than a defect fix. **That ruling is now ADR 0594.**

**The ruling: it is a BOUNDARY, not a hole.** The approval gate's closed world is
the *page*. An `entityList`/`entityDetail` section is not page content — it is a
pointer into a second store that carries its own publication gate
(`status: published` + `publicRead` + `!neverPublic`). Approving the page
approves the **pointer**; publication of the **rows** stays with the entities
feature. ADR 0594 D1 requires the approval card to SAY so, deriving a
`liveReferenceSections` disclosure exactly as `aiDraftedLocales` is derived — and
**over `deliverableSectionsForPage`, for this ADR's own §C9 F1 reason**: a
live-reference section dropped from the live page but surviving in a bound
running-variant snapshot still reaches readers, and a disclosure derived from
`page.sections` would report *none*.

**Three things the code contradicted in the row's framing**, recorded because
this class has now had multiple verdicts falsified by reading the code:

1. **The stated objection to the naive cure is structurally impossible.**
   "Gating entity writes would refuse a CRM edit" — CRM/service-desk types are
   minted `neverPublic: true` and `gatePublicType` refuses them at the one
   anonymous funnel (`publicRead.ts:66`), so a CRM record can never reach one of
   these sections. The at-risk population is only types an **admin** designated
   public. The naive cure fails for a *different and stronger* reason: an
   `entityList` stores a **query**, not a row id, so "which pages reference this
   row" is not computable by any index — and with `limit`+sort, creating an
   *unrelated* row changes what a page shows.
2. **Gating at the projection would be VACUOUS.** `GET …/public-entities/:tenantId/…`
   (`entities/routes.ts:572, 605`) is an independent anonymous lane with no page
   context, and the SPA renders these sections from it client-side
   (`SectionRenderer.tsx:398-435`). A resolver-side gate holds the crawler only —
   §C9's "the crawler would see less than a human" inversion, compounded into a
   gate that does not gate. And because `resolveContentSection` swallows failures
   into chrome (`contentDataSources.ts:73-77`), a firing gate would be
   indistinguishable from a resolver bug.
3. **A fourth consumer of the shared read exists** —
   `kicktodo-community/communityService.ts:331` calls `readPublicEntity`. Any
   predicate pushed into `readPublicEntities`/`readPublicEntity` to close the
   bypass would silently change that feature too.

**Follow-up filed — `CMSA-D6` (stale comment, this ADR's own §C9 fix).**
`host/contentDataSources.ts:38-45` still documents `ContentResolveContext.pageTenantId`
as *"best-effort … the entities resolver relies on the public-read gate instead,
so this is informational."* §C9 falsified that when it made both resolvers
enforce the field (`publicRead.ts:147-150`). The contract comment now understates
its own guarantee — the past-tense-claim-outlives-the-code shape, inside the fix
that closed it.
