# ADR 0101 — Fold the agent Profile into Instructions as "Guardrails"; make the kept fields enforce

**Status:** Accepted
**Date:** 2026-06-22
**Depends on:** ADR 0031 (the `agentProfile` shape), ADR 0033 (`requiredConnections`
activation gating — `host/connectionReadiness.ts`), ADR 0036 (`permissions.never` /
`hitl` / `withinPolicyActions` enforcement via `host/agentPolicyResolver.ts`,
composed at the heartbeat pick + assistant action enqueue), ADR 0010 (notifications),
the new agent **Edit-details modal** (#598 — `roster.autonomyLevel` is now an
owner-editable field and the single autonomy source the heartbeat reads).
**Implements (host-local):** RFC 0064 (tool-invocation hooks & authorization,
`Accepted`) for Phase 4 — `host/toolHooks.ts` already exists.
**Surface:** host runtime + the agent-workspace UI. No OpenWOP wire field, capability
flag, or run-event. **NON-NORMATIVE — no new RFC** (Phase 4 rides the already-Accepted
RFC 0064; everything else is host product config under `/v1/host/openwop-app/*`).

## Why this exists

The agent workspace grew two overlapping behaviour surfaces:

- **Instructions** (the `systemPrompt`) — *functional*: injected into the model on
  every chat reply (`conversationExchange.ts:302`) and agent-routed workflow node
  (`bootstrap/nodes.ts:1422`).
- **Profile** (`agentProfile`, ADR 0031/0036) — a 9-section governance tab that is
  **mostly inert metadata**. An enforcement audit found only four fields actually fire:
  `permissions.never` (hard-deny), `hitl` (force review), `requiredConnections`
  (autonomy gate), and `autonomy.withinPolicyActions` (auto-mode allowlist), all via
  `agentPolicyResolver.ts`. `permissions.read/write`, `escalation`, `channels`,
  `adminControls`, `riskCompliance`, `metrics`, and `configParameters` (except the
  nested `.compaction` key) are stored-and-displayed only.

Two concrete problems:

1. **Capability dishonesty** — the tab presents guardrails the runtime doesn't honour
   (the exact failure ADR 0036 set out to fix, left half-done).
2. **An autonomy duplication bug** — Profile's `specLevel` selector is decoupled from
   `roster.autonomyLevel`, which is the field the heartbeat actually reads
   (`autonomyOf(entry)`, `heartbeatService.ts`) and which the new Edit-details modal
   now owns. Two autonomy controls, only one wired; editing Profile's changes nothing.

## Decision

**Fold the enforced governance into the Instructions tab as a "Guardrails" section,
remove the standalone Profile tab, make the kept fields honest, and fix the autonomy
single-source-of-truth.** Same slimmed view in the admin Roster modal (it reuses
`AgentProfilePanel`), so the two stay consistent.

### Field disposition

| Field | Decision | Rationale |
|---|---|---|
| `permissions.never` | **Keep** (enforced) | hard-deny, `agentPolicyResolver.ts:116` |
| `hitl` | **Keep** (enforced) | force review, `:122` |
| `requiredConnections` | **Keep** (enforced) | autonomy gate, `connectionReadiness.ts:75` |
| `autonomy.withinPolicyActions` | **Keep** (enforced; auto only) | allowlist, `:167` |
| `permissions.read` / `permissions.write` | **Keep + BUILD** (Phase 4) | per-tool enforcement via toolHooks (RFC 0064) |
| `escalation` {contacts,triggers} | **Keep + BUILD** (Phase 2) | notify on review/deny via ADR 0010 seams |
| `metrics` | **Keep + BUILD** (Phase 3) | surface on Overview |
| `autonomy.specLevel` (editor selector) | **Remove from UI** | duplicate of `roster.autonomyLevel`; derive it instead |
| `channels` | **Remove** (drop on save) | inert; in-app inbox is the default |
| `adminControls`, `riskCompliance` | **Remove** (drop on save) | governance notes, nothing to enforce |
| `configParameters` | **Remove from editor; CARRY THROUGH on save** | inert *except* `.compaction`, which is functional (`tool-output-compaction/decision.ts`) — dropping it would silently disable per-agent compaction |

### Autonomy single-source-of-truth (the bug fix)

`roster.autonomyLevel` (owned by the Edit modal, read by the heartbeat) becomes the
ONLY autonomy control.

- Remove the `specLevel` selector from the Guardrails UI.
- `host/agentPolicyResolver.ts` gates `withinPolicyActions` on the **passed roster
  `level === 'auto'`** instead of `profile.autonomy.specLevel === 'autonomous-within-policy'`
  (`:164`). This makes the allowlist key off the field that's actually authoritative.
- On profile save, the backend **derives** `profile.autonomy.specLevel` from
  `roster.autonomyLevel` (review→`recommend`, guided→`execute-with-approval`,
  auto→`autonomous-within-policy`) so the stored provenance can't disagree with the
  enforced level. The FE no longer sends `specLevel`.
- Guardrails shows the `withinPolicyActions` allowlist only when `roster.autonomyLevel
  === 'auto'`.

### Data preservation on the full-replace PUT

`PUT /agents/:id/profile` is a full replace. The slim editor sends only kept fields
**plus a verbatim carry-through of `configParameters`** (so `.compaction` survives).
`channels`/`adminControls`/`riskCompliance` are intentionally omitted → dropped on the
next save (they're inert; no functional loss). Existing stored values remain until a
re-save (harmless, unread). No destructive migration required.

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Fold + autonomy SSoT** | Guardrails section in Instructions; remove Profile tab; slim `AgentProfilePanel` to kept fields; relocate the self-gating `AgentTwinPanel` (twin-recall) to the Integrations tab; backend derives `specLevel` from roster level + resolver gates on roster `level`; **update `exampleAgents.json` seed profiles** (strip `channels`/`adminControls`/`riskCompliance`/`configParameters`, keep `permissions`/`hitl`/`escalation`/`requiredConnections`/`metrics`); route + resolver tests. | none — shippable; fixes the duplication bug |
| **2 — Escalation → notifications** | At the heartbeat propose path (`heartbeatService.ts` `mustPropose`), resolve `escalation.contacts` via `approverResolution.resolveNotificationRecipients` and push via `notificationAdapter` (the `kanbanAssignmentNotify` pattern). Idempotent on the proposal/card key; fails open (no notify ≠ block the proposal). | none |
| **3 — Metrics on Overview** | Render `profile.metrics` as "Success metrics" on the Overview tab; optionally feed `AgentHealthPanel` (chief-of-staff). Display-only. | none |
| **4 — Per-tool read/write enforcement** | Compose `permissions.read/write` into `host/toolHooks.ts` `evaluateToolHook` (RFC 0064): a tool call outside the allowlist for its exec-class → `forbidden`, fail-closed, verdict stamped for deterministic replay. | **Design gate:** the tool→read/write **exec-class mapping** (RFC 0069 exec-classes). Own test suite. May split to ADR 0102. |

## Implementation status

| Phase | Status | Commits |
|---|---|---|
| 1 — Fold + autonomy SSoT | ✅ implemented | fold+SSoT, code-review fixes, ux-review copy |
| 2 — Escalation → notifications | ✅ implemented | `host/escalationNotify.ts` + heartbeat propose hook + test |
| 3 — Metrics on Overview | ✅ implemented | `AgentMetricsCard` on the Overview tab (self-hiding) |
| 4 — Per-tool read/write enforcement | ✅ logic + gate landed (ADR 0102) | `host/agentToolPermissions.ts` + `runChatToolLoop` gate (env-flagged) + tests; live default-on is the ADR 0102 gate |

## Risks

- **Capability honesty** — until Phases 2/4 land, `escalation`/`read`/`write` are kept
  in the UI but not yet enforced. Mitigation: label them "enforced after save" only
  once wired; ship Phase 1 with the truly-enforced four prominent and the to-build
  three clearly marked, or sequence Phases 2–4 close behind Phase 1.
- **Replay/fork** — escalation notifications fire at *heartbeat-propose* time, outside
  the run payload, so run `:replay`/`:fork` never re-fires them. Phase 4 denials MUST
  be stamped so a replayed run reproduces the same `forbidden` verdict (no live
  re-resolution).
- **IDOR/tenant** — unchanged; the profile routes already gate by roster ownership
  (`agentProfile.ts` `requireOwnedAgent`). Escalation recipient resolution stays
  tenant-scoped (`approverResolution` already is).
- **Idempotency** — escalation notify keyed on the proposal/card id so retries and the
  autonomous daemon's re-scan don't duplicate.

## Open questions / decisions checklist

- [ ] Phase 4: confirm the tool exec-class source (RFC 0069) and whether read/write
      classification is per-tool-id or per-class; split to ADR 0102 if the mapping is
      non-trivial.
- [ ] Keep a hidden "advanced" escape hatch for `configParameters` (compaction), or
      give compaction its own control later?
- [ ] `AgentTwinPanel` new home — Integrations tab (proposed) vs a small Guardrails
      sub-section. It self-gates on `twin-recall`, so placement is low-risk.
