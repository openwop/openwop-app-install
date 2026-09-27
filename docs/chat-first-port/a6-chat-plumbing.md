# A6 — Chat plumbing — chat-first port review

**Scope (single-feature / unit mode):** the seven backend packages
`backend/typescript/src/features/{chat-export, conversation-search,
chat-autotitle, multi-tab-chat, tool-output-compaction, context-economy,
conversation-tools}` and their frontend surfaces under
`frontend/react/src/{chat, conversationTools, client}`.

**Headline:** This unit is *plumbing over the ONE chat*, and it is honest
plumbing — eleven of twelve capabilities RIDE or thinly ADAPT the real owners
(the RFC 0005 conversation, the ADR 0043 visibility predicate, the ADR 0102
tool-permission gate, the ADR 0089/0193 `interrupt.approval` card, the core
`toolResultTransform` + `runStartContext` IoC seams, the Documents owner, the
`db.search` surface). There is **no parallel architecture** here and nothing
faking intelligence behind a form. The only defect is one orphaned helper
(`exportConversationAsDocument`) with no igniter — dead capability, not a lying
UI. There is essentially nothing to *port*; there is one thing to *ignite or
delete*.

---

## Verdict table

| # | Capability | Today | Verdict | Port / action target |
|---|---|---|---|---|
| 1 | Export transcript (md/json) | `GET …/chat-export/:sessionId` read-only render over the chat store | **PAGE-LEGIT** | Keep. Read-only projection; visibility loop closed. |
| 2 | Import transcript (openwop-v1 / ChatGPT) | `POST …/chat-export/import` → new owned conversation, untrusted-stamped | **ADAPTER** | Keep; rides the conversation owner (`ensureConversationMeta`) + `contentTrust:'untrusted'`. Watch for drift. |
| 3 | Export conversation **as a Document** | `exportConversationAsDocument()` composes the renderer + Documents owner | **THEATER** | **No route, no agent tool, no UI calls it.** Ignite (agent tool + ChatHeader item) or delete. |
| 4 | Conversation full-text search (route) | `GET|POST …/chat/search` over `db.search`, visibility-scoped | **RIDES** | Leave alone. |
| 5 | Conversation search **agent tool** | `openwop:conversations.search`, shares the route's `searchVisibleConversations` owner | **RIDES** | Leave alone (reference ADR 0308 seam). |
| 6 | Auto-title conversation | fire-and-forget managed-LLM side-effect on first exchange | **RIDES** | Leave alone. |
| 7 | Multi-tab chat deck | N instances of the RFC 0005 chat primitive (FE-only) | **RIDES** | Leave alone. |
| 8 | Tool-output compaction (auto boundary) | core `toolResultTransform` + `runStartContext` seams | **RIDES** | Leave alone. |
| 9 | Tool-output compaction (explicit node/surface) | `ctx.features['tool-output-compaction'].compact` + node pack | **RIDES** | Leave alone. |
| 10 | Context-economy levers + admin projection | env-governed; read-only `…/feature-toggles/admin/env-governed` | **PAGE-LEGIT** | Keep — this IS the honest fix for a retired lying toggle. |
| 11 | Per-conversation capability scope (narrowing) | ANDed into ADR 0102 gate, stamped in `run.metadata`, never-widen | **RIDES** | Leave alone. |
| 12 | Per-tool approval (gate + ledger + interrupt card) | shared `interrupt.approval` card + feature ledger/resolve route | **ADAPTER** | Keep; honest adaptation to the in-process-loop constraint. Watch the parallel-resolve seam (below). |

**Tally: RIDES 7 · ADAPTER 2 · PARALLEL 0 · THEATER 1 · PAGE-LEGIT 2**

---

## Contract scouting (pinned evidence)

**Igniters / call sites all real (no orphaned orchestration except #3):**

- Auto-title is genuinely fired from the exchange seam, not declared-only:
  `host/exchange/persistExchange.ts:74` calls `maybeAutotitleOnFirstExchange`
  (the `chat-autotitle/binding.ts:48` fire-and-forget wrapper). Toggle-gated
  server-authoritative (`binding.ts:62`), never clobbers a manual rename
  (`titleSource` idempotency key, `binding.ts:68` + TOCTOU re-check `:77`).
- Tool-output compaction is wired into **two** real boundaries, not just
  declared: `host/agentDispatch.ts:1125` (`applyToolResultTransform` on every
  tool result) and `bootstrap/nodes.ts:1960` (sub-run results). The per-run
  decision is frozen at run creation via `stampRunStartContext`
  (`host/runInsert.ts:22`) reading `resolveCompactionDecision`
  (`decision.ts:59`) → replay-safe.
- Capability scope is enforced live in the loop, not just stamped:
  `host/conversationToolLoop.ts:430` (`isNarrowing`) → `:431`
  (`applyApprovalDecisions(resolveCapabilityScope(...))`) → `:433`
  (`computeCapabilityScopeStamp`), and it **intersects with the ADR 0136 intent
  ledger** at `:426` (`intersectScopes`) — one composed narrowing, not two
  competing filters.
- Deferred tool calls are recorded to the durable ledger at
  `conversationToolLoop.ts:538` (`recordToolApprovalRequested`), and the shared
  `interrupt.approval` card that displays them exists in the FE registry
  (`chat/registry/defaultCards.tsx:442`).
- Search's route and agent tool share ONE owner
  (`conversation-search/searchEngine.ts:194` `searchVisibleConversations`) — the
  ADR 0043 visibility filter cannot drift between them
  (`agentTools.ts:44` and `routes.ts:53` both call it); the tool **fails empty**
  without an acting user (`agentTools.ts:39`).

**Owners instantiated, not shadowed:**

- Import rides the conversation owner: `importService.ts:38`
  `ensureConversationMeta` (not a bespoke meta write) and stamps every turn
  `contentTrust:'untrusted'` (`importService.ts:50`).
- Export-as-Document rides the Documents owner: `asDocumentService.ts:28`
  `createDocument` + `:36` `addVersion` — correct composition, but **nothing
  ignites it** (see Blocker 1).
- Search rides the host `db.search` surface (`searchEngine.ts:138`) —
  explicitly NOT a feature-local `tsvector` table (the ADR-correction note at
  `searchEngine.ts:15` records the no-parallel-substrate decision).
- Compaction registers INTO core seams; core never imports it
  (`tool-output-compaction/feature.ts:30-33`).

**Chassis constraint that shaped #12 (honest, not a smell):** the in-process
tool loop cannot suspend mid-iteration, so a `requireApproval` tool is *not*
executed — it is recorded `pending` and folded on the agent's re-attempt
(`approvalLedger.ts` header + `scopeResolver.ts:119` `applyApprovalDecisions`).
This is why #12 has its own capture/resolve path instead of the normal
gate suspend/resume.

---

## Blockers (from scouting) — each with the honest alternative

**Blocker 1 — `exportConversationAsDocument` is an orphan (THEATER).**
`chat-export/asDocumentService.ts:17` is a fully-built ADR 0119 Phase-3
capability ("export this conversation as a Document") that composes the right
owners — but it has **zero callers**: no route in `chat-export/routes.ts`
(which exposes only GET transcript + POST import), no agent tool, and no
frontend reference (the FE `chatExportClient.ts` only hits
`/chat-export/:sessionId` and `/chat-export/import`). It reads as capability and
delivers none.
*Honest alternative:* either (a) **ignite it** — add an
`openwop:conversation.exportAsDocument` agent tool (so "save this chat to my
docs" works in-chat) sharing the export route's visibility predicate, plus a
ChatHeader "Save to Library" item; or (b) **delete it** and drop the ADR 0119
Phase-3 claim to `deferred`. Do not leave it built-but-dark.

**Blocker 2 (watch, not stop) — #12's resolve path is feature-namespaced, not
the shared reviews inbox.** The `interrupt.approval` *card* is the shared
primitive, but resolution goes through `POST
…/conversation-tools/…/approvals/:toolName` (`routes.ts:124`) + the
`CapabilityScopePanel` (`conversationTools/CapabilityScopePanel.tsx`), a
separate lane from the standard interrupt `resume`. This is a *defensible*
adaptation to the no-mid-loop-suspend constraint, so it is ADAPTER not PARALLEL
— but it is the surface most likely to drift into a second approval system.
*Guard:* keep the decision durable + attributed (it is:
`approvalLedger.ts:57`), and if a future change lets these approvals reach the
reviews inbox, route them there rather than widening the feature lane.

---

## Demolition list (with regression pins)

Nothing to demolish — no bespoke "talk to AI" surface, no form hiding a model
call, no duplicated owner. The single cleanup:

- **Remove or ignite `asDocumentService.ts`.** If deleted, pin a test asserting
  no `createDocument({ kind: 'conversation-transcript' })` call path exists
  outside an ignited tool/route (a resurrected orphan fails). If ignited, pin a
  route/tool test that a non-participant gets a uniform 404 (mirror
  `chatExportClient.test.ts`).

---

## New-code inventory (small — only if Blocker 1 is ignited, else zero)

- 1 agent tool `openwop:conversation.exportAsDocument` sharing the export
  route's `isVisibleToAsync` predicate (fails typed without an acting user).
- 1 ChatHeader menu item wired to a thin `exportAsDocument` client call.
- 1 route (or reuse the export route with `?as=document`) calling the existing
  `exportConversationAsDocument`.
- No new store, node, workflow, or owner — the helper already composes them.

---

## Phased plan

**Phase 0 (decision, no code):** owner picks ignite-vs-delete for Blocker 1.
Gate: ADR 0119 Phase-3 status line updated to match reality.

**Phase 1a (if delete):** remove `asDocumentService.ts`, add the
no-orphan regression pin. Gate: `npm run ci`.

**Phase 1b (if ignite):** ship the agent tool + route + ChatHeader item +
visibility test; close with `/code-review` + `/ux-review` and apply fixes.
Gate: `npm run ci`, then the visibility/404 regression test green.

No other phases — the remaining eleven capabilities need no work.

---

## Deferred honestly

- **Persisted FTS backend** for search is a *host-surface* follow-up
  (`searchEngine.ts:15` correction note), benefiting `db.vector` too — correctly
  NOT scoped as a feature-local table. Left deferred-visibly; the v1 in-memory
  `db.search` rebuild is drift-proof by construction.
- **Compaction Phase-2 per-agent lossy opt-in** is implemented
  (`decision.ts:73-91`, `agentProfile.configParameters.compaction`) but is an
  operator/agent-config lever with no dedicated chat surface — correct, it is
  infra, not a described-intent capability.
- **#12 approvals via the reviews inbox** is deferred by the in-process-loop
  constraint (Blocker 2), stated, not faked.
