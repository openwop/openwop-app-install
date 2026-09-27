# ADR 0546 — the warm path is the product: referrals, follow-ups, interviews, and the only metric that matters

Status: implemented

Parent: [ADR 0539](0539-job-search-vertical-strategy.md). Composes:
[0540](0540-job-search-domain-and-crm-mapping.md) (deal = application),
[0543](0543-career-agent-and-work-loop.md) (chains + the work loop),
[0545](0545-zero-toil-answer-bank-and-autopilot.md) (batched exceptions),
CRM (contacts, activities, Gmail sync), Documents, Notifications.

Module: `features/job-search/lifecycle/` · Toggle: **`job-search`** (the ONE vertical flag).

## Context

A completeness audit against the baseline found that the ADR set covered *getting an
application sent* and almost nothing after it. Four capabilities were missing outright —
follow-ups, interview replies, interview prep, and response analytics — and warm intros were
named but never designed.

That gap is not incidental. **Sending is the cheap half.** Once ADR 0541 makes submission
automatic, the volume of sent applications stops being the constraint and everything
downstream becomes the product: whether anyone replies, whether the reply is handled well,
and whether the user can tell what is working.

It is also where the vertical's stated thesis (ADR 0539: sell applications that get *read*,
not more applications) either becomes measurable or stays a slogan.

### The evidence that reorders this ADR

Measured industry rates:

| Path | Interview rate |
|---|---|
| Cold application | **2–3%** (0.1–2% to offer in competitive fields) |
| **Referred** application | **40–65%** |

**One referral is worth roughly forty cold applications**, and ~85% of roles are filled
through networking rather than boards.

That number changes what the agent should spend its cycles on. Automating submission makes a
user faster at the path that works 3% of the time; finding a warm path makes them effective
at the one that works 40–65% of the time. An agent-minute spent discovering a mutual
connection is worth on the order of **forty** agent-minutes spent submitting faster.

An earlier draft of this ADR had warm intros as D5 — a deferred sub-feature at the bottom.
**That was backwards, and this revision inverts it.**

## Decision

### D0 — Warm-path discovery is the PRIMARY agent workload

For every application above the match floor, the agent's first question is not "how do I
submit this faster" but **"is there a path in?"**

1. **Look for a path** — an existing CRM contact at the company; a former colleague from the
   résumé's own employment history; a second-degree connection through the workspace's
   contact graph; a public alum/community signal.
2. **If a path exists** — draft the intro, park it (D5 rules: never auto-send), and mark the
   application as *warm-eligible*. The cold application still goes out automatically
   (ADR 0541) — the two are not exclusive, and the cold one costs nothing.
3. **If no path exists** — the cold application stands on its own, which is the floor.

**The ranking follows the leverage.** ADR 0534's compiler ranks the agent's board, so a
*warm-path-available* card must outrank a speculative new application: one is worth ~40 of
the other. This is a criteria-set change in `job-search`, not a new mechanism.

**This is also the honest answer to "why not just apply to 500 jobs?"** Not because volume is
morally wrong, but because the 501st cold application is worth 1/40th of one warm intro, and
the agent has finite cycles. Reallocating effort is a *better outcome* for the user, not a
safety restriction imposed on them.

### D1 — Follow-ups are scheduled work items, not a cron over applications

A follow-up is a **kanban card on the agent's board**, created when an application enters a
stage that warrants one and due at a cadence the user set. That means it inherits everything
already built: ranked selection (ADR 0534) puts a due follow-up in front of a speculative
new application, stranded-work recovery (ADR 0535) means a crashed follow-up returns to the
queue, and the run budget bounds it.

The alternative — a scheduler sweeping applications for "sent > 7 days ago" — would be a
second work loop, which ADR 0543 D1 exists to prevent.

**Cadence is per-stage, not global.** A follow-up after *applied* is a nudge and should be
rare and late. A follow-up after an *interview* is a thank-you and should be same-day. One
global `followupDays` (the baseline's model) gets both wrong.

**Hard rule: never more than one follow-up per application per stage, ever.** The failure
mode here is not a missed nudge, it is becoming the candidate who emails four times. The
count is enforced at the store, not by prompt.

### D2 — Interview replies are drafted, never sent

An interview invite is the highest-stakes message in the whole pipeline and the one where a
wrong automated reply is least recoverable. So:

- the agent drafts a reply proposing concrete availability, grounded in the user's calendar
  when a calendar Connection exists and in stated preferences otherwise;
- it **parks it as an approval card** with the draft inline;
- **it never sends.** Not under a grant, not on Tier A, not ever.

This is not inconsistent with auto-apply. Applying is a *bounded, reversible, low-variance*
act against a form. Replying to a human who is deciding whether to hire you is neither. The
tiering in ADR 0541 was always about *who owns the surface*; here the surface is a person.

Untrusted-content rules apply to the invite body: it informs the draft and can never
instruct the agent (ADR 0542 D3).

### D3 — Interview prep is a document, generated once, attached to the deal

A prep sheet (the role, the company, likely questions from the JD, the user's own matching
evidence pulled from their résumé) is a **Documents** artifact attached to the CRM deal,
generated when a deal reaches an interviewing stage.

Generated **once and marked**, so a re-run does not produce a second sheet — the baseline
uses a marker prefix for exactly this dedupe and it is the right instinct: the marker lives
on the document kind, not in prose.

### D4 — The response-rate loop is the product's only honest scoreboard

Applications sent is a vanity number that this product explicitly does not sell (0539). The
scoreboard is therefore:

| Metric | Why it is the right one |
|---|---|
| **Response rate** (replies ÷ applications) | the direct measure of whether applications are being *read* |
| **Time to first response** | detects boards/employers that never reply at all |
| **Stage conversion** (applied → screening → interview → offer) | where the funnel actually breaks |
| **Warm vs cold response rate** | **the dominant variable** (2–3% vs 40–65%) and the cleanest to attribute — report it first |
| **Response rate by source, by variant, by match band** | the only way to answer "should I apply to more of these?" |

All of it derives from **CRM stage history and activities**, which already exist (ADR 0210
stage history + weekly snapshots) — so this is a projection, not a new store.

**It must be allowed to deliver bad news.** If a résumé variant has a 0% response rate over
40 applications, or a match band below 70 never converts, the product says so and proposes
narrowing. An analytics surface that can only report progress is marketing.

### D5 — Warm intros are drafted, never auto-sent (the execution half of D0)

D0 makes discovery the priority; this constrains how it is acted on. Outreach to a person is
Tier C by construction (ADR 0541) — the surface is a human, and the platform where most such
outreach would happen is the same one whose automation gets accounts restricted.

**Discovery and drafting are the automation. Sending is the human's.** That split is not a
compromise: drafting a credible, specific intro is where the effort actually is, and sending
it takes five seconds. Automating the five seconds would buy nothing and risk everything.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package** | `features/job-search/lifecycle/` — a module of the one package (0539 D0). Composes CRM activities/stage history, Documents, kanban, Notifications. |
| 2 | **Toggle** | **`job-search`** — no toggle of its own; part of the sold bundle. |
| 3 | **Workflow surface** | `ctx.features['job-search']`: `funnel(range)` and `responseRate(groupBy)` (read); `scheduleFollowup(dealId)` (write). Sending is **not** a surface op. |
| 4 | **Node pack** | `feature.job-search.nodes` gains `followup.schedule`, `interview.prep`, `funnel.read`. **No `send` node** — a chain must not be able to email a recruiter. |
| 5 | **Envelopes** | **None.** |
| 6 | **Agent pack** | None new — 0543's persona, with these chains added. |
| 7 | **Public surface** | **None.** |
| 8 | **RBAC** | Reads `workspace:read` scoped to deals the caller owns; drafting writes `workspace:write`. Sending requires a human approval — there is no role that can bypass it. |
| 9 | **Replay/fork** | Drafts are recorded; a fork replays the recorded draft and never re-drafts or re-sends. Follow-up counters are CAS-guarded so a re-dispatch cannot produce a second nudge (D1). |
| 10 | **Frontend** | The funnel lives on the CRM deal board's Reports tab, which 0540 D3 already made count-based for non-revenue pipelines — so the scoreboard is *the same surface*, not a second dashboard. Interview drafts and follow-ups surface as approval cards. |

## Phased plan

| Phase | Scope | Verification |
|---|---|---|
| **P1** | Response-rate + funnel projection over CRM stage history. | Numbers reconcile against the underlying activities; a variant with zero responses is reported as zero, not hidden. |
| **P2** | Follow-up cards + per-stage cadence + the one-per-stage cap. | The cap holds under retry, re-dispatch and fork. |
| **P3** | Interview reply drafting → approval card. | The headline test is negative: **no code path sends**, sabotage-verified. Untrusted invite body cannot instruct. |
| **P4** | Prep sheets, generated-once. | A re-run attaches no second sheet. |
| **P5** | Warm-intro drafting over CRM contacts. | Draft-only; no send path exists. |

## Implementation record

| Phase | Landed as | Pinned by |
|---|---|---|
| **P1** | funnel projection over CRM stage history | `job-search-funnel.test.ts`, `__tests__/funnelHonesty.test.tsx` |
| **P2** | per-stage cadence + the one-per-stage cap | `job-search-lifecycle.test.ts` |
| **P3** | interview-reply drafts, no send path | `job-search-lifecycle.test.ts` (negative test over stripped source) |
| **P4** | prep sheets, generated once | `job-search-lifecycle.test.ts` |
| **P5** | warm-intro drafts, draft-only | `job-search-lifecycle.test.ts` |

**A dead field, found by P1.** `board` has been in `APPLICATION_FIELD_DEFS` since ADR 0540
and **nothing ever wrote it** — which is why D4's "response rate by source" could not be
computed: the column existed and was always empty. Now populated by the caller, falling back
to inferring from the posting URL against the adapter REGISTRY (so a newly registered board
attributes without a second edit here), and returning empty rather than guessing — a wrong
source attribution would push someone to abandon a board that is working for them.

**On the negative test.** P3 asks for "no code path sends, sabotage-verified". It is
asserted over the module's own source with comments STRIPPED, because that module's header
explains at length that it never sends and a raw text scan would flag the very prose written
to guarantee it. Sabotage (adding a `fetch` call) turns it red.

## Explicitly deferred (recorded so they are not silently dropped)

The audit also surfaced three baseline capabilities that are **out of scope for this vertical
and are not being ported**:

- **Self-promotion posts** (HN/Reddit/LinkedIn "who wants to be hired"). Peripheral to
  applying, and posting to communities on a user's behalf carries reputational risk that
  needs its own decision. Note the name `promotions` is **taken** by the e-commerce discount
  engine (0539), so this can never reuse it.
- **Public candidate profile / portfolio / leaderboard.** A public-content surface, which
  Publishing + CMS already own; it is a different product from a job-search agent.
- **Freelance bidding** (0539 OQ-4) — a second vertical with its own quality heuristics.

Each is deferred on a *reason*, not on effort, and each would be its own ADR.

## Open questions

- **OQ-1 — follow-up cadence. RESOLVED: ship conservative, then let the data set it.** One
  nudge at ~7 days post-application; a same-day thank-you post-interview. The evidence on
  timing is thin and employer-dependent, so the defaults are a starting point rather than a
  claim — and P1's response-rate projection makes them empirically adjustable per user, which
  is better than a number argued from anecdote.
- **OQ-2 — attribution. RESOLVED for the variable that matters.** Warm-vs-cold dominates
  everything else (2–3% vs 40–65%) and is cleanly attributable, so it is reported first and
  prominently. Secondary cuts (variant, match band, source) are reported **with volume** and
  an explicit correlation caveat — never a confident causal chart over 12 data points.
- **OQ-3 — does the funnel discourage? RESOLVED by baseline.** The fix is not to hide the
  number but to give it its comparison class: *"3.1% — typical for cold applications is
  2–3%"* is encouraging and true, where a bare *"3.1%"* is demoralising and equally true.
  Where a warm path exists the comparison is transformative rather than consoling, which is
  the point of D0.
- **OQ-4 — how deep should path discovery go?** Contacts and prior colleagues are clearly in
  scope. Second-degree inference from public sources is more powerful and more invasive.
  Recommend: only sources the user could reach themselves, never purchased contact data, and
  the provenance of every suggested path shown ("you both worked at X, 2019–2021").
