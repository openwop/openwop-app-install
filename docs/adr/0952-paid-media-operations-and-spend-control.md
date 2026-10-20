# ADR 0952 — Paid media operations and spend control

Status: Proposed

**Date:** 2026-10-19
**Program:** Campaign Studio (ADRs 0941–0962), Tier 2. Plan: the program brief
(David, 2026-10-19). Net-new planning, not a MyndHyve port.
**Feature:** **extends `campaign-intel`** (caps, pacing actions, reallocation) and
**`campaign-connectors`** (status reads, catalog feeds); the adapter change lands in
`host/adsAdapter.ts`. No new toggle.
**Depends on:** 0941 (canonical campaign), 0942 (autonomy gate), 0907 (account metrics,
sandbox-verified readers). **Composes:** 0160/0220/0357 campaign intelligence, 0167/0223
ad dispatch, 0922 destinations, 0921 client accounts, 0410 catalog, 0945 product-grounded
creative. **Feeds:** 0950 (traffic shifting). **Integrates with, not depends on** (later
tiers): 0956 (incrementality; D3 reallocation defaults to measured ROAS once 0956
lands) and 0960 (D4 alert links open the command center once it exists, else the
Campaign Intelligence page).
**RFC verdict:** **host-extension — no RFC.** See § RFC verdict.

## Context

Ads are created PAUSED today and a human activates them on the platform. Budgets can
be changed through one gated write. Pacing raises alerts at 80% and 100% of plan and
does nothing else. So the app can draft and stage paid media, but it cannot launch,
cannot stop a runaway campaign, and cannot move money between channels as one
governed action.

Competitive frame (brief § Paid ads): Google PMax and AI Max are "transparency without
control"; Meta Advantage+ swaps creative silently; Smartly's cross-platform predictive
budget allocation (xPBA) moves money across channels but logs no human decision. No one
pairs budget moves with role-routed approvals, hard caps and a replayable record.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/`.

**What exists (single owners):**

| Concept | Owner | Evidence |
|---|---|---|
| Ad dispatch, created PAUSED | `host/adsAdapter.ts` | header contract (`:3,22`); Meta/Google/TikTok/LinkedIn strategies (`:475,581,663,756`); `STRATEGIES` table (`:825`) |
| Adapter interface | same | `AdsAdapter` = publishAd, syncAudience, listDispatches, sendConversion, getMetrics, getAccountMetrics, updateBudget (`:1243-1275`) — **no pause/activate** |
| Budget write | same | `updateBudget` (`:1414-1438`): meta + google only, tiktok/linkedin `unsupported` (`:1428-1430`); "never unpauses" (`:1273`) |
| Spend gate | same | `evaluateSpendGate` (`:339-382`): `actionPolicy['ads.publish' \| 'ads.budget']`, `adSpend.approvalThresholdMinor` (`host/governanceService.ts:82-84`) → `campaign-spend` approval (`host/approvalService.ts:44,1392`), fork-stable `spendKey` map (`adsAdapter.ts:310-311`) |
| Dispatch ledger | same | `AdDispatchRecord` with `briefId`, `platformCampaignId`, `adAccountId` (`:221-237`); tombstoned, never deleted (`:239-250`) |
| Readers | same + 0907 | `getAccountMetrics` per platform, TikTok/LinkedIn honest-off until sandbox-verified (`:1441-1444`); merged #4920/#4935/#4936; #4937 (Google conversions) and #4938 (hourly conversions delivery) open |
| Platform versions | `host/adsWire.ts` | `ADS_API_VERSIONS` pin table (`:34-54`) |
| Pacing | `features/campaign-intel/pacing.ts` | bands ok/warning/over (`:24,64`); CAS-claimed escalation memo (`:54,105-150`); joins spend to campaign by id **or by name** (`:75`) |
| Budget math | `features/campaign-intel/intelligence.ts`, `budgetPlanner.ts` | `optimizeBudget` (`intelligence.ts:41`), `planBudget`/`scenarioShift`/`detectAnomalies` (`budgetPlanner.ts:78,154,184`) |
| Apply-through-gate | `features/campaign-intel/routes.ts` | `POST …/recommendations/apply` → `adapter.updateBudget` (`:117-145`) |
| Campaign plan | `features/campaign-orchestration/types.ts` | `MarketingCampaign.budget: BriefBudget` (`:32`; `campaign-brief/types.ts:53-60` = `totalMinor`, `currency`, `perChannel`) |
| Destinations | `features/campaign-ops/types.ts` | `DestinationAdapter` (`:89-100`); kinds = `openwop.cms.page` only (`:33-34`) |
| Scheduled checks | `campaign-sync` chain pack | `campaign-sync.daily-metrics`, `campaign-sync.pacing-check` (`examples/workflow-chain-packs/campaign-sync/pack.json`) |
| Connections | RFC 0095 packs | `examples/connection-packs/{meta-ads,google-ads,tiktok-ads,linkedin-ads}` |

**Different concepts, not duplicates:** `host/workflowBudgets.ts` and
`host/runBudgetService.ts` (ADR 0482) cap model/run cost, not media spend. This ADR
does not touch them.

**Findings (closed below unless marked):**

| # | Finding | Evidence |
|---|---|---|
| P1 | No pause or activate operation exists, so neither governed launch nor auto-pause is possible | `AdsAdapter` (`adsAdapter.ts:1243-1275`) |
| P2 | **The spend gate fails OPEN.** A governance-policy read error is "treated as unset", which allows the live write | `adsAdapter.ts:348` (and the audience gate, `:1320`) |
| P3 | ADR 0357 §3 promises "pause" recommendations and "applied/skipped outcomes stamp back onto the recommendation". Neither exists: no pause op, and the apply route returns the result without recording it | `0357…md:40-42`; `campaign-intel/routes.ts:117-145`; no `applied` anywhere in `features/campaign-intel/` |
| P4 | Pacing's name fallback (`r.campaignName === campaign.name`) is safe for an alert, not for enforcement | `pacing.ts:75` |
| P5 | Reallocation is one platform at a time; a two-leg move has no ordering or atomicity rule | `routes.ts:117-145` |
| P6 | `publish-ad-variants` is `role: action`, not `side-effect`; the dispatch ledger is what prevents a duplicate paid object on fork | `packs/feature.campaign-channels.nodes/pack.json`; `adsAdapter.ts:239-250,432-449` |
| P7 | The `meta-ads` connection pack authorizes against Graph `v19.0` while the adapter calls `v25.0` (not fixed here; filed against 0907) | `examples/connection-packs/meta-ads/pack.json`; `adsWire.ts:42` |
| P8 | No product feed exists; catalog ads have nothing to point at | no feed/Merchant code in `features/commerce/` |

## Decision

### D1 — Delivery status on the ONE adapter

`AdsAdapter` gains one method; each platform strategy owns its status literal, as it
already does for creation:

```ts
setDeliveryStatus(args: {
  platform: AdPlatform; adAccountId: string; campaignId: string;
  status: 'paused' | 'active';
  reason: { kind: 'launch' | 'cap' | 'pacing' | 'operator' | 'promotion'; ref?: string };
  dryRun?: boolean;
}): Promise<
  | { outcome: 'updated' | 'unchanged'; platform: AdPlatform; status: 'paused' | 'active' }
  | { outcome: 'requires_approval'; approvalId: string }
  | { outcome: 'refused'; error: 'cap_exceeded' | 'cap_unenforceable' | 'policy_unreadable' | 'policy_disabled' }
  | { outcome: 'no_connection' } | { outcome: 'unsupported'; platform: AdPlatform }
  | { outcome: 'failed'; error: string }>;
```

- **`paused` is never gated.** Stopping spend is the safe direction. It is audited
  (`campaign.ads.paused`), notified and idempotent (`unchanged` when already paused).
- **`active` is the launch.** It passes, in order: the 0942 gate for action class
  `ads.launch` (frozen at run start; role, quorum, SLA), then the cap check (D2). It is
  refused when a cap exists on a platform this adapter cannot both read spend for and
  pause (`cap_unenforceable`), so a cap is never decorative.
- Writes are platform-native: Meta `status`, Google `campaign.status`, TikTok
  `operation_status`, LinkedIn campaign `status`. Each body is built in `adsWire.ts`
  so `scripts/ads-sandbox-verify.mjs` verifies the shipped shape (ADR 0907 D0). A
  platform ships live only after its sandbox row passes; until then it is `unsupported`.

**P2 fix:** for every live mutation (`publishAd`, `updateBudget`, `setDeliveryStatus
active`, `syncAudience`) a governance read failure returns `policy_unreadable`. Pause
stays available. This changes observable behaviour (a transient storage error now
blocks a launch), which is the point.

### D2 — Hard spend caps with auto-pause

```ts
// features/campaign-intel — DurableCollection('campaign-intel:spend-cap'), key tenant::orgId::capId
interface SpendCap {
  capId: string; tenantId: string; orgId: string;           // org = client (ADR 0921)
  scope: { kind: 'campaign'; campaignId: string } | { kind: 'client' };
  limitMinor: number; currency: string;
  period: 'lifetime' | 'calendar-month';
  onBreach: 'pause';                                         // v1: pause only
  maxStaleMinutes: number;                                   // default 180 (Q2)
  version: number; createdBy: string; createdAt: string; updatedAt: string;
}
// DurableCollection('campaign-intel:cap-state'), key tenant::capId::periodKey
interface CapState {
  spentMinor: number | null; readAt: string | null; readError?: string;
  status: 'ok' | 'near' | 'breached' | 'stale';
  pausedTargets: Array<{ platform: AdPlatform; campaignId: string; at: string }>;
  version: number;
}
```

**Two layers, because synced spend lags real spend.**

1. **Platform-native ceiling at launch.** When a campaign-scoped cap exists, launch
   first writes the platform's own lifetime/total limit where one exists (Meta campaign
   `spend_cap`; LinkedIn campaign `totalBudget`; TikTok `BUDGET_MODE_TOTAL`; Google
   where the campaign type supports a total budget). Each must pass the sandbox
   harness before it is relied on. The platform then stops spend itself, with no
   polling delay.
2. **Host watchdog (the cross-platform and client-level cap).** The
   `campaign-sync.pacing-check` chain gains a `feature.campaign-intel.nodes.enforce-caps`
   node (`role: side-effect`). Per cap it reads spend from `getAccountMetrics`
   (ADR 0907 D3), **joining platform campaigns to the MarketingCampaign only by id**:
   the dispatch ledger's `briefId` → the campaign's `briefId` (one campaign per brief,
   `campaign-orchestration/types.ts:18`). Name matches are never counted (P4). A client
   cap sums every campaign in the client's connected ad accounts, dispatched by us or not.

**Enforcement is CAS and idempotent.** The node CASes `CapState` from `ok|near` to
`breached` (`compareAndSwap`, the `pacing.ts:126-150` pattern). Only the winner calls
`setDeliveryStatus(paused)` for each target and appends to `pausedTargets`; a loser or a
re-run sees `breached` and only re-checks that each target is still paused. A pause
that fails leaves `breached` set, so the next tick retries it.

**Fail-closed.** A failed or rate-limited read sets `readError` and does not pretend
spend is zero (the 0907 honesty rule: `null` ≠ `0`). If the last good read is older than
`maxStaleMinutes`, the cap goes `stale` and the node **pauses**, as if breached, and
notifies with reason `spend_unreadable`. While a cap is `breached` or `stale`, D1 refuses
`active`. Raising the cap is a gated action (D4) and re-arms the state.

### D3 — Cross-channel reallocation as a gated plan, on existing math

No fourth spend-math module. `intelligence.ts` `optimizeBudget` stays the optimizer;
`budgetPlanner.ts` stays the planner; `pacing.ts` stays the band logic and gains the cap
bands. This ADR adds the **action**:

```ts
interface ReallocationPlan {
  planId: string; tenantId: string; orgId: string; campaignId?: string;
  source: { kind: 'optimizeBudget' | 'planBudget' | 'agent'; recommendationHash: string };
  ops: Array<{ platform: AdPlatform; adAccountId: string; campaignId: string;
               fromDailyMinor: number; toDailyMinor: number }>;   // decreases sorted first
  planHash: string;   // sha256 of the canonical ops
  status: 'proposed' | 'approved' | 'applying' | 'applied' | 'partial' | 'rejected' | 'expired';
  results: Array<{ opIx: number; outcome: string; at: string }>;
}
```

- Run as chain **`campaign-intel.reallocate`** (in `core.openwop.workflows.campaign-sync`
  or a new `campaign-intel` chain pack): `budget-optimize` (existing node) →
  `propose-reallocation` (NEW, pure; builds `ops` and checks the caps) →
  `feature.campaign-orchestration.nodes.autonomy-gate` (0942 class `ads.budget`,
  approval bound to `planHash`) →
  `apply-reallocation` (NEW, side-effect).
- **Decreases first, then increases.** A failure part-way through under-spends, never
  over-spends. Each op calls `updateBudget` with a deterministic spend key
  `realloc:<planId>:<opIx>`, so a retry or `:fork` does not double-apply. The plan ends
  `applied` or `partial` and records every op's outcome. That closes the P3 stamp-back
  for both this path and the existing one-click route, which writes the same record.
- An op that would push a campaign past its cap is dropped at propose time, with a reason.
- One approval covers the whole plan; the approver sees the before/after table and the
  projected effect from `scenarioShift`.

### D4 — Pacing alerts become actions

A `warning`/`over`/`breached`/`stale` notification carries up to three proposed actions:
**pause** (D1, ungated), **reallocate** (opens a D3 plan pre-filled), **raise cap**
(gated, class `ads.budget`). Each link opens the command center (ADR 0960) or the
Campaign Intelligence page with the action staged. A notification never applies a change.

### D5 — Platform coverage through the existing packs

TikTok and LinkedIn **dispatch already exists** (`adsAdapter.ts:663,756`) on the
`tiktok-ads` / `linkedin-ads` packs; their readers ship honest-off in #4936. This ADR
adds `updateBudget` and `setDeliveryStatus` writers for both, behind the same sandbox
gate. No new connection pack; any new scope is a write-scope group on the existing pack
(ADR 0024 Phase C re-consent).

### D6 — Catalog / dynamic product ads (late phase)

A product feed built from the commerce catalog (`commerce.product`, ADR 0410) by a
scheduled chain `campaign-sync.catalog-feed`, pushed to a Meta catalog (`items_batch`)
and, if David approves the account (Q4), Google Merchant Center. **Only real catalog
images** go into the feed (ADR 0945's rule). Feed pushes are side-effect nodes with
per-item content hashes, so an unchanged product is not re-sent. Catalog campaigns are
dispatched created-PAUSED through `publishAd` with a `catalog` objective, then launched
through D1.

### D7 — The ads destination wraps the adapter

ADR 0922's `DestinationAdapter` gains kind `openwop.ads.campaign`. `read` returns
status, budget and spend from `getMetrics` / `getAccountMetrics`; `write` accepts the
constrained edits `{dailyBudgetMinor, status}` and delegates to `updateBudget` /
`setDeliveryStatus`. **No second strategy table and no second gate**: the adapter stays
the one chokepoint (`adsAdapter.ts:296-308`).

### D8 — Agents

The Media Buyer (ADR 0943) is the existing Campaign Intelligence Analyst persona
(`vendor.openwop-app.campaign-intel.agents.intelligence-analyst`) widened by allowlist:
`openwop:campaign-intel.caps` (read), `openwop:campaign-intel.propose-reallocation`
(starts the D3 chain; returns `runId`). The agent proposes; the gate decides. It has no
tool that activates or raises a cap.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | `campaign-intel` (caps, plans, routes, nodes); `campaign-connectors` (feed); `host/adsAdapter.ts` + `adsWire.ts` (D1); `campaign-ops` adds one destination kind. No new feature. |
| 2 | Toggle | `campaign-intel` (stable, OFF, tenant) gates caps and reallocation; launch needs `campaign-channels` + a connection. Live writers per platform stay `unsupported` until sandbox-verified. |
| 3 | Workflow surface | `ctx.ads.setDeliveryStatus`; `ctx.features['campaign-intel']` gains `getCaps`, `proposeReallocation` (read/pure). |
| 4 | Node pack | `feature.campaign-intel.nodes` + `enforce-caps`, `propose-reallocation`, `apply-reallocation` (side-effect); `feature.campaign-channels.nodes` + `launch-ad` (side-effect); `feature.campaign-connectors.nodes` + `push-catalog-feed`. Chains `campaign-intel.reallocate`, `campaign-sync.catalog-feed`; `pacing-check` gains `enforce-caps`. |
| 5 | AI chat + envelopes | Chat tools only (D8). No new envelope kind. |
| 6 | Agent pack | Existing analyst persona, allowlist +2. |
| 7 | Public surface | None. |
| 8 | RBAC | Caps and plans are per client org via `authorizeOrgScope`; creating or raising a cap needs `workspace:write` on the client **and** an agency-admin approval when the 0942 policy says so; pause is `workspace:write`. |
| 9 | Replay / fork | 0942 policy frozen at run start; spend keys deterministic; pause idempotent; cap state is CAS'd outside the run, so a fork re-reads live state rather than replaying a stale breach. |
| 10 | Frontend | Campaign Intelligence page: caps panel per client and campaign, staleness badge, reallocation plan review, actionable pacing alerts. 4 locales. |

## Why this is our advantage

- **Control with transparency.** Every launch, pause and budget move is a run step with
  a named agent, a role-routed gate and a replayable record (thesis 1–3). PMax gives
  neither control nor explanation; Smartly gives allocation without a logged decision.
- **Caps that fail closed.** A cap that cannot read spend pauses rather than trusting
  stale numbers. No incumbent states this rule.
- **Per-client spend limits in an agency workspace** (thesis 4): a client cap can never
  be spent by another client's campaign.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | P2 fail-closed fix; `setDeliveryStatus` for meta + google, sandbox-verified | test: policy read throws → `policy_unreadable`; pause idempotent; activate requires gate |
| P1 | `SpendCap` + `CapState` + `enforce-caps` in `pacing-check`; id-only join | tests: concurrent ticks pause once; read failure past `maxStaleMinutes` pauses; breached refuses activate |
| P2 | Platform-native ceilings at launch (meta, then others as verified) | sandbox rows green per platform |
| P3 | `ReallocationPlan` + `campaign-intel.reallocate` chain + route stamp-back (P3) | partial-failure test leaves under-spend; fork does not re-apply |
| P4 | D4 actionable alerts; D8 agent tools | chat proposes a plan; approval applies it |
| P5 | TikTok + LinkedIn budget/status writers (after #4936 readers verify) | sandbox rows green |
| P6 | D7 ads destination | campaign-ops change set edits a budget through the adapter |
| P7 | D6 catalog feeds | feed push idempotent; catalog campaign created PAUSED |

## Alternatives weighed

- **A separate spend-control service with its own platform clients.** Rejected: a second
  egress path around the adapter's gate.
- **Auto-pause from the daily sync only.** Rejected: up to a day of overspend. Hence the
  native ceiling plus the watchdog.
- **Pause on any read error.** Rejected: transient API errors would stop healthy
  campaigns. `maxStaleMinutes` bounds the exposure instead.
- **Applying reallocation op-by-op without a plan.** Rejected: no atomic approval and no
  ordering rule (P5).
- **Fully automatic budget moves.** Allowed only when the 0942 policy for
  `ads.budget` resolves to `auto` within its limits; never the default.

## RFC verdict

**Host-extension — no RFC.** Platform calls ride Accepted RFC 0045/0046/0047/0079/0095,
exactly as ADR 0167 established. Caps, plans and routes live under
`/v1/host/openwop-app/campaign-intel/*`. No wire field, event type or capability changes.

## Open questions

1. **(David)** Live spend. Every live writer (launch, budget, pause, native ceiling,
   catalog push) needs a sandbox and then a real ad account per platform. All ship
   **disabled / `unsupported`** until David provides accounts and approves spend.
2. **(David)** Default `maxStaleMinutes`: 180 proposed. Lower stops sooner but pauses
   more healthy campaigns on API outages.
3. **(David)** Should a client cap be mandatory before any client campaign can launch?
   Proposed: yes for client orgs in `live` mode (ADR 0921 `mode`), optional for the
   agency's own org.
4. **(David)** Google Merchant Center and Meta catalog access for D6: accounts and scope.
5. Should P2's behaviour change (policy read failure blocks launch) also apply to
   `sendConversion`? Proposed: no; it carries no spend and is consent-gated.
6. File P7 (meta-ads OAuth `v19.0`) against ADR 0907 rather than fixing it here.
7. P6: should `publish-ad-variants` become `role: side-effect`? Proposed: yes, in P0,
   so fork safety does not rest on the ledger alone.

## Planning rows

- **ROADMAP Overview row:** `| 0952 | Paid media ops + spend control (extends campaign-intel/campaign-connectors) | \`campaign-intel\` | 0941, 0942, 0907 (composes 0160/0220/0357/0167/0223/0922) | \`feature.campaign-intel.nodes\`, \`feature.campaign-channels.nodes\`, \`feature.campaign-connectors.nodes\` | 🔵 Proposed | — (net-new) |`
- **FEATURES "Future features" row:** **Paid media operations + spend control (ADR 0952,
  Proposed)** — extends `campaign-intel` (toggle stable, OFF, tenant): governed launch
  (`setDeliveryStatus`, activate behind the 0942 gate, pause always allowed), hard
  campaign and client caps enforced by platform-native ceilings plus a fail-closed
  watchdog that auto-pauses, cross-channel reallocation as one approved plan
  (decreases first), actionable pacing alerts, TikTok/LinkedIn writers, catalog feeds.
  Every live writer ships disabled until sandbox-verified and David approves spend.
