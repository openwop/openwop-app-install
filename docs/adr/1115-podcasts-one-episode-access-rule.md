# ADR 1115 — Podcasts: one episode-access rule, for every lane

Status: Accepted (2026-11-13, after an independent adversarial architect pass; findings
folded in, see § Architect pass)

> **RENUMBERED 2026-11-13: 1113 → 1115.** This ADR reserved 1113 first (b94d4f5cdd, 2026-11-12 21:28 -05:00), but `docs/adr/1113-site-nav-authored-links.md` merged on main under the same number while this one was unmerged. Renumbering the unmerged ADR touches no merged history.

Feature loop round 2, row 93. Grade record:
`docs/steward/workflows-assessment/2026-11-13-podcasts-row93.md` (finding ids `PODC93-*`,
`PODUX93-*`). Builds on ADR 0086 (podcasts), 0390 (public distribution), 0562 (ingest,
Proposed, not built), 0603 (typed failures, public transcript), 0679 (writer replay
classification) and ADR 1103 (row 92), which routed the podcasts run lane here by name.

## Context

Podcasts has four lanes that touch an episode: the HTTP doors, the chat tools
(`openwop:podcasts.list` / `.produce`), the run (`ctx.features.podcasts`, driven by the
`podcasts.generate` chain), and the public exits. Each answers "may this person touch
this episode" with its own code, and they disagree:

- **`PODC93-1` (Blocker).** The route doors start the generation run with no actor
  (`routes.ts:132-140`). Since ADR 1103 D2, an actorless run reads only org-visible
  notebooks, so a private notebook's `ask` comes back empty, `select-content` reports
  success with `''` (`index.mjs:153-154`), and a paid outline, transcript and per-turn TTS
  run on the briefing alone. The episode shows "Ready".
- **`PODC93-2` (Blocker).** `ctx.features.podcasts` is tenant-trusted (`surface.ts`): it
  reads any episode or profile and writes any episode (`recordEpisodeResult`) by id. The
  ADR 0832 floor only sees `listEpisodes`. Published episode ids are public (enclosure
  URLs). The cross-org overwrite of a published episode's audio is held today only by the
  documents surface's write floor, which the outline node happens to meet first, and not
  at all when `documents` is OFF.
- **`PODC93-4` (Blocker) + `PODC93-3` (High).** The `:id` write doors (retry, publish,
  unpublish, delete) skip the private-notebook check that the two read doors apply, and
  the chat `list` tool lists private-notebook episodes the HTTP list hides. Together: an
  org writer who is not a member of a private notebook publishes its episode's audio and
  transcript to the public web.

  > **CORRECTED 2026-11-13 (first test run): the org-WRITER half of this premise is
  > false.** ADR 0054 D5's `levelFor` answers `write` to anyone holding
  > `workspace:write`, private or not ("membership NEVER grants write", and write
  > reads). So a non-member org writer already reads and writes a private notebook,
  > and its episode is not hidden from them. D1's notebook question changes nothing
  > for writers. Three tests written from this sentence used an org editor and went
  > red. What the rule actually closes is the org READER. A non-member org viewer
  > was listed the episode by the chat `list` tool (`PODC93-3`), which is real. The
  > `:id` write doors answered that viewer 403, confirming the episode exists. Now
  > they answer 404, as `GET` does. The witnesses use a viewer. A control shows the
  > same viewer gets 403 on an org-visible notebook, and removing the notebook
  > check reddens both. `PODC93-4` is therefore not a Blocker as written: an org
  > writer publishing a private notebook's episode is within ADR 0054's authority
  > model. Whether private notebooks should withhold write from non-member writers
  > is a projects-wide question for ADR 0054, not a podcasts fix.
  >
  > **UPDATED 2026-11-13: decided by ADR 1118.** A private project now admits only its
  > members and the org's admins, so a non-member org editor is hidden from a private
  > notebook's episodes as well. `podcasts-episode-access.test.ts` R4 asserts it (404).
- **`PODC93-5` (High).** Retry re-runs a published or still-running episode with no guard;
  publish accepts an episode with no audio.

Prod facts (MEASURED 2026-11-13 ~02:40Z by the lead, read-only, counts only): one `podcasts` toggle override row (value not read); **0** episodes, episode profiles, speaker profiles and shows; **0** `podcasts.generate` runs and **0** runs of any `%podcast%` workflow, ever; 0 overlapping runs. Control: `hostext:projects:project:%` = 20. **Verdict: LATENT.** All three Blockers have exposure 0; no data repair, backfill or operator review is needed.

### Boundaries audit

| Concern | Owner | This ADR |
|---|---|---|
| Episode access rule | `features/podcasts` | NEW `podcastsAccess.ts`: the one rule the routes, the chat tools and the surface call |
| Org scope | `host/accessControlService.ts` `resolveEffectiveAccess` | **no change**, called as-is |
| Notebook read level + provisioning | `features/notebooks` `notebookAccess` (wraps `resolveProjectAccess`) | **no change**, called as-is; a NEW static `podcasts → notebooks` service edge (no cycle: notebooks does not import podcasts), recorded in `feature-dependency-parity.test.ts` |
| Run actor stamp | `host/runStarter.ts` (`metadata.actingUserId`, `personalTenant`, caller-owned `runId`) | **no change**; the routes now pass all three |
| Surface org floor | `host/featureSurfaces.ts` | **no change**; podcasts does its own floor, as notebooks does, because only it can map an episode to its org and notebook |
| Notebook grounding | `features/notebooks` surface (`ask`, `getNotebook`) | **no change**; podcasts now reads its refusal instead of turning it into success |
| Subject erasure | `host/subjectErasure.ts`, `subjectEraserManifest.ts` | NEW `erasePodcastsSubject` (the owner decision `RECORDED_DEBT` asked for) |
| Chain visibility | `examples/workflow-chain-packs/podcasts` | chain becomes `internal` |
| Node pack | `packs/feature.podcasts.nodes` | authorize-first, typed grounding, every writer fails typed on refusal, `failEpisode` carries the code; version bumps |
| FE | `features/podcasts/*` | existing lazy pages and the existing `podcasts` namespace only; no route, no namespace |

## Decisions

### D1 — One episode-access rule (closes `PODC93-3`, `PODC93-4`)

`features/podcasts/podcastsAccess.ts` holds the rule. Everything else calls it.

- `orgAllows(tenantId, orgId, subject, scope)`: `resolveEffectiveAccess(...).scopes.includes(scope)`.
  An absent subject answers `false`.
- `notebookReadableBy(tenantId, notebookId, subject, memo?)`: `true` for an orphan (the
  project was deleted; the episode stays reachable to org readers, ADR 0086's orphan
  rule), else `resolveProjectAccess(...) !== 'none'`. The memo is the existing per-list
  dedupe.
- `episodeAccess(tenantId, episode, subject, need: 'read' | 'write')` →
  `'ok' | 'hidden' | 'forbidden'`:
  - `hidden` when the subject lacks `workspace:read` in `episode.orgId`, or cannot read
    the episode's notebook. Doors answer the uniform 404; the run answers "not found".
  - `forbidden` when `need === 'write'` and the subject lacks `workspace:write`. Doors
    answer 403.
- `generateTargetAccess(tenantId, orgId, notebookId, subject)` for a NEW or re-run
  episode → `{ ok: true } | { refused: 'hidden' | 'forbidden' | 'notebook_has_no_sources' }`:
  `workspace:write` in `orgId`; the project exists in `orgId` and the subject's project
  level is not `none` (else `hidden`); and the project is a **provisioned notebook**
  (`notebookAccess(...)` non-null), else `notebook_has_no_sources`. An orphan cannot be
  a generation target. *(Corrected by the architect pass, finding 3: the first draft
  said "the notebook exists", which a project without a bound KB collection also
  satisfies; every such episode would then fail at run time with a message that blamed
  deletion or access.)*

Callers:

| Lane | Call |
|---|---|
| `GET /episodes/:id` | `episodeAccess(read)` |
| `POST /episodes/:id/publish`, `/unpublish`, `DELETE /episodes/:id` | `episodeAccess(write)` (**new**: the notebook check, `PODC93-4`) |
| `POST /episodes/:id/retry` | `episodeAccess(write)` then `generateTargetAccess` for the episode's org and notebook (an orphan or unprovisioned target is refused up front, never enqueued to fail later) |
| `GET /episodes` | org read, then `notebookReadableBy` per episode (unchanged behaviour, shared helper) |
| `POST /episodes` | `generateTargetAccess` |
| `openwop:podcasts.list` | org read, then the SAME per-episode filter as `GET /episodes` (**new**, `PODC93-3`) |
| `openwop:podcasts.produce` | `generateTargetAccess` |
| `ctx.features.podcasts` | D2 |
| public exits (`publicRoutes.ts`) | **unchanged**: gate only on the show + episode `published` flags. The publish door, now notebook-gated, is the single decision point for what becomes public |

The profiles and shows keep their org-scope rule: they are org config, not
notebook-bound. The chat tools keep their own org RESOLUTION (`resolveOrgScope` picks
the sole org when none is passed, and fails typed for the action); it evaluates the same
`resolveEffectiveAccess` as `orgAllows`, and the predicate they then apply is D1's.

### D2 — The run acts for its person (closes `PODC93-2`)

Every `ctx.features.podcasts` method resolves through `podcastsAccess`, with the run's
person (`scope.actingUserId`) as the subject:

| Method | Rule | Refusal |
|---|---|---|
| `authorizeGeneration({episodeId})` (**new**) | `episodeAccess(write)`; `generateTargetAccess` for the episode's org and notebook; the episode profile and its cast resolve in the episode's org | `{ error: { code, message } }` |
| `getEpisode` | `episodeAccess(read)` | `{ episode: null, refused: code }` |
| `getEpisodeProfile`, `getSpeakerProfile` | `orgAllows(read)` in the profile's org | `{ profile: null, refused: code }` |
| `listEpisodes` | the ADR 0832 floor (unchanged) plus the D1 per-episode notebook filter | filtered list |
| `recordEpisodeResult` | `episodeAccess(write)` | `{ found: false, recorded: false, applied: [], dropped: [], refused: code }` |
| `mixClips({episodeId})` (**signature change**) | `episodeAccess(write)`; muxes the episode's **stored** clips, never node-supplied URLs | `{ url: '', refused: code }` |

- **No person, no podcasts run.** Every supported starter carries an actor after D3: the
  route doors, the `produce` tool, `POST /v1/runs`, a builder or picker start, a schedule
  (ADR 0816 D8), a fork, a debug run or a redrive (re-stamped,
  `routes/runs.ts:2101-2118`, `workflowDebug.ts:280`, `:429-442`), and an executor resume
  (the actor is on the run row). An actorless run is refused with
  `podcast_run_needs_person`, read and write alike.
  *(Corrected by the architect pass, finding 7: the first draft said "there is no cause
  lane on any podcasts starter". Generic starters exist that would launch
  `podcasts.generate` by id with no actor: a sub-workflow child carries only
  `orgScopeSubject` (`executor/subWorkflowDispatcher.ts:303-321`), and host-event
  triggers, approvals, workflow-compose and kanban start runs the same way. They are
  refused by design: `podcasts.generate` is internal host machinery (D7), not a
  supported nested or triggered chain. A sub-workflow-child witness pins it.)*
  Notebooks kept actorless org-visible reads (ADR 1103 D2) because MCP and system jobs
  read notebooks; nothing reads podcasts without a person.
- **Refusal codes** (closed set, exported as `PodcastRunRefusal`):
  `podcast_run_needs_person`, `podcast_episode_not_found` (hidden, or gone),
  `podcast_write_forbidden`, `podcast_profile_missing` (the episode profile or its cast
  is gone, `PODC93-12`), `podcast_notebook_unavailable`, `podcast_notebook_has_no_sources`.
- **Read refusals carry their code.** A node forwards `refused ?? 'podcast_episode_not_found'`,
  so an actorless or in-flight-at-deploy run reports `podcast_run_needs_person`, not a
  misleading "not found". Reads never tell a run that a row exists in an org it cannot
  see: `hidden` maps to `podcast_episode_not_found`.
- **`authorizeGeneration` is the first thing the pipeline does**, so an unauthorized or
  unconfigured run fails before any paid call.
- **Every write is re-checked, and every writer fails on a refusal.** Authority is not
  cached from the first node: each `recordEpisodeResult` and `mixClips` call re-resolves
  (a membership removed mid-run stops the next write). One pack helper,
  `recordOrFail(pod, patch)`, is the only way a node writes: a result with `refused` (or
  `found:false`) fails the node typed with that code. `outline` and `transcript` record
  their Document refs through it (today they discard the result, `index.mjs:212-213`,
  `:262-263`), and `mix` records its audio through it (today its second write is
  ignored, `:383-385`). A refused write therefore stops the pipeline before the next paid
  call. *(Added by the architect pass, finding 5.)*
- **Fork, replay and resume** (lead review, 2026-11-13). A `:fork` (either mode) is a NEW
  run with a new `runId`, so it is not the episode's claimed run. Its served side-effect
  nodes (`synthesize`, `mix`) read their recorded results and write nothing. The FIRST
  node that runs live refuses, typed `podcast_run_not_claimed`. That is `select-content`
  (`authorizeGeneration`) for a fork from the start. For a fork whose fork point is
  after it, the refusing node is `outline`, `transcript` or `synthesize` (`checkWrite`,
  before its paid call). Every live writer refuses the same way (`recordOrFail`,
  `mixClips`). The fork therefore reads `failed` with a code, and the episode is
  unchanged. It never succeeds with nothing written (the
  `NBK92-2` shape). Regenerating is the doors' job, which claim first. A re-execution of
  the SAME run (an executor resume after a crash or a lease takeover) keeps its `runId`,
  so it passes the claim check. Its Document writes converge on the content-derived mint
  (ADR 0679), and its `recordEpisodeResult` writes are merges. Witness:
  `podcasts-episode-access.test.ts` R7b (fork refused typed, `callAI` never called,
  episode byte-identical; same-runId control allowed).
- **`mixClips` muxes what is stored** (architect finding 6). It takes the `episodeId`,
  re-checks write, and muxes `episode.clips`. A node can no longer concatenate arbitrary
  tenant media tokens into a new asset. `mix` distinguishes `refused` (fail typed) from
  the codec degrade (`url:''`, no `refused`: keep the playlist).
- **Audio provenance.** `recordEpisodeResult` clears `audioMediaRef` and
  `durationSeconds` whenever it replaces `clips` without an `audioMediaRef` in the same
  patch. A regeneration whose mux degrades then leaves no audio rather than the previous
  run's audio beside a new transcript; D5's publish readiness cannot pass stale audio.

### D3 — The doors start the run as the caller (closes `PODC93-1` root, `PODC93-8`)

`enqueueGeneration` passes `metadata.actingUserId` (the authenticated caller) and
`personalTenant` (when the request has one), the notebooks `startAsCaller` shape
(`features/notebooks/routes.ts:136-145`). The `produce` tool forwards `personalTenant` as
well as the plan exemption it already forwards. A caller with no identity already gets
the uniform 404 from the org gate; nothing is enqueued for them.

### D4 — Grounding is a typed failure, never a silent fallback (closes `PODC93-1`, `PODUX93-1`)

`select-content`:

1. calls `authorizeGeneration`; a refusal fails the node with its code;
2. requires `ctx.features.notebooks` (absent, or a disabled toggle's
   `host_capability_disabled` throw → `podcast_notebook_unavailable`). The "degrade to
   the briefing alone" branch is removed;
3. reads `notebooks.getNotebook`; `null` → `podcast_notebook_unavailable` ("the notebook
   was deleted, or the person this run acts for can no longer read it"). With D1's
   door rule an unprovisioned project never reaches here, so this message is true when
   it is shown;
4. calls `ask`; an empty `augmentedPrompt` → `podcast_content_empty` ("the notebook has
   no sources to ground on"). A briefing is a steer, not a source.

Every surface that creates an episode binds it to a provisioned notebook: the doors and
`produce` require one (D1). *(Corrected by the architect pass, finding 3: the first draft
said "nothing in the product creates an episode without a notebook", which was false:
`ProjectPodcastPanel` renders on any project's Podcast tab and passes a project id that
may have no bound KB collection. D1 now refuses that at the door with
`notebook_has_no_sources`, and the panel says so.)*

**Notebooks OFF** (architect finding 4). After D4 a podcasts run cannot succeed with
`notebooks` OFF. `POST /episodes` and `/retry` therefore refuse up front, **409
`notebooks_disabled`**, and the embedded panel and the Studio hide Generate with a
notice. `dependsOn: ['notebooks']` is **not** declared: it is a disable-LOCK
(`feature-dependency-parity.test.ts`), and a lock would make notebooks undisableable by
podcasts; the typed door refusal is the instrument, as the `documents` edge chose.

**Rejected:** keep the briefing-only path and stamp a `grounding` flag for the UI to
warn about. It keeps paying for an episode nobody asked for, and the warning is one more
thing a publisher can miss.

### D5 — Retry and publish say no when the state is wrong (closes `PODC93-5`)

*(Rewritten by the architect pass, finding 1 (Blocker) and finding 2. The first draft
read "the current run" through `projectStatus`, which maps an absent run to `queued`,
so a purged or never-dispatched run would have locked an episode forever, and a
check-then-act guard would not have stopped two concurrent retries.)*

- **A live run** is a run row that EXISTS and whose status is not terminal
  (`completed`, `failed`, `cancelled`). An absent run row is not live.
- **Retry** answers **409 `episode_published`** for a published episode ("unpublish it
  first; regenerating would replace the public audio"), and **409
  `generation_in_progress`** with the `runId` while a live run exists. A run stuck in a
  non-terminal state is escaped through the generic run cancel (`/runs/:id`), which the
  409 names and the Studio links; podcasts adds no cancel door of its own.
- **Retry claims the episode atomically.** The door mints the new run's id, then
  compare-and-swaps the episode from the `runId` it read (with its `error`/`errorCode`
  cleared in the same write) to the new id. Losing the swap is 409
  `generation_in_progress`. Only the winner calls `startWorkflowRun` with that id (the
  caller-owned `runId` input). If the start fails, the door swaps back best-effort; a
  dangling id names an absent run, which is not live, so retry stays possible. Create
  uses the same write (its episode is new, so it cannot lose). This also replaces the
  separate `clearEpisodeError` call and its ordering comment.
- **Publish** answers **409 `episode_not_ready`** unless the episode has an
  `audioMediaRef` AND no live run. Readiness is observable state, not "the run said
  done": an episode whose run row was purged after it finished, or a seeded or ingested
  episode with audio and no `runId`, stays publishable. D2's audio-provenance rule is
  what keeps stale audio from passing.
- **`produce`'s ignition key** adds the actor and the title (`PODC93-13`), so one
  person's call is never handed another person's run.

**Rejected:** let retry of a published episode auto-unpublish. It turns a "try again"
click into a public takedown; the person should do that on purpose.

### D6 — The failure code reaches the row (closes `PODC93-6`)

`failEpisode(pod, episodeId, code, message)` writes `errorCode` beside `error`. Three
sites must carry it, or the field is silently dropped (architect finding 9; the
validator-allowlist trap):

1. the surface's explicit pass-through object (`surface.ts:91-97`), accepting only a
   value matching `^podcast_[a-z_]+$` (a node-chosen code, never free text);
2. the service: the `patch` type, `EpisodeResultField`, the `asked` table and the merge
   (`podcastsService.ts:377-430`);
3. the clear: the D5 claim write clears both `error` and `errorCode`
   (`clearEpisodeError`'s early return on `error === undefined` would have missed a lone
   code; it is replaced, not patched).

The wire type gains `errorCode?: string`. The `pack-surface-arg-parity` fixture
(`callSites`, `assertedPairs`) moves with the new keys and methods.

### D7 — The chain is host machinery (closes `PODC93-7`)

`core.openwop.workflows.podcasts` marks `podcasts.generate` `internal: true` (the row 92
`NBK92-3` precedent). The doors start it by id; it leaves the gallery and the `/` picker.
Version moves, each named (architect finding 10; the per-node pins are not uniform):

- nodes: `select-content` 1.1.0 → 1.2.0, `outline` 1.1.0 → 1.2.0, `transcript` 1.1.0 →
  1.2.0, `mix` 1.3.0 → 1.4.0 (`synthesize` 1.2.0 → 1.3.0 only if its code changes:
  it shares `failEpisode`, so it does). Pack `feature.podcasts.nodes` 1.2.0 → 1.3.0;
  `features/packPins.ts` follows;
- chain pack `core.openwop.workflows.podcasts` 1.0.2 → 1.1.0 and the chain 1.0.1 →
  1.1.0, the typeId pins in its DAG moved to the versions above; checked against the
  registry for a `core.openwop.workflows.*` version collision;
- the agent pack prompt (`prompts/podcast-producer.md`) states that an empty notebook
  fails typed (no pack logic change, a prompt-text change and its version bump);
- regenerated and shown before commit: `packs/.steward-manifest.json`, schema `$id`s,
  `executor/sideEffectFloor.generated.ts` (re-checked, expected unchanged: the
  `side-effectful` set does not move); all `scripts/check-pack-*.mjs` run.

### D8 — Erasure for `podcasts:show` (closes `PODC93-10`)

The owner decision `RECORDED_DEBT` asked for: **scrub the person, keep the show.**
`erasePodcastsSubject(tenantId, subjectKey)`:

- `createdBy` matching a `subjectKeyForms` form → the tombstone `erased:subject`. The
  literal `'unknown'` (`routes.ts:330`, no actor) is no one's and is left;
- an email subject key (`subjectKey.includes('@')`, the `crm/erasure.ts:176`
  convention) equal case-insensitively to `ownerEmail` → `ownerEmail` and `ownerName`
  removed. The feed then omits `<itunes:owner>` (`podcastFeed.ts:88`) until the operator
  enters a new contact; that is valid RSS and the honest result of an erasure;
- **residual, stated:** the public feed (`max-age=600`) and the bot prerender cache (up
  to an hour) keep the erased contact until they expire.

The show, its episodes and its public URLs are org business records and stay.
Registered with `registerSubjectEraser`, added to the manifest with a ledger edge, and
moved from `RECORDED_DEBT` to covered in `subject-erasure-feature-stores.test.ts`.

**Rejected:** delete the show. It would take an org's whole public channel down because
one person who once created it asked to be forgotten.

### D9 — No hard-coded model (closes `PODC93-9`)

`createEpisodeProfile` stores `outlineModel` / `transcriptModel` only when given;
`EpisodeProfile` types them optional (backend and `podcastsClient.ts`). With none, the
nodes already pass `model: undefined` and the host fills provider and model (ADR 0903);
the failure messages say "the run's default model" instead of interpolating
`undefined`. Existing rows keep their stored value.

### D10 — The Studio tells the truth about state (closes `PODUX93-2`, `-3`, `-4`, `-5`, `-7`; part of `-6`, `-10`)

All inside the existing lazy `PodcastStudioPage` / `ShowsManager` and the `podcasts`
namespace (4 locales):

- a failed episode renders `<Notice variant="danger">` with translated copy for each
  known `errorCode` (what happened, what to do), the raw message behind a details
  disclosure, and the old generic copy for an unknown code;
- the clip playlist plays through (`play()` on advance once playback started) and resets
  when the clip list changes;
- "Retry" only on failed episodes whose notebook still exists. A done, unpublished
  episode offers "Regenerate" behind a danger confirm. A published episode offers
  neither, and says "Unpublish to regenerate";
- Publish only for an episode with audio and no live run. The published chip reads
  "Published (show is a draft)" as a warning chip when the bound show is unpublished.
  Episode unpublish and show unpublish ask first;
- status changes from polling are announced (`announce()`): "'{title}' is ready" /
  "'{title}' failed";
- `canWrite` starts unknown (no write controls) until a read answers;
- the door's 403 / 404 / 409 codes (`episode_published`, `generation_in_progress`,
  `episode_not_ready`, `notebooks_disabled`, `notebook_has_no_sources`) map to
  translated copy instead of the server's English; Generate is hidden with a notice when
  notebooks is off, in the embedded panel too.

## Migration

None in code. Episode rows gain optional fields only. Runs in flight under the old lane
meet D2's refusal at their next podcasts call and fail typed
(`podcast_run_needs_person`). Old tenant copies of the chain at the old node pins run
the new node code (`runInsert.ts:167-172` warns, does not refuse), so D2 and D4 apply to
them and to forks of old runs.

Operator review: the prod queries count `podcasts.generate` runs by whether they carry an
actor, and episodes by notebook visibility and published state. A done episode generated
ungrounded under `PODC93-1` is not detectable after the fact (no grounding was recorded).
The `PODC93-4` population IS detectable: **published episodes whose notebook is now
private**. If that query returns rows, the lead reviews them with the operator; this ADR
does not unpublish anything automatically.

## Alternatives weighed

- **Teach the ADR 0832 floor to resolve an episode's org from its id.** The floor is
  generic and keyed on `args.orgId` by design (ADR 0832 residue); a per-surface id→org
  resolver in the host is the abstraction notebooks also declined. And the floor only
  checks membership, not the notebook rule or write authority.
- **Pass `orgId` into every podcasts surface call so the floor fires.** The org would come
  from the run's inputs, which is the thing a cross-org run controls; the node would have
  to read the episode to learn it, which is the unauthorized read.
- **Keep actorless reads (the notebooks D2 table).** Nothing legitimate reads podcasts
  without a person, so the extra lane is attack surface with no user.
- **A `generationLock` field with a staleness timeout** instead of the runId CAS. Two
  fields to keep consistent and a clock to tune; the runId already names the generation.

## Implementation plan

| Phase | Scope | Witness (behaviour, sabotage-shown red against `origin/main`) |
|---|---|---|
| P1 backend | D1, D2, D3, D5, D6, D8, D9; agent tools | `podcasts-episode-access.test.ts` (new), multi-person `org:` tenant, demo mode off: cross-org run read and write refused; a write-less runner refused; actorless and sub-workflow-child runs refused `podcast_run_needs_person`; private-notebook non-member refused at retry / publish / unpublish / delete (404) and filtered from the `list` tool; unprovisioned project and notebooks-off refused at the door; retry 409s (published, live run) and NOT for an absent run; two concurrent retries start one run; publish 409 without audio and allowed for a seeded episode with audio and no run; route-started run carries the actor and `personalTenant`; `mixClips` muxes stored clips only; clips replace clears stale audio; the erasure test. Updated: `podcasts.test.ts`, `notebooks-podcasts-agent-tools.test.ts`, `adr0390-podcast-distribution.test.ts`, `adr0390-podcast-prerender.test.ts`, `podcasts-writer-replay.test.ts`, `subject-erasure-feature-stores.test.ts`, the eraser manifest test, `feature-dependency-parity.test.ts` (the new edge) |
| P2 packs | D2 node half, D4, D6, D7; version bumps, steward manifest, pins | `podcasts-generation-pipeline.test.ts`: private notebook → `podcast_notebook_unavailable`; empty notebook → `podcast_content_empty`; deleted profile fails before `callAI`; a refusal after `outline` stops `transcript` before `callAI`; refused `mixClips` fails `mix` typed while the codec degrade still succeeds; `errorCode` reaches the row. Fixtures: `pack-surface-arg-parity.json` |
| P3 frontend | D10 | Studio tests: error copy by code, playlist advance, regenerate / publish gating, announce, draft-show chip, notebooks-off notice, `canWrite` unknown |
| Docs | | `FEATURES.md` podcasts rows, `docs/steward/LLM-EXCHANGE-AUDIT.md` podcasts row, the tracker row, the grade record's closing grades |

## Open questions

- [x] Does any podcasts run exist without an actor in prod, and are any published
  episodes bound to a now-private notebook? **No: 0 runs and 0 episodes ever** (measured
  2026-11-13). The § Migration operator review is not needed.
- [x] Should an orphan episode (notebook deleted) stay publishable? Yes, if it has audio:
  the ADR 0086 orphan rule. It cannot be regenerated: the retry door answers 409
  `notebook_unavailable`, and the episode wire carries `notebookMissing` so the Studio
  offers no Retry or Regenerate for it. *(Corrected by the UX re-grade, `PODUX93R-1`: the
  first cut claimed the Studio hid Retry with nothing implementing it, and the door's 404
  read as "it may have been deleted, refresh", a loop.)*

## Architect pass (2026-11-13, independent, read-only)

Verdict: approve after fixes. 1 Blocker, 4 High, 5 Medium, 6 Low, all folded in above.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Blocker | D5 read "the current run" via `projectStatus`, which maps an absent run to `queued`: purged or stuck runs lock retry forever; "run done" refuses seeded and ingested episodes | D5 rewritten on observable state (live run = existing non-terminal row); publish = audio and no live run; stuck-run escape via the generic cancel |
| 2 | High | Retry guard was check-then-act | runId compare-and-swap claim, then start with the caller-owned id |
| 3 | High | "Nothing creates an episode without a notebook" was false (unprovisioned projects) | `generateTargetAccess` requires a provisioned notebook; 409 `notebook_has_no_sources` |
| 4 | High | D4 made notebooks a hard dependency silently | door 409 `notebooks_disabled`; FE gates Generate; `dependsOn` deliberately not declared, with the reason |
| 5 | High | Only `mix` read write refusals | one `recordOrFail` helper; every writer fails typed |
| 6 | Medium | `mixClips` took node URLs; refusal looked like the codec degrade; stale audio | `mixClips({episodeId})` muxes stored clips; `refused` distinct; clips replace clears audio |
| 7 | Medium | Generic starters (sub-workflow child, triggers, approvals, compose, kanban) are actorless | named in D2 as refused by design; sub-workflow witness |
| 8 | Medium | Read refusals dropped their code; orphan retry fails late | `refused` carried on reads; retry refuses orphan targets up front |
| 9 | Medium | `errorCode` must pass three allowlists | named in D6; fixture update in P2 |
| 10 | Medium | Plan omitted pins, manifests, prompt, docs, tests | listed in D7 and the plan |
| 11 | Low | messages would print "(undefined)" | D9 wording |
| 12 | Low | D8 matching rule and residual caches unnamed | named |
| 13 | Low | "unauthenticated retry is a 401" was wrong | D3: the org gate 404s |
| 14 | Low | the `PODC93-4` population is detectable | § Migration operator review |
| 15 | Low | public exits missing from D1's table | added |
| 16 | Low | the ADR cited an uncommitted path | queries summarised in § Migration |

## Re-grade round 1 (2026-11-13, independent, read-only) — folded in

Code B+, UX B+ on the first cut. What they found and what changed:

| Finding | Sev | Change |
|---|---|---|
| `PODCD93-1` the published / one-run rules lived only at the retry door; a direct `POST /v1/runs`, a fork or a redrive could still replace a published episode's audio | High | **D2 amended:** a run-lane WRITE also needs `episode.runId === scope.runId` (the door's claim is the single authority, `podcast_run_not_claimed`) and an unpublished episode (`podcast_episode_published`). A fork of a generation run therefore writes nothing; regenerating is the door's job. |
| `PODCD93-2` two racing retries could both start (the first claim's run row does not exist yet) | Medium | closed by the claim rule: the loser's run is refused at its first call |
| `PODCD93-3` the `produce` tool still wrote `runId` after starting, unguarded | Medium | the tool pre-mints and claims before the start, as the door does; `setEpisodeRun` deleted |
| `PODCD93-4` a failed start erased the last failure | Low | the release restores `error` / `errorCode` |
| `PODCD93-5` a create whose run never started stayed "queued" forever | Low | the door deletes the episode, as the tool already did |
| `PODCD93-6` door and tool asked different notebooks questions | Low | the door uses `resolveOne` (toggle and plan), the predicate the tool's kit answers from |
| `PODCD93-7` paid model / TTS calls ran before the first refused write | Low | new `checkWrite` surface method; `outline`, `transcript` and `synthesize` ask it before their paid step |
| `PODCD93-8` the eraser could skip a row it lost the race on and report clean | Low | three attempts, then a throw (the DSAR fan-out counts it) |
| `PODUX93R-1` Retry offered on an orphan, looping on a 404 | High | 409 `notebook_unavailable` + `notebookMissing` on the wire; no button, a line saying why |
| `PODUX93R-2` the failure Notice made every failed row an assertive alert | Medium | plain text; the transition is announced once |
| `PODUX93R-3` a landed recheck spoke twice | Low | the generic "finished" line only when nothing landed by name |
| `PODUX93R-4` ShowsManager `canWrite` still defaulted true; empty states instructed read-only members | Medium | `null` until read; read-only empty-state copy |
| `PODUX93R-5` ShowsManager toasted server English | Medium | shared `podcastsErrors.ts` (`requestErrorText`) for both panels |
| `PODUX93R-6` "regenerate to try again" for a mixed-codec episode | Low | copy says what happened; "may help" |
| `PODUX93R-8` green chip asserted over a failed shows read | Low | neutral chip |
| `PODUX93R-9` the embedded panel announced other projects' episodes | Low | announces scoped episodes only |

Round 2 (code A−): `PODCD93-11` select-content no longer attempts a row write for a
claim/published refusal; `PODCD93-13` an episode whose run row is gone but whose audio is
stored projects `done`; `PODCD93-12` the fork policy is stated in D2 above, and ADR 0679
gets a pointer: its "a fork reuses the Documents" now applies only to a same-run
re-execution, because a fork is refused at its first live node. `PODCD93-14` filed (the
`personalTenant` and sub-workflow witnesses; FE code lists are hand-mirrored; a surface
with no `runId` skips the claim, which is reachable only from tests and from actorless
builders that `podcast_run_needs_person` already refuses).

Round 2 (UX A− once one existing test was corrected): `PODUX93R-12`: the
`podcastsFailureRecovery` "Check again finds it finished" case asserted the generic
"Finished" line, which R3 deliberately no longer speaks when the episode is announced by
name. The test now asserts the by-name line and the absence of "Finished", and a new case
pins "Finished" for a cohort that vanished. `-13`: `publishNeedsAudio` no longer names a
cause it cannot know. `-14`: landed-by-name is computed over the scoped list. es nit fixed.
Filed: `-15` (failure lines say "try again" to read-only members), `-16`/`-7`
(subject-less not-found), `-17` (focus), `-18` (more witnesses: embedded notebooks-off,
running→failed announce, playlist reset).

**Closing grades (independent, round 2): CODE A−, UX A−. WF A− (own, labelled: every
Blocker closed and witnessed; residue Low).**

Filed: `PODUX93R-7` (a subject-less not-found line), `PODUX93R-10` (focus after an
action; with `PODUX93-8`), `PODCD93-9`'s `personalTenant` witness (the test login does not
set one) and sub-workflow-child witness (refused by the same `actingUserId` check R3
pins), `PODCD93-10` (header wording, the three-lookup `generateTargetAccess`).

## Not decided here (residue)

- `PODC93-11` (Medium): the public transcript serves the newest Document version. Pinning
  the version at publish needs a documents read-by-version that this host does not expose
  on the service yet. Filed (was `DOC2CD-4`).
- `PODC93-14` (N+1 run reads), `-15` (free-text TTS provider), `-16` (orphan loses its
  transcript silently), `-17` (unfenced briefing): Low, filed as written.
- `PODUX93-8` (focus after delete/edit), `-9` (named delete labels), `-11`..`-15`: filed.
