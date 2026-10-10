# ADR 0835 — App builder: guard the deploy, export and seed exits

Status: implemented (pending merge; see § Implementation record)

Feature loop round 2, row 21 (`app-builder`, with its `code-export`, `code-publish`,
`code-sync` and `app-builder.deploy` sub-toggles). Never graded as a feature before; the
app-builder trio is cited in `CLAUDE.md` as an A+ exchange reference. Per that file's own
warning, the citation is a claim, so every surface was re-measured on `origin/main` @
`269b9eee9`. Each defect below is proved RED on the unmodified code by a committed test
before it is fixed (§ Witnesses).

This extends ADR 0153 (app-builder canvas), ADR 0173 (code export), ADR 0306 (GitHub
publish), ADR 0393 (two-way sync), ADR 0424 (governed deploy), ADR 0346 (repair chain)
and the canvas chassis (ADR 0310). Every route is under `/v1/host/openwop-app/*` and no
run-event, capability or endpoint contract changes, so **no RFC is needed**.

## Context — what was measured

What held up:

- **The authoring trio is sound as a shape.** `openwop:app-builder.render`
  (`renderCore.ts`) normalizes through the same render node the chain runs, validates
  closed-world with `validateAppDoc`, returns a typed failure with the errors for the
  model to repair, and updates only through `applyRepair` (CAS + the full validator).
- **The editor's own writes validate.** PATCH, restore (DATA-D6), the collab room
  (`registerCollabCanvasType({ validate })`) and the inbound GitHub sync
  (`syncWebhook.ts:217`) all run `validateAppDoc` and refuse errors. Two other writers
  do not (S3, S9).
- **The in-app preview cannot execute design content.** It renders through React, URLs
  pass `safeHref` / `safeImageSrc`, colors pass `safeHex`.
- **Text props in exported code are escaped** for every target, braces included
  (grade pass 2026-07-07 F2), and URLs pass `safeUrl`.
- **Publish and sync keep the GitHub token host-side** (`brokeredFetch`), validate
  owner/branch, verify the webhook HMAC over raw bytes with `timingSafeEqual`, and 404
  a webhook whose tenant turned `code-sync` or `app-builder` off.
- **Paywall at the exits.** Routes go through `requireFeatureEnabled` (ADR 0820 G5) and
  agent tools through `resolveFeatureAccess` → `resolveOne` (toggle + plan).
- **Get-design and render results are declared `contentTrust: 'untrusted'`.**

What did not:

| # | Defect | Evidence |
|---|---|---|
| S1 | **A deploy can replace any Cloud Run service in the operator's project, including the host itself, and run any image with the project's default identity.** `deployApp` takes `service` from node inputs; the only check is a lowercase-kebab regex. The Cloud Run adapter runs with the host's own metadata identity (`run.admin`), tries `POST /services?serviceId=…`, and on any failure falls back to `PATCH /services/<service>` with the caller's `image`. So a member of a deploy-enabled tenant who can run a workflow (`runs:create` — every Editor) can patch `openwop-app-backend`, or another tenant's or org's app, to an arbitrary image. The spec sets no `template.serviceAccount`, so even a correctly-named deploy runs the image as the project's default compute account, which can mint project credentials from the metadata server. Nothing requires an approval (the pack description only says "compose after"), and nothing limits where the image comes from. (`rollbackDeployment` has no node; `deploymentStatus` reads only the stored record.) **Config-conditional**: it needs `OPENWOP_APP_DEPLOY_PROVIDER=cloud-run` and the default-OFF `app-builder.deploy` toggle; otherwise `resolveDeployAdapter` answers 501. | `deploy/adapter.ts:95-102`, `deploy/deployService.ts:43,70,75`, `surface.ts:123-135`, `packs/feature.app-builder.nodes/index.mjs:752-763` |
| S2 | **Exported source carries un-escaped design values.** The generators interpolate enum-typed props (`fontSize`, `tone`, `direction`, `variant`, `size`, …) through `str()`, which does not escape. The surface's inline `export({ app })` treats catalog violations as non-fatal by contract, so a value such as `md" onClick={() => fetch(…)} x="` lands as live JSX in `react-styled`, and `"><script>` lands in `html-css` and `vue-tailwind`. | `export/generators.ts:86,214,224,459`, `surface.ts:36-46` |
| S3 | **Opening a run artifact as a canvas skips the type's validator.** `seedCanvasFromArtifact` writes the artifact payload as the canvas state. The artifact schema leaves `props` open (`{ type: 'object' }`), so a payload the editor would refuse becomes a durable canvas, and the stored-canvas export then ships S2's payload. This is the `CLAUDE.md` non-negotiable "model output reaches durable state only through closed-world validation", broken on the chassis for every canvas type that declares a validator. | `host/canvasFromArtifact.ts:25-58`, `features/canvasEditorRoutes.ts:291`, `artifactTypes.ts:25` |
| S4 | **An MCP client approves app-builder review gates with no approver check.** `resolve-paused-task` calls `resolveAndResume` with no `reviewer`. On an open non-quorum gate — the repair review is one (`requiredApprovals: 1`, no ACL) — NEITHER eligibility lane consults `approvals:respond` (the subject lane returns early at `routes/interrupts.ts:968`, the token lane at `:1054`). The repair chain's review then writes the canvas, attributed to nobody (ABWF-5). **Reach, measured:** the MCP registry gate requires `workspace:write` for this `write`-tier tool (`requiredScopeForTool`), and every Editor also holds `approvals:respond`, so the principals who slipped through are custom roles or narrowed `owk_` keys with `workspace:write` but not `approvals:respond`; the effect (a repair's CAS write, an audit capture) is one a `workspace:write` holder can already make by PATCH. The real loss was attribution. The witness drives the node with a Viewer to pin the node's own check; in production the registry gate stops a Viewer first. | `mcpControlNodes.ts:175`, `routes/interrupts.ts:968,1054,1597-1600` |
| S5 | **`resolve-paused-task` refuses every real run.** It allows only `run.workflowId === 'app-builder.design' / 'app-builder.repair'`; runs started from the gallery are template copies with a minted id (ABWF-2). | `mcpControlNodes.ts:171`, `routes/workflows.ts:1176` |
| S6 | **Approving the plan-to-kanban review with `accept` fails the run.** The materializer accepts only `approve`; the host advertises and accepts both spellings (ABWF-3). | `packs/core.openwop.kanban-work-items/index.mjs:42-43`, `routes/interrupts.ts:582-586` |
| S7 | **The repair apply step never checks the approval it is wired to.** Its `approval` input reads `review.approved`, which the review node does not emit. Today the review's reject fails the run first; remove that edge in the builder and an unreviewed repair is written (ABWF-4). | `examples/workflow-chain-packs/app-builder/pack.json:470`, `packs/feature.app-builder.nodes/index.mjs:721-736` |
| S8 | **A repo named `.` or `..` passes `REPO_NAME_RE`** and is spliced into GitHub API paths, where URL normalization re-targets the request. Low: the token is the user's own. | `publishService.ts:22,93` |
| S9 | **The UI-plugin RPC writes app-builder canvases with read access and no validator.** `artifact.write` is gated by `canvasReadAllowed` only (no `workspace:write`) and calls `updateCanvasForTenant` without `validateAppDoc`, so a Viewer who can read a canvas overwrites it with arbitrary state, which a later export ships. | `routes/uiPlugins.ts:80,103-115` |
| S10 | **The generated backend splices an operation name into a line comment.** `validateAppDoc` allows a newline in `operations[].name`, so `x\nrequire('child_process')…` becomes live server code in the export — from a fully validated stored canvas. `app.theme` lands raw in `data-theme="…"` (inline export treats a bad theme as non-fatal). | `export/backendGen.ts:147`, `validateAppDoc.ts:421`, `export/generators.ts:344` |

## Decision

**D1 — Deploy names its own services, runs them as a no-role identity, and needs an
admin (S1).** The Cloud Run service is never the caller's string. `startDeploy` derives
`owa-<12 hex of sha256(tenantId + NUL + orgId)>-<service>` and records it as
`cloudRunService`; the caller's `service` (now `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, so the
whole name fits Cloud Run's 49 and never ends in `-`) is the display name. The org is in
the hash and in `deployKey`, because orgs share a tenant (ADR 0832): an admin of org A
must not patch, or read back through idempotency, org B's same-named service.

The guards sit at the exit, in the Cloud Run adapter only (the mock stays a test
double): every verb refuses a name without the `owa-` prefix; `deploy` refuses an image
that does not start with one of `OPENWOP_APP_DEPLOY_IMAGE_PREFIXES` (comma list, each
entry must end in `/`; unset ⇒ 501); and `deploy` pins `template.serviceAccount` to
`OPENWOP_APP_DEPLOY_RUNTIME_SA` (unset ⇒ 501). The default compute account is never
used, so code from an allowed image still cannot act as the project. PATCH remains the
update path, but only for a name the namespace produced. A record written before this
ADR (no `cloudRunService`) is refused by the stale re-claim and by rollback, never
replayed against the raw name.

Authority: the new management scope `host:app-deploy:manage` (built-in admin/owner, the
`host:code-sync:manage` precedent — a deploy spends operator infrastructure and
publishes to the internet). `deployApp` refuses a run with no acting user and an empty
`orgId`, and the surface declares `orgPolicy.methodScopes: { deployApp:
'host:app-deploy:manage' }` so the ADR 0832 floor checks the scope in the named org.
`rollbackDeployment` checks the same scope against the stored record's `orgId`.

> **Added before the gate (orchestrator review):** the approval is enforced by the
> SURFACE, not the pack's "compose after core.approvalGate" advice — `deployApp`
> refuses with `approval_required` unless its `approval` argument is `true` or an
> `approve`/`accept` decision (the node passes its `approval` input through), because
> the builder can delete an edge and another node could call the surface directly.
> And `exportHash` must be one of THIS tenant's exports (`isTenantExportHash`, a
> tenant-prefix scan of the export lineage); the surface's own `export` now records
> lineage too (an inline export under a per-tenant `_inline` row), so a render →
> export → deploy chain can cite its hash. That closes the deferred AB-D1 below.
> A ratchet pins that the Cloud Run Admin API is reached from `deploy/adapter.ts`
> only (two reviewed exceptions: the runtime-posture GET of the host's OWN
> `K_SERVICE`, and a comment) and that every adapter verb asserts the namespace
> first; an unset or unknown provider is pinned as a hard 501 with no fallback.
> In production the provider is unset, so S1 was LATENT there (orchestrator's
> read-only check, 2026-10-06); it is a host-takeover class for any adopter who
> enables it.

Alternatives rejected: a deny-list of host service names (fails open on the next
service anyone adds); per-tenant GCP projects (infrastructure this host does not own);
an approval gate in the chain (the builder can delete an edge — the check belongs in the
surface).

**D2 — The exporter refuses to emit an unchecked token (S2, S10).** `generate()` first
passes the app through `coerceForExport`: for every prop the component catalog declares
as an enum, and for `app.theme`, a value outside the enum is replaced by the declared
default and reported as an export `warning` (the contract that catalog mismatches
degrade to warnings holds). The generated backend's comment line goes through a
single-line sanitiser (every C0 control and both Unicode line separators — JS ends a
`//` comment at four characters, not one).

> **Correction during implementation:** the draft also had `validateAppDoc` refuse
> control characters in operation and model names. Dropped: it would make every
> existing canvas that carries one unsaveable, and the exit sanitiser already makes
> the value inert in the only place it is spliced into code. Guard at the exit.

The ratchet is behavioural:
a test walks the live catalog and, for every string-typed prop of every component plus
the app-level and operation/model text fields, exports a hostile value to every target
and asserts it never appears verbatim. A new prop is covered without editing the test.

**D3 — Seeding a canvas from an artifact is type-pinned and validated (S3).** The
from-artifact route refuses with a uniform 404 unless the artifact's `artifactTypeId` is
the route's `cfg.canvasTypeId` (today an app-builder artifact key posted to the slides
route seeds an app-builder canvas past app-builder's toggle and `authorize`).
`seedCanvasFromArtifact` takes a `validate`; errors refuse with the editor's 422
`validation_error` and the error list, warnings pass.

> **Correction during implementation — the validator is per-type opt-in
> (`validateSeed`), not the type's save `validate`.** Passing `cfg.validate`
> chassis-wide reddened `slides-editor-routes`: a slides ARTIFACT is positional (the
> editor assigns per-slide ids), so the slides save validator refuses every real
> one. An app-builder artifact IS its document, so app-builder passes
> `validateSeed: validateAppDoc`. The type pin stays chassis-wide.
>
> And the idempotency note was wrong: validation runs before the idempotent create,
> so re-opening an artifact that was seeded invalid BEFORE this ADR now answers 422.
> The working copy it created still exists and opens from the canvas list; only the
> re-open from the run artifact refuses.

**D4 — MCP approvals need `approvals:respond` and come from the chain's own gates (S4,
S5).** `resolve-paused-task` requires `ctx.actingUserId`, checks the subject holds
`approvals:respond` in the workspace (`assertTenantScope`) itself
(the eligibility helpers skip it on open gates), and passes the subject as
`reviewer.subjectRef` for attribution. The run must originate from the design or repair
chain — `chainIdOfDefinition` on the definition the run started from, the existing
parser — AND the interrupt's `nodeId` must be one of that chain's own gate ids
(`clarify`/`review` for design, `review` for repair, in the expansion's
`<chain>_<12 hex>_<id>` shape), because a tenant copy is builder-editable and could
carry any extra gate. The definition is read from the live catalog: a run record
carries no definition snapshot (ABWF-9), so a member who renames an added gate to
`…_review` passes the id check — which is why the scope check, not the allowlist, is
the boundary (an MCP caller with `approvals:respond` has the HTTP approve route's
authority anyway). Missing
`value` is a typed `validation_error`, never `{ resolved: true }` (ABWF-12).

**D5 — Approval spellings and the repair gate (S6, S7).** The kanban materializer's
`isApproved` admits `approve` and `accept` (the `resumeActionSpelling` equivalence;
`override` is not a spelling and stays refused). The repair chain wires `review.output`
into `apply-repair.approval`, and `apply-repair` refuses unless that input is an
approval. This is a correctness guard against an edited copy, not a security boundary
(an editor can PATCH the canvas directly). Versioning: node version bump (ADR 0766),
chain 1.0.1→1.0.2, `feature.app-builder.nodes` and the chain pack bumped, the
`requiredPacks` pin moved; the pinned-pack publish is called out in the deploy note.
Existing tenant copies keep the old edge and therefore fail at apply with a typed
`approval_required` whose message says to re-create the workflow from the gallery.

**D6 — `REPO_NAME_RE` refuses `.` and `..` (S8).**

**D7 — The UI-plugin write is the editor's write (S9).** `artifact.write` requires
`workspace:write` and runs `validateAppDoc`. The RPC names no org, so the scope check
is the workspace union (`assertTenantScope`, the predicate `requireTenantScope` uses);
a refusal answers the RPC's closed wire code `unauthorized`, a catalog violation
`handler_error` with the first error. The scope check runs before the version compare
and the validator after it, so the conformance suite's stale-write probe still gets
`artifact_conflict`; the test-seam-only conformance canary skips the validator (its
payloads are the suite's opaque `{}`).

## Grader pass (after D1–D7)

`/grade-workflows` B (no Blockers), `/grade-code` B with one NEW Blocker, `/grade-ux` B
(no Blockers). Closed in the same PR, each backend leg RED on `origin/main` source:

| Id | Severity | What | Fix |
|---|---|---|---|
| AB2-CD-1 | **Blocker** | An unknown component `type` closed the JSX `{/* unsupported: … */}` comment in react-tailwind / react-styled / react-native / nextjs exports (`escapeHtml` leaves `*` and `/`). The inline export admits unknown types by contract; D2's ratchet walked catalog props only. | `jsId(n.type)` in every "unsupported" comment; a per-target leg with `*/` and a backtick. |
| AB2-CD-2 | Medium | D1's `driveDeploy` turned a thrown adapter error into a PERMANENT `failed` for those inputs (only a stale `deploying` was re-claimable), so fixing the 501 config never helped. | A `failed` record is re-driven by CAS; the error keeps its code + message. |
| AB2-CD-3 | Medium | The public share projection was a six-key DENYLIST: `models`, any unknown top-level key and extra data-source keys reached a public link. | An allowlist (the file's own "Kept" list); sources are `{ id, name, fields, rows? }`. |
| AB2-CD-4 | Medium | The inbound sync egress carried no `orgId`, so the broker fell back to the tenant's first org connection — possibly another org's GitHub credential. | The binding records its org; the webhook passes it. Bindings made before stay as they were (residual). |
| AB2-CD-5 | Low | `deploymentStatus` read any org's record by key. | Org membership checked against the record's org. |
| AB2-CD-6 | Low | A 64-char non-ASCII signature made `timingSafeEqual` throw → 500. | Hex-format check first → 401. |
| AB2-CD-7 | Low | `app.model.json` of `null` → TypeError → every redelivery 500. | Object guard → `fallback_invalid`. |
| AB2-CD-8 | Low | `.`-led branch segments passed the binding check (the branch form of D6). | Refused, server and client. |
| AB2-CD-10 | Low | `type: 'constructor'` / `kind: 'toString'` hit `Object.prototype` in the backend/openapi generators → 500. | `Object.hasOwn`. |
| AB2-CD-11 | Low | D1's pre-namespace 409 in `startDeploy` was dead code (a new key never finds an old record); rollback answered 422 for an old record with no org. | Dead branch removed; rollback's 409 runs first. |
| AB2-UX-1 | High | The new 422 from `from-artifact` showed raw English with a Retry that reloaded into the same 422 forever. | Permanent, localized (4 locales), server detail behind a disclosure, Back. |
| AB2-UX-2 | Medium | The export-warnings intro said every item was "missing", but coerced props are exported with a default. | Neutral copy (4 locales); the warning says "or left out where there is none". |
| AB2-UX-3 | Medium | The deploy toggle description said "approval-gated" (S1: nothing required one) and omitted the admin rule and the two new env vars. | Rewritten. |
| AB2-UX-6 | Low | The SPA's repo/branch checks no longer matched the server (D6, CD-8). | Mirrored. |

## Deferred (filed, with reasons)

- ~~**AB-D1 — `exportHash` is not checked against the tenant's export lineage.**~~
  Closed before the gate (see D1's added note): a tenant-wide lineage scan, no node
  contract change needed.
- **ABWF-6 — the design intake routes on text markers.** Needs a deterministic verdict
  output and a chain revision; no security consequence (fails or stalls the run).
- **ABWF-7 — failed research reports success with an unwired `warning`.**
- **ABWF-9 — model id resolved at registration; replay after a catalog change.** Needs
  a replay probe first.
- **ABWF-11 — plan-to-kanban declares no capabilities; unwired declared outputs** (the
  SPWF-4/14 class, RFC-blocked).
- **AB2-CD-9 — the outbound sync's delete list is read from the repo's own
  `.openwop/generated.json`, uncapped.** The repo is the binding admin's choice and
  every delete is a fast-forward commit (recoverable); keeping the manifest
  server-side is a sync-state migration.
- **AB2-CD-12 — no executor-level test resolves the repair review through to
  `apply-repair`.** The wiring is pinned by an edge assertion plus the node guard.
- **D3 residual — other canvas types still seed run artifacts unvalidated** (slides'
  artifact shape is not its editor shape; each type opts in via `validateSeed`).
- **Sync residuals:** the inbound webhook acts as `boundBy` without a live membership
  re-check; a captured signed body can be replayed to mint extra fallback branches
  (canvas writes stay basis + CAS protected); pre-ADR bindings carry no `orgId`.
- **AB2-UX-4 (Medium) — the hub's "Start blank" takes `orgs[0]`** instead of the
  selected org (pre-existing; needs the hub to adopt `useOrgSelection`).
- **AB2-UX-5 / -7 / -8 (Low)** — Publish/Sync warnings as one paragraph; Contract
  workspace invalid fields without a stated rule; deploy refusals only as English
  run-node errors (no deploy UI exists to localize them in).

## Phases

1. Witnesses (RED on `origin/main`), then D1–D6 with the witnesses turning green.
2. `/grade-ux` + `/grade-code` over the result; fix Blockers.
3. Gate (`npm run ci`), PR.

## Witnesses

Each file was run against `origin/main` source (the changed files swapped back,
the tests kept) before its fix landed. Controls stay green on both.

| File | Defects | RED on `origin/main` | Green after |
|---|---|---|---|
| `test/adr0835-export-exit.test.ts` | S2, S10 | 12 / 20 (the 7 free-text legs + 1 count leg are controls: text was already escaped) | 20 / 20 |
| `test/adr0835-deploy-exit.test.ts` | S1 | 9 / 9 | 9 / 9 |
| `test/adr0835-canvas-writers.test.ts` | S3, S9 | 4 / 4 | 4 / 4 |
| `test/adr0835-mcp-resolve.test.ts` | S4, S5, ABWF-12 | 4 / 5 (the added-gate leg is a control) | 5 / 5 |
| `test/adr0835-approvals-and-repo.test.ts` | S6, S7, S8 | 5 / 7 (`approve` materializes, reject refused: controls) | 7 / 7 |

The S2 probe that started this (before any witness): an inline `export({ app })` with
`fontSize: 'md" onClick={() => fetch(…)} x="'` produced live JSX in
`src/screens/Home.jsx` for `react-styled` and attribute injection in `html-css` and
`vue-tailwind`; a run artifact carrying `"><script>` seeded a canvas through
`from-artifact` and the stored-canvas export shipped the `<script>`.

## Implementation record

| Decision | Commit (subject) |
|---|---|
| D2 | `fix(app-builder): coerce enum props + one-line op names at the export exit (ADR 0835 D2)` |
| D1 | `fix(app-builder): namespace + guard the deploy exit, admin-only deploys (ADR 0835 D1)` |
| D3, D7 | `fix(canvas): type-pin + validate from-artifact seeds; ui-plugin write needs workspace:write + the validator (ADR 0835 D3/D7)` |
| D4 | `fix(app-builder): MCP resolve-paused-task needs approvals:respond, answers chain copies' own gates (ADR 0835 D4)` |
| D5, D6 | `fix(app-builder): both approval spellings, repair applies only an approved candidate, dot repo names (ADR 0835 D5/D6)` |

Pack versions: `core.openwop.kanban-work-items` 1.1.1 → 1.1.2 (materialize node
1.1.0 → 1.1.1); `feature.app-builder.nodes` 1.9.2 → 1.9.3 (apply-repair and
deploy-app 1.0.0 → 1.0.1; the `requiredPacks` pin moved); the chain pack
`vendor.openwop.app-builder.workflows` 1.4.1 → 1.4.2 (repair and plan-to-kanban
chains 1.0.1 → 1.0.2). `packs/.steward-manifest.json` regenerated — without it the
bumped node pack is `no_attestation` and refuses to dispatch.

Operator note: a host that sets `OPENWOP_APP_DEPLOY_PROVIDER=cloud-run` must now also
set `OPENWOP_APP_DEPLOY_IMAGE_PREFIXES` and `OPENWOP_APP_DEPLOY_RUNTIME_SA`, or deploys
answer 501. Deployments recorded before this ADR cannot be re-driven or rolled back
from the host (409); their services are untouched.
