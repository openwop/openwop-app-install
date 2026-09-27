# ADR 0541 — ApplyGrant: auto-submit where submission is first-party, prepare where it is not

Status: Proposed

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Extends: `computer-use` (ADR 0454-class
governed browser sessions), approvals/interrupts, ADR 0447 (obligation ledger — the shape
this borrows), ADR 0036 (agent policy).

Core seam: `host/applyGrant.ts` (extends `computer-use`). No toggle of its own — inert unless **`job-search`** and `computer-use` are both on (ADR 0539 D0).

## Context

`computer-use` drives a provider-hosted browser as **recorded workflow steps** with
risk-tiered HITL: observe is automatic, interact is session-approved, and **`commit`-class
actions — submit, purchase, download, new-origin — are gated per action** through the
existing approval/interrupt cards.

auto-apply's entire premise is the opposite: an auto-apply campaign submits N applications
without a human in the loop, up to a cap the user set once.

These cannot both be true as stated. The question is which one bends, and how.

**The wrong answer is a second browser driver.** Porting the prior art's browser worker as its
own feature would sidestep the gate by standing up a parallel automation system next to a
shipped one — the exact violation ADR 0539's audit exists to prevent, and it would mean two
places to get replay, egress, credentials and approval semantics right.

## Decision

**Auto-submit, but only where submitting is the endpoint's intended use.**

The research above is about *platform* automation — driving a logged-in LinkedIn/Indeed
session and clicking Easy Apply at machine speed. That is what triggers velocity detection
and account suspension. It is **not** what applying to a company's own applicant-tracking
system is.

Greenhouse publishes a documented endpoint that accepts a job application as a multipart
POST. Ashby publishes `applicationForm.submit`. These exist **so that applications can be
submitted programmatically** — an ATS's entire purpose is to receive applications, and a
company's careers page is the one place an employer unambiguously wants you to apply.

So the grant is tiered by **who owns the submission surface**:

| Tier | Submission surface | Grant authorises | Why |
|---|---|---|---|
| **A** | The employer's own ATS, via its **documented submission API** (Greenhouse, Ashby, Lever, Workable) | **SUBMIT — fully automatic, no human, no browser** | First-party and intended. No platform ToS, no session, no velocity heuristics, no CAPTCHA. Deterministic and replayable. |
| **B** | The employer's own careers page, **no API** | **SUBMIT** via `computer-use`, paced | Still first-party — you are applying to the employer, not automating a platform. Real but bounded risk: a form can change under you. |
| **C** | A **platform's** native apply (LinkedIn Easy Apply, Indeed) or any flow hitting CAPTCHA / 2FA / payment | **PREPARE ONLY** — the human submits | This is exactly the surface where automation gets accounts banned, and the one the evidence indicts. Not worth a user's account. |

**Tier A is the default and covers most of the market** — nearly every company whose careers
page runs on a modern ATS. For those, auto-apply is genuinely hands-off: the user never sees
a form, a CAPTCHA, or an approval card.

Tier C is the exception path, not the norm — and it is the *only* place a human is asked.

### D1 — The grant

```
ApplyGrant {
  grantId, tenantId, orgId,
  subjectId          // WHOSE applications (RFC 0048 opaque id) — not the operator's
  grantedBy          // WHO authorised it (a person, always)
  campaignId         // scope: this campaign only
  maxSubmits         // hard ceiling on AUTOMATIC submissions (tiers A/B)
  submitsUsed
  maxPrepared        // hard ceiling on tier-C items parked for the human
  preparedUsed
  ratePerHour        // pacing — velocity is what gets accounts flagged
  tiers[]            // which tiers this grant covers; default ['A'] — B is opt-in
  origins[]          // scope: these origins only
  resumePolicy       // which résumé/variant policy may be attached
  expiresAt          // time bound — a grant always dies
  revokedAt?         // instant kill
}
```

Two ceilings, because two things need bounding: `maxSubmits` (what goes out) and
`maxPrepared` (what queues up for a human on Tier C). A user should never discover that
"auto-apply" quietly became a 40-item review backlog.

Every field is a bound. A grant with no ceiling, no scope, or no expiry is not a grant — it
is the gate turned off, and the schema refuses it.

### D2 — The gate consults; it does not defer

At a `commit`-class action the existing gate asks, in order:

1. Is there an unrevoked, unexpired grant for **this subject, this campaign, this origin**?
2. Does it have budget (`preparedUsed < maxPrepared`) and is it within the rate?
3. Does the action match the grant's class — a **submit**, not a purchase or a download?

All three yes ⇒ proceed, decrement, and record. Anything else ⇒ **per-action approval,
exactly as today**. A missing, expired, revoked, exhausted, out-of-scope, or wrong-class
action is indistinguishable from having no grant at all.

**`purchase` is never grantable.** The prior art's rule is right here too: never process payments — record
`failed: Payment required`. A grant covers submitting an application; it can never authorise
spending money, and the class check is what makes that structural rather than a convention.

### D3 — Decrement is a CAS, before the work

The counter increments through a compare-and-swap *before* the submit or the preparation. A
crash mid-flight costs one unit and loses nothing; the reverse order would let a retry storm
run past the ceiling. Same consume-then-act ordering the obligation ledger uses for accrual.

The ceiling is a **true ceiling**, not an average.

### D3b — Idempotency: never apply twice to the same job

A retry, a re-dispatch, or a fork must never produce a second application. The submission
key is deterministic — `(subjectId, canonicalListingId)` — and CAS-claimed before the send,
so a duplicate is refused at the store rather than discovered at the employer. This is the
single most embarrassing failure mode in this product and it is designed out, not tested
for.

### D3a — Pacing is mandatory, and it is cheap insurance

The grant carries `ratePerHour`, not just a total, and submissions are spread rather than
bursted. On Tier A this is not about detection — an ATS expects applications — it is about
the *user-side* harm the evidence documents: high-velocity applying correlates with
auto-rejection and DNC flagging. On Tier B it is also anti-bot hygiene.

Defaults are deliberately modest. A user who asks to fire 200 applications an hour is asking
for the outcome this product exists to prevent, and the UI says so plainly rather than
silently obliging — but the cap is theirs to raise, because it is their job search.

### D4 — Replay and fork can never consume budget

A replayed or forked run must not spend grant units and must not re-prepare. `computer-use`
already reads the recorded trajectory on replay rather than re-driving; the grant check sits
on the **live** path only, and the ADR 0531 effect-suppression guard is the backstop.

### D5 — Every consumption is attributable and visible

Each decrement writes an audit row: who granted, whose subject, which campaign, which
origin, which deal, when. A user must be able to answer "what did it submit on my behalf,
and under what authority" without reading logs. Revocation is immediate and does not require
the campaign to stop.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | No new package. `host/applyGrant.ts` (store + CAS + the tier resolver). The `computer-use` commit gate gains a grant consult for tier B; tier A never touches the browser at all. |
| 2 | **Toggle** | None of its own. A grant is inert unless `computer-use` **and** `job-search` are on; that AND-gate is the activation. |
| 3 | **Workflow surface** | Read-only: `ctx` exposes remaining budget so a chain can stop cleanly rather than fail at the gate. **No write op** — a workflow must never mint its own authority. |
| 4 | **Node pack** | None. Granting is a human act through a UI, never a node. |
| 5 | **Envelopes** | **None.** A model must not be able to request authority. |
| 6 | **Agent pack** | **None.** |
| 7 | **Public surface** | **None**, ever. |
| 8 | **RBAC** | Creating a grant requires the acting user to BE the subject, or hold org-admin over them. Revocation available to the subject, the granter, and org-admin — the widest of the three, because stopping must be easier than starting. Fail-closed. |
| 9 | **Replay/fork** | D4. Grant id + remaining budget stamp onto the run at creation and are read verbatim on `:fork`; the fork never re-consumes and never re-prepares. |
| 10 | **Frontend** | Grant creation is an explicit, legible dialog on the campaign — the caps, boards, and expiry stated in plain language, with a running "12 of 25 used" and a one-click revoke. This screen is the consent moment; it gets designed, not generated. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | `host/applyGrant.ts`: schema (all bounds mandatory), CAS decrement, revoke. No consumer. | Unit: a grant without a ceiling/scope/expiry is rejected; concurrent decrements cannot exceed `maxPrepared`. |
| **P2** | The preparation-path consult in `job-search`. | The headline test is **negative and structural**: with a valid grant, a submit STILL raises an approval card. Assert no code path lets a grant satisfy the commit gate — a tripwire over `computer-use`'s gate call sites, sabotage-verified. |
| **P3** | Audit rows + the run stamp + fork-safety. | Fork test: a forked run consumes zero budget and re-submits nothing. |
| **P4** | The grant UI + revoke. | Route tests; `/ux-review` on the consent dialog. |

## Alternatives weighed

| Option | Verdict |
|---|---|
| **Tiered by submission-surface ownership (chosen)** | Auto-submit where the endpoint exists to receive applications (the employer's own ATS), prepare-only where automation is what gets accounts banned (platform-native apply). Delivers genuinely hands-off auto-apply for most of the market without buying the risk that harms users. |
| **Prepare-only everywhere (an earlier draft)** | **Rejected** — it treats a first-party ATS API, which exists precisely to receive applications, as if it were LinkedIn Easy Apply. That over-corrects from the platform evidence and makes the product toil-heavy for no safety gain. |
| **Auto-submit everywhere, including platform-native** | **Rejected on evidence.** Tier C is exactly where velocity detection, suspensions and DNC flagging live. Not worth a user's account, and the accounts lost are theirs, not ours. |
| **A second browser driver outside the gate** | **Rejected** — parallel architecture; two places to get replay/egress/credentials/approvals right, and they will disagree. |
| **A global "trust this agent" setting** | Rejected — unbounded, unattributable, and it weakens the gate for *every* commit class including purchases. |
| **Bounded grant (chosen)** | Satisfies the gate through explicit authority rather than bypass; every dimension is bounded and revocable. |

## RFC gate

**Host work, no RFC.** The grant is host-local and never crosses the wire. **If it ever
needs to travel between hosts** — a run on host A submitting under a grant issued on host B
— it becomes wire and needs an RFC first. Keeping it host-local is a deliberate constraint
(0539 OQ-1), not an oversight.

## Open questions

- **OQ-1 — review backlog. RESOLVED: prepared items EXPIRE (7 days), and the rate tracks
  observed review throughput, not ambition.** If a user reviews ~5 a day, preparing 40 a day
  manufactures guilt and stale work. The grant's rate adapts to what the human actually
  clears, and expiry keeps the queue honest rather than letting it become a backlog the user
  avoids opening.
- **OQ-2 — exhaustion. RESOLVED: notify, pause, one-tap re-grant.** Never silently degrade
  to a different behaviour — a product that quietly changes what it does is worse than one
  that stops and says why.
- **OQ-3 — multi-applicant workspaces.** `subjectId` makes a grant per-person, but nothing
  yet stops an org-admin granting on behalf of someone who never consented. That is a
  consent question, not an authz one, and it wants a decision before multi-applicant use
  (mirrors ADR 0540 OQ-2).
