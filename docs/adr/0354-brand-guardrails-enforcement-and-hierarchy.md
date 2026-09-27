# ADR 0354 — Brand guardrails: publish-blocking enforcement, brand hierarchy, persona voice, rule audit

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1, 3–5; P2 folded into P1 — see corrections) — 2026-07-12 |
| **Date** | 2026-07-12 |
| **Feature** | extends **`brand`** (ADR 0155, always-on core per ADR 0170) — no toggle change |
| **Closes** | `CSG-BR-1..4` ([gap register](../CAMPAIGN-STUDIO-GAP-FINDINGS.md)) |
| **Composes** | `host/adsAdapter.ts` gates (ADR 0167), approvalService, publish last-mile paths (ADR 0162/0166), campaign-brief personas (ADR 0156) |
| **RFC verdict** | **Host-ext, no new RFC.** |

## Context (boundaries audit)

The scorer is real (hybrid 60% deterministic / 40% LLM-judge, banned-phrase caps ≤30 —
`brand/scoring.ts:57-135`, `packs/feature.brand.nodes/index.mjs:61-142`) and injected into every
generation prompt (`resolveVoice`, `scoring.ts:149-186`). But compliance is **explicitly
non-blocking** (`packs/feature.campaign-channels.nodes/index.mjs:138-151`); `governance.
requireApproval` is advisory (`brand/types.ts:101-102`); `parentBrandId` exists with no cascade
(`types.ts:184`, deferred at ADR 0155:54); voice resolves by channel/register only (`scoring.ts:149`);
rule edits are unaudited. Enforcement chokepoints already exist and are the right owners: the
**adsAdapter spend/audience gates** (`adsAdapter.ts:279-322,963-996` — the single point node calls
can't bypass) and the publish last-mile handoffs.

## Decision

1. **Publish-block policy (CSG-BR-1).** `Brand.governance.compliance` gains
   `blockPublish: 'off' | 'critical' | 'threshold'` (+ `blockThreshold`, default 60). Enforcement
   lives at the **existing gates**, not in generation:
   - `adsAdapter.publishAd`/`updateBudget`: alongside the spend gate, a compliance gate — under
     `critical`, a banned-phrase (score-capped) result **forces `requires_approval`** through the
     same approvalService flow the spend gate uses (never a silent block; a human can override with
     the approval). Under `threshold`, score < `blockThreshold` does the same.
   - The draft handoff legs (CMS/email/document publishes, ADR 0162/0166) apply the same policy
     before promoting a draft.
   - **Fail-closed:** if scoring errors while `blockPublish != 'off'`, treat as non-compliant →
     `requires_approval` (mirrors the audience-gate default-deny posture).
   Generation itself stays non-blocking (drafts always land for iteration) — the gate is at the
   *edge where content leaves the tenant*, which is where the money/reputation risk is.
2. **Brand hierarchy cascade (CSG-BR-2).** `resolveEffectiveBrandRules(brandId)`: walk
   `parentBrandId` (cycle-guarded, depth ≤ 5); **banned phrases and avoid-lists are additive down
   the chain** (a child can extend, never remove); voice/tone fields override nearest-wins. Scorer +
   `resolveVoice` consume the effective set. Pure function, unit-tested.
3. **Persona voice dimension (CSG-BR-3).** `ChannelVoiceRule` gains optional `personaId`;
   `resolveVoice({ channel?, register?, personaId? })` prefers the persona-specific rule, falling
   back to the channel rule. The brief context assembler (ADR 0156) passes the brief's persona ids.
4. **Rule audit trail (CSG-BR-4).** Append-only `brand:audit` rows (who/when/field-level before →
   after) written by the brand service on every rule mutation; listed read-only on the brand page.
   Compliance *decisions* remain replay-safe node outputs (unchanged).

## Phases

| Phase | Ships | Gaps |
|---|---|---|
| 1 | `blockPublish` policy + adsAdapter compliance gate (requires_approval path) + fail-closed | BR-1 |
| 2 | Draft-handoff legs honor the policy | BR-1 |
| 3 | Effective-rules cascade (pure fn) wired into scorer + resolver | BR-2 |
| 4 | Persona voice rules + assembler passthrough | BR-3 |
| 5 | Rule audit rows + FE list | BR-4 |

## Matrix highlights

Feature stays always-on core (ADR 0170); the *policy* defaults `blockPublish:'off'` so behavior is
unchanged until a tenant opts in. Packs: `feature.brand.nodes` bump (`compliance-check` reads
effective rules). Replay/fork: gate outcomes ride the approvalService rows (fork-stable keys, the
spend-gate precedent). RBAC: policy edits = the existing brand governance surface (`accessControl`);
audit rows read = `workspace:read`.

## Alternatives weighed

- *Block at generation time*: rejected — kills the iterate-on-drafts loop; the leak risk is at
  publish/dispatch, so the gate belongs at the adsAdapter/handoff chokepoints.
- *Hard block with no human override*: rejected — `requires_approval` keeps a governed escape hatch
  and reuses the existing approval UX instead of a new refusal surface.
- *Score-cascade across brands via duplication*: rejected — effective-rules resolution keeps one
  source of truth per rule.

## As-built corrections (2026-07-12)

- **P2 folded into P1**: the draft-handoff legs (CMS/email/document drafts) are the
  ITERATION space — blocking them contradicts this ADR's own edge principle. The one real
  egress edge is ads dispatch; drafts keep their attached compliance reports. No handoff-leg
  gate shipped (deliberate).
- **Host/feature boundary**: adsAdapter (host) gates via a REGISTERED checker seam
  (`setAdsComplianceChecker`) — the brand feature builds the checker
  (`buildAdsComplianceChecker`), resolving brief→brand lazily through campaign-brief. A
  non-allow verdict reuses the SAME campaign-spend approval machinery (`cmpl:`-prefixed
  fork-stable key) — one approval UX.
- **Fail-closed split**: POLICY evaluation failures fail closed inside the checker
  (requires-approval); a checker TRANSPORT crash in adsAdapter logs + allows (a missing
  brand binding must never block unbranded dispatch).
- `critical` covers banned phrases only (open Q1: as suggested). Audit cap 500/brand (Q2).
- **FE policy knob deferred**: the compliance policy is a governance field (API/agent-set);
  a brand-page select ships with the next brand-UI pass.
- **Unbriefed dispatches — tenant-default brand policy SHIPPED (BRAND-CODE-6)**: a
  `publishAd` call with no `briefId` has no brief→brand binding. Rather than leave it
  ungoverned, the checker now consults a **tenant-default brand compliance policy** —
  **Option A**: an additive optional field on the existing host `GovernancePolicy`
  (`brandCompliance: { blockPublish; blockThreshold?; defaultBrandId? }`), NOT a parallel
  store. When it is present, `blockPublish !== 'off'`, and it names a `defaultBrandId`,
  the unbriefed path loads that brand and runs the **same** deterministic scorer the
  briefed path uses (refactored into one shared `scoreBrandCompliance` helper — one
  scorer, two legs). It degrades to `allow` (fail-open) when no policy / `off` / no
  `defaultBrandId` / the default brand row is gone (a configured-but-missing default logs
  a warn — a real misconfig signal), preserving the pre-0354 open posture for unbriefed
  dispatch. Tenant-scoped; an **org-level** default is deferred. Set via the superadmin
  governance route (`PUT …/governance/policy`, `brandCompliance` field); the field
  round-trips through the `GovernancePolicy` Pick allowlist + the GET.
- **Grade-pass hardening (2026-07-12)**: the compliance gate RE-CREATES its approval when
  the mapped `cmpl:` row points at an approval that no longer loads (pruned resolved rows
  must not fall the gate open — BRAND-CODE-1); the checker fails CLOSED on any
  brand-load/scoring crash once a brandId is resolved (fail-open remains only on the
  brief→brand resolver leg — BRAND-CODE-2); the gate scores copy VALUES, not the JSON
  envelope (BRAND-CODE-5); parent-cascaded bans also flow through the
  `ctx.features.brand` surface ops (`checkComplianceDeterministic`/`resolveVoice`), so
  packs see the same effective rules as the dispatch edge (BRAND-CODE-4).

## Phase → implementation record

| Phase | Ships | Evidence |
|---|---|---|
| 1 (+2) | `governance.compliance` policy + `setAdsComplianceChecker` seam + publishAd gate → spend-approval flow | `host/adsAdapter.ts`, `brand/brandService.ts`, `brand/feature.ts`; `test/brand-enforcement.test.ts` |
| 3 | `resolveEffectiveBrandRules` — additive-ban cascade (cycle-guarded, depth ≤5) + scorer `extraBannedPhrases` | same |
| 4 | `ChannelVoiceRule.personaId` + persona-preferred `resolveVoice` + surface/pack passthrough (channels pack 1.5.0) | same |
| 5 | `brand:audit` append-only guardrail diffs (cap 500) + GET `/brands/:id/audit` | same |
