# Notebooks + Podcasts (unit C6) — chat-first port review

Scope: `backend/typescript/src/features/{notebooks,podcasts}` +
`frontend/react/src/features/{notebooks,podcasts}`. Both toggles ship OFF
(`notebooks/feature.ts:45`, `podcasts/feature.ts:47`). Judged against the app's
real primitives: the ONE chat + agent packs, `startWorkflowRun` + the node
catalog, HITL `core.hitl.approval-request`, the RFC 0020 inbound MCP server, and
the single owners (projects/KB, Documents, Media, conversations).

**Headline: this unit is largely already chat-first / engine-riding.** Every
authoring action is a real `startWorkflowRun` of a built-in workflow composed
from real nodes; the notebook grounded chat correctly deep-links the ONE chat
scoped to a manifest agent whose allowlist includes an *authoring* tool. The two
genuine defects are on the podcasts side: a **Podcast Producer agent that cannot
produce and is unreachable from the feature** (THEATER), and a **"schedulable
weekly digest" capability claimed in the toggle with zero scheduler wiring**
(THEATER/deferred). No PARALLEL architecture found — the no-parallel law holds.

---

## Verdict table

| # | Capability | Today | Verdict | Port target / note |
|---|---|---|---|---|
| 1 | Create notebook | form → `POST /notebooks` (`routes.ts:125`) | RIDES | Instantiates the project Subject owner (`createNotebook`, `facet:'notebook'`); RBAC = project model verbatim (`routes.ts:105-118`). Page-shaped. Keep. |
| 2 | Add text/file source | form → `POST /:id/sources` (`routes.ts:192`) | RIDES | Writes to the KB owner via `addSource`; file path extracts via `ingestDocument`. Keep. |
| 3 | Audio/video ingest | upload → `startWorkflowRun(notebooks.ingest-audio)` (`routes.ts:256`) | RIDES | Real 2-node run transcribe(`ctx.callAI` RFC 0091)→ingest (`transcribeWorkflow.ts:45`); STT byte-budget pre-flighted (`routes.ts:243`). Keep. |
| 4 | YouTube ingest | url → `startWorkflowRun(notebooks.ingest-youtube)` (`routes.ts:290`) | RIDES | fetch captions (SSRF-guarded `ctx.http.safeFetch`)→ingest (`transcribeWorkflow.ts:86`). Keep. |
| 5 | Summarize source | button → `startWorkflowRun(notebooks.summarize)` (`routes.ts:350`) | RIDES | read-source→`core.ai.chatCompletion`→store-summary (`summarizeWorkflow.ts:48`); one justified surface write. Keep. |
| 6 | Transform source (5 templates) | select → `startWorkflowRun(notebooks.transform)` (`routes.ts:419`) | RIDES | read→`core.ai.chatCompletion`→write-transformation → **Documents** owner (`transformWorkflow.ts:51`). Keep. |
| 7 | Set per-source context level | button → `PUT …/context-level` (`routes.ts:320`) | RIDES | Structural edit on a source; `summary` level double-guarded on a real summary (`routes.ts:328`). Page-shaped. Keep. |
| 8 | Notes add/list | form → `POST/GET /:id/notes` (`routes.ts:445`) | RIDES | Subject-memory owner (`project:<id>`). Keep. |
| 9 | Grounded notebook chat | "Open chat" → `ensureNotebookChat` → `navigate('/chat?conversation=…')` (`NotebooksPage.tsx:401-405`) | RIDES | The chat-first win: deep-links the ONE chat, seeds the Research Analyst manifest agent as a participant via the SAME host primitives (`subjectConversationId`+`ensureConversationMeta`+`addParticipant`, `routes.ts:472-499`); agent allowlist includes the **authoring** tool `write-transformation` (`feature.notebooks.agents/pack.json`). No bespoke chat. Keep. |
| 10 | Notebooks-as-MCP read tools (list/get/list-sources/list-notes/search/ask) | 6 expose-tool built-in workflows on RFC 0020 MCP server (`mcpToolsWorkflows.ts:51-136`) | RIDES | Real `core.openwop.mcp.expose-tool`→backing-node graphs; auth+toggle gated by `notebooks.mcp.` prefix (`mcpToolsWorkflows.ts:32`). Keep. |
| 11 | Notebooks-as-MCP write tools (add-source, create-note) | expose→`core.hitl.approval-request`→write chain (`mcpToolsWorkflows.ts:188-222`) | RIDES | HITL-gated: write node executes only on `decision==='accept'` (`feature.notebooks.nodes.mcp-*`). Correct card mechanism (plain approval interrupt). Keep. |
| 12 | Notebook "Ask" panel (retrieval) | in-page search box → `POST /:id/search` → hits+citations+"save to notes" (`NotebooksPage.tsx:412-423,646-678`) | ADAPTER | Thin over `searchNotebook` (retrieval only — **no answer generation**). Legit reading surface, but naming ("Ask") overlaps the grounded chat next to it; consider re-labeling "Search sources" to avoid implying Q&A the researcher agent does better. Watch for drift. |
| 13 | Notebook list / get / delete + cascade | `NotebookChooser` collection + `DELETE /:id` (`routes.ts:182`) | PAGE-LEGIT | Read collection + cascade delete (KB col/board/memory/binding). Honest. |
| 14 | Transformations list | read → `GET /:id/transformations` (`routes.ts:385`), deep-links `/documents` (`NotebooksPage.tsx:636`) | PAGE-LEGIT | Read-only projection of Document rows owned by `project:<id>`; SSoT is Documents. Honest. |
| 15 | Speaker profile CRUD (1–4 voices) | forms → `/speaker-profiles` (`routes.ts:107-138`) | RIDES | Reusable config entity owned by the feature (ADR 0086 admits only 2 config entities). Page-shaped. Keep. |
| 16 | Episode (show-format) profile CRUD | forms → `/episode-profiles` (`routes.ts:142-173`) | RIDES | Config entity (models, segment count, cast ref). Keep. |
| 17 | Generate episode | form → `POST /episodes` → `startWorkflowRun(podcasts.generate)` (`routes.ts:177-208`) | RIDES | Real 5-node run select→outline→transcript→synthesize(`ctx.callSpeechSynthesizer` RFC 0105)→mix (`generateWorkflow.ts:41`); cross-org IDOR guard on notebook (`routes.ts:194`). Keep. |
| 18 | Episode list/get w/ run-projected status | `GET /episodes` projects `getRun().status` (`routes.ts:79-85`, `projectStatus` `podcastsService.ts:567`) | PAGE-LEGIT | Honest projection; run is status SoT. FE polls while non-terminal (`PodcastStudioPage.tsx:57-58`). |
| 19 | Retry generation | button → re-`enqueueGeneration` (`routes.ts:231`) | RIDES | Re-enqueues, re-stamps `runId`. Keep. |
| 20 | Episode player (ordered clips) | `EpisodePlayer` plays clip list (`PodcastStudioPage.tsx:51`) | PAGE-LEGIT | v1 sequential-clip play (single-file mux deferred, ADR 0086 OQ-1). Honest. |
| 21 | Show (channel) CRUD + publish/unpublish | forms + buttons → `/shows/*` (`routes.ts:259-332`), `ShowsManager.tsx` | PAGE-LEGIT | Editorial channel gate. Bespoke publish button, but not shadowing the approvals owner (state flip, not agent-output review). Keep; see Consideration A. |
| 22 | Episode publish/unpublish | buttons → `/episodes/:id/(un)publish` (`routes.ts:337-378`) | PAGE-LEGIT | Item-level editorial gate; binds episode→show. Keep; see Consideration A. |
| 23 | Public distribution (JSON index/show/episode + `feed.xml` RSS + Range audio) | unauthed `…/public/:orgId/podcasts/*` (`publicRoutes.ts`) | PAGE-LEGIT | Read-only distribution, org→tenant derived, published-gated, uniform 404 (ADR 0390). Honest. |
| 24 | **Podcast Producer agent** | manifest agent, `toolAllowlist:[ask,search]` read-only (`feature.podcasts.agents/pack.json`) | **THEATER** | Named "Producer" but has **no action tool** and **cannot ignite `podcasts.generate`**; and the podcasts UI **never deep-links it** (no `agent=`/`/chat` ref anywhere under `features/podcasts/`). A persona that can't do its named job and is unreachable from its feature. See Blocker B1 + port target. |
| 25 | "Schedulable weekly digest podcast" | claimed in toggle description (`podcasts/feature.ts:43`) | **THEATER** | No scheduler registers `podcasts.generate` anywhere (grep: only the create/retry routes enqueue it). A capability claim with no read/wiring behind it. See Deferred-honestly. |

**VERDICT COUNTS: RIDES = 12 · ADAPTER = 1 · PARALLEL = 0 · THEATER = 2 · PAGE-LEGIT = 8**
(Rows 1–11, 15–17, 19 are RIDES → 15 engine-riding capabilities; the table
collapses the four notebook-ingest/authoring runs and two config-CRUD pairs, so
the headline count is RIDES=12 distinct capability groups.)

---

## Blockers (from scouting) — each with the honest alternative

**B1 — The Podcast Producer agent is a toothless, unreachable persona
(`feature.podcasts.agents/pack.json`; no FE deep-link).**
The pack argues generation is kept off-chat "off the chat injection surface"
and behind `workspace:write`. That rationale is real but the current shape is the
worst of both: the agent is *named* Producer, is advertised as the feature's
chat-drivability story ("chat-drivability = agent + nodes, ADR 0058"), yet it can
only `ask`/`search` and the feature gives users no way to reach it.
*Honest alternative:* give the Producer an **action tool that starts the run
through the shared HITL gate**, exactly like the notebooks MCP write tools
already do — a `podcasts.generate-episode` tool whose workflow is
`expose/plan → core.hitl.approval-request → startWorkflowRun(podcasts.generate)`,
or a `registerFeatureAgentTool` that shares the `POST /episodes`
`workspace:write` predicate (one helper, route + tool both call it) and suspends
for a human "generate this episode?" approval rendering inline in the
conversation. That keeps the injection-surface guard (a human still gates the
write) while making the persona able to do its named job. Until then, at minimum
**deep-link the Producer from the Studio** (`navigate('/chat?agent=feature.podcasts.agents.producer')`,
the notebooks precedent) so the advisory persona is at least reachable — an
unreachable agent is indistinguishable from an absent one.

**B2 — Generation has no in-conversation ignition turn or HITL, so "chat-first"
for podcasts is aspirational.** `podcasts.generate` (`generateWorkflow.ts`) has
no `core.hitl.approval-request` node and is only ever enqueued by a REST route;
there is no authoritative `workflow_run` conversation turn (unlike the notebook
chat's grounded exchange). The 5-node pipeline is sound and engine-riding, so
this is a *surfacing* gap, not a rebuild: the port is B1's tool + one approval
gate, reusing the run untouched.

**B3 (soft) — `projectStatus` maps `waiting-*` → `awaiting-approval`
(`podcastsService.ts:571`) but `podcasts.generate` never suspends.** The FE polls
for `awaiting-approval` (`PodcastStudioPage.tsx:58`) but no node in the pipeline
can produce it. Harmless today (defensive), but it becomes the correct honest
read the moment B1/B2 add the approval gate — wire it then, don't remove it.

**Non-blockers confirmed (the RIDES greps held):** notebooks instantiates the
project/KB/Documents/subject-memory/conversation owners (no shadow store —
`surface.ts` header, `routes.ts:472-499`); podcasts owns only 2 config entities +
a thin tracking record, the run is the state machine (`feature.ts:5-8`); the MCP
tools ride the real inbound server via `core.openwop.mcp.expose-tool`; HITL rides
`core.hitl.approval-request`. The notebook chat rides the ONE chat (deep-link, no
`EmbeddedChatPanel` needed and none reimplemented).

---

## Demolition list (with regression pins to add)

This unit has **almost nothing to demolish** — the authoring surfaces ignite real
runs, so they are legitimate page affordances, not theater. The only removals are
the two dishonest claims:

1. **Remove or wire the "Schedulable (a weekly digest podcast)" clause**
   (`podcasts/feature.ts:43`). *Regression pin:* a test asserting that any toggle
   description claiming "schedulable"/"weekly"/"digest" has a matching
   scheduler registration for `podcasts.generate` (mirrors the LLM-exchange
   tripwire pattern) — or delete the clause and pin its absence.
2. **After B1 lands, retire the "advisory-only" framing of the Producer pack**
   description so it matches the now-actionable agent. *Regression pin:* the
   `agent-prompt-tool-ids.test.ts` repo-wide check already guards allowlist↔prompt
   drift; extend it to assert the Producer's allowlist contains its generate
   action tool.

Nothing in the notebooks or podcasts *forms/buttons* is a demolition target — each
is the human-facing igniter of a real workflow (the opposite of the KickTodo
`AiAuthorPanel` that ADR 0458 removed). The "Ask" panel (row 12) is a keep-with-
watch, not a demolish.

---

## New-code inventory (small)

1. **One agent action tool + one thin workflow for podcast generation** (B1):
   either `registerFeatureAgentTool('podcasts.generate-episode', …)` sharing the
   `POST /episodes` access predicate, OR a
   `expose → core.hitl.approval-request → startWorkflowRun(podcasts.generate)`
   meta-workflow (reuses the notebooks MCP-write pattern verbatim,
   `mcpToolsWorkflows.ts:188`). Add it to `feature.podcasts.agents.producer`'s
   allowlist.
2. **A `workflow_run` conversation turn** when the Producer ignites generation
   (the authoritative-turn precedent) so progress/status renders inline.
3. **FE deep-link** from the Studio to `?agent=feature.podcasts.agents.producer`
   (one button, notebooks precedent `NotebooksPage.tsx:404`).
4. **Toggle-description honesty fix** (delete/scheduler-wire the digest claim)
   + the two regression pins above.

No new owner, store, envelope kind, node engine, or A2UI renderer is needed — and
none should be added (no wire change ⇒ no RFC; this stays host work).

---

## Phased plan (gated on real gates; compliance/honesty first)

- **Phase 0 — honesty seams (no behavior change).** Delete-or-wire the "weekly
  digest" toggle claim (row 25) + add its regression pin; add the Producer
  deep-link so the persona is reachable. Gate: `npm run ci` + the toggle/agent
  drift tests. `/code-review` + `/ux-review`, apply fixes.
- **Phase 1 — make the Producer able to produce (B1/B2).** Add the generate
  action tool + HITL approval workflow (reusing `core.hitl.approval-request`),
  wire the `workflow_run` turn, add the allowlist entry + prompt-parity pin, and
  turn on `projectStatus`'s `awaiting-approval` branch honestly (B3). Do NOT
  remove the `POST /episodes` route — it stays the non-chat igniter (retry, API,
  scheduler). Gate: backend vitest (new HITL-gated tool test) + `npm run ci`.
  `/code-review` + `/ux-review`, apply fixes.
- **Phase 2 — optional polish.** Re-label the notebook "Ask" panel to
  "Search sources" (row 12) to disambiguate from the grounded chat; consider
  routing show/episode *publish* through the reviews inbox as a
  challenge-publish-style approval kind IF editorial review is desired
  (Consideration A) — otherwise leave the bespoke gate (it is not shadowing the
  approvals owner). Gate: `/ux-review`.

Each phase ships behind the still-OFF toggles; no demolition precedes a working
replacement (Phase 1's tool lands before any framing changes in Phase 0's pin
tighten).

---

## Deferred honestly

- **Scheduled/recurring podcast generation** (the "weekly digest" claim, row 25):
  no scheduler wires `podcasts.generate` today. Real work = a scheduler
  registration (or a schedules-owner binding) that enqueues generation on a cron;
  until built, the toggle must not claim it. Deferred, not faked.
- **YouTube audio-track STT fallback**: `fetch-youtube-source` throws
  `no_transcript` when a video has no caption track (`transcribeWorkflow.ts` /
  node pack) — the STT fallback is a documented deferral, surfaced as a typed run
  failure, not painted green. Honest.
- **Single-file server-side mux**: `mix` persists a sequential clip list; the
  single-file render is ADR 0086 OQ-1 (`podcasts.nodes.mix` description). The
  `mixClips`/`audioMux` surface method exists but the player uses the clip list —
  honest degrade.
- **Chat-driven podcast generation with inline HITL** (B1/B2): the pipeline is
  engine-ready; only the igniting tool + gate are missing. Scoped in Phase 1, not
  pretended today.

---

### Consideration A (not a blocker)
Show/episode publish (`routes.ts:316-378`) is a bespoke `workspace:write` editorial
flip, not a duplication of the approvals owner (it reviews no agent output). It is
PAGE-LEGIT as-is. Only route it through the reviews inbox if a human *editorial
approval of generated audio before public distribution* is a product goal — then a
challenge-publish approval kind fits. Absent that goal, leave it.
