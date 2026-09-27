# KickTodo Metrics (unit G9) — chat-first port review

Scope: `backend/typescript/src/features/kicktodo-metrics/` +
`frontend/react/src/features/kicktodo-metrics/`. Feature toggle `kicktodo-metrics`
(OFF), ADR 0432 "PRD §15 outcome metrics as computed-on-read projections plus
sampled verifier review." Read-only except this file.

## Headline

This is **mostly a legitimately page-shaped feature that already rides the
engine** — the four metric reads are honest computed-on-read projections over the
owning services, and the human-grading half correctly rides the approvals owner +
reviews inbox. Two capabilities are **THEATER**: (1) the `POST /verifier-sample`
route that mints the grading tasks has **no igniter anywhere in the app** — no UI,
no chat tool, no workflow, no scheduler, no seed calls `sampleVerdict` — so the
verifier FP/FN quality metric is structurally starved and will always report
`sampled: 0`; and (2) ADR 0432 P5's claim that "KickBot/insights may READ metrics"
is unwired — the `outcome-metrics` node exists but is in **no agent's
toolAllowlist**, so no agent can invoke it. Nothing here is PARALLEL — the ADR's
central discipline (no second read model) held.

## Contract scouting (file:line evidence)

**What is declared vs what creates runs of it**

- **Four GET metric routes** (`routes.ts:35,44,53,88`) are pure reads; each calls
  a projection function that reads owner state through the owners' exported
  functions: `activationMetrics`/`engagementMetrics` read
  `listEnrollmentsInTenant` + `listCheckIns` (`metricsService.ts:21-23,80,103`),
  `factoryMetrics` reads `listCandidates` (`metricsService.ts:23,208`),
  `verifierQuality` reads its own sample rows + `getApproval`
  (`verifierSampleService.ts:125-139`). No second store, no rollup at rest — the
  ADR's "computed-on-read" claim is true (`metricsService.ts:1-18`).
- **`POST /verifier-sample`** (`routes.ts:61-84`) → `sampleVerdict`
  (`verifierSampleService.ts:60`) reads the enrollment + the goal's recorded
  `lastVerdict` from the judge (`verifierSampleService.ts:64-69`) and mints a
  `metrics-verifier-sample` approval via the **existing approvals owner**
  `createCommunityApproval` (`verifierSampleService.ts:88-96`,
  `approvalService.ts:398-414`). **Igniter grep: `sampleVerdict` and the
  `/verifier-sample` path have ZERO callers outside the feature's own route** —
  no UI button (`MetricsPage.tsx` is read-only, no POST), no chat tool, no
  workflow node, no scheduler, no seed. The route is reachable only by a raw
  external HTTP POST.
- **`outcome-metrics` node** (`packs/feature.kicktodo.nodes/pack.json:269`,
  `index.mjs:513-528`) reads `ctx.features['kicktodo-metrics']` — the correct
  RIDES mechanism for the ctx surface (`surface.ts:11-19`). But grep shows it is
  referenced **only by its own pack registration** — it is in no agent
  toolAllowlist and no workflow in `packs/`/`distributions/`. The nine KickTodo
  agent toolAllowlists carry only `kicktodo.candidates/factory.run/today/progress/
  circles` (`packs/feature.kicktodo.agents/pack.json` toolAllowlists) — **never
  `outcome-metrics`**. This is exactly the cross-cutting "declared node never
  projected into a conversational tool" pattern: even if it were allowlisted it
  would need the projection; here it is not allowlisted at all.

**Agent tool allowlists vs what tools can do:** N/A — this feature ships **no
agent pack** (`feature.ts` has no agent; ADR 0432 Feature-matrix item 6 = "Agent
pack: none new"). So there is no persona to be toothless; the gap is the opposite —
there is no agent path to the reads at all.

**Owners instantiated vs shadowed:**
- Approvals owner: **instantiated**, not shadowed — `createCommunityApproval`
  (`verifierSampleService.ts:88`); no second review inbox. RIDES.
- Reviews inbox: the generic approval projection surfaces any pending approval
  with approve/reject actions (`reviewProjection.ts:290,296-297`), so a
  `metrics-verifier-sample` approval renders in the inbox and its redactor is
  registered (`approvalService.ts:707`). RIDES.
- Metric owners (enrollments, check-ins, candidates, goals): **read through their
  exported functions only** — no copy of their state. RIDES.

**Executor/chassis constraints:** none — projections are pure functions of durable
state, no run coupling, no replay/fork surface (ADR 0432 matrix item 9). The one
honest scale caveat (per-tenant prefix scans, falsifiable rollup trigger at ~5k
enrollments / p95>2s) is documented in code (`metricsService.ts:11-18`).

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| View activation metrics (days-to-first-action p50, any-completion) | GET `/activation` → `MetricsPage` table | **PAGE-LEGIT** | keep; honesty loop closes (withheld cells labeled, contributor counts shown) |
| View engagement / north-star metrics (weekly meaningful progress, D7/D30 retention, completion/abandonment, recovery) | GET `/engagement` → table | **PAGE-LEGIT** | keep; named-predicate definitions, k-floor on human counts |
| View factory-quality metrics (candidates-by-state, publish rate) | GET `/factory` → chips + table | **PAGE-LEGIT** | keep |
| View verifier FP/FN quality (sampled/resolved/agreed/FP/FN, disagreement rate) | GET `/verifier-quality` → chips | **PAGE-LEGIT** | keep; denominator always stated, null-until-graded |
| Grade a sampled verdict (human agree/disagree) | `metrics-verifier-sample` approval → reviews inbox approve/reject | **RIDES** | leave alone — approvals owner + reviews inbox + redactor all instantiated |
| **Mint a verifier sample for grading** | `POST /verifier-sample` | **THEATER** | ignite it: a scheduled/deterministic sampler (or an admin action) that calls `sampleVerdict` — otherwise stop claiming a verifier-quality metric |
| **Read metrics from chat (KickBot / insights)** — ADR 0432 P5 claim | `outcome-metrics` node reads ctx surface but is in no toolAllowlist | **THEATER** | allowlist the node into KickBot's chat tools (and confirm it projects), or drop the "may READ metrics" claim |

Counts: RIDES 1, ADAPTER 0, PARALLEL 0, THEATER 2, PAGE-LEGIT 4.

## Blockers (from scouting) — each with the honest alternative

- **B1 — The verifier-quality metric has no source of samples.** `sampleVerdict`
  is never called by the app (`routes.ts:61` is the only caller-of-record, and
  nothing calls the route). So `verifierQuality` (`verifierSampleService.ts:125`)
  will report `sampled: 0, resolved: 0, disagreementRate: null` forever, and the
  page's verifier section shows only the "ungraded" notice (`MetricsPage.tsx:183`).
  ADR 0432 P3 promised "**a deterministic sample of goal verdicts** becomes
  approvals" — there is a per-enrollment idempotent minter but **no sampler that
  selects verdicts and drives it**.
  *Honest alternative:* the ignition belongs to the **scheduler**, not chat — this
  is periodic QA sampling, not an intent a user describes. Add a scheduled job (or
  a heartbeat task) that enumerates recently-judged enrollments, picks a
  deterministic sample, and calls `sampleVerdict` per enrollment. The approval
  each mints already rides the reviews inbox. Until that exists, mark the
  verifier-quality section **deferred-visibly** (it already is, via the ungraded
  notice — but the ADR must stop asserting the metric is live).

- **B2 — The chat-read of metrics is unwired.** `outcome-metrics`
  (`index.mjs:513`) is a correct thin read node over the ctx surface, but it is in
  no agent toolAllowlist and no workflow, so KickBot/insights cannot invoke it —
  ADR 0432 P5's "KickBot/insights may READ metrics" is a claim with no path.
  *Honest alternative:* if metrics-in-chat is wanted, add `outcome-metrics` to
  KickBot's (or the insights agent's) toolAllowlist **and verify it projects into
  a conversational tool** (the cross-cutting silent-drop check). If not wanted,
  delete the P5 clause and the node — a dead node is drift the `/grade-node-packs`
  pass will flag.

- **B3 — Self-grading is not blocked at the metrics seam.** `sampleVerdict` sets
  `submittedBy = subjectOf(req)` (`routes.ts:69`) and the approval is a generic
  community approval; the reviewProjection offers approve/reject to any admin
  including the submitter. For a genuine FP/FN audit the grader should differ from
  the minter (the ADR 0415 challenge-publish separation-of-duties precedent). Not
  a chat-port blocker, but a metric-integrity note to carry into B1's sampler
  design (mint on behalf of the tenant/system, not a self-submitting admin).

## Demolition list (with regression pins)

Almost nothing to demolish — the page is legitimately page-shaped and the writes
already ride owners. The only items:

- **If B2 is resolved by deletion:** remove the `outcome-metrics` node
  (`index.mjs:513-528`, `pack.json:269-276`) and ADR 0432 P5's KickBot-read
  clause. *Regression pin:* a pack-parity test asserting no dead node typeId
  (a resurrected unreferenced node fails `/grade-node-packs`).
- **No bespoke approve/submit UI exists to demolish** — grading already goes
  through the reviews inbox. *Regression pin:* a test asserting `MetricsPage`
  renders no POST/mutation control (it must stay read-only), and that
  `metrics-verifier-sample` decisions flow only through the approval decide path.

## New-code inventory (small — mostly ignition + a doc correction)

- **One scheduled sampler** (B1): a heartbeat/scheduler task that selects a
  deterministic sample of recently-judged enrollments and calls the existing
  `sampleVerdict` per enrollment. No new store — the sample rows and approvals
  already exist. Mint as system/tenant, not a self-submitting admin (B3).
- **One toolAllowlist edit** (B2, only if chat-read is wanted): add
  `feature.kicktodo.nodes.outcome-metrics` to KickBot's allowlist + a projection
  assertion test. Otherwise a deletion (see demolition).
- **ADR 0432 correction note**: the implemented endpoints are a **subset** of the
  ADR's declared shape — `signupToFirstPlanP50`, `intakeAbandonmentByStep`,
  `completionRateByDifficulty`, `killSwitchActivations`, `timeToPublishP50` are in
  the ADR Decision block but **not** in `metricsService.ts`/`verifierSampleService.ts`.
  The code is honest (it doesn't fake them), but the ADR over-claims. Add an inline
  correction note listing what actually ships vs what is deferred.
- No new envelopes, no new owner, no new store, no RFC (host-extension routes).

## Phased plan (real gates; compliance/honesty first, no demolish-before-replace)

1. **P1 — Honesty first (ADR + docs).** Add the ADR 0432 correction note (shipped
   subset vs deferred metrics; verifier-quality is dormant until a sampler exists).
   No code. Gate: doc review. This stops the feature *claiming* live metrics it
   cannot produce.
2. **P2 — Ignite the sampler (B1/B3).** Scheduled deterministic sampler → existing
   `sampleVerdict`, minting on behalf of the system so the grader ≠ minter. Only
   after this lands does verifier-quality report real numbers. Gate: `npm run ci`
   (backend vitest — pin: sampler is idempotent per enrollment, reuses legacy ids
   per `verifierSampleService.ts:84-87`, never double-counts). Close with
   `/code-review`.
3. **P3 — Decide chat-read (B2).** Either allowlist `outcome-metrics` into KickBot
   + projection test, or delete the node + P5 clause + add the dead-node pin. Gate:
   `/grade-node-packs` + `npm run ci`. Close with `/code-review`.
4. **P4 — Page polish only.** The metrics page already passes the honesty-loop
   test; run `/ux-review` for withheld-cell/denominator clarity in all 4 locales.
   No structural change.

## Deferred honestly

- **Verifier FP/FN quality is dormant, not broken** — it will read `sampled: 0`
  until P2's sampler ships. The page already shows this truthfully via the
  "ungraded" notice (`MetricsPage.tsx:183-184`); the ADR must match.
- **Chat-read of metrics is a claim, not a capability** until B2 is resolved one
  way or the other.
- **The five ADR-declared-but-unimplemented sub-metrics** (intake abandonment by
  step, completion-rate-by-difficulty, kill-switch activations, time-to-publish
  p50, signup-to-first-plan p50) are deferred — record them, don't paint them.
- **Scale rollup** is deferred by design with a falsifiable trigger
  (`metricsService.ts:14-18`) — leave as-is.
