# ADR 0136 — Intent Ledger (a reviewable pre-flight mission contract)

**Status:** implemented — all 5 phases (2026-06-24)
**Date:** 2026-06-24

## Implementation record

| Phase | What | Commit |
|---|---|---|
| 1 | Pure `ledgerToScope` (projects onto the ADR 0132 `ConversationCapabilityScope` — one enforcement path) + `run.metadata.intentLedger` stamp (scope CONFIG + relative-TTL expiry; replay-safe) | `492cba23` |
| 2 | Per-conversation store + LLM extractor (`parseLedgerDraft` pure/ceiling-intersected/malformed-safe; `isComplexRequest` over-friction guard; draft-only) | `d76e6b58` |
| 3 | REST (draft/approve/reject; owner-gated; no auto-approve) + loop integration: `intersectScopes` (ledger ∩ chipset, never-widen) + `out_of_mandate` expiry (anchored to stamped `resolvedAt`) ⇒ talk-not-act | `4dc1d84c` |
| 4 | Authored-vs-completed reckoning (`reckonLedger` pure; criteria `needs-review`, `blockedToolAttempts`; projection over runs+events) | `01fcf97e` |
| 5 | FE mission-contract panel (`IntentLedgerModal`, lazy, beside the ADR 0132 button) + i18n | `bbef2ca9` |

Built under `/goal` with `/architect` before each phase + `/code-review` (+`/ux-review` P5) after; each GO'd. The ledger REUSES the ADR 0132 enforcement (no second gate); the firewall (ADR 0135) is an orthogonal loop gate, so ledger∩chipset∩firewall compose naturally. An on-demand "Draft from conversation" action runs the LLM extractor under the live `isComplexRequest` over-friction guard (a trivial request 422s); drafting is user-initiated in v1. Deferred: LLM/human success-criteria judging; a fully-automatic draft-on-complex-turn trigger in the loop.

**Graduation (2026-06-24):** the toggle was **removed — always-on**; a no-op until a user drafts + approves a mission for a conversation (the chat-header “Mission” button + the on-demand “Draft from conversation” extract are always available). Id in `RETIRED_TOGGLE_IDS`. Historical toggle rationale retained.

**Toggle (historical):** `intent-ledger` · default **OFF** · `bucketUnit: tenant`. When OFF, chat is
unchanged. When ON, a ledger is drafted **only for requests classified complex/high-risk**
(the over-friction guard) — simple chats never see it.
**Surface:** host-extension — an `IntentLedger` (DurableCollection, per conversation/run)
+ REST under `/v1/host/openwop-app/intent-ledger/*` to review/edit/approve. Enforcement
**reuses the ADR 0132 capability-scope loop gate** (the ledger projects onto the
effective scope); the contract adds success-criteria + expiry + the authorized-vs-completed
summary. The resolved ledger is stamped in `run.metadata.intentLedger`.
**Depends on / composes:** ADR 0132 (per-conversation capability scope — the ledger's
`allowed`/`forbidden`/`requireApproval` **project onto** `enabled`/`disabled`/
`requireApproval`, so the *enforcement mechanism is reused, not rebuilt*), ADR 0036
(`permissions.never` — the hard floor a ledger can never widen past), ADR 0075 (HITL
approval — `requiredApprovals`), ADR 0135 (Capability Firewall — composes; both AND into
the loop), ADR 0130 (the cheap-classifier precedent for the complexity gate), ADR 0031
(the `run.metadata` resolve-stamp + replay-on-fork invariant).
**RFC verdict:** **host-extension — NO new RFC.** A host-internal authoring + review
surface whose enforcement rides the already-shipped ADR 0132 gate (RFC 0064/0078,
Accepted). It only narrows the agent's surface (never grants past the agent ceiling or
`permissions.never`). The resolved ledger is stamped in non-normative `run.metadata`.

> **Origin.** `openwop_ai_chat_innovation_strategy.md` §3/§4 "Intent Ledger" (P0). The
> insight: delegation today is *implicit* — users authorize a prompt, not a **bounded
> mission**, and tool-approval dialogs fire only *after* the agent has already planned a
> step. The fact-check found the *enforcement* primitives already ship (ADR 0132 scope +
> per-tool approval, ADR 0036 `never`, ADR 0075 HITL); the genuinely-new delta is the
> **upfront reviewable contract** — goal + success-criteria + expiry + an
> authorized-vs-completed reckoning.

---

## Context — boundaries audit first (MANDATORY)

The naïve build is "a new governance system that gates tool calls." That would stand up a
**second enforcement path** beside ADR 0132 — the worst outcome. The ledger is an
**authoring + review layer** whose runtime effect is the *same* effective capability scope
0132 already enforces.

| Concern | Existing owner (file:line) | How the ledger reuses it |
|---|---|---|
| Tool gating (allowed/forbidden/approval) | ADR 0132 `resolveCapabilityScope` + the `runChatToolLoop` gate (`agentDispatch.ts:835+`) | The ledger's `allowed`→`enabled`, `forbidden`→`disabled`, `requireApproval`→`requireApproval` project onto the **same `ConversationCapabilityScope`** the loop already honors. **Zero new enforcement code in the loop.** |
| Hard floor | ADR 0036 `permissions.never` | The ledger can never widen past `never` (resolver intersects with the agent ceiling — the 0132 never-widen invariant carries over). |
| Approvals | ADR 0075 HITL + the ADR 0132 Phase-3 approval-request seam | `requiredApprovals` are existing HITL approvals; no new approval store. |
| Complexity classification | ADR 0130 `classify` (a cheap-LLM call, result stamped) | The "draft a ledger only for complex/high-risk requests" gate reuses that classifier pattern; the result is stamped so `:fork` is deterministic. |
| Decision stamp | `run.metadata` (`computeCapabilityScopeStamp` precedent) | The resolved ledger (effective scope + success-criteria + expiry) is stamped at creation, read verbatim on `:fork`. |

**Net new (bounded):** an `IntentLedger` entity (goal / success-criteria / expiry /
status), an LLM **ledger extractor** (proposes a draft for complex requests), an
**expiry + success-criteria evaluator**, the projection `ledger → ConversationCapabilityScope`,
the `run.metadata.intentLedger` stamp, REST to review/edit/approve, and the FE contract
panel + the end-of-run authorized-vs-completed summary. **No second tool-gate, no second
approval store.**

---

## CRITICAL design point — the ledger IS the capability scope (no parallel gate) + replay

1. **Enforcement is delegated to ADR 0132.** The ledger does not re-decide per tool call;
   it *produces* the conversation's effective `ConversationCapabilityScope` (the
   resolver/loop from 0132 does the rest). This is the single most important boundary:
   the Intent Ledger is a **higher-level, reviewed source** of the same scope, plus the
   contract metadata (goal / success-criteria / expiry). One enforcement path, two
   authors (the user's quick scope chipset *or* a reviewed mission ledger).
2. **Replay/fork.** The resolved ledger (effective scope + `successCriteria` + `expiresAt`)
   is stamped in `run.metadata.intentLedger` at creation and read verbatim on `:fork`
   (ADR 0031); the classifier's complex/simple verdict is captured once. **Expiry is
   evaluated against the run's own recorded clock** (the run-start time + a relative TTL),
   never `Date.now()` at replay — so a replayed/forked run reaches the same in/out-of-
   mandate verdicts deterministically.

---

## Decision

Add an optional **Intent Ledger**: for a request classified complex/high-risk, an LLM
extractor proposes a **draft contract** — `goal`, `allowed`, `forbidden`,
`requiredApprovals`, `successCriteria`, `expiry`. The user reviews/edits/approves it; the
approved ledger **projects onto the conversation's capability scope** (ADR 0132 enforces
it) and is stamped on the run. At run end, a summary reconciles **authorized vs completed**
work against the success criteria. Simple requests skip the ledger entirely.

### Data model

```ts
IntentLedger                              // per conversation (+ stamped per run)
  { ledgerId, tenantId, conversationId,
    goal: string,
    allowed: string[], forbidden: string[],   // tool ids/prefixes → ADR 0132 enabled/disabled
    requireApproval: string[],                 // → ADR 0132 requireApproval
    successCriteria: string[],                 // checked at run end
    expiresAtRelMs?: number,                   // TTL from run start (clock-free for replay)
    status: 'draft' | 'approved' | 'expired' | 'rejected',
    proposedBy: 'extractor' | 'user', approvedBy?, createdAt }

// stamped at run creation; read verbatim on :fork
run.metadata.intentLedger = { effective: EffectiveScope, goal, successCriteria, expiresAtRelMs, resolvedAt }
```

`ledger → ConversationCapabilityScope`: `{ mode:'restricted', enabled: allowed, disabled:
forbidden, requireApproval }` — then 0132's resolver intersects with the agent ceiling
(never-widen) and the loop enforces it. **Expiry** adds one term to the loop's
already-live scope read: past `expiresAtRelMs`, all gated tools are denied
(`out_of_mandate`).

### Over-friction guard (the doc's headline risk)

A ledger is **only drafted** when the request classifies complex/high-risk (token count,
write/exec tools available, or the cheap classifier — the ADR 0130 pattern). Simple chats
never get a ledger; the feature adds zero friction there. This is configurable per tenant.

### RBAC & isolation

Reviewing/approving a ledger = the conversation owner (the ADR 0132 Phase-4 owner-gate) +
`workspace:write`; tenant/conversation IDOR-404; a ledger can never widen past the agent
ceiling or `permissions.never` (fail-closed).

---

## Evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package (0001) | `features/intent-ledger/` — entity + extractor + projection + REST + FE. Enforcement is **reused from ADR 0132**; this package does not touch `runChatToolLoop` except for the one `out_of_mandate` expiry term. |
| 2 | Toggle + admin UI | `intent-ledger`, OFF, `bucketUnit:'tenant'`; complexity-threshold config in the AI-config admin. |
| 3 | Workflow surface (0014) | None new v1. |
| 4 | Node pack | None. |
| 5 | AI-chat envelopes | None new — the ledger draft/approve is REST + a chat card; the run dispatches through the existing path with the stamped scope. |
| 6 | Agent pack | None (governance, not a named-agent capability). |
| 7 | Public surface | None. |
| 8 | RBAC + isolation (0006) | Owner + `workspace:write` to approve; never widens past ceiling/`never`; IDOR-404; fail-closed. |
| 9 | Replay / fork safety | `run.metadata.intentLedger` stamped at creation, read verbatim on `:fork`; expiry uses a **relative** TTL off the run clock (no `Date.now()` at replay); classifier verdict captured once. |
| 10 | Frontend | `IntentLedgerPanel` (review/edit/approve the draft), `LedgerViolationBanner` (out-of-mandate / forbidden), end-of-run `AuthorizedVsCompleted` summary; reuses the ADR 0132 chipset for the tool lists; `ui/` tokens, a11y. |

---

## Phased plan

1. **The projection + stamp.** Pure `ledgerToScope(ledger)` → `ConversationCapabilityScope`
   + the `run.metadata.intentLedger` stamp (reuse `computeCapabilityScopeStamp`'s guard).
   Unit-tested. No loop change beyond consuming the projected scope (0132 already does).
2. **Entity + extractor + complexity gate.** `IntentLedger` store, the LLM extractor
   (draft for complex requests only, classifier stamped), expiry as a relative TTL.
3. **REST + RBAC.** `/v1/host/openwop-app/intent-ledger/*` (draft/get/edit/approve/reject),
   owner-gated, IDOR-404. The `out_of_mandate` expiry term in the loop's scope read.
4. **Run-end reckoning.** Evaluate `successCriteria` at run completion → the
   authorized-vs-completed summary (recorded on the run).
5. **Frontend.** The contract panel + violation banner + summary; `/ux-review`.

## Alternatives weighed

1. **A second tool-gate enforcing the ledger directly.** Rejected — duplicates ADR 0132's
   loop gate (two enforcement paths drift). The ledger *projects onto* the 0132 scope.
2. **A ledger for every chat.** Rejected — the doc's own over-friction risk; gate drafting
   behind the complexity classifier (simple chats are untouched).
3. **Absolute `expiresAt` timestamp.** Rejected for replay — a wall-clock expiry diverges
   on `:fork`; use a relative TTL off the recorded run clock (ADR 0031).
4. **Fold into Capability Firewall (0135).** Rejected — the firewall is *tenant-global
   combination risk*; the ledger is *per-mission authored bounds + success/expiry*.
   Different authors and lifetime; they compose.

## Open questions

1. **OQ-1 — Extractor trust.** The drafted contract is model-authored → must be
   user-reviewed before it governs (draft-first, never auto-approve). Confirm the default
   is review-required.
2. **OQ-2 — Success-criteria evaluation.** LLM-judged at run end (nondeterministic) →
   record the judgement once on the run (don't re-judge on replay). Confirm.
3. **OQ-3 — Relationship to roster-agent autonomy (ADR 0075/0105).** A heartbeat run with
   an autonomy level vs an interactive ledger — v1 scopes the ledger to interactive chat;
   heartbeat governance stays ADR 0105.

## RFC verdict (Step 5)

**Host-extension — NO new RFC.** The ledger authors + reviews a contract whose
enforcement is the already-shipped ADR 0132 scope (RFC 0064/0078, Accepted); it only
narrows, stamps in non-normative `run.metadata`, and adds no wire field/event/capability.
