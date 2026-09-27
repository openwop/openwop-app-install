# ADR 0514 — Agent Author: describe-to-create for the digital workforce

Status: implemented (P1–P3; P4 re-scoped — see Implementation record)
Date: 2026-08-01
Deciders: round-3 UX programme (agents flagship, named in the agents round-2
matrix — PR #2797 — and reinforced by the advisory-board/brand round-2 catalogs)

## Context

The agents round-2 competitive matrix (Agentforce / Copilot Studio /
Relevance AI, all cited in `UX_UPGRADE-agents.md`) found exactly one dimension
where we trail all three leaders: **natural-language agent creation**. Copilot
Studio's describe-to-create (name/instructions/knowledge suggested, each
dismissible), Agentforce's "What do you want your agent to do?" wizard entry,
and Relevance's "Invent" all lead with NL; our `/agents/new` is a 5-step
manual wizard + templates + fork. The brand round-2 catalog independently named
Canva's extraction-first onboarding as the same lane, and the access-hub
round-2 deferred its admin-assistant to this pack.

The app already has the A+ reference for exactly this capability class: the
**Workflow Architect** (ADR 0058/0072/0073) — an agent pack + nodes pack whose
`catalog → get → draft → validate → persist` trio is the repo's exemplar
LLM-exchange rail, embedded in the builder via `CreateWithAiPanel` →
`EmbeddedChatPanel`.

## Decision

Ship **Agent Author** as the same two-pack + embedded-panel shape — no new
chat surface, no wire change (host work only; no RFC needed):

1. **`packs/feature.agent-author.nodes`** — the exchange trio over a new
   `ctx.features['agent-author']` surface:
   - `get` — the closed world the model must author against: current roster
     (read-before-write), role templates + role keys, autonomy levels, the
     tenant's workflow ids (for the agent's portfolio), and model classes.
   - `draft` — produce a schema-valid **roster-entry draft** (persona, label,
     roleKey, autonomyLevel, workflows[], instructions, confidence threshold).
     Declared output schema; invalid output is a typed failure with ONE bounded
     error-fed repair (the doctrine).
   - `validate` — closed-world checks: roleKey exists, every workflow id
     resolves in the tenant ownership index, autonomy level legal, persona
     name not colliding (dedupePersonasBeforeAdopt semantics, ADR 0379).
   - `persist` — create through the SAME service path the 5-step wizard uses
     (no parallel creation lane — the no-parallel-architecture law). Returns
     the rosterId; the UI deep-links the new agent's workspace for human
     review. Persist is allowlisted, shares the route's access predicate via
     `registerFeatureAgentTool`, and fails EMPTY without an acting user.
2. **`packs/feature.agent-author.agents`** — one agent,
   `feature.agent-author.agents.agent-author` ("Agent Author"), tool-allowlisted
   to exactly the trio + `openwop:schema.lookup`. Prompt mirrors the Workflow
   Architect's: never invent role keys or workflow ids; read before drafting;
   the human reviews the created agent in its workspace.
3. **Frontend** — `agents/AgentAuthorPanel.tsx` on `/agents/new`: a
   "Describe your agent" entry ABOVE the manual wizard (the Copilot Studio
   arrangement — NL first, manual path intact and one click away). Lazy-import
   `EmbeddedChatPanel` (chat/ imports agents/ for roster surfaces, so a static
   agents→chat edge would cycle — same rule as the builder). Empty state:
   three seeded example prompts + the dismissible-suggestions framing.
4. **Governance** — the pack is NOT in the ADR 0315 default-on baseline; the
   agent appears only when the pack is installed + the agent-author feature
   toggle is on (default off). Creation lands the agent with `enabled: false`
   pending the human's review-and-enable in the workspace — the
   draft-never-auto-activate consensus every catalog documented.

## Alternatives considered

- **Wizard-inline AI fields** (generate per-step suggestions inside the 5-step
  wizard): rejected — fragments the AI surface (the AiAuthorPanel lesson) and
  can't read the roster/catalog mid-flow the way the exchange rail can.
- **Extending the Workflow Architect** to also author agents: rejected — one
  agent per authoring domain keeps allowlists minimal (the capability-firewall
  posture) and prompts honest; the packs compose in chat if both are installed.
- **A new RFC**: not needed — no wire surface changes; agents/rosters are
  host-extension routes.

## Phases

| Phase | Deliverable | Verify |
|---|---|---|
| P1 | nodes pack (get/draft/validate/persist + schemas) + `agent-author` feature surface + agentTools registration | backend vitest (schema parity + persist-gating tests) |
| P2 | agents pack + prompt | prompt↔tool-id parity test (agent-prompt-tool-ids) |
| P3 | AgentAuthorPanel on /agents/new + i18n ×4 | frontend build gate + panel test |
| P4 | example-data walkthrough seed (ADR 0435 pattern) | seed smoke |

## Open questions

- OQ1: should `persist` also accept a draft-only mode (return the draft for the
  wizard to prefill, without creating)? Leaning yes as a P3+ follow-up — it
  gives the dismissible-suggestions UX without a roster write.
- OQ2: does the extraction-first brand-intake (BRAND-R2-2) share this pack or
  ship its own? Decide when brand round-3 opens.


## Implementation record (2026-08-01)

| Phase | PR | Notes |
|---|---|---|
| ADR | #2854 | Proposed |
| P1 backend + nodes pack | #2856 | 7 service tests; prompt-tool-id parity green |
| P2 agents pack + prompt | #2856 | shipped with P1 (requiredPacks couples them) |
| P3 AgentAuthorPanel | #2857 | toggle-gated entry; both polarities pinned |
| P4 walkthrough seed | re-scoped | walkthroughs are CHAIN-backed (they project from workflow definitions), so a guided tour here is a workflow-chain pack — a follow-up in the chains lane, not example-data. The feature is demoable directly: toggle `agent-author` on, open /agents/new. |

**OQ1 decided: yes, as a follow-up** — a draft-only persist mode (return the
draft for wizard prefill without a roster write) gives the dismissible-
suggestions UX; it extends the surface with one method and needs no new pack
version semantics beyond a minor bump.

**OQ1 IMPLEMENTED (2026-08-02):** `persist` gains `mode:"draft"` — the
validated draft lands in a per-(tenant,user) stash (`draftStash.ts`,
subject-keyed ⇒ its own ADR 0464 eraser, self-policing like
`tutorials/progressStore`), and the wizard offers it as a DISMISSIBLE prefill
(apply or dismiss both consume; never auto-applied). Two self-scoped
host-ext routes (`GET`/`DELETE …/agent-author/draft`) share the tool's
acting-user predicate by construction. Only an `ok:true` draft is ever
stashed (the doctrine). Packs 1.1.0 ×2 (+ the manifest's persist/validate
input schemas corrected to the WRAPPED `{draft}` shape the node code always
read — a pre-existing mismatch found in this pass). Tests:
`agent-author-draft-stash.test.ts` (5 — validation gate, self-scoping incl.
foreign-row invisibility, eraser) + `stashedDraftOffer.test.tsx` (3 — offer/
apply-consumes/dismiss-untouched + toggle-off polarity).
**OQ2 owner:** brand round-3 (the extraction-first intake decides whether it
shares this pack).
