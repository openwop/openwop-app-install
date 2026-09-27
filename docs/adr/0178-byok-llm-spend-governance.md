# ADR 0178 — BYOK LLM chat spend governance (per-org hard cap + soft-warning threshold)

**Status:** implemented
> **Status corrected 2026-07-17:** implemented (aiProviders/byokChatBudget.ts, enforced in host/exchange/dispatchTurn.ts:275/:328) — verified during ADR 0396 authoring.
**Date:** 2026-07-01
**Depends on:** ADR 0106 (media-generation cost governance — the pattern this mirrors), ADR 0077 (data governance / retention — the sibling core-governance extension both ADRs mirror), ADR 0024 (BYOK + managed provider tiers), ADR 0118 (LLM observability + Usage Analytics — the read-side dashboard this composes with, does not duplicate).
**Surface:** host runtime only. No wire change. **NON-NORMATIVE — no new RFC.**

> Originates as gap #6 from a 2026-07-01 competitive feature-gap analysis — comparable tools enforce a hard USD spend cap with soft warnings as a live per-session guardrail. This ADR records the design; it does not implement.

## Why this exists (and why the original framing needed correcting)

The originating gap was framed as "openwop-app only has after-the-fact usage *reporting* (ADR 0118), not live-enforced spend caps." **That framing was half right.** The audit below shows the picture is more specific:

- **ADR 0118 (Usage Analytics) is confirmed observational-only** — a read-side rollup dashboard over already-recorded `provider.usage` events. It enforces nothing (`docs/adr/0118-llm-observability-otel.md` §Decision, §Data model: "a cache of recorded data, never authoritative").
- **The managed/free-tier LLM path already has a hard, live-enforced cap** — `providers/managedProvider.ts:292` (`prepareManagedDispatch`) checks a per-tenant `dailyTokenCap` **and** a global daily token ceiling **before** dispatch, throwing `daily_limit_reached` (fail-closed) if either is exceeded. This is a genuine, proven hard-cap mechanism — but it only covers the operator-paid managed tier.
- **The media path (TTS/STT) has an equivalent hard-cap mechanism for BOTH tiers** — ADR 0106's `mediaBudget` module: a per-org daily budget, checked before dispatch, fail-closed when enabled, with a DI-seam override resolver so a superadmin can set a per-org cap via the existing governance route.
- **The gap that's actually real and unaddressed:** **BYOK LLM chat dispatch has no aggregate spend cap of any kind.** A tenant using their own Anthropic/OpenAI/Google key can drive unbounded token volume through `ctx.callAI`/the AI-envelope chat path with zero host-side ceiling — not even an opt-in one. This is exactly the competitive-comparison gap, just narrower than originally stated: it's specifically the **BYOK chat path**, not "spend governance in general" (managed-tier chat and media already have it).

## Boundaries & pre-existing-surface audit

| Claim | Evidence | Verdict |
|---|---|---|
| Usage Analytics (ADR 0118) enforces nothing | `docs/adr/0118-llm-observability-otel.md` — `UsageRollup` explicitly documented as "a cache of recorded data, never authoritative"; no dispatch-path gate cited anywhere in its Decision/Phased-plan | Confirmed observational-only |
| A hard, live-enforced daily-cap pattern already exists for managed-tier chat | `providers/managedProvider.ts:292-317` (`prepareManagedDispatch`) — per-tenant `dailyTokenCap` + global `globalDailyTokenCap()`, both checked pre-dispatch, `daily_limit_reached` thrown fail-closed | **Compose this pattern** for the token-counting mechanics; don't reinvent |
| A hard, live-enforced, BOTH-tier daily-budget pattern already exists for media | `aiProviders/mediaBudget.ts` (ADR 0106) — `resolveBudget`/`checkMediaBudget`, per-`(tenant, UTC-day)`, DI-seam `configureMediaBudget({storage, resolveOverride})`, fail-**soft** on override-read error but fail-**closed** on over-budget, env default + superadmin per-org override via the governance route | **Compose this pattern** for the governance-extension shape (no toggle, env-gated, DI-seam override) — this is the closer structural precedent since it already spans BYOK + managed |
| Cost-emission / rate-table exists | `observability/costEmitter.ts` (`emitCost`), `providers/usageEmitter.ts` (RFC 0026 `provider.usage`) | Reuse — the same token-count signal already emitted per dispatch feeds both the existing dashboard AND this new cap check |
| USD-denominated caps have a known staleness liability | ADR 0106 §Phase 2 notes: "a media-price table... is the same staleness liability as the LLM cost table (cf. grade-code INT-1)... ships as the unit projection... not a fabricated dollar amount" | **Correction applied below** — this ADR follows the same precedent: the enforced unit is **tokens**, not USD, for exactly the reason ADR 0106 already discovered and documented. A USD figure is a read-only estimate layered on top, never the enforcement primitive. |
| Governance config has a home + admin gate | `host/governanceService.ts` + `routes/governance.ts` (`requireSuperadmin`), already extended once by ADR 0106's `mediaBudget` override | **Extend** the same governance config again — no new admin surface |

**Conclusion:** this is **not** a feature-package, exactly like ADR 0106. It is a **core cost-governance extension** — the BYOK-chat-path sibling of ADR 0106's media budget and the managed-tier `dailyTokenCap` — riding the existing cost-emission signal, the existing governance admin route, and the existing DI-seam override pattern. No new toggle, no new `src/features/<id>/`, no packs, no agents.

## Decision

Add a **per-org daily token budget for BYOK LLM chat dispatch**, structurally identical to `mediaBudget.ts` (ADR 0106), with one addition: a **soft-warning threshold** (a percentage of the cap) surfaced to the caller before the hard cap is hit — the comparison's "soft warning" half of the gap, which neither the managed-tier cap nor the media budget currently has.

1. **Unit of account: tokens, not USD** (input + output, mirroring `dailyTokenCap`'s existing counting), for the same staleness-avoidance reason ADR 0106 already established. A **read-only USD estimate** may be computed from the existing `usageEmitter` rate table purely for display (the warning message, an admin readout) — never as the enforcement comparison.
2. **Scope: BYOK dispatches specifically** — the managed-tier path keeps its existing, separate `dailyTokenCap`/`globalDailyTokenCap` mechanism untouched (different tier, different owner, ADR 0024's existing tier split). This ADR's cap applies where `managedProvider.ts`'s cap does **not** apply today: the BYOK-credential dispatch path in `conversationExchange.dispatchReply` (the same call site ADR 0118 Phase 1b already instruments with a span).
3. **Budget check (hard ceiling).** Before a BYOK chat dispatch, read the day's per-org token usage and reject with a new `byok_budget_exceeded` error (fail-**closed**, mirroring `media_budget_exceeded`'s shape and `daily_limit_reached`'s precedent) when the next call would cross the configured cap.
4. **Soft-warning threshold (the net-new half).** A configurable percentage (default e.g. 80%) of the cap: once crossed, the dispatch **still succeeds**, but the response carries a non-blocking warning signal (a structured field on the chat turn's result, NOT a new wire/run-event type — see RFC verdict) so the client UI can surface "approaching your org's daily spend limit" before the hard stop arrives. This is the literal comparison feature ("soft warnings" alongside the hard cap) that neither existing mechanism (`managedProvider`'s cap, `mediaBudget`) currently provides.
5. **Off by default, per-org opt-in.** Mirrors ADR 0106's BYOK tier policy exactly: "the budget is opt-in cost control per org (the user pays, but an org admin may still want a guardrail). Off by default for BYOK so a BYOK user is never blocked by a cap they didn't ask for." `OPENWOP_BYOK_DAILY_TOKEN_CAP` env default (0/unset = uncapped) + a per-org override via the existing governance route (superadmin-gated), exactly like `mediaBudget`'s `resolveBudget`.

### Data model — no new store, extends the existing accounting shape

```
BYOK usage counter                    // mirrors getManagedUsage's shape, new key
  key (tenantId, provider, UTC-day)
  { inputTokens, outputTokens }        // same accounting primitive as dailyTokenCap

GovernancePolicy.byokChatBudget?: {    // extends the SAME policy object mediaBudget added to (ADR 0106)
  dailyTokenCap?: number;              // present field (incl. 0 = uncapped) overrides env default
  softWarningPct?: number;             // 0-100, default 80
}
```

Reuses the exact accounting call shape `getManagedUsage`/`recordManagedUsage` already established (per-`(tenant, provider, date)`), and the exact override-resolution DI seam `configureMediaBudget` already established (`configureByokChatBudget({storage, resolveOverride})` — fail-**soft** on a governance-read outage, per ADR 0106's own precedent: "a governance-read outage must not block a paid call").

### RBAC & isolation

Identical posture to ADR 0106: usage accounting is keyed by the run's own `(tenantId, provider)`, never request input (IDOR-safe by construction); the budget OVERRIDE is `requireSuperadmin` via the existing governance route (a `PUT` sibling to `.../governance/media-budget`, e.g. `.../governance/byok-chat-budget`); fail-closed on over-budget, fail-soft on an override-read outage.

### Replay / fork safety

Identical posture to ADR 0106 and ADR 0114's code-exec budget: the usage record is incremented **post-dispatch** from real, already-recorded token counts (the same figures `emitCost`/`recordUsage` already write); the cap CHECK happens once, at live-dispatch time. A `:fork`/replay reads the recorded turn output verbatim and does **not** re-dispatch, so there is no double-charge and no wire field touched — this mirrors the "record real usage after, check the cap before, never re-charge on replay" invariant already proven twice in this codebase (managed-tier cap, media budget).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **N/A — core cost-governance extension** (like ADR 0106/0077). Lives in `aiProviders/` or a new sibling `aiProviders/byokChatBudget.ts` + a governance-policy field. No `src/features/<id>/`, no core route/nav edits. |
| 2 | Toggle + admin UI | **No toggle** — env-gated cap (`OPENWOP_BYOK_DAILY_TOKEN_CAP`) + a superadmin per-org override via the existing ADR 0077/0106 governance route. Mirrors the no-toggle governance precedent exactly. |
| 3 | Workflow surface (0014) | No new `ctx.<feature>`. The cap enforces transparently inside the existing BYOK dispatch call site in `conversationExchange.dispatchReply`. |
| 4 | Node pack | **None** — rides the existing dispatch path every chat node already calls. |
| 5 | AI-chat integration | The soft-warning signal surfaces on the existing chat turn result (a structured, non-blocking field) — **not** a new envelope type; reuses the turn-result shape the frontend already reads. |
| 6 | Agent pack | **None** (not an AI-authoring surface — a platform-safety concern, same call ADR 0106 made). |
| 7 | Public surface | **None.** |
| 8 | RBAC + isolation (0006) | Per-`(tenant, provider)` accounting + cap; over-budget rejection fail-closed; budget override is `requireSuperadmin` (governance route). IDOR-safe (usage keyed by the run's tenant, never request input). |
| 9 | Replay / fork | Usage record is post-dispatch (real figures); cap check is at dispatch time; `:fork`/replay never re-dispatches, so no double-charge and no wire field touched. |
| 10 | Frontend | A non-blocking warning toast/banner in the chat UI when the soft threshold is crossed (reads the existing turn-result field); an optional budget + usage readout added to the existing superadmin Governance panel (ADR 0106's precedent — same panel, one more section). |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | Per-org BYOK usage accounting (mirrors `getManagedUsage`/`recordManagedUsage`) + the **hard cap check** in `conversationExchange.dispatchReply`'s BYOK dispatch branch, env-gated default-off, `byok_budget_exceeded` error → 429, fail-closed | tsc + vitest (cap-hit + under-cap + off-by-default, mirroring `mediaBudget`'s existing test shape) |
| 2 | **Soft-warning threshold.** Compute `usedPct` against the effective cap; when `usedPct >= softWarningPct`, attach a non-blocking warning field to the dispatch result (no envelope/event-type change — a structured field on the existing turn-result payload the frontend already consumes) | vitest (threshold-crossed vs not, warning absent when uncapped) |
| 3 | **Governance override + frontend.** `PUT .../governance/byok-chat-budget` (superadmin, read-modify-write preserving other `GovernancePolicy` fields, mirroring ADR 0106's editable-override phase exactly) + a `GovernancePanel` section (budget + today's usage, 4 locales) + the chat-UI warning banner | FE build + vitest |

## Alternatives weighed

1. **A toggle feature-package "Spend Limits."** Rejected — spend governance is a horizontal platform-safety concern, not a user-facing toggle feature (the identical call ADR 0106 and ADR 0077 both made). A toggle would imply per-user opt-in for what is fundamentally an operator/org-admin safety backstop.
2. **USD-denominated hard cap.** Rejected as the enforcement unit — ADR 0106 already discovered and documented this exact staleness liability for the media price table; the LLM cost table has the identical problem (cited there as `grade-code INT-1`). Tokens are the stable, already-metered unit; a USD figure is a derived read-only estimate, never the comparison.
3. **Extend `managedProvider.ts`'s `dailyTokenCap` to cover BYOK too, rather than a new sibling module.** Considered and rejected — `managedProvider.ts`'s cap is intentionally an **operator-spend** backstop (the operator's own key, the operator's own money) with an *always-on* posture; BYOK is the *user's* money, and ADR 0106 already established the correct tier-policy split for exactly this distinction ("opt-in for BYOK, always-on backstop for managed"). Folding them into one mechanism would blur that already-settled policy split. A sibling module mirroring the same shape is cleaner than overloading one with two different default postures.
4. **Do nothing (rely on ADR 0118's dashboard for an admin to notice and manually intervene).** Rejected — this is precisely the gap: a dashboard is reactive (an admin must notice, then act, potentially after real damage); the comparison's point is a **live, automatic** guardrail. The existing managed-tier cap and media budget both already prove the org already accepts live enforcement as the right shape for cost risk; BYOK chat is the one path missing it.

## Open questions

1. **OQ-1 — Soft-warning delivery mechanism.** A field on the existing dispatch/turn-result payload (proposed, no new envelope) vs. a distinct notification (reusing the existing notification-emit seam, `getNotificationEmitter`, for an out-of-band admin alert when a tenant crosses the threshold repeatedly). Recommend: ship the inline turn-result field first (Phase 2); consider the notification path only if repeated near-cap usage proves to be a real operational signal worth surfacing outside the chat itself.
2. **OQ-2 — Per-session vs per-org granularity.** This ADR proposes per-org (per-tenant) daily budgets, matching every existing precedent (`dailyTokenCap`, `mediaBudget`) exactly. The comparison's framing mentions "per-session" caps too. Recommend: per-org only for v1 — a per-session cap is a materially different (and much smaller-grained, harder-to-configure-sensibly) unit that has no existing precedent in this codebase to compose; revisit only if a concrete operator request surfaces.
3. **OQ-3 — Reset cadence.** Daily UTC (mirrors every existing cap in this codebase) vs. rolling window. Daily proposed, no deviation from precedent without a reason to.

## RFC verdict

**Host-internal — no new RFC.** Caps, usage accounting, and the soft-warning field are all host-side; the enforcement unit (tokens) and the warning signal never touch the wire as a new capability, event type, or endpoint contract — the warning rides the existing turn-result shape the frontend already reads, exactly as ADR 0106's budget check rides the existing dispatch error-mapping path. If a future need exposes a *normative* "budget remaining" field on the run/event wire (so a remote client, not just this host's own frontend, could observe it), **that** would need an RFC — out of scope here, consistent with ADR 0106's own closing note.
