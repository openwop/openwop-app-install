# ADR 0084 — Research Notebooks (a NotebookLM-style research workspace as a project facet)

**Status:** **implemented** (Phase 1 + Phase 2 `ctx.features.notebooks` read surface + grounded chat + Context Levels (Full/Excluded) implemented; **Phase 3** — `feature.notebooks.nodes` READ nodes `ask` + `search` + the Transformations WRITE node `write-transformation` shipped; **Transformations T1** — `summarize-source` + the **Summary** context level (the `notebooks.summarize` built-in workflow + the summary store + the generic `extraContext` binding seam); **Transformations T2** — `apply-transformation` (the `notebooks.transform` built-in workflow: `core.ai.chatCompletion` → `feature.notebooks.nodes.write-transformation` → a **Document** owned by `project:<notebookId>`; a const transformation catalog = config, NOT a parallel store; output lands in Documents, the single owner of stored artifacts, so the notebooks surface stays read-only); **Phase 4** — `feature.notebooks.agents` Research Analyst shipped + the notebook chat repointed to it; **Phase 5 / Transformations T3** — the "AI-chat envelope" path realized via **agent + nodes** (the Research Analyst's allowlist gains `write-transformation` so the chat can author + persist a transformation Document) — NO bespoke envelope kind / acceptor seam, the priority-matrix precedent. Only the optional `ingest-source` / chat-`addSource` write paths remain deliberately deferred — ingest stays a UI action; chat-driven ingest of arbitrary content is an injection surface. **UPDATE (ADR 0085):** the `ingest-source` node + the narrow `ctx.features.notebooks.ingestSource` surface write are now IMPLEMENTED, used by the audio/video + YouTube source-ingest workflows the upload ROUTE enqueues (RBAC `workspace:write`). The injection-surface guard still holds: `ingest-source` is wired ONLY into those built-in workflows and is deliberately NOT in the Research Analyst agent's allowlist, so chat-driven ingest of arbitrary content stays closed.)
**Date:** 2026-06-20

> ## ✏️ Surfacing correction (2026-06-22) — notebooks live INSIDE projects
> The original surfacing made a notebook a standalone top-level destination
> (`/notebooks`) with its own `facet:'notebook'` flavor — a "standalone feature".
> The intent was project-INTEGRATED. Corrected: a notebook's source surface is now a
> **"Sources" tab on `ProjectDetailPage`** (sources w/ context levels, audio/YouTube
> ingest, transformations, grounded Ask), available to **any project** — not a
> separate page. Backend: `getNotebook`/`listNotebooks` resolve any project with a
> bound KB collection (the `facet:'notebook'` guard is dropped); a new idempotent
> `POST …/notebooks/:id/ensure` provisions the collection+binding on tab-open. The
> standalone `/notebooks` nav is withdrawn (`NotebookWorkspace` is reused embedded
> via `ProjectSourcesPanel`). The `facet` field stays additive/back-compat but is no
> longer required. RBAC (`resolveProjectAccess`) + org-visibility are unchanged.

**Toggle:** `notebooks` · default **OFF** · `bucketUnit: tenant` (a shared B2B research surface per ADR 0015 — every user in a workspace gets the same variant) — now gates the project **Sources tab** visibility, not a standalone page.
**Surface:** host-extension `/v1/host/openwop-app/notebooks/*` (non-normative) + `ctx.notebooks` workflow surface
**Depends on / composes:**
- ADR 0001 (feature-package architecture)
- ADR 0045 / 0046 / 0054 (the Subject model + the `project` subject + collaborative project — **a notebook IS a project**)
- ADR 0011 (Knowledge Base / RAG — sources = an org-scoped KB collection; the vector/ingest/retrieve substrate)
- ADR 0041 (subject memory — notes = the `project:<id>` memory scope)
- ADR 0042 / 0038 (knowledge binding + dispatch-composed retrieval)
- ADR 0043 / 0073 (the one chat model + `EmbeddedChatPanel`)
- ADR 0053 (Documents & Templates — transformations = template runs producing notes/documents)
- ADR 0072 (AI workflow authoring) · ADR 0006 (RBAC) · ADR 0007 (Media Library — source bytes)
**RFC verdict:** **host-extension, NO new RFC.** Every capability rides already-**implemented** ADRs and already-**Accepted** RFCs (KB/RAG over the RFC 0018 vector surface; chat over RFC 0005). Nothing new touches the wire.

> **Origin.** This ADR ports the *product design* of [`lfnovo/open-notebook`](https://github.com/lfnovo/open-notebook) (an open-source Google-NotebookLM alternative) — **not its code** (Python/FastAPI/LangGraph/SurrealDB, non-portable). The capability intent (notebooks → sources → notes → chat/ask → transformations → search) is re-expressed on this app's seams. See `/tmp/open-notebook-PRD-and-port-analysis.md` for the full source PRD + capability map.

---

## Context — boundaries audit first (MANDATORY, per the scope rule)

The PRD's author (NotebookLM's model) treats *notebook, source, note, chat-session, transformation* as five new top-level entities with their own stores. **The audit overturns that: every one of them already has a single owner in this corpus.** Re-implementing any as a parallel store would violate the `no-parallel-architecture` law (a feature that *is* a primitive MUST instantiate it, not shadow it).

**Namespace check** — `grep -rni "notebook" backend/typescript/src frontend/react/src`: **zero** route/feature-id/service collisions (one incidental i18n word in `profiles/i18n`). `notebooks` is a clean toggle id and route prefix.

**Concept-ownership map (compose these; do NOT fork them):**

| PRD entity / capability | Single owner already in repo | How a notebook reuses it |
|---|---|---|
| **Notebook** (isolated research container owning sources/notes/chat) | `project` Subject — `host/subject.ts` + `features/projects/` (ADR 0046), collaborative variant ADR 0054 | A notebook **is a `kind:'project'` Subject** with a `facet:'notebook'` preset. It inherits — for free — org-scoping, a board, memory, knowledge binding, group chat, members, schedules, and assigned workflows. No new container entity. |
| **Source** (ingested doc, chunk→embed→index, retrieval w/ citations) | `kb` feature — `features/kb/` + `host/knowledgeSurface.ts` over the RFC 0018 `ctx.db.vector` surface + `aiProviders/localEmbedding.ts` (ADR 0011) | Each notebook owns **one org-scoped KB collection** (`collectionId = notebook:<projectId>`). "Add source" = KB ingest; the resulting `KnowledgeDocument` is **bound to the notebook Subject** via the ADR 0042 binding seam. Retrieval + citations are KB's. |
| **Note** (mutable knowledge output, searchable) | `subjectMemory` — `host/subjectMemory.ts`, `project:<id>` scope (ADR 0041) | Notes = durable memory notes (`kind:'note'`) in the notebook's project scope. Manual notes, saved chat answers, and transformation outputs all land here. |
| **Chat session** (per-notebook, persistent, citations) | The one chat primitive — RFC 0005 / ADR 0043, embedded via `chat/EmbeddedChatPanel` (ADR 0073) | The notebook's chat = a conversation owned by the project Subject (ADR 0054 project chat), driven by the **Research Analyst** agent (below). **No second chat panel.** |
| **Transformation** (reusable prompt template → structured output) | Documents & Templates — `features/documents/` (ADR 0053) bind prompt→artifact schema | A transformation = a template run via `ctx.callAI`; its output is written as a note (memory) or a versioned document. |
| **Ask** (auto multi-query RAG + synthesis) | KB semantic search (`ctx.kb.search`) + dispatch composition (ADR 0038/0042) + the agent loop | "Ask" = a turn of the Research Analyst agent: generate-queries → `ctx.kb.search` (multi-query) → synthesize-with-citations. The ADR 0058/0048 "chat-drivability = agent + nodes" pattern. |
| **Search** (text + vector) | `ctx.db.vector` (RFC 0018) + KB text/semantic search | A notebook search surface scoped to the notebook's collection + its notes. |
| **Multi-modal bytes** (PDF/img) | Media Library (ADR 0007) | Source bytes for non-text uploads; **audio/video deferred to ADR 0085**. |

**The one architecture-imposed correction (same one ADR 0011 hit).** NotebookLM/Open Notebook run transformations and "Ask" as **synchronous** request/response. In this corpus that is **impossible**: provider embeddings **and** LLM generation are `ctx`-only — reachable only inside a workflow run (they need a per-node `AdapterScope`: runId/nodeId/attempt/secretResolver/policyResolver), never from synchronous feature-route code (ADR 0011 § "One architecture-imposed constraint"). **Therefore every AI step here is a workflow run**, surfaced asynchronously (chat stream, a note appearing, a document version). REST routes orchestrate runs; they never call a model directly. This is recorded as a PRD-vs-architecture correction, not a limitation.

**Net:** the notebook feature is ~90% *assembly* of existing accepted seams. The genuinely new code is a thin facet over `project`, one KB collection per notebook, a Research Analyst agent pack, a transformations node pack, the `ctx.notebooks` read surface, and the three-panel UI.

---

## Decision

Ship a **`notebooks` feature-package** (ADR 0001) that presents an existing `project` Subject in NotebookLM's three-panel research workspace (**Sources | Notes | Chat**), composing KB, subject memory, knowledge binding, the chat primitive, and Documents/Templates. **A notebook is not a new entity — it is a project with `facet:'notebook'`.**

### Data model (almost entirely derived)

```
Notebook                       // NOT a new record — a VIEW over a project Subject
  = Project { id, tenantId, orgId, name, facet:'notebook', workflows[] }   // ADR 0046; `facet` is an additive optional field
  + collectionId: `notebook:<projectId>`     // its own org-scoped KB collection (ADR 0011)
  + sources    -> KnowledgeDocument[]        // KB docs bound to the Subject (ADR 0042 bindings)
  + notes      -> SubjectMemoryNote[]        // project:<id> memory, kind:'note' (ADR 0041)
  + chat       -> Conversation               // project chat (ADR 0054), Research Analyst agent
  + transforms -> Template[] runs            // ADR 0053 templates → note/document
```

- **`facet`** is the only schema touch: an additive optional field on the `project` record (default `undefined` = a plain project; `'notebook'` = surfaced in the notebooks UI + gets a KB collection on create). No migration; existing projects are unaffected. *(Correction note vs the PRD: a notebook does not get its own table.)*
- **Per-source context level (Full / Summary / Excluded)** — the NotebookLM signature UX — is modeled **host-side as a retrieval filter**, NOT a wire field: stored per `(notebookId, sourceId)` in the notebook's config, read when composing the agent's retrieval. *Full* injects the bound document's full text; *Summary* injects a cached AI summary (a transformation insight, generated lazily on first use); *Excluded* omits it. **Because it never travels on the run/dispatch envelope, no RFC is required** (open question OQ-3 records the alternative).

### RBAC & isolation

Rides the project Subject's org-scoping (ADR 0046 § read-privacy): every route gates on the caller's RBAC scope **in the notebook's org** — `workspace:read` to view, `workspace:write` to mutate — uniform 404 on insufficient scope (no existence leak). The KB collection is org-scoped (ADR 0011). The notebook is never an authenticated principal (ADR 0045 boundary). Delete cascades the project's board + memory + the KB collection + bindings.

---

## Phased plan

**Phase 1 — Backend feature-package + REST.** `src/features/notebooks/` (`feature.ts` toggle `notebooks`/OFF/`tenant`; `notebooksService.ts`; `routes.ts` under `/v1/host/openwop-app/notebooks/*`, all via `featureRoute` → `authorizeOrgScope` + `requireFeatureEnabled`). Routes: notebook CRUD (creates the backing project + KB collection), `…/:id/sources` (ingest → KB → bind), `…/:id/sources/:sid/context-level` (**built** — see "Context Levels"), `…/:id/notes` (memory CRUD), `…/:id/search`. No model calls here — ingest/transform/ask **enqueue runs**.

**Phase 2 — `ctx.features.notebooks` workflow surface (ADR 0014). BUILT.** Read-only typed surface behind the same `notebooks` toggle (gated at the `registerFeatureSurface` seam), advertised at `/.well-known/openwop` as `host.sample.notebooks` AUTOMATICALLY when enabled (via `registeredFeatureSurfaceIds()`, no discovery.ts edit): `listSources({notebookId})`, `getSource({notebookId, sourceId})`, `listNotes({notebookId})`, `searchNotebook({notebookId, query, topK?})`, `getContextLevels({notebookId})`. Modeled exactly on `features/strategy/surface.ts` — each method COMPOSES the existing `notebooksService` functions (no new logic). A run is **tenant-trusted** (a `BundleScope` carries no caller subject), so the surface applies the strategy-style **org-visibility filter**: it serves a notebook ONLY when its backing project is `facet:'notebook'` AND `(visibility ?? 'org') === 'org'` — a `visibility:'private'` (member-scoped) notebook is INVISIBLE (exactly как strategy hides a user-scoped private draft). Write-back stays a route/service act (the surface is read-only). Host-internal, no RFC. Replay-safe via the observable-result cache, like `ctx.kb`. (`backend/.../features/notebooks/surface.ts` + `feature.ts surface:` + `test/notebooks-surface.test.ts`.)

**Phase 3 — Node pack `feature.notebooks.nodes`** (`requiredPacks`). **PARTIAL — READ nodes shipped.** The pack ships two READ-ONLY nodes over the Phase-2 `ctx.features.notebooks` surface, modeled exactly on `feature.kb.nodes` (the `rag`/`search` precedent), both `role: "action"` (recorded outputs ⇒ replay/fork read the cache):

- **`feature.notebooks.nodes.ask`** — "Notebook Ask (grounded retrieve)". Multi-query grounded retrieval: if `queries[]` is supplied it fans out one `ctx.features.notebooks.ask` per query and MERGES (concat `augmentedPrompt` blocks, dedupe `citations` by `documentId`, concat `contexts`); else a single `query`. Returns `{ augmentedPrompt, citations, contexts }`. **Generation is run-scoped downstream** (feed `augmentedPrompt` to a `callPrompt`/agent), exactly the `feature.kb.nodes.rag` stance — the pack retrieves + formats, it does not synthesize an answer.
- **`feature.notebooks.nodes.search`** — "Notebook Search". Raw ranked hits via `ctx.features.notebooks.searchNotebook` → `{ hits }`.

**Fencing + Full/Excluded context-level filtering stay in the HOST, never reimplemented in the pack.** The surface's `ask` derives `augmentedPrompt` from the Phase-2 host helper `composeKnowledgeForSubject(tenantId, projectSubject(notebookId), query, { topK })` — which applies the same trusted-cite / untrusted-fence treatment as live dispatch AND the binding's `excludeDocumentIds` (the per-source `excluded` level); `citations`/`contexts` come from `searchNotebook`, already excluded-filtered by the service. The pack only fans-out/merges. (`packs/feature.notebooks.nodes/{pack.json,index.mjs}` + the new surface `ask` method in `features/notebooks/surface.ts` + `feature.ts requiredPacks` + `test/notebooks-nodes.test.ts`.)

**Transformations T1 — `summarize-source` (BUILT, see Status):** the `notebooks.summarize` built-in workflow (`read-source` → `core.ai.chatCompletion` → `store-summary`) writes the summary to the notebook summary store, un-gating the **Summary** context level. The summary store is the one justified surface write; the notebooks surface stays otherwise read-only.

**Transformations T2 — `apply-transformation` (BUILT).** A reusable transformation TEMPLATE (Summary / Key Concepts / Methodology / Takeaways / Open Questions) is applied to a source by an LLM run that writes the result as a **Document** owned by `project:<notebookId>`:

- **Catalog = const config, not a store** (`features/notebooks/transformations.ts`): `NOTEBOOK_TRANSFORMATIONS` pairs each template's fixed `systemPrompt` with its output Document `kind` (`notebook-summary` / `notebook-key-concepts` / `notebook-methodology` / `notebook-takeaways` / `notebook-questions`). There is NO transformation store — the catalog only names the prompt + the output kind.
- **Workflow `notebooks.transform`** (`features/notebooks/transformWorkflow.ts`, in `feature.ts builtinWorkflows`): a 2-node graph mirroring `summarizeWorkflow` — `generate` (`core.ai.chatCompletion`, reads the full `messages` array the route supplies as a run variable) → edge `generate.content → write.content` → `write` (`feature.notebooks.nodes.write-transformation`, with `orgId`/`title`/`kind`/`ownerSubject` from run variables). Replay-safe: the LLM node is Layer-2-cached and the write is idempotency-keyed off the run.
- **Write node `feature.notebooks.nodes.write-transformation`** (the strategy `create-board-memo` precedent, ADR 0080): `ensureDocuments(ctx)` then `ctx.features.documents.createDocument({ orgId, title, kind, format:'markdown', ownerSubject })` + `addVersion({ content, idempotencyKey })`. The output lands in **Documents** (the single owner of stored artifacts, ADR 0053), keeping the notebooks surface read-only.
- **Routes:** `POST .../sources/:sid/transform {templateId}` (write-gated; templateId ∈ catalog else 400; reads the source text/title via `kbService.getDocument`, builds `messages = [{system: tpl.systemPrompt},{user: sourceText}]`, enqueues the run) → `{runId}`; `GET .../transformations` (read-gated; `documentsService.listDocuments(by ownerSubject=project:<id>)` filtered to the 5 notebook-* kinds); `GET .../transformations/templates` (the catalog `[{id,label}]`). Listing is a **cross-feature read** of `documentsService.listDocuments` — precedented (`features/sharing` imports `publicDocumentView`, `features/priority-matrix` imports `createDocument`/`addVersion` from `documents/documentsService`), and Documents is a host-extension feature (not the wire), so host-internal — no RFC.

**Transformations T3 — chat-driven actions (BUILT):** realized via the agent+nodes path (see "Phase 5" above) — `write-transformation` added to the Research Analyst's allowlist so the chat can author + persist a transformation Document. No bespoke envelope kind. Host-internal, no RFC.

**STILL DEFERRED** (NOT stubbed/faked here): the write/AI node `notebooks.ingest-source` (compose KB ingest + bind) and chat-driven `addSource`. `ingest-source` needs a KB write path the read-only notebooks surface deliberately does not expose; it will follow the same precedent (write to an existing write surface). Chat-`addSource` is an injection surface — ingest stays a deliberate UI action. Host-internal, no RFC.

**Phase 4 — Agent pack `feature.notebooks.agents`** (chat-drivability = agent + nodes, ADR 0058/0048). **BUILT.** One agent: **Notebook Research Analyst** (`feature.notebooks.agents.researcher`, persona `RESEARCH`, modelClass `research`) — a manifest agent scoped to a single notebook, tool-allowlisted to `feature.notebooks.nodes.ask` + `feature.notebooks.nodes.search` (over `ctx.features.notebooks` — the notebook surface tools, NOT the kb nodes). It honors per-source context levels (Full/Excluded, inherited from the host surface), cites sources inline, treats fenced source text as data (anti-prompt-injection), and never invents sources. It is the **notebooks-surface analog of `feature.kb.agents`** (distinct tooling; manifest **DATA**, not source — the `agent-capability-core-not-named` law is honored: NO source-level capability was added, only a manifest agent + a divergent system prompt over the existing notebooks node pack).

The notebook chat is **repointed off the reused KB Researcher to the notebooks Research Analyst**: `routes.ts` `RESEARCHER_AGENT_ID = 'feature.notebooks.agents.researcher'` is the participant `ensureNotebookChat` seeds, and `feature.ts` `requiredPacks` is now `feature.notebooks.nodes` + `feature.notebooks.agents` (the `feature.kb.agents` + `feature.kb.nodes` deps are dropped — notebooks ships its own node + agent packs). **Phase-2 owner-subject auto-grounding is agent-agnostic** (it composes the conversation's `ownerSubject` knowledge into whichever agent answers), so swapping the seeded agent **keeps grounding** and **adds** the agentic ask/search tools. Host-internal, no RFC (a manifest agent over an existing surface; rides RFC 0003 agents[] + RFC 0002 §A14 allowlist). (`packs/feature.notebooks.agents/{pack.json,prompts/notebook-researcher.md}` + `feature.ts requiredPacks` + `routes.ts RESEARCHER_AGENT_ID` + `test/notebooks-chat.test.ts`.)

**Phase 5 — AI-chat actions (BUILT — realized via agent + nodes, NOT bespoke envelope kinds).** *Correction to the original framing:* this host has **no per-feature envelope-acceptor seam** — "chat-drivability = agent + nodes" IS the AI-chat-envelope path (the `priority-matrix/feature.ts` precedent: `supportedEnvelopes`/`envelopeAcceptor.ts` covers only the universal + media + `ui.a2ui-surface` kinds; vendor/feature actions ride the agent's tools). So adding `notebook.addSource`/`applyTransformation`/`ask` envelope KINDS would be a **parallel** of the established pattern. Instead, the Notebook Research Analyst (Phase 4) is the chat-action surface: `ask`/`search` already give chat-driven **retrieval**, and `write-transformation` is added to its allowlist (T3) so the chat can **author + persist** a transformation Document (the strategy `create-board-memo` precedent — the agent authors prose, the node persists to Documents with `ownerSubject=project:<notebookId>`). `createDocument`'s `resolveOwnerSubject` enforces the derived-org IDOR guard. `read-source`/`store-summary` stay **internal** to the `notebooks.summarize` workflow (an agent must not ad-hoc write the summary store that gates the Summary level — summarize is the explicit UI button). `addSource` via chat stays **deferred** (ingest is a deliberate UI action; chat-ingest of arbitrary content is an injection surface).

**Phase 6 — Frontend `src/features/notebooks/`.** `notebooksClient.ts` + `NotebookListPage` + `NotebookWorkspacePage` (three-panel: Sources / Notes / Chat) + `routes.tsx` (`FrontendFeature`, `featureId:'notebooks'`); nav via the menu registry (`GROUP_ORDER`). Reuses `EmbeddedChatPanel`, KB search components, `ui/` cohesion (`.surface-card`/`.chip`/`<StateCard>`), Lucide icons, i18n keys (ADR 0065). Sources panel shows the Full/Summary/Excluded selector + token indicator (the NotebookLM signature UX).

**Phase 7 — Search + `/.well-known` + tests.** Unified text/semantic toggle over the notebook's collection + notes; advertise `ctx.notebooks` only when enabled; backend `test/notebooks.test.ts` (org-scope/IDOR, run-orchestration, context-level filter) + a frontend smoke.

---

## Phase 2 — grounded chat (implemented)

Phase 1 shipped the notebook surface with the chat targeting the global, *ungrounded* KB Researcher via `EmbeddedChatPanel` (it answered as a general assistant — the sources never reached the prompt). Phase 2 grounds the conversational chat in the notebook's KB sources, with ZERO parallel chat machinery — it rides the **project group conversation** precedent (ADR 0054 D3 / ProjectChatTab).

**The seam.** A notebook IS a `project` Subject; its KB collection is already bound to `project:<id>` via `setSubjectKnowledge`. The conversational chat is the project's server-owned group conversation, deep-linked into the main `/chat` surface (`/chat?conversation=<id>`), whose turns run through `host/conversationExchange.ts`. The notebook's `POST /:id/chat` route reuses the SAME host primitives the projects `/chat` handler uses — `subjectConversationId` + `ensureConversationMeta` + `addParticipant` — with `ownerSubject` **SERVER-SET** to `projectSubject(id)` (never client-supplied) and the Research Analyst seeded as a conversation participant (the grounded analyst in the room). (The Researcher is a *manifest* pack agent, not a roster entry, so it rides the conversation participant list — which the chat dispatch resolves via the agent registry — rather than the project member API, which validates roster agents.)

> **Correction note (Phase 4).** Phase 2 originally seeded the *reused* KB Researcher (`feature.kb.agents.researcher`) here — a notebook's sources are a KB collection, so the KB Researcher was a correct grounded analyst. Phase 4 ships the notebooks-surface-native **Notebook Research Analyst** (`feature.notebooks.agents.researcher`) and repoints the seeded participant to it. Because the Phase-2 auto-grounding (below) keys off the conversation's `ownerSubject`, not the agent identity, grounding is **unchanged** by the swap — the new agent additionally carries the notebooks ask/search tools.

**The ONE core change.** `conversationExchange` now composes the conversation's `ownerSubject` knowledge into the answering agent's prompt:

- **Authorized.** Before composing, it resolves the **exchanging caller's** access to the owner subject — `resolveSubjectAccess(tenantId, convMeta.ownerSubject, run.metadata.actingUserId)`. Access `'none'` ⇒ compose nothing (skip silently — no leak). This closes the IDOR: a non-member who somehow reaches the gate can't pull the subject's knowledge into a reply. `null` (subject not membership-scoped) ⇒ the conversation's own visibility gate governed entry ⇒ compose.
- **Shared composition.** Knowledge is composed via a new shared helper `composeKnowledgeForSubject(tenantId, subject, query, {topK})` in `host/agentKnowledgeComposition.ts`, which wraps the SAME `composeAgentKnowledgeContext` primitive live agent dispatch uses — so the trusted-cite / untrusted-**fence** treatment can never drift between the two flows. Untrusted notebook chunks (sources are ingested `contentTrust:'untrusted'`) stay inside the BEGIN/END UNTRUSTED CONTENT fence — never agent-trusted.
- **Self-gating blast radius.** `composeKnowledgeForSubject` returns `''` when the subject has no bound collections, so the change affects ONLY conversations whose `ownerSubject` has bound knowledge. Project group chats are included **by design** (a project with bound KB now grounds its chat too — the same desirable behavior).
- **Merged** into the prompt via a new optional `knowledgeBlock` param on `composeAgentSystemPrompt` (distinct from the board-context `injectedContextBlock`; this one is live-retrieved per turn and carries its own fence).
- **Best-effort.** Composition is wrapped in try/catch — a retrieval failure logs a warn and never breaks the turn.

**Replay property.** Live retrieval (drift on `:fork`) is **accepted**, consistent with `agentDispatch` — no recording mechanism is added.

**Tests.** `test/notebooks-chat.test.ts`: `POST /:id/chat` returns a conversationId whose meta `ownerSubject === project:<notebookId>` (idempotent re-open), a foreign-tenant caller is denied (uniform 404 — the IDOR guard), and a unit assertion that `composeKnowledgeForSubject` returns a fenced block carrying a bound source's text and `''` for an unbound subject.

**Frontend.** `NotebooksPage` replaces the inline ungrounded `EmbeddedChatPanel` with a launch panel (modeled on `ProjectChatTab`) that calls `ensureNotebookChat(id)` then deep-links `/chat?conversation=<id>`; the Phase-1 "general assistant" caveat copy is removed (the chat is now actually grounded). i18n updated in all four locales.

---

## Context Levels (implemented)

Each notebook source has a per-source **context level** — `full` (the default; in the grounded chat + Ask) or `excluded` (omitted from both). `summary` was originally **reserved-but-disabled** (the route rejected it with a 400, the FE disabled it) pending real LLM summaries.

> **Correction (Transformations T1 — implemented).** `summary` is now a real, selectable level once a source has been summarized. It is **never faked**: the summary comes from a real `notebooks.summarize` run (see "Transformations T1" below). When a source is at `summary`, its raw chunks are **excluded** from context and the stored short summary is **injected instead** (fenced as untrusted). The route + service now ALLOW `summary` only when a stored summary exists (else a 400 "summarize the source first"); the FE enables the Summary button only when `hasSummary`.

**Generic binding seam — no notebook leak.** The exclusion rides a generic field on the shared knowledge binding: `SubjectKnowledgeBinding.retrieval.excludeDocumentIds?: string[]` in `host/agentKnowledgeComposition.ts`. It means simply "this subject's binding excludes these documents" — the seam knows nothing of notebooks. In `resolveSubjectKnowledgeRetrieve`, the KB chunk loop skips a chunk when `excludeDocumentIds` includes `chunk.assetId` (kbService sets `assetId = documentId`), **before** `out.push`. Because both the grounded chat (`composeKnowledgeForSubject → resolveSubjectKnowledgeRetrieve`) and every binding consumer share this path, the exclusion is honored everywhere with zero notebook leakage. Opt-in blast radius: a binding that never sets `excludeDocumentIds` is wholly unaffected.

**Level store is the source of truth; the binding is a DERIVED projection.** A per-source level is stored in a new `DurableCollection` (`notebook-source-level`, keyed `${tenantId}:${notebookId}:${sourceId}`; absent row ⇒ `full`). `setSourceContextLevel` validates the notebook + that `sid` is a real document in its collection (unknown sid ⇒ uniform 404), writes the level row, then **recomputes** the notebook's excluded documentIds (all sources where `level==='excluded'`) and persists them into the subject binding via `setSubjectKnowledge(..., { collectionIds:[existing], retrieval:{ ...existing, excludeDocumentIds } })` — **preserving** the existing `collectionIds` + the rest of `retrieval`. Only `excluded` excludes; `summary` is treated like `full` for the projection (it stays in-context until real summaries ship). `listSources` surfaces each source's `contextLevel`; `searchNotebook` (the Ask path) post-filters hits by the same excluded set, so Ask and chat agree without teaching kbService about levels.

**Route.** `PUT /v1/host/openwop-app/notebooks/:id/sources/:sid/context-level` body `{level}`, gated `requireNotebook(req, 'workspace:write')`; `level ∈ {full, excluded}` (else 400; `summary` ⇒ a clear 400), unknown sid ⇒ 404, cross-tenant ⇒ uniform 404. Returns the updated source projection.

**Frontend.** The Sources panel renders a compact segmented Full / Summary / Excluded control per source (Summary disabled with a "available with transformations" hint), an approximate per-source token indicator (`chunkCount × ~250`, a documented heuristic) and a running **context-budget** total for the non-excluded sources near the panel header; excluded sources are visually de-emphasized. `ui/` tokens only; i18n keys in all four locales.

**Replay property.** Live + consistent: exclusion is applied at retrieval time from the current level store, so a `:fork` reflects the levels as they are at replay — the same accepted live-retrieval property as the grounded chat (no recording mechanism added).

---

## Transformations T1 — summarize-source + the Summary context level (implemented)

T1 completes the shipped-but-disabled **Summary** level. A source can be **SUMMARIZED** (LLM, run-scoped) and set to `summary`; the grounded chat + Ask then inject the short summary **instead of** the source's full chunks.

**The summarize built-in workflow (`notebooks.summarize`) — a real run, not a route-side LLM call.** Mirrors the insights-suite `builtinWorkflows` precedent (`features/insights-suite/{feature.ts,metaWorkflows.ts}`): a `WorkflowDefinition` shipped via `notebooksFeature.builtinWorkflows`, resolved in catalog source A. A **3-node graph** (the pack node CAN call `ctx.callAI`, but the work is split so the LLM call is its own replay-cached node — the architect-preferred shape):

```
read (feature.notebooks.nodes.read-source)        reads the source's FULL text via
   │  out: { empty, messages }                     ctx.features.notebooks.getSourceText
   │  edge read.messages → generate.messages        → a chatCompletion messages payload
   ▼
generate (core.ai.chatCompletion)                  BYOK LLM (config: provider 'anthropic',
   │  out: { content }                              model 'claude-sonnet-4-6', systemPrompt
   │  edge generate.content → store.summary          "Summarize … in 3-5 sentences; plain text")
   ▼
store (feature.notebooks.nodes.store-summary)      persists the summary via the ONE justified
                                                    surface write ctx.features.notebooks.setSourceSummary
```

`notebookId`/`sourceId` are workflow **variables** seeded from the run inputs and threaded into the two notebook nodes via `{type:'variable'}` input declarations (the anniversary-draft `workdayResource` precedent). The chatCompletion `messages` come from `read`'s output port; the summary from `generate`'s `content` output port (the executor `EdgeDef.sourceOutput`/`targetInput` port model — verified in `executor/scheduler.ts buildNodeInputs`). **Replay-safe**: the LLM call is a `side-effectful` node cached in the Layer-2 invocation log; the two notebook nodes are recorded action reads/writes — a `:fork` replays the cached summary. The chatCompletion node fails closed at execute without BYOK (exactly like the insights workflows), so the definition loads + validates without credentials.

**The summary store (the one justified write).** A new `DurableCollection` `notebook-source-summary` (keyed `${tenantId}:${notebookId}:${sourceId}` → `{ tenantId, notebookId, sourceId, summary, createdAt }`). The notebooks **surface stays read-only except for one narrow write** — `setSourceSummary` — used only by the store-summary node; it rides the same `resolveOrgVisibleNotebook` org-visibility gate as every read. The service also adds `getSourceText` (the read the read-source node feeds the LLM) and `getSourceSummary` (the presence check that un-gates the level).

**The generic `extraContext` binding seam — no notebook leak.** The summary injection rides a generic field on the shared binding: `SubjectKnowledgeBinding.retrieval.extraContext?: Array<{ title?; content; contentTrust? }>` in `host/agentKnowledgeComposition.ts`. It means simply "this subject's binding always contributes these extra context items" — the seam knows nothing of notebooks or summaries. In `resolveSubjectKnowledgeRetrieve`, after the KB-chunk loop, each `extraContext` item is APPENDED to `out` as a chunk-like entry (`kind:'kb'`, `contentTrust` from the item) so it flows through the **same** `composeAgentKnowledgeContext` fence path — an `untrusted` summary stays fenced (data-only, never an instruction). Opt-in: a binding that never sets `extraContext` is a no-op.

**The derived projection now handles `summary`.** Extending the Context-Levels recompute: on any level **or** summary write, `recomputeBindingProjection` derives from the level store + the summary store and persists BOTH `excludeDocumentIds` + `extraContext` onto the binding (preserving `collectionIds`). Per source: `excluded` → `excludeDocumentIds`; `summary` (only if a stored summary exists) → `excludeDocumentIds` (drop its raw chunks) **plus** an `extraContext` item `{ title: source title, content: the stored summary, contentTrust:'untrusted' }`; `full` → nothing. A `summary` level with no stored summary is defensively treated like `full` (never drop chunks without a replacement). Because `summary` sources are in `excludeDocumentIds`, the existing binding-based search filter already drops their chunks from Ask too.

**Trigger route.** `POST /v1/host/openwop-app/notebooks/:id/sources/:sid/summarize` (gated `requireNotebook(req,'workspace:write')`; validates `sid` is a real document in the collection ⇒ 404; cross-tenant ⇒ uniform 404) → `startWorkflowRun({ storage: deps.storage, hostSuite: deps.hostSuite }, { tenantId, workflowId:'notebooks.summarize', inputs:{ notebookId, sourceId } })` → `202 { runId }`. `PUT .../context-level` now allows `summary` **only when a stored summary exists** (else 400).

**Frontend.** The Sources panel gains a per-source **Summarize** action (calls `summarizeSource` → toast → refresh to pick up `hasSummary`; the run is async, so it polls `listSources` after a beat). The **Summary** segmented button is enabled **only when `hasSummary`** (else disabled with the existing hint); selecting it calls the existing context-level route with `'summary'`. `listSources` now returns each source's `hasSummary`. i18n in all four locales. `ui/` tokens only.

Host-internal — no wire change, **no RFC** (run orchestration via the existing `startWorkflowRun` + `core.ai.chatCompletion`; the binding seam is host-owned).

---

## Post-merge review fixes (code-review)

Three LOW findings from the consolidated `/code-review` were addressed:

1. **Transform reads the source IN-RUN (no inlined text).** `notebooks.transform` was a 2-node graph where the route inlined the full source text into `run.inputs.messages`. It is now a 3-node graph (`read-source → generate → write`) mirroring `notebooks.summarize`: the `read-source` node fetches the source text at run time and prepends the template's `systemPrompt` (carried as a small variable), so the run record stays small for large sources and the two transformation workflows are consistent.
2. **Concurrent context-level writes converge.** The derived-binding-projection recompute (`getSubjectKnowledge → derive → setSubjectKnowledge`) is now **serialized per `(tenant, notebook)`** via an in-process tail-promise chain, closing the read-modify-write lost-update window when two sources' levels/summaries change at once (the level/summary stores remain the source of truth, so each serialized recompute reads the full current state). A concurrency-convergence test guards it.
3. **`write-transformation` constrains `ownerSubject` to a `project` subject.** Since the chat Research Analyst supplies this arg (T3), the node now drops a non-`project` `ownerSubject` — a chat-driven caller can never mint a Document owned by an arbitrary `user`/`agent` subject (the `createDocument` org-guard already blocks cross-org; this closes the cross-subject-kind surface). The remaining same-org cross-notebook targeting is bounded by the caller's own org access (no escalation).

---

## Alternatives weighed

1. **Notebook as its own feature entity bound to KB+chat (not a Subject).** Rejected — shadows the Subject model (a parallel container with a fake owner id), the exact `no-parallel-architecture` violation. Loses board/memory/schedules/members for free.
2. **A new `kind:'notebook'` Subject.** Rejected for v1 — `project` already expresses everything a notebook needs (org-scoped container, no cognition, owns memory/knowledge/chat). A new kind earns its keep only if notebooks need owner semantics `project` can't express (none found). The `facet` field keeps the door open without the cost.
3. **Synchronous transformations/Ask (mirror NotebookLM).** Architecturally impossible here (`ctx`-only AI). Runs are the only conformant path.
4. **A second, bespoke "notebook chat" panel.** Forbidden by CLAUDE.md (one chat only). Use `EmbeddedChatPanel` + a scoped agent.

## PRD-vs-architecture corrections (recorded)

- Notebook/Source/Note/Transformation are **not** new stores → project facet + KB collection + subject memory + Documents templates.
- Transformations & Ask are **async runs**, not sync responses (`ctx`-only constraint).
- Per-source context level is a **host-side retrieval filter**, not a wire/dispatch field (keeps it RFC-free).
- "Notebook" is a **presentation** of a project, not a parallel container.

## Open questions

1. **OQ-1 — Notebook sharing.** Should a notebook be publicly shareable (rides Sharing ADR 0013 resolver-registry + capability tokens)? Deferred; the seam exists.
2. **OQ-2 — Cross-notebook search.** v1 scopes search to one notebook's collection+notes. A workspace-wide "search all notebooks" is a later additive surface.
3. **OQ-3 — Context level on the wire.** If a future need requires the per-source context level to travel on the dispatch envelope (e.g. a remote agent must honor it), that becomes an RFC in `openwop` (a new optional dispatch field) before that host work. v1 deliberately keeps it host-side → no RFC.
4. **OQ-4 — Summary cache invalidation.** A *Summary*-level insight is cached; when does it regenerate (source re-ingest? model change)? Propose: invalidate on source version bump.
5. **OQ-5 — Notes vs Documents for transformation output.** Short structured extracts → memory notes; long artifacts (literature-review entry) → versioned documents (ADR 0053). Default by length; let the template declare.

## RFC verdict (Step 5)

**Host-extension under `/v1/host/openwop-app/notebooks/*` → NO RFC.** Composes implemented ADRs (0011/0041/0042/0043/0046/0053/0054/0072) and rides Accepted RFCs (0005 chat, 0018 vector surface). The `ctx.notebooks` surface and envelopes are non-normative host extensions. **Companion features carry their own gates:** audio/video ingestion (ADR 0085, rides Accepted RFC 0091), podcasts (ADR 0086, blocked on **new RFC 0105** speech-synthesis), inbound MCP (ADR 0087, rides Accepted RFC 0020 + 0078).
