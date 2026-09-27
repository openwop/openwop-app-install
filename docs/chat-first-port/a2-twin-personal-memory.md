# Digital twin & personal memory (unit A2) — chat-first port review

**Scope (single-feature mode):** the twin/personal-memory unit —
`backend/typescript/src/features/{twin,profile-memory,memory-auto-extract}` +
`frontend/react/src/features/{twin,profile-memory}`, riding the host-owned
`twinService`, `subjectMemory`, `kbService`, and the agent-dispatch seams.
ADRs 0041 (subject memory), 0042 (human knowledge binding), 0044
(twin cross-subject recall), 0120 (chat memory auto-extraction).

**Headline verdict: this unit is authorization + substrate that feeds the ONE
chat — it declares no workflows, no nodes, no agent tools, and shadows no
owner, so it *mostly already rides the engine*. The exception is the flagship
capability: a granted twin's borrowed recall is composed on ONLY the ad-hoc
Agent-Playground dispatch call site, NOT the conversation/agent-runner path the
ONE chat actually uses — so a twin never recalls its owner's memory when a user
actually chats with it. That is the one THEATER finding, and it contradicts the
ADR's "chat, runs, and forks alike" claim.**

---

## Step 1 — Contract scouting (evidence)

**What this unit declares vs ignites.**
- **No workflow/node/agent packs.** Grep for pack files mentioning
  twin/memory/profile in `packs/` → none. No `WorkflowDefinition`, no
  `startWorkflowRun` caller, no `registerFeatureAgentTool` anywhere in the three
  backend features. This unit is pure host-extension routes + host seams; there
  is nothing orphaned-workflow-shaped to ignite.
- **Personal-memory notes ride the shared owner.** Routes write through
  `addSubjectNote`/`listSubjectNotes`/`removeSubjectNote` on the RFC-0004
  subject-memory store under `user:<id>` — the SAME primitive agents use under
  `agent:<id>` (`profile-memory/routes.ts:27,33,47,57`). Frontend uses the
  shared `MemoryBrowser` (`ProfileMemoryTab.tsx:10,27`). No parallel store.
- **Personal knowledge rides the shared owners.** `kbService` collections +
  `Profile.knowledge.collectionIds` binding + the shared
  `resolveSubjectKnowledgeRetrieve` composition (`profileKnowledgeService.ts:21-31`),
  surfaced through the shared `SubjectKnowledgePanel`
  (`ProfileKnowledgeTab.tsx:10,28`). Self-heals dangling bindings on read
  (`profileKnowledgeService.ts:90-95`). No parallel store.
- **Twin link + grant have a single host owner.** `host/twinService.ts` is the
  sole owner of the `twin-grant` `DurableCollection` + the `agentProfile.twin`
  link; routes are thin wrappers (`twin/routes.ts:30-34`). Re-link auto-revokes
  the prior grant (`twinService.ts:83-86`); unlink revokes
  (`twinService.ts:99`); roster delete cascades (`clearTwinGrantsForAgent`,
  `twinService.ts:161`). DSAR eraser registered (`twinService.ts:176-188`).
- **Borrowed recall is a genuine host seam, filled by the feature.**
  `twin/feature.ts:26` calls `setBorrowedRecallResolver(resolveBorrowedRecall)`;
  `borrowedRecall.ts:33-78` is the live gate (toggle → link → active grant →
  compose owner corpus) and audits actual use. Core reads it via
  `getBorrowedRecallResolver()` (`twinRecallSurface.ts`) and the dispatch
  primitive consumes `deps.borrowedRetrieve` and funnels every chunk into the
  UNTRUSTED block (`agentDispatch.ts:404,596-599`). The fence is structural.
- **Auto-extraction IS wired and ignited (ADR 0120 Phases 2b–2d), despite a
  stale "Phase 1 only" comment.** `feature.ts:6-7` still says "Phase 1 ships
  ONLY the grant gate — no extraction yet," but `persistExchange.ts:94-105`
  (`maybeExtractMemoryOnClose`) is called at conversation close
  (`conversationExchange.ts:199`) → `extractConversationMemory`
  (`extractionBinding.ts:22`) → `runMemoryExtraction` (fail-closed on consent,
  `extractionOp.ts:31`) → `llmExtractFacts` managed dispatch
  (`memoryExtractor.ts:46`), landing `[auto-extracted]`-tagged notes on the
  user's own subject. Real igniter, real execution.

### BLOCKER B1 (the load-bearing one) — borrowed recall is wired to the wrong call site

`getBorrowedRecallResolver()` has **exactly one caller**
(`routes/agents.ts:291`) and `borrowedRetrieve` is supplied to a dispatch at
**exactly one call site** (`routes/agents.ts:323`). That call site is the
**ad-hoc, non-persisted `POST /agents/:id/dispatch {live:true}`** route — the
Agent-Playground "run this agent once" preview (its own comment at
`routes/agents.ts:283-285` calls it "this ad-hoc/runless dispatch [with] no
acting participant").

The two agent-execution call sites the ONE chat actually drives an agent
through **do not compose it**:
- **`agentRunnerNode.ts:123`** — the node that runs a standing/user agent turn
  INSIDE a conversation/workflow run (i.e. the ONE chat's real agent turn).
  Builds dispatch deps at `:135-149` with `knowledgeRetrieve` composed
  upstream but **no `borrowedRetrieve`**.
- **`chatContext.ts` / `conversationToolLoop.ts` / `bootstrap/nodes.ts`** —
  zero references to `borrowed`/`twin` (grep clean).

ADR 0044 §4 (line 102) rationalizes replay safety by asserting "the recall
happens in `runAgentDispatchLive` … so a revocation takes effect immediately
everywhere — **chat, runs, and forks alike**." That inference is wrong: the
composition is at the *call site*, not inside `runAgentDispatchLive`; only the
preview route wires the dep. **Net effect: a granted twin agent that a user
actually converses with never recalls the owner corpus.** The consent grant,
the "Allow recall" toggle, the "Who can recall my memory" dashboard, the audit,
and the structural fence are all real — but they authorize a capability that
does not fire on the surface the UI implies (the chat). ADR status is
"implemented (Phases 1–3)," so it is painted green.

**Honest alternative:** additive one-line composition at the agent-runner node
call site (and, if voice/tool-loop turns should also recall, the conversation
turn path) — mirror `routes/agents.ts:291-292,323`:
`const br = getBorrowedRecallResolver(); const borrowedRetrieve = br ? await br(ctx.tenantId, agentId) : undefined;`
then spread `...(borrowedRetrieve ? { borrowedRetrieve } : {})` into the
`runAgentDispatchLive` deps at `agentRunnerNode.ts:135`. `runAgentDispatchLive`
already consumes it; the fence is already structural; the gate is already live.
Additive chassis hook — every other dispatch consumer stays byte-for-byte
unchanged.

### BLOCKER B2 — the `memextract:grant` consent store has no DSAR erasure

`memory-auto-extract/grantService.ts:22` creates a `DurableCollection`
`memextract:grant` keyed `${tenantId}:${subject}` (subject = `user:<id>`). Grep
for the key across the tree finds **no `registerSubjectEraser`** and no
retention purger — unlike the twin grant (`twinService.ts:187`) and the
subject-memory notes (`subjectMemory.ts:297`), both of which register erasers.
So on a user DSAR the extracted *notes* are erased but the standing
extraction-consent record for that user persists tenant-wide.

**Honest alternative:** register an idempotent subject eraser for
`memextract:grant` (delete rows whose subject matches `subjectKeyForms`),
wired into the host-erasers boot list — the exact shape `twinService.ts:176-188`
already ships. Small lifecycle-close, not a redesign.

### Honesty-loop note H1 — auto-extraction provenance is a text prefix, not a field

Extracted facts land as `[auto-extracted] <fact>` string-prefixed notes
(`extractionBinding.ts:32`), and the client comment states plainly "there is no
separate review surface" (`memoryExtractionClient.ts:8`). They render as plain,
editable notes in the Personal Memory list, distinguishable only by literal
text the user can delete or accidentally strip. The consent hint promises the
user can "review and delete anytime" (`ProfileMemoryTab.tsx:70`) — the delete
is real, but the "review" affordance is just an inline prefix. Model output
reaching durable personal memory is gated only by the one-time consent + the
closed-world `parseFactLines` caps (`memoryExtractor.ts:27-41`), never a
per-fact human gate. Defensible for *the subject's own* data, but the provenance
should be a structured note attribute the browser can badge/filter, not a
prefix — otherwise the honesty loop is a convention, not a read.

---

## Step 2/3 — Capability inventory + verdicts (ten port tests applied)

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Curate personal memory notes (add/list/delete) | shared `MemoryBrowser` → `subjectMemory` `user:<id>` (`profile-memory/routes.ts`) | **RIDES** | leave; expose an in-chat `add-memory`/`list-memory` agent tool as an *additive* lane (see New-code) |
| 2 | Curate personal knowledge (bind/create collections, ingest/delete docs) | shared `SubjectKnowledgePanel` → `kbService` + `Profile.knowledge` (`ProfileKnowledgeTab.tsx`) | **RIDES** | leave; watch for `kbService` drift |
| 3 | Search my own corpus (retrieve) | `POST /knowledge/retrieve` self-read (`knowledgeRoutes.ts:65`) | **PAGE-LEGIT** | keep; read-only self-query, honesty loop closed |
| 4 | Admin links agent↔person (twin LINK) | thin route over host `twinService` (`twin/routes.ts:83-102`) | **RIDES** | leave; single owner, IDOR-guarded, cascade-clean |
| 5 | User grants/revokes twin-recall consent | thin route over host `twinService` (`twin/routes.ts:113-132`) | **RIDES** | leave; standing consent grant (not a per-turn approval), correct as a page |
| 6 | "Who can recall my memory" dashboard | `ProfileTwinGrantsTab.tsx` list + revoke | **PAGE-LEGIT** | keep; consent dashboard, honest read |
| 7 | Twin agent recalls owner corpus **during chat** | composed ONLY at ad-hoc dispatch (`routes/agents.ts:291,323`); absent from `agentRunnerNode.ts:123` + conversation path | **THEATER** | **B1** — compose the host seam at the agent-runner call site so it fires in the ONE chat |
| 8 | Opt in/out of chat auto-extraction (consent) | self-service toggle (`memory-auto-extract/routes.ts`; `ProfileMemoryTab.tsx:43`) | **PAGE-LEGIT** | keep; add DSAR eraser (**B2**) |
| 9 | Auto-extract durable facts from chats → memory | ignited at conversation close, fail-closed, managed dispatch (`persistExchange.ts:94-105`) | **RIDES** | leave; fix provenance to a structured attribute (**H1**) |

**Counts: RIDES 5 · ADAPTER 0 · PARALLEL 0 · THEATER 1 · PAGE-LEGIT 3.**

Test highlights:
- **Interface test:** memory/knowledge curation is *structural editing of a
  personal collection* (page/panel-shaped, correct) — NOT "describe intent." The
  ONE thing that IS describe-intent-shaped ("remember I prefer X"; "recall my
  notes") has **no agent-tool lane** — the only chat→memory write is the
  post-turn auto-extractor. That is the additive port opportunity, not a
  demolition (see New-code).
- **Agency test:** no named agent, no `registerFeatureAgentTool` in the unit —
  so no toothless persona to flag. The unit is substrate, not a persona.
- **Ignition test:** auto-extraction has a real igniter (conversation close);
  borrowed recall's igniter is mis-targeted (B1).
- **HITL test:** twin grant + extraction consent are *standing capability
  grants*, correctly page-shaped consent dashboards — NOT duplications of the
  per-decision approvals/reviews machinery. No bespoke approve/submit button.
- **Authority-parity test:** self-ownership predicate (`resolveCallerUser`) gates
  every profile route; `resolveEffectiveAccess` gates admin link + org-scoped KB
  writes; the twin grant uses `grantedByUserId` identity. The borrowed-recall
  resolver re-checks toggle+link+grant live per dispatch. Parity holds on the
  wired paths; B1 is a *coverage* gap (a path the capability forgot), not an
  authz hole.
- **Lifecycle test:** twin grants + subject-memory notes have erasers; the
  `memextract:grant` store does not (B2).
- **Card-mechanism test:** the unit renders no chat cards (no A2UI surface, no
  typed renderer, no interrupt card) — its outputs are fenced *context* injected
  into a turn, not interactive cards. Nothing to mis-pick. Correct.

---

## Blockers — with honest alternatives

- **B1 (THEATER, top severity):** borrowed recall composed only on the ad-hoc
  preview dispatch (`routes/agents.ts:291,323`); the conversation/agent-runner
  path (`agentRunnerNode.ts:123`) omits it → a granted twin never recalls in the
  real chat, contradicting ADR 0044 §4 line 102. **Alt:** additive host-seam
  read at the agent-runner call site (and voice/tool-loop turn path if in
  scope), passing `borrowedRetrieve` into the existing dispatch dep. ~1 read + 1
  spread per call site; primitive + fence already exist.
- **B2 (lifecycle):** `memextract:grant` has no DSAR eraser. **Alt:** register
  an idempotent subject eraser mirroring `twinService.ts:176-188`, wire into the
  host-erasers boot list.
- **H1 (honesty loop):** auto-extraction provenance is a `[auto-extracted]` text
  prefix with "no separate review surface." **Alt:** carry provenance as a
  structured note attribute the shared `MemoryBrowser` badges/filters, so
  "review" is a real read, not a convention.

---

## Demolition list

**Empty — this is the honest good-news outcome.** There is no bespoke "talk to
AI" surface, no orphaned workflow, no toothless agent, no parallel owner to
demolish. Every UI surface in the unit is a legitimate curation/consent page
(capabilities 1–6, 8) over a shared owner. Nothing to tear down.

**Regression pins to ADD (so the fixed state can't silently regress):**
- After B1: a test asserting a conversation/workflow agent turn for a *granted
  twin* composes owner chunks into the untrusted block (extend
  `twin-recall-fence.test.ts` to the agent-runner path, not just the ad-hoc
  route), and that a revoked grant yields none.
- After B2: a DSAR test asserting `memextract:grant` rows for an erased subject
  are gone (extend the subject-erasure completeness tripwire).
- A drift pin that fails if a new `runAgentDispatchLive` call site is added
  without a borrowed-recall composition decision (documented seam contract).

---

## New-code inventory (small, additive)

1. **B1 fix** — host-seam read + dep spread at `agentRunnerNode.ts:135`
   (and optionally the conversation turn path). No new file.
2. **B2 fix** — `eraseSubjectMemoryExtractionGrant` + `registerMemoryExtractErasure()`
   in `memory-auto-extract/grantService.ts`, one line in the host-erasers boot
   list. ~15 lines, mirrors twin.
3. **H1 fix** — provenance as a structured attribute on the note write +
   `MemoryBrowser` badge (chassis-additive; other consumers unchanged).
4. **Additive chat-drivability lane (the real chat-first upgrade, optional):**
   a `registerFeatureAgentTool` pack exposing `add-memory` (action, self-subject,
   shares the `resolveCallerUser` predicate → typed failure without a user) +
   `recall-my-corpus` (read, fails EMPTY) so a user can curate their twin *by
   talking to it* ("remember I prefer dark mode"), per the ADR 0058
   chat-drivability pattern. The profile tabs stay page-legit for bulk
   review/management. This is the one place the unit could genuinely move from
   "substrate" to "expressed through the chat," and it is purely additive.

No new stores, no new workflow, no new node beyond the optional agent-tool pack.

---

## Phased plan (gated on real gates; compliance seam first; never demolish
before the replacement works — nothing to demolish here)

- **Phase 0 — honesty corrections (docs, no behavior):** correct the stale
  `memory-auto-extract/feature.ts:6-7` "Phase 1 only" comment; add a correction
  note to ADR 0044 §4 that borrowed recall is composed at the call site and (pre-B1)
  fires only on the ad-hoc dispatch. Gate: `/architect` sign-off.
- **Phase 1 — B2 (lifecycle seam first):** register the `memextract:grant`
  eraser + regression pin. Gate: backend vitest + subject-erasure tripwire.
- **Phase 2 — B1 (ignite the flagship capability on the real chat path):**
  compose borrowed recall at `agentRunnerNode.ts` (+ conversation turn path if
  in scope); extend `twin-recall-fence.test.ts` to that path; add the drift pin.
  Gate: `npm run ci` + `/code-review` + `/ux-review` (verify a granted twin
  recalls in a live conversation, a revoked one does not).
- **Phase 3 — H1 + optional chat-drivability pack:** structured provenance
  attribute + `MemoryBrowser` badge; then (optional) the `add-memory`/
  `recall-my-corpus` agent-tool pack, allowlisted per ADR 0315 (not silently
  default-on). Gate: `npm run ci` + `/code-review` + `/ux-review` +
  `/grade-ai-exchange` (new model-facing tool lands with its
  `docs/steward/LLM-EXCHANGE-AUDIT.md` row + tripwire).

Each phase closes with `/code-review` + `/ux-review` and fixes applied.

---

## Deferred honestly

- **Voice/tool-loop turn borrowed recall:** B1's fix targets the agent-runner
  node (conversation/workflow agent turns). Whether realtime-voice turns and the
  chat tool-loop should also compose owner recall is a scope decision — deferred
  visibly, not silently wired.
- **Per-fact human gate for auto-extraction:** the ADR 0120 design chose
  opt-in + post-hoc delete over a gate-before-write; if a stricter gate is ever
  wanted it would ride the reviews inbox, not a new surface. Not blocking;
  recorded as a design choice, not an omission.
- **Chat-drivability pack (New-code #4):** genuinely additive and the highest-
  value chat-first move, but it is a *new capability*, not a port of an existing
  one — deferred to Phase 3 and gated on the AI-exchange audit.
