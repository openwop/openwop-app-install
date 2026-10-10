# ADR 0830 — Knowledge Base / RAG, round 2: the org dimension on every read exit, the fence at every prompt exit

Status: Accepted (implemented on `feat/fl2-18-kb`; flips to implemented on merge)

Related: ADR 0011 (Knowledge Base / RAG), ADR 0038 (per-agent knowledge), ADR 0100
(managed planning KBs), ADR 0113 (hybrid + rerank), ADR 0351 (retrieval fidelity),
ADR 0398 (ingestion depth), ADR 0605 (`KSC-4`, the RAG context fence), ADR 0608 (`CPC-2`,
project-bound collections), ADR 0643 (reindex orchestration, `KBC-1` subject gate),
ADR 0818 §4 (media's run-lane org check), ADR 0819 (the paywall resolver), the monetization packaging ADR §8.1
(#4418, the reader-side managed-recall plan gate; this ADR does not touch it), CMNT-4
(`assertOrgScope`, the one org-scope predicate), ADR 0324 (the one tool-scope composer).
Feature loop 2026-10 row 18; workflow findings `KB2WF-1..9` in
`docs/steward/WORKFLOWS-ASSESSMENT.md`; market scan
`docs/research/kb-rag-competitive-2026-10.md`.

> **Order of work.** The security probes ran first, against unmodified `origin/main`
> source (`abb233f96`), before any refinement: three cross-org read holes were proven
> RED with real fixtures (`test/adr0830-kb-org-scope-probes.test.ts`, 5 red, the 2
> allowed-arm legs green), reported to the orchestrator with a prod-sizing request,
> then fixed. Every other decision below was likewise witnessed RED on the pre-fix
> code before it was called closed.

## Context

The KB HTTP doors are sound and were re-measured as such: every `/kb/orgs/:orgId/*`
route goes through `requireOrgScope` (CMNT-4's `assertOrgScope`), writes need
`workspace:write`, reindex needs `host:org:manage`, and project-bound collections are
gated by a mounted `subjectAccess` guard plus the service-level `KBC-1` gate. The probe
fixture asserts the door's 403 before it tests anything else, so the holes below are
not door holes. Round 1 graded the feature A− / A− / B+ by looking at those doors.

KB's data does not only leave through the doors. An exit inventory (55 rows: HTTP, the
`ctx.features.kb` and `ctx.knowledge` run surfaces, the chat tools, dispatch-time
recall, MCP, the indexers, the eraser) found the org dimension missing on three read
lanes and the untrusted fence missing on two prompt lanes:

- **S1 — `ctx.features.kb.search` / `.rag` / `.listCollections`** took `orgId` from node
  args and never asked whether the run's acting user may read it. A run acting for an
  `editor` of org A read org B's verbatim chunk text. This is the CMNT-4 shape, one
  feature over; media closed its copy in ADR 0818 §4.
- **S2 — `tenantRetrieve`** (behind `ctx.knowledge` for every run, `ctx.features.kb.retrieve`,
  and the `openwop:knowledge.search` / `core.rag.retriever-*` chat tools whenever the
  agent has no binding) fanned out across every org's collections and filtered only
  project-bound rows (`filterReadable`). Any member of any org pulled any org's KB
  through chat.
- **S3 — `POST /agents/:id/knowledge/bindings`** resolved the collection tenant-wide and
  never asked whether the binder may read its org. The projects and profile bind doors
  both do. A tenant-`workspace:write` member bound org B's collection to an agent and
  read it back through the agent, whose use lane reads bindings pre-authorized.
- **S4 — the ad-hoc dispatch** (`POST /agents/:agentId/dispatch`, `live:true`) built its
  tool executor with a hand-rolled `createAgentToolProvider({...})` literal with no
  `actingUserId` — the shape ADR 0324 forbids — so every tool on that lane ran as a
  system run for any signed-in caller, `knowledge.search` included.
- **S5 — untrusted text into prompts.** `vendor.myndhyve.knowledge-tools`
  `knowledge.augment-prompt` concatenated every chunk, `contentTrust` ignored, into the
  augmented user message; `feature.campaign-brief.nodes.extract-voc` wrapped chunks in
  `<SOURCE>` tags a chunk could close itself. Team Portfolio profile text — one member's
  free-text bio, recalled into OTHER members' agent turns — was indexed TRUSTED.
- **S6 — managed collections written past their guard.** `assertNotManaged` sat on the
  KB routes only; `documents/:id/ingest-to-kb` (and the agent-knowledge and project
  ingest lanes onto a bound Strategy KB) wrote trusted text into a collection advisors
  cite as the strategy itself.

Probed and found sound: cross-TENANT reads on every lane (the tenant comes from the run
scope or the active tenant, never from args); Viewer writes on the KB doors (all write
routes need `workspace:write`); URL ingest SSRF (it rides `webResearchSurface`'s
`ssrfGuardedFetch`: the webhook egress guard's denied ranges, re-checked on every
redirect hop through the guarded dispatcher, a 2 MB body cap); file uploads (base64
validated before decode, 32 MiB decoded cap, 200 MiB for audio, PDF/DOCX parsed
in-process after the cap); stored XSS (`KbViews`/`KnowledgeBasePage` render chunk text
as React-escaped children, and the public share viewer's `ui/Markdown` renders no raw
HTML); DSAR erasure and retention (`eraseSubjectKb` + `purgeOrphanKbDerivedRows`,
witnessed by `kb-erasure-retention.test.ts`); the paywall (`kb` is always-on and not
priced; the managed-collection plan gate is #4418's).

The workflow grade (B, from a claimed A−) found the KB-owned lane at A− and the gallery
chains that consume KB at C+ (`KB2WF-1..9`). The market scan graded the user-facing layer
C+ and ranked a one-line bug first: `/rag` and `kb.rag` ignored the collection's
retrieval mode.

## Decision

### D1 — One run-lane org predicate, on every KB read exit (S1, S2, S4)

`host/accessControlService.ts` gains `assertRunOrgScope(tenantId, actingUserId, orgId,
scope)` — the media surface's `requireScope` (ADR 0818 §4), lifted out unchanged so KB and
media decide it identically — and `runOrgScopeFilter(...)`, the same predicate as a filter
for a fan-out (one resolve per distinct org; a refusal drops that org's rows). The
semantics are CMNT-4's `assertOrgScope`, which the HTTP doors use, plus the two lanes media
already had:

- **no acting user** (a schedule, a trigger, a system run) stays tenant-trusted, as every
  surface without an actor is (`featureSurfaces.ts`'s stated model);
- the **workspace-root id** of a single-principal tenant passes (it need not be an org row).

Applied at:

- `ctx.features.kb.search`, `.rag`, `.listCollections` — `workspace:read` in the named org
  before any read;
- `tenantRetrieve` — after the subject filter, keep only rows whose org the caller may
  read. `preAuthorized` callers are unchanged. **`TENANT_SCOPED_KB_ORGS`** (`_team`,
  `_kickbot`) are tenant-level namespaces the managed indexers file under; they are not
  orgs, have no members to ask, and stay readable to whoever is in the tenant. A ratchet
  scans every `*KnowledgeService.ts` for a synthetic `'_…'` org constant and fails if one
  is missing from the set, because the failure mode is silent recall loss;
- the ad-hoc dispatch now builds its executor through `createScopedAgentToolProvider`
  with `actingUserId: callerSubject(req)` and `personalTenant`, the ADR 0324 composer, so
  its tools act for the caller (`callerSubject`, not `req.userId`: an `apikey:` or bearer
  caller has no `req.userId` and would otherwise still run as a system run).

The fan-out filter resolves orgs one at a time and rethrows anything that is not a
refusal (`not_found` / `forbidden_scope`): a storage error must surface, never read as
"nothing you may read", which is indistinguishable from a tenant with no knowledge.

**Bound collections on the TOOL lane are reader-gated, deliberately.** An agent's
`knowledge.search` with a binding retrieves through `tenantRetrieve` with the chatting
person's subject, so a bound collection in an org the person cannot read is filtered,
while dispatch-time composition reads the same bindings pre-authorized. That split
predates this ADR for project-bound collections (KBC-1) and follows ADR 0664 D6
("re-resolve the READER wherever a principal exists"); the composition lane is the
stated residual R4.

### D2 — The bind door checks the collection's org (S3)

`bindCollection` takes a REQUIRED `assertCollectionOrg: ((orgId) => Promise<void>) |
'preauthorized'`, so a future door that forgets the check fails to compile. The HTTP bind
route passes `assertRunOrgScope(tenantOf(req), binder, orgId, 'workspace:read')` with the
same subject its tenant gate used — the KB door's predicate in the form that keeps a
personal or `anon:` sandbox's implicit owner (the first cut used `resolveCallerUser`,
which 401s an `anon:` caller this route used to admit). The advisory-board reconciler and
create-then-bind, which bind only collections they resolved or minted themselves, pass
`'preauthorized'`.

### D3 — Untrusted text reaches a model fenced (S5)

- `knowledge.augment-prompt` partitions chunks by `contentTrust`; untrusted ones sit inside
  the host's `BEGIN/END UNTRUSTED CONTENT` fence (the same words as
  `host/untrustedContent.ts`, so a model sees one convention), with titles and headings
  flattened and the fence words defanged inside them. Numbering is preserved. A chunk with
  no label is trusted, as the spec says. Pack `1.0.2 → 1.0.3`.
- `extract-voc` defangs `<SOURCE`/`</SOURCE` and the fence words in chunk text and reduces
  the `doc` attribute to id-safe characters. The grounding check compares quotes against
  the ORIGINAL chunk, so this cannot change what grounds. Pack `1.5.1 → 1.5.2`.
- Team Portfolio documents are indexed `contentTrust: 'untrusted'`, and `upsertDocument`
  now counts a trust change as a change (its no-op check compared only title and text, so
  an unchanged bio would have kept its stored `trusted` label forever).

### D4 — A managed collection takes writes only from its indexer (S6)

The guard moves to the exit: `ingestDocument` refuses a managed collection unless the
in-process `InternalDocumentFields.managedWrite` flag is set, and only `upsertDocument` (the
indexers' sanctioned replace path) sets it. `upsertDocument` has one non-indexer caller,
`ingestMediaCollection`, which takes a user-chosen collection id, so it asks the same
refusal (`refuseManagedCollection`) at its own entry. `managedWrite` joins the privileged-field list,
so a forwarded body that carries it is refused rather than honoured. The route-level
`assertNotManaged` stays as the cheap first line.

### D5 — `/rag` and `kb.rag` use the collection's retrieval mode

`ragQuery` resolves the collection's configured mode (ADR 0113) instead of a literal
`'dense'`, and `RagResult` carries `mode` — the mode the answer actually used — beside the
existing `embedding` honesty label. Additive on the host-extension `/rag` response; the
`kb.rag` node's output projection is unchanged.

### D6 — The reindex driver reap cannot take a successor's driver (`KB2WF-4`, `KB2WF-5`)

`reapKbReindexDriverIfTerminal` re-reads the job row and skips the teardown when a
non-terminal job owns the collection, and re-reads it again AFTER the teardown,
re-ensuring the driver (idempotent; it re-registers the definition un-archived) if a
successor started in between: the driver is shared per collection (one job id, one
workflow id), and `drainReindex` reaps after the old-namespace GC and the `completed` emit,
so a reindex started in that window used to lose its scheduler job and have its workflow
archived while its row said `running`. The comment that claimed emitting LAST prevented
this is corrected. `kb.reindex` is marked `internal: true` (RFC 0135), so it no longer
appears in the gallery or the `/` picker where a copy could only ever fail the node's 403.

### D7 — Gallery chains that consume KB deliver through a named port (`KB2WF-2`, `KB2WF-3`)

Four bare edges into a delivery node are port-qualified, following the `inbox`/`exec-ops`
precedent: `lighthouse.rfp-response` `draft.content → approve.artifact`,
`finance.month-end-close` `variance.content → chase.artifact` (the two blind approval
gates), `marketing.content-brief` `brief.content → deliver.message` and
`it-support.incident-triage` `summary.content → notify.message`. Each pack and chain gets a
patch bump; the local copy wins over the registry's older version (loader semver
precedence), and the registry republish is owed (as for every chain bump). A structural
gate now holds every chain that uses `feature.kb.nodes.rag` to this rule.

## Alternatives weighed

- **A membership floor at the `featureSurfaces` seam** (wrap every surface method that
  receives `args.orgId` with `assertRunOrgScope(…, 'workspace:read')`). This is the
  systemic fix, and it is the right one: a grep heuristic finds **31 of 34** org-taking
  surfaces ungated (only orgs, media, comments call the predicate). It is not taken HERE
  because it changes 30 other features' behaviour at once, `gate()` currently skips
  always-on surfaces entirely, and read vs write cannot be told apart at the seam. It is
  Residue R1, routed to the orchestrator, and the ratchet in this ADR pins the 30 so the
  class cannot grow meanwhile.
- **Gate `tenantRetrieve` inside `filterReadable`.** Rejected: #4418 is reshaping
  `filterReadable`/`readableCollection` for the managed plan gate, and the subject gate
  and the org gate answer different questions; a separate filter step is one hunk that
  does not entangle them.
- **Refuse system runs (no actor) on the KB surface, as comments does.** Rejected for a
  READ surface: scheduled and webhook-triggered RAG chains are the feature's main
  automation shape, and comments refuses because it WRITES. Media's precedent (system run
  = tenant-trusted) is the consistent one for reads.
- **Put the bind check in the route by re-reading the collection.** Rejected for a
  callback into `bindCollection`: the service already resolves the collection, and a
  second read in the route is a second opinion that can disagree.

## Adversarial `/architect` pass (2026-10-05) — findings and dispositions

Run over this ADR and the implementation together, after the probes had already driven
D1–D2. 2 Blockers, 7 Shoulds, 6 Nits; every Blocker and Should was against MY first cut.

| Finding | Disposition |
|---|---|
| **B1** dispatch passed `req.userId`; `apikey:`/bearer callers still ran actorless | Fixed: `callerSubject(req)`; ratchet re-pinned |
| **B2** channel @mentions and kanban WorkItems start actorless runs a person causes, so the "system run" exemption is not only schedules/webhooks | Not fixable inside KB without a run-scope seam; the claim is corrected and the lanes filed as R8, routed with R1 |
| S1 the fan-out swallowed storage errors as "no knowledge"; parallel full scans | Fixed: refusal-only catch, sequential resolves |
| S2 a successor starting after the re-read could still lose its driver; the "emitted LAST" comment was not corrected | Fixed: second re-read + idempotent re-ensure; comment corrected in place |
| S3 R3's relabel could never happen (no-op check ignored trust) | Fixed in `upsertDocument` |
| S4 `ingestMediaCollection` reached `upsertDocument`'s indexer pass with a user-chosen id | Fixed: `refuseManagedCollection` at its entry |
| S5 tool lane vs composition lane disagree on bound collections | Decided and documented in D1 (reader-gated, ADR 0664 D6); composition is R4 |
| S6 no `ws:`/`user:`/`anon:` recall witness; D7 has only structural gates; notify truncates at 2000 chars | `user:`/`anon:` are the single-principal exemptions media already relies on; a D7 execution witness and the truncation are filed with R2 |
| S7 D2 401'd `anon:` callers and the check was optional | Fixed: run-lane predicate on the route's own subject; the argument is required |
| Nits (Matrix text, "last hand-rolled literal", pinning-test name, `_team`/`_kickbot` 404 on `kb.search`) | Fixed; `kb.search`/`rag`/`listCollections` now exempt the tenant namespaces like `tenantRetrieve`. `agentRunnerNode`'s literal carries `actingUserId` and is not this lane |

Claims the pass verified true: the run/chat subject key equals the member-row key for
cookie, SAML and personal callers; personal tenants keep recall; media's predicate moved
unchanged; S1/S2 gated for runs with an actor; D3 fence wording matches
`host/untrustedContent.ts` and numbering is preserved; D4/D5/D7 as written.

## Grade passes over the implementation (2026-10-05)

**`/grade-code kb`: B (claimed B+) → A− after fixes.** One Blocker, again in my own fix.

| Finding | Disposition |
|---|---|
| **KBCD-1 (Blocker)** — the D3 pack edits left `packs/.steward-manifest.json` pinning the old digests, so the loader refused to dispatch `augment-prompt` and every campaign-brief node (`no_attestation`); `gen-steward-manifest --check` is a `ci.sh` step | Fixed: manifest regenerated |
| KBCD-2 — the org filter ran over every collection before narrowing to `collectionIds` | Fixed: narrow first. The per-org resolve still scans the member stores, as every HTTP `requireOrgScope` does; a subject-indexed read is a host-wide improvement, not KB's |
| KBCD-3 — the D5 witness checked only the label | Fixed: asserts the contexts ARE the hybrid hits (scores differ by construction); sabotage-RED |
| KBCD-4 — trust relabel, Team Portfolio label and the media-collection refusal had no witness | Fixed: one leg each, each sabotage-RED |
| **KBCD-5** — the root shortcut accepted `default`, which outside demo mode is the shared SAML tenant | Fixed: personal tenants, and `default` only in demo mode. This NARROWS ADR 0818 §4's media lane too (one predicate): `adr0818-media-access-probes` now pins both arms (demo ⇒ root write works; non-demo ⇒ 404) |
| KBCD-6 — anonymous widget lane | Filed under R8 |
| KBCD-7 — bind subject spelling for an unbound OIDC bearer | Fails closed; filed |
| KBCD-8 — the dispatch fix is pinned by source shape only | Filed (a live-dispatch harness needs a provider seam) |
| KBCD-9 — the bind door's 403 vs 404 was an existence oracle | Fixed: one 404 |
| KBCD-10 — the namespace ratchet saw only `const …ORG… = '_x'` | Widened to inline literals passed to the KB writers |

**`/grade-ux kb`: B− (claimed A−) → A− after fixes**, three Blockers, all frontend:
`KB2UX-1` the page offered every write and the owner-only Reindex panel to callers whose
one possible outcome was a 403 (now gated per org on `/access/effective`, fail-closed
with an announced retry); `KB2UX-2` server English shown in all four locales;
`KB2UX-3` the agent Knowledge tab rendered raw server text or `unbindCollection returned
403`, newly reachable through D4's managed refusal. Improvements filed: `KB2UX-4`
(the agent panel should not offer Add/Delete on a managed collection; needs `managed` on
the `BoundCollection` view), `-5` (reindex failure reason codes), `-6..9`.

## Matrix

| Dimension | Disposition |
|---|---|
| Feature-package boundaries | Host helper in `accessControlService`; the KB surface, `tenantRetrieve`, media and the agent-knowledge bind door call it; `routes/agents.ts` reaches it through the tools. No feature→feature import added. |
| Toggle / paywall | `kb` always-on, not priced. Untouched; #4418 owns the managed plan gate. |
| Workflows (chains or stacks) | No in-tree definition added; five chain packs bumped (D6, D7). |
| Node / agent packs | `vendor.myndhyve.knowledge-tools` 1.0.3, `feature.campaign-brief.nodes` 1.5.2 (requiredPacks pin updated). Registry republish owed. |
| AI exchange lanes | Chat-time tools now act for the caller on the ad-hoc dispatch lane (D1); untrusted text fenced at two more prompt exits (D3). |
| RBAC | D1/D2: the HTTP predicate reaches the run, chat and bind lanes. |
| Replay / fork | No new event or clock read. A `:fork` of a run re-checks D1 against the run's stamped `actingUserId` (the same field media reads). |
| RFC gate | None needed: host-extension routes and host surfaces only; `RagResult.mode` is an additive host-extension field. |
| Data | No migration. Existing Team Portfolio documents keep their stored `trusted` label until each profile is next re-indexed (Residue R3). |

## Phases

| Phase | What | Witness |
|---|---|---|
| P1 | D1, D2 (S1–S4) | `adr0830-kb-org-scope-probes.test.ts` (S1–S3 RED on `abb233f96` source; the S2 legs sabotage-RED individually), `adr0830-kb-ratchets.test.ts` (dispatch composer, tenant namespaces, no-growth surface pin) |
| P2 | D3, D4, D5 | `adr0830-kb-ratchets.test.ts` (augment fence), `campaign-brief-voc.test.ts` (SOURCE breakout, RED on the old pack), probes D4/D5 legs |
| P3 | D6, D7 | `adr0830-kb-reindex-reap-race.test.ts` (KB2WF-4, RED with the old reap), ratchets (internal flag, named delivery ports) |

## Residue (filed, not done here)

- **R1 — the seam-level membership floor** for the 30 pinned surfaces (see Alternatives).
  Routed to the orchestrator 2026-10-05; needs its own ADR and full gate.
  > **Taken by ADR 0832** (`docs/adr/0832-org-scope-seam-floor.md`): the floor lives in
  > `gate()` for every surface, always-on included, and `UNGATED_ORG_SURFACES_PINNED` is
  > gone; the ratchet now pins what the floor cannot see (an absent org read as the whole
  > tenant). R8 is answered there by a narrowing `orgScopeSubject`. Its /architect pass
  > found that `KBCD-6`'s "operator-granted" reading was false (a widget's grant needs
  > authority in one org, the anonymous turn reads the tenant), so `KBCD-6` stays OPEN as
  > ADR 0832 R8-anon.
- **R2 — `KB2WF-1`/`-7`**: `it-support`'s KB article reaches no consumer, and two RAG →
  chat edges pass a JSON blob. Both need a product call on what the ticket and the model
  should receive, not a mechanical rewire.
- **R3** — existing Team Portfolio docs relabel on their next re-index (a profile save, or
  the binding backfill); there is no one-time sweep.
- **R4** — a binding outlives the binder's org membership (the agent use lane reads
  bindings pre-authorized; ADR 0664's stated residual, now also org-shaped).
- **R5** — `deleteDocument` on a managed collection through the agent-knowledge and
  project delete lanes is not yet refused at the service (entangled with #4418's
  `KB_MAINTENANCE_CALLER`; the KB route guards it).
- **R6** — workflow-surface write lanes outside KB with no org check
  (`notebooks.ingestSource/addNote/setSourceSummary`, `agent-knowledge.ingestDocument`,
  `knowledge-sync.runOnce`) — the same class as R1, owned by those rows.
- **R8 — runs a person causes but no person is stamped on.** A channel post that
  @mentions an agent (`channelAgentDispatch.ts`, system-fired on purpose: the poster must
  not become the twin-recall audience) and a kanban WorkItem delivery
  (`kanbanWorkItemDelivery.ts`) start runs with no `actingUserId`, so D1's "no actor ⇒
  tenant-trusted" applies and an agent's unbound `knowledge.search` still reads every
  org in the tenant there. S2 is closed for runs and chat turns that carry their person;
  it is NOT closed for these two lanes. The anonymous public-widget lane
  (`anonymousActor.ts`, off by default) has the same shape if a widget's grant
  includes `knowledge.search` (`KBCD-6`). The fix is a read-only org-scoping subject
  stamped separately from the acting user (so twin recall stays denied), which touches
  the run scope for every feature — the same seam question as R1, routed with it.
- **R7** — market-scan gaps 2–8 (clickable passage citations, honest no-sources refusal,
  source-ACL mirroring for synced drives, verification cadence, question-gap analytics,
  URL re-fetch, per-collection editors). Ranked in the scan; none is a defect.

## Open questions

- [x] Prod sizing (read-only, orchestrator, 2026-10-05 ~13:45 EDT): **LATENT, no hotfix.**
      418 tenants, 23 org rows, 47 member rows, 3,857 KB collections, 11,614 docs. One
      tenant has 2+ org rows, and in it no KB org has a tenant subject outside it. One
      tenant (a personal `user:` tenant, 13 subjects) has KB in 2+ org ids: its own org
      (45 collections, every subject a member) and the pseudo-orgs `_team` (1 / 13 docs)
      and `_kickbot` (1 / 3 docs), which have no org row and no member rows — the
      `TENANT_SCOPED_KB_ORGS` allow-arm exists for exactly these, and both arms (listed ⇒
      readable; an unlisted pseudo-org ⇒ refused, never "no org row ⇒ allowed") are pinned
      in `adr0830-kb-org-scope-probes.test.ts`.
- [ ] R1 seam fix (orchestrator will spawn it after merge, burning down the ratchet's pin
      list): a membership floor at the `featureSurfaces` `gate()` seam, INCLUDING the
      always-on surfaces `gate()` skips today, honouring the same `_team`/`_kickbot`
      allow-arm. R8 rides with it.
