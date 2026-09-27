# ADR 0458 — KickTodo chat-first challenge authoring: ignite the factory on the existing engine

Status: implemented
Date: 2026-07-20
Authors: Claude (session with David), from David's 2026-07-20 direction
Relates: ADR 0415 (Challenge Factory), ADR 0437 (Creator Studio experience), ADR 0441 (candidate⇄draft binding), ADR 0442 (KickBot named-agent composition), ADR 0058 (chat-drivability = agent + nodes), ADR 0308/0315 (agent tools), ADR 0310/0319 (canvas chassis/toggles), ADR 0411 (video generation), ADR 0447/0448/0449 (platform seams), ADR 0068/0074 (approvals)

---

## 1. Context — the D- verdict and what the audits actually found

On 2026-07-20 David reviewed the shipped Creator Studio and graded the KickTodo
initiative **D-**: `/kicktodo/studio` reads as "a duplicate/parallel
implementation to our core architecture," with "no evidence of deep web
research and collaborative AI agent collaboration." His original direction —
restated as the requirement of this ADR — was:

> The AI chat is the interface. A named course/challenge-builder agent talks
> the creator through the concept in the chat. That agent has a
> course/challenge-builder workflow in its assigned workflows and feeds the
> idea through it. The workflow composes EXISTING nodes: deep web research on
> the subject → distill into a course/challenge outline → a node set iterating
> each lesson/day → generated visual/video assets. HITL checkpoints validate
> every step — each lesson/day as it is built, and every generated asset. At
> minimum the builder should have been a canvas type.

Three adversarial audits (creator pipeline, primitives sweep, experience
layer; 2026-07-20, this session) established the precise failure. It is
**disconnection, not duplication**:

- The factory's research and plan-generation workflows are real
  `WorkflowDefinition`s composing real nodes (`core.web.search` is the live,
  SSRF-guarded provider node; `plan-generate` is a schema-validated
  `ctx.callAI` node; `decompose` writes through the single challenge owner;
  publication rides the shared approvals service with separation of duties).
  **But nothing anywhere creates a run of either workflow.** The REST research
  route records caller-supplied evidence instead of searching; the Studio's
  authoring buttons deep-link chat personas whose tool allowlists
  (`kicktodo.today`, `kicktodo.progress`) cannot drive anything; the media and
  simulation stages do not exist; "six gates" is four deterministic checks.
  Declared orchestration with no orchestrator — capability theater.
- The experience layer already ships everything the target needs: run-from-chat
  (`workflow_run` messages with live progress panels), inline HITL interrupt
  cards with durable decision records, agents-with-assigned-workflows, a
  trait-based canvas chassis that accepts new types with zero core edits, and
  image/video generation nodes behind one host seam each.
- The primitives sweep found **zero hard parallel implementations** across the
  other eight kicktodo packages — but one absent compliance seam (no
  retention purgers, no subject-erasure wiring anywhere in kicktodo) and one
  borderline-parallel scheduler (`sessionService`).

So the remediation is not a rewrite of the domain machinery — it is wiring
the declared engine to real drivers, moving the interface into the chat and a
canvas, deleting the bespoke remnants, and closing the compliance hole.

## 2. Decision

Rebuild challenge authoring as **conversation-driven orchestration over the
existing engine**, entering only through named `ARCHITECTURE.md` seams:

### 2.1 The Challenge Author agent (pack persona; capability at core)

- A new persona in `packs/feature.kicktodo.agents`: **Challenge Author** — the
  named agent a creator converses with in the ONE chat. Per the agent law
  (ADR 0023/0031), nothing is hard-coded to the persona: a
  `challenge-authoring` capability lives at the core agent level and is
  activated via `agentProfile.capabilities`.
- Real tools (ADR 0308 pattern, `kicktodo-creator/agentTools.ts`), allowlisted
  to this pack only — never the ADR 0315 default-on baseline:
  - `openwop:kicktodo.candidates` (read own candidates + stage state),
  - `openwop:kicktodo.factory.run` (dispatch the factory workflow for a
    candidate — see 2.2),
  - existing `documents`/KB reads as needed for brief context.
- **Authorization is the route's predicate, shared:** every tool calls the same
  `requireKicktodoManage` helper the authoring routes use, and fails EMPTY
  without an acting user holding manage authority. A participant reaching the
  agent cannot drive the factory. (Architect review CRITICAL-3.)
- The agent carries the factory workflow in its **assigned workflows**
  (`workflows: []` on its roster entry), so the chat's existing
  run-mention/assigned-workflow dispatch is the ignition path — no bespoke
  trigger surface.

### 2.2 The challenge-factory workflow (versioned builtin, existing nodes)

One packaged, versioned builtin `openwop-app.kicktodo.challenge-factory`
(PRD §8.2 small-stable-set precedent — parameterized by candidate id, never
generated per challenge), composing the EXISTING catalog:

1. **Research** — `research-frame` → `core.web.search` (+
   `ctx.webResearch.fetchBatch` for page content) → `source-normalize` →
   `evidence-graph`; optionally `feature.agent-knowledge.nodes.ingest` to give
   the author agent retrieval over the dossier. (This is the already-declared
   `openwop-app.kicktodo.research` spine, invoked at last.)
2. **Distill → outline** — `plan-generate` (existing schema-validated node) →
   `core.chat.approvalGate` — the creator approves the outline **in the
   conversation** (interrupt card inline; durable decision record).
3. **Per-lesson build** — `core.openwop.data.array-map` over plan days →
   `core.subWorkflow` per lesson: lesson content refinement (`core.ai.*`
   structured nodes) + optional assets via `core.openwop.ai.image-generate` /
   `core.openwop.ai.video-generate` → media persisted as Media-library assets.
4. **Checkpoints** — HITL gates between lessons via the interrupt/approval
   primitives; **gate cadence is a run input** (`checkpointEvery`:
   outline-only | per-week | per-day), because thirty sequential approvals is
   approval fatigue, and a fatigued gate is no gate. (Architect HIGH-5.)
5. **Asset review** — generated media passes `core.workflow.assetDecisionGate`
   so every visual/video is human-approved before it attaches to a lesson.
6. **Validate → decompose** — existing `plan-validate` → `decompose`
   (deterministic draft id, ADR 0441 — re-runs collide instead of orphaning).
7. **Submit — never publish** — a new thin node
   `feature.kicktodo.nodes.submit-publication` whose ONLY effect is raising
   the existing separation-of-duties `challenge-publish` approval.
   **No in-run step can complete publication** (exchange law: model output
   reaches durable state only through closed-world validation and/or a human
   gate; architect CRITICAL-2). The approval is decided in the unified
   reviews inbox by an identity distinct from the submitter, exactly as
   `publishService` already enforces.

**Simulation becomes real or unclaimed:** the three sim personas
(`sim-newcomer`, `sim-time-poor`, `sim-skeptic`) are convened as bounded
handoff stages (the ADR 0442 P5 convene precedent) against the validated plan,
returning structured verdicts recorded on the candidate; the "simulation"
gate then reads those verdicts. Until this stage lands, no surface claims a
simulation gate.

**Idempotency:** lesson artifacts and generated assets key deterministically
(`<candidateId>:day-<n>`), so suspend/resume/retry amends rather than
duplicates (architect HIGH-4; the GEN-2 lesson).

### 2.3 The `challenge-outline` canvas type (structured editing between turns)

- New canvas type on the chassis `tree` trait (modules → days, drag-reorder,
  `OutlineTree`), registered per ADR 0310 (`definition.tsx` +
  `registerCanvasEditorRoutes` + gallery row), collab-enabled per ADR 0359.
- **Single source of truth (architect CRITICAL-1):** the candidate's
  **validated plan revision remains the ONLY truth** — `decompose` never reads
  anything else. The canvas doc is an explicitly-labeled *working draft*;
  "Apply" runs the existing `plan-validate` surface op and persists a new plan
  revision through the candidate owner (draft → validate → persist, the
  workflow-author law). The canvas never becomes a second plan store; a stale
  canvas draft is visibly stale, never silently authoritative.
- Toggle: rides the existing `kicktodo-creator` toggle (deviation from the
  ADR 0319 per-type-toggle pattern, stated deliberately: the canvas is
  meaningless without the factory, and KickTodo already carries nine toggles).

### 2.4 Studio demolition (what pages remain)

- **Delete** the bespoke submit/complete publication buttons — the
  `challenge-publish` approval already projects into the unified reviews
  inbox / `ReviewCard`; that inbox is the publication UI. (Highest-value
  dedup; audit-experience.)
- **Intake moves to chat** — "create a challenge" is a conversation with the
  Challenge Author (who creates the candidate via its tool); the intake form
  goes.
- The candidate workspace **shrinks to a read-only provenance view** (spine,
  dossier, monitor) pending David's standing call on full demolition; Creator
  Insights stays (honest reporting on shared primitives). The manual
  evidence-POST research route survives only as a clearly-labeled import
  lane — the run is the primary path.
- FE media-review gap closed: `chat/reviews/AssetPreview` renders image/video
  inline (mime discriminator added to `ReviewAsset`) so an approver actually
  sees the asset the gate is gating.

### 2.5 Phase 0 — compliance seam (redesign-independent, ships first)

- Register **retention purgers** for every kicktodo durable collection and
  wire **subject erasure** for all subject-keyed kicktodo data (check-ins,
  evidence, enrollments, invites, circles, profiles/reviews, contact links).
  Open question OQ2 resolves the mechanism (single-resolver composition vs.
  feeding the existing resolver) — determined by reading the seam, not
  guessed.
- `sessionService` routes any future firing through the scheduling owner
  (`registerJob`), never a loop over its own rows (audit-primitives #2).
- `kicktodo-entitlements` collection rename to `challenge-access` happens via
  the normalize-on-boot migration pattern (#2269 precedent) — or is explicitly
  declined with a doc note; live durable keys are never renamed casually.

## 3. What this deliberately does NOT do

- No new run/event/schedule/agent/credential model; no wire change; **no RFC
  needed** (everything is packs + host-extension + existing interrupt kinds).
  A future in-run envelope kind for challenge intent would be an OpenWOP RFC
  first.
- No per-challenge generated workflows (PRD §6.1 stands).
- No deletion of the A-grade domain machinery (validators, honesty gates,
  derived citation hashes, approvals wiring) — it is finally *used*.
- No second chat, no bespoke AI editor, no new hue.

## 4. Alternatives considered

- **Patch the Studio pages** (add run buttons to the existing workspace):
  keeps the wrong interface, violates the chat-first direction, leaves the
  agent toothless. Rejected.
- **Full demolition of all Studio pages immediately**: loses honest read-only
  provenance/insights surfaces that are legitimately page-shaped
  (audit-experience §4) before the chat flow proves out. Deferred to David's
  explicit call (OQ1).
- **A bespoke orchestrator service driving the pipeline server-side without
  runs**: parallel to the executor; categorically rejected.

## 5. Phases

| Phase | Contents | Gate |
|---|---|---|
| **0** | Retention/erasure seam; sessionService scheduling discipline; entitlements-rename decision | none — ships immediately (compliance) |
| **1** | Challenge Author agent + tools (+ shared authz predicate); `challenge-factory` builtin (research→outline→approve→validate→decompose→submit); run-from-chat | Phase 0 merged |
| **2** | Per-lesson iteration + checkpoint cadence input; image/video asset stages + `assetDecisionGate`; `AssetPreview` media renderer + mime; simulation stage over convened sim personas | Phase 1 usable end-to-end |
| **3** | `challenge-outline` canvas type (working-draft semantics, apply-through-validate) | Phase 1 |
| **4** | Studio demolition per §2.4; route/nav cleanup; deprecation notes | Phases 1–2 live (never demolish before the replacement works) |

Each phase lands with route-level tests (authz through HTTP), a
`promptCatalogParity` pin for the Challenge Author prompt, phantom-tool-id
lint coverage for new tool ids, and one end-to-end factory-run test driving
research→outline→gate→decompose→submit against the stub-honest fallbacks.

## 6. Open questions

- **OQ1 (David):** Studio candidate workspace — full demolition, or keep the
  read-only provenance shell? (Plan default: shrink to read-only.)
- **OQ2:** subject-erasure mechanism — does the seam compose multiple
  resolvers, or does kicktodo feed the single existing resolver? Resolve by
  reading `host` seam code at Phase 0 implementation.
- **OQ3:** checkpoint-cadence default (`per-week` proposed) and whether the
  outline approval is ever skippable (proposed: never).
- **OQ4:** whether the Challenge Author replaces the three factory deep-link
  personas in the pack, or composes them as convened specialists (proposed:
  compose; they become its convene targets, mirroring KickBot).

## 7. Success criteria

A creator with manage authority can, entirely inside the ONE chat: describe a
challenge concept to the Challenge Author → watch a real run perform live web
research → approve the outline on an inline card → watch lessons build with
checkpoints at their chosen cadence → approve generated media on cards that
show the media → and see a `challenge-publish` approval appear in the reviews
inbox for a *different* identity to decide. Every artifact traces to the run;
no bespoke pipeline surface remains; DSAR erasure reaches every kicktodo
store.

---

## Implementation record

### Phase 0 — compliance seam (2026-07-21)

Shipped exactly as §2.5, with three recorded resolutions:

- **OQ2 RESOLVED:** the erasure seam composes — `registerSubjectEraser` and
  `registerSubjectKeyResolver` are both idempotent registries. Every kicktodo
  package registers ONE eraser (core additionally registers the
  subject⇄contact key resolver over the ADR 0449 bridge, both directions,
  store-backed only). Registration runs from `feature.ts` `registerRoutes`
  regardless of toggle state, so an off-toggled tenant stays erasable.
- **Anonymize-not-delete** where money-truth or provenance must survive:
  per-buyer entitlements re-keyed under a deterministic `erased:<hash>`
  subject (write-new-then-delete-old — a mid-way failure can duplicate but
  never lose the money record; retry self-heals); creator candidates and
  publication acts keep rows, sever the person link.
- **`onEnrollmentDeleted` lifecycle seam** (house ADR 0288 contract) added in
  kicktodo-core and fired from the single enrollment-delete path; integrations
  subscribes wearable-rule cleanup to it — the eraser-ordering race found in
  review is closed at the owner, not by registration order.
- **Entitlements rename DECLINED** (correction to §2.5's option): live durable
  keys; doc-notes at the collection + `host/entitlementSeam.ts` vocabulary
  distinction instead.
- Retention purgers registered only where aged `confidential-pii` exists
  (check-ins, evidence, coach proposals); every omission carries a reason
  comment at the registration site.
- `sessionService` arms T-minus reminders as one-shot scheduler-owner jobs
  (deterministic ids, disarmed on cancel/erase); delivery-node wiring deferred
  to Phase 2 (pack pins frozen at 1.13.0 this phase) — the job carries full
  context so no reschedule is needed.
- Drive-by: fixed a latent flake in `kicktodo-projections.test.ts` (a bare
  `'72'` non-containment assertion collides with random uuid hex; now a
  decimal sentinel).

### Phase 1 — ignition (2026-07-21)

Shipped per §2.1–2.2 with three recorded decisions from the contract scout's
blockers:

- **Tool-dispatched runs render inline via the authoritative embed**: the
  `openwop:kicktodo.factory.run` tool persists a server-side
  `{kind:'workflow_run', runId}` conversation turn (the
  `conversationExchange` pattern) in addition to stamping
  `metadata.actingUserId` + `metadata.chatSessionId`. Best-effort — a turn
  persist failure never kills the run.
- **Ignition is the tool, not a per-agent mention filter** (correction to any
  §2.1 implication otherwise): the chat's `/`-mention catalog is tenant-wide
  and never reads `roster.workflows[]`; building an agent-scoped mention
  filter is net-new FE explicitly NOT built. `workflows:
  ['openwop-app.kicktodo.challenge-factory']` on the Challenge Author's roster
  entry is honest portfolio metadata (profile Workflows tab, run-now).
- **Evidence grounding is bag-wired**: the `evidence-graph` adapter now sets
  `evidenceSummary` (derived ONLY from the recorded dossier; explicit
  `'no recorded evidence'` marker when empty) which `plan-generate` consumes —
  the KTFULL-B4 precedent.

Landed: `challengeAuthorService` (per-tenant named agent, deterministic
roster id, `challenge-authoring` added to the core `AgentCapabilityId` union
+ capability module, heartbeat off, review autonomy); the
`openwop-app.kicktodo.challenge-factory` builtin (research spine →
plan-generate → `core.chat.approvalGate` outline gate → plan-validate →
decompose → `submit-publication`); `hasKicktodoManageAuthority` extracted so
routes and tools share ONE predicate; tools `openwop:kicktodo.candidates`
(read, fail-empty) + `openwop:kicktodo.factory.run` (action, typed errors);
pack `feature.kicktodo.agents@1.4.0` (Challenge Author persona + prompt,
prompt-parity pinned) + `feature.kicktodo.nodes@1.14.0`
(`submit-publication` thin node — raises the separation-of-duties approval,
no completion path). E2E test executes every factory node including gate
resolution and the rejection path.

### Phase 2 — checkpoints, media, simulation (2026-07-21)

Shipped with four scout-verified corrections to §2.2's assumptions:

- **Bounded batch-cadence gates, not dynamic per-lesson gates** (§2.2 step 3-4
  correction): the executor is an acyclic DAG (no node re-entry) and re-invoke
  suspensions seed exactly ONE resolution per resume, so a node cannot chain
  N gates and a static graph cannot hold dynamic-N of them. The factory now
  carries a `checkpoint-plan` stage + up to FOUR fixed checkpoint slots
  (build-batch → parent `core.chat.approvalGate` → typed-fail on reject),
  with `checkpointEvery` ('outline-only' | 'batched') as the run input.
  Per-day cadence is approximated by ≤4 batch checkpoints; TRUE dynamic
  per-lesson gating needs an executor change (accumulate resolutions from
  event history) — deliberately NOT taken here (replay-critical; its own ADR
  if ever wanted). The checkpoint barrier is `decompose ← fail-slots` with
  `none_failed` (a convergence-once-visited scheduler constraint found and
  solved in test through the live scheduler).
- **All gates live in the parent run** — child-run interrupts surface to the
  parent as opaque plumbing (no prompt/artifact), so children only build.
- **Media keying is an app-owned pointer** (`<candidateId>:day-<n> → assetId`
  on the creator side, replace-on-retry) — the media surface mints uuids and
  offers no caller key; a media-contract change was rejected in favor of the
  pointer. `AssetPreview` now renders image/video inline on approval cards
  through the SHARED `mediaSrc` XSS allowlist (extracted to one module);
  `ReviewAsset` carries `mimeType`/`url` with the host projection in lockstep.
- **The simulation gate is now REAL** (closes the 0415 "six gates" theater):
  the three sim personas carry a closed-world `sim-verdict` return schema
  (agents@1.5.0), dispatch as parallel agent-runner nodes with per-node
  `offerTools: []` confinement (race-free by construction — no stored
  override), `sim-collect` records persona-keyed verdicts verbatim, and
  `publishService.assertGates` blocks on any 'block' (including a
  block-severity finding under a lenient headline verdict — defense in
  depth). agent-runner gains an additive structured `result` output.
- **Schema honesty drive-by**: `core.openwop.ai` image-generate's output
  schema declared `contentBase64` while the runtime emits `url` — fixed
  (1.3.1); a model reading that schema is no longer lied to.
- Packs: nodes@1.18.0 (checkpoint-plan, lesson-batch-build, sim-collect,
  lesson-media-persist), agents@1.5.0. Lesson content is validated by an
  in-node closed-world validator (a lesson is gate-reviewed node output,
  never durable domain state — the plan revision remains the SSoT).

### Phase 3 — challenge-outline canvas (2026-07-21)

Shipped with three scout-verified corrections to §2.3:

- **The tree trait is not standalone** — a tree type is frames + tree + a
  registered component catalog. The outline rides ONE synthetic frame holding
  the tree (the slides `FramesTreeDefinition` pattern).
- **"Modules → days" corrected to a FLAT days tree** — the domain has no
  module concept; alternatives are the tree's second level; meta / outcomes /
  achievements edit via doc-level property widgets. Lossless by construction
  (property-tested round trip, incl. the empty-alternatives normalization).
- **The durable plan revision now EXISTS** (the §2.3 SSoT sentence made
  real): `FactoryCandidate.plan {plan, revision, recordedAt}` is stamped
  inside the ONE shared derive path (`deriveAndBindCandidateDraft`) every
  time a draft is derived — plan is the source, the ChallengeDefinition
  draft its deterministic derivation; nothing else writes it. The canvas is
  a working draft: **Apply** = doc→plan → `validatePlan` (422 defects
  verbatim to the human) → persist revision → re-derive the draft; a
  published draft is a typed 409 at both call sites.
- One canvas per candidate via `ensureCanvasForTenant` with the
  deterministic id `canvas-outline-<sha(tenant|candidate)>` (no back-link
  race); ensure returns `seededFrom: 'plan'|'skeleton'` and the UI states a
  skeleton seed honestly. No creatable-gallery row — the outline exists only
  through its candidate. Collab on ('elements'), FE⇄BE shape drift-pinned as
  the 7th collab type. Rides the existing `kicktodo-creator` toggle (§2.3's
  stated deviation from per-type toggles).

### Phase 4 — Studio demolition (2026-07-21)

§2.4 executed, resolving OQ1 on its recorded default (shrink, not raze):

- The bespoke **submit/complete publication buttons are gone** — the
  publication section now only STATES where things stand and links the
  reviews inbox; the decision lives with the shared approvals machinery.
- The **intake form is gone** — intake is a conversation with the Challenge
  Author (one accent CTA deep-linking the ONE chat); a regression test pins
  the demolition (a resurrected form field fails it).
- The **three toothless persona deep-links are gone**, replaced by the one
  Challenge Author link.
- The workspace keeps its honest read surfaces (spine, dossier, monitor,
  outline open/apply, retire) — the OQ1 read-only shell.
- Dead client fns removed (createCandidate/submitPublication/
  completePublication — routes remain for API completeness); 16 orphaned
  i18n keys removed ×4 locales, 6 demolition-copy keys added ×4.

OQ3 resolved: checkpoint cadence default is 'batched' (Phase 2); the outline
approval gate is never skippable. OQ4 resolved: the Challenge Author
COMPOSES the factory personas as convened specialists (the sims run inside
the factory; the author holds only its two tools) — mirror of KickBot.

### Grade sweep (2026-07-21, closing the ADR)

/grade-code + /grade-ux + /grade-data over the whole series: pre-fix
Code B+ / UX A− / Data B; ALL findings fixed in the Phase 4 landing —
notably `0458-B1` (outline canvas + collab were `workspace:*`-gated, not
manage-gated; fixed with an additive chassis `authorize` hook so the whole
canvas family can carry per-type authority, and a route-level test that
finally exercises a REAL shared-workspace editor) and the candidate-death
lifecycle seam (`onCandidateWithdrawn`) that reclaims outline canvases,
lesson-media pointers, and superseded Media assets. Post-fix scoped grades
A− / A− / A−. Recorded, not hacked: host canvas `capturedBy` sits outside
subject-erasure for every canvas type (platform TODO); OutlineTree
reordering is drag-only chassis-wide (a11y follow-up); per-day cadence
remains the documented ≤4-batch approximation.

**Correction (2026-07-21):** the `capturedBy` platform-TODO above is CLOSED —
**ADR 0464 P2** added `eraseSubjectCanvas` (`host/canvasSurface.ts`), which
anonymizes `capturedBy` on every version snapshot the subject captured **and** a
canvas's user-kind `ownerSubject`, tenant-wide, for **every** canvas type; it is
wired at boot (`hostSubjectErasers.ts` `registerCanvasErasure()`) and pinned by
`adr0464-host-subject-erasure.test.ts` (anonymizes the subject, leaves other
editors + other tenants intact, idempotent). The **OutlineTree keyboard-reorder
a11y follow-up is also CLOSED**: `OutlineTree` now supports Alt+ArrowUp/Down
sibling reorder (ARIA APG modifier+Arrow), reusing `treeOps.moveNode` + the drop
guards, focus-follows-moved-item, and an `.sr-only` `aria-describedby` hint
(4-locale); tests `OutlineTree.test.tsx` + `treeReorder.test.ts`. Keyboard
cross-parent reparent stays drag-only (an honest partial — indent/outdent is a
scoped follow-on). Per-day cadence remains the documented ≤4-batch approximation.

**Correction (2026-09-15) — the inbox could not publish.** §2.2 step 7 and the
Phase 4 record say the `challenge-publish` approval "is decided in the unified
reviews inbox" and "that inbox is the publication UI". Measured on
kicktodo.com's sync of `d2c5c1bde`: an APPROVE from the inbox returned **404
"Proposing agent no longer exists"**. `approvalDecision.ts` routed the kind
through the generic run-proposal finalizer, which resolves the proposing roster
entry first, and `createChallengePublishApproval` names `host:kicktodo-factory`,
a persona, not a roster row. REJECT worked (it never touches the roster). The
only publication act was the creator's `complete-publication` route, and Phase
4 had deleted its client. `test/kicktodo-publish-approval-eligibility.test.ts`
recorded the gap in a comment ("the generic CLAIM lane cannot complete a
challenge-publish") and tested reject only; manual test KTCO-03 asserted the
opposite. Fixed the way the other feature kinds are wired: the creator feature
registers a `challenge-publish` decision handler on the approval core at boot
(`registerChallengePublishApprovalHandler` → `decideChallengePublishApproval`);
approve runs `completePublication` (separation of duties and the gates re-run
there, unchanged), reject resolves. The approvals routes, the review card and
decide-by-email now share ONE publication act. Route-level pins: approve via
`/approvals/:id/claim` publishes; the submitter's claim is 403; a second
decision is 409; reject leaves the challenge unpublished and the candidate
"returned". The eligibility test's happy path now asserts a typed 409 (no
submitted record) instead of the runless 404. One consequence, deliberate: a
registered-handler kind counts as having reject side effects
(`kindHasRejectSideEffects`), so the ADR 0478 SLA expire rung no longer
auto-rejects an overdue `challenge-publish`; it sends the overdue notification
and leaves the decision to a human, which is the right posture for a
content-safety act. Pinned in the eligibility test.

**Correction (2026-09-15) — the evidence stopped at the plan summary.** PRD §7
requires every factual statement in a plan or daily action to trace to an
entailing source. Measured at the sync of `d2c5c1bde`: `plan-generate` received
`evidenceSummary`, a three-claim prose line with no ids or sources;
`lesson-batch-build` received the day payload only, against a placeholder
`responseSchema {type:'object'}`; the skeptic persona was told to check "whether
the plan's own sources actually support" each promise while receiving `planBrief`
(title, promise, audience, day lines) and nothing else. A challenge could pass
every gate with a grounded outline and ungrounded daily copy, and the third
simulation vote was theatre. Fixed as one seam, chain pack 1.4.0 / nodes 1.29.0
/ agents 1.9.0: `evidence-graph` writes the STRUCTURED `evidenceClaims` bag
variable (claim id, text, supported, cited sources — derived by the creator
surface's `evidenceClaims` op from the recorded dossier, capped, never re-derived
in a node); `plan-generate` receives it and every plan day may cite `claimRefs`,
validated closed-world against the candidate's dossier by `validatePlan`
(`claim-ref-unknown`, fed to the bounded repair) and carried verbatim onto the
`ChallengeActivity` (`claimRefs`, inside `contentHash`) and through the outline
doc; `lesson-batch-build` fetches the new `lessonSchema` SSoT, receives the
evidence, and refuses a lesson citing an id the evidence does not list (or citing
anything when no evidence is in scope); `checkpoint-plan` writes
`planEvidenceBrief` (brief + evidence + each day's refs) and the skeptic's task
reads it while the newcomer and time-poor personas keep `planBrief`. Pins: the
pack-node tests (unknown ref is `lesson_invalid` after one repair, listed ref
passes with `claimRefs` on the lesson, no-evidence lessons must cite nothing, the
skeptic brief carries id + text + source), the plan validator (unknown ref
typed, malformed typed, artifact-schema parity, refs onto the activity), and the
chain-backed e2e (the bag carries `evidenceClaims` and `planEvidenceBrief`, the
skeptic's task contains the claim, the newcomer's does not). Not done here: the
outline canvas property panel does not show `claimRefs` (read-only provenance
rides the doc untouched; a panel row is FE i18n work), and the participant UI
does not yet render a day's sources — the field exists for it to.

