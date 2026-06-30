# ADR 0123 — Eval / feedback leaderboard from MessageFeedback (+ optional model arena)

**Status:** in-progress — **Phase 1 (core) implemented** (2026-06-24): the pure win-rate leaderboard math (`features/evals/leaderboard.ts` — `computeLeaderboard`). Aggregates `(model, rating)` rows into per-model up/down/neutral + win-rate (= up/(up+down); neutral excluded), ranked deterministically by win-rate → decisive volume → model id. **Phase 2 (Elo) implemented** (2026-06-24): `features/evals/elo.ts` — `computeEloRatings` (each thumbs up/down is a match vs a fixed 1500 anchor, K=32; up→win/down→loss, neutral skipped, deterministic) + `eloMatch`/`expectedScore` (the pairwise primitive arena head-to-head reuses). **Phase 1c (service) implemented** (2026-06-24): `buildTenantLeaderboard(tenantId, resolveModel)` aggregates a tenant's MessageFeedback (`listFeedbackForTenant`) into a per-model win-rate + Elo ranking (`combineLeaderboard`); the feedback→model JOIN is an INJECTED resolver (the route binds the message-meta lookup), and an unattributable rating is dropped (honest). **Phase 2 (admin route) implemented** (2026-06-24): `GET /v1/host/openwop-app/evals/orgs/:orgId/leaderboard` (authorizeOrgScope workspace:read, toggle `evals` OFF/tenant) binds `buildTenantLeaderboard` to a message-meta model resolver (parses each rated message's persisted `meta.model`; per-conversation cached; unattributable dropped). **Phase 3 (arena capture) implemented** (2026-06-24): `features/evals/arena.ts` — `recordArenaMatch` captures a session-bound rater's winner between two models as a TRUE head-to-head `eloMatch` (K=32, the Phase-2 primitive; both models move, tie=0.5) + persists an `ArenaMatch` ledger + a per-(tenant,model) `ArenaRating`. The two live dispatches (normal runs on the existing path) + the route are the remaining wiring. The write-through rollup + per-model detail (remaining) pending. **Date:** 2026-06-23
**Toggle:** `evals` · default **OFF** · `bucketUnit: tenant` (an admin model-quality surface).
**Surface:** host-extension `/v1/host/openwop-app/evals/*` (admin leaderboard + optional arena, non-normative). No new wire contract.
**Depends on / composes (all implemented — this turns an already-captured-but-unused signal into a product):**
- **ADR 0071 (durable chat UI state + feedback) — `host/messageFeedbackStore.ts`** — the `MessageFeedback` store ALREADY persists per-(user, message) `rating: 'up'|'down'|'neutral'` + a secret-scrubbed `reason`, keyed `(tenantId, conversationId, messageId, subjectRef)`, with `listMessageFeedback(...)` (all raters on a message) already in place "for the conversation owner / quality aggregation". ADR 0071 Phase 5 explicitly left "aggregate feedback to authorized quality tooling" as the deferred consumer. **This ADR is that consumer.**
- **ADR 0029 (assistant-evals-health-indexing)** — the eval/scorecard machinery (RFC 0081 scorecard shape) + the `(entity, dimension)` secondary-index primitive in `hostExtPersistence`. **Reuse, do NOT fork** — the leaderboard's per-model rollup rides the ADR 0029 index; any rubric scoring serializes as an RFC 0081 scorecard, not a parallel harness.
- **The recorded model attribution** — `providers/usageEmitter.ts` (RFC 0026 `provider.usage`: `provider` + `model` per call) + the conversation run-event log give the model that produced a given assistant message. The leaderboard joins feedback → model via this recorded signal.
- **ADR 0067 (conversation-run secret stripping)** + **ADR 0077 (PII masking)** — the `reason` text is already `sanitizeFreeText`-scrubbed at write (`messageFeedbackStore.ts:59`); the leaderboard reads it, never re-collecting raw text.
- **ADR 0088 (run-read-authz)** — single-response drill-down from the arena/leaderboard routes through `loadReadableRun` (tenant gate, 404-not-403).
- **ADR 0118 (LLM observability)** — adjacent and complementary: 0118 measures cost/latency, 0123 measures quality. Both read the same recorded `provider.usage` model attribution + the ADR 0029 index; they are two lenses, not two pipelines.

**RFC verdict:** **host-extension — NO new RFC.** The leaderboard is a read-only aggregation of recorded feedback + run model-attribution; the arena pairs two managed-provider responses through the existing dispatch path. Elo/win-rate scoring is host-internal math; scorecards (if surfaced) ride the **accepted** RFC 0081. Routes are non-normative `/v1/host/openwop-app/*`; nothing is advertised on the wire.

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §9 backlog item **B14 — "Eval / feedback leaderboard from existing MessageFeedback"** (MEDIUM) and §11 roadmap Q3. Research verdict: ABSENT — "feedback captured (ADR 0071), unused." Competitor impl paths: Open WebUI `routers/evaluations.py` (**Elo K=32** leaderboard + optional query-aware semantic re-rank) + `models/feedbacks.py` + `src/lib/components/admin/Evaluations/`; LobeHub `packages/eval-rubric/`. Open WebUI's multi-response tree (`childrenIds`, `branchPointMessageId`) is what "feeds the arena/eval leaderboard" — our equivalent feed is the per-message feedback already captured.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a new feedback store + a new eval harness + a new scoring service." Every one of those exists. The corrected scope is **aggregate the feedback ADR 0071 already captures, join it to the model that ADR 0026 already records, and score it with the ADR 0029 eval seam** — plus one genuinely net-new bit (the optional arena's paired dispatch).

| Concern | Existing owner (file:line) | How this ADR reuses it |
|---|---|---|
| Per-message feedback (rating + reason) | `host/messageFeedbackStore.ts:26` `MessageFeedback` + `:82` `listMessageFeedback` (all raters) | The leaderboard's sole quality signal. No new feedback store, no new collection. |
| Model attribution per message | `providers/usageEmitter.ts` (RFC 0026 `provider`+`model`) + run-event log | Joins a rated message → the model that produced it. |
| Eval / scorecard machinery | ADR 0029 (RFC 0081 scorecard shape) | Reused — rubric scores (optional) serialize as RFC 0081 scorecards, not a fork. |
| Per-model rollup index | `hostExtPersistence` `(entity, dimension)` index (ADR 0029) | Per-model win/loss prefix-keyed `(eval, tenant:model)` — point reads, no cross-tenant scan. |
| Reason redaction | `messageFeedbackStore.ts:59` `sanitizeFreeText` (ADR 0067/0077) | Already scrubbed at write; the leaderboard reads scrubbed text. |
| Run-read authorization | `host/runAccess.loadReadableRun` (ADR 0088) | Drill-down to a single arena/leaderboard response routes through it. |
| Provider dispatch (arena) | the existing chat-turn / managed-provider dispatch path | The arena fans one prompt to two models through the SAME dispatch + redaction path. No second provider client. |
| Admin gating | `requireSuperadmin` (`features/assistant/routes.ts:295`) + tenant-admin `roles.includes('admin')` | Same gate the health/marketplace surfaces use. |

**Net new (small):** (1) a `features/evals/` package with an admin **leaderboard** route aggregating `MessageFeedback` → per-model **win-rate** + an **Elo** rating (K=32, the Open-WebUI default), maintained via the ADR 0029 index; (2) a per-model win/loss + reason-sample admin view; (3) an **optional model arena**: fan one prompt to two configured models, render side-by-side, capture the winner as a head-to-head feedback row that feeds the same Elo. Everything else is reuse.

---

## Decision

Ship a **`features/evals/` feature-package** (toggle `evals`, default OFF, `bucketUnit: tenant`) that converts the already-captured `MessageFeedback` into an **admin model-quality leaderboard** and adds an **optional A/B model arena** — building strictly on ADR 0071's store and ADR 0029's eval seam (reuse, don't fork).

### Scoring — win-rate + Elo (rides ADR 0029, not a new harness)
- **Win-rate per model:** `up / (up + down)` over the tenant's rated assistant messages, joined to the producing model via the recorded `provider.usage`. Neutral ratings clear a prior up/down (ADR 0071 semantics) and don't count.
- **Elo (K=32):** each up vs down (and each arena head-to-head) is a "match"; ratings update via standard Elo with K=32 (the Open-WebUI constant). For thumbs feedback the opponent is a per-tenant baseline rating, so a single model still moves; arena matches are true head-to-head between the two chosen models.
- Both are host-internal math over recorded data; if a rubric/LLM-judge score is ever added it serializes as an **RFC 0081 scorecard** (ADR 0029), never a parallel shape. Optional query-aware semantic re-rank (Open WebUI's refinement) is OQ-2, not v1.

### Data model — one rollup + (optional) arena match rows; no second feedback store

```
EvalModelRating                      // per (tenant, model) — the leaderboard row (rebuildable cache)
  key (entity='eval', `${tenantId}:model:${model}`)
  { tenantId, model, provider,
    up, down, winRate, elo,
    matchCount, lastUpdatedAt }

ArenaMatch                           // ONLY when the optional arena is used
  { matchId, tenantId, conversationId,
    prompt,                          // sanitizeFreeText-scrubbed
    leftModel, rightModel,
    leftRunId, rightRunId,           // each response is a normal run (ADR 0088-readable)
    winner: 'left'|'right'|'tie',
    raterSubjectRef, createdAt }
```

`EvalModelRating` is a **rebuildable cache** maintained write-through on each new `MessageFeedback`/`ArenaMatch` via the ADR 0029 index — the source of truth is the feedback store + run events; drop and replay to reconstruct. `ArenaMatch` is the only genuinely new persisted entity, and it stores a scrubbed prompt + two run ids (the response bodies stay in the run-event log, not duplicated here).

### RBAC & isolation
Admin-only (`requireSuperadmin` for cross-tenant; tenant-admin `roles.includes('admin')` for a tenant's own leaderboard), tenant/org-scoped. A non-admin gets a uniform **404** (no existence leak — ADR 0088 posture). The `evals` toggle gates the routes: off ⇒ 404 + panel self-hides. IDOR-safe: prefix-scoped to `tenantId`; the arena's winner-capture binds `raterSubjectRef` to the session (never client-supplied), exactly like ADR 0071 feedback. Reading another rater's `reason` is admin-only aggregation, consistent with `listMessageFeedback`'s "conversation owner / quality" intent.

### Replay / fork
**Leaderboard is pure read-only aggregation** over recorded feedback + runs — it never re-runs a model, carries no replay obligation, and `EvalModelRating` is a rebuildable cache. **The arena DOES dispatch** two live runs (one per model) — those are normal runs on the existing dispatch path, so they are individually replay/fork-safe and `loadReadableRun`-gated; capturing the winner is a write to `ArenaMatch` + a feedback-style Elo update, not a wire event. No new event shape, no fork impact.

---

## Evaluation matrix

| # | Criterion | Verdict |
|---|---|---|
| 1 | Feature-package architecture (`src/features/evals/`, default OFF) | Yes — packaged feature; no global mutation. |
| 2 | Toggle + admin UI (`bucketUnit: tenant`) | Yes — `evals` toggle OFF/tenant; admin-only leaderboard + arena. |
| 3 | Workflow + node packs | Arena dispatch reuses the existing chat-turn/provider path; no new node pack for v1. (A `feature.evals.nodes` "score model" tool is a clean follow-on.) |
| 4 | AI-chat envelopes + agent packs | Arena composes the existing chat dispatch; the leaderboard exposes a `ctx.features.evals` read surface (ADR 0014) a future "model-picker" agent could query. |
| 5 | RBAC (admin, fail-closed, IDOR, uniform-404) | Yes — superadmin/tenant-admin gate, tenant-prefix scoping, session-bound rater, uniform 404. |
| 6 | Replay / fork safety | Yes — leaderboard read-only; arena uses normal replay-safe runs; rollup is a rebuildable cache. |
| 7 | Privacy / secret-stripping (ADR 0067 + 0077) | Yes — `reason` already scrubbed at write; arena prompt `sanitizeFreeText`-scrubbed; no raw secrets stored. |
| 8 | Reuse-not-recreate | Yes — reuses `messageFeedbackStore`, ADR 0029 eval seam + index, `usageEmitter` model attribution, existing dispatch, `loadReadableRun`. Net-new: rollup + leaderboard + optional arena. |
| 9 | RFC gate honesty | Yes — host-ext, no wire change; scorecards ride accepted RFC 0081; no capability advertised. |
| 10 | Composes existing seams (not parallel) | Yes — explicitly the deferred ADR 0071 Phase 5 consumer; ADR 0029 reused not forked; complements (not duplicates) ADR 0118. |

---

## Phased plan

1. **Feedback → model join + win-rate leaderboard.** A `features/evals/` package: aggregate `listMessageFeedback` across a tenant, join each rated message to its producing model via recorded `provider.usage`, compute per-model win-rate, store `EvalModelRating` write-through via the ADR 0029 index. Admin route `/v1/host/openwop-app/evals/leaderboard`. Tests: win-rate math, rebuild-from-feedback, RBAC fail-closed, IDOR 404, toggle-off 404.
2. **Elo (K=32) + per-model detail.** Add Elo updating on each new feedback row (baseline opponent) + a per-model view: up/down counts, recent scrubbed reasons (admin-only). Test: Elo monotonicity + K=32 constant; reason redaction preserved.
3. **Optional model arena.** Fan one prompt to two configured models via the existing dispatch path, render side-by-side, capture the winner (session-bound rater) as an `ArenaMatch` + a head-to-head Elo update. Each response is a normal run; drill-down via `loadReadableRun`. Tests: paired dispatch redaction parity, winner-capture binds session subject, arena Elo head-to-head, run-read 404 cross-tenant.
4. **Admin UI.** A React admin panel (leaderboard table + per-model detail + arena), self-hiding on a 404 when the toggle is off (the `knowledge-sync` precedent). FE build gate green.
5. **Core-app extension surface.** Expose `ctx.features.evals` (ADR 0014) as a thin read surface so a future model-selection / "which model wins for this task" agent (ADR 0058) can query the leaderboard in chat without a second data path.

## Alternatives weighed
1. **A new feedback store + a new eval harness.** Rejected — `messageFeedbackStore` (ADR 0071) + the ADR 0029 eval seam already exist; building either anew is the `no-parallel-architecture` violation and abandons the signal already captured.
2. **Per-RUN annotations (RFC 0056) as the quality signal.** Rejected as the primary signal — ADR 0071 already established that per-(user, message) chat feedback is DISTINCT from per-run `run.annotated` (a conversation run holds many messages; multiple users rate one message). The leaderboard is a chat-quality lens; bridging message-feedback → `run.annotated` stays the out-of-scope future option ADR 0071 named.
3. **LLM-judge rubric scoring as v1.** Rejected for v1 — ADR 0029 OQ-1 flagged LLM-judged quality as non-deterministic (manual/CI-optional). v1 uses human feedback (deterministic, already captured); rubric scoring is an additive RFC 0081 scorecard later.
4. **Fold into ADR 0118's observability dashboard.** Rejected — 0118 is cost/latency (operational), 0123 is quality (RLHF/Elo). Different math, different intent; they share the model-attribution read + the ADR 0029 index but are honestly separate surfaces.

## Open questions
1. **OQ-1 — Cold-start / low-N.** Elo on sparse feedback is noisy. Propose a minimum-match threshold before a model ranks, and show win-rate with a confidence note until then.
2. **OQ-2 — Query-aware re-rank.** Open WebUI re-ranks the leaderboard by semantic similarity to a query. A useful refinement (per-task model quality) but adds an embedding dependency — follow-on, not v1.
3. **OQ-3 — Cross-tenant vs per-tenant boards.** Default per-tenant (privacy + relevance). A superadmin global board across tenants is admin-only and opt-in (OQ).
4. **OQ-4 — Arena cost.** The arena doubles provider spend per prompt (two models). Gate it behind the managed daily usage cap; surface the cost. Keep it explicitly opt-in within the already-OFF feature.
5. **OQ-5 — Feedback gaming / multi-rater weighting.** One user spamming 👍 skews Elo. Propose per-(user, message) idempotency (already enforced by the store key) + optional rater de-duplication in the rollup.

## RFC verdict (Step 5)
**Host-extension — NO new RFC.** The leaderboard is a read-only aggregation of recorded `MessageFeedback` (ADR 0071) joined to recorded model attribution (RFC 0026 `provider.usage`); Elo/win-rate are host-internal math; the optional arena fans the existing dispatch path to two models. Any rubric scorecard rides the **accepted** RFC 0081 (ADR 0029). Routes are non-normative `/v1/host/openwop-app/*`; nothing touches the wire or `/.well-known/openwop`. A new RFC would be warranted only if a normative cross-host model-leaderboard advertisement were later required — not now.

> **Phase 4a (2026-06-24) — FE client:** `evalsClient.ts` — fetchLeaderboard + captureArenaMatch + fetchArenaRating for the admin leaderboard view + the model arena. The leaderboard table + arena UI components are Phase 4b.

> **Phase 4b (2026-06-24) — leaderboard component:** `features/evals/LeaderboardPage.tsx` (+ routes + i18n×4 + a component test), registered in `FRONTEND_FEATURES` under the Workspace nav (`featureId: evals`). Read-only per-model table (model · up · down · win-rate% · Elo) over `fetchLeaderboard`; loading/empty/error/disabled states; toggle-gated (no fetch when off). Passed /architect (GO, cites the 0118 Phase 3b precedent), /code-review + /ux-review (clean — identical pattern, DESIGN.md compliant). The arena head-to-head UI is Phase 4c.
