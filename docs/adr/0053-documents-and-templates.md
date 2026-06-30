# ADR 0053 — Documents & Templates (agentic business-document generation)

**Status:** implemented (Phases 1, 3, 4 shipped — `src/features/documents/`,
`packs/feature.documents.{nodes,agents}`, `test/documents-route.test.ts`; Phase 2
ships markdown-only, non-markdown rendering deferred per §Phase 2; artifact-types
deferred per §RFC verdict)
**Date:** 2026-06-15
**Depends on:** ADR 0001 (feature-package architecture), ADR 0004 (Orgs),
ADR 0006 (RBAC), ADR 0007 (Media Library — rendered bytes), ADR 0011 (KB/RAG —
optional text ingest), ADR 0013 (Sharing — public links), ADR 0014 (feature
workflow surfaces), ADR 0015 (workspace-as-tenant), ADR 0041 (Subject Memory),
**ADR 0045 (the Subject model — the owner abstraction)**, **ADR 0046 (the `project`
subject — documents' work container)**. Composes wire-accepted **RFC 0027/0028**
(Prompt Templates + library, implemented here); **RFC 0071/0075** (Artifact-Type
Packs) is referenced as a *future gate* — not yet implemented in this host.
**Toggle:** `documents` (OFF, bucket `tenant`) · **Surface:** host-extension
`/v1/host/openwop-app/documents/*` (non-normative)

---

## Context (boundaries audit first)

The plan: businesses run on documents — SOWs, PRDs, RFPs, Epic Briefs, board-meeting
agendas, status reports. We want two product concepts: a **Document** (a stored,
versioned business artifact in some format — Markdown, PDF, slides, diagram, sheet —
produced/consumed by agents and workflows) and a **Template** (a reusable,
parameterized generator that produces a Document of a given kind). Per the `/feature-refinement`
scope rule, the corpus was audited before claiming anything is new. The audit moved
the design substantially.

### What already exists (single-owner map — compose, do not fork)

| Concept the plan implies | Existing owner | Verdict |
|---|---|---|
| Binary/rendered bytes (the PDF, the slide deck) | **Media** (ADR 0007) — `media:asset` + RFC 0055 capability-token blob surface (`GET …/assets/:token`); MIME allowlist already includes PDF; `host/blob/s3Blob.ts` | **Reference Media tokens. Never re-store bytes.** (the CMS/KB boundary) |
| "Documents" as a text corpus | **KB** (ADR 0011) — `kb:document`, chunk→embed→`db.vector`, citations | **Different concept.** KB owns a *RAG corpus*; we own *authored business artifacts*. A document MAY be ingested into KB (compose), but KB is not the store. |
| Versioned content with a publish lifecycle | **CMS** (ADR 0009) — `cms:page` + `cms:pageversion` + draft→review→approve→publish | **Same shape, different consumer.** CMS = public web pages. We reuse its *patterns* (one package owning instance + version collections), not its store. |
| The template *generator* | **Prompt Templates** (RFC 0027/0028, `routes/prompts.ts` — mutable library + `:render`) **+ Artifact-Type Packs** (RFC 0071/0075 — `artifactTypeId`→JSON-Schema, render/export facets, `artifact.created` run event, `host.artifactTypes`) **+ Chat Card Packs** (RFC 0071 Phase 2 — bind a prompt template to a typed output artifact) | **This is the generator.** A "document template" = promptRef + artifactTypeId + parameter schema. **Forking the prompt-template/artifact-type engine is forbidden (no-parallel-architecture).** |
| The container documents "live in" (projects) | **The `project` Subject** (ADR 0045/0046) — `features/projects/` (`projectsService`, always-on), a `kind:'project'` Subject that already owns a board, memory, knowledge, and workflows over the generic owner abstraction (`host/subject.ts`, `subjectScope`, `ownerSubject`, `host/subjectOrgScope.ts`). | **Compose it — do NOT invent a soft tag.** A document attaches to a `Subject` via `ownerSubject` (the kanban/scheduling precedent); a project-owned document derives its org from `resolveSubjectOrg`. (PRD correction #1 — superseded by upstream.) |
| "documents in memories" | **Subject Memory** (ADR 0041, `host/subjectMemory.ts`, always-on) — `user:<id>` / `agent:<id>` / `project:<id>` notes | **Reference, don't duplicate.** A subject's memory note may point at a `documentId`; we add no memory store. |
| md→pdf / md→slides rendering | **Nothing.** `inMemorySurfaces.ts` explicitly notes "file-system image/pdf/archive helpers — out of scope"; no renderer ships. | Rendering is a real gap → run-scoped path (Phase 2 / deferred). |
| Public links | **Sharing** (ADR 0013) resolver registry | Add a `document` resolver type — one entry. |

**What's missing** is the product feature itself: a store of versioned, provenance-stamped
**document instances** in multiple formats, a **template library** that binds the existing
prompt/artifact-type machinery to named business-document kinds, an **agentic
generate-from-template** path, and the UI. That is what this ADR builds, as one
feature-package (ADR 0001) composing every owner above.

### PRD-vs-architecture corrections (the audit overruled the plan)

1. **A document attaches to a `Subject` (ADR 0045/0046), not a soft tag.** *(This corrects an
   earlier draft of this ADR, authored against a stale tree, which claimed "no projects
   primitive exists" and proposed a free-form `projectId` borrowed from `canvasSurface`.
   Upstream landed the **Subject model** (ADR 0045) and the first-class **`project` subject**
   (ADR 0046) — so a real owner now exists and MUST be composed, not shadowed.)* Every
   document carries an **optional `ownerSubject: Subject` (`{kind:'project'|'user'|'agent', id}`)** —
   absent ⇒ org-level. This is the exact additive pattern kanban boards (ADR 0046) and
   scheduled jobs use; a `kind:'project'` document derives its owning org from
   `resolveSubjectOrg` (`host/subjectOrgScope.ts`), never a stored/drifting `orgId`. The
   `projects` feature already FILLS that resolver at boot. ("stored in projects" → "owned by
   the `project` subject; org-level when unowned." This is also the ADR 0045 thesis: a new
   subject-owned surface should be nearly free.)

2. **"Templates generate documents" = the RFC 0071 card-pack pattern — compose it.** The
   generator already exists on the accepted wire (prompt templates + artifact types). This
   feature owns the **binding** (`documents:template`) and the **instance store**, not a
   parallel prompt/template engine. A template references a `promptRef` (RFC 0028) and an
   `artifactTypeId` (RFC 0071/0075); generation routes through `ctx.aiEnvelope`/`ctx.callAI`
   exactly as a card does.

3. **Generation is run-scoped (the KB §Correction lesson, ADR 0011).** Provider LLM calls
   need a per-node `AdapterScope` (runId/nodeId/secretResolver/policyResolver) — **never
   reachable from synchronous feature-route code.** So the feature's route floor is
   **assemble + validate**: bind a template's params into an `augmentedPrompt` and
   pre-validate the expected output against the `artifactTypeId` schema. **Actual
   generation is a workflow node / agent turn** (Phase 4), where `ctx.callAI` exists. Honest
   capability: the route stores/versions/templatizes today; the agent *writes* in a run.

4. **Bytes in Media, content in the version store.** The durable source of truth for a
   document's content is structured text/Markdown in `documents:version`; **rendered**
   PDF/slide/sheet bytes are **Media tokens** referenced from the version (same boundary CMS
   sections and KB source-docs use). md→pdf/slides **rendering** does not exist today and is
   itself a run-scoped/deferred path — not wedged into route code.

### Relationship to the Subject model (the owner abstraction — ADR 0045/0046)

Documents are **a new subject-owned surface**, joining board / memory / knowledge / workflows
on the unified `Subject` (`host/subject.ts`). The composition is deliberate and exactly the
ADR 0045 thesis (a new surface over the subject model should add almost no infrastructure):
- **Ownership** rides the generic `ownerSubject` field (the kanban/scheduling precedent, ADR
  0046) — no per-kind code; a `kind:'project'` document is owned by that project.
- **Org-scoped visibility** of project-owned documents rides `host/subjectOrgScope.ts`
  (`resolveSubjectOrg`) — `core` never imports the `projects` feature; the org is derived,
  never stored, so it can't drift (same seam kanban uses for project boards).
- **`projectKnowledgeService`** (a project's *cited* KB documents) is the direct precedent and
  a distinct concept: that is KB-RAG corpus (`kb:document`); this is the authored business
  artifact (`documents:doc`). A project may own both; the naming note (below) keeps them apart.

### Relationship to canvas / launch-studio (adjacent owner — single-source-of-truth)

The audit also surfaced a pre-existing, *wired* host surface that touches this space and the
ADR must not fork: **`host.launchStudio`** (`host/launchStudioSurface.ts`, registered at
`inMemorySurfaces.ts:1458` / `hostSurfaceRegistry.ts:107` / `executor.ts:488`). A studio
holds a `prdId` and `sharedArtifactRefs: [{artifactTypeId:'doc.prd'|'brand.kit'}]`, with
steps bound to `canvas.brief`/`canvas.design` and an optional `projectId` — i.e. it already
names "PRD"/"brief" artifacts in the same project-grouped space documents now occupy.

**Single-owner declaration:** the `documents` feature is the **one owner of durable, stored
business documents.** launch-studio and `canvasSurface` remain the owners of the *studio
configuration* and the *live canvas working-surface*; they are **producers/consumers** of
documents, not a second document store. Direction of dependency: a launch-studio
`sharedArtifactRef` or a finished canvas should ultimately **reference a `documentId`** owned
here — never the reverse, and never a parallel artifact table. Wiring that reference is **not
in scope for v1** (launch-studio is demo-seeded reference data), but the boundary is fixed
now so the next author composes instead of forking (the orgs↔accessControl lesson).

## Decision

A single `documents` `BackendFeature` (org-scoped, RBAC-gated, toggle **default OFF** — a
new product surface, ADR 0001 §6) + a `documents` `FrontendFeature`, composing Media,
Prompt-Templates, KB, Sharing, the Subject model (memory + `ownerSubject` + `subjectOrgScope`,
ADR 0045/0046), and the workflow surface.
**One package, three durable collections** (the CMS precedent: `cms:page`+`cms:pageversion`
+`cms:redirect` in one feature) — instances, immutable versions, and template bindings.
**Not** two feature-packages: templates and documents share one toggle/lifecycle, the
template is meaningless without the instance store, and the generator half is composed (not
owned), so a standalone "templates" package would be a thin shadow of RFC 0027/0028/0071.

### Data model

- **`Document`** (`DurableCollection 'documents:doc'`) — `{documentId, tenantId, orgId,
  ownerSubject?, kind, format, title, status, currentVersionId, templateId?, provenance,
  createdBy, updatedBy, createdAt, updatedAt}`.
  - `ownerSubject` — optional `Subject` (`{kind:'project'|'user'|'agent', id}`, ADR 0045).
    Absent ⇒ org-level. A `kind:'project'` document's effective org is `resolveSubjectOrg`
    (`host/subjectOrgScope.ts`), not a drifting stored value. The additive owner field, no
    migration (the ADR 0046 board pattern).
  - `kind` — free-form string, seeded set `sow | prd | rfp | epic-brief | board-agenda |
    status-report | doc` (open vocabulary; a host may register more — mirrors artifact-type
    open registration).
  - `format` — `markdown | pdf | slides | diagram | sheet | doc`. `markdown` is the native
    durable format; the others are **rendered representations referenced as Media tokens**.
  - `status` — `draft | in-review | approved | final` (RBAC-gated transitions; reuses the
    CMS state-machine shape, no interrupt-run).
  - `provenance` — `{producedBy: {kind:'user'|'agent'|'run', id}, runId?, nodeId?,
    templateId?, templateVersion?}` — the agentic audit trail (which agent/run wrote it).
  - **Naming note (cohesion):** this `documents:doc` (an authored *business artifact*) is a
    distinct concept from KB's `kb:document` (a *RAG corpus* entry) and from the protocol's
    *run artifacts* (`artifacts:read` scope). UI/nav labels and the collection key must keep
    them visibly separate — three "document/artifact" nouns now coexist in this host.
- **`DocumentVersion`** (`DurableCollection 'documents:version'`) — immutable snapshots:
  `{versionId, documentId, tenantId, orgId, version, content, renderedMediaToken?,
  producedBy, createdAt}`. `content` (Markdown/structured text) is the **durable source of
  truth**; `renderedMediaToken` points at a Media asset for non-markdown formats. Capped
  history (the CMS lesson). **`versionId` is deterministic — `${documentId}:${version}`,
  `version` monotonic** — so a replayed/retried run reproduces the same row (idempotent
  write), never a duplicate (see Phase 1 concurrency rule).
- **`DocumentTemplate`** (`DurableCollection 'documents:template'`) — the binding, **not**
  a new engine: `{templateId, tenantId, orgId, name, kind, outputFormat, promptRef,
  parameters, outputSchema?, artifactTypeId?, version, createdBy, updatedAt}`.
  - `promptRef` — a **RFC 0028 `PromptRef`** into the existing prompt library (the
    generator body), implemented in this host at `routes/prompts.ts`. Not a copy of the prompt.
  - `parameters` — a JSON Schema for the template's fill-in variables (SOW: client, scope,
    rate; board-agenda: meeting date, topics).
  - `outputSchema` — **a JSON Schema the feature owns**, used to validate generated content.
    The output contract is the *template's*, not the wire's — so validation needs nothing
    external and works today.
  - `artifactTypeId` — **OPTIONAL, opaque forward-compat tag only.** This host does **not**
    implement an RFC 0071/0075 artifact-type registry (audit: the only `artifactTypeId`
    occurrences are seeded demo strings in `host/launchStudioSurface.ts:36-37` — no registry,
    no schema store, no `host.artifactTypes` capability). v1 **stores** the tag but does
    **not** validate against it or emit `artifact.created`; real artifact-type binding is
    deferred to a future host artifact-type registry (own ADR — see Open questions).

### Phase 1 — Store + templates + assemble (backend)

Routes under `/v1/host/openwop-app/documents/orgs/:orgId/*`, all `authorizeOrgScope`-gated
(read = `workspace:read`, write = `workspace:write`, status-approve = `host:members:manage`):
- `POST/GET/PATCH/DELETE …/documents[/:documentId]` — instance CRUD + status transitions;
  list filterable by `kind`, `ownerSubject` (e.g. all docs of a `project:<id>`), `status`.
  Delete cascades versions. A project-owned document is read/written by callers holding the
  scope **in the project's org** (`resolveSubjectOrg`), the ADR 0046 read-privacy model.
- `GET …/documents/:documentId/versions[/:versionId]` — immutable version history;
  `POST …/documents/:documentId/versions` records a new version (content + optional rendered
  Media token + provenance), accepting an **idempotency key** (a retried run must not
  duplicate).
- **Concurrency rule (TOCTOU):** `currentVersionId` is a *derived* pointer, never a blind
  read-then-write. A new version is written at the deterministic key `${documentId}:${n}`
  where `n` is the next monotonic version; `current` is resolved as `max(version)` on read,
  **or** the pointer is updated via compare-and-set against the expected prior version.
  Concurrent `generateFromTemplate` runs therefore either collide on the deterministic key
  (idempotent) or advance the counter safely — no lost/duplicated versions.
- `POST/GET/PUT/DELETE …/templates[/:templateId]` — template CRUD; validates the `promptRef`
  resolves against the prompt library (honest: reject dangling refs); `artifactTypeId`, if
  present, is stored verbatim (not resolved — no registry exists, per the data-model note).
- `POST …/templates/:templateId/assemble` `{params}` → validate `params` against the
  template's `parameters` schema → resolve the `promptRef` (RFC 0028 `:render`) → return
  `{augmentedPrompt, outputSchema}`. **No LLM call here** (run-scoped, per Correction 3) —
  the KB `:rag` analogue. **Authority/redaction:** if `assemble` folds in any KB or tenant
  context, that context is fetched under the caller's org-scope and passed through SR-1
  redaction before it reaches `augmentedPrompt` — the same boundary KB `:rag` enforces.
- **Caps:** per-org documents/templates, per-version content bytes, version-history depth —
  all bounded (the Media/CRM/CMS lesson).
- **Perf note:** the documents-list (filter by kind/ownerSubject/status) is a
  `DurableCollection.list()` cross-tenant scan filtered in memory — consistent with CMS/KB
  and acceptable for v1, but business documents accrete faster than CMS pages; add a
  per-org / per-`ownerSubject` index path if counts grow.

### Phase 2 — Render representations (backend, run-scoped/deferred)

`markdown` is served inline from `content`. Non-markdown formats (`pdf`, `slides`, `sheet`,
`diagram`) require a renderer that **does not exist today** (audit). Rendering is a
**run-scoped path** (a workflow node that produces bytes and stores them via the Media
upload route, returning a token recorded on the version) — **not** a synchronous route
dependency. v1 may ship markdown-only and defer rendering to the node pack (Phase 4),
logged as an open question rather than faked.

### Phase 3 — Frontend feature

`DocumentsPage` as a `FrontendFeature` route, nav-gated on `documents`: a documents list
(filter by kind/owner/status, incl. a project's documents), a Markdown document editor with version history, a template
gallery (the seeded business-document kinds) + a "Generate from template" action that fills
params and kicks the assemble/agent path. `documentsClient.ts`. Honors `ui/` cohesion +
tokens + a11y (`/ux-review`, `DESIGN.md`). The canonical `npm run build` gate must pass.

**Test plan (authz + namespace are HTTP-boundary-only):** route-level tests
(`createApp` + `app.listen` + cookie jar) covering toggle gating, `authorizeOrgScope` IDOR
(cross-tenant/non-member → 404/403), status-transition RBAC, idempotent version writes, the
`assemble` redaction boundary, share-resolver approved-only visibility, and the
`/documents/*` non-collision — plus service-level edge/empty/concurrency cases.

### Phase 4 — Core-app extension surface (the agentic half)

- **`ctx.documents` workflow surface (ADR 0014)** — `surface.ts` exposing replay-safe
  `listTemplates / getTemplate / assemble / createDocument / addVersion / getDocument`
  (reads cached, writes idempotency-keyed; run-scope authority + SR-1 redaction). Advertised
  as non-normative `host.openwop-app.documents` at `/.well-known/openwop`, toggle-gated.
- **Node pack `feature.documents.nodes`** (signed, Ed25519 + SRI) — `documents.generateFromTemplate`
  (assemble → `ctx.callAI` → validate against the template's `outputSchema` →
  `createDocument`/`addVersion`, idempotency-keyed), `documents.render`
  (content → bytes → Media token → `addVersion`), `documents.create`, a `document.created`
  sensor/trigger. **(Not in v1:** emitting a typed `artifact.created` run event per RFC 0071
  — that awaits a host artifact-type registry; until then generation output is captured as a
  normal run output, not a typed wire artifact.)
- **AI-chat envelopes** — `documents.create` / `documents.fromTemplate` routed to the service
  (schema handshake), so "draft me an SOW for Acme" in chat produces a real Document.
- **Agent pack `feature.documents.agents`** — a **document-author** agent (drafts from a
  template + KB context) and a **document-reviewer** agent (critiques against the kind's
  rubric). Persona is `agentProfile`; the capability stays core (David's law — ADR 0031).
- **KB compose** — optional "ingest this document into KB collection X" (calls `kbService`),
  making finished documents retrievable; no new RAG store.
- **Sharing compose** — a `document` `ShareResolver` (ADR 0013), enabling public/expiring
  document links via the existing `/shared/:token` surface. **Default visibility =
  `approved`/`final` only** (unlike CMS, which deliberately allows draft shares — a leaked
  draft SOW/RFP is a confidentiality risk); a uniform 404 on missing/expired/revoked/non-published.
- **Subject-memory compose (ADR 0041)** — "documents in memories" = a memory note that
  *references* a `documentId` under `user:<id>`/`agent:<id>`; no new store.

## Architectural constraints honored

- **Compose, don't reinvent:** the template generator rides RFC 0027/0028 prompt templates
  (the artifact-type half is deferred — see RFC verdict); **ownership rides the Subject model
  (`ownerSubject` + `subjectOrgScope`, ADR 0045/0046)**; bytes ride Media (RFC 0055); RAG
  rides KB; links ride Sharing; memory rides Subject Memory. This feature owns the
  document/version/template-binding store and the agentic glue, **no parallel engine and no
  parallel owner**.
- **Run-scoped honesty (ADR 0011 §Correction):** routes assemble + validate; generation +
  rendering happen where `ctx.callAI`/`AdapterScope` exist (Phase 4). No fake out-of-run
  provider calls; advertise `host.openwop-app.documents` only when the surface is wired
  (`OPENWOP_REQUIRE_BEHAVIOR=true` honesty).
- **Feature-package contract (ADR 0001):** `BackendFeature` + `FrontendFeature`, toggle-gated,
  registered in `BACKEND_FEATURES`/`FRONTEND_FEATURES` — no core route/nav edits; features may
  import core, core must not import features.
- **Org-scoped + fail-closed (ADR 0006):** `authorizeOrgScope` on every route; cross-tenant/
  non-member → 404/403; `ownerSubject` is the owner abstraction (ADR 0045), never an
  authenticated principal — a project-owned document's org is *derived* (`resolveSubjectOrg`),
  the ADR 0046 read-privacy model (uniform 404 on insufficient scope, no existence leak).
- **Replay/fork safety (ADR 0014):** if a template variant influences a run, stamp
  `run.metadata.featureVariant` at creation, read verbatim on `:fork`; packs decoupled from
  toggle state; surface calls route through the invocation cache.

## Alternatives considered

1. **Two feature-packages (`documents` + `document-templates`).** Rejected — shared
   toggle/lifecycle; the template is inert without the instance store; and the generator is
   *composed* (RFC 0027/0028/0071), so a standalone templates package would be a thin shadow
   of the wire engine. One package owning three collections matches the CMS precedent.
2. **Extend CMS with a "document" section type.** Rejected — CMS is public-web-page content
   with slug/redirect/SEO/publish semantics; business documents are internal, kind-typed,
   provenance-stamped artifacts with a different lifecycle and no public slug. Reusing CMS's
   *patterns* (instance+version collections, state machine) is right; reusing its *store*
   couples two unlike products.
3. **Make documents KB documents (a system collection).** Rejected — KB is a RAG corpus
   (chunk/embed/retrieve), not an authored-artifact store with versions and rendered bytes.
   Documents *compose* KB (optional ingest), they don't live in it.
4. **Fork a new prompt/template engine inside the feature.** Rejected outright
   (no-parallel-architecture; David's law) — the wire already specifies prompt templates +
   artifact types; we bind them.
5. **Store rendered bytes inline / a new blob store.** Rejected — Media (RFC 0055) owns
   bytes; duplicating the blob surface is the exact fork the review bar rejects.
6. **Synchronous LLM generation in `assemble`.** Rejected — architecturally impossible
   without a per-run `AdapterScope` (ADR 0011 §Correction); generation is a node/agent turn.
7. **A free-form `projectId` soft tag (the canvas precedent).** Rejected — this was the
   original draft's correction #1, written against a stale tree. Upstream's Subject model +
   `project` subject (ADR 0045/0046) made a soft tag a *parallel owner* beside a real one.
   Composing `ownerSubject` is the single-owner-honoring choice.

## RFC verdict (Step 5 — wire vs host-extension)

**Pure host-extension work — NO new RFC required, and none blocks it.** All routes live under
the non-normative `/v1/host/openwop-app/documents/*` namespace; `host.openwop-app.documents`
is a non-normative capability.

**Honesty caveat (what this host actually implements vs what the wire defines):**
- **RFC 0027/0028 (prompt templates + library) — implemented here** (`routes/prompts.ts`);
  the `promptRef` composition genuinely rides them.
- **RFC 0055 (Media capability tokens), RFC 0004/0018 (memory/vector) — implemented here;**
  genuinely ridden for bytes / memory-refs / KB.
- **RFC 0071/0075 (artifact-type packs, `artifact.created`, `host.artifactTypes`) — NOT
  implemented in this host** (only seeded demo strings in `launchStudioSurface.ts`). The
  RFCs being *Accepted on the wire* does **not** mean this host honors them. v1 therefore
  does **not** advertise artifact-type binding or emit typed `artifact.created` events
  (`OPENWOP_REQUIRE_BEHAVIOR=true` honesty); `artifactTypeId` is an opaque stored tag and
  output is validated against the template-owned `outputSchema`.
  - **§Correction (2026-06-16, ADR 0055):** this is now implemented. The host ships an
    artifact-type registry (`host/artifactTypes.ts`), advertises `host.artifactTypes`, serves
    schemas, validates a bound `artifactTypeId` (no longer opaque — an unknown id is rejected at
    template create), and the generate-from-template node emits a typed, validated
    `artifact.created`. See ADR 0055.

A *future, optional* play — a real host artifact-type registry (own ADR) + publishing
business-document templates as portable artifact-type/card packs — would ride RFC 0071
directly and **still needs no new RFC**; it is the gate that unlocks typed `artifact.created`
emission here.

## Implementation (landed)

| Phase | What shipped | Artifacts |
|---|---|---|
| 1 — Store + templates + assemble | `documents:doc` / `documents:version` / `documents:template` collections; org-scoped RBAC routes; deterministic+idempotent versions (CAS); `ownerSubject` via the Subject seam (`resolveSubjectOrg` for `project`); assemble (validate + render, no LLM); KB-ingest compose; bounded caps | `src/features/documents/{documentsService,routes,feature}.ts` |
| 3 — Frontend | `DocumentsPage` (org picker, documents list + Markdown editor + version history, template gallery + assemble preview + seed), `documentsClient.ts`, nav-gated route | `frontend/react/src/features/documents/{DocumentsPage.tsx,documentsClient.ts,routes.tsx}` + FE registry |
| 4 — Core extension surface | `ctx.features.documents` workflow surface (assemble/create/addVersion, idempotency-keyed); node pack (`list-documents`, `assemble`, `generate-from-template` → `ctx.callAI`); agent pack (document-author, document-reviewer); Sharing `document` resolver (approved/final-only) | `src/features/documents/surface.ts`, `packs/feature.documents.{nodes,agents}/`, `sharing/sharingService.ts` |
| 2 — Render | **markdown-only** (native `content`); pdf/slides/sheet rendering deferred to a run-scoped node path (no renderer in-host) | — (deferred per §Phase 2) |

Verified: `tsc --noEmit` clean (backend + FE), `frontend/react` `npm run build` green (token/CSS gates pass), `test/documents-route.test.ts` (5) + `test/sharing-route.test.ts` (6) pass. The 9 pre-existing node-pack/runtime suite failures (canvas/kb-agent/nosql/replay/triggers/workflow-templates) reproduce identically on `origin/main` with this feature removed — unrelated to this change.

## Open questions

- [ ] **Document ownership surface depth.** v1 attaches documents via `ownerSubject` and
  filters lists by it. Do we also want a thin `projectDocumentService` mirror (the
  `projectKnowledgeService` precedent) so a project page lists/creates its own documents
  directly, or is the generic `ownerSubject` filter on the documents routes enough?
- [ ] **Non-markdown formats for canvas/launch-studio handoff.** Should a finished
  `canvas.brief`/`canvas.design` materialize as a `documents:doc` automatically (the
  reference-into-documents direction), and if so via which seam?
- [x] **md→pdf rendering.** RESOLVED in **ADR 0057** — pure-JS (`markdown-it` + `pdfkit`,
  no Chromium), delivered as a deterministic `…/documents/:id/render` route + the
  `feature.documents.nodes.render` node + `ctx.features.documents.render`, storing the PDF as
  a Media token on the version. Slides/sheets remain deferred.
- [ ] **Host artifact-type registry (the deferred gate).** A real `host.artifactTypes`
  registry (artifact-type packs + schema validation + typed `artifact.created` emission)
  does not exist in this host (only seeded demo strings in `launchStudioSurface.ts`). It is
  its **own future ADR**; once it lands, `documents` upgrades `artifactTypeId` from an opaque
  tag to a validated binding and emits typed run artifacts. v1 deliberately does not depend
  on it.
- [ ] **Wire the launch-studio/canvas → document reference.** Make launch-studio
  `sharedArtifactRefs` / finished canvases point at a `documentId` (the single-owner
  direction declared above) — deferred; v1 leaves launch-studio's seeded refs untouched.
- [ ] **Template portability.** Ship templates as host-local `documents:template` rows only
  (v1), or also publish them as RFC 0071 artifact-type/card packs for cross-host reuse
  (depends on the artifact-type registry above)?
- [x] **Seeded template library.** RESOLVED — a code-versioned, host-global, read-only
  **starter catalog** (`features/documents/seedTemplates.ts`, the `workflowTemplates.ts`
  precedent) ships SOW / PRD / RFP / Epic-Brief / board-agenda starters (Markdown,
  no `outputSchema` → free-form generation). Surfaced at `GET …/templates/catalog`;
  `POST …/templates/from-catalog/:catalogId` copies one into the org as an editable
  `documents:template`. The catalog is never per-tenant state; users own their copies.
- [x] **Approval workflow depth.** RESOLVED — v1 ships the CMS-style state machine:
  `draft → in-review → approved → final` with demotions back to draft/in-review
  (`STATUS_TRANSITIONS`, validated in `updateDocument`; illegal jumps → 409). Promotion to
  a shareable status (`approved`/`final`) is gated on `host:members:manage`; lower edits on
  `workspace:write`.
- [x] **ownerSubject integrity.** RESOLVED — a `user`/`agent` owner is validated to exist in
  the caller's tenant (`getUser`/`getRosterEntry`), a `project` owner to resolve to the doc's
  org — a cross-tenant/dangling owner is a uniform 404. `ownerSubject` is an honest reference,
  not an arbitrary client tag.
