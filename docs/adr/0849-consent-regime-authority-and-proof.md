# ADR 0849 — Consent: the tenant-wide regime is an admin act, and a subject's consent can be proven

Status: implemented (2026-10-07; Accepted after the pre-code `/architect` pass, then corrected by `/grade-code` + `/grade-ux` — see the correction notes; feature loop round 2 row 31, branch `feat/fl2-31-consent`)

Builds on ADR 0020 (consent feature), ADR 0227 (per-channel specifics), ADR 0302 (purpose
vocabulary), ADR 0394 (WhatsApp strict opt-in), ADR 0586 + ADR 0657 (the erasure lane, the
tombstone, re-admit, and the `host:members:manage` DSAR authority, D6), ADR 0832 / 0837 (the
surface org floor and its tenant-level twin), and ADR 0848 D4 (admin-tier settings on
`host:members:manage`).

## Context

Round 1 closed consent at WF/UX/CODE **A− / B− / B**. Its notes say "legal exposure; UX/CODE
held at B". This pass re-measured the feature on `origin/main` @ `b634adc76`. Each claim was
read at the cited line before it was written down.

Consent is **tenant-scoped by design** (`routes.ts:5-6`: "a visitor's choices apply across the
tenant's orgs"). The policy, the purpose vocabulary, the strict flag and every consent record
are keyed by `tenantId`. Every authed route is addressed through `/consent/orgs/:orgId`, so
authority is decided per org while the effect is tenant-wide.

1. **Any editor of any org can change the consent regime for the whole tenant.**
   `PUT …/policy` checks `workspace:write` in the addressed org (`routes.ts:223-232`) and
   writes the tenant's single `consent:policy` row. With `defaultMode: 'opt-out'`, every
   subject who has no record becomes marketable on email, SMS and push, in every org of the
   tenant (`consentService.ts:796`). That is a lawful-basis decision for the whole workspace.
   The purpose-vocabulary writes and the strict-purpose flag (`routes.ts:305-329`) have the
   same shape. In a personal workspace the owner is the only member, so this only matters in a
   shared `ws:` workspace. That is exactly where it matters.
2. **Any viewer of any org can read every consent record in the tenant.**
   `GET …/records` (`routes.ts:234-237`, `workspace:read`) returns `listConsent(tenantId)`. Each
   row carries the raw subject key: a CRM contact id, a user id, an email address, or (since
   ADR 0394) an E.164 phone number, plus region, purposes and source. `GET …/subjects/:key`
   (`routes.ts:239-242`) is a per-person oracle on the same `workspace:read` lane, and is not
   toggle-gated. Erasure of that same person needs `host:members:manage` (ADR 0657 D6). So the
   lane that reads personal data is two tiers below the lane that deletes it.
3. **A workflow run can record consent on anyone's behalf, which no HTTP door allows.**
   `ctx.features.consent.record` (`surface.ts:99-104`) merges categories into any subject key.
   It takes no `orgId`, so the ADR 0832 floor never fires, and the surface declares no
   `tenantMethodScopes`. No authed HTTP route writes a consent record for an arbitrary
   subject: the public capture writes only its own `visitor:` identity space. A person-started
   run can therefore grant `marketing.whatsapp: true` (ADR 0394's explicit-opt-in channel) or
   `marketing: true` to any contact, and the record says only `source: 'workflow'`. That fails
   the ADR 0832 rule: a run may not do what its starter could not do over HTTP.
4. **A consent record cannot prove itself.** Art. 7(1) GDPR: "the controller shall be able to
   demonstrate that the data subject has consented". The record is latest-wins
   (`mergeConsentCategories` overwrites `ts`, `source` and `categories`). The only trail is the
   tenant audit chain, which stores a **hash** of the subject and is read only as the whole
   chain (`auditChainService.ts:261`, one point read per entry, and every public capture
   appends one). An operator asked "when did this person opt in to SMS, and from where?" can
   answer only "this is the current state". Separately, a subject lookup for an **erased**
   person returns `record: null`, the same answer as "never recorded". The operator cannot
   see that the erasure, the most important fact on that subject, happened.
5. **A consent read error takes a published page down.** `publishingService.ts:208` calls
   `isAllowed` inside the public page serve when a visitor key is present, with no catch. A
   consent-store read error becomes a 500 on a public page. Every other public caller of the
   gate degrades (the CNWF-6 class, ADR 0657 D5).
6. **`ConsentRecord.expiresAt` is a field with no reader and no writer**
   (`consentService.ts:77`; CNWF-15 / WF-CONS-8). A reader of the type believes consent
   expires.

The competitive input is `docs/steward/UX_UPGRADE-consent.md` (OneTrust, Salesforce RTBF
vendors, round 1; the round 2 market roadmap CN-R2-1..7). Two of its converged conventions fit
here:

- **Point-in-time consent proof.** Every leader keeps a per-subject consent history: when,
  what, and through which capture point. OneTrust calls these consent receipts; Osano and
  Ketch call them a consent log.
- **Privacy administration as an admin role.** OneTrust and Transcend put regime settings
  behind a privacy-admin role, not behind content editors.

The rest of that roadmap stays deferred. That covers the request register with an SLA clock,
the Art. 15 access/export lane and verified intake (see Out of scope).

## Boundaries audit

- All changes are inside `features/consent/` plus:
  - one surface policy (`feature.ts`);
  - one guarded call in `features/publishing/publishingService.ts`;
  - the SPA's `features/consent/`.
- No new feature package, toggle, store, route prefix or node-pack version. The pack's node
  contract is unchanged; only the seam's authority check changes.
- The DSAR seam (`host/subjectErasure.ts`) is untouched. The new history rides the existing
  `consent:record` row, so the ADR 0464 store census is unchanged. The record is already
  deleted by the consent eraser on every resolved key (ADR 0657 D1), and the history goes
  with it.

## Decision

### D1 — The tenant-wide consent regime is admin-tier: `host:members:manage`

The following routes keep their existing org check (toggle where it applies, plus org
membership). They then also require `requireTenantScope(req, 'host:members:manage')`, the
DSAR authority (ADR 0657 D6) and the admin-tier settings authority (ADR 0848 D4):

- `PUT …/policy`
- `POST …/purpose-vocab`, `DELETE …/purpose-vocab/:code`, `PUT …/purpose-vocab/strict`
- `GET …/records` (the tenant-wide ledger with raw subject keys)
- `GET …/subjects/:subjectKey` (and D3's history, which rides it)

`GET …/policy` and `GET …/purpose-vocab` stay at `workspace:read`. They carry no personal
data, and a member needs to see which regime governs the sends they author.
`GET …/policy` additionally returns `access: { canManage: boolean }`, computed by catching
the same scope check (the ADR 0848 M9 / ADR 0788 `holdsScope` shape). The UI then hides what
the server would refuse, without a second rule.

**Why `host:members:manage` and not a new `host:privacy:manage`.** Custom roles cannot hold
any `host:` scope (`accessControlService.ts:216-221`). Only the built-in admin and owner roles
carry them, and both carry every one. A new scope would therefore grant exactly the same
people the same access today, and would split the consent console across two names: DSAR on
one scope, policy on another. A distinct privacy-officer role becomes meaningful only when
custom roles can hold management scopes. That is a platform decision, and it can rename all
consent authority in one move then.

### D2 — A run records consent only if its person could administer consent

`consentFeature.surface` declares `orgPolicy: { tenantMethodScopes: { record: 'host:members:manage' } }`
(ADR 0837 D2). When a run has a person (its acting user, else the member who caused it), that
person must hold the scope tenant-wide.

- **Runs with no person keep working:** a public form or webhook-triggered chain, and system
  jobs. That is the legitimate capture lane: the subject's own submission arrives that way.
- **`isAllowed` stays on the default floor.** It is a yes/no read that every sending chain
  needs.

The record's `source` becomes `workflow:<runId>` when the run id is known (it stays
`workflow` otherwise), so D3's history names the run that wrote it.

### D3 — Every consent record carries its own bounded history; a lookup reports erasure

- **The history.** `ConsentRecord.history?: ConsentChange[]` holds up to the newest **25**
  prior states. Each entry is `{ ts, source, categories, region?, legalBasis?, purposes? }`.
  It is appended inside the existing write: the CAS in `mergeConsentCategories`, and the
  latest-wins put in `recordConsent`. So a change and its receipt land atomically, and a lost
  CAS retries both.
- **Why it lives on the row.** It is erased with the row, by the DSAR and by the consent
  eraser on every resolved key. So it adds no new store, no new eraser and no retention lane.
  The tenant audit chain stays the tamper-evident, hashed trail. The history is the readable
  one.
- **Why the cap is 25.** It bounds the row (a fixed-window public capture can rewrite a
  `visitor:` row repeatedly). It is far above any real person's number of consent changes.
- **Legacy rows** have no history. The UI shows them as "current state only; history is
  recorded from <deploy date>". It never shows a fabricated trail.
- **The ledger omits history.** `GET …/records` strips `history` (the ledger is a list, not a
  proof).
- **The lookup carries it, plus erasure.** `GET …/subjects/:subjectKey` returns
  `{ record, erased: boolean, erasedAt?: string }`. `erased` reads the PII-free tombstone (all
  key forms, `isErasureTombstoned`). An erased subject has `record: null, erased: true`, which
  the UI renders as "Erased on <date>" with the re-admit action, never as "no record".
- **The public read is unchanged.** `GET /public-consent/:orgId/:token` does not return
  history (the visitor reads their current choices).

### D4 — A consent read error never takes a public page down

`publishingService.ts` wraps the experiment-assignment `isAllowed` call. On a throw, it serves
the published page with no experiment exposure. That is the same page a visitor without
analytics consent gets. The service logs `consent_unreadable` with the page and org ids.

### D5 — Delete `ConsentRecord.expiresAt`

No writer sets it and no reader reads it. Honouring it is a product decision that is not made
here (see Out of scope): an expired **refusal** must never decay into the opt-out default. So
the honest move now is to stop the type from claiming it.

### D6 — The console is role-aware and shows the proof

`ConsentPage` reads `access.canManage`. When it is false:

- the policy editor and the purpose vocabulary render read-only, with a one-line notice that
  only workspace admins change the consent regime;
- the records ledger and the subject lookup are replaced by the same notice, not by a 403
  error card;
- erase and re-admit are not offered (they already 403 for non-admins).

The subject lookup:

- renders the history as a newest-first timeline (date, source, the categories that changed);
- for a legacy row, renders an honest "history recorded from" line;
- for an erased subject, renders an erased state with the date and the re-admit door.

All strings go in the lazy `features/consent/i18n` chunk, in four locales.

## The ratchet

`test/adr0849-consent-authority.test.ts`, RED on `b634adc76`:

- **Authority.** A shared workspace with an org-B **editor**: `PUT policy`, purpose-vocab
  writes, `GET records` and `GET subjects/:key` are each 403. The policy row is unchanged
  afterwards. An admin gets 200 on all of them.
- **Run floor.** A person-started run whose person is an editor calls `record`, and gets
  `forbidden_scope`. No record is written. An admin run, and a run with no person, both write.
- **History.** Three merges produce a history of length 3 in order, with the right sources.
  The cap holds at 25. The ledger strips `history`. A DSAR on the subject leaves
  `record: null, erased: true`.
- **Publishing.** A throwing `isAllowed` serves the page (200) with no experiment stamp.

Every new guard is sabotage-witnessed: remove it, and the named test goes red.

## Architect review (pre-code, 2026-10-07) — corrections to the decisions above

An adversarial `/architect` pass read every decision against the code before any of it was
implemented. It returned **3 Blockers, 5 High and 9 Medium** findings. Each is answered below.
The decision text above is left as written (except the line citations, which were re-cited
per M1), so the trail shows what changed and why. **Where a row and the text above disagree,
the row governs.**

| # | Finding | Resolution |
|---|---|---|
| B1 | D6 hides the DSAR console from every tenant in the default posture. `GET …/policy` is toggle-gated (404 with the toggle OFF, the default), so `canManage` never arrives, and the lookup/erase panel that CONS-5 keeps outside the toggle would vanish for admins too. | `canManage` comes from a new **`GET …/access`** on the un-toggle-gated `dsarAuthz` lane (org membership at `workspace:read`, then the same `requireTenantScope` predicate, caught to a boolean). `GET …/policy` does not carry it. The ratchet adds toggle-OFF legs for an admin and a non-admin. |
| B2 | D2's premise is false. Event-triggered runs (form submits included) carry `orgScopeSubject = binding.createdBy` (`hostEventDispatcher.ts:350`), so a form-capture chain armed by an editor would fail on the subject's own opt-in, silently. | **D2 checks the ACTOR lane only.** A new per-method policy facet, `actorOnlyTenantMethods`, makes `tenantScopeFloor` check `record` only when the run has an `actingUserId`: a person started it, or it runs on their schedule. The causing member of an event-fired run does not act; the event does. Stated residue: an editor can arm a binding whose chain records consent; the binding is audited, and that lane is the legitimate capture path. |
| B3 | History amplifies an unauthenticated row about 26×: `purposes` and `region` are uncapped on the public capture (1 MB body limit). | The service caps both on every write path: `purposes` ≤ 32 codes of ≤ 64 chars each, `region` ≤ 64 chars. Over the cap is a typed `validation_error` (400). A row-size witness is added. |
| H1 | History is evictable: repeated identical writes (one-click unsubscribe prefetch, preference re-posts, STOP repeats, form re-submits) would push out the original opt-in. | An entry is appended **only when the written state differs** from the newest entry (categories, region, legalBasis, purposes). The **oldest entry is pinned**: trimming drops the second-oldest, so the first recorded receipt survives. Witness: 30 identical unsubscribes leave the opt-in present. |
| H2 | D3 says "prior states", but the ratchet counts "3 merges ⇒ length 3". | **Change log.** Each entry is the state WRITTEN, newest first, so `history[0]` mirrors the current row. The UI diffs adjacent entries to show what changed. A legacy row's first post-release write starts its history at that write. |
| H3 | `recordConsent` is a blind put, so appending history there is a read-then-put race. | `recordConsent` reads the row and puts the appended history. Under contention this is lossy, exactly as the record itself is latest-wins on that path (the merge's retries-exhausted fallthrough and the demo seeder are its only callers). Documented at the function, not hidden. |
| H4 | D4 is incomplete: `campaign-connectors` public `pixels` and `conversions` also 500 on a consent read error. `findRunningExperiment` can throw in the same publishing block. | D4 covers all three. The whole experiment block degrades to "no experiment". Pixels degrade to `pixels: []` and conversions to `202 recorded:false, reason:'consent_unreadable'`, each with a log line. Context §5's "every other public caller degrades" is wrong; it is corrected by this row. |
| H5 | A wider write door is open: an anonymous form submit with an email opt-in checkbox writes `marketing:true` (the umbrella) as well as `marketing.email:true` (`formsConsentSink.ts:51-57`). The umbrella grants SMS, push and ad-audience targeting wherever no specific exists. That is a CONS-3-class grant from an email checkbox. | **New D7:** the forms sink writes only `marketing.email: true`. An email checkbox grants email. The fact that any submitter can type someone else's address is the double-opt-in question, named out of scope (industry cure: confirmation mail). |
| M1 | Route line citations were off by 17–23 lines. | Re-cited in place. |
| M2 | Rationale errors: (a) owner-only `host:` scopes exist (`host:org:manage`, `host:compensation:waive`); (b) on `ws:` tenants the tenant scope is the **root** membership only (ADR 0815 D1b), so the rejected "`workspace:write` changes nothing" alternative is overstated there. On `default`/SAML tenants, an admin of any sub-org passes tenant-wide. | (a) The rationale is corrected: the built-in admin and owner both carry `host:members:manage`. (b) The alternative is still rejected, because an editor at the root still sets the regime. Recorded as residue: outside `ws:`, "an admin of any org" administers the tenant regime, which is the same posture as today's DSAR door. The ratchet seats its admin at the root org. |
| M3 | `requireTenantScope` judges the raw principal; `requireOrgScope` judges the canonical one. An unbound OIDC bearer can pass the org check and fail D1. ADR 0848 D4 was org-scoped, not tenant-scoped. | Kept consistent with the DSAR door (the same predicate on both read and erase). Named residue. `canManage` uses the exact gate predicate. The "ADR 0848 D4 precedent" is reworded to "the same admin-tier scope". |
| M4 | There is no purpose-vocabulary UI. `access` already names `useFeatureAccess('consent')`. A non-admin's parallel `listRecords` would 403 into the failed card. | D6 drops the purpose-vocab bullet. The flag is `canManage`. The page skips `listRecords` and the lookup when `!canManage`. |
| M5 | "History recorded from <deploy date>" has no data source (a compiled date is wrong for white-label installs). | A record with no `history` field renders "current state only — earlier changes were not recorded". No date. |
| M6 | `getErasureTombstone` is not exported. A legacy pre-barrier row can coexist with a tombstone. After a re-admit, the lookup reads as never-recorded. | A new export, `getErasureStatus(tenantId, key)`, returns `{ erasedAt } \| null`. **Erased wins** in the API and the UI. Post-re-admit reads as not erased: stated, since the attested re-admit is on the audit chain. |
| M7 | Replay wording: a `record` node AFTER a fork point executes live under the forking caller's stamp and does enter the floor. | Reworded in the matrix: the served prefix reads recorded results; post-fork nodes run live under the fork's actor, which is correct. |
| M8 | The survivor's history keeps `crm-merge:<sourceKey>`. | Stated. A person-level DSAR walks `mergedInto` (`crm/erasure.ts:88-113`) and erases both rows with their histories. |
| M9 | D5 verified safe. | — |

## Feature evaluation matrix (`/feature-refinement`, 2026-10-07)

Decomposition: ONE feature, an extension of `consent`. No new toggle and no new package.

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | `features/consent/**` + one guarded call in `features/publishing/publishingService.ts`. |
| 2 | Toggle + admin UI | `consent`, unchanged (core, OFF ⇒ permissive). The DSAR lane stays un-toggle-gated (ADR 0586). |
| 3 | Workflow surface | `ctx.features.consent` keeps both methods; D2 declares `record` on the tenant floor. |
| 4 | Node pack | `feature.consent.nodes` 1.2.1, unchanged (no node contract change). |
| 5 | AI chat + envelopes | None. Consent is a policy gate, not an AI surface (`feature.ts:5`). Unchanged. |
| 6 | Agent pack | None (unchanged, deliberate). |
| 7 | Public surface | Unchanged. `/public-consent` neither gains history nor loses anything. |
| 8 | RBAC + isolation | D1 + D2. Fail-closed: a caller who cannot be resolved gets 401/403 as today; a personal-workspace owner passes the `requireTenantScope` personal short-circuit. |
| 9 | Replay / fork | `record` is a served side-effect node (ADR 0657 D3): the replayed prefix reads recorded results and does not re-enter the floor. A `record` node after the fork point runs live under the fork's acting user and new run id, and does meet the floor (correct). |
| 10 | Frontend | `ConsentPage` role-aware + history timeline + erased state; four locales. |

## Alternatives weighed

- **`requireTenantScope(req, 'workspace:write')` for the policy.** Rejected: the tenant scope
  is the union across the caller's memberships, so an editor of any org still passes. It
  changes nothing.
- **A new `host:privacy:manage` scope.** Rejected for now (D1): it grants the same people
  today and splits the console's authority across two names.
- **History from the audit chain** (filter `consent.change` by subject hash). Rejected: it is a
  full-chain scan of point reads per lookup, and the chain grows with every public capture. It
  also stores only a hash, so the operator would have to know the key's hash to search, and
  there is no index to build on.
- **A separate `consent:history` store.** Rejected: a new store needs its own eraser, retention
  class and teardown entry. It also writes outside the record's CAS, so a change and its
  receipt could diverge.
- **Honour `expiresAt`** (D5). Deferred: see Out of scope.

## User-visible behaviour changes (product decisions for the user)

1. **In a shared workspace, only admins and owners can change the consent policy, the purpose
   vocabulary or the strict-purpose flag.** Editors see them read-only.
2. **Only admins and owners can see the consent records list and look up a person's consent.**
   Viewers and editors see a notice instead. A personal workspace's owner is unaffected.
3. **A workflow run that a non-admin started (or that runs on a non-admin's schedule) can no
   longer record consent** (`feature.consent.nodes.record`). It fails with `forbidden_scope`.
   Event-fired runs (a form submit, a webhook) are unaffected, whoever armed the trigger
   (architect B2).
4. **A subject lookup now shows the consent history** (newest 25 changes, recorded from this
   release on) and shows **"Erased on <date>"** for an erased person, instead of "no record".
5. **A published page with a running experiment no longer errors when the consent store is
   unreadable.** It serves the page without the experiment.
6. **(D7, architect H5) An email opt-in checkbox on a form now grants email marketing only.**
   It used to also set the `marketing` umbrella, which made the person reachable by SMS, push
   and ad audiences wherever they had no channel-specific choice.
7. **(architect B3) Consent writes refuse more than 32 purpose codes, a code over 64
   characters, or a region over 64 characters** (400).

## Out of scope (named, with the reason)

- **CN-R2-1 — DSAR request register with an SLA clock** (Art. 12(3) one month; CCPA 45 days).
  It needs a store whose rows hold the subject key while the case is open, plus a retention
  rule for closed cases. That is its own ADR.
- **WF-CONS-12 — Art. 15 access/export lane.** It needs a reader registry symmetric to the
  eraser registry across every feature store. That is ADR-scale.
- **WF-CONS-5 — a DSAR as a stack card.**
- **CNWF-15 — honouring consent expiry.** It needs a decision on what expires (grants only;
  never a refusal) and a re-ask flow.
- **Ledger pagination.** `listConsent` is a bounded per-tenant prefix read, but it is
  unpaginated. That is a performance residue at scale, not a correctness one.
- **Carried, unchanged:** CNWF-9, CNWF-12, CNWF-13a, CNWF-14, CNWF-16, CNWF-17.

## Phased plan

| Phase | Scope | Witness |
|---|---|---|
| P1 | D1 routes + `access.canManage`; D2 surface policy + attributed source | `adr0849-consent-authority.test.ts` (authority + run-floor legs) |
| P2 | D3 history + erased lookup; D5 | same file (history legs) |
| P3 | D4 publishing guard | same file (publishing leg) |
| P4 | D6 UI + i18n | `ConsentAuthorityAndProof.test.tsx` |

## Open questions

1. Does any shipped chain call `feature.consent.nodes.record` from a person-started run?
   Measured: **zero chain consumers of the pack** (`git grep feature.consent.nodes -- packs
   examples` → none, WF-CONS-11). So D2 breaks no shipped chain.
2. Prod reach: how many tenants have a non-default policy, or more than one org? The answer
   decides how many real editors lose the policy write. Asked of the orchestrator; the result
   goes in `scratchpad/row31-prod-counts.md`.

## RFC verdict

No RFC. Every change is host-internal: route scopes on `/v1/host/openwop-app/*`, a
host-extension surface policy, an additive field on a host-extension store, and one guarded
call. Nothing on the OpenWOP wire changes.

## Correction notes (implementation, 2026-10-07 — `/grade-code` + `/grade-ux`)

`/grade-code` returned **1 Blocker** (opening grade B−) and `/grade-ux` returned **2 Blockers**
(opening C+). Each finding was fixed or named below. The rows above stay as written, so the
trail shows what changed.

| # | Finding | Resolution |
|---|---|---|
| CN2CD-1 (**Blocker**) | **The B2 resolution was wrong.** `actorOnlyTenantMethods` exempted every run without an `actingUserId`, not only event-fired runs. Kanban Run (`kanbanWorkItemDelivery.ts:25`), a canvas invoke of an editor's run (`canvasSurface.ts:792`) and a composed-workflow approval (`workflowComposeTool.ts:736`) are all cause-lane only, so an editor could record consent by pressing Run on a kanban card. | **The facet is deleted** (`featureSurfaces.ts` is back to `origin/main`). `record` is checked on the run's person, actor else cause, like every other floor. A trigger that records consent must be armed by an admin. Zero chains consume the pack (WF-CONS-11), so no shipped capture lane breaks, and the forms opt-in rides the submission-sink seam, not a chain. Witnessed: editor-caused refused, admin-caused and person-less writes. **User-visible change 3 now reads: a run started OR caused by a non-admin is refused.** |
| CN2CD-2 | A legacy row's first post-release write overwrote its own `ts` and `source` and fabricated a "first recorded" receipt. | `withHistory` seeds the log with the legacy row's state, marked `legacy: true`. The UI labels it "State before history was kept". |
| CN2CD-3 | D7 fixes forward only. Rows the sink wrote before this release still carry `marketing: true`. | **Named residue, not fixed:** repairing it is a prod data change (find `form-optin:*` rows with the umbrella and no channel specific, and rewrite them through the merge), which needs the user's approval. Raised as a product decision in the PR. |
| CN2CD-4 / CN2UX-5 | The bound's dropped stretch was invisible, so the UI diffed across it. | The record carries `historyDropped`. The UI shows "N earlier changes were not kept" before the pinned origin and never diffs across it (the entry above shows its full state). The log collapses to the newest 5 behind an `aria-expanded` "Show all". |
| CN2CD-5 | `requireTenantScope` judged one identity spelling. | Every admin-tier consent door (the regime, the ledger, the lookup, `…/access`, and the erase + re-admit doors) uses `callerHoldsTenantScope` (ADR 0775 D1): both spellings, and `owk_` narrowing. That is one predicate for the whole console. This retires residue M3. |
| CN2CD-6 | Read amplification: `isAllowed` deserialises the history. | Accepted and stated: at most 25 entries, each bounded by B3 (about 2 KB). Measure before splitting the row. |
| CN2CD-7 / -13 | The publishing catch logged `consent_unreadable` for any failure, with `err.message` (which can embed a row key). | Renamed `page_experiment_degraded`. Both new log lines carry `err.name` only. |
| CN2CD-8 | The merge fallthrough re-sent stored purposes into the new bounds, so a revocation under contention could 400. | The bounds apply to the caller's payload only (they are skipped when `purposesAsserted`). |
| CN2CD-9 | A public capture's source was the bare `public`. | It is now `public:<orgId>`. |
| CN2CD-11 | The UI's category list was hand-written. | It is derived from the keys the entries carry. |
| CN2UX-1 (**Blocker**) | A member's disabled empty regions field showed its placeholder ("EU, CA") as if configured. | A member reads the policy as a `<dl>` ("None declared"), never as disabled inputs. |
| CN2UX-2 (**Blocker**) | After a re-admit, the page still said "Erased … until re-admitted", with a second Re-admit button. | The lookup for that key is re-read (silently; the Notice is the voice), and the receipt withdraws its Re-admit offer for that subject. |
| CN2UX-3/-4 | The history diffed stored literals. An absent channel follows the umbrella, so the labels were wrong. Region, basis and purposes were hidden. | The diff compares EFFECTIVE grants (WhatsApp strict). Region, basis and purposes are shown per entry when they changed. |
| CN2UX-6/-7 | "N changes" counted the first state. Raw machine sources were shown under "Captured via". | The title counts entries. A source kind is named in words ("Via form opt-in"), with the id as `<code>`. |
| CN2UX-8/-10 | Controls flashed before the access answer, and a 403 read as a failure. | Controls are disabled or skeleton while access is loading; the state is reset only on an org change. Any 403 from an admin-tier door switches the page to the member view. |
| CN2UX-9 | A member saw three "admins only" lines. | One page-level notice. The member gets no data-subject card and no ledger card. |
| CN2UX-11/-12 | A lookup failure was announced twice, success never. Enter did nothing. | The toast is dropped (the StateCard announces). A success is announced. The lookup is a `<form>`. |
| CN2UX-13/-14/-15 | es/pt-BR gender agreement; pt-BR used two verbs for erase; `lookupNoRecord` was ambiguous. | "Granted: {{category}}" shape; pt-BR "Excluir"; `lookupNoRecord` rewritten in all four locales. |
| CN2UX-16/-17/-19/-21 | No list labelling, overflow, a stale comment, a dead effect. | `aria-labelledby` + `<time>`; `u-break-anywhere`; comment corrected; effect deleted. |
| CN2UX-18/-20 | `InlineState kind="empty"` for permissions; "(s)" pseudo-plurals in the receipt. | -18 is moot (those lines are gone). **-20 open** (pre-existing receipt copy, out of this ADR's diff). |

### Re-verify pass (same day) — what the graders' second read added

Both graders re-read the fixes. `/grade-code` closed CN2CD-1/-2/-4/-5/-7/-8/-9/-10/-11/-13
with no new Blocker or High: **A−**. `/grade-ux` closed 19 of 21 with no new Blocker: **B+**,
then the items below took it to its stated A− bar.

| # | Finding | Resolution |
|---|---|---|
| code N2 | `callerHoldsTenantScope` admits a NON-wildcard env API key as tenant owner (`credentialAuthority → tenantOwnerScopes`), which `requireTenantScope` refused. | Stated, not changed: an env key IS the tenant's own principal (ADR 0601 C4), and the other admin-tier doors that use this predicate already admit it. |
| code N1 | The erase-door comment said "ONE authority" while `users/routes.ts` still judges the same scope with `requireTenantScope`. | Comment corrected. The users door's predicate is a users-feature change: residue **CN2WF-9**. |
| UX G1 | An unused import was an eslint error in the frontend lint lane. | Removed. |
| UX N1 | After a re-admit from the erased-lookup panel, focus fell to `<body>`. | The outcome Notice takes focus (`tabIndex=-1`). Witnessed: focus is never `<body>`. |
| UX N2 | An entry with no effective flip, or one that only REMOVED region/basis/purposes, read as just a date and a source. | Removals render ("Region cleared"…). A no-effect entry says "No change in effect". |
| UX N3 | With the regime OFF, the member notice promised a read-only policy that is not shown. | A regime-off variant of the member notice. |
| UX N4/N5/N6/N7 | "Consent banner" overclaimed the public route; `whatsapp:keyword:` repeated "keyword"; es register was mixed; `refusedAsMember` was not memoised. | "Public consent capture"; the `keyword:` prefix is stripped; es `usted`; `useCallback`. |
| UX CN2UX-20 | "(s)" pseudo-plurals in the pre-existing receipt copy. | **Open**, Nice-to-have, outside this diff. |
| orchestrator | "An anon workspace owner can still manage their own policy." | **MEASURED: they never could.** Every authed consent route starts with `requireOrgScope`, whose `resolveCallerUser` answers an anonymous session `sign_in_required` (401), even in the anon's OWN workspace, and that is unchanged from `origin/main`. ADR 0849 adds no door in front of it: `…/access` answers exactly as the untouched policy GET (witnessed). Opening `/consent` to anon demo owners is a change to the shared org seam (the ADR 0839 question). Residue **CN2WF-8**, raised to the orchestrator. A personal signed-in owner's full console is witnessed. |

## Implementation record

| Phase | Commit (subject) | Witness |
|---|---|---|
| P1–P3 | `fix(consent): regime + ledger admin-tier, actor-lane run floor, consent history, public lanes degrade (ADR 0849 D1-D5, D7)` | `test/adr0849-consent-authority.test.ts`, `test/cms-page-experiments.test.ts` (D4), `test/forms-email-consent-sink.test.ts` (D7) |
| P4 | `feat(consent): role-aware console, consent history timeline, erased lookup state (ADR 0849 D6)` | `ConsentAuthorityAndProof.test.tsx`, `ConsentReadmit.test.tsx` |
| Corrections | `fix(consent): grade-code + grade-ux closures — …` + `test(consent): witness the history gap …` | same files; every guard sabotage-witnessed (removing it reds its named test) |
