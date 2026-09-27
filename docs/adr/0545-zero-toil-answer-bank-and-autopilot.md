# ADR 0545 — zero-toil autopilot: answer once, apply forever

Status: implemented

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Composes:
[0540](0540-job-search-domain-and-crm-mapping.md) (profile, résumé variants),
[0541](0541-apply-grant-bounded-auto-submit.md) (tiered submission),
[0542](0542-job-board-adapters-and-listings.md) (Tier-1 sources),
[0544](0544-application-intent-attestation.md).

Module: `features/job-search/autopilot/` · Toggle: **`job-search`** (the ONE vertical flag).

## Context

"Auto-apply" is not one capability. It is the *absence* of a dozen small interruptions, and
a product is only toil-free if **every one of them** is designed out. The prior art
eliminates some and reintroduces others:

| Interruption | Prior art | Cost |
|---|---|---|
| Salary expectation | asks per campaign, remembers per campaign | asked again next campaign |
| A screening question it has not seen | `needs_user` → parks the job | the run stops; the human context-switches |
| 2FA on a board | parks, ~5 min expiry, then skips the job | the job is silently lost |
| CAPTCHA | attempts to solve, else skips | a lost application, and a paid solver dependency |
| Résumé for this role | tailors per job | N documents, N tailoring runs, N chances to fabricate |
| Login gone stale | fails the job with `Login failed` | the campaign quietly degrades |

Each is individually reasonable and collectively fatal to "seamless": a user who is
interrupted once per five applications is not on autopilot, they are doing data entry with
extra steps.

**Tier-A coverage is ~35%, not "most of the market" — and the product must say so.**
Measured ATS share of enterprise postings: **Workday 32%**, Greenhouse 18%, iCIMS 10%.
Greenhouse + Lever + Ashby + Workable together are roughly **30–40%**, concentrated in tech
startups and scaleups. Workday — the single largest — publishes **no public candidate
submission API** and is the hardest surface to drive.

An earlier draft of this ADR claimed Tier A "covers most of the market". That was wrong, and
the correction matters more than the number: a paid product that overstates its automation
boundary gets discovered by the user at exactly the wrong moment.

**The Tier-A path in ADR 0541 deletes four of these outright** — no login, no session, no
CAPTCHA, no 2FA, because there is no browser and no platform account. What remains is a
*content* problem: the application asks questions, and something must answer them without
asking the human twice.

## Decision

### D1 — The Answer Bank: answer once, reuse forever, per person

A durable, per-subject store of **answers to application questions**, keyed by a normalised
question identity — not by board, not by campaign, not by employer.

```
Answer {
  subjectId,               // whose answer (RFC 0048 opaque id)
  questionKey,             // normalised identity, e.g. 'work-auth.us.requires-sponsorship'
  value,                   // scalar | enum | text
  source: 'profile' | 'user' | 'inferred',
  confirmedAt,             // when a human last affirmed it
  usageCount
}
```

Three sources, and the distinction is load-bearing:

- **`profile`** — derived from the structured profile (name, contact, work authorisation,
  location). Never asked.
- **`user`** — explicitly answered once, then reused everywhere. Salary expectation, notice
  period, relocation willingness, veteran/disability disclosure.
- **`inferred`** — the agent proposes an answer from the résumé (e.g. "years with Python: 6"
  from the experience dates). **Never auto-submitted on first use**: an inferred answer is
  confirmed once, and thereafter it is a `user` answer.

The rule that makes this toil-free: **a question is asked at most once, ever.** The second
employer asking for salary expectation gets the stored answer, silently.

### D2 — Seed the bank up front, not during a campaign

At setup the user answers a **standard question bank** — the ~20 questions that cover the
overwhelming majority of applications (work authorisation, sponsorship, salary, start date,
relocation, remote preference, EEO/voluntary disclosures, references, portfolio links).

This is the single highest-leverage decision in the whole vertical. Answering 20 questions
once, at a moment the user has chosen, is not toil. Being asked one question, unpredictably,
in the middle of an unrelated day, forty times — **that** is toil, and it is what makes
existing tools feel like work.

Seeding also converts "unknown question" from the common case into the rare one.

**Correction note (P1, added during implementation).** D2 puts "EEO/voluntary disclosures"
in the standard bank. **This implementation refuses to store them at all**, and the refusal
is structural: `recordAnswer` rejects a special-category question before it resolves a key,
so no row can exist. The reasons are specific to this host rather than general squeamishness:

- `DurableCollection` is plaintext JSON in Postgres. There is **no field-level encryption
  seam for user data** — the AES/KMS machinery under `byok/` is a separate keyspace for
  credentials and a collection cannot opt into it. Row 7 calls this "among the most
  sensitive stores in the app"; that was a statement about how carefully to guard it, and
  the honest reading of the available primitives is that we cannot guard it that well.
- Masking is not a control here either. `maskPiiValue` is a SHA-256 prefix, which is
  dictionary-reversible for exactly the low-cardinality values a disability or veteran
  answer takes.
- **"Decline to self-identify" is a valid, penalty-free answer on every one of these
  forms** — it is what they are for. So the applicant loses nothing, and the product's most
  sensitive category never enters the database.

A store that cannot hold a disability disclosure cannot leak one, which is a stronger
guarantee than any access rule over a store that can. If a later phase genuinely needs to
transmit these values, that is a new seam (a KMS-backed collection variant), not a field on
this one.

**OQ-3 is already resolved by ADR 0544's own correction**, ahead of the deadline this ADR
set for it: `human-reviewed` is emitted only where a human actually decided, so autopilot
submissions carry "a named person authorised this campaign under a bounded policy" and never
a review claim. The tension OQ-3 identified is real and was settled in the honest direction.

### D3 — Unknown questions do not stop the campaign

When an application asks something the bank cannot answer:

1. If the field is **optional** — skip it and submit. An optional field is optional.
2. If **required** and the agent can infer it at high confidence from résumé/profile —
   answer, submit, and **queue the inference for confirmation later**, batched.
3. If **required** and genuinely unknown — park **this one application**, and **keep
   going**. One unanswerable question must never stall a campaign.

Parked items batch into a single "3 questions, ~40 seconds" card rather than three
interruptions. Answering them writes to the bank, so they are never asked again.

**Order matters.** Prior art parks first and asks immediately, which is why one novel
question stops the loop. Here the campaign continues and the human is interrupted in
batches, on their schedule.

### D4 — A small set of résumé variants, not one per job

Per-job tailoring produces N documents, N generation runs, and N opportunities to fabricate.
It also degrades: a résumé rewritten for every posting drifts from the truth by increments.

Instead: a **small set of variants** (typically 2–4 — e.g. backend, platform, leadership),
each tailored once and reused via the ADR 0540 reuse-vs-create score. A new variant is
created only when no existing one scores well enough for a role.

Fewer documents, fewer generations, less drift, and — importantly for ADR 0544 — a résumé
the applicant has actually read.

### D5 — Autopilot is a policy, not a queue of decisions

The user sets a **policy** once:

```
Autopilot {
  roles[], locations[], remote,
  minMatchScore,           // the eligibility floor
  dailyCap, ratePerHour,   // the ADR 0541 grant bounds
  tiers: ['A']             // 'B' opt-in; 'C' is always human
  variantPolicy,
  autoAttest: bool         // ADR 0544
}
```

Then it runs. The human's ongoing involvement is exactly three things:

1. **Exceptions** — batched unknown questions and Tier-C items.
2. **Replies** — a recruiter responded (this is the *valuable* interruption).
3. **Steering** — "stop applying to agencies", changing the policy.

Everything else is invisible. The user opens the app to see *outcomes*, not a work queue.

### D5a — Coverage is segmented, disclosed, and never discovered by surprise

- **Claim precisely.** "Fully automatic at companies on Greenhouse, Lever, Ashby and
  Workable — assisted everywhere else." Precision is checkable; "most jobs" is not, and a
  sold bundle should never make an unfalsifiable capability claim.
- **Disclose per search.** Every saved search reports its own split — *"of your 40 matches,
  26 are auto-apply, 11 assisted, 3 need you"* — before the user commits to it.
- **Workday gets a dedicated hardened adapter, not generic fallback.** At 32% of enterprise
  postings it is a third of the market and the worst form-driving surface (~70% field
  accuracy in the best available tooling). Treating it as a named Tier-B adapter with a
  pinned flow is proportionate to its share; lumping it into "generic browser" is not.
- **Segment honestly in positioning.** This product is *excellent* for the tech
  startup/scaleup segment and *assistive* for enterprise. That is a real, defensible market,
  and claiming otherwise sets up the disappointment.

### D6 — The failure posture is "keep going, report honestly"

A campaign must degrade, never halt. A stale connection disables one board and says so; an
adapter that breaks skips that employer and records why; an unanswerable question parks one
application. The daily digest reports what happened — *including what was skipped and why* —
because a silent skip is indistinguishable from a job that was never found, and that is the
failure mode that erodes trust in an autonomous product.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `features/job-search/autopilot/` — a module of the one package (0539 D0). |
| 2 | **Toggle** | **`job-search`** — no toggle of its own; part of the sold bundle. |
| 3 | **Workflow surface** | `ctx.features['job-search']`: `answerFor(questionKey)` (read), `recordAnswer` (write, human-confirmed only). The policy is read-only to workflows — a chain must not widen its own autopilot. |
| 4 | **Node pack** | `feature.job-search.nodes` gains `answer-lookup` and `answer-propose` (propose ≠ persist). |
| 5 | **Envelopes** | **None.** |
| 6 | **Agent pack** | None new — the persona is 0543's. |
| 7 | **Public surface** | **None.** The answer bank is among the most sensitive stores in the app (salary, disability, veteran status). |
| 8 | **RBAC** | Read/write require the acting user to **BE** the subject. **Not org-admin** — an admin must never read an employee's disability disclosure or salary expectation. This is stricter than the app's default org-scoping, deliberately. |
| 9 | **Replay/fork** | The answers used are **stamped onto the application at submit**, not looked up at read: a later answer change must never rewrite what was actually sent. Fork replays the stamped set. |
| 10 | **Frontend** | A setup wizard for D2 (~20 questions, progress-visible, skippable-with-consequence-stated) and a single batched exceptions card. **No per-application UI in the happy path** — if the user sees an application before it is sent, autopilot has failed. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | Answer bank + question-key normalisation. | Two employers phrasing the same question differently resolve to one key; an `inferred` answer cannot be used twice without confirmation. |
| **P2** | The standard bank + setup wizard. | Coverage measured against real ATS forms: what fraction of required fields does the seeded bank answer? Ship the number; it is the toil metric. |
**P2 coverage — the shipped number (MEASURED 2026-08-11).** Against a representative
reconstruction of the four Tier-1 boards' required application fields (21 fields):

| | Covered | Ratio |
|---|---|---|
| Full seeded bank (10 questions) | 20 / 21 | **95%** |
| Core six only | 14 / 21 | **67%** |
| Answered by declining (special category) | 1 | counted SEPARATELY, never as coverage |

Computed by `coverageReport()` from fixtures in `standardBank.ts`, not asserted in prose —
`job-search-standard-bank.test.ts` prints it and pins the properties that keep it honest: a
declined special-category field is not coverage, a fuzzy key match is not coverage (the
runtime refuses to auto-answer on one, so counting it would measure something that will not
happen), and the special-category field stays IN the denominator rather than being quietly
excluded to flatter the ratio. The fixtures are a reconstruction, not a scrape, and the
report returns per-board denominators so the number cannot be quoted without them.

The measurement immediately earned its keep: it exposed that `authorized` (US) and
`authorised` (UK) differ by enough token overlap to fall below the fuzzy threshold, so the
**American** spelling of a US-centric work-authorisation question was missing while the
British one matched. Fixed in the synonym table — never by lowering the threshold, which
would have raised the number by making wrong answers likelier.

| **P3** | Tier-A submission (0541) end-to-end: discover → score → variant → answers → submit → deal. | Idempotency (0541 D3b): a retry, re-dispatch and fork each produce exactly one application. |
| **P4** | Exception batching + the digest (D3, D6). | An unanswerable question parks ONE item and the campaign continues; skips are reported, never silent. |
**P3/P4 note — a real defect the campaign loop exposed (2026-08-11).**
`ensureApplicationFieldDefs` (ADR 0540) claimed idempotency and was not: it compared the
camelCase literal `jobUrl` against the STORED key, which `buildFieldSpec` normalises to
`joburl`, so the guard never matched and the second call threw `A field \`joburl\` already
exists`. Every existing test creates ONE application per tenant, so nothing caught it —
**the campaign loop is the first caller to create a second, and it failed on listing #2**,
which means every real user would have hit this on their second job application. Fixed by
normalising both sides, pinned directly by `job-search-application-idempotency.test.ts`
rather than only through the campaign suite.

| **P5** | Policy UI + attestation opt-in (0544). | `/ux-review`; the happy path shows zero per-application interactions. |

**Correction note (P5).** D5's policy includes `autoAttest: bool`. **Not implemented, and
deliberately.** ADR 0544 P4 established that consent to disclose is per application and must
show the number BEFORE consent, because "consenting to disclose an unseen number is not
consent". A policy-level `autoAttest` is exactly that blanket consent: at the moment the
policy is set the campaign has not run, so the count it would disclose does not yet exist.
Attestation therefore stays a per-application act on the applications list. Everything else
in D5's policy already existed on the ADR 0543 steering store and is composed rather than
duplicated.

## Implementation record

| Phase | Landed as | Pinned by |
|---|---|---|
| **P1** | answer bank + question-key normalisation | `job-search-answer-bank.test.ts` |
| **P2** | standard bank, coverage number, setup wizard | `job-search-standard-bank.test.ts`, `job-search-answer-routes.test.ts`, `__tests__/answerBankWizard.test.tsx` |
| **P3** | Tier-A submission end to end | `job-search-autopilot-pipeline.test.ts` |
| **P4** | campaign loop, exception batching, digest | `job-search-campaign.test.ts`, `job-search-application-idempotency.test.ts` |
| **P5** | exceptions card + policy (composed, not duplicated) | `__tests__/exceptions.test.tsx`, `job-search-answer-routes.test.ts` |

## How this improves on the prior art

| | Prior art | Here |
|---|---|---|
| Submission | Playwright form-fill, ~70–90% field accuracy per ATS, CAPTCHA/2FA failure modes | **Tier-A documented API — deterministic, replayable, no browser** |
| Repeat questions | salary asked per campaign; 2FA per board | **Answer bank — asked at most once, ever** |
| Novel question | parks the job, asks now | **Campaign continues; batched later** |
| Résumés | one tailored document per job | **2–4 variants, reuse-scored** |
| Credibility | none | **Verifiable attestation (0544)** |
| Pipeline | bespoke `Application` table | **CRM deal — stage history, reports, merge, timeline** |
| Replay | browser trajectory | **Deterministic API call + stamped answers** |

## Open questions

- **OQ-1 — Tier-A coverage. RESOLVED (~30–40%), and the design changed accordingly.**
  Workday 32% / Greenhouse 18% / iCIMS 10% of enterprise postings; the Tier-A four cover
  roughly a third, concentrated in tech startups and scaleups. D5a is the response: claim
  precisely, disclose per search, invest in a Workday adapter, and segment the positioning.
  P2 still measures coverage against the user's *actual* target list, because the market
  average is not their average — but the product no longer depends on that number being high.
- **OQ-2 — inferred answers. RESOLVED: confirm-before-first-use, batched into setup.** An
  unconfirmed inference can never reach an employer (P1 proves it structurally). Confirmations
  batch into the setup wizard or the periodic exceptions card — never mid-campaign, which
  would reintroduce exactly the interruption D3 exists to remove.
- **OQ-3 — how honest is "auto-attest"?** If autopilot submits without the human reading the
  application, the ADR 0544 claim "a human reviewed and submitted this" becomes **false for
  Tier A**. The attestation wording must change to what is actually true — *"a human
  authorised this campaign and its policy"* — or the claim is a lie. **This must be settled
  before 0544 P1**; it is the sharpest tension between "toil-free" and "credible."
