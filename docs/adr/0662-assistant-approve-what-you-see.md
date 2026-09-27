# ADR 0662 — Assistant: approve what you see

Status: implemented (2026-09-11, feature loop it.14 — P1..P4 shipped). D1/D2/D4/D5 were substantially corrected pre-implementation after `/architect`; see the inline correction notes.
Date: 2026-09-11
Feature: Assistant capability + Chief of Staff (FEATURES.md ordinal 14 of 71; ADR 0023 §Correction, ADR 0027 §4, ADR 0031) · feature loop 2026-09 it.14
Plan input: `/grade-*` recon 2026-09-11, ids `COSX-1..4` (prefix verified unused — `AST2-`, one S, is taken by 16 ids and 6 source files)
Related: ADR 0473 (`expectedDefinitionHash` — approve-what-you-see, server-enforced end to end), ADR 0660 (the previous iteration, where the ADR's own headline was falsified pre-implementation)

## Context

This feature exists to put a human between an agent and an irreversible act. Its approval
loop is carefully built: a CAS makes execution exactly-once, `isAutoAllowEligible`
(`assistantService.ts:937`) encodes "untrusted-derived or high-risk ALWAYS surfaces to a
human" in ONE place so it cannot drift, and `editPendingAction` refuses to touch a row that
is no longer `pending`. The machinery is sound.

**What is missing is the link between what the human saw and what runs.**

### `COSX-1` — the approval card cannot show the action (Blocker)

`projectActionCard` (`actionApproval.ts:186-192`) allowlists the card's `payload` to `{to}`
and nothing else. `executeApprovedAction` (`actionExecution.ts:297`) dispatches
`payload: action.payload` — the **whole** payload — into the run, where
`packs/feature.assistant.nodes/index.mjs:585` uses `payload.subject` as the email Subject
and `:592` uses `payload.event` as the **entire** calendar event body (summary, time,
attendees, location). `ApprovalsInbox.tsx:68` renders only `to`.

So a human approving a `calendar.invite` is shown the invitee list and nothing else. They
are accountable for content that was never displayed to them.

**This is a control that backfired, not carelessness — say so.** The allowlist's own comment
states its purpose: "so a future action kind that stuffs sensitive data into `payload` can
never leak it onto the approval row by default — additive opt-in, not pass-through." It
protects the approval ROW from the payload. But the payload is precisely what the approver
must see. **A privacy control became an accountability hole.** The cure is therefore not to
delete the allowlist; it is to make it per-kind and *required*, so that the set of fields
the card shows and the set the executor consumes cannot drift apart.

### `COSX-2` — nothing binds the approved bytes to the executed bytes (Blocker)

`PATCH /pending-actions/:id` (`routes.ts:312`) accepts a new `payload` with no
`expectedVersion` / `If-Match`, and `editPendingAction` (`assistantService.ts:909-927`)
last-write-wins. Two consequences, of different severity — state both honestly:

1. **The ordinary case (likely, no concurrency needed).** An approver loads a card, someone
   edits the action, the approver clicks approve. The edited payload executes. `editedAt`
   exists and the route comment says the card "surfaces `editedAt` so the approver knows they
   approve an edit" — but that only informs an approver who *re-reads the card after* the
   edit. It is an advisory timestamp, not a binding.
2. **The narrow race.** `decideApproval` CASes the *approval* row, then re-reads the *action*
   row and executes it (`actionApproval.ts:167-171`). `editPendingAction`'s
   `status !== 'pending'` guard is a real defence, but it reads the ACTION row, so an edit
   landing between the approval CAS and the execution re-read is not excluded by it.

ADR 0473 solved exactly this for composed workflows: the approver's view is hashed, the hash
is re-verified at dispatch, and a mismatch refuses. That precedent applies verbatim.

### `COSX-3` — both ingest loops can die silently and permanently (Blocker)

`core.openwop.http/index.mjs:355-366` returns `status:'success'` on 4xx/5xx, and `:414-427`
on a pure network failure. `ingestCommitments` never reads `i.status`, so an expired Google
token yields `items: []` → `success, created: 0` → `recordJobRun` stamps a green tick,
forever. The send lane already has the cure (`confirm-action-send`) — the "a defect closed on
one lane survives on its sibling" shape, now in the **fifth consecutive feature** of this loop.

**Scope note:** the success-on-error behaviour is in a CORE pack used far beyond this feature.
Changing that pack is a large blast radius; the assistant-side cure (read `i.status` and fail
the ingest typed) is the right scope for this ADR, with the pack-level question recorded.

### `COSX-4` — a leftover predicate, NOT a missing gate (corrected)

> **My first framing was premise-wrong and the review corrected it.** I wrote that "the
> replacement gate is inert". There is no replacement *gate*, because the capability was
> never a permission. ADR 0023 §Correction (`0023:10-22`) states its runtime contract:
> the runtime "resolves the acting/writing agent by this capability — never by `roleKey`",
> and ADR 0031:67-76 calls `capabilities` the **activation surface**. That mechanism IS
> wired and load-bearing — `findAssistantAgent` / `listCapabilityAgents`
> (`capability.ts:50-68`), consumed at `actionApproval.ts:75` and `loops.ts:181`.

What actually exists is a leftover convenience predicate, `agentHasAssistantCapability`
(`capability.ts:116`), with zero callers. It reads like a gate and is not one, which is the
hazard: the next reader trusts it.

## Decision

### D1 — no payload byte reaches a provider that the card did not render (`COSX-1`)

> **Two Blockers in this decision's first draft, both found before code.**
> **(a) The quantifier excluded the worst case.** It said "every kind in
> `EXEC_WORKFLOW_BY_KIND`", and that map is typed
> `Exclude<PendingActionKind,'nudge'|'servicedesk.reply'>` (`actionExecution.ts:117`).
> `servicedesk.reply` appends an **outbound customer-facing message** to a ticket thread
> and reads `payload.ticketId` (`:229-231`) — the card shows `to` only, so the approver
> cannot see which ticket or which customer. The test would have been green on the one kind
> it most needed to fail on.
> **(b) A leaf-field allowlist is impossible for two of five kinds.**
> `calendar.invite` sends `payload.event` **verbatim** as the Google Calendar POST body and
> `calendar.reschedule` sends `payload.patch` verbatim as the PATCH body
> (`packs/feature.assistant.nodes/index.mjs:592,600`). The "field list" is one field, and
> rendering it IS rendering the whole payload — the alternative this ADR rejects.

`CARD_FIELDS` is typed **`Record<PendingActionKind, …>`** — every member, so a new kind is a
**compile** error, not merely a test failure. Each entry is
`{ field, mode: 'scalar' | 'passthrough' }`. A `passthrough` arm renders the whole object
through the redaction seam `actionApproval.ts:30-31` already imports (`sanitizeFreeText`,
`stripSecretsFromPersisted`), so the privacy property is kept where it can be and is
honestly abandoned where it cannot.

**The enforced invariant is behavioural, not structural:** *no payload byte reaches the
provider that the card did not render.* A structural "field ∈ CARD_FIELDS" assertion cannot
be derived statically anyway — the kind→node route is pack DATA, the node is untyped `.mjs`
loaded from `~/.openwop-packs`, and the chains are builder-editable. So the test is
**inverted and behavioural**: the node pack exports `PAYLOAD_FIELDS_BY_KIND` and the test
asserts `CARD_FIELDS ≡` it, PLUS a sentinel leg — per kind, feed `prepareActionRequest` a
payload with poisoned keys and assert no sentinel appears in `outputs.body`. The passthrough
arms go red first.

### D2 — bind the approval to the bytes (`COSX-2`)

> **The first draft copied half of ADR 0473 — and dropped the half that makes the refusal
> safe.** 0473 §(d) (`0473:195-200`) puts the definitive check **after** the CAS and pairs a
> mismatch with **`reopenApproval` + 409**. "Refused 409 and nothing executes" is not
> implementable safely at either placement: *before* the CAS is 0473's own F2/F3 check→lock
> window; *after* it leaves the approval consumed and
> `decidePendingAction(...,'approved')` already written (`actionApproval.ts:160-163`) with
> nothing executed and nothing reporting failure — precisely the lying state this ADR exists
> to close.

`projectActionCard` includes `contentHash = sha256(canonicalize({draft, payload}))` over what
it just projected, using **`host/auditChainService.canonicalize`** — the same function
`host/definitionHash.ts:13-17` hashes with for ADR 0473. No second canonicaliser (four
already exist in this repo). Its semantics answer the open questions: recursive key sort,
arrays ordered, `undefined` ≡ absent.

`POST …/approve` **requires** `expectedContentHash`. The check sits in
`decideActionViaApproval` **after** the CAS and **before** `executeApprovedAction`; a
mismatch runs a **two-sided compensation** — `reopenApproval(approvalId)` (`approvalService.ts:2256`)
*plus* restoring the action row to `pending` — then 409s with the current hash.
**That restore does not exist yet:** `decidePendingAction`'s status union
(`assistantService.ts:962`) has no `'pending'` member, so a `reopenPendingAction` verb (or a
widened union) is **in this decision's scope, not a follow-up**. `editPendingAction` takes the
same guard so two editors cannot silently overwrite each other.

**No compatibility window.** The first draft proposed "optional for one release", and this
repo has no mechanism to force such a window closed: host-extension routes are
non-normative, nothing advertises them, and there is no third-party client of
`/v1/host/openwop-app/*`. An optional guard is an unguarded guard. The SPA and the route
change together. (ADR 0473's `expectedDefinitionHash ?? pin` fallback does **not** transfer —
a `PendingAction` has no propose-time pin, so a missing hash would mean *unguarded*.)

**Stated consequence:** the hash covers the **projected** card, so a deploy that changes
`CARD_FIELDS` invalidates every in-flight card. That is correct — the approver's view changed
— and it is a release note, not a bug.

### D3 — an ingest that fetched nothing because it failed says so (`COSX-3`)

`ingestCommitments` (`index.mjs:523-533`, which today reads `body = 'body' in i ? i.body : i`
and never `i.status`) reads `i.status`; a non-success ingest is a typed failure that
`recordJobRun` records as failed, with the provider error surfaced. A green tick means "we
looked and there was nothing", never "we could not look".

**Corrections to this decision's own first draft, from the review:**
- **No core-pack change is needed, so do not hedge about blast radius.** The http node does
  not swallow — it *returns* `status` (`:355-366`) and `status:0 + networkError`
  (`:414-427`), and the `fetch → ingest` edge passes the whole outputs object. The
  assistant-side fix is sufficient.
- The in-repo copy target is **`confirmActionSend` in the same file**, not "the send lane".
- The "sibling loop" claim was wrong: `drive-ingest` uses the **same node** (so it is fixed
  for free) and `morning-briefing` makes no HTTP call.
- **The run half is not the whole fix.** `listLoopStatuses` (`loops.ts:134-150`) projects
  `lastRunAt`/`lastRunId` with **no `lastRunStatus`**, so a failed run still renders
  "last run: <time>". D3 adds that field, or it closes the run and leaves the panel green.

### D4 — delete the leftover predicate (`COSX-4`, REWRITTEN)

> **The first draft said "wire it as a gate, on the read lane as well as the write lane".
> That was wrong twice.** Per ADR 0023 §Correction the capability's contract is agent
> RESOLUTION, not permission — and that mechanism is already wired. And wiring a gate as
> described would be **breaking**: the read lane's caller is a *human*
> (`routes.ts` `wrapRead` / `tenantOf(req)`), so there is no `rosterId` to test; the tool
> lane already has its documented ADR 0458 parity gate (`hasAssistantWriteAuthority`,
> `agentTools.ts:16-24`) with reads deliberately failing **empty**; and it would revoke
> reads for exactly the white-label tenants `capability.ts:90-107` (COS-15) documents as
> having no seedable agent.

**Delete `agentHasAssistantCapability` (`capability.ts:116-119`).** Zero callers; the
capability's real contract is served by `findAssistantAgent` / `listCapabilityAgents`
(`:50-68`). A predicate that reads like a gate and is not one is worse than no predicate.

### D5 — the stale rows, corrected (and two of MY corrections were themselves wrong)

- **`COS-4` and `COS-7` were swapped in the first draft.** The five `listForTenantIndexed`
  scans are **COS-7** (`CODEBASE-ASSESSMENT.md:6021-6032`) ⇒ complete. **COS-4**
  (`:5916-5925`) is index-exclusive reads with no `.list()` fallback plus an unconditional
  boot backfill; it is *also* closeable — the backfill is now marker-gated
  (`assistantService.ts:374-379`) and the absent fallback was argued deliberately
  (`:498-509`) — but **not by the evidence the first draft cited**. Fix the citation, not
  just the verdict.
- **`AST-UX-3` is stale at TWO sites**, `UX-ASSESSMENT.md:51` and `:3047`; `:3132` already
  records it closed (#3570, 2026-08-31).
- **The erasure claim was FALSE as reasoned.** `index.mjs:525-531` stamps
  `owner:{kind:'self'}` on a commitment derived from the **principal's own** calendar/Drive,
  which **confirms** `erasure.ts:232`'s exemption rather than falsifying it.

### D6 — the real erasure gap the wrong claim was sitting next to (`COSX-5`, new)

Third-party PII on ingested commitments lives in `description`
(`Prepare for "<event title>"`, `index.mjs:520-522`) plus `source.url` / `externalId`. Leg 2
of the eraser (`erasure.ts:355-357`) reaches a commitment only via `subjectCommitmentIds`,
built from `personMatches(c.owner, …)` (`:303`). So **a DSAR from a third party named in an
ingested event title erases nothing while `eraseSubject` reports success** — the
success-over-a-no-op shape, on the erasure lane. Its own id, because it is not fixed by
touching `personMatches`.

### `/architect` review record (2026-09-11, before code)

Four Blockers, eight SHOULD/NITs — the **fifth consecutive iteration** where the Blockers
lived in the decision text rather than the diff, and the **second consecutive** where one of
my own findings was premise-wrong.

1. **D1's quantifier excluded the worst case** — `EXEC_WORKFLOW_BY_KIND` is typed to exclude
   `servicedesk.reply`, the kind that posts a customer-facing message, so the drift test
   would have been green exactly where it mattered.
2. **D1's leaf-field allowlist is impossible for two of five kinds** — `calendar.invite` and
   `calendar.reschedule` pass their payload verbatim to the provider, so the "field list" is
   one field and rendering it IS rendering everything.
3. **D2 copied half of ADR 0473** — the load-bearing half is the two-sided reopen, and the
   action-row half of it does not exist yet (`decidePendingAction` has no `'pending'`).
   Without it, a mismatch leaves the approval consumed, the row marked approved, nothing
   executed and nothing reporting failure.
4. **D4 was wrong and breaking** — `COSX-4`'s premise was mine and it was false: the
   capability is agent RESOLUTION (ADR 0023 §Correction) and IS wired; the predicate is a
   leftover. Wiring a gate would have revoked reads for white-label tenants with no seedable
   agent.

Also folded: the canonicaliser already exists and is the one ADR 0473 hashes with; the
"optional for one release" window has no forcing mechanism in this repo and is dropped; the
approval renderer is in **core** and already duplicated across two inboxes; D3 needs no
core-pack change but does need `lastRunStatus` or the panel stays green; and my COS-4/COS-7
citations were swapped while the erasure claim was false as reasoned — with a **real**
adjacent gap (`COSX-5`) sitting next to it.

**What survived attack:** `COSX-1` and `COSX-2` are real and correctly diagnosed, and framing
the allowlist as a backfired control rather than carelessness is the right reading.

## Alternatives weighed

- **Render the whole payload on the card.** Rejected: it re-opens exactly what the allowlist
  was built to prevent, and a future kind could put a secret in `payload`.
- **Freeze the payload at approval time (snapshot and execute the snapshot).** Tempting and
  simpler than a hash, but it silently executes something the row no longer shows, which is
  the same class of lie from the other direction. The hash refuses instead of guessing.
- **Fix `core.openwop.http` to fail on 4xx/5xx.** Correct in principle; out of scope here.
  Every caller across the repo currently depends on the present behaviour, so that is its own
  ADR with its own blast-radius measurement.

**RFC gate:** **NON-NORMATIVE — no OpenWOP RFC.** Everything here is host-extension
(`/v1/host/openwop-app/*`). RFC 0051 governs *in-run* approval gates; a grep of
`../openwop/RFCS` and `spec/` finds no normative "approve what you see" or content-hash
language, so this host is free to define it.

## Open questions

1. D2: is `conflict` 409 right, or should a hash mismatch re-render the card with a diff?
   (Leaning 409 plus the current hash — the SPA can then show a diff without the server
   inventing a presentation.)
2. ~~Does any other surface render pending actions?~~ **ANSWERED: yes, and it already
   duplicates.** The renderer is `frontend/react/src/notifications/ApprovalsInbox.tsx:68` —
   **core**, not `features/assistant/`, shared across approval kinds — and
   `NeedsYouInbox.tsx:49` carries a copy-pasted `destinationOf`. Both fold onto ONE shared
   helper in P1, or the drift D1 closes server-side reopens client-side.
3. ~~Is the intended gate per-profile or per-tenant?~~ **ANSWERED by ADR 0023 §Correction:
   the capability is agent RESOLUTION, not a gate.** D4 is now a deletion.

## Phased plan

| Phase | Scope | Closes |
|---|---|---|
| P1 | D1 + the drift test | `COSX-1` |
| P2 | D2 | `COSX-2` |
| P3 | D3 | `COSX-3` |
| P4 | D4 + D5 + D6 | `COSX-4`, `COSX-5`, the stale rows |

## Implementation record (2026-09-11)

| Decision | Landed in | Witness (sabotage-proven) |
|---|---|---|
| D1 per-kind `CARD_FIELDS`, `Record<PendingActionKind,…>`, `scalar \| passthrough` | `actionApproval.ts` (`cardFieldsFor`, `projectActionCard`) | `assistant-approve-what-you-see.test.ts` — 4 legs incl. a SENTINEL that runs the real node and asserts nothing withheld reaches the request body. Sabotage: restore the `{to}`-only allowlist ⇒ 3 red; mislabel a passthrough ⇒ 1 red |
| D2 `contentHash` + post-CAS check + **two-sided** reopen | `actionApproval.ts` (`contentHashOf`), `assistantService.ts` (`reopenPendingAction`), `routes.ts` (required param) | `assistant-action-approval.test.ts` — stale hash ⇒ 409 AND both rows back to `pending`; absent hash ⇒ 400; current hash accepted. Sabotage: reopen one side only ⇒ red with `expected 'approved' to be 'pending'` — the lying state itself |
| D3 ingest reads `i.status`; `lastRunStatus` on the panel | `packs/feature.assistant.nodes/index.mjs`, `loops.ts` | covered by the assistant suites; no core-pack change needed (the node RETURNS the status) |
| D4 delete the leftover predicate | `capability.ts` | `assistant-capability.test.ts` now asserts the REAL contract (profile capability + resolution) instead of a function with no production caller |
| D6 (`COSX-5`) erasure reaches free-text email mentions | `erasure.ts` (`mentionsSubject`) | `assistant-erasure.test.ts` — a self-owned commitment naming the subject is erased; a bystander row is not; **the name-only residual is asserted** so a future change is deliberate. Sabotage: drop the match ⇒ red |

**Gate:** backend 15458 passed, frontend 5319 passed; one frontend contention flake
(`adr0654D10`, a known one) green alone at 15/15. An earlier run was correctly stopped by
`gen-steward-manifest --check` — a pack edit needs its version, its pin and the manifest to
move together, plus the line-pinned arg-parity fixture, which was RECOMPUTED (+19) rather
than hand-edited.

**Not shipped:** `WF-COS-5/-7/-9..-12`, `COS-10`, `COS-12`, `AST-UX-4..-22`, and the
`core.openwop.http` success-on-error behaviour itself (its own ADR, its own blast radius).
