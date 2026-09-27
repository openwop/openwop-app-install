# ADR 0596 — The AI Workflow Author's honesty contract: typed failure, enforced rules, and a hand-off that exists

Status: implemented

Feature 25/71, PR-B. The sibling PR-A is
[ADR 0595](0595-workflow-author-write-integrity-and-authority.md), which closed
the DURABLE-WRITE half (dropped fields, unowned defs, fire-and-forget persist,
the second write lane). This ADR closes the HONESTY half: what the feature tells
the model, what it tells the user, and whether either statement is true.

`CLAUDE.md` cites this feature as an **A+ reference implementation** for the
AI-exchange lanes. All three graders falsified that claim, and the headline
falsification is on the very non-negotiable it is cited for:
*"invalid model output is a typed failure, never success-with-empty."*

## The decisions

| # | Row(s) | Decision |
|---|---|---|
| 1 | `WFAC-2` = `WFAWF-10` = `WFAU-4` | `draft` returns a TYPED FAILURE when the bounded repair loop is exhausted, and never fabricates a `workflowId`. |
| 2 | `WFAU-1` | The "opens on the canvas" hand-off is WIRED — as a link driven by an authoritative host read — and the promise is reworded everywhere it is made. |
| 3 | `WFAWF-9` | Acyclicity is enforced at BOTH authoring doors, using the EXECUTOR's own rule. Connectivity is NOT enforced, and is no longer claimed. |
| 4 | `WFAC-3` | The catalog tool is compaction-exempt, and a per-feature `promptCatalogParity` suite pins the prompt↔enforcement pairs. |
| 5 | `WFAC-9` = `WFAWF-2` = `WFAU-2` | Provenance is stamped HOST-side at the write choke (lane-independent, unforgeable) and denormalized onto the ownership row so it can be read. |
| 6 | `WFAWF-11` | The node pack has execution tests. |
| 7 | `WFAU-3` | The ADR 0137 seed is latched during render, so clearing its router source cannot destroy it. |
| 8 | `WFAU-5` (partial) | The AI drawer adopts the focus/Escape/disclosure pattern both sibling drawers already implement. |
| 9 | `WFAWF-18` | The `builtinWorkflows` doc rot is corrected at the three current-state sites; the two historical records get correction notes. |

---

## 1. `WFAC-2` / `WFAWF-10` / `WFAU-4` — success-with-empty on the authoring path

`draft` ran a bounded repair loop, and when it ran out it returned
`status:'success'` carrying a definition it had *just been told was invalid*. The
run still failed — but only because a **different node** (`validate`) re-checked,
across an edge (`triggerRule: all_success`) declared in a **different file** (the
chain pack). So the honesty of the node's own contract was a property of the
wiring, not of the node.

That distinction is not academic. `draft`'s `status` is what a `:fork` reads,
what a sub-chain caller reads, and what any future edge reads. A node whose
`status` lies is a landmine for every consumer that is not the one specific edge
that happened to catch it.

**Decided:** exhaustion is `status:'failed'` with code `workflow_author_unrepaired`,
carrying the last validator errors so the repair feedback is not lost at the door.
The downstream re-check stays as defence in depth.

### The fabrication, and the fork hazard hiding inside it

`parseDefinition` coerced an unparseable response to `{}` and then MINTED
`authored.<slug-of-intent>-<runId>` onto it. Two defects in one line:

1. **Fabrication.** A placeholder standing in for invalid model output is exactly
   what the exchange contract forbids. A model answering "sorry, I can't" became
   a plausible-looking workflow object.
2. **Run-identity derivation (`WFAWF-10b`).** The minted id came from `ctx.runId`.
   **Fork ≠ resume:** a `:fork` is a fresh runId, so re-executing `draft` would
   mint a *different durable workflowId* for the same authoring intent.

**Decided:** `parseDefinition` returns `null` when the payload is not an object,
and never invents an absent id. The structured-output schema already declares
`workflowId` required, so a missing id is a validation error the repair loop
feeds back — which is the loop doing its job, not a gap to paper over.
Sanitising an id the model DID supply is kept: normalising a real value is not
inventing an absent one. This closes `WFAWF-10b` as a side effect.

## 2. `WFAU-1` — the "opens on the canvas" promise

The promise was made in `FEATURES.md`, in **four locale files**, in the **agent's
system prompt**, and in the **persist tool's `note`** — i.e. the model was being
told it could do something the product could not, and was instructed to relay it.
Nothing implemented it: `CreateWithAiPanel` had no `useNavigate`, no workflow-id
state, no completion callback, and `fetchRegisteredWorkflow` — whose docblock
names this exact use — had **zero builder callers**.

The brief framed this as a genuine fork: wire it, or remove the promise. **Wired**
— but not in the shape the tracker implies, because the tracker's shape is
impossible. See §Falsified 1.

### The end-to-end path, named

```
BuilderShell.tsx  renders  <CreateWithAiPanel/>            (inside /builder/:workflowId)
CreateWithAiPanel   on mount → listWorkflows()             baseline: Set<id>  [builder/persistence/backendStore.ts]
                  → <EmbeddedChatPanel onTurnSettled={…}/> [chat/, lazy-imported]
EmbeddedChatPanel   forwards onTurnSettled → EmbeddedConversation
EmbeddedConversation  edge-triggers it on isSending true→false   (one tick per turn)
CreateWithAiPanel   on tick → listWorkflows() again → rows NOT in baseline
                  → renders <Link to={`/builder/${id}`}>          ← the user clicks this
react-router      navigates → BuilderShell mounts for the new id → loadWorkflow(id)
```

`listWorkflows` → `listWorkflowSummaries` → `GET /v1/host/openwop-app/workflows`,
the tenant-scoped list, which projects from **ownership rows**.

**Which PR-A question this relies on:** the **scoped-list** one, not
resolve-by-id. PR-A made authored definitions born `transient`, which
`catalogVisible` hides from the *catalog*; but the owner's own scoped list
deliberately keeps its transient drafts VISIBLE (`routes/workflows.ts`, mirrored
in `listAuthoredWorkflows`). So a just-authored, unpromoted draft **does** appear
in this list for its owner, which is precisely why the diff can see it. Had the
hand-off relied on gallery/catalog visibility it would have found nothing.
`fetchRegisteredWorkflow` (resolve-by-id) remains uncalled by the builder — the
navigation goes through the builder's normal `loadWorkflow` path, so wiring the
hand-off did NOT require it. **It still has zero builder callers, and that is now
a correct outcome rather than a gap.**

### Why a link and not a navigation

Auto-navigating would have been destructive: this drawer lives *inside*
`/builder/:workflowId`, so routing away unmounts the canvas the user is standing
on, and the surface has no dirty-state guard anywhere. The sibling `propose` lane
already ends with a clicked "Open in builder" link
(`chat/reviews/ComposedWorkflowSection`); this matches that rather than inventing
a second ending. The copy in all four locales, the agent prompt and the tool
`note` now say **"ready to open"**, and the prompt is explicitly instructed not
to claim it opened anything.

### The one shared-chat change

`EmbeddedChatPanel` / `EmbeddedConversation` gain ONE additive optional override,
`onTurnSettled` — a "re-read your own state" tick that carries **no turn content**
(it cannot; §Falsified 1). Default behaviour is unchanged when absent. This is
the ADR 0073 override seam being used as designed, not a second chat.

## 3. `WFAWF-9` — acyclicity

The system prompt told the model *"the graph MUST be connected and ACYCLIC"* and
the host enforced **neither**. `validateAuthoredWorkflow` returned `{ok:true}` for
a cyclic graph — it affirmatively CERTIFIED a graph that can only ever
`cycle_detected` at dispatch, long after the model told the user it was done.

**Decided:** `findWorkflowCycleError` in `host/workflowDefinitionValidation.ts`,
delegating to the executor's own `buildGraph` + `topologicalOrder`.

**Why delegate rather than write a DFS.** The executor does **not** reject every
cycle: a back-edge whose endpoints include `core.dispatch` /
`core.orchestrator.supervisor` is a legitimate RFC 0022 dispatch-supervisor loop
and is stripped as inert. A hand-rolled "no cycles" check would have been a NEW
rule rejecting graphs the runtime happily runs — a gate that disagrees with the
thing it gates. Reusing the scheduler's pair makes *"would this run?"* and
*"may this be authored?"* the same question by construction, and keeps them the
same question when the executor's rule moves.

**Wired at BOTH doors** — `validateAuthoredWorkflow` AND `persistAuthoredWorkflow`
— because `persist` is separately callable (the chat tool, the surface, the node).
A gate on `validate` alone would be a gate on the CREATION lane and not the USE
lane: a model that skips `validate`, or revises after it, would still reach
durable state.

### Connectivity is NOT enforced — deliberately

A disconnected graph is perfectly runnable; two components both execute.
Enforcing connectivity would be a taste rule with no runtime basis, and promising
the model it is rejected would be the same defect with the polarity flipped. The
prompts now state it as the preference it is. The parity suite asserts the words
"MUST be connected" appear in **neither** prompt, so restoring the old lie fails
a test.

### Blast radius: why NOT in `validateWorkflowDefinition` itself

The tracker names `workflowDefinitionValidation.ts:363-572` — the shared
validator — as the site. The helper lives there; the CALL does not. Putting the
check inside `validateWorkflowDefinition` would apply it to the REST create, the
builder autosave, chain expansion, revision restore, from-chain and
collab-derive lanes. That converts "unrunnable at run time" into
"unREGISTERable", which for **existing stored data** means a historical cyclic
definition becomes unrecoverable through revision restore. A cyclic graph is
already refused at dispatch, so the marginal safety is small and the marginal
risk is a data-recovery path. Scoped to the authoring lane, the defect the row
actually describes — *the model is told a rule and `validate` certifies
violations of it* — is fully closed. Widening it is a separate decision that
needs its own measurement (§Residual R4).

## 4. `WFAC-3` — compaction exemption + prompt↔catalog parity

`openwop:feature.workflow-author.nodes.draft` returns the closed-world node
catalog WITH every node's JSON Schemas, and was NOT in
`SCHEMA_READ_EXEMPT_TOOLS` — while its exact sibling
`openwop:app-builder.catalog` has been since the list existed. Latent only
because the compaction toggle defaults off. A truncated enum or an elided node
array makes the model author against a catalog that is not this host's, and the
graph is then refused by `findUnknownTypeIds` — **a defect the model cannot
diagnose, because the thing it was shown was wrong.**

A new per-feature `promptCatalogParity` suite pins the hand-copies this feature
has BY CONSTRUCTION: the pack `.mjs` cannot import TypeScript, so its system
prompt restates rules the host enforces in `.ts`. Each stated rule is pinned to
its enforcement, in both polarities (acyclicity: stated MUST **and** refused;
connectivity: stated as preference **and** accepted).

## 5. `WFAC-9` / `WFAWF-2` / `WFAU-2` — provenance

**Verified before changing anything.** WRITER: only the pack's `draft` node — the
RUN lane. READER: nobody. REPLAY/`:fork`: it lives in `definition.metadata`, part
of the durable WorkflowDefinition — **not** an RFC 0056 annotation and **not**
`run.metadata` — so it survives both, and ADR 0595's `preserveDroppedFields`
already protects `metadata` on a revise.

The tracker was right about the symptom and understated the cause. Two defects:

1. **Lane-dependent.** The chat lane has no `draft` node — the agent loop IS the
   author and calls `persist` directly — so a workflow whose entire content a
   model wrote carried NO provenance at all.
2. **Forgeable.** It was stamped onto the model-controlled candidate, so
   `authoredVia` was whatever the model last said it was.

**Decided:** stamp host-side in `persistAuthoredWorkflow`, the single write choke
both doors already share — the same shape `withHostLifecycle` uses for lifecycle,
for the same reason. The descriptive half the RUN knows and the service does not
(`intent`, `model`, `attempts`) is preserved untouched: it is testimony, not
authority, and nothing reads it as authority.

**No timestamp in the definition**, deliberately: `recordRevision` is
content-addressed, so a clock value inside the definition would mint a spurious
revision on every re-persist of byte-identical content. The ownership row already
has `createdAt`/`updatedAt`.

**Made readable.** The scoped list projects from ownership rows precisely to avoid
N registry reads, so provenance living only in `definition.metadata` could never
reach the dashboard or the `/` picker. It is denormalized onto the row and STICKY
there — the same `meta.X ?? existing?.X` shape ADR 0474's publish pin uses, not a
second rule — so a later builder autosave or revision restore, which omits it,
cannot erase it. *A machine-authored workflow does not stop being
machine-authored because a human edited it.* The chip is `chip--ai`
(DESIGN.md §5.3), already the house pattern in five features, and carries its own
text label so status is never colour-only.

## 6. `WFAWF-11` — the node pack had no test

`packs/feature.workflow-author.nodes/index.mjs` — the entire authoring brain —
was executed by **no test in the repository**. That is how `WFAC-2` shipped and
survived a grading pass. The new suite drives the real handlers against the REAL
feature surface (only `ctx.callAI` is stubbed), so the closed-world catalog, the
shared validator, the ownership layer and the registry all participate.

## 7–8. `WFAU-3`, `WFAU-5`

`WFAU-3`: `seedPrompt` is a `useMemo` over `location.state`, and the effect that
opens the drawer clears that state in the SAME commit. Under React 18 automatic
batching the clear lands with `setAiHasOpened(true)`, so the first render in
which the panel mounts already had `undefined`. Both ADR 0137 producers handed
off into an EMPTY Architect — under a comment claiming "no more no-op accept".

Fixed with `useLatchedValue`, latching during **render** rather than in an effect.
This is deliberately not the tracker's shape ("latch into local state before
clearing router state"): a state+effect latch still has to WIN the batching race,
whereas latching in render removes the ordering from the problem entirely — it
cannot participate. It also made the rule testable, which is why it is an
extracted helper.

`WFAU-5`: the trigger carried `aria-pressed` where a disclosure needs
`aria-expanded` + `aria-controls`; focus never moved in, was never restored
(Close lives *inside* the collapsing region, so activating it stranded focus on
`<body>` 220 ms later), Escape did nothing, and `aria-hidden` flipped
synchronously while `visibility` lagged the transition — visible focusable
content inside an `aria-hidden` subtree (WCAG 4.1.2), now `inert`. Both sibling
drawers already did all of this; this was drift, not an unsolved problem.

## 9. `WFAWF-18` — `builtinWorkflows` doc rot

**Verified against the code, not the sentences.** `host/builtinWorkflows.ts` is
DELETED; the `BackendFeature.builtinWorkflows` FIELD is GONE (declaring one is a
TypeScript error); `LEGACY_PINNED_WORKFLOWS` is frozen empty by the ADR 0472 P4
ratchet. So the existing ADR 0072 correction note, which said "DEPRECATED",
**understated** it.

Fixed the **three** CURRENT-STATE sites: `feature.ts`'s docblock (which
contradicted its own `registerRoutes` body twelve lines below — the file argued
with itself), `routes.ts`'s header, and the `FEATURES.md` row. `docs/adr/0072`
and `ROADMAP.md` are HISTORICAL records of what shipped in June 2026, so per
*"correct, don't rewrite history"* they get appended correction notes rather than
edited bodies. *(Was "four", which is where §Correction 10's contradiction came
from: the number counted `ROADMAP.md` while the sentence after it put
`ROADMAP.md` in the other bucket.)*

---

# Prescriptions falsified

The brief and the tracker rows arrive labelled "the fix", which earns them less
scrutiny. Four were wrong, and in three cases the falsification changed the fix.

## Falsified 1 — "`fetchRegisteredWorkflow` has zero builder callers" implies wiring is calling it (`WFAU-1`)

**Mechanism:** you cannot call it without an id, and **the id cannot reach the
browser.** `agent.toolReturned` (RFC 0064) is emitted at
`host/agentDispatch.ts:1249` as
`{ toolName, callId, status: execOut.isError ? 'error' : 'ok', durationMs }` —
**no result payload.** The SPA mirror agrees: `ToolActivity`
(`chat/conversationTransport.ts:383`) has no result field, and while
`AgentToolCall.outcome` exists in the types and is rendered by `AgentEventCards`,
`applyToolActivity` (`chat/hooks/chatSession/lib.ts`) **never populates it**. So
the `workflowId` the persist tool returns is not on the wire.

Relaying tool results would be a **WIRE change**, which per `CLAUDE.md` needs an
RFC in `openwop`, not a host ADR. Hence the host-read + diff design in §2, which
needs no wire change at all.

## Falsified 2 — WFAU-4's remedy (`errorClassify.ts:162-164`) is a NO-OP, twice over

The row prescribes adding arms for `workflow_invalid`, `persist_failed`,
`acting_user_required` and the three 409s to `chat/lib/errorClassify.ts`.
**Structurally inert against the defect it names:**

1. `classifyChatError` is only reached from `ErrorCard`, which reads
   `ChatMessage.meta.error`. `meta.error` is written at exactly three sites
   (`useTurnTransport.ts:433`, `:498`, and the workflow-run dispatch path) — a
   failed agent TOOL writes none of them. The new arms would never execute.
2. Even if routed there, **the code is not on the wire.** Per Falsified 1, the
   event carries the coarse enum `error|forbidden|rate_limited|invalid_args`;
   `workflow_invalid` does not survive the trip. `applyToolActivity` then
   *replaces* the message with a generic string, so the backend's carefully
   written remedy text ("…is owned by another workspace… Author it under a new
   workflowId.") is discarded client-side.

WFAU-4 is therefore **not closable in a host PR**. Recorded as §Residual R1. The
one honest, non-wire mitigation available was applied: the architect prompt is
now explicitly instructed never to claim a failed step succeeded, and to quote
the reason the tool gave.

## Falsified 3 — putting acyclicity in the shared validator (`WFAWF-9`)

The row names the shared `validateWorkflowDefinition` as the site. Doing so would
make historical cyclic definitions unrecoverable through revision restore, for
marginal safety over a dispatch-time refusal that already exists. Scoped to the
authoring lane instead; reasoning and the widening question in §3 and §Residual R4.

## Falsified 4 — "the graph MUST be connected" (the prompt's own claim)

Both prompts asserted connectivity as a MUST. It is not a correctness rule —
disconnected components both run. Enforcing it to match the prompt would have
been the tempting "make the code match the doc" move and would have rejected
legal graphs. The **prompt** was corrected instead, and the parity suite now
fails if the MUST returns.

---

# Witnesses

Every test below was confirmed able to FAIL by breaking the code it guards
(`cp` backup → break → run → restore).

| # | Witness | File | Sabotage | RED |
|---|---|---|---|---|
| W1 | `draft` fails typed on exhaustion (invalid-but-parseable, and unparseable prose); repair loop is bounded to `maxAttempts`; no `outputs` on failure | `test/workflow-author-node-pack.test.ts` | `if (!lastValidation.ok)` → `if (false)` **plus** both cycle checks → `null` | **7 of 16** — a blast radius, not one witness; see W2/W3 for the narrow ones |
| W2 | the `workflowId` fabrication does not return | same | restore ONLY the fabrication (typed failure left intact) | **3** |
| W3 | acyclicity refused at `validate` AND at `persist`; self-loop is a cycle; disconnected graph still ACCEPTED | same | (covered by W1's combined sabotage) | see W1 |
| W4 | pack loads, declares its four typeIds, and every node fails `host_capability_missing` without the surface | same | — (characterisation; guards `WFAWF-11`) | — |
| W5 | provenance on the CHAT lane; a forged `authoredVia` is overwritten while `intent` survives; provenance is sticky across a bare `recordOwnership` | same | remove both `AUTHORED_VIA` stamps | **exactly 3** (other 16 green) |
| W6 | catalog tool is compaction-exempt, and a destroy-everything transform leaves it byte-exact while a non-exempt id is destroyed | `features/workflow-author/__tests__/promptCatalogParity.test.ts` | remove the one exempt-list entry | **exactly 2 of 12** |
| W7 | prompt↔enforcement parity in both polarities (acyclicity MUST/refused; connectivity preference/accepted) | same | — (guards Falsified 4 from returning) | — |
| W8 | hand-off renders an "open on the canvas" link for a workflow that appeared during the session; silent when nothing new; silent when the BASELINE READ FAILED | `builder/__tests__/createWithAiHandoff.test.tsx` | hand-off render → `{false ? …}` | **exactly 1** (the two negative tests correctly stay green) |
| W9 | the seed latch survives its source going `undefined`; no phantom seed; a later value wins | `builder/__tests__/aiDrawerHandoff.test.tsx` | `useLatchedValue` → `return value` | **exactly 2 of 5** |
| W10 | the AI trigger exposes `aria-expanded` + `aria-controls` and NOT `aria-pressed` | same | revert to `aria-pressed` | **exactly 2 of 5** |

**W1 is a blast radius, stated as such.** It sabotaged two independent fixes at
once and reddened seven tests. W2 is the narrow follow-up that isolates the
fabrication; W5/W6/W8/W9/W10 are each single-mechanism.

---

# Residuals — open, and open ON PURPOSE

## R1 — `WFAU-4` is NOT closed. Failure honesty at the UX layer needs an RFC.

Backend failures are typed and well-crafted; **no user-facing surface renders any
of them.** Per §Falsified 2 this needs the tool's error code + message on
`agent.toolReturned`, which is an **RFC 0064 wire change** — an RFC in
`../openwop`, not a host ADR. Until then the user's failure experience is the
model's prose, mitigated only by the prompt instruction added here. **This is the
most severe thing left open in this feature**, and it is the user-facing half of
the same Blocker whose backend half (§1) is now closed.

## R2 — `WFAWF-6`: the showcase seeder IS the retired anti-pattern. Not migrated.

**Verdict, on the stated test (ORIGIN + paired `recordOwnership`, not call-site
existence):** two in-tree `WorkflowDefinition` literals
(`host/workflowAuthorSeed.ts` `WORKFLOW_AUTHOR_SHOWCASE`) registered with **no
`recordOwnership`** — so they read as host BUILT-INs to every tenant and are
un-overwritable by anyone, including their author. That is the retired
hard-coded pattern, not the sanctioned runtime-registered tenant-owned lane.

**Not fixed here, and the obvious fix is a trap.** Adding `recordOwnership` to
the seeding tenant looks like a one-line close, but `count`/`clear` operate
HOST-GLOBALLY on fixed ids: tenant A seeds and gets a row; tenant B's seed is a
no-op (already registered) and B gets **no** row, so B stops seeing them. That is
a new defect wearing the costume of a fix — the "my fix reintroduces the family
it closes" shape. The correct close is a chain pack + per-tenant from-chain
instantiation, which is a data migration over fixed public ids and belongs in its
own PR. The `PIN_SITE_QUARANTINE` row (shrink-only, NO-GROWTH) stays.

`WFAU-16` rides with it: the untranslatable English `'AI-authored · '` name
prefix. §5's chip is now the real provenance signal, so retiring the prefix is
part of R2's migration.

> **CORRECTION 2026-08-31 — `WFAWF-6` CLOSED, and the prescribed route was
> over-engineered.** This section prescribed "a chain pack + per-tenant
> from-chain instantiation" and warned that adding `recordOwnership` is a trap
> because `count`/`clear` are host-global. **The trap is real for the NAIVE
> one-line add, but not for the full fix.** The neighbouring
> `host/demoWalkthroughsSeed.ts` (ADR 0435) proves a simpler sanctioned close:
> keep the in-tree `WorkflowDefinition` literals, but seed PER TENANT —
> `registerWorkflow` (shared by-id def, so replay/`:fork`/run still resolve) +
> `recordOwnership(tenantId, …)`, with `count`/`seed`/`clear` all keyed by
> `tenantId` (`getOwned`/`removeOwnership`). That is the ADR 0472 *sanctioned
> runtime-registered tenant-owned lane*, not the retired pin — the ratchet's own
> `SANCTIONED_ORIGINS` already lists `demoWalkthroughsSeed.ts` under exactly this
> rule. Making `count`/`clear` per-tenant IS the fix for the host-global trap this
> section named, so tenant B now gets its own ownership row.
>
> **Chosen over the chain-pack route because it dominates on every axis that
> matters here:** it is **replay-safe** — the ids stay
> `openwop-app.authored.lead-triage` / `.doc-summary` (a chain pack would mint
> per-tenant ids and strand any pre-migration run's stamp), it needs **no
> pack-gate cascade / registry republish**, and it is an existing proven pattern.
> The only thing the chain-pack route buys — "showcase defs live in a pack, not
> in-tree" — is unnecessary for demo seeds, exactly as `demoWalkthroughs`
> demonstrates. Implemented in `host/workflowAuthorSeed.ts` (rewritten to mirror
> `demoWalkthroughsSeed`), wired per-tenant in `exampleDataSeeders.ts`, and the
> ratchet drained: `PIN_SITE_QUARANTINE` loses the `host/workflowAuthorSeed.ts`
> entry, `PIN_SITE_CEILING` 5→4, and the file moves to `SANCTIONED_ORIGINS` (it
> now pairs registration with `recordOwnership`). Tier-3 non-vacuity is unaffected
> — it was always covered by a synthetic probe (the sabotage test's case 6), not
> by this live file. Witness: `test/workflow-author-seed.test.ts` (tenant-owned +
> per-tenant isolation + replay-stable ids, born red without the pairing) and
> `test/workflow-pin-site-ratchet.test.ts` (ceiling 4; the site classified
> SANCTIONED). `WFAU-16` (the English name prefix) is independent of the route
> chosen and remains open in the UX tracker.

## R3 — `WFAU-5` is only PARTIALLY witnessed.

`aria-expanded`/`aria-controls` are pinned (W10). Focus-in on open, focus
restoration on close, Escape, and `inert` are **implemented but unwitnessed**:
they live in `BuilderShell`'s JSX, and no test in this repo renders
`BuilderShell` (it pulls xyflow, the builder store and a dozen clients). I did
not write a source-string grep to stand in — that polices a spelling, not the
behaviour, and would read as coverage that does not exist.

## R4 — acyclicity is enforced on the AUTHORING lane only.

The REST create / builder autosave / from-chain / revision-restore lanes can
still register a cyclic definition, which then fails at dispatch with
`cycle_detected` — pre-existing behaviour, and honest at run time. Widening the
gate needs the blast-radius measurement described in §3 (how many stored
definitions and chain packs would become unregisterable). **Not measured here.**

## R5 — `ROADMAP.md:289` still names `builtinWorkflows`.

A historical Done record for **Campaign Studio**, a different feature. Equally
stale by the same verification, but out of this feature's scope; recorded rather
than silently touched.

## R6 — `AgentToolCall.outcome` is a declared, rendered, never-populated field.

`AgentEventCards.tsx:103` renders `call.outcome`; nothing ever sets it. It is a
seam with no writer — dead UI that will silently start working if someone ever
lands the R1 wire change, and until then is a false affordance in the codebase.
Found while falsifying prescription 1; not this feature's file, so not touched.

## R7 — `CLAUDE.md`'s "A+ reference implementation" citation.

ADR 0595 said it should not be restored until PR-B lands. With **R1 open** — the
user-facing half of the very success-with-empty Blocker the citation is made
about — my recommendation is that it stays unrestored. Not restored in this PR.

## R8 — the hand-off diff is a HEURISTIC, and can attribute a workflow this session did not author — including the user's OWN.

*Added by the reviewing session, not the implementing one — it is a limit I found
while verifying the W8 path end to end, and it belongs in the record rather than
in a chat message.*

> **This section was REWRITTEN by [§Correction 7](#correction-7--r8-understated-its-own-defect-the-window-was-not-one-chat-turn),
> which found my original text wrong in both halves. It is rewritten rather than
> annotated because the sentence as first written told the next reader the risk
> was smaller than it is — and a reader who stops at this section must not carry
> away the understatement. §Correction 7 holds the full reasoning, the fix, and
> the vacuity note on the cure that was first proposed.**

The hand-off decides "you just authored this" by set-differencing a `listWorkflows()`
read against a baseline. The list is tenant-scoped, not session-scoped, so **any**
workflow appearing in the window is attributed to this conversation — a second
browser tab, another member of the same tenant, a seeder, or an API client all
qualify. **And so does the user's own hand-built workflow**: create one via "New
workflow", let autosave register it, reopen the drawer and send any message, and
the panel offers it back as the model's output. That case needs no second actor
at all, and it is the one my first draft missed.

**The window was not "one chat turn"** — that claim was wrong. The baseline was
taken once in a `useEffect(…, [])`; the panel never unmounts (the drawer hides via
CSS, and `BuilderShell` survives navigation between workflows with no `key`), so
the exposure ran for the panel's entire lifetime. §Correction 7 closes the
no-peer case by re-baselining on drawer OPEN.

What remains true, and is why a residual survives at all: the link is a
NAVIGATION, not a destructive act, and it points at a real workflow the tenant is
entitled to open. The failure is one of ATTRIBUTION, not of authorization.

It is recorded rather than closed because every cheap fix is worse than the defect.
Correlating on the run's own output would need the tool `outcome` payload that
**R6** says is never populated and **R1**'s falsified prescription shows cannot
reach the browser without an RFC 0064 change — i.e. the honest fix is blocked on
the same wire gap as `WFAU-4`. Narrowing the diff by timestamp would trade a
visible wrong link for an invisible missing one, which is the worse direction for
a disclosure surface. If R1's wire work ever lands, close this with it: a
`workflowId` relayed on the tool return makes the diff unnecessary, not merely
narrower.

---

# RFC gate

**No new RFC in this PR.** Everything landed is host-internal: node-pack
behaviour, host validation, ownership-row metadata, host-extension route
projection, prompts, and SPA code. No wire shape, capability flag, event type or
endpoint contract changed.

**But two findings are RFC-shaped and are named as such:** R1 (tool error
code/message on `agent.toolReturned`) and the same gap read from the other
direction in §Falsified 1 (tool RESULT payload). Both are RFC 0064 surface. A
future PR that wants either must go through `../openwop/RFCS/`, not through a
host ADR.

# Replay / fork

- `draft`'s typed failure is deterministic given the same model output; the node
  is `role:"action"`, so replay reads the recorded result.
- **`WFAWF-10b` closed:** removing the `ctx.runId`-derived id means a `:fork` can
  no longer mint a different durable workflowId for the same intent.
- `findWorkflowCycleError` is pure over the definition — no clock, no random.
- Provenance carries **no timestamp** by design (§5), so re-persisting identical
  content is still content-identical and cannot mint a spurious revision.

# Gates run

- Backend `tsc --noEmit`: **clean.**
- Targeted vitest: the 8 workflow-author suites, the new node-pack and parity
  suites, `agent-prompt-tool-ids`, `tool-content-trust-required`, the ADR 0472
  `workflow-pin-site-ratchet`, and the pack-pin-parity suites — **all pass.**
- Frontend `tsc --noEmit`: **clean.** Targeted frontend vitest: the four builder
  suites — **pass.**
- **`frontend/react && npm run build` was run ONCE (green) before the provenance,
  drawer and hand-off-test commits, and NOT re-run afterwards** — the box was
  under load from a peer session's fleet. So the token/CSS/bundle/CSP integrity
  gates are **UNVERIFIED for the last three commits.** No colour literal, emoji
  icon, `window.confirm`/`alert`, or new CSS class was introduced in them; the
  only new classes used (`chip`, `chip--ai`) are pre-existing.
- **`npm run ci` was NOT run** — it is owned by the caller.

---

# Correction notes

## §Correction 1 (2026-08-21) — my own change killed the feature's chat lane, and the pack's own tests could not see it

A final verification sweep — run *after* everything was committed and pushed —
found `test/workflow-author-agent-pack.test.ts` RED:

```
AssertionError: agent feature.workflow-author.agents.workflow-architect
  must be in the inventory: expected undefined to be defined
AssertionError: expected 404 to be 200
```

**Cause: mine.** `packs/.steward-manifest.json` carries a CONTENT DIGEST per pack
directory (`host/packTrust.ts` — `steward_manifest_digest_match`). Editing a
pack's contents invalidates that digest, and ADR 0555 P0 fails **closed**: an
unattested pack is `tier:'untrusted'` and `packs.agentLoader` **refuses to
register its agents at all**.

```
packs.agentLoader: pack is not dispatchable — refusing to register its agents
  pack=feature.workflow-author.agents version=1.1.1 tier=untrusted reason=no_attestation
```

So the Workflow Architect disappeared from `GET /v1/agents` — **the entire chat
lane of the feature this ADR exists to fix, dead**, as a side effect of a
version bump and a prompt edit.

**Both packs were stale, not just the loud one.** `feature.workflow-author.nodes`
was equally unattested (manifest 1.0.2, tree 1.0.3). It stayed silent because its
tests `import()` `index.mjs` directly and bypass pack trust entirely — the new
`WFAWF-11` witness added in §6 **cannot see the seam it sits behind.** A test that
loads the module under test by direct import is blind to every gate between the
registry and the module. That is a real limit of the witness, not a reason to
distrust it, and it is why the sweep mattered.

**Proved before fixing.** Restoring ONLY the two pack files to `origin/main`
content made the suite pass 2/2; restoring my versions made it fail again. That
ordering matters: "red in an area you touched" still deserves the pristine-baseline
check, and here it converted a guess into a fact.

**Fix:** `node scripts/gen-steward-manifest.mjs`, with the diff verified line by
line to touch EXACTLY the two packs edited in this PR — a regenerator that
quietly re-attests a peer's in-flight pack edit would be a worse defect than the
one it fixes.

**The generalisable lesson:** *editing any pack ⇒ re-run
`gen-steward-manifest.mjs`*, and the failure mode is INVISIBLE to that pack's own
unit tests. Neither `npm run ci` nor a targeted run of the suites I had touched
would have caught it at the time I introduced it, because I ran those suites
BEFORE the agent-pack bump and only a subset after. **Run the suites that cover
what you touched, after you touch it** — the ordering, not the selection, was the
mistake.

## §Correction 2 (2026-08-21) — a gate this ADR claims was NOT re-run

§Gates run says `frontend/react && npm run build` was green once, before the last
three commits. That remains true and is restated here because it is the kind of
claim that decays into "the gate was green" on a later read: the token/CSS/bundle/
CSP integrity checks are **UNVERIFIED** for the provenance, drawer and hand-off-test
commits. They must be run before this branch merges.

## §Correction 3 (2026-08-21) — the retired promise survived in the two files this PR EDITED, and one of them is model-facing

§2 says the "opens on the canvas" promise was reworded *"everywhere it is made"*.
**It was not.** An adversarial review found it alive in both workflow-author pack
manifests — **files this PR itself edited** (`1.0.2→1.0.3`, `1.1.0→1.1.1`) and
then re-attested in §Correction 1, so the claim rode through two of my own passes:

- `packs/feature.workflow-author.nodes/pack.json` — the **persist node's**
  `description`: *"…so it opens in the builder canvas."*
- `packs/feature.workflow-author.agents/pack.json` — the pack `description`
  (*"registers it so it opens in the builder"*, plus the "connected" claim
  §Falsified 4 says was corrected) and the **agent** `description`
  (*"drafts a connected node/edge DAG"*).

**The node one is MODEL-FACING, and the call graph is the reason it matters.**
`nodeCatalogBuilder.ts` copies a manifest node's `description` verbatim into
`CatalogNode.description`; `buildAuthoringCatalog` (no meta-node exclusion) passes
it through; the pack's `buildSystemPrompt` `JSON.stringify`s the whole menu into
the system prompt. So in ONE turn the host told the model *"it opens in the
builder canvas"* (catalog) and *"Do NOT say it is already open"*
(`agentTools.ts` persist `note`) — **two contradictory host statements, the older
one being the lie the PR exists to retire.** The same string is the palette
tooltip (`builder/palette/NodePalette.tsx` — `titleParts.push(entry.description)`),
so it is user-facing on the identical hop.

**Fixed content-only; versions deliberately NOT bumped.** `feature.ts`
`requiredPacks` pins `1.0.3` / `1.1.1`, and §Correction 1 is the record of what a
version/pin mismatch costs. Editing pack CONTENT still invalidates the steward
digest, so `node scripts/gen-steward-manifest.mjs` was re-run and the diff
verified to touch **exactly** those two entries (versions unchanged);
`--check` exits 0.

### The population swept, and how

The class is *"a host-authored surface that restates what `persist`/authoring
does"*. Enumerated by asking where such a statement can physically live, then
grepping each:

| Surface | Reaches | Verdict |
|---|---|---|
| `packs/…nodes/pack.json` node `description` ×4 | model (catalog→prompt) + user (palette tooltip) | **persist FIXED**; draft/validate/get make no open-claim |
| `packs/…agents/pack.json` pack + agent `description` | user (`GET /v1/agents`, packs admin) | **both FIXED** |
| `packs/…agents/prompts/workflow-architect.md` | model | already correct (checked line by line; `:35` *"they'll open it in the builder"* is the HUMAN as subject and is TRUE) |
| `packs/…nodes/index.mjs` `buildSystemPrompt` | model | already correct |
| `agentTools.ts` four tool `description`s + persist `note` | model | already correct (`"can be opened"`, `"READY TO OPEN, not already open"`) |
| `packs/…nodes/schemas/*.json` `description`s | model (inlined into the catalog) | clean — no open-claim |
| `examples/workflow-chain-packs/workflow-author/pack.json` | user (chain gallery) | clean |
| `frontend/react/src/builder/i18n/{en,es,fr,pt-BR}.ts` | user | already correct |
| `FEATURES.md:193` | reader | already correct |
| `features/workflow-author/feature.ts` docblock | reader | **FIXED** — still said *"so it opens in the existing xyflow builder"* |
| `workflowAuthorService.ts:388` | reader | left: an explicitly PAST-TENSE quote of the retired string inside a comment explaining the old defect |

Two searches, both repo-wide and both run: `grep -rniE "open(s|ed|able)?\b"`
across the feature + packs, and `grep -rn -i connected` across the same. The
frontend palette was checked for a HAND-COPY of node descriptions
(`builder/palette/catalogRegistry.ts`) — there is none; the tooltip reads the
backend catalog, so the manifest fix covers the user-facing hop too.

### Witness (W11)

`promptCatalogParity.test.ts` gains four assertions. The population is derived
**from the manifests themselves** (`nodesManifest.nodes.map(...)`,
`agentsManifest.agents.map(...)`), not a hand-written list, so a newly declared
node or agent is covered the moment it exists.

The negative regex is `/(?<!to )(?<!be )\bopens?\s+(?:it\s+)?(?:in|on)\s+the\s+(?:builder|canvas)/i`.
The two lookbehinds are load-bearing and were added *because the first version
went red on the fix*: they separate the FINITE voice that asserts the hand-off
already happened (`"so it opens in the builder"`, `"it is open in the builder"`)
from the accurate forms the fix ships (`"ready TO OPEN on the canvas"`,
`"can BE opened in the builder"`), which must stay sayable.

The third assertion is the one that makes this more than a grep: it re-points
`OPENWOP_PACK_DIR` at the repo's own `packs/` (restored in `finally` — the
`isolatePackDir` tripwire fails a file that leaks it), runs the REAL
`buildNodeCatalog()`, and asserts the persist node's catalog `description` is
byte-identical to the manifest's and free of the claim. **That executes the
model-facing hop instead of asserting it in prose.**

**Sabotage:** appended `", so it opens in the builder canvas"` to the persist
description while LEAVING the truthful sentence intact (so the positive
"states the truth" assertion could not mask it) → **exactly 2 red**, both on the
persist row: the manifest-prose negative and the catalog-hop pin. No other test
in the file moved.

## §Correction 4 (2026-08-21) — "made readable" had ZERO witness on the hops that make it readable

§5 ends *"Made readable."* The three provenance witnesses behind that sentence
(W5) all stop at `getOwned()` — the ownership ROW. An adversarial review DELETED
the projection line in `routes/workflows.ts` (`...(o.authoredVia ? … : {})`) and
ran six suites: **96 passed, 0 failed.** On the SPA side
`grep -rn "authoredVia\|aiAuthoredChip" frontend/react/src --include=*.test.tsx`
returned **zero**. So the chip could be removed from the product with CI green
and an ADR claiming the defect closed.

**The class is the HOPS between the row and the pixel, and there are three** —
the review named two; the third was found by walking the chain:

| # | Hop | Site | Was witnessed |
|---|---|---|---|
| 1 | ownership row → wire | `routes/workflows.ts:252` | no |
| 2 | wire → client summary | `builder/persistence/backendStore.ts:109` | no |
| 3 | client summary → pixel | `builder/WorkflowCardViews.tsx:319` (grid card) **and** `:394` (list row) | no |

Hop 2 is the one the review did not name and is silent by construction:
`listWorkflows` REBUILDS the row field by field rather than spreading it, so
dropping one line loses the field with no type error. Hop 3 is **two** sites —
a witness on only one leaves half the dashboard unguarded.

### Witnesses (W12–W14), each sabotaged independently

| # | Hop | Test | Sabotage | RED |
|---|---|---|---|---|
| W12 | row → wire | `test/workflow-author-route.test.ts` — persist over the real booted app, then `GET /v1/host/openwop-app/workflows`; a REST-created workflow is the control (no `authoredVia`), which also proves the route PROJECTS the field rather than stamping it | delete `...(o.authoredVia ? … : {})` | **exactly 1** — and the three node-pack provenance tests stayed GREEN in the same run, reproducing the review's finding |
| W13 | wire → client | `persistence/__tests__/backendStore.syncHonesty.test.ts` — a stubbed 200 carrying `authoredVia`; a row WITHOUT it is the control (the projection must not invent it) | delete the `authoredVia` line in `listWorkflows` | **exactly 1** |
| W14 | client → pixel | `builder/__tests__/WorkflowCardSemantics.test.tsx` — `it.each` over BOTH `WorkflowCard` and `WorkflowRow`: `.chip--ai` present, its own TEXT label (`AI-authored`, never colour-only), the review-before-you-run tooltip; and absent for a hand-built workflow | `{wf.authoredVia ? …}` → `{false ? …}`, **once per view** | **exactly 1 each** — the two sites are independently guarded |

The route test learns the caller's tenant from `allOwnershipByWorkflow()` after a
REST create rather than assuming one: the list projects `listOwned(tenantOf(req))`,
so a tenant mismatch would make the assertion pass vacuously on an absent row.
(`GET …/workspaces` was tried first and 404s in that harness.)

**Gate note, superseding §Correction 2 for this commit:**
`( cd frontend/react && npm run build )` was run and is **GREEN** here — the
token/CSS/`check-built-css`/bundle-budget/CSP checks included. §Correction 2's
warning still stands for the three commits it names, but the branch now has a
green frontend build at its tip.

## §Correction 5 (2026-08-21) — the drawer's new Escape handler steals Escape from the chat inside it

§8 (`WFAU-5`) says the AI drawer "adopts the focus/Escape/disclosure pattern both
sibling drawers already implement." **The pattern did not transfer, and copying
it was the bug.**

`BuilderShell`'s drawer `onKeyDown` sits on the drawer element, so it is a
React-tree **ancestor of the embedded chat**. It handled Escape unconditionally.
Two in-chat handlers call `preventDefault()` **without** `stopPropagation()`:

- `chat/ChatInput.tsx` — Escape during a streaming turn **cancels the turn**
- `chat/MessageBubble.tsx` — Escape **exits message-edit**

So Escape-to-cancel-a-turn also slammed the drawer shut and yanked focus to the
toolbar trigger — a regression **this PR introduced**. `HistoryDrawer` /
`EvalsDrawer` were a safe precedent only because neither contains a nested
Escape consumer; the AI drawer is the first that does. The correct guard was
already in the house idiom, in the very file that breaks it
(`ChatInput.tsx`'s own `if (e.defaultPrevented) return;` backstop).

**Fixed as ONE shared rule, not a fourth hand-written copy** —
`drawerEscapeHandler(close)` in `builderShellHelpers.ts`:

```ts
if (e.key !== 'Escape' || e.defaultPrevented) return;
e.stopPropagation();
close();
```

`stopPropagation` is KEPT (Escape that closed this drawer must not also reach
anything above it); `defaultPrevented` is the added half. **The two sibling
drawers adopt the same helper.** That change is behaviourally inert for them
today — verified by grep over `frontend/react/src/builder/`: neither contains a
descendant that `preventDefault`s Escape, and no ancestor of any drawer consumes
Escape, so both the new guard and the newly-added `stopPropagation` are no-ops
there. It is adopted anyway because *the copies are what drifted*: two correct
hand-written copies produced one wrong third.

### Witness (W15)

`builder/__tests__/aiDrawerHandoff.test.tsx` — three cases over a REAL React
tree using the REAL helper: a descendant that `preventDefault`s Escape (the
ChatInput/MessageBubble idiom) does NOT close the drawer; an unconsumed Escape
DOES (the guard must not disable the drawer — a gate with no exit is a defect);
other keys are ignored.

**Sabotage:** dropped `|| e.defaultPrevented` → **exactly 1 red**, the
already-consumed case. The positive case stayed green, so the assertion is
about the guard and not about the handler existing.

**Limit, stated rather than implied:** this witnesses the MECHANISM (synthetic
bubbling + `defaultPrevented` surviving the hop) over a reconstructed tree. It
does NOT witness the WIRING — that `BuilderShell` passes this handler to the
drawer div and renders `CreateWithAiPanel` inside it — because no test in this
repo renders `BuilderShell`. That is `R3`, unchanged.

## §Correction 6 (2026-08-21) — the hand-off disclosure was a live region that announces nothing

`CreateWithAiPanel` rendered the hand-off as `<div role="status">` **already
containing its text**. `DESIGN.md` §8 forbids exactly this and explains why: AT
registers a live region on INSERTION and announces subsequent MUTATIONS, so a
conditionally-mounted inline region announces approximately nothing — *"and a
test asserting the attribute passes either way."* ADR 0500 records this same
defect shipping three times. `scripts/check-live-regions.mjs` does not catch it
(it knows the `useState`-backed `aria-live` shape, not this one).

This is not a cosmetic a11y nit here. Per §Falsified 1 the `workflowId` cannot
reach the browser through the chat, so **this block is the only product-owned
signal that something is ready to open** — a screen-reader user got nothing at
all.

**Fixed with the house mechanism**: the visual block stays, `role="status"` is
removed, and `announce()` (`ui/announce.tsx` → the always-mounted
`GlobalLiveRegion`, ADR 0363 P4) fires in the `onTurnSettled` `.then()` beside
`setAuthored`. **Polite, not assertive** — it arrives on a background re-read,
not as the direct result of a keystroke.

### Witness (W16)

`builder/__tests__/createWithAiHandoff.test.tsx` asserts the ANNOUNCEMENT
(`currentAnnouncements().polite`, the announcer's own test seam), **pinned to the
visible copy** so the spoken and shown words cannot drift, plus the negative that
the block is no longer its own live region.

Asserting the announcement rather than the attribute is the whole point: the old
shape would have passed an attribute assertion.

**Sabotage:** removed the `announce(...)` call → **exactly 1 red.**

## §Correction 7 (2026-08-21) — R8 UNDERSTATED its own defect. The window was not "one chat turn".

`R8` (written by the reviewing session) says the hand-off diff's exposure is
bounded because *"the window is one chat turn"*, and lists only EXTERNAL sources
(a second tab, a peer, a seeder, an API client). **Both halves are wrong, and
R8 is rewritten below rather than annotated, because the sentence as written
tells the next reader the risk is smaller than it is.**

1. **The window was the panel's whole lifetime, which never ends.** The baseline
   was taken in a `useEffect(…, [])` and never refreshed. The panel does not
   unmount: `aiHasOpened` only ever goes true, and the drawer hides via CSS
   (`data-open`), not unmount. `BuilderShell` also survives navigation BETWEEN
   workflows — `/builder/:workflowId` renders one `<BuilderTab/>` which renders
   `<BuilderShell/>` with **no `key`**, so a param change re-runs the load effect
   without remounting.
2. **The worst case needs no peer at all.** Open `/builder/A`, open the drawer
   (baseline captured), close it, click "New workflow", let autosave register it,
   reopen the drawer, send "thanks" → the panel offers **the user's own
   hand-made workflow** as the model's output, on the surface whose entire
   purpose is honest attribution.

**Fixed — and the review's own suggested cure was only half of it.**

- **Re-baseline on drawer OPEN**, not only on mount, and clear the baseline to
  `null` FIRST so a turn settling before the read lands is silent rather than
  diffing against a stale set. **This is what closes the no-peer case above**,
  which per-turn re-baselining alone does NOT: the hand-built workflow appears
  *before* the first turn of the reopened drawer.
- **Re-baseline after every settled turn** (the review's suggestion) — see the
  vacuity note below for what it actually buys.
- **Reword the copy** (the review's suggestion, adopted): `aiAuthoredReady` in
  all four locales stops asserting causation. *"The Architect registered a
  workflow"* → *"A new workflow appeared in this workspace since you opened this
  panel."* The panel cannot know the Architect wrote it; it can know it was not
  there when the panel opened. **This does not close the residual — it stops the
  product asserting what it cannot know**, which is the same rule §1 and §2
  apply to the model.

### The re-baseline the review asked for is nearly a NO-OP, and sabotage is how I found out

The list ACCUMULATES with de-duplication across turns (a plain replace would
delete the link the user was about to click the moment the next turn settled).
Under accumulation, `(rows₂ \ rows₁) ∪ (rows₁ \ base)` and
`(rows₂ \ base) ∪ (rows₁ \ base)` are the **same rendered set** whenever the list
only grows. So the obvious assertion — *"turn 2 shows both links"* — is VACUOUS:
disabling per-turn re-baselining reddened **nothing**.

The one thing it genuinely changes is the ANNOUNCEMENT. Without it `fresh` never
empties, so every later turn re-runs `announce` with the same sentence — and
`withRepeatMark` deliberately makes a repeat audible again. A screen-reader user
would be told *"a new workflow appeared"* on **every turn for the rest of the
session**. That is the assertion the witness makes.

*Recorded because it is the general shape:* a cure that reads as obviously
correct can be inert against the assertion you were about to write, and only the
sabotage says so.

### R8, rewritten

> **R8 — the hand-off diff is a HEURISTIC and can attribute someone else's
> workflow to this session.** The panel decides "this appeared" by diffing a
> `listWorkflows()` read against a baseline. The list is TENANT-scoped, not
> session-scoped, so anything that appears inside the window is included: a
> second browser tab, another member of the tenant, a seeder, an API client —
> **and, until §Correction 7, the user's own hand-built workflow.**
>
> The window is now bounded: re-taken when the drawer OPENS and after every
> settled TURN. **What remains open is a workflow created by another actor
> *during* one of the user's turns.** The copy no longer claims the Architect
> made it, so the residual is now "this list may include something you did not
> ask for", not "the product asserts the model wrote your workflow".
>
> Consequences stay bounded for the same reasons as before: the link is a
> NAVIGATION, not a destructive act, and it points at a real workflow the tenant
> is entitled to open. The failure is ATTRIBUTION, not authorization.
>
> The honest close is still blocked on the same wire gap as `WFAU-4`: correlating
> on the run's own output needs the tool `outcome` payload that **R6** says is
> never populated and **§Falsified 1** shows cannot reach the browser without an
> RFC 0064 change. If that lands, close this with it — a relayed `workflowId`
> makes the diff unnecessary, not merely narrower.

## §Correction 8 (2026-08-21) — one transient baseline-read failure disabled the hand-off for the session, and a test PINNED that

`.catch()` on the baseline read left `baseline.current === null`, and
`onTurnSettled` early-returned on `if (!base) return;`. With no unmount there was
**no recovery path**: one failed read killed the hand-off for the rest of the
browser session. `CLAUDE.md` § "Rate-limit gotcha" documents that builder pages
fan out enough parallel reads to trip the per-IP 429 budget — and the drawer
opens inside that window.

Failing SILENT is the right polarity (a read we could not do is not a result).
The **permanence** was incidental, not designed.

**Worse: the third existing test pinned the defect as the guarantee.** It
asserted `expect(listWorkflows).toHaveBeenCalledTimes(1)` after the turn settled
— i.e. "no second read is even attempted". That is the *"tests that PIN
defects"* family: it encoded what the code did wrong as what it must do. **The
test is rewritten, not just extended.**

**Fix:** `onTurnSettled` does its read FIRST, then reads `baseline.current`. One
read, two jobs — it re-baselines, and when the window's own read lost it ADOPTS
this read as the baseline. Silent this turn, working from the next one on, and
it cannot invent a link (the adopted baseline contains every pre-existing row).

**This also makes the reviewer's SUSPECTED-but-unproved startup race harmless by
construction.** `WorkflowAuthorWelcome` auto-submits the seed prompt on mount, in
the same commit that dispatches the baseline read. If that round-trip lost, the
ADR 0137 seeded flow — the one case the hand-off was built for — would have been
silent forever. It now recovers on the following turn.

### Witnesses (W17–W19), each sabotaged separately

| # | Witness | Sabotage | RED |
|---|---|---|---|
| W17 | a failed baseline read is silent THIS turn (a pre-existing row is never offered) and RECOVERS on the next | move `if (!base) return;` above the re-baseline (the old shape) | **exactly 1** |
| W18 | an unchanged list does not re-announce, and the existing link survives | adopt-but-never-re-baseline | **exactly 1** (only after the assertion was rewritten — the first version was vacuous, see above) |
| W19 | re-baselining on drawer REOPEN: a workflow the user hand-built while the drawer was closed is NOT attributed to the next turn | `useEffect(…, [open])` → `[]` | **exactly 1** |

**Gates:** frontend `tsc --noEmit` clean; all 34 builder suites **295/295**;
`( cd frontend/react && npm run build )` **GREEN**.

## §Correction 9 (2026-08-21) — the parity suite claimed a scope it did not cover, and policed two spellings

`promptCatalogParity.test.ts`'s connectivity assertion was titled *"CONNECTIVITY
is NOT stated as a MUST anywhere the model reads"* and checked **two of the three
sources**. `agentToolsSrc` — the chat lane's own tool descriptions — was
`readFileSync`'d at the top of the file and never asserted against, and
`agentTools.ts` still told the model to *"compose a **connected**, acyclic
node/edge graph"*. So §Falsified 4's correction was, in the lane most users
actually reach, **not made**.

Two defects, one row:

1. **Scope claimed ≠ scope covered.** A ratchet that names a surface it does not
   read is worse than no ratchet: it is a green light over an unread file.
2. **Spelling-bound.** `/MUST be connected|Keep the graph connected/` matches two
   exact strings. This repo has a standing lesson for that shape (*"ratchets
   police a SPELLING, not the invariant"*), and it is not theoretical here —
   **sabotage confirmed it**: rewriting the pack prompt to *"The graph MUST be a
   fully connected component"* would have sailed past the old regex.

**Fixed:**
- `agentTools.ts`'s `draft` description reworded — ACYCLIC as the rule (which
  both doors enforce), a single connected graph as the PREFERENCE it is.
- The assertion is now `it.each` over **all three** model-facing sources, testing
  `/\bconnected\b/i` after removing the one honest phrasing
  (`/a\s+single\s+connected\s+graph/gi`). `\bconnected\b` does not match
  "disconnected" — no word boundary — which is exactly what keeps the honest
  sentence sayable.
- Comments are stripped from the two CODE sources only (a comment QUOTING the
  retired wording is not the model reading it; the markdown prompt is stripped of
  nothing, because every byte of it reaches the model).
- A **positive** counterpart was added: all three sources must still STATE the
  preference. Deleting the sentence is not a fix — the model would be left
  guessing, and a negative-only ratchet rewards silence.

### Witness (W20)

**Sabotage 1:** restored `"compose a connected, ACYCLIC"` in `agentTools.ts` →
**exactly 1 red**, the `agentTools.ts` row — the row that did not exist before.
**Sabotage 2:** replaced the pack prompt's honest sentence with a NEW spelling of
the lie (*"The graph MUST be a fully connected component."*) → **2 red** (the
negative for that source, plus the positive that its preference vanished). The
old regex would have caught neither.

## §Correction 10 (2026-08-21) — the two records this PR wrote contradicted each other

ADR 0072's new Correction 2 said **four** current-state sites were fixed and
named `ROADMAP.md` among them. §9 above said **four** and then listed **three**,
putting `ROADMAP.md` in the other bucket (appended correction note, per *"correct,
don't rewrite history"*). The diff says §9's *treatment* is what happened and
§9's *number* was wrong.

**Ground truth, from `git diff origin/main...HEAD`:**

| Site | Treatment |
|---|---|
| `features/workflow-author/feature.ts` docblock | prose REPLACED |
| `features/workflow-author/routes.ts` header | prose REPLACED |
| `FEATURES.md` row | prose REPLACED (+ an inline `(Corrected …)` note) |
| `ROADMAP.md` Done row | correction note APPENDED to the historical row |
| `docs/adr/0072` | correction note APPENDED |

Both records now say **three replaced + two appended**, and each carries a note
saying what the number used to be. In a PR whose subject is doc rot, a record of
the fix that drifts from the fix is the same defect one level up — so it is
corrected in place rather than left for the next reader to re-derive from the
diff.

**No witness is possible or appropriate here.** This is prose-vs-prose
consistency between two hand-written records; a test that pinned either sentence
would police a spelling, which is the family §Correction 9 exists to reject.

## §Correction 11 (2026-08-21) — dead type-escape-shaped noise in a new test

`builder/__tests__/aiDrawerHandoff.test.tsx` spread
`{...({} as Record<string, never>)}` onto `<BuilderToolbar>`. **Removing it and
running `tsc --noEmit` produces no diagnostics** — it is a NO-OP that READS like
a deliberate defeat of required-prop checking, in a repo that bans `as any` /
`@ts-ignore` / `@ts-nocheck`. Deleted.

**Class swept:** `grep -rn "as Record<string, never>"` across
`frontend/react/src`, `backend/typescript/src` and `backend/typescript/test`
returns exactly two hits. The other
(`test/conformance-claims-routes.test.ts:94`) is a **different shape** — an
opaque alias for a fetched JSON body that is re-narrowed at each read site, not a
props-spread escape — and belongs to another feature. Left alone.

---

# Review fold-in — final state (2026-08-21)

Eleven correction sections above (§3–§11) fold in an adversarial review of this
PR. Two findings changed the DIAGNOSIS as well as the code (§Correction 7's
window, §Correction 10's count), one cure was found to be **nearly inert** and is
recorded as such rather than shipped as if it worked (§Correction 7's per-turn
re-baseline), and one finding's prescribed cure was **half the fix** (§Correction
10 named only ADR 0072; ADR 0596 §9 was wrong too).

**Witnesses added: W11–W20.** Every one was confirmed able to FAIL by breaking
the code it guards (`cp` backup → break → run → restore), and every sabotage
result is stated with its section. One assertion (W18) was **rewritten because
its first version was vacuous** — the sabotage reddened nothing, which is what
exposed that the cure it was guarding was itself nearly a no-op.

## Limits that remain, stated here so they are not only in a chat message

- **`R3` is unchanged.** No test in this repo renders `BuilderShell`. The AI
  drawer's focus-in, focus-restoration, `inert` and (now) the Escape WIRING are
  implemented and unwitnessed; §Correction 5's W15 witnesses the Escape
  MECHANISM over a reconstructed tree, not the wiring.
- **The palette-tooltip hop of §Correction 3 is not test-witnessed.** The fixed
  string reaches the tooltip through `entry.description`, i.e. the same backend
  catalog the model reads — verified by reading
  `builder/palette/NodePalette.tsx` and confirming `catalogRegistry.ts` holds no
  hand-copy. A backend test asserting a frontend source string would police a
  spelling across a workspace boundary; it was not written.
- **`R8`'s residual** (a workflow created by another actor DURING one of the
  user's turns) is open by design — see the rewritten R8. The copy no longer
  claims the Architect made it.
- **`R1`, `R2`, `R4`, `R5`, `R6`, `R7` are untouched by this fold-in.**

## Gates run in the fold-in

- Backend `tsc --noEmit`: **clean.**
- Backend targeted vitest: the eight `workflow-author-*` suites +
  `promptCatalogParity` + `agent-prompt-tool-ids` + `tool-content-trust-required`
  — **151/151.**
- `node scripts/gen-steward-manifest.mjs --check`: **exit 0** (208 packs).
- Frontend `tsc --noEmit`: **clean.**
- Frontend vitest `src/builder` + `src/ui`: **659/659** (64 files).
- **`( cd frontend/react && npm run build )`: GREEN** — token/CSS,
  `check-built-css`, bundle budget and CSP hash included. **This closes
  §Correction 2's outstanding warning: the branch tip now has a verified
  frontend build.**
- **`npm run ci` was NOT run** — it remains owned by the caller.
