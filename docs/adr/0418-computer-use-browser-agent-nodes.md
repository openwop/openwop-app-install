# ADR 0418 — Computer-use browser-agent nodes (provider-API lane, HITL-gated)

Status: implemented (P1–P4 engine-side, 2026-07-18) — live-provider integration EXTERNAL-DEP-GATED (see §P2 correction)

> **§P2 correction (2026-07-18):** the ADR's "provider hosts the browser" premise
> does not hold for Anthropic today — computer-use is CLIENT-executed (model-side
> tool, no hosted-browser API to call). Hosted sessions come from
> Browserbase-class services. Per the ADR 0404 P3c rule (never a guessed live
> API), the live adapter is **gated on an operator-supplied provider** with
> verified docs/credentials; the seam ships honest-off (`capability_not_provided`
> without `OPENWOP_COMPUTER_USE_PROVIDER`; the mock is explicit-opt-in). Every
> engine-side invariant is implemented + tested against the mock seam.

## Implementation record

| Phase | What landed |
|---|---|
| P1 | Adapter contract + deterministic mock; durable session store (requestHash CAS submit-once); the tiered control loop (observe/interact auto-advance recorded, commit-class halts `awaiting_approval`), fail-closed https origin allowlist on provider-reported URLs, step ceiling + per-call advance budget, feature-local KV daily session budget (imagegen precedent; pre-submit failures release the claim + refund — no tombstone), ctx surface, toggle (off/tenant/Agents), seed ACK, `feature.computer-use.nodes` 1.0.0 (task/decide/status). 13 tests. |
| P2 | The honest-off provider seam (above). HITL rides the recorded chain shape task → `core.approvalGate` → decide (no new approval flow); screenshot/media artifact storage joins the live-provider gate (no real screenshots exist to store from the mock). |
| P3 | `feature.computer-use.agents` 1.0.0 — the Browser Operator persona (chat-drivable per ADR 0058; never handles credentials, presents pending actions, never self-approves) + session read routes (`workspace:read`, org-scoped, read-only — writes stay on the recorded node lane). FE trajectory viewer deferred WITH the provider gate (no live trajectories to view; the session store is reachable via status node/route). |
| P4 | Hardening review against the §Decision invariants: submit-once (test: identical inputs, zero provider calls), tier closed-world (every kind classified), allowlist fail-closed incl. unparseable URLs, ceilings, budget release/refund, tenant-guarded reads, honest-off node behavior. |

**Gate to lift the deferral:** an operator supplies a hosted-session provider
(credentials + verified API contract) → implement the adapter behind BYOK +
`brokeredEgress`, wire screenshot→media-asset lineage, ship the trajectory
viewer, and red-team the allowlist/approval surfaces against live behavior.

Decision source: **docs/steward/GAP-SWEEP-2026-07.md §3 row 1** — computer-use/browser agents
are mid-2026 table stakes (OpenAI ChatGPT agent, Anthropic Computer Use, Google
Gemini Computer Use, Zapier agents) — and the 2026-07-18 `/architect` audit:
**no runtime browser/automation surface exists anywhere in the app** (the only
hits are the dev-only `tools/browser` harness and incidental user-agent
handling), making this the batch's one genuinely-new surface. The audit fixed
the seams v1 MUST ride; they are this ADR's acceptance criteria.

## Context

An agent here can call APIs (connections, MCP) but cannot act on a third-party
site with no API — fill a form, download a statement, complete a portal step.
All three frontier providers now ship computer-use APIs where the PROVIDER
hosts the browser/VM and the client drives a screenshot→action loop. That
hosted lane fits this app: no browser infrastructure to run, the loop is just
turns, and every side effect can ride the existing HITL machinery.

## Decision

A new feature package `computer-use` (toggle OFF, tenant bucket) + a
`feature.computer-use.nodes` pack, on the **provider-API lane** (no self-hosted
browsers in v1). The invariants — each mapped to an existing owner, none new:

1. **The loop is a workflow, steps are recorded actions.** A `computer-use.task`
   node runs the screenshot→model→action loop against the provider API. Every
   action batch is recorded (role:action) — replay/fork reads the recorded
   trajectory and NEVER re-drives the browser (the creative-video submit-once
   discipline applied to sessions).
2. **HITL by risk tier, via the existing gates.** Action classes are tiered:
   `observe` (screenshot/read) auto-approved; `interact` (click/type on the
   current site) session-approved once; `commit` (submit/purchase/download,
   credential entry, ANY navigation to a new origin) each gated through
   `core.approvalGate`/`core.interrupt` — the approval card shows the
   screenshot + intended action. **Never a new approval flow** (seam L130).
   Credential entry is v2-at-earliest and would ride the Connections broker —
   the model NEVER sees secrets (BYOK invariant).
3. **Egress through the chokepoint.** All provider calls ride
   `brokeredEgress`/`guardedEgressFetch` (HTTPS, SSRF pins); the task's
   target-origin allowlist is part of node config, validated closed-world, and
   enforced host-side by inspecting provider-reported URLs — a navigation
   outside the allowlist fails the step closed.
4. **Artifacts, not blobs in events.** Screenshots/downloads store as media
   assets with lineage (`generatedBy:'computer-use'`, task ref); the run event
   carries asset refs (the ADR 0115 serve-reference pattern). Downloads pass
   the media capacity gate before storage.
5. **Budgets.** Sessions meter against the ADR 0106 media-budget family with a
   new `computer-use` kind (per-tenant daily cap, default conservative);
   step-count + wall-clock ceilings per task (runaway-loop backstop).
6. **Wire posture: none.** v1 is a node pack + host adapter — no
   `/.well-known/openwop` capability advert, so **no RFC** (the ADR 0411
   precedent). IF a second consumer later wants `ctx.callComputerUse` as a host
   capability, that is a spec conversation first (recorded as the gate).

Provider order: Anthropic computer-use first (portable screenshot+action tool
shape), the adapter seam (`computerUseProviderAdapter.ts`, mirroring
`videoProviderAdapter.ts`) keeping OpenAI/Google pluggable. BYOK keys via the
standard resolver; `adapterOnly` governed-spend posture.

## Alternatives weighed

- **Self-hosted Playwright/Chromium workers** — rejected for v1: heavy infra
  (Cloud Run is a poor fit for long-lived browser VMs), a large new attack
  surface, and the provider lane ships the capability at a fraction of the
  cost. Recorded as a possible v2 for data-residency-sensitive operators.
- **MCP to a third-party browser service** (Browserbase-class) — viable, but
  it moves the HITL gate outside the host's control loop; the node lane keeps
  every action inside the recorded, gated workflow. An MCP bridge remains
  possible for operators who prefer it (it composes; nothing forecloses it).
- **Chat-tool-only (no workflow node)** — rejected: multi-minute sessions
  belong on durable runs (resume, replay, audit), not chat turns; the chat
  drives it via the agent-pack + node pattern (ADR 0058) instead.

## Phased implementation plan

- **P1 — adapter + task node (mock-first)**: the provider adapter seam + a
  `mock` provider (deterministic screenshot/action fixtures — the creative-video
  test discipline), the task node with tiering/allowlist/budget enforcement,
  route-level authz tests, replay test (recorded trajectory, zero provider
  calls on replay).
- **P2 — Anthropic provider + HITL cards**: live adapter behind BYOK; approval
  cards with screenshot rendering in the existing interrupt UI; origin-
  allowlist enforcement tests against provider-reported navigation.
- **P3 — agent pack + FE surface**: `feature.computer-use.agents` persona
  (chat-drivable per ADR 0058), a task-review surface (trajectory viewer over
  the stored artifacts) on the runs page — composition, not a new page system.
- **P4 — hardening pass**: /architect + security review against the §Decision
  invariants (they are the acceptance criteria), red-team the allowlist and
  approval-bypass surfaces, budget/quota tuning.

## Open questions

- OQ-1: default origin-allowlist posture — empty (operator must configure) vs
  a curated safe list? Leaning empty/fail-closed.
- OQ-2: does the trajectory viewer belong on the runs page or the media
  library? (Runs — it is an execution record.)
- OQ-3: multi-provider consensus on risky actions (two models must agree a
  `commit` action matches intent) — v2 idea, recorded only.
