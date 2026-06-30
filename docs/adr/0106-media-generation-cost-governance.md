# ADR 0106 — Per-org media-generation cost governance (transcription + TTS budgets + pre-flight estimate)

**Status:** implemented (Phases 1–3, 2026-06-22)
**Date:** 2026-06-22
**Depends on:** ADR 0077 (data governance / retention — the sibling core-governance
extension this mirrors), ADR 0085 (audio/video source ingestion), ADR 0086
(multi-speaker podcasts), ADR 0024 (BYOK + managed provider tiers).
**Surface:** host runtime only. No wire change. **NON-NORMATIVE — no new RFC.**

> Originates as gap **MEDIA-7** from the 2026-06-22 grade-code audit ("no per-org
> transcription/TTS cost guard or pre-flight estimate"). This ADR records the design;
> it does not implement.

## Why this exists

The audio surfaces (ADR 0085/0086) make **paid external provider calls per run** —
speech-to-text (`ctx.callAI` with an audio part) and text-to-speech
(`ctx.callSpeechSynthesizer` → MiniMax/OpenAI/Google). Today the only guards are:

- a **per-call** input cap — `MAX_SPEECH_CHARS = 50_000` (`aiProvidersHost.ts:516`) for
  TTS and a 32 MiB decoded-bytes cap for a single transcription
  (`packs/feature.notebooks.nodes/index.mjs`); and
- the **managed-tier** daily token cap for LLM chat (`managedProvider.ts:292`,
  `dailyTokenCap` + `storage.getManagedUsage`) — which does **not** cover the media
  (STT/TTS) path at all.

So a tenant can stay under every per-call cap yet run an **unbounded aggregate** of
media calls (a podcast loop, repeated transcriptions) with no per-org ceiling and **no
way to know the cost before committing the run**. That is a real operator-spend and
abuse exposure on a BYOK + multi-instance Cloud Run host.

## Boundaries & pre-existing-surface audit

| Claim | Evidence | Verdict |
|---|---|---|
| No per-org **cost/spend cap** exists today | `grep -rn "org.*budget\|costGuard\|spendCap"` → only `turnPolicy`, seed data, no cost cap | **genuinely new** |
| A per-tenant **daily cap** pattern already exists (LLM only) | `managedProvider.ts:292` `dailyTokenCap`; `storage.getManagedUsage(tenant, provider, date)` | **compose this pattern**, don't invent |
| A **cost-emission** seam already exists | `observability/costEmitter.ts` `emitCost(record)`, called post-dispatch (`aiProvidersHost.ts:361`) | **reuse** — usage accounting reads the same figures |
| A **per-call** media backstop already exists | `aiProvidersHost.ts:516,555` `MAX_SPEECH_CHARS`; node-side 32 MiB decode cap | **extend**, don't duplicate — add the aggregate ceiling above it |
| Governance config has a **home + admin gate** | ADR 0077 `governanceService` + `routes/governance.ts` (`requireSuperadmin`) | **extend** the governance config, no new feature surface |

**Conclusion:** this is **not** a feature-package. It is a **core cost-governance
extension** — the spend sibling of ADR 0077's retention sweep — that rides the existing
managed-cap accounting pattern, the existing cost emitter, and the existing governance
admin surface. No new toggle, no new `src/features/<id>/`, no packs, no agents.

## Decision

Add a **per-org media-generation budget** with a **pre-flight estimate**, enforced
host-side in the `aiProviders` speech/transcription path:

1. **Unit of account.** TTS = **characters** (already the natural unit; `MAX_SPEECH_CHARS`
   counts them). Transcription = **decoded input bytes** (cheap to measure pre-flight; the
   32 MiB per-call cap already computes it). Both roll up into one per-org daily counter
   `{ ttsChars, sttBytes }` keyed `(tenantId, orgId, dateUtc)`, mirroring `getManagedUsage`.
2. **Budget check (the aggregate ceiling).** Before a media dispatch, read the day's usage
   and reject when the next call would cross the configured per-org budget — the same
   shape as `daily_limit_reached`, with an actionable error (`media_budget_exceeded`,
   carrying the cap + reset time). Fail-**closed** when enabled.
3. **Pre-flight estimate.** A pure `estimateMediaCost({kind, chars|bytes, provider, model})`
   (reusing the `usageEmitter` rate table) returns `{estimatedUsd, wouldExceedBudget}` so a
   route can reject an over-budget request **synchronously at enqueue** (notebooks/podcasts
   routes) instead of failing mid-run.
4. **Env-gated, default-off.** `OPENWOP_MEDIA_*_BUDGET` per-org defaults + an operator
   global ceiling, exactly like `OPENWOP_MANAGED_DAILY_TOKEN_CAP` /
   `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP`. A superadmin may set a per-org override via
   the existing governance admin route (ADR 0077). Off ⇒ today's per-call-only behaviour,
   unchanged.

### Tier policy (open question resolved)

- **Managed tier** (operator's key): the budget is an **always-on operator backstop** (the
  operator pays) — defaults to the global media ceiling.
- **BYOK** (user's own provider key): the budget is **opt-in cost control** per org (the
  user pays, but an org admin may still want a guardrail). Off by default for BYOK so a
  BYOK user is never blocked by a cap they didn't ask for.

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (ADR 0001) | **N/A — core cost-governance extension** (like ADR 0077). Lives in `aiProviders/` (cap check + estimate) + a `mediaUsageService` + storage `get/recordMediaUsage`. No `src/features/<id>/`, no core route/nav edits. |
| 2 | Toggle + admin UI | **No toggle** — env-gated caps (`OPENWOP_MEDIA_*_BUDGET`) + a superadmin per-org override via the ADR 0077 governance route. Mirrors the managed-cap + retention-window precedent (both no-toggle governance). |
| 3 | Workflow surface (0014) | No new `ctx.<feature>`. The cap enforces transparently inside the existing `ctx.callSpeechSynthesizer` / `ctx.callAI` audio path; the estimate is a host-internal helper the enqueue routes call. |
| 4 | Node pack | **None** — rides the existing `aiProviders` host surface the notebooks/podcasts nodes already call. |
| 5 | AI-chat envelopes | **None.** |
| 6 | Agent pack | **None** (not an AI authoring surface). |
| 7 | Public surface | **None.** |
| 8 | RBAC + isolation (0006) | Per-`(tenant, org)` accounting + cap; over-budget rejection is fail-closed; budget overrides are `requireSuperadmin` (governance route). IDOR-safe (usage keyed by the run's tenant/org, never request input). |
| 9 | Replay / fork safety | `emitCost`/usage record is post-dispatch (real figures); the cap check is at dispatch time. A `:fork`/replay re-reads recorded outputs and **does not re-dispatch**, so no double-charge and no wire field touched. |
| 10 | Frontend | Optional: a budget field + usage readout in the existing superadmin **Governance** panel (ADR 0077). Not required for Phases 1–2. |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | Per-org media **usage accounting** (`storage.{increment,get}MediaUsage` mirroring `getManagedUsage`) + the **aggregate cap check** in the `aiProvidersHost` TTS dispatch (`callSpeechSynthesizer`), env-gated default-off, `media_budget_exceeded` error → **429**, `emitCost` unchanged | tsc + vitest (cap-hit + under-cap + off-by-default) |
| 2 | **Pre-flight estimate** (`estimateMediaCost`, pure, reuses the `usageEmitter` rate table) + **STT byte-budget enforcement at the routes** wired into the notebooks `/sources/audio` + podcasts enqueue routes → synchronous over-budget 4xx instead of a doomed async run | vitest (estimate + route rejection) |
| 3 | **Frontend** read-only budget + usage readout in the superadmin Governance panel (`GET …/governance/media-budget` + a `GovernancePanel` section, 4 locales) | FE build |

> **Phase 3 note (2026-06-22, implemented):** ships the readout (configured env budgets + today's usage, superadmin-gated).
>
> **Editable override (2026-06-22, implemented — the matrix-row-10 follow-on):** the per-org budget OVERRIDE is now editable. `GovernancePolicy` gains an optional `mediaBudget?: { ttsChars?, sttBytes? }` (a present field — incl. `0` = uncapped — overrides the host env default for that org; absent ⇒ env). `checkMediaBudget`/`recordMediaUsage` consult it via a **DI seam** — `configureMediaBudget({ resolveOverride })` wired at bootstrap to `getGovernancePolicy`, so `aiProviders/mediaBudget` never imports `governanceService` (no cross-module edge, no cycle); the resolver is **fail-soft** (a governance-read outage falls back to env, never blocks a paid call). `PUT /v1/host/openwop-app/governance/media-budget` (superadmin, validated, audited) is a **read-modify-write** that preserves the other policy fields (the policy store does a full replace). The `GovernancePanel` section is now editable (number inputs, blank ⇒ env default, 0 ⇒ uncap, 4 locales). +9 backend tests (override resolution + route) + 3 FE tests.

> **Implementation correction (Phase 1, 2026-06-22):** STT (transcription) metering was planned for the in-dispatch `callAI` audio path, but `callAI` carries an **invocation-log cache + `:fork` replay** — metering there would double-count bytes on replay (violating this ADR's no-double-charge invariant) and require hooking a replay-sensitive hot path. STT enforcement therefore moves to the **upload route** (Phase 2), where decoded bytes are known synchronously with no cache/replay concern. TTS stays in `callSpeechSynthesizer` (synthesis happens inside recorded nodes, so a fork replays the recorded node output without re-invoking the synthesizer — replay-safe). The `media_provider_usage` table + `mediaBudget` module ship in Phase 1 and already support both kinds.

> **Phase 2 notes (2026-06-22, implemented):** the **STT byte budget** is pre-flighted at the notebooks `/sources/audio` route (`estimateMediaBytes` → `checkMediaBudget('stt')` → 429 `rate_limited` before enqueue; `recordMediaUsage('stt')` after a successful enqueue — once per upload, replay-safe). The **USD cost figure** the original Phase 2 sketch mentioned is **deferred**: a media-price table (per-char TTS / per-byte STT) is the same staleness liability as the LLM cost table (cf. grade-code INT-1), so the pre-flight "estimate" ships as the **unit projection** (`{used, cap, nextTotal, exceeded}` from `checkMediaBudget`) — the load-bearing signal that lets the route reject pre-flight — not a fabricated dollar amount. A **podcasts** pre-flight estimate is **not feasible at enqueue** (the transcript that determines TTS char count is generated mid-run); podcast TTS is therefore governed at synth time by the Phase 1 in-dispatch budget, which is the correct chokepoint.

## Alternatives weighed

- **A toggle feature-package "Media Budgets"** — rejected: spend governance is a horizontal
  platform-safety concern, not a user-facing toggle feature (the exact call ADR 0077 made
  for retention). A toggle would imply per-user opt-in for an operator-spend backstop.
- **Per-call cap only (status quo)** — rejected: `MAX_SPEECH_CHARS` + the 32 MiB decode cap
  bound a *single* call, never the aggregate; a loop of small calls is unbounded.
- **Provider-side budgets** — N/A: BYOK keys mean the host, not the provider, must enforce;
  managed keys are the operator's, enforced here already for LLM.

## Open questions / decisions checklist

- [ ] Transcription unit of account — **decoded bytes** (proposed, cheap pre-flight) vs
      audio-minutes (needs a decode) vs post-hoc tokens. Bytes chosen unless a minutes
      proxy proves materially more accurate for the rate table.
- [ ] Reset cadence — **daily UTC** (mirrors managed caps) vs rolling 30-day. Daily proposed.
- [ ] Does the global media ceiling share the managed-LLM global counter or get its own?
      Proposed: **separate** counter (`media` vs `tokens`) so an operator can budget them
      independently.

## RFC verdict

**Host-internal — no new RFC.** Caps, usage accounting, and the pre-flight estimate are
all host-side; credentials and cost figures stay off the wire (the same posture as the
ADR 0077 retention sweep and the managed daily cap). A capability is advertised only if/
when wired. If a future need exposes a *normative* "media budget remaining" field on the
run/event wire, **that** would need an RFC — out of scope here.
