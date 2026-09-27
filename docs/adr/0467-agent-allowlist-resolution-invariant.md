# ADR 0467 — Agent-allowlist resolution invariant: every allowlisted tool must resolve at dispatch

| | |
|---|---|
| **Status** | implemented |
| **Date** | 2026-07-22 |
| **Deciders** | architect review (chat-first-port remediation Phase 1) |
| **Relates to** | ADR 0358 (app-builder exchange remediation — the repair pattern), ADR 0308 (feature-registered deliverable tools), ADR 0081 P3 (node-as-tool projection), ADR 0315 (default-on baseline), docs/steward/CHAT-FIRST-PORT-AUDIT.md (cross-cutting finding #1) |

## Context — the bug class

The whole-app chat-first port sweep (docs/steward/CHAT-FIRST-PORT-AUDIT.md, 62 units) found
ONE dominant THEATER class: agent packs whose `toolAllowlist` entries are node
typeIds (or otherwise unregistered ids) that no provider projects into
conversational tools. Both model-offering lanes intersect the allowlist with
exactly `builtinAgentToolIds()` — the chat loop
(`conversationToolLoop.ts:304`) and the run lane
(`agentRunnerNode.ts` `availableTools: offerTools ?? builtinAgentToolIds()`) —
and `resolveAgentTools` (`agentDispatch.ts`) **silently drops** anything the
provider cannot describe. The persona loads, responds, and can call nothing.

It shipped green because the prior lint (`agent-prompt-tool-ids.test.ts`) pins
prompt *mentions* against a universe that includes raw node typeIds — it
asserts the string, not resolution. The tripwire run on 2026-07-22 found **234
unresolvable entries across 54 packs** — including packs earlier reviews had
rated clean by reading the allowlist string (kb, marketplace, analytics).

## Decision

1. **The invariant (test-enforced):** every agent-pack `toolAllowlist` entry
   MUST be present in `builtinAgentToolIds()` after app boot, or be listed in
   a documented in-test exemption map (empty by design).
   `backend/typescript/test/agent-allowlist-resolution.test.ts` boots the real
   app (`createApp`, memory storage) and asserts resolution — never a source
   scan. If the exemption map ever grows, that is the signal the projection
   seam needs an RFC-grade design, not more exemptions.
2. **No pack-schema change.** A "run-only" pack field was rejected: it would
   touch the RFC-governed pack schema for an escape hatch the evidence says is
   unnecessary (correct packs — kicktodo, app-builder — allowlist only real
   conversational tools; nodes belong in workflows, not allowlists).
3. **Repair pattern (per feature), in preference order:**
   - **Pure nodes** (`role:"pure"`, no ctx surface/secrets/egress) → add to
     `PROJECTABLE_COMPUTE_NODE_TYPE_IDS` (ADR 0081 P3 lane).
   - **Surface-backed capabilities** → feature `agentTools.ts` registering
     real tools via `registerFeatureAgentTool` (ADR 0308 seam) that share the
     HTTP routes' access predicate, fail EMPTY on reads / TYPED on actions
     without an acting user, resolve the feature toggle inside `run()` with
     the SAME `{tenantId, userId}` subject the routes use, validate
     closed-world with verbatim defects (the loop is the bounded repair), and
     persist only through the owning service/CAS with deterministic keys.
     Tool ids may reuse the pack-node id when prompts already name it (the
     `openwop:feature.code-exec.nodes.run` precedent).
   - **Workflow ignition** → an action tool calling `startWorkflowRun` guarded
     by `host/ignitionGuard.ts` (`claimIgnition` — deterministic
     business-input key, 5-minute CAS window) so model loops cannot amplify
     cost or mint duplicate rows.
   - **Everything else** → prune the entry and align the prompt ("ignite it or
     stop claiming it"). A blanket projection of surface-backed nodes was
     REJECTED: `ctx.features` surfaces are tenant-trusted with per-subject
     RBAC deliberately deferred, so generic projection into a subject-scoped
     chat would mass-produce authority-parity holes (the D8/B1 class).
4. **Deliberate exclusions stay excluded:** connector/egress nodes
   (`core.files.*`, `core.openwop.mcp.*`, `core.email.*`, media-gen
   side-effect nodes) are never projected (ADR 0358's rule); crew packs that
   claimed them were pruned to truth.

## Consequences

- 234/234 inventory entries now resolve or are honestly removed; ~20 features
  gained real conversational tools (see the per-feature commits citing this
  program); the sweep's marquee-theater findings (A1, A10, C2, C3, C4, C6,
  D4, E1–E8, F2) are closed on the tool side.
- One restored regression: the Chief of Staff's ADR 0103 schedule-status
  grant, which a prune had dropped instead of migrating — now
  `openwop:priority-matrix.schedule-status`.
- Reviews of agent capability MUST henceforth verify resolution (run the
  tripwire), never read allowlist strings.

## Open questions

- OQ1: should `runAgentDispatch`'s deterministic seam (`toolSurface` echo)
  also warn on unresolvable entries at load time (boot-time lint vs
  test-time)? Deferred — the test gate suffices for CI-local discipline.
