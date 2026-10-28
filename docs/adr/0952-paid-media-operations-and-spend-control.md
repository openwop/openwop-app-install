# ADR 0952 — Paid media operations and spend control

Status: Accepted (2026-10-20). P0 code is complete: the spend gate fails closed (defect P2), and
`setDeliveryStatus` is built. Its sandbox-verification row stays OPEN until David's accounts exist. P1 (spend
caps and the auto-pause watchdog), P3 (reallocation as one approved plan) and P4 (actionable alerts, the Media Buyer
tools, the currency-aware spend threshold) are built. P2 (the Meta native ceiling at launch) is built, and its
writer stays unverified until David's sandbox exists. P5 (TikTok and LinkedIn budget and status writers) is built,
fixture-only and unverified, for the same reason. P7 (the product feed from the commerce catalog: a signed
feed URL plus an API push to Meta Catalog and Google Merchant Center) is built; the push is fixture-only and
unverified, and catalog campaigns are still OPEN. See § Implementation record.

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

> **Implementation note (2026-10-20, P0):** until ADR 0942 P3 places its autonomy gate inside
> `evaluateSpendGate`, a launch passes that function as kind `ads.launch` and always requires a
> `campaign-spend` approval. A launch has no budget to compare against a threshold, so an unset policy
> is not a licence to start spend. One approval authorizes one launch: it is consumed on success.
> 0942's chokepoint covers `ads.launch` with no second seam.

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

> **Correction (2026-10-20, P1):** the cap check runs BEFORE the spend gate, not after it. A launch that a
> breached, stale or unenforceable cap would refuse must not first open an approval a human then grants for
> nothing. Both checks still run on every launch; only the order changed. A cap checker that throws refuses
> the launch as `policy_unreadable` (fail closed). The result carries `capId` on a cap refusal.

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

> **Implementation notes (2026-10-20, P2, from the architecture review):**
> - **Only where the platform total IS the cap.** A native ceiling is set for a LIFETIME, campaign-scoped cap
>   whose campaign has exactly ONE platform campaign, and only then: that campaign's own lifetime spend is the
>   cap's spend. A calendar-month cap (a lifetime `spend_cap` would block next month), a client cap, or a cap
>   spread over several platform campaigns gets none. The launch result says why
>   (`ceiling: 'not_set:<period_not_lifetime | client_scope | multi_target | not_sandbox_verified>'`), and the P1
>   watchdog stays the guard. The launch check (`setAdsCapChecker`) carries the ceiling, so no new seam was added.
> - **Meta first.** The campaign `spend_cap` ("integer value of subunit in your currency", minimum about $100;
>   Meta campaign reference) is in Meta's own currency unit, converted like `daily_budget`. It is written BEFORE
>   the ACTIVE write. A verified writer that fails refuses the launch, so the campaign stays paused, with
>   Meta's own words (`ceiling_rejected:<message>`, for example a cap below the minimum). A cap in another
>   currency than the account is `cap_unenforceable`. Google, TikTok and LinkedIn ceilings come with their
>   writers (P5) once verified.
> - **Raising a cap does not move the native ceiling** until the next launch writes it. That errs toward
>   under-spend. A raise is a person's action on a route that has no ad connection in scope, so it never
>   writes to the platform.
> - **Sandbox:** `ads-sandbox-verify.mjs meta ceiling` writes `spend_cap` on one named TEST campaign through the
>   adapter's builder and reads it back. The PASS proves the unit, not just that Meta accepted the value. The
>   writer is `unsupported` until then (`OPENWOP_ADS_VERIFIED_CEILING_WRITERS`).

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

> **Implementation notes (2026-10-20, P1, from the architecture review):**
> - **Where it lives.** `features/campaign-intel/spendCaps.ts`. The adapter learns about caps through a
>   host seam, `setAdsCapChecker` (the `setAdsComplianceChecker` precedent), so the host never imports the
>   feature. The watchdog's one call is the surface method `enforceCaps`; like ADR 0907's scheduled
>   delivery it runs as the run owner, needs `workspace:write` in the org, and is `disabled` with the
>   `campaign-intel` toggle off.
> - **Periods.** `calendar-month` is the UTC month; ad accounts report in their own timezone, so a boundary
>   can be off by a day. `lifetime` reads a campaign cap from its earliest dispatch (minus a day) and a
>   client cap from the cap's creation.
> - **Stale baseline.** The latest of the cap's creation, the period start and the last good read. A new
>   month gets its own grace period, so one failed read on the 1st does not mass-pause.
> - **Client targets.** Every campaign with spend in the org's ad accounts, PLUS every campaign of ours in
>   those accounts that has not spent yet. Otherwise an active campaign with no spend would keep running
>   until a later tick.
> - **`cap_unenforceable`.** A covering cap exists, but its watchdog toggle is off for the tenant or the
>   platform's spend reader is not verified. A stored breach still refuses (`cap_exceeded`) whatever the
>   toggle says.
> - **A failed read never moves a state down.** A breach holds for the period until the cap is raised;
>   raising re-arms it from the last good read and never resumes delivery.
> - **Who may change a cap (interim, until P4 routes a raise through the ADR 0942 gate).** Creating or
>   lowering needs `workspace:write`, because it only ever stops spend. Raising or deleting needs
>   `host:org:manage`, which is held by the org owner.
> - **Concurrency.** Only the tick whose `CapState` CAS lands acts on a state change; a tick that loses the
>   race does nothing. A later tick that finds the cap already enforcing re-checks every target through the
>   adapter's read-first pause, which writes nothing when the target is still paused.
> - Breach and stale notifications use the new type `campaign.spend-cap` (high priority), so muting pacing
>   alerts does not mute a pause.

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

> **Implementation notes (2026-10-20, P3, from the architecture review):**
> - **The approval.** One `campaign-spend` approval (spendKind `reallocation`) per plan, carrying the
>   before/after table. When it is approved, `apply` maps each op's budget spend key (the hash `updateBudget`
>   computes) to it (`authorizeBudgetOps`), so `updateBudget`'s threshold gate finds an approved row while its
>   `disabled` / `draft-only` / `unreadable` checks still apply. Like any per-amount budget approval, the mapping
>   also covers a later set of that campaign to that exact amount.
> - **Correction: no autonomy-gate node yet.** ADR 0942 P2's `autonomy-gate` node does not exist, so the chain is
>   `budget-optimize → propose-reallocation → apply-reallocation`. In-run, `apply` returns `awaiting_approval`
>   and applies nothing. An approver applies the plan from the Campaign Intelligence page
>   (`POST …/reallocations/:planId/apply`, `workspace:write`, the caller's ad connections). When the gate node
>   lands it slots between `propose` and `apply`, and the run waits instead.
> - **"From" is read, never assumed.** A new adapter read, `getCampaignBudget`: Meta's campaign
>   `daily_budget`, or Google's campaign budget `amount_micros`. It sits behind the platform's verified reader.
>   (Meta: see the residual (b) correction below, which made it find the budget on the one ad set.) `apply`
>   re-reads before every op and does not overwrite a budget that moved (`stale_budget`).
> - **Mapping a platform shift to campaigns.** `optimizeBudget` recommends per PLATFORM. Each of the org's
>   dispatched campaigns on that platform (joined by brief id) is scaled by `(currentSpend + change) /
>   currentSpend`. Changes under 1% are left out, and no budget goes below 100 minor units.
> - **Caps at propose time.** An increase is left out when a covering cap is enforcing, has never been read, or
>   would be exceeded by spent + new daily budget × days left in the period (lifetime: one day). This counts only
>   this campaign's new budget, so it is a necessary check, not a sufficient one; the P1 watchdog stays the guard.
> - **Lifecycle.** A plan expires after 7 days and never applies after that, even if approved. `apply` is
>   claimed with a 5-minute lease, so a concurrent call is `in_progress` and a crashed one resumes, skipping
>   ops already recorded ok. A plan is idempotent per (tenant, org, run, planHash).
> - **Defect P9 — FIXED by #5082 (money).** Every budget unit assumed a 2-decimal currency (Google ×10⁴
>   micros, TikTok/LinkedIn ÷100, Meta passing ISO minor units through though Meta's offsets are its own).
>   `dailyBudgetMinor` is now ISO minor units of the ad ACCOUNT's currency, read from the platform before every
>   live budget write and converted in `adsWire.ts`; see ADR 0223's correction note. `getCampaignBudget` reads
>   through the same converters (Meta offset → minor; Google micros → minor), so a read-then-write round-trips in
>   every currency. This branch merges #5082, so it must land after it.
> - **Residuals filed by the P9 audit:** (a) the spend-gate threshold (`adSpend.approvalThresholdMinor`) named
>   no currency. **FIXED in P4:** see the D4 implementation notes. (b) Meta dispatch puts the daily budget on the AD SET,
>   while `updateBudget` wrote the CAMPAIGN budget, so Meta rejected every budget write for a campaign this
>   app dispatched, and a reallocation left them all out. **FIXED (2026-10-20, on #5078):** the Meta budget
>   read and write now find where the budget lives (`metaBudgetTarget`). That is the campaign's own
>   `daily_budget` (campaign budget optimization), else its ONE budgeted ad set (ad-set budgets, our dispatch
>   shape). An ABO campaign whose budget is split across several ad sets has no single daily budget to move,
>   so it is a typed failure (`budget_split_across_ad_sets`), never a guess. Dispatch keeps creating an ad-set
>   budget; that path is shipped, and switching it is a separate decision. Test: `ads-campaign-budget.test.ts`
>   (CBO write on the campaign, ABO write on the ad set, split refused with no write), sabotage-witnessed by
>   writing the campaign regardless.

### D4 — Pacing alerts become actions

A `warning`/`over`/`breached`/`stale` notification carries up to three proposed actions:
**pause** (D1, ungated), **reallocate** (opens a D3 plan pre-filled), **raise cap**
(gated, class `ads.budget`). Each link opens the command center (ADR 0960) or the
Campaign Intelligence page with the action staged. A notification never applies a change.

> **Implementation notes (2026-10-20, P4):**
> - **Alerts carry actions** (`features/campaign-intel/alertActions.ts`). A pacing `over` alert carries pause +
>   reallocate; `warning` carries reallocate; a cap breach carries raise-cap + reallocate (the watchdog already
>   paused); a stale cap carries raise-cap. Each is a deep link with `stage=<action>`, kept in
>   `metadata.actions`; the first is the notification's link. **A notification never applies a change.**
> - **The page stages, a person confirms.** Campaign Intelligence shows the staged action with what it does:
>   pause (`POST …/campaign-intel/pause`: every dispatched platform campaign of the campaign, ungated,
>   workspace:write); reallocate (`POST …/reallocations/propose`: one plan + one approval, nothing changes);
>   raise-cap (focuses the cap in the new caps panel, where raising needs the org owner until the ADR 0942
>   gate). The P1 caps had no UI; the panel (list, status, create, lower or raise, remove) lands here.
> - **No command center yet (ADR 0960):** links open Campaign Intelligence, as D4 allows.
> - **Residual (a) — the spend threshold has a currency.** `adSpend.approvalThresholdCurrency` (ISO; absent =
>   USD, the field's only meaning before). The spend gate reads the ad account's currency (one memoized read,
>   shared with the write's own conversion) and compares a budget against the threshold ONLY in the same
>   currency. A different account currency asks a person, and the approval text says why (no FX). An
>   unreadable currency compares as before; the write then fails closed on the same read.

### D5 — Platform coverage through the existing packs

TikTok and LinkedIn **dispatch already exists** (`adsAdapter.ts:663,756`) on the
`tiktok-ads` / `linkedin-ads` packs; their readers ship honest-off in #4936. This ADR
adds `updateBudget` and `setDeliveryStatus` writers for both, behind the same sandbox
gate. No new connection pack; any new scope is a write-scope group on the existing pack
(ADR 0024 Phase C re-consent).

> **Implementation notes (2026-10-20, P5):**
> - **TikTok works at the campaign level.** `operation_status` ENABLE / DISABLE goes through
>   `/campaign/status/update/`. The daily budget (`BUDGET_MODE_DAY`, major units of the advertiser currency)
>   goes through `/campaign/get/` and `/campaign/update/`. A campaign without a daily budget is
>   `no_daily_budget`. Our dispatch also sets an ad-group day budget; `updateBudget` changes the CAMPAIGN
>   budget, which caps the ad group, so a decrease always binds and an increase binds up to the ad-group
>   budget. That is the under-spend direction.
> - **LinkedIn works at the campaign GROUP level.** Our dispatch maps the group into the `campaignId` slot.
>   A pause patches the group, which pauses everything under it. A launch patches the group AND each
>   campaign in it to ACTIVE, because dispatch left the campaign PAUSED and an active group alone delivers
>   nothing. The daily budget lives on the group's ONE campaign; several campaigns have no single daily
>   budget and are refused with no write (`budget_split_across_campaigns`). Every update is a Rest.li
>   `PARTIAL_UPDATE` with a `{patch:{$set}}` body.
> - **Every writer and reader is `pending_sandbox`.** That covers status writers
>   (`OPENWOP_ADS_VERIFIED_STATUS_WRITERS`), the new budget-writer table
>   (`OPENWOP_ADS_VERIFIED_BUDGET_WRITERS`) and the budget readers (the existing reader gate). New sandbox
>   checks: `tiktok|linkedin delivery-status` (PAUSED on a named TEST campaign or group) and
>   `tiktok|linkedin budget` (major units through the adapter's builder). Native ceilings for these
>   platforms (TikTok `BUDGET_MODE_TOTAL`, LinkedIn `totalBudget`) are not built; P2's Meta ceiling is the
>   only one, and these platforms report `ceiling: not_set:platform_unsupported`.
> - Sources (not re-read live; the sandbox is the verification): TikTok API for Business v1.3 campaign
>   endpoints; LinkedIn Marketing API "Create and manage campaigns" (versioned REST).

### D6 — Catalog / dynamic product ads (late phase)

A product feed built from the commerce catalog (`commerce.product`, ADR 0410) by a
scheduled chain `campaign-sync.catalog-feed`, pushed to a Meta catalog (`items_batch`)
and, if David approves the account (Q4), Google Merchant Center. **Only real catalog
images** go into the feed (ADR 0945's rule). Feed pushes are side-effect nodes with
per-item content hashes, so an unchanged product is not re-sent. Catalog campaigns are
dispatched created-PAUSED through `publishAd` with a `catalog` objective, then launched
through D1.

> **Correction (2026-10-20, P7, team-lead decision Q4):** the feed has TWO outputs, not one.
> Besides the API push, it is served at a **signed public URL**
> (`/host/openwop-app/public/:orgId/catalog/feed.xml?v=&sig=`) that Merchant Center and
> Commerce Manager fetch on a schedule. That works with no API access at all, which is why
> it ships first. Google Merchant Center is in scope (Q4), through a new `google-merchant`
> connection pack. The chain is not scheduled by default: an operator schedules
> `campaign-sync.catalog-feed` per org. Catalog campaigns (`publishAd` with a `catalog`
> objective and Meta's `promoted_object.product_catalog_id`) are **not built**: the request
> shape cannot be checked without a sandbox catalog, so that row stays OPEN.

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

> **Implementation note (2026-10-20, P4):** `propose-reallocation` calls the same `proposeReallocation` service
> as the chain's node (one owner) and returns `{ planId, approvalId, ops, dropped }`, not a `runId`; there is no
> run to start for a proposal. It needs workspace:write (a viewer is refused) because it reads live budgets
> through the person's ad connections and opens an approval. Both tools are allowlisted on the analyst only,
> not the ADR 0315 default-on baseline, and have rows in `docs/steward/LLM-EXCHANGE-AUDIT.md`.

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

## Implementation record

| Phase | Part | PR | Commit | What landed |
|---|---|---|---|---|
| P0 | Defect P2: spend gate fails closed | #5035 | `c0cf19263` | `evaluateSpendGate` returns `unreadable` when `getGovernancePolicy` throws, so `publishAd` and `updateBudget` return `policy_unreadable` with no platform call; the audience gate (`syncAudience`) refuses the same way. Dry-run previews still work. Test: `ads-spend-gate-fail-closed.test.ts` (fixture server, zero calls); restoring either catch turns 3 of its 5 tests red. |
| P0 | `setDeliveryStatus` (meta + google) | #5065 | `a0614d331` | `AdsAdapter.setDeliveryStatus` (D1). **Pause is never gated** (it still runs with the policy unreadable or the circuit open) and is idempotent: it reads the status first and returns `unchanged` with no write. **Activate is a launch:** it goes through the spend gate as `ads.launch`, which by default requires a `campaign-spend` approval (`spendKind: 'launch'`); unreadable/disabled policy refuses and `draft-only` previews. **The approval is consumed** on a successful launch, so a re-launch asks again. Writes are platform-native and built in `adsWire.ts` (Meta `status PAUSED/ACTIVE`; Google `campaigns:mutate` `PAUSED/ENABLED`, `updateMask: status`). A removed campaign fails; it is never re-enabled. Events `host.campaign.ads.paused` / `.activated`. Method gate: `campaign-channels`. Tests: `ads-delivery-status.test.ts` (7, fixture server). Sabotage witnesses: gating pause, skipping the consume step, skipping the read-first check, dropping the writer gate, or dropping the Google numeric-id guard each turns it red. A non-numeric Google id is refused rather than stripped, so the status read and the mutate always name the same campaign. The sandbox script gains `delivery-status` (Google `validateOnly`; Meta PAUSED on a named TEST campaign only). |
| P0 | Sandbox verification of the two writers | — | — | **OPEN — needs David's sandbox accounts.** Both writers are `unsupported` (`not_sandbox_verified`) until `ads-sandbox-verify.mjs <meta\|google> delivery-status` passes and the operator lists them in `OPENWOP_ADS_VERIFIED_STATUS_WRITERS`. Never faked green. |
| P1 | `SpendCap` + `CapState` + `enforce-caps` in `pacing-check`; id-only join | #5072 | `36f3a99c6` | `features/campaign-intel/spendCaps.ts`: caps (`campaign-intel:spend-cap`) and per-period state (`campaign-intel:cap-state`). Routes `GET/POST /campaign-intel/caps` and `PATCH/DELETE /campaign-intel/caps/:capId`. Node `feature.campaign-intel.nodes.enforce-caps` 1.0.0 (`role: side-effect`; pack 1.3.0) is a second root in `campaign-sync.pacing-check` 1.1.0 (pack 1.5.0). The launch check is wired through the new adapter seam `setAdsCapChecker`. A creator is tombstoned on erasure (`eraseCampaignIntelSubject`). Tests: `campaign-intel-spend-caps.test.ts` (8) covers concurrent ticks pausing ONCE, a stale read pausing, a breach refusing a launch, an unenforceable cap refusing, the client-cap target set, mixed currency, raise re-arm, the node/surface identity rules and the route RBAC. `ads-delivery-status.test.ts` (+1) shows a cap refuses a launch before any approval opens, a throwing checker refuses, and pause ignores caps. `workflow-chain-campaign-sync-execution.test.ts` runs the chain through the real loader and executor with a cap present, and pins `pace` as the single primary output (the `caps` root is listed first, because expansion marks the LAST terminal node primary). An org with no caps needs no acting user, so existing pacing schedules keep running green. Sabotage witnesses each turn it red: ignoring a lost CAS, counting a failed read as zero, joining every row rather than by id, the launch check ignoring a breach, the adapter skipping the checker, and stale not enforcing. Ratchets regenerated with their generators: side-effect floor 351 → 352 (served 276 → 277), steward manifest, pack-surface arg parity (asserted pairs 286 → 287). |
| P3 | `ReallocationPlan` + `campaign-intel.reallocate` + route stamp-back | #5078 | `0392b34ad` | `features/campaign-intel/reallocation.ts` (`campaign-intel:realloc-plan`). The adapter gains `getCampaignBudget` (method gate `campaign-connectors`) and `authorizeBudgetOps`. Nodes `propose-reallocation` and `apply-reallocation` 1.0.0, both `role: side-effect` (pack 1.4.0). Chain `campaign-intel.reallocate` 1.0.0 (campaign-sync pack 1.6.0). Routes: `GET …/reallocations`, `POST …/reallocations/:planId/apply`; the one-click `/recommendations/apply` route now stamps its outcome into the same store (closes finding P3). Campaign Intelligence page: a reallocation-plans panel (before/after, outcome per op, apply, link to Inbox), in 4 locales. Tests: `campaign-intel-reallocation.test.ts` (8) covers live "from", unreadable dropped, cap-blocked increase dropped, one approval idempotent per run, waits for approval, a fork re-applies nothing, a failed decrease skips increases (under-spend), stale budget, expiry, rejection, a concurrent apply claimed once, and the route stamp-back. `ads-campaign-budget.test.ts` (2, fixture server) covers the budget read (Meta/Google/ABO) and that one plan approval covers its ops while an op outside the plan still asks. The chain also runs through the real loader and executor. FE: `reallocationPlans.test.tsx` (3). Sabotage witnesses each turn it red: increases sorted first, no stale check, no expiry, no claim, authorizing an unapproved approval, increases not held after a failed decrease. Ratchet: seeded-chain ceiling 127 → 128 (declared). |
| P4 | D4 actionable alerts; D8 agent tools; residual (a) | #5093 | `3be26ec2a` | `alertActions.ts` + `metadata.actions` on pacing and cap notifications; routes `POST …/campaign-intel/pause` and `POST …/reallocations/propose`; `pauseMarketingCampaign`. FE: `SpendCapsPanel` (the P1 caps get a UI) and `StagedAlertAction` on Campaign Intelligence, in 4 locales. Agent pack `vendor.openwop-app.campaign-intel.agents` 1.3.0: `caps` + `propose-reallocation`. Governance `adSpend.approvalThresholdCurrency` + a currency-aware spend gate. Tests: `campaign-intel-spend-caps` (+2: alert actions, pause/propose RBAC and coverage), `campaign-intel-agent-tools` (parity, viewer refused to propose), `campaign-intel-reallocation` (+1: re-proposal after a finished plan), `ads-budget-currency-units` (+1: USD vs JPY accounts against a USD threshold, a JPY threshold), FE `spendCapsAndStaged.test.tsx` (4). **TikTok AIGC flag (for ADR 0945 D6, team-lead request):** `PublishAdArgs.aiGeneratedMedia` sets the creative's `aigc_disclosure_type` (field documented on TikTok Marketing API v1.3 Get ads, https://business-api.tiktok.com/portal/docs/get-ads/v1.3, read 2026-10-20). Its VALUE (`SELF_DISCLOSURE`) is unconfirmed from the docs, so it is `pending_sandbox`: an AI ad to TikTok is refused `aigc_flag_not_verified` (never published unlabelled) until `ads-sandbox-verify.mjs tiktok aigc-disclosure` (read-only) reads that value back from a TEST ad toggled in Ads Manager and the operator lists `tiktok` in `OPENWOP_ADS_VERIFIED_AIGC_FLAGS`. The 0945 gate can then consult `adsAigcFlagEnabled('tiktok')`. Tests: `ads-adapter-tiktok` (+1, sabotage-witnessed) and `ads-sandbox-verify-script` (+1). |
| P2 | Platform-native ceilings at launch (Meta) | #5099 | `9c18f0f36` | `AdsCapVerdict.ceiling` / `noCeiling` from `checkLaunchAgainstCaps`; `setDeliveryStatus` writes Meta `spend_cap` before ACTIVE (`buildMetaSpendCapBody`, `adsCeilingWriterEnabled`); the result's `ceiling` says `set` or `not_set:<reason>`. Tests: `ads-delivery-status` (+1: unverified ⇒ watchdog only and said so; verified ⇒ spend_cap then status, in that order; below-minimum refuses with the campaign left paused; currency mismatch refuses), `campaign-intel-spend-caps` (+1: ceiling only for a lifetime single-target cap, reasons otherwise), `ads-sandbox-verify-script` (+1: write plus read-back). Sabotage witnesses each turn it red: ignoring a rejected ceiling, offering one for a multi-target cap, skipping the ceiling. |
| P2 | Sandbox verification of the Meta ceiling writer | — | — | **OPEN — needs David's sandbox accounts.** |
| P5 | TikTok + LinkedIn budget/status writers | #5104 | `7c5cd85e9` | `setDeliveryStatus`, `updateBudget` and `getCampaignBudget` for TikTok (campaign) and LinkedIn (campaign group, with the budget on its one campaign); builders in `adsWire.ts`; `ADS_BUDGET_WRITER_STATUS` plus `adsBudgetWriterEnabled`; status-writer table widened; sandbox checks `delivery-status` and `budget` for both. Tests: `ads-tiktok-linkedin-writers.test.ts` (5, fixture server: unverified ⇒ unsupported with no call; TikTok DISABLE/ENABLE, idempotent, JPY/KWD budgets, no daily budget; LinkedIn group pause, group+campaign launch, PARTIAL_UPDATE, one-campaign budget, split refused), `ads-sandbox-verify-script` (+1). Sabotage witnesses each turn it red: launch patching the group only, a budget ignoring the currency, dropping the budget-writer gate. Also fixed the shared test fixture's LinkedIn account-currency match, which was answering sub-resource reads. |
| P5 | Sandbox verification of the TikTok and LinkedIn writers | — | — | **OPEN — needs David's sandbox accounts.** |
| P7 | D6 catalog feeds: signed feed URL + API push (Q4) | #5112 | `08de7d0bb` | `features/campaign-connectors/catalogFeed.ts` builds the feed on request from `listProducts` (ADR 0410), so there is no second product store. Only active products with a price and at least one catalog image (`imageAssetTokens`, the product's own media; never ADR 0945 AI concept assets) go in; the rest are listed with a reason (`no_image`, `no_price`, `invalid_currency`). Fields follow Google's product data spec: `id` (a variant's id is a stable 43-character digest, under Google's 50-character cap), `title`, `description`, `link`, `image_link`, `additional_image_link`, `availability`, `price` ("12.34 USD" in the currency's own decimals), `condition`, `item_group_id`, `product_type`, `brand` (the org's name) and `identifier_exists: no`. Cost and raw inventory never appear. RSS 2.0 with the `g:` namespace, which both Merchant Center and Meta read. **Signed URL:** HMAC-SHA256 with the session secret over `catalog-feed:<tenant>:<org>:<version>`, compared timing-safe; rotate bumps the version, so every earlier URL dies. An unknown org, the toggle off (toggle + plan, `resolveOne`), a lapsed owner (ADR 0820 §7), a disabled feed and a bad or rotated signature all answer the same 404; `cache-control: private, max-age=300`, so no shared cache outlives a rotate. Settings: `campaign-connectors:catalog-feed` (enabled, version, Meta catalog id, Merchant account + data source, content language, feed label). Routes `GET/PUT …/orgs/:orgId/catalog-feed`, `POST …/rotate`, `POST …/push` (workspace:read/write). **Push** (`host/catalogPushAdapter.ts`, the one egress owner): Meta `items_batch` (UPDATE with `allow_upsert`, DELETE; per-item `validation_status`), over the `meta-ads` connection's new `catalog.manage` group (`catalog_management`, pack 1.2.0); Google Merchant API products v1 `productInputs:insert` and DELETE by `contentLanguage~feedLabel~offerId`, price as exact `amountMicros`, over the new `google-merchant` connection pack (scope `auth/content`). `pending_sandbox` per platform (`OPENWOP_ADS_VERIFIED_CATALOG_PUSH`). A per-item ledger (`campaign-connectors:catalog-push`) sends only changed items, removes items that left the feed, and moves only on items the platform accepted, so a refused item is retried. Node `feature.campaign-connectors.nodes.push-catalog-feed` 1.0.0 (`role: side-effect`, pack 1.6.0; unverified and all-refused are typed failures, never success-with-nothing). Chain `campaign-sync.catalog-feed` 1.0.0 (pack 1.7.0). FE: a product-feed card on Campaign Connectors (publish, copy, replace URL behind a confirm, target ids, send now), in 4 locales. Sandbox check `ads-sandbox-verify.mjs <meta\|google> catalog-push` (one test item). Tests: `ads-catalog-feed.test.ts` (9: feed contents, signed URL, a save never building on a failed read, settings RBAC, push gating, Meta changed-only/removal/retry, Google insert/delete, micros, node), `workflow-chain-campaign-sync-execution.test.ts` (+1, real loader + executor: feed off completes `disabled`; no public origin fails `not_configured`; unverified fails `connector_not_configured`, checked before the nothing-to-send shortcut), FE `catalogFeed.test.tsx` (4). Sabotage witnesses each turn it red: an unverified platform reporting `pushed` when nothing changed, dropping the version from the signature check, a save over a failed read (it reset the version and revived rotated URLs), a refused item moving the ledger, skipping removals, pushing unchanged items, a long variant id, rotate without confirm, an unverified push shown as a result. Ratchets: seeded-chain ceiling 128 → 129 (declared), side-effect floor, served set, steward manifest, pack-surface arg parity. |
| P7 | Sandbox verification of the catalog push (Meta, Google) | — | — | **OPEN — needs David's Meta catalog and Merchant Center accounts.** Both are `unsupported` until `ads-sandbox-verify.mjs <meta\|google> catalog-push` passes and the operator lists them in `OPENWOP_ADS_VERIFIED_CATALOG_PUSH`. The signed feed URL needs no verification and works today. |
| P7 | Catalog campaigns created PAUSED (`catalog` objective, Meta `promoted_object.product_catalog_id`) | — | — | **OPEN — needs a sandbox catalog** to check the request shape. Not built; never faked. |
| P7 | Residuals | — | — | (1) A `meta-ads` connection made before pack 1.2.0 lacks `catalog_management` and must reconnect; Meta then refuses the push, which surfaces as per-item failures. (2) `catalog_management` needs Meta Advanced Access for non-admin users (an operator step). (3) The feed uses only the product's own catalog images; if ADR 0945 later lets AI concept images into the catalog, it must mark them so this feed can keep excluding them. (4) The storefront has no per-product page, so every item's `link` is the store (`/store/:orgId`). Merchant Center may disapprove items whose landing page does not show that one product; a product page (or deep link) is commerce work, OPEN. (5) The signature is keyed on the session secret, so rotating that secret also replaces every feed URL; the page then shows the new one. |
| — | Defect P7: meta-ads connection pack Graph version | #5057 | `c2d89a2e0` | `examples/connection-packs/meta-ads` 1.1.0: the OAuth `authorize`/`token` endpoints move from Graph `v19.0` (expired 2026-05-21) to `v25.0`, which the adapter pins (`ADS_API_VERSIONS.meta`). `ads.manage` gains `pages_manage_ads` + `pages_show_list`; Meta's permission reference requires them to create ads for a Page, and every live Meta `publishAd` sends `object_story_spec.page_id`. `business_management` stays out, because no call needs it. Tripwire: `ads-api-version-tripwire.test.ts` pins the served ads packs' versioned endpoints (Meta authorize+token, TikTok token) to `ADS_API_VERSIONS`; putting `v19.0` back turns it red. **Residual:** granted scopes are stored at connect time (`oauthFlow.ts`) and nothing detects drift, so a connection made before this change has to reconnect to get the Page scopes. Until then Meta rejects its Page-backed creates as a typed `ad_dispatch_failed`. `pages_manage_ads` also needs Meta Advanced Access (App Review) for non-admin users, which is an operator step. The vendored conformance fixture and an inline test sample still say `v19.0` on purpose: they test `apiHosts` validation and are not served. |

> **Naming note (2026-10-20):** the #5035 commit is titled "(ADR 0952 P2)". That **P2 is defect P2**
> in the boundaries-audit table above, not phase P2 of the phased plan. The defect is closed in
> **phase P0**, per the plan's first row. The commit title is left as it is, because rewriting it would
> change a reviewed head.

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

> **Decisions (2026-10-20, team-lead, overridable by David):**
> - **Q2:** `maxStaleMinutes` defaults to 180, as shipped in P1.
> - **Q4 (P7):** the product feed is GENERATED from the one commerce catalog (no second product store), served as
>   a signed feed URL plus an API push adapter for Google Merchant Center and the Meta Catalog. The push is
>   fixture-only until the accounts exist. Feed fields follow Google's product data specification
>   (https://support.google.com/merchants/answer/7052112). David can override this.
> - **Q3:** a client cap is NOT mandatory before launch while every launch already needs a per-launch
>   approval (P0). It BECOMES mandatory the moment a campaign's ADR 0942 autonomy policy lets `ads.launch` or
>   `ads.budget` proceed without a per-action approval (any preset above "review everything"). That is enforced
>   in ADR 0942's `enforceCampaignAction`: an unattended launch or budget change with no enforceable cap is
>   refused `cap_required`. Meta and Google both push spend limits as the guard for automated buying. Owner: the
>   0942 P3 chokepoint (cs-0942), with this ADR's P4. The seam is `hasEnforceableCap(tenantId, target)` in
>   `features/campaign-intel/spendCaps.ts` (#5078): `false` when no cap covers the campaign, or the covering cap
>   cannot be enforced. Unlike the launch check, "no cap" never reads as ok there. An `approve` outcome needs
>   no cap, because the approval is the control (cs-0942, 2026-10-20).

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


## Recovery correction — P0 launch approval concurrency (2026-10-21)

The original D1 implementation record's “consumed on success” was insufficient:
two callers could read the same approved mapping before either post-write delete.
An invalid runtime delivery status also fell through the literal builders to
ACTIVE/ENABLED while bypassing the `status === active` gate.

The existing ads adapter remains the single egress owner and the existing
`ads:spend-approval` DurableCollection owns a launch-only claim receipt. There is
no new route, queue, credential path, normative protocol field or capability; no
RFC is required for this host-internal repair.

1. Validate exact paused/active status before previews, reads or gates, and make
   the exported wire-body builders refuse invalid runtime values.
2. Validate the mapped approval's tenant, kind, spend key, platform, account and
   campaign. CAS the exact approved mapping to a random claim identity BEFORE
   a platform mutation. Lost CAS or unreadable claim storage makes no write.
3. Preserve the claim on every failed or ambiguous external attempt. A confirmed
   response can CAS only its own claim to completed. A later paused-to-active
   attempt can CAS a completed marker to a fresh pending approval. No blind map
   replacement or post-effect delete may release someone else's claim.

Alternatives rejected: a process mutex cannot coordinate instances; deleting on
success races; a time-expiring claim can repeat a successful but unacknowledged
financial effect. This is an at-most-one attempt per approval fence, not an
exactly-once platform effect guarantee. An ambiguous claim requires operator
reconciliation and remains blocked across retries/restarts without an automatic
lease expiry. A pause and read-first already-active no-op remain available, and
neither clears the claim. Completed markers are retained without creative/PII.

Fixture-server witnesses cover concurrent Meta/Google launches, invalid runtime
statuses, stale/newer mappings, wrong campaign approvals, claim-store failures,
malformed responses after application, completion-ack failure and ungated pause.
These additions are authored but unexecuted; independent source review, focused
execution and the full bounded merge gate remain required. Sandbox verification
and live-writer env enablement remain the existing explicit operator steps.


## Recovery correction — P1 current, enforceable cap snapshots (2026-10-21)

The initial launch check trusted a saved ok band indefinitely and could mistake
a swallowed state/settings read for absence of a covering cap. A cap now needs
a valid, nonfuture last-good read within maxStaleMinutes, a nonnegative safe
minor-unit amount, and the same account/target coverage digest as the current
resolved population. Missing/legacy snapshots without that digest refuse until
a successful watchdog tick. Every covered account's platform reader must remain
verified, and the watchdog must be enabled. Current cap limits are re-read after
coverage/state resolution; an old ok band cannot override a newly lowered limit.

Client caps cover launches carrying their matching client org, even when their
account is not configured yet; such unknown coverage is unenforceable, not a
proof of no cap. The existing host-only cap-checker seam forwards its run's orgId.
The existing connector-settings reader gains opt-in read-error propagation for
this financial decision. Missing/tombstoned target identity refuses rather than
turning the cap into an uncovered one. No new protocol surface or RFC is needed.

The watchdog also re-reads the cap after awaited metrics before computing its
state, so concurrent lowering can pause this tick. Negative, nonfinite or unsafe
spend totals are failed reads, never fresh ok data. Creator erasure now retries
five fresh-row CAS attempts, preserving concurrent limit edits and reporting
exhaustion rather than claiming erasure succeeded.

Alternatives rejected: trusting a cached status or adding a timer alone cannot
prove freshness at launch; a process lock cannot preserve cross-instance edits.
The existing state row holds the population digest and the existing CAS/storage
seams retain authority. This is still a sampled-spend safeguard; platform-native
ceilings and sandbox enablement remain separate existing phases.

Authored witnesses cover no-tick expiry, state/settings faults, future timestamps,
current lowering at both awaited boundaries, changed accounts, lost secondary
reader verification, malformed spend and erasure contention. Independent source
review and guarded focused/full execution remain pending.

### Recovery composition correction — canonical campaign coverage, 2026-10-21

ADR 0941 P2 dispatch rows carry the stored run's campaign ID and client org even
when their caller-supplied brief differs. Spend caps now prefer those explicit
fields: campaign caps require the exact campaign and org; client caps retain the
stamped org's accounts even after its MarketingCampaign retires. Only rows without
a campaign ID use the legacy brief join, and an explicitly foreign org never
falls through to it. The existing ledger snapshot and coverage digest remain the
authority; no new poll or platform request is added.

Six authored cases cover unrelated/absent briefs, conflicting campaign IDs,
foreign orgs, legacy org boundaries and client coverage after retirement. The
existing actual-publisher witness establishes that a tagged run can dispatch
with an unrelated brief. Source review and execution of the combined cap
witnesses remain pending the sole monitored validation slot.

## Integration correction — the P2–P7 stack onto main (2026-10-25)

The P3, P4, P2, P5 and P7 branches (#5078, #5093, #5099, #5104, #5112) were one
linear stack cut before the two recovery corrections above landed on main. They
were merged onto main as one integration (`feat/0952-ads-integration`; every head
kept in ancestry). Where they met, main's P0/P1 money-safety rules won, and every
new write path now goes through them:

1. **P2 native ceiling vs the launch claim.** The stack wrote Meta `spend_cap`
   before the status write, with no claim. It now runs AFTER the launch claim, so
   no vendor call precedes the claim. A ceiling refusal happens before the status
   write, so no launch was attempted: the claim goes back to the approved mapping
   it was taken from (CAS on our own claim only; a changed mapping stays fenced),
   and a retry can launch on the same approval. A ceiling write never starts
   spend, so an ambiguous ceiling write is not an ambiguous launch.
2. **P3 reallocation vs current snapshots.** `capBlocksIncrease` used a looser
   test (any read at all). It now shares `checkLaunchAgainstCaps`'s coverage
   resolution and current-snapshot test: a stale, never-read, coverage-changed or
   unenforceable cap refuses the increase (`cap_stale`, `cap_unenforceable`). An
   approved plan can be applied up to 7 days later, so each increase is
   re-checked on a current snapshot at APPLY time, not only at propose. Client
   caps now cover a plan's campaigns through the plan's org.
3. **P4 currency-aware threshold vs the ADR 0942 gate.** A different account
   currency now sets `thresholdMet`, so main's autonomy gate takes the tenant
   ceiling `approve`, rather than the stack's separate branch.
4. **P5 TikTok/LinkedIn launches** ride the one `setDeliveryStatus` path, so they
   inherit the claim and the cap check; their status literals now throw on an
   invalid runtime value, as main's Meta/Google literals do.
5. **Meta budget reads** bind the campaign to its account first, as the writer does.
6. **P7 catalog push is `ads.publish`** (team-lead decision): listings can show
   publicly and feed shopping ads. `ads.publish` is a PendingApproval-lane class,
   so `catalogPushAdapter.pushCatalogItems` goes through the ads adapter's ONE
   spend gate (`gateCatalogPublish` → `evaluateSpendGate('ads.publish')`, budget 0,
   a fork-stable key over the content hash of exactly what is sent). Under a
   Guarded policy it opens a campaign-spend approval (kind `publish`) and the push
   node waits on `approval:<id>`, the publish-ad-variants pattern; the decision
   resumes it under the same key. The tenant's `ads.publish` action policy applies
   (disabled refuses; draft-only refuses, there being no preview). There is NO
   autonomy-gate node in the chain: the in-run gate cannot open this lane
   (`lane_unavailable`). **Correction within the integration:** its first commit
   (`0dd29c59f`) wired the interrupt lane (the SMS shape), and its test passed only
   because it hand-inserted an interrupt the system never creates for this class.
   That wiring could never have been approved under Guarded; it was replaced
   before the PR. A replay fork never re-pushes (the node is fast-path served),
   and a re-run sends only changed items (the push ledger).

Action classes added (ADR 0942 D6 table): `apply-reallocation` → `ads.budget`;
`propose-reallocation`, `budget-optimize` → `none`; `push-catalog-feed` →
`ads.publish`. Witnesses: `ads-delivery-status` (claim before `spend_cap`; ceiling
refusal releases the claim; stale cap refuses), `ads-tiktok-linkedin-writers`
(claim before the vendor call; stale cap; a part-way LinkedIn launch stays
fenced), `campaign-intel-reallocation` (stale snapshot refused at apply),
`ads-campaign-budget` (owner mismatch), `adr0942-p3-chokepoints` (catalog push under
Guarded, sabotage-witnessed). Fixed in the same integration (it was live: the signed
feed needs no sandbox): while the store does not serve (commerce off or the owner
lapsed, the store's own `checkOwnerPublicAccess`), the public feed answers 404 and
a push refuses `commerce_off` with no vendor call. It is never an empty feed: that
would turn every listing into a removal and delete the client's platform catalog
over a toggle.

