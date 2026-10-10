# ADR 0821 — AI credits: one metered unit over the existing prepaid balance, plan allowances, and per-feature attribution

Status: Accepted — partially implemented (the owner approved implementation, 2026-10-05; P1–P5 code in PR #4422, with every new knob defaulting to today's behaviour; P6, the prod env values, awaits owner approval)

Related:
- ADR 0176 P2 — prepaid token balance, token packs;
- ADR 0419 — bundles;
- ADR 0482 — per-workflow USD budgets;
- ADR 0693/0721 — managed usage scope per acting subject;
- ADR 0786 — billing money-truth;
- ADR 0820 — packaging;
- ADR 0118 — usage-analytics.

Evidence: `docs/steward/monetization-2026-10/value-cost.md` §0, §2 and §3.

## Context

All of the following were measured on 2026-10-05, from code and from read-only reads of the Cloud Run env.

- **The platform pays for chat and agent turns by default.** With no BYOK binding, chat turns, the tool loop,
  agent dispatch and the chat-responder node all use the managed MiniMax key (`host/exchange/dispatchTurn.ts:260`,
  `host/conversationToolLoop.ts`, `host/agentDispatch.ts:855`). Workflow `ctx.callAI` nodes do NOT fall back;
  they fail `byok_required`.
- **Some background text calls use managed even for BYOK tenants:** auto-title, memory extract, headless text
  (CMS auto-translate, the online eval judge). `host/headlessAi.ts:208-215` returns managed for text
  unconditionally, though its comment says otherwise.
- **Prod caps.** `OPENWOP_MANAGED_DAILY_TOKEN_CAP=20000000` per bucket per day, 400× the code default of 50k.
  > **CORRECTED 2026-10-05 (ADR 0773 G-10e):** the code default is now 150,000, so that a
  > Pair Canvas first draft (64–140k measured) fits on a fresh install. It was sized as D2's
  > free tier knowing it is per acting subject (#6); prod's 20M is unchanged.
  `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP=200000000`.
- **The prepaid balance already draws on managed usage**, through `recordManagedUsage` → `drawFromBalance`, with
  cache-weighted tokens (`providers/managedProvider.ts:552-576`). Gaps:
  - (G1) a tenant with any balance spends it from the first token, ahead of the free allowance;
  - (G3) managed TTS, operator image/video, E2B, web search and app-deploy hosting are platform-paid and never
    drawn;
  - (G4) there is no feature or user attribution.
- **Plan limits are display-only, except KickTodo enrollments** (`kicktodo-commerce/tierGuard.ts`).
  `limits.workflowRuns` is enforced nowhere.
- **`usage-analytics` sees none of the platform's spend.** It records lifetime BYOK-chat totals per
  provider/model only. The managed branch returns before recording.
- **No meter records usage per tenant per feature.**
- **The market packages AI as pooled workspace credits** with a per-tier allowance, at about $10 per 1,000
  credits (HubSpot, Lindy, Notion agent credits). Customer-facing agents are priced per outcome (Intercom
  $0.99, HubSpot $0.50) (`benchmark.md` §3.4).

## Decision

### D1 — One unit: the AI credit, defined over the existing balance
- The `billing:token-balance` store stays the single ledger. Its unit is renamed from "tokens" to **credits** in
  display and config. Storage keeps a token-equivalent integer, so no migration is needed.
- `1 credit = OPENWOP_BILLING_TOKENS_PER_CREDIT managed tokens` (cache-weighted as today).
- `OPENWOP_BILLING_TOKEN_PACK_PRICES` stays the pack catalog.

No second balance, store or Stripe object.

### D2 — A fixed consumption order (fixes G1)
Each managed call draws, in this order:
1. **the free daily allowance** (`OPENWOP_MANAGED_DAILY_TOKEN_CAP`, per acting subject as today);
2. **the plan's monthly allowance** (`OPENWOP_BILLING_PLAN_LIMITS.<plan>.aiCreditsMonthly`, tracked per tenant
   per UTC month in the managed-usage store);
3. **purchased packs** (the balance).

When all three are exhausted, the call refuses with the existing typed managed-cap error. The global cap stays
the operator's backstop. The draw stays post-hoc, with a one-call overshoot bound (G2, accepted and documented).

### D3 — Meter the platform-paid non-token spend into credits (fixes G3)
A rate table in operator env, `OPENWOP_BILLING_CREDIT_RATES`, converts each unit into credits, each with a
default:
- TTS characters;
- generated images;
- video seconds;
- web-search queries;
- code-exec seconds (E2B);
- chat-widget conversations.

Each platform-key call site already has a budget check (`aiProviders/mediaBudget.ts`, `host/codeExecBudget.ts`).
The draw is added beside that check, through the same `managedBalanceHook` seam. No feature imports billing.

### D4 — Attribution per feature (fixes G4; the instrumentation keystone)
- Every draw carries `featureId` (the owning feature of the tool, node, daemon or surface; `chat` for plain
  turns) and `subject`.
- They are recorded as a per-tenant, per-day, per-feature row in the existing managed-usage store. It gains a
  `feature` column; no new store.
- `usage-analytics` reads this table for its rollup instead of keeping its BYOK-only writer as the sole source.
  The BYOK writer stays for BYOK visibility.

### D5 — Headless text honours BYOK
`headlessAi` text calls prefer the tenant's own key when one is bound, and fall back to managed metered by
D2/D3. Its doc comment becomes true.

### D6 — Plan limits become enforced, starting with runs
- `limits.workflowRuns` (monthly, per tenant) is enforced at run start. `host/runStarter.ts` `startWorkflowRun`
  is used by `POST /v1/runs` and the schedule daemon. Trigger, webhook, channel and heartbeat starts must be
  routed through it, or checked beside it; that inventory is P5's first task. The count is kept in the durable store, not the per-instance
  in-memory quota maps.
- The pricing page may display only limits that have an enforcement site. A ratchet test pins the set of
  displayed limit keys to the enforced keys.

## Architect pass (adversarial, decision text) — 2026-10-05

Run with `/architect`, Track A. Findings on THIS ADR. Each is corrected here; the original decision text above is
kept for the trail.

- **#1 (Critical, ops): D6 would refuse the conformance and showcase tenants.** A free-plan `workflowRuns` limit
  applies to every non-superadmin tenant. MEASURED over 30 days: `conformance-prod` 12,637 runs, `__showcase__`
  776. Neither is in `OPENWOP_SUPERADMIN_TENANTS`, so certification cuts would start failing. **Corrected:**
  - a new `OPENWOP_BILLING_EXEMPT_TENANTS` (operator-service tenants) exempts **limits and credits only**;
  - it NEVER exempts the feature paywall, because a service tenant must not become a free-everything backdoor;
  - D6 ships with a witness test that an exempt tenant passes the run limit AND is still plan-refused on a
    priced feature.
- **#2 (High, perf/data): D4 must not touch the cap row.** `incrementManagedUsage`/`getManagedUsage`
  (`storage/storage.ts:1046-1059`) key on `(tenant, provider, date)` and are read on every managed call. Adding
  `feature` to that key makes the hot read an aggregate and forces a PK migration in both adapters.
  **Corrected D4:**
  - the cap row is unchanged;
  - attribution goes to a separate `DurableCollection` keyed `${tenantId}:${dateUtc}:${featureId}`, CAS-folded
    (the `usage:rollup` precedent) and written after the call, best-effort (a write failure logs and never fails
    the call);
  - P1 therefore needs no storage-interface change.
- **#6 (High, unit economics): D2's free allowance scales with seats.** The daily free bucket is per acting
  subject (ADR 0693/0721), so with unlimited seats an N-member workspace gets N× the free allowance before
  touching its plan or packs. **Corrected D2:**
  - step 1 is bounded by BOTH the per-subject cap AND a per-tenant ceiling
    (`OPENWOP_MANAGED_TENANT_DAILY_TOKEN_CAP`, summing the tenant's subject buckets);
  - the tenant-owned-bucket match already exists for this (the `LIKE` participant-bucket read at
    `storage/storage.ts:1060+`).
- **#8 (Medium, consent): D5 changes who pays without asking.** **Corrected D5:**
  - BYOK preference for headless calls is a per-tenant opt-in (the BYOK settings surface), default OFF, so
    background calls stay managed and metered;
  - the `headlessAi.ts` doc comment is corrected either way.

## Alternatives
- **A new metering service or Stripe usage-based billing (meters API) now.** Stripe metered prices add
  reconciliation and an invoice-time surprise to a product with zero external buyers. Prepaid credits are
  money-truth-simple: paid before use, exactly-once credit via CAS. Revisit when an enterprise contract needs
  post-paid overage.
- **Per-feature AI add-ons** (ClickUp style). The market is moving away from them, and they multiply SKUs.
  Rejected.
- **Unlimited AI inside flat bundles.** It inverts margin for heavy users. Rejected (value-cost §2).

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Extends `billing`, plus the host seams `managedBalanceHook` and the managed-usage store. No new package. |
| 2 | Toggle / admin UI | No new toggle. The billing page shows the credit balance, the monthly allowance and per-feature spend (from D4). |
| 3 | Workflow surface | None. Node LLM calls stay BYOK. |
| 4 | Node pack | None. |
| 5 | AI chat / envelopes | No envelope change. The managed-cap refusal is the existing typed error. |
| 6 | Agent pack | None. |
| 7 | Public surface | Chat-widget conversations are metered to the owning tenant (D3). |
| 8 | RBAC | Buying credits stays `host:billing:manage`. |
| 9 | Replay | Draws happen at live call time only. Replay serves recorded responses and never draws. |
| 10 | Frontend | Billing page credit meter. |

**RFC verdict: none.** RFC 0026 `provider.usage` emission is unchanged; this is host accounting.

## Phases

| Phase | Content | Gate |
|---|---|---|
| P1 | D4 attribution column + a superadmin per-feature spend read (measure before pricing) | storage migration test (`legacyDbAtVersion`) |
| P2 | D2 consumption order + `aiCreditsMonthly` | managed-provider tests (free → plan → pack) |
| P3 | D3 rate table + draws at the media/code-exec/search/widget sites | per-site tests |
| P4 | D5 headless BYOK preference | headlessAi tests |
| P5 | D6 durable run limit + the displayed-limits ratchet | run-starter tests |
| P6 | Lower the prod free cap (env) and publish packs and allowances | **owner approval** (strategy Q2) |

**Implementation record.** P1–P5 are in PR #4422 (`feat/monetization-ai-credits`), one commit per phase, with the witnesses listed in its body. The run-limit checks at start sites outside `host/runStarter.ts` follow in the run-lifecycle PR (workstream B2).

> **IMPLEMENTATION NOTE 2026-10-05 (P5 fully wired).** #4436 wrapped the ~10 run-minting sites outside
> `startWorkflowRun` (`POST /v1/runs`, `:fork`, debug, redrive, triggers, kanban, MCP, CRM, workflow-author,
> creative-briefs) in `host/runLimitSeam.ts` `withRunLimit`, which stayed a no-op because nothing registered a
> reserver. Billing's `registerRoutes` (`features/billing/feature.ts`) now calls
> `registerRunLimitReserver(reservePlanRun)` beside its plan-limits resolver, so every new run draws from the ONE
> durable monthly counter (core never imports billing). Unchanged postures: exempt tenants and an unset
> `workflowRuns` limit are a no-op with no write (prod sets no `workflowRuns`, so deploy changes nothing), and a
> refused launch never counts. Witness: `test/adr0821-p5-run-limit-wired.test.ts` (boots `createApp`, drives
> `POST /v1/runs` and `:fork`; RED before the registration — the count stayed 0).

**Implementation note, 2026-10-05: the D1/D4 and D5 UIs.** PR #4422 shipped both without a UI.
- **D1/D2/D4, the billing-page credit meter.** It reads `GET /v1/host/openwop-app/billing/ai-credits`
  (`features/billing/aiCreditMeter.ts`), a single tenant-scoped read gated on the `billing` toggle plus
  `requireBillingManage` (`host:billing:manage`). That is the gate for billing writes, not the member-level
  balance read, because tenant-wide AI spend per feature is admin-class. usage-analytics' rollup of the same
  store already requires `host:members:manage`. The route returns:
  - today's free allowance (`describeOwnManagedUsage`, the composer the cap check uses);
  - this month's plan allowance (the new `describePlanAllowance`, which reads the D2 CAS counter);
  - the purchased balance;
  - the top 5 features over 30 days.

  Everything is converted to credits on the server. A leg that does not exist is `null` and is not rendered:
  no ready managed key means no free allowance shown, and no `aiCreditsMonthly` means no monthly bar. It is
  never shown as a zero cap. The SPA panel is `features/billing/AiCreditMeter.tsx`, lazy-loaded from
  `BillingPage` and rendered only for `canManage`. Witness: `test/adr0821-ai-credit-meter-route.test.ts`.
- **D5, the background-AI opt-in.** A `role="switch"` checkbox on the BYOK page's AI-default card
  (`byok/AiDefaultCard.tsx`) is saved with the binding through the existing `PUT /byok/ai-default`
  (`host:byok:manage`). Witness: `test/adr0821-byok-prefer-text-route.test.ts`.
  - **Correction to the brief:** chat auto-title (`chat-autotitle/titleGenerator.ts`) and memory extraction
    (`memory-auto-extract/memoryExtractor.ts`) call `dispatchManagedChat` directly, not `resolveHeadlessAi`.
    The opt-in does NOT move them. The switch copy says so; it lists only translation, rewriting and eval
    judging, which are `resolveHeadlessAi` text callers.
  - Routing those two through the D5 ladder is an open follow-up.

> **IMPLEMENTATION NOTE 2026-10-05 (D5 follow-up CLOSED — auto-title and memory extraction honour the
> opt-in).** Both callers now get their dispatch from `host/headlessAi.ts` `resolveHeadlessAi(tenantId,
> 'text', …)`, the same resolver the other headless text callers use; neither calls `dispatchManagedChat`
> any more, and no second BYOK-preference reader was added. The behaviour follows the resolver's existing
> ladder:
> - **Opt-in OFF (default) or no binding:** unchanged. Managed, metered by D2, attributed by D4 to
>   `chat-autotitle` / `memory-auto-extract`. Extraction still meters to the acting subject (ADR 0721):
>   `resolveHeadlessAi`'s options gained `actingSubject`, forwarded to the managed dispatch.
> - **Opt-in ON and the key resolves:** the tenant's provider. No `dispatchManagedChat`, so no managed draw,
>   no usage increment and no attribution row. Extraction uses the binding's model. Auto-title asks for
>   `modelClass: 'quick'`, which resolves to the provider's new providers.json `classDefaults.quick` (Haiku
>   4.5 / GPT-5.6 Luna / Gemini 3.5 Flash-Lite), falling back to the binding's model. That is the only
>   place the choice is made; a 24-token title on an adaptive-thinking-only model can come back empty.
> - **Opt-in ON, key missing or expired:** falls through to managed, metered. This is the step-0 posture the
>   resolver already had. A failure to read the preference row now also falls through (logged), since OFF
>   is the default.
> - **Opt-in ON, the provider errors (invalid key, 4xx/5xx, timeout):** the background task is skipped (no
>   title, so the placeholder stays; no facts) and managed is NOT retried. The resolver never retried
>   managed after a BYOK call failed, and a silent retry would bill the allowance for a call the tenant
>   opted out of. Neither caller can affect the turn: auto-title is fire-and-forget, and extraction is
>   raced against a bound with failures ignored.
> - **Replay:** both run after the exchange is persisted and write host-extension stores only (the session
>   title, memory rows), outside any recorded run. That is the posture `resolveHeadlessAi` requires.
>
> The BYOK switch copy (4 locales) now lists auto-titles and memory extraction. ADR 0721's ratchet lost two
> EXEMPT rows, `host/headlessAi.ts` (it now passes the subject) and `titleGenerator.ts` (it no longer calls
> the managed door). The gap the second row recorded is still open: auto-title passes no subject.
> Witness: `test/adr0821-d5-background-callers-byok.test.ts`. RED against the pre-change callers on the
> opt-in-ON cases.

> **IMPLEMENTATION NOTE 2026-10-06 (D1/D7 — credit packs on the store).** The pack catalog stays
> `OPENWOP_BILLING_TOKEN_PACK_PRICES` (D1). What was missing was a way to see and buy a pack from the store:
> - **Display copy:** the new optional `OPENWOP_BILLING_TOKEN_PACK_DISPLAY` (`{"<packPriceId>":{"price","label"}}`),
>   memoized like the bundle display map; keys that are not a configured pack price are dropped with a warn.
>   Without it a pack lists its credits and the store offers no buy button.
> - **Read:** `GET …/billing/token-packs` → `[{packKey, credits, tokens, priceDisplay?}]`, smallest first,
>   gated like the bundle-store read (the `billing` toggle). `packKey` is `pack_` + the first 16 hex of
>   sha256(priceId): opaque and stable when other packs are added. No Stripe id crosses the boundary.
> - **Buy:** `POST …/billing/token-packs/:packKey/checkout` (`requireBillingManage`) resolves the price on the
>   server and calls the existing `createCheckoutSession`, so the ADR 0786 checkout-row fulfilment is unchanged.
>   The response does not echo the price id. The legacy `POST …/billing/checkout {priceId}` still accepts a pack
>   price; it is left as is and nothing in the SPA calls it for packs.
> - **UI:** `features/marketplace/CreditPacksStrip.tsx` on `BundleShopPage` (in the route's lazy chunk). Buy
>   only for `host:billing:manage` and only when a display price exists. Success returns to
>   `?checkout=credits`.
> - **Preflight:** `scripts/check-billing-config.mjs` validates both env values.
>
> Witnesses: `backend/typescript/test/adr0821-d7-token-pack-store.test.ts`,
> `backend/typescript/test/check-billing-config.test.ts` (D7 cases),
> `frontend/react/src/features/marketplace/__tests__/creditPacks.test.tsx`. Each was RED against the code before
> the change. The prod display env is an owner-approved operator step (P6), not part of this change.

> **IMPLEMENTATION NOTE 2026-10-07 (D7 — packs on the public /pricing page).** `GET …/public/pricing` now
> carries `creditPacks: [{credits, price, label?}]`: PRICED packs only (a pack without a display price is not
> advertised to an anonymous visitor), smallest first, with no Stripe id and no `packKey` (an anonymous visitor
> cannot buy). `[]` when none is priced, and the page then renders no credits block. Witness:
> `backend/typescript/test/public-pricing-page-payload.test.ts` (RED before).

## Open questions
- [ ] The credit exchange rate and pack sizes. Proposed: 1 credit = 1,000 managed tokens; packs of 1k/5k/25k
      credits at about $10 per 1k [A, against the MiniMax invoice].
- [ ] The free daily allowance. Proposed ~200k tokens/day, down from 20M (Q2).
- [ ] Per-outcome pricing for the Support bundle's customer-facing agent (phase 2 of ADR 0820's Support bundle).
