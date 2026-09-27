# Documents (unit C2) — chat-first port review

Scope: `features/{documents, document-editor, docs}` (backend + frontend).
Method: `.claude/skills/chat-first-port/SKILL.md`, single-feature mode.

**Headline.** The working chat-first path already exists and is clean — ADR 0308's
`documents.draft` / `documents.get` / `documents.list-templates` are real
`registerFeatureAgentTool` tools that share the HTTP routes' authz predicate and
write through the ONE documents owner. `document-editor` rides the canvas chassis
and `docs` rides CMS+Publishing+KB+MCP verbatim. **But the feature's headline
"agentic generate-from-template" is THEATER**: the `generate-from-template` node,
the `document-author`/`document-reviewer` agent packs, and the modal's
"assemble/generate" button form a declared-orchestration layer with **no igniter
and no reachable execution path** — nothing creates runs of the node, and the
agents' allowlisted tools cannot resolve in the ONE chat.

---

## Contract scouting (pins)

**The real chat path (RIDES).** Three feature-registered chat tools exist and work:
- `openwop:documents.draft` — `agentTools.ts:135-166`; writes a real draft through
  `createDocument`/`addVersion` (`agentTools.ts:99-112`), acting-user-gated
  (`:67-70`), toggle-rechecked (`:61-64`), org RBAC parity with the HTTP write path
  (`:84-87`, `resolveEffectiveAccess … workspace:write`), retry-idempotent via a
  run-scoped deterministic id (`:96-107`).
- `openwop:documents.get` — `agentTools.ts:218-265`; read-before-write, exact
  `workspace:read` parity (`:244-247`).
- `openwop:documents.list-templates` — `agentTools.ts:267-306`.
These are in the `BUILTINS` map (`agentToolProvider.ts:426` `builtinAgentToolIds`),
so any chat agent can call them.

**The declared-but-dead orchestration (THEATER).**
- Node `feature.documents.nodes.generate-from-template` is declared
  (`packs/feature.documents.nodes/pack.json`) and implemented
  (`packs/feature.documents.nodes/index.mjs:78,144`) — it assembles → `ctx.callAI`
  → persists. **No igniter.** A repo-wide grep for `generate-from-template` across
  `backend/` and `frontend/` hits only the toggle description
  (`documents/feature.ts:52`), a comment (`seedTemplates.ts:10`), and the pack
  manifest. No `startWorkflowRun`, no workflow definition, no route, no UI creates a
  run of it. (Contrast the sibling `render` node, which IS ignited — the
  insights-suite meta-workflow chains it: `features/insights-suite/metaWorkflows.ts:32,46`.)
- Agents `feature.documents.agents.document-author` / `document-reviewer`
  (`packs/feature.documents.agents/pack.json`) allowlist **workflow-node typeIds**
  (`openwop:feature.documents.nodes.assemble` / `.generate-from-template` /
  `.list-documents`). In live chat dispatch, `compileAgentTools`
  (`agentDispatch.ts:481-489`) intersects the allowlist with the host's
  `availableTools` = `builtinAgentToolIds()`. Those node typeIds are **not** in
  `BUILTINS`: node-as-tool projection is a curated allowlist of PURE compute nodes
  only — `PROJECTABLE_COMPUTE_NODE_TYPE_IDS = [variance-compute, talent-score]`
  (`agentToolProvider.ts:45-48`), documents nodes excluded. So both agents resolve
  to **zero** of their declared tools in chat — toothless personas (Agency test
  fail). They are eager-loaded into the AgentRegistry at boot
  (`bootstrap/agentPackResolver.ts:46-63`) but no source seeds them into a roster or
  the chat agent picker.
- Frontend "generate from a template" dead-ends: `NewDocumentModal.runAssemble`
  (`NewDocumentModal.tsx:197-204`) POSTs `assemble` and drops the returned
  `augmentedPrompt` into a `<pre>` (`:488`) under a Sparkles-iconed button labeled
  "assemble" (`:493`) — there is no "generate" or "save this as a document" from the
  assembled output. The other template path, `applyTemplate` (`:180-186`), calls
  `createDocument` with only title/kind → an **empty** document. The toggle sells
  "agentic generate-from-template"; the UI delivers a prompt-string preview and an
  empty doc.

**Owners each surface instantiates (not shadows).**
- `document-editor` → `registerCanvasEditorRoutes` (`document-editor/routes.ts:41`),
  `canvas.document` on `host.canvas`, collab via ADR 0359 (`:49-51`). Clean RIDES of
  the canvas chassis.
- `docs` owns no store — CMS pages `collection:'docs'` (`docs/docsService.ts:1-7`),
  public serve via Publishing's existing route (`docs/routes.ts:1-20`), KB sync on
  publish (`docs/feature.ts:22-24` `onCmsPageLifecycle`), MCP expose-tool workflows
  (`docs/mcpToolsWorkflows.ts`), search/get through `ctx.features.docs`
  (`docs/surface.ts`). Clean composition.
- Artifact Library/workbench (`documents/artifactRoutes.ts`) — read-only projection
  over documents+media+run-output, "owns NO data" (`:13`), per-record authz.
- Promote-to-rich, materialize-from-canvas, delete-canvas-from-list all reuse the
  canvas owner's cascade (`routes.ts:115-140`, `DocumentDetailPage.tsx:153-169`),
  not a second mutation path.

**Executor/chassis constraint that bounds the port.** A workflow node cannot be
called as a chat tool unless it is on the pure-compute projection allowlist
(`agentToolProvider.ts:35-48`) — side-effecting/`ctx`-using nodes are deliberately
excluded and run only inside real workflow runs. So the chat-first port for
generation is NOT "project the node into chat"; it is either (a) a thin READ tool
that hands the model the assembled prompt so it drafts + calls `documents.draft`, or
(b) an igniter that starts a real `generate-from-template` workflow run from a chat
tool. (a) is preferred — it reuses the working `documents.draft` write and needs no
new durable state.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | Draft a document by describing intent (chat) | `documents.draft` tool | **RIDES** | leave |
| 2 | Read a document (chat) | `documents.get` tool | **RIDES** | leave |
| 3 | List templates (chat) | `documents.list-templates` tool | **RIDES** | leave |
| 4 | **Generate a document from a template (agentic)** | node exists; no igniter; UI previews a prompt then stops | **THEATER** | add `documents.get-template` read tool → agent drafts against assembled prompt → `documents.draft`; retire the node OR ignite via `startWorkflowRun` |
| 5 | **`document-author` agent (chat persona)** | allowlist = 3 node typeIds, all unresolvable in chat | **THEATER** | repoint allowlist to real chat tools (list-templates, get-template[new], draft, get); make it the reference in-chat consumer |
| 6 | **`document-reviewer` agent** | allowlist = `list-documents` node typeId, unresolvable | **THEATER** | repoint to a real read tool (`documents.get` / a `documents.list` chat tool) or remove pack |
| 7 | Template CRUD + starter catalog | REST + management UI | **PAGE-LEGIT** | keep; its only downstream consumer is the dead generate path — becomes real once #4 lands |
| 8 | Manual markdown authoring (write/split/preview) | `DocumentDetailPage` textarea + `ui/Markdown` | **PAGE-LEGIT** | keep (structural text edit, not describe-intent) |
| 9 | Version history | list under the editor | **PAGE-LEGIT** | keep |
| 10 | Export/render (pdf/slides/sheet/docx/epub/odt/latex) | deterministic render node | **PAGE-LEGIT** (node also RIDES — ignited by insights-suite) | keep |
| 11 | Status transition draft→approved→final | `<select>` (`DocumentDetailPage.tsx:209`); approve gated `host:members:manage` (`routes.ts:170-175`) | **ADAPTER** (watch) | single-actor lifecycle field, not a second approval engine — OK; if it ever needs multi-party sign-off, route through the approvals/reviews owner, not a new button |
| 12 | Documents+canvases browser | unified list | **PAGE-LEGIT** | keep |
| 13 | Assign document to a project | modal | **PAGE-LEGIT** | keep |
| 14 | Promote markdown → rich `canvas.document` | one-way, idempotent | **ADAPTER** | keep; rides canvas chassis |
| 15 | Ingest document → KB | composes `kbService` | **RIDES** | leave |
| 16 | Materialize canvas → document | `from-canvas` route | **ADAPTER** | keep |
| 17 | Delete canvas from Documents list | reuses `deleteCanvasForTenant` | **ADAPTER** | keep |
| 18 | Artifact Library / workbench (list/read/revisions/diff) | read-only projection | **PAGE-LEGIT** | keep |
| 19 | Rich-text canvas editor (`canvas.document`) | `registerCanvasEditorRoutes` | **RIDES** | leave |
| 20 | Canvas doc export (md/pdf/docx) | server-authoritative | **PAGE-LEGIT** | keep |
| 21 | DOCX import (mammoth → schema-parsed) | stateless convert | **ADAPTER** | keep |
| 22 | Public docs site (nav + page serve) | CMS pages + Publishing | **RIDES** | leave |
| 23 | Docs chat-RAG (KB sync on publish) | `onCmsPageLifecycle` sync | **RIDES** | leave |
| 24 | `docs.search` / `docs.get` MCP tools | expose-tool workflows (ADR 0087) | **RIDES** | leave |
| 25 | `llms.txt` | plain-text index | **PAGE-LEGIT** | keep (honest checkbox, `docsService.ts:65-79`) |
| 26 | Docs↔KB backfill/reconcile | authed admin sweep | **PAGE-LEGIT** | keep |

Counts: **RIDES 8 · ADAPTER 5 · PARALLEL 0 · THEATER 4 · PAGE-LEGIT 9.**

No hard PARALLEL: the doc stores are single-owner by construction (the markdown
`documents` store and the `canvas.document` store coexist under the ADR 0334
single-owner-per-store rule; `document-editor/feature.ts:6-8`), and every
canvas/KB/CMS touch instantiates the owner rather than shadowing it.

---

## Blockers (from scouting) — each with the honest alternative

- **B1. A side-effecting node cannot be a chat tool.** `generate-from-template`
  can't be projected into chat (`agentToolProvider.ts:35-48` restricts projection to
  pure-compute nodes). → *Alternative:* the chat-first path is the agent composing
  content itself and calling `documents.draft`; the template's only chat-relevant
  contribution is its assembled prompt + `outputSchema`. Ship a thin
  `documents.get-template` READ tool (returns the assembled `augmentedPrompt` +
  `outputSchema` — the `assemble` surface already computes both,
  `documents/surface.ts:44`), and the node/agent-pack machinery is no longer needed
  to make generation real.
- **B2. Repointing an agent allowlist to node typeIds silently yields a toothless
  agent** (no error — `compileAgentTools` just filters the entry out). → *Alternative:*
  agent allowlists in this app MUST reference `registerFeatureAgentTool` ids
  (`openwop:documents.*`), never workflow-node typeIds. This is a general lint gap
  worth a repo-wide check (filed, below), not a documents-only fix.
- **B3. The `document-author`/`document-reviewer` agents are loaded but not
  selectable** — no roster seed, no picker entry found. → *Alternative:* decide
  deliberately: either seed them as selectable chat agents (ADR 0058 "chat-drivability
  = agent + nodes") with real tools, or delete the packs. A loaded-but-unreachable
  agent is dead weight either way.

---

## Demolition list (with regression pins)

- **`NewDocumentModal` `assemble` step (`:476-498`) + `runAssemble` (`:197-204`).**
  It previews a prompt and dead-ends. After #4 lands, "generate a document from a
  template" is a chat action (Document Author agent → `documents.draft`). Demolish
  the prompt-preview UX; keep only template *management* (create/edit/delete/seed).
  Pin: a test asserting no `augmentedPrompt`-into-`<pre>` render path and no
  Sparkles "assemble"/"generate" affordance in the create modal.
- **`applyTemplate` empty-doc path (`:180-186`).** Creating a titled-but-empty
  document from a template is a non-feature masquerading as one. Fold into the chat
  generate flow. Pin: a test that "use template" does not produce a zero-content
  document.
- **`feature.documents.nodes.generate-from-template` node + `feature.documents.agents`
  pack** — if #4 uses the `documents.get-template` + `documents.draft` chat path
  (recommended), both become orphaned. Demolish or, if kept for a future
  scheduled/batch generation workflow, IGNITE it in the same PR with a real
  `startWorkflowRun` caller and a `workflow_run` turn — never leave it declared and
  dead. Pin: a coverage test asserting every declared node typeId has a run-creating
  caller OR is explicitly registered as a chat/MCP tool (the "no orphaned
  orchestration" invariant).

---

## New-code inventory (small)

1. `documents.get-template` chat tool (`registerFeatureAgentTool`, `agentTools.ts`) —
   returns assembled `augmentedPrompt` + `outputSchema` for a named template;
   `workspace:read` parity; ~40 lines, reuses `assemble`/`getTemplate`.
2. Repoint `feature.documents.agents` allowlists to the real `openwop:documents.*`
   tool ids (manifest edit, no code).
3. (If keeping the agents selectable) a roster seed entry per ADR 0058 — reuse the
   existing agent-seed path, no new mechanism.
4. Regression pins listed above.
5. Filed platform TODO: an agent-pack lint that rejects a `toolAllowlist` entry that
   is neither a `builtinAgentToolIds()` id nor a projectable node — this bug class
   (allowlisting an unresolvable node typeId) is invisible today.

Everything else (draft/get/list-templates tools, canvas editor, docs composition,
render, artifact projection) is already correct and untouched.

---

## Phased plan (gated on real gates)

- **Phase 1 — read seam.** Add `documents.get-template` chat tool + tests; no
  behavior removed yet. Gate: `npm run ci`, `/code-review`.
- **Phase 2 — make the agent real.** Repoint `document-author` allowlist to
  {list-templates, get-template, draft, get}; decide + wire selectability (or delete
  `document-reviewer`). Verify in the ONE chat that "draft me an SOW from the X
  template" resolves tools and produces a real draft. Gate: `/code-review`, manual
  chat smoke.
- **Phase 3 — demolish the theater UI.** Remove the `assemble`-preview + empty
  `applyTemplate` paths from `NewDocumentModal`; keep template management; add the
  regression pins. Gate: frontend `npm run build`, `/ux-review`.
- **Phase 4 — retire or ignite the node.** Either delete
  `generate-from-template` + `feature.documents.agents` (if Phase 2 uses the chat
  path) or ship a real igniter. File the allowlist-lint TODO. Gate: `npm run ci`,
  `/grade-code`.

Compliance seam (the read tool) first; demolition only after the chat path works.

---

## Deferred honestly

- **Docs search is base-locale only** (`docs/surface.ts:28-30`, `:60-61`) — the
  docs→KB sync embeds base data with no locale overlays; a localized docs-RAG is a
  separate program, stated in-code, not faked.
- **`canvas.document` share links / read-only shared view** are deferred to ADR 0334
  Phase 7/8 (`document-editor/routes.ts:53-55`) — no share ResourceType yet; honest
  absence, not a broken button.
- **`llms.txt`** ships as an acknowledged no-consumer checkbox
  (`docsService.ts:65-71`) — kept because trivial, labeled as such.
