# ADR 0648 — Forms: the intake chain's writer is replay-served, and a public submit cannot resurrect an erased subject

Status: implemented
Renumbered: 0646 → 0648 at merge (2026-09-10) — a peer's `0646-content-negotiation-on-shared-names.md` merged first; merge order, not creation order, decides. Every citation on this branch was swept in the same commit.
Date: 2026-09-10
Feature: Forms (ADR 0017 capture-before-effect; ADR 0247 intake chain) · FEATURES.md ordinal 8 of 71
Extends ADR 0247 · Composes ADR 0464 (subject erasure), ADR 0572 (served-set ratchet), ADR 0587 §7 (`role:"action"` is not read), ADR 0645 D3 (the CSM instance of D1)
Source: `/grade-workflows` re-grade 2026-09-10 (`WORKFLOWS-ASSESSMENT.md`, `FRMWF-1..16`)

## Context

The forms-intake chain is the cleanest orchestration in the loop so far: one effect node,
every inbound edge to it conditioned on a single three-valued discriminator, a typed
failure for the manual-run case, a reachable declared output, and a witness layer with
zero mocks that drives the real executor end to end. Both Blockers are one seam outside
that lane, and both are rules this repo already enforces elsewhere.

### The boundaries audit

- The chain's only durable writer is **not a Forms node**. `feature.priority-matrix.nodes.submit-idea`
  belongs to the priority-matrix pack; Forms composes it. D1 therefore edits that pack,
  not `feature.forms.nodes` (whose three nodes are reads and are correctly `action`).
- Suppression is owned by `crm/suppressionService.ts` (`isSuppressed(tenantId, email)`,
  `:112`). D2 **composes** that predicate on the create path; it does not restate it.
- RFC verdict: host-extension, **NO RFC**. Nothing on the wire changes.

## Decision

### D1 — classify the writer honestly; make the ratchet see it; witness replay (`FRMWF-1`, `FRMWF-3`, `WF-FORM-7`)

`submit-idea` creates a durable idea card and declares `role:"action"`, `capabilities:[]`.
It is in neither the side-effect floor nor the fast-path served set. **MEASURED:** nothing
in the executor compares `role` to `"action"` (`sideEffects.ts:219-223` says so verbatim);
`replayServed` is never set for it; a replay-mode `:fork` re-executes it, and `submitIdea`
mints a fresh random card id — a **duplicate card** with the same `sourceSubmissionId`.

The prior assessment wrote that every effectful node here was `action` "so a replay-mode
fork reads the record rather than re-filing." That was false at this commit, and it
narrowed `WF-FORM-7` to branch mode. The tell is inside the same pack: `update-intake`
declares `["side-effectful"]` and IS classified — the node that *edits* a card was
protected while the node that *creates* one was not. This is `CSMWF-3` one feature over.

`submit-idea` gains `role:"side-effect"` + `capabilities:["side-effectful"]`, pack
1.3.0 → 1.4.0. **The ripple was checked before deciding:** the node reaches no host AI
capability, so it is *served*, not held back — floor and served each rise by one and
**undischarged stays flat**, which is what the ADR 0572 ratchet constrains.

It is also added to `EFFECT_TYPEIDS` so the derived gate ratchet can see this chain's
effect. Today the `WF-FORM-8` tripwire ("if a gate is ever added…") is enforced by
nothing: add a gate and the ratchet finds zero governed effects and stays green while
`file` writes on a rejection. The `CSMWF-5` fix was applied for CSM and not generalized;
this is the next instance.

A `forms-node-replay.test.ts` lands beside its six siblings, with the byte-identical
double-expansion leg.

### D2 — the CRM sink refuses to re-create a suppressed or erased subject (`FRMWF-2`)

`createContact` consults neither suppression nor erasure. A comment three hundred lines
below it says `crm:suppression` is "retained ON PURPOSE (the address is the key)" — i.e.
the store survives a DSAR precisely so this check can be made — and nothing on the create
path reads it. So: erase a subject through the ADR 0464 fan-out, and any anonymous public
submit with that email and `createToContact` on writes a fresh contact row. The eraser
anonymizes the *submission*; the sink re-creates the *contact*. It is the one place in the
lane where an unauthenticated actor can undo erasure.

The Forms CRM sink calls `isSuppressed` before `createContact` and, when true, returns
`{ error: 'suppressed' }` — a marker, not a throw, because sink failures are deliberately
swallowed (capture-before-effect, ADR 0017) and the submission itself must still land.
**The check sits in the sink, not in `createContact`,** because the authenticated CRM
create route is a different trust boundary: an operator re-adding a contact by hand is
allowed to; an anonymous form is not.

### D2 — CORRECTED the same day (`FRMCD-1`, Blocker; `FRMCD-2`)

**The first cut of D2 closed half of its own title.** It called `isSuppressed` and the
section above says "suppressed or erased." MEASURED after the `/grade-code` pass: **no
erasure path writes a suppression row** — `addSuppression`'s only callers are the CRM
admin route, the preference centre, engagement unsubscribes and bounce webhooks, and the
DSAR fan-out merely *redacts* an existing row (`crm/erasure.ts:278-288`, `continue` when
absent). So the modal case D2 describes — a respondent who became a contact and then filed
a DSAR without ever unsubscribing — was still re-created from an anonymous write.

The predicate for that case already existed: `consent/consentService.ts:550`
`isErasureTombstoned(tenantId, subjectKey)`, a PII-free tombstone written *before* the
fan-out precisely as the "this subject was erased ⇒ deny" check. The sink now probes it
— on the raw email **and** the `normalizeEmail`-folded one, because `tombstoneId` hashes
the raw key with no folding — and returns `{ error: 'erased' }`.

**Why my own review missed it:** the D2 witness seeded `addSuppression` by hand and never
ran the eraser, while its own comment claimed the "suppressed or DSAR-erased" property.
It could only see the arm I had implemented. The corrected witness drives the real
`deleteSubject` and was born-red with the resurrected contact id in the message;
sabotage-proved by removing the probe. This is the second iteration running in which the
code grader found the Blocker inside my own workflows-pass fix, and the same shape as
last time: **I proved the half I tested and claimed the whole.** A witness that seeds the
precondition by hand cannot see whether the real path produces that precondition.

**`FRMCD-2`, also in D2's code:** `isSuppressed` propagates storage errors by design, and
my call sat *outside* the sink's `try` — so a transient KV fault threw out of the sink,
the loop swallowed it, and the row carried no marker at all, indistinguishable from "CRM
toggled off." `suppressionBlocksSend` is the purpose-built wrapper with a third
`'unreadable'` state; the sink now uses it, and an unreadable store — suppression or
tombstone — is recorded as `{ error: 'suppression_unreadable' }` rather than silence.
No fault-injection witness exists for this arm (the Forms backend suite is deliberately
mock-free); it is closed structurally and stated as such.

**A new cross-feature edge, stated plainly.** The corrected sink imports
`isErasureTombstoned` from `consent/consentService.ts`, so `crm` now depends on `consent`.
`gen-feature-deps` recorded it as a **[2] soft-read** ("target vacuous-when-off, leave
documented, no lock") and auto-described it as a `consent.isAllowed` policy read. That
description is the generator's template, not the truth: the import is a **store read** of
the erasure tombstone, which is written by `deleteSubject` regardless of the `consent`
toggle and is therefore *not* vacuous when consent is off. The classification (documented,
unlocked) is still right — the edge is a read that can never break CRM — but the row's
prose is wrong about *what* is read. The import-boundary gate passes with zero
unallowlisted imports.

### D3 — WITHDRAWN before implementation: the cure was an attack on ADR 0584 (`FRMWF-4`)

As first written, D3 said a flagged submit past the quarantine budget should "drop
silently with the same 201 shape" so the honeypot never becomes an oracle. **Reading the
code it would replace falsified it.** The 429 is not an oversight; it is a documented
decision with its reasoning inline (`formsService.ts:636-650`, GC-FRM-7 + ADR 0584): *"a
capture primitive must never silently drop leads … The honest end of the quarantine: we
will NOT store it, so we must not claim we did."* The existing witness says the same in
its own words — *"A refusal the respondent can SEE. The old code answered 200 {ok:true}."*

Past the budget, two invariants genuinely conflict: FORM-UX-1's *flagged must answer like
clean* and ADR 0584's *never say thank-you for something not stored*. They cannot both
hold once storage stops, and the older rule is the stronger one — a silent 201 for a
dropped lead is the exact lie ADR 0584 was written to end. The scout's observation is
correct (the detector does return past 1000 flagged submits, and a false-positive user
hits a hard error), but the cost is bounded — the attacker pays 1000 submissions first,
`droppedCount` and `submission_flagged_cap_refused` already surface it — and the cure
would have reopened a closed Blocker to close an Improvement.

**Disposition:** `FRMWF-4` is downgraded to Nice-to-have and left open with this
reasoning; no code changes. The residual — an answer that is both honest and
oracle-free past the budget — is a product decision, not a fix. This is the fourth
prescribed fix in this loop that was an attack on the thing it replaced; the previous
three were caught by the same method (read what the fix deletes before deleting it).

### D4 — degrade is distinguishable from skip at the run boundary (`FRMWF-5`)

A stale binding (OQ-2 degrade), an unbound form, and a quarantined lead all complete with
`done.outputs = {value: undefined}`. `done` gains a `status` output (`filed` / `skipped` /
`degraded`), and the e2e's weak negative (`not.toContain(<another tenant's cardId>)`,
which the skip path also satisfies and which passes on an empty read) is replaced by an
assertion on that value.

### D5 — witnesses for the refusals nothing tests, and the ordering nothing pins (`FRMWF-6`, `FRMWF-7`)

Route-level: `POST /submit` to a draft form ⇒ 404; a >20 000-char values body ⇒ 413. And
one line in `feature-registration-order.test.ts` pinning `crm < service-desk`, with the
`intake.ts:120` rationale.

## Alternatives weighed

- **Put the suppression check inside `createContact`.** Rejected — it would refuse an
  operator deliberately re-adding a contact through the authenticated route. The trust
  boundary is the *public* lane; gate there.
- **Throw from the sink on suppression.** Rejected — sink throws are swallowed by design
  so a downstream outage never loses a capture; a marker is the honest signal.
- **Make `submitIdea` idempotent by `sourceSubmissionId` instead of classifying.**
  Considered and worth doing later (`WF-FORM-7`'s branch-mode half), but it is not the
  fix for the replay half: classification is the guard the executor actually reads.
- **Keep 429 past the budget "so operators notice".** Rejected — operators do not read
  public status codes; `droppedCount` is the operator signal, and the 429 is only ever
  read by the attacker and the false-positive victim.

## Open questions

- `FRMWF-9` (tool/route predicate divergence, fail-closed direction) needs a decision on
  whether `resolveReadOrgScope` should adopt `assertOrgScope`'s personal-owner
  short-circuit; deferred — it is parity, not escalation.
- `FRMWF-11` (input schemas) is the durable cure for `WF-FORM-9`; medium effort, deferred.

## Phased plan

| Phase | Decision | Gap ids |
|---|---|---|
| P1 | D1 — classify + ratchet + replay witness | `FRMWF-1`, `FRMWF-3`, `WF-FORM-7` |
| P2 | D2 — suppression check on the public sink | `FRMWF-2` |
| P3 | D4 (D3 withdrawn — see its section) | `FRMWF-5` |
| P4 | D5 — the three missing witnesses | `FRMWF-6`, `FRMWF-7` |


## Implementation record

| Phase | Decision | Change | Witness |
|---|---|---|---|
| P1 | D1 `FRMWF-1` | `submit-idea` → `role:"side-effect"` + `["side-effectful"]`; priority-matrix pack 1.3.0→1.4.0, node 1.0.0→1.1.0; feature pin moved | `forms-node-replay.test.ts` (new) — **born-red on legs 1/2/3, sabotage-proved** by restoring the `action` role; floor 306→307, served 263→264, **undischarged flat at 43** as predicted before deciding |
| P1 | `FRMWF-3` | `submit-idea` added to `EFFECT_TYPEIDS` | the derived reject ratchet still passes — no existing chain has it ungated |
| P2 | D2 `FRMWF-2` + **`FRMCD-1`/`-2` corrections** | the sink calls `suppressionBlocksSend` (3-state) AND `isErasureTombstoned` (raw + folded email); markers `suppressed` / `erased` / `suppression_unreadable` | two witnesses in `forms-route.test.ts`: suppression (hand-seeded) and **erasure through the real `deleteSubject`** — each born-red with the resurrected id in the message, each sabotage-proved |
| P3 | D3 `FRMWF-4` | **WITHDRAWN** — see D3 | no code changed; gap downgraded |
| P3 | D4 `FRMWF-5` | the e2e's degrade negative asserts the terminal's OWN output is absent | `forms-intake-chain-execution.test.ts` — first cut misread `terminalOutput`'s shape (it already maps to the outputs bag, which is `undefined` on degrade — a stronger fact); corrected |
| P4 | D5 `FRMWF-6`, `FRMWF-7` | three witnesses: POST-to-draft ⇒ 404, 20 001 chars ⇒ 413 + 5 001-char field ⇒ 400, `crm < service-desk` pinned | all green on first run — these witness behaviour that already held and was simply never asserted |

### Two corrections in this ADR's own life

- **D3 was withdrawn before implementation** — the cure would have violated ADR 0584 to
  satisfy FORM-UX-1; reading the code it deleted is what caught it.
- **D4's first witness misread the harness** — `terminalOutput` already returns outputs
  bags; my assertion reached for `.outputs` on one and threw. The corrected assertion is
  stronger (the bag is absent entirely on degrade), not weaker.

### Deliberately NOT closed

`FRMWF-9` (tool/route predicate divergence, fail-closed direction) — needs a decision
on adopting `assertOrgScope`'s personal-owner short-circuit in `resolveReadOrgScope`;
parity, not escalation. `FRMWF-11` (input schemas — the durable cure for `WF-FORM-9`),
`FRMWF-12` (opt-in sink idempotency), and the rest of `FRMWF-8..16` are recorded with fix
shapes. `WF-FORM-7`'s branch-mode half (idempotent `submitIdea` by `sourceSubmissionId`)
is the follow-on to D1.
