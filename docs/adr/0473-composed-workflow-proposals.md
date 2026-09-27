# ADR 0473 — Composed-workflow proposals: propose → review → approve-to-run for agent-composed workflows

Status: implemented (Phases 1–5, 2026-07-23; see phase table + correction notes)
Date: 2026-07-23

| Phase | PR | Landed |
|---|---|---|
| 1 propose tool + `composed-workflow` kind + decide handler | #2440 | + the adversarial-review fold-in (F1–F8: live-hash approve rule, dispatch-time re-verify, catalog id probe, attributed decider, expiry sweep, throw-compensation, GC pending-guard, runInputs bounds) |
| 2 chat review card | #2442 | projection live view (async, pending-only) + role badges + staleness/error paths hardened (F1–F7) + embedded-surface strip parity + a11y/bundle fixes |
| 3 builder proposal banner | #2443 | save-then-approve (approve-what-you-see for unsaved canvases) + cross-surface signal refresh + identity guard |
| 4 grants + exchange audit | (this PR) | Workflow Architect pack 1.1.0 grants `openwop:workflows.propose` + persist-vs-propose prompt guidance; LLM-EXCHANGE row (A−); compose-and-run repositioned (ADR 0369 §6 correction landed with the ADR) |
| grade hardening (code A− / ux B+ / data A− → fixes) | (hardening PR) | C1 sweep hoisted OUT of the run-retention gate (dead on default posture — the one production defect all 3 review rounds missed) + daemon `tickNow` seam + tick test; C2 approved live hash persisted + audited (forensic approve-what-you-see); C3 policy-key component encoding; C5 `lastProposalSweep` probe on the admin debug read; U1 wrapping notices; U2 the honest degraded card (no live view ⇒ no silent unpinned Approve — builder path self-heals); U3 header localization (kind label, draft name, risk levels); D1 tenant teardown purges owned `wfreg:` defs (the PII-backstop claim is now true); D2 approval-index teardown purge + marker self-heal; D3 sweep reconciles crash-window unarchived drafts; D4 legal holds respected by the proposal sweep + transient GC; D5 awaited durable draft write on propose |
| 5 scoped auto-approval | (this PR) | operator-opt-in policy store (`host/workflowProposalPolicy.ts`, superadmin CRUD under `/workflow-proposals/admin/policies`) + the propose-time gate: fires ONLY for policy-named agents whose EVERY node role ∈ {pure, read} (undeclared blocks — fail-closed), resolves through `claimApproval` attributed `policy:*` (audit never thins); the tool result is honest (`auto_approved` + runId vs `pending_approval`). The card-fused "always allow" verb is deferred until a tenant-facing policy permission exists (the superadmin surface is the v1 authority). |

> **Correction (2026-07-23, Phase 1 implementation — adversarial review fold-in).**
> Five review findings corrected this ADR's original text; the reasoning trail:
> 1. **Approve-what-you-see rule (F1):** the original "mismatch against the
>    propose-time pin ⇒ 409" made ANY builder edit a permanent dead end (no
>    re-pin verb existed; even a node drag reorders the serialized array). The
>    shipped rule: the reviewed hash is `expectedDefinitionHash ?? pin` — a
>    client that displays the LIVE definition and sends its hash approves it;
>    the pin alone governs only hash-less (API) claims.
> 2. **Verify→dispatch window (F2/F3):** the handler's post-CAS verify and the
>    dispatch's own resolve were two reads — and dispatch resolves the CATALOG
>    (samples/templates/chain-backed shadow the registry). `startWorkflowRun`
>    now takes `expectedDefinitionHash` and refuses when the definition it
>    actually dispatches hashes differently; propose refuses ids the CATALOG
>    (not just the registry) resolves.
> 3. **Decide bar (F4):** matrix §8 originally claimed `isEligibleApprover` +
>    `resolveEffectiveAccess` gate every claim — that machinery is QUORUM-only
>    in the decision core. The shipped bar: tenant-scoped visibility (as every
>    kind) + a required attributed decider (403 without one). This is MEMBER
>    PARITY, not privilege escalation: any tenant member can already author +
>    run the same definition through the builder (`POST /workflows` +
>    `POST /v1/runs` carry the same tenant-member bar). An org-anchored
>    scope bar is Phase 5 policy work.
> 4. **Expiry semantics:** originally "410 gone" — `OpenwopErrorCode` is a
>    closed wire-adjacent union, so expiry is `409 conflict` +
>    `reason: proposal_expired`; expired reviews project as `expired` with no
>    actions; the retention tick sweeps them (rejected, note `expired`, draft
>    archived) so ignored proposals stop pinning the transient cap (F5).
> 5. **GC guard (F7):** the ADR 0371 P4 transient GC now skips drafts
>    referenced by a PENDING proposal — a user archiving the reviewed draft
>    must not let the next tick hard-delete it under the open card. A REJECTED
>    proposal's draft remains GC-eligible immediately (zero runs): the approval
>    row + `definitionHash` are the durable record of what was declined.
> Post-CAS refusals also compensate loudly now: reopen + `review.updated`
> signal + a `workflows.proposal.reopened` audit entry beside the chain's
> `approved` record; run-start EXCEPTIONS (not just null returns) reopen too
> (F6). Frozen `runInputs` are part of the reviewed payload: projected onto the
> review card, stripped from the raw approvals list (the `configurable`
> discipline), and bounded at 16KB (F8).
Lane: cross-cutting seam (agent workflow composition + human approval) — NO new
feature package, NO new toggle (the grant IS the switch; see matrix §2)
RFC verdict: **host work only, no new RFC.** A new *approval kind* is host-local
(`APPROVAL_KINDS` tuple + the APPR-5 redactor-completeness test,
`host/approvalService.ts:34-62`); the chat card rides the existing ADR 0068/0311
in-conversation review projection (`host/reviewProjection.ts`, non-normative
`/v1/host/openwop-app/reviews/*`); the propose tool is a `registerFeatureAgentTool`
core tool. A new *envelope kind* WOULD need an OpenWOP RFC (CLAUDE.md § three
lanes) — this design deliberately adds none. Nothing on the wire changes; the
runs/replay/fork contract is inherited unchanged via `startWorkflowRun`.

## Why this exists — the original intent, finally

The maintainer's original request (2026-07-15, restated 2026-07-23): *an LLM can
decide to build a workflow dynamically, and the user reviews the workflow in the
AI Chat or in the workflow builder UI **before approving** it.* ADR 0369 recorded
a narrower lifecycle framing ("spun up on the fly and disposed of when
completed") and shipped the (correct, still-load-bearing) transient-lifecycle
subsystem — but the review-before-execution requirement never made it into that
ADR. The delta that remains, verified against the tree on 2026-07-23:

1. `openwop:workflows.compose-and-run` (`host/workflowComposeTool.ts:51`)
   registers a transient draft and **immediately starts the run** (`:133`) — no
   pre-run human review exists on the composition itself.
2. The tool has **zero grants**: it is not in the ADR 0315 default-on baseline
   (`host/agentToolAllowlistService.ts:62-84`), no agent pack manifest lists it,
   and no ADR 0104 override grants it — the capability is dormant.
3. Its tool result renders as a generic collapsed JSON `<pre>` in chat
   (`chat/AgentEventCards.tsx:29-41`) — no review affordance, no builder link.
4. The one review path that DOES exist — builder Save/promote — is gated on a
   *completed run* (`routes/workflows.ts:421`, 409 `workflow_untested`), i.e.
   execution precedes approval: the inverse of the ask.

This ADR closes the gap with the smallest honest delta: **split "compose and
run" into "propose" (agent) and "approve-to-run" (human)**, carried entirely on
seams that already exist and are already tested in production.

## Competitive research (2026-07-23, adversarially verified — full report in the
## authoring session; load-bearing claims spot-checked against vendor docs)

Eleven products/systems surveyed: n8n AI Workflow Builder, Zapier Copilot,
Make Maia, Gumloop Gummie, Lindy, Relevance AI Invent, Dust Sidekick, OpenAI
AgentKit/Agent Builder (deprecated 2026-06-03 — the market's clearest signal
that a *separate* AI-composition surface loses to generating into the existing
editor), Claude Code plan mode, LangGraph/LangChain HITL, Temporal/Step
Functions. The market converged on a two-loop architecture — a **build-time
loop** (AI composes; human reviews an editable draft before it can run) and a
**runtime loop** (per-tool approval gates inside runs, which this host already
has: approval-gate interrupts, ADR 0028 governance, spend gates).

Table stakes (every leader ships them) → how this ADR lands each:

| # | Pattern | This design |
|---|---|---|
| 1 | Draft-by-construction on the NATIVE editing surface, activation a separate human act | proposals are ordinary ADR 0369 transient drafts, visible at `/builder/:id`; the run happens only on claim |
| 2 | Plan/intent preview; rejection loops, never terminates | the proposal card in the conversation; Reject feeds a structured reason back to the agent turn (OQ1) |
| 3 | Dual-lane editing (prompt AND manual canvas), with explicit edit-preservation semantics | builder edits win; the approval pins a definition hash — approve-what-you-see (see §Integrity) |
| 4 | Side-effect-keyed gates (reads free, writes ask) | risk badges derive from node classes; the run-level gates (capability refusal, ADR 0028, budgets) still apply unreduced |
| 5 | Payload-level approval card with approve / edit / respond / reject | the four card verbs (§Chat card) |
| 6 | Durable approvals inbox + in-context delivery | free: PendingApproval rows already project into the reviews inbox AND in-thread via `conversationId` (ADR 0311, `reviewProjection.ts:330,412`) |
| 7 | Audit trail (who/when/why) | free: the shared decision core audits every claim/reject (`host/approvalDecision.ts`) |

Differentiators adopted (the 2026 whitespace — prescribed everywhere, shipped
almost nowhere): **approval integrity** (pinned definition hash + staleness
refusal + TTL'd proposals — §Integrity) and **structural, not prompted,
enforcement** (the propose tool has no run-start dependency at all — it cannot
execute, in the same way Claude Code plan mode's read-only allowlist cannot
write). Scoped auto-approval (Gumloop App Rules / Dust stakes taxonomy /
Claude Code auto mode) is Phase 5, deliberately last and operator-opt-in.
Anti-patterns explicitly avoided: rejection-terminates (OpenAI approval node),
auto-binding credentials by heuristic (Zapier), a second AI-output surface
(OpenAI Agent Builder), silent live side effects labeled "test" (n8n/Zapier).

## Boundaries & pre-existing-surface audit (MANDATORY findings, `file:line`)

Every concept this ADR touches already has exactly ONE owner. This ADR adds no
second owner for anything:

| Concept | Single owner | This ADR's relationship |
|---|---|---|
| Propose-then-approve-then-run | `PendingApproval` + the `run-proposal` finalizer: pre-resolve wf → CAS `resolveApproval` → `startWorkflowRun` → audit (`host/approvalDecision.ts:447-497`) | **compose** — new kind `composed-workflow` with a registered handler (the `getXApprovalHandler` seam, `approvalService.ts`), NOT a second store or decide path |
| Decide routes + inbox + quorum | `routes/approvals.ts:118,139` (thin callers) → `host/approvalDecision.ts` (the ONE decision core, ADR 0068) + `reviewDecisionLedger` | claim/reject ride the SAME routes; zero new decide endpoints |
| In-conversation review card | ADR 0068/0311 review projection (`reviewProjection.ts:330` carries `conversationId` for in-thread placement) + `chat/reviews/ReviewCard.tsx` | new kind-specific renderer for `composed-workflow`; transport unchanged |
| Transient draft lifecycle | ADR 0369: `host/workflowLifecycle.ts`, registry filter `workflowsRegistry.ts:78`, promote gate `routes/workflows.ts:416-424`, GC ADR 0371 P4 | proposals ARE transient drafts (`generatedBy: agent:<id>`); promote-after-green-run is untouched |
| Definition validation | `host/workflowDefinitionValidation.ts` (shared with `POST /workflows`, the compose tool, workflow-author) + `capabilityGatedTypeIdRefusal` (`routes/runs.ts`) | reused verbatim at propose time |
| Catalog-grounded authoring | ADR 0072 `workflow-author` (Architect agent `feature.workflow-author.agents.workflow-architect`, tools `packs/feature.workflow-author.agents/pack.json:21-27`) | the Architect gains `openwop:workflows.propose`; its draft/validate loop is unchanged |
| Tool grants | pack manifest `toolAllowlist` ∪ ADR 0315 baseline, overridden by ADR 0104 (`host/agentToolAllowlistService.ts:90`) + super-admin UI | the pack lane grants the Architect; other agents via ADR 0104 — no new grant mechanism |
| Run start | `host/runStarter.ts:startWorkflowRun` (no paused-start mode — verified `:67,:98`) | called ONLY from the approval handler; the propose tool has no dependency on it (structural enforcement) |
| Agent-transient abuse cap | `OPENWOP_AGENT_TRANSIENT_WORKFLOWS_MAX` (`workflowComposeTool.ts:43`) | reused for propose |

Route collision: none — no new routes (decide rides `approvals/:id/{claim,reject}`;
reads ride `reviews`; the draft rides `/builder/:workflowId`). Concept duplication:
`grep -rn "proposal"` shows `run-proposal` (roster/kanban lineage, requires a
roster member at claim, `approvalDecision.ts:447-449`) and `kicktodo-plan-proposal`
— the roster requirement is exactly why `composed-workflow` is a NEW kind with a
registered handler (the sanctioned pattern used by `anon-surface-write`,
`strategy-checkin`, `commerce-listing-publish`, all with empty `rosterId`) rather
than an overload of `run-proposal`'s roster semantics.

## Decision

### 1. `openwop:workflows.propose` — the default composition lane (Phase 1)

A core agent tool (`registerFeatureAgentTool`, beside the existing compose tool
in `host/workflowComposeTool.ts` — one module owns both lanes). Pipeline:

1. schema-validate the candidate (`validateWorkflowDefinition`) — invalid ⇒
   typed tool error, nothing stored (one bounded error-fed repair stays in the
   Architect's chat loop, per the LLM-exchange law);
2. the SAME capability refusal as `POST /v1/runs` (`capabilityGatedTypeIdRefusal`);
3. no id takeover (resolvable id ⇒ refuse) + the transient cap;
4. register transient (`withLifecycle {transient:true, generatedBy:'agent:<id>'}`)
   + `recordOwnership` — the draft is now a first-class ADR 0369 citizen,
   catalog-hidden, resolvable, builder-editable at `/builder/<id>`;
5. compute `definitionHash` = SHA-256 over the canonical (sorted-key) JSON of
   the registered definition;
6. create the hold via a kind-scoped creator (`createComposedWorkflowApproval`,
   the `createAnonSurfaceWriteApproval` precedent, `approvalService.ts:1167`):
   `{ kind:'composed-workflow', workflowId, conversationId, configurable: inputs,
   composedWorkflow: { definitionHash, agentProfileId, nodeCount, riskSummary,
   validation }, expiresAt }` — flat payload for the APPR-5 redactor. Propose is
   deliberately NOT idempotent (each proposal is a distinct review object); the
   transient cap bounds retry abuse;
7. return `{ workflowId, approvalId, status:'pending_approval',
   builderUrl:'/builder/<id>', note }` — the model is told the truth: nothing
   ran, a human decides.

**Structurally cannot execute:** the tool takes no `StartRunDeps`; there is no
code path from propose to `startWorkflowRun`. `dryRun:true` keeps the
validate-only mode.

### 2. Approval kind `composed-workflow` + registered handler (Phase 1)

Added to `APPROVAL_KINDS` (the APPR-5 completeness test forces the redactor
entry — the payload stays 2-level flat). The registered handler (the
`anon-surface-write` deferred-execution shape, `host/anonymousActor.ts:505-575`
precedent):

- **On approve:** (a) resolve the definition; vanished/archived ⇒ 422 (the
  run-proposal pre-resolve discipline); (b) pre-check hash + expiry for a fast,
  side-effect-free refusal (stale ⇒ 409 `proposal_stale`, the card re-renders;
  expired ⇒ 410); (c) CAS `resolveApproval` (`changed` = the at-most-once lock);
  (d) **the definitive integrity check runs AFTER the CAS**: re-read the
  definition, re-hash, and compare against BOTH the pinned propose-time hash and
  the `expectedDefinitionHash` the card sent — a concurrent builder edit in the
  check→lock window must not run an unreviewed definition; mismatch ⇒
  `reopenApproval` + 409 (approve-what-you-see is server-enforced, not
  UI-advisory); (e) `startWorkflowRun` with the frozen `configurable` and
  `metadata.approval = { approvalId, agentProfileId, source:'composed-workflow' }`;
  (f) `attachRunId`. Start failure after CAS ⇒ `reopenApproval` (the ADR 0469
  compensation).
- **On reject:** archive the transient draft (`archivedAt` stamp — invisible,
  resolvable, GC-eligible once runs age out) and record the reviewer's note; the
  note is surfaced to the agent's conversation so rejection iterates rather than
  terminates (OQ1 wires the loop).
- **TTL:** `expiresAt` defaults to 7 days (`OPENWOP_WORKFLOW_PROPOSAL_TTL_DAYS`);
  expired proposals auto-archive their draft on the existing retention tick
  (compose with `__runTransientDefGcOnce`'s sweep, ADR 0371 P4 — no new daemon).

### 3. The chat review card (Phase 2)

A kind-specific renderer for `composed-workflow` in the reviews card path
(`chat/reviews/ReviewCard.tsx` + the card registry) — in-thread placement is
free via the approval's `conversationId`; the inbox row is free via the reviews
projection. Card contents (payload-level, never summary-only):

- name, node/edge count, the **step list** with per-node **risk badges** derived
  from node class: `read` / `write` / `egress` / `spend` / `capability-gated` /
  `interrupt` (source: the node-catalog's pack metadata + the
  `capabilityGatedTypeIdRefusal` list — same SSoT the gates use, never a
  hand-kept copy);
- **validation evidence**: the propose-time `{ok, errors:[]}` + schema pass +
  "capability gates: none tripped" (the dry-run-evidence pattern);
- staleness state: "edited in builder since proposed" when the live hash ≠
  pinned hash, with a re-review affordance that re-pins;
- four verbs: **Approve & run** (claim, carrying `expectedDefinitionHash`) ·
  **Open in builder** (`/builder/<id>` — the WorkflowRunBubble deep-link
  precedent) · **Respond** (focus the composer, quoting the proposal — the
  conversation IS the respond channel) · **Reject** (with optional note).
- After approve, the card swaps to the run state (the `WorkflowRunBubble` /
  `HitlDecisionCard` resolved-state precedent) with `/runs/:id` link; after a
  green run the existing promote affordance ("Save to catalog") takes over —
  ADR 0369 §5's user-only promotion and its green-run gate are UNCHANGED.

i18n ×4 (en/es/fr/pt-BR, `builder` + chat namespaces); `ui/` cohesion
(`surface-card`, `chip`, `StateCard`) per DESIGN.md; a11y reviewed via
`/ux-review`.

### 4. Builder awareness (Phase 3)

`/builder/:workflowId` already loads transient drafts. Add: when a pending
`composed-workflow` approval references the loaded draft, show a proposal
banner (proposer agent, conversation link, Approve & run / Reject — the same
decide routes) and surface the edited-since-proposed state. Editing remains the
user's right; the hash pin makes it safe, not forbidden (edit-preservation:
manual edits win by construction — the Dust semantic).

### 5. Grants + the compose-and-run disposition (Phase 4)

- `packs/feature.workflow-author.agents/pack.json`: add
  `openwop:workflows.propose` to the Workflow Architect's `toolAllowlist`
  (pack version bump + the `feature.ts` pin bump); prompt guidance in
  `prompts/workflow-architect.md`: prefer an existing workflow → a chain
  instantiation → propose; never claim the run started.
- Any other agent gets propose via ADR 0104 (super-admin UI) — no default-on
  baseline entry (CLAUDE.md: new tools are pack-allowlisted, never silently
  baseline).
- `openwop:workflows.compose-and-run` is **repositioned, not removed**: it
  remains the AUTONOMOUS lane for explicitly-granted headless agents (scheduled
  jobs where a human is not in the loop by design), still zero-granted by
  default, documented as such in its tool description + ADR 0369 correction
  note. Propose is the default lane; the two share the validation/cap/registration
  helpers (one module).
- `docs/steward/LLM-EXCHANGE-AUDIT.md` gains the propose tool's tracker row + tripwire
  (schema text = the workflow-definition SSoT via `openwop:schema.lookup`;
  invalid output = typed failure; read-before-write = the Architect's catalog
  tool; durable state only through closed-world validation + the human gate —
  this feature is the human gate).

### 6. Scoped auto-approval (Phase 5 — operator-opt-in, last)

Per-(tenant, agent) policy, super-admin set (the ADR 0104 override store
pattern): auto-approve a `composed-workflow` proposal ONLY when **every** node's
risk class is `read` (the closed-world class map — unknown class = not read =
no auto-approve, fail-closed) AND the policy names the agent. Auto-approved
proposals still create the approval row (`decidedBy: 'policy:<id>'`) — the
audit trail never thins. The approve card verb may offer "Approve & always
allow read-only composes from this agent" ONLY to users who hold the policy
permission (the Claude-Code fused-escalation pattern). Everything else keeps
asking. No time-based auto-approve; no model-decides mode (the Relevance
"Let Agent Decide" anti-guarantee is explicitly rejected).

## Feature evaluation matrix (honest answers for a core seam)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | **None** — extends the ADR 0369 core seam (`host/workflowComposeTool.ts`, `host/approvalService.ts`/`approvalDecision.ts`, `chat/reviews/`). Producers (Architect, future agents) are the features. |
| 2 | Toggle | **None.** Default-deny grants ARE the switch (a toggle would be a second, drift-prone gate over the same decision). Precedent: ADR 0369/0104. Phase 5's policy is super-admin-set, fail-closed. |
| 3 | `ctx.<feature>` | None — proposing is a chat/agent act, not a workflow node op (a workflow spawning approval-gated workflows = recursion/budget semantics out of scope, same as ADR 0369 §matrix 3). |
| 4 | Node pack | None. |
| 5 | Chat envelopes | **None — deliberately.** The card rides the reviews projection; a new envelope kind would demand an OpenWOP RFC for zero added capability. |
| 6 | Agent pack | `feature.workflow-author.agents` version bump (Architect gains propose). No new persona. |
| 7 | Public surface | None (authed tenant surfaces only; anon actors CANNOT reach propose — it is not in any anon grant tier, and ADR 0468's floor is untouched). |
| 8 | RBAC | Claim/reject bar = the existing approvals eligibility (`isEligibleApprover` + `resolveEffectiveAccess`, same as every kind); draft edit = owning tenant (ADR 0163); proposer attribution = `agentProfileId` + acting user on the audit row. Fail-closed throughout. |
| 9 | Replay / fork | Strictly inherited: the approved run is an ordinary `startWorkflowRun` run of a durable (transient) definition — archived-stays-resolvable (ADR 0369) protects replay; the approval stamp rides `run.metadata` (the ADR 0001 correction-note pattern). |
| 10 | Frontend | Chat card + builder banner + inbox row (free); tokens/i18n ×4; `/ux-review` at Phase 2/3. |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 1 | Backend: propose tool + `composed-workflow` kind + handler (CAS, hash pin, TTL, reject→archive, compensation) + APPR-5 redactor + tests (propose cannot start a run; stale hash 409s — including an edit landing in the check→CAS window, which must reopen, never run; expired 410s; concurrent claims: one winner; reject archives + preserves the note; cap enforced) | backend vitest |
| 2 | Chat review card (kind renderer, 4 verbs, risk badges, validation evidence, staleness, i18n ×4) | FE build + `/ux-review` |
| 3 | Builder proposal banner + edited-state surfacing | FE build + `/ux-review` |
| 4 | Architect pack grant + prompt + compose-and-run repositioning + `docs/steward/LLM-EXCHANGE-AUDIT.md` row + ADR 0369 correction note + FEATURES/ROADMAP sync | backend vitest + `/grade-ai-exchange` spot-check |
| 5 | Scoped auto-approval policy (read-only classes, operator-set, audited) | backend vitest + `/architect` |

## Alternatives weighed

1. **Overload `run-proposal`** — rejected: its finalizer requires a live roster
   member (`approvalDecision.ts:447-449`); pack chat agents aren't roster
   members, and bending that check weakens the kanban lineage's semantics. The
   registered-handler seam exists precisely for kinds with their own decide
   semantics.
2. **In-run approval interrupt as the gate** (start the run; first node raises
   `interrupt.approval`) — rejected: execution-before-approval by construction
   (the run exists, occupies quota, stamps history before the human decides),
   requires injecting a gate node into the user's DAG (mutating what the agent
   composed), and `startWorkflowRun` has no paused-start (`runStarter.ts:67,98`).
   The PendingApproval store IS the pre-execution primitive (its doc line:
   "proposed-but-unstarted actions").
3. **A new envelope kind** (`workflow.propose`) — rejected: wire RFC for zero
   capability gain; the reviews projection already delivers in-conversation
   placement + inbox + quorum + audit.
4. **Approve = promote to catalog** (fuse execution approval with saving) —
   rejected: conflates two decisions with different blast radii; keeps ADR 0369
   §5's user-decided, green-run-gated promotion as the second, separate gate
   (defense in depth for the catalog).
5. **Hard-delete on reject** — rejected: ADR 0369's replay law (archive, never
   dispose); rejected drafts GC naturally once runless (ADR 0371 P4).

## PRD-vs-architecture corrections

- "Review in the AI Chat **or** the builder" → review in the chat card **and/or**
  the builder — one approval object, two surfaces, one decide path (ADR 0068's
  projection makes "or" free).
- "Approve the workflow" → approve **this definition-hash of** the workflow —
  approval integrity is the 2026 whitespace and the only honest semantic once
  the draft is user-editable.
- Execution approval (this ADR) and catalog promotion (ADR 0369 §5) are kept as
  TWO gates, not merged — running once is lower blast radius than joining the
  catalog every future run resolves from.

## Open questions

1. **OQ1 — rejection feedback loop:** on reject-with-note, deliver the note into
   the proposing conversation as a system message that re-engages the Architect
   ("the user declined: <note> — revise?"). Proposed: yes, Phase 2, via the
   existing conversation exchange seam; confirm the exact injection point.
2. **OQ2 — quorum:** default single-approver at the existing eligibility bar;
   the `reviewDecisionLedger` quorum machinery is available if an operator
   wants N-of-M on composed workflows later. Deferred, no design debt.
3. **OQ3 — risk-class map ownership:** the node-class (read/write/egress/spend)
   map must live where the catalog lives (`host/nodeCatalogBuilder.ts` metadata,
   sourced from pack manifests), never a hand-kept FE list. Confirm pack
   manifests carry enough signal (e.g. `adapterOnly`, connector requirements) at
   Phase 2; where they don't, default the class to `write` (fail-closed badge).
4. **OQ4 — voice parity:** the ADR 0324 voice tool-scope parity test will force
   the propose tool through the same scope composer; confirm the card renders in
   the voice transcript surface or degrades to the inbox gracefully.
