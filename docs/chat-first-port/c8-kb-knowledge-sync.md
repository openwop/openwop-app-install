# KB / RAG + Knowledge-sync (unit C8) — chat-first port review

**Scope:** `backend/typescript/src/features/{kb,knowledge-sync}` +
`frontend/react/src/features/{kb,knowledge-sync}`, plus the packs
`packs/feature.kb.nodes`, `packs/feature.kb.agents`,
`packs/feature.agent-knowledge.nodes`. Reviewed against the app's real
primitives: the ONE chat, feature-bound agent packs + `registerFeatureAgentTool`
tools, `startWorkflowRun` + the node catalog, the HITL machinery, and the single
owners (connections, knowledge/vector store, scheduler-class daemons).

## Headline

**This unit already rides the engine — it is the cleanest C-batch result so
far.** The grounded-answer intelligence is expressed correctly: a feature-bound
agent (`feature.kb.agents.researcher`) whose ACTION tools are the KB node pack
over `ctx.features.kb`, tool-allowlisted to that surface only
(`packs/feature.kb.agents/pack.json:14-27`), installed at boot via
`requiredPacks` (`backend/typescript/src/features/kb/feature.ts:33-36` →
`featurePackRefs()` → `ensureRegistryPacksInstalled`,
`backend/typescript/src/index.ts:364`). There is **no orphaned workflow, no
toothless agent, no parallel owner, no fake gate**. `grep` for
`WorkflowDefinition|startWorkflowRun|builtinWorkflows` across both packages
returns **nothing** — knowledge-sync deliberately runs as a cadence daemon (the
`heartbeat`/`refreshDaemon` class), a documented ADR 0107 correction away from
"scheduler fires a workflow."

The one genuine chat-first gap is **surfacing, not architecture**: the KB page
offers a raw-chunk *search* box (`KnowledgeBasePage.tsx:295-301`, calls
`search` → scored chunks) but **never surfaces the grounded "ask my Knowledge
Base and get a cited answer" experience** — the `rag` route + the researcher
agent — even though every peer feature deep-links its agent into the ONE chat
(`crm/CrmPage.tsx:81`, `campaign-intel/CampaignIntelPage.tsx:103`,
`document-editor/DocumentEditorSurface.tsx:331`, `kicktodo/TodayPage.tsx:182`).
The `ragQuery` client fn exists (`kb/kbClient.ts:211`) but is **called from
nowhere in the UI**. The port is a single additive deep-link.

---

## Verdict table

| # | Capability | Today | Verdict | Port target |
|---|---|---|---|---|
| 1 | KB Researcher agent — grounded, cited Q&A | Feature-bound agent, action tools (`search`/`rag`) allowlisted to the KB surface (`feature.kb.agents/pack.json:21-24`) | **RIDES** | Leave. **Surface it** (cap #4). |
| 2 | KB node pack (`search`/`rag`/`list-collections`) | `role:action` nodes over `ctx.features.kb`, recorded/replay-safe (`feature.kb.nodes/index.mjs`) | **RIDES** | Leave. |
| 3 | `ctx.knowledge` host backend (tenant retrieval for ALL agents) | `setKnowledgeBackend({ retrieve: tenantRetrieve })` (`kb/feature.ts:25`) | **RIDES** | Leave. |
| 4 | Grounded Q&A in the UI ("answer from my KB") | **Absent** — page shows raw-chunk `search`; `ragQuery` client fn unused (`kbClient.ts:211`) | **THEATER-adjacent (missing surface)** | Add an "Ask your Knowledge Base" deep-link → `/?agent=feature.kb.agents.researcher` scoped to the collection. |
| 5 | Connection-revoke → pause sync sources | `onConnectionRevoked('knowledge-sync', …)` (`knowledge-sync/feature.ts:19-22`) — the single connection lifecycle owner | **RIDES** | Leave. |
| 6 | KB workflow surface (`ctx.features.kb`) | Self-described "THIN adapter over kbService," tenant from run scope (`kb/surface.ts`) | **ADAPTER** | Leave; watch drift. |
| 7 | Scheduled sync (cadence daemon) | Focused daemon composing `listFolder`+`diffFolder`+`kbService` under `claimIdempotency` lease; NOT a workflow, by ADR 0107 correction (`knowledgeSyncDaemon.ts`) | **ADAPTER** | Leave. Fix stale "Phase-3 workflow" comments. |
| 8 | "Sync now" + one-pass runner | Route → `syncNow` → `runKnowledgeSyncOnce`, composes host owners, per-file isolation (`knowledgeSyncRunner.ts:40-113`) | **ADAPTER** | Leave. |
| 9 | Media-collection → KB bridge | `ingestMediaCollection` composes the media owner, stable-id, untrusted-fenced (`kb/routes.ts:111-122`) | **ADAPTER** | Leave. |
| 10 | Manage collections (create/list/delete) | Org-scoped CRUD page (`KnowledgeBasePage.tsx`) | **PAGE-LEGIT** | Keep. |
| 11 | Ingest documents (paste/upload/URL/media) | Write forms, untrusted-fenced server-side (`KnowledgeBasePage.tsx:205-269`) | **PAGE-LEGIT** | Keep. Optional agent tool later. |
| 12 | Semantic search box (raw scored chunks) | Real retrieval preview for KB managers (`KnowledgeBasePage.tsx:426-441`) | **PAGE-LEGIT** | Keep as a manager/debug preview (distinct from #4). |
| 13 | Retrieval config (mode/embedder/enrichment) | Operator knobs, PATCH `/retrieval` (`kb/routes.ts:195-202`) | **PAGE-LEGIT** | Keep. |
| 14 | Reindex (versioned embedding migration) | ADMIN-gated job + determinate progress, client-driven drain loop (`ReindexPanel`, `KnowledgeBasePage.tsx:560-628`) | **PAGE-LEGIT** | Keep; see note. |
| 15 | Sync-source CRUD + folder picker + pause/resume/includeMedia | Config surface, self-gates when toggle off (`KnowledgeSyncPanel.tsx`) | **PAGE-LEGIT** | Keep. |
| 16 | Document reader | Read-only, React-escaped plain text (`KnowledgeBasePage.tsx:494-506`) | **PAGE-LEGIT** | Keep. |

**Counts:** RIDES = 4 · ADAPTER = 4 · PARALLEL = 0 · THEATER = 0 · PAGE-LEGIT = 7.
(Capability #4 is a *missing surface* over a RIDES primitive, not runtime
theater — counted under PAGE-LEGIT's port target, not THEATER.)

---

## Port tests applied (the load-bearing ones)

- **Interface (cap #4):** "answer my question from the KB" is *describing
  intent* → belongs in the ONE chat via the researcher agent, not a search box.
  The primitive exists and is drivable; the UI just never routes to it. Every
  peer feature already does this (`/?agent=…` deep-link precedent, 8+ call
  sites). **This is the whole port.**
- **Agency (cap #1):** PASS — named agent, ACTION tools (`search`/`rag` are
  `role:action`, `feature.kb.nodes/pack.json:16,24`), allowlist scoped to the KB
  surface only. Not a read-only toothless persona.
- **Ignition (cap #7/#8):** PASS with a caveat — there is *no* declared
  workflow to ignite. Sync runs from a route (`/:id/sync`) and a cadence daemon,
  both calling `syncNow` directly. ADR 0107 §Phase-3b **explicitly** chose the
  daemon over a workflow ("a feature-service node = a signed node pack …
  disproportionate"). This is honest and documented, not theater.
- **HITL (cap #11):** ingestion of *untrusted* synced/URL content is fenced
  (`contentTrust:'untrusted'`, `knowledgeSyncRunner.ts:90`; ADR 0027) — the
  trust boundary is intact. No human-gate is duplicated in bespoke UI.
- **Authority-parity:** the routes and the surface share the tenant+org
  enforcement (`requireOrgScope` on routes; `kbService` enforces the tenant+org
  key so the surface's node-supplied `orgId` can't cross tenants — `surface.ts`
  header). Managed collections refuse hand-edits via `assertNotManaged`
  (`kb/routes.ts:42-47`). Sync-source create validates the connection + target
  collection belong to the tenant/org (`knowledge-sync/routes.ts:57-62`).
- **Honesty-loop:** every UI state has a real read — search hits are real
  cosine scores, reindex progress is real chunk counts, sync status is the real
  `lastSyncedAt`/`lastError`. Nothing painted green.

---

## Blockers (from scouting) — each with the honest alternative

**None that block the port.** The port target (cap #4) is purely additive and
rides shipped primitives. Two smaller items:

- **B1 — The researcher agent has no per-collection scoping input.** The
  agent's tools take `{ orgId, collectionId, query }` (`kb/surface.ts:21-30`),
  but a chat scoped via `/?agent=…` carries no collection context — the agent
  would have to `list-collections` then guess, or the user names the
  collection. *Honest alternative:* seed the composer with the collection via
  the existing `composerSeed` mechanism (`chat/composerSeed.ts`) OR pass the
  collection through the deep-link and have the agent's first turn read it (a
  `?collection=` param the researcher's system prompt is told to honor). This is
  a prompt/seed wiring task, not new architecture. Do NOT invent a new
  agent-scoping channel.
- **B2 — Reindex drain is a client-side pump.** `ReindexPanel.runToCompletion`
  loops `drainReindex` up to 10,000× from the browser
  (`KnowledgeBasePage.tsx:572-579`). Honest (determinate progress, budget-paused
  state surfaced) but tab-close aborts an in-flight migration mid-way. Not a
  chat-first concern; flagged for the operator-job backlog, not this port.

---

## Demolition list

**Nothing to demolish.** No parallel chat panel, no bespoke "talk to AI"
textarea, no duplicated approve/submit button, no orphaned workflow. The
search box (cap #12) is a legitimate KB-manager retrieval preview and is
*retained* — it is distinct from the grounded-answer surface being added
(cap #4). Regression pin to add with the port:

- **P1 — assert the KB page exposes an "ask" deep-link to
  `feature.kb.agents.researcher`.** A future refactor that drops it (or replaces
  it with a bespoke in-page answer box) fails the suite. (New test, e.g.
  `frontend/react/src/features/kb/__tests__/ask-deeplink.test.tsx`.)

---

## New-code inventory (SMALL — additive)

1. **One deep-link affordance** in `KnowledgeBasePage.tsx`: an "Ask your
   Knowledge Base" button in the search card that
   `navigate('/?agent=feature.kb.agents.researcher&collection=<id>&org=<id>')`
   (mirror `CrmPage.tsx:81` / `campaign-intel` exactly).
2. **Composer seed / prompt wiring** so the researcher honors the scoped
   collection (B1) — reuse `chat/composerSeed.ts`; no new channel.
3. **i18n keys** for the button label/help across the 4 locales
   (`features/kb/i18n/*`), FATAL-parity per the frontend gotcha.
4. **One regression test** (P1 above).
5. **Comment cleanup** (not code): the 5 stale "Phase-3 `knowledge-sync.run`
   workflow (not yet wired)" references
   (`knowledge-sync/feature.ts:4`, `routes.ts:7`, `knowledgeSyncService.ts:4,42`,
   `host/knowledgeSourceFetch.ts:452`) contradict ADR 0107's "all phases
   complete / daemon by design" and read as a declared-but-unbuilt workflow that
   does not exist. Correct them to name the daemon.

No new nodes, no new agent, no new workflow, no new owner, no new durable row.

---

## Phased plan (gated on real gates)

- **Phase 1 — Surface the intelligence (the port).** Add the "Ask your
  Knowledge Base" deep-link + collection scoping (items 1–3), plus the
  regression pin (item 4). Close with `/code-review` + `/ux-review`; apply fixes.
  Gate: `( cd frontend/react && npm run build )` green (tsc + token/CSS + i18n
  parity).
- **Phase 2 — Honesty cleanup.** Rewrite the 5 stale `knowledge-sync.run`
  comments (item 5) to reflect the shipped daemon. Docs-only; no gate beyond
  build.
- **Deferred (own backlog, NOT this port):** move reindex drain off the client
  pump (B2) to a server-driven job; optional `kb.ingest` agent tool so a user
  can say "add this to my KB" in chat (cap #11 → ADAPTER) — only if a real
  demand appears, since deliberate structural ingest is legitimately page-shaped.

---

## Deferred honestly

- **Grounded-answer collection scoping (B1)** is a seed/prompt wiring task the
  port includes; if the seed mechanism can't carry a collection cleanly, ship
  the deep-link scoped to the *org* and let the researcher `list-collections`
  first — stated, not faked.
- **External-provider reranker** is deferred-by-design (ADR 0113 Phase 4;
  `setRetrievalConfig` rejects `rerank.kind:'connection'` — the honest gate),
  unrelated to the chat-first port.
- **Reindex client-pump (B2)** — filed as a cross-layer operator-job gap, not
  worked around locally.
