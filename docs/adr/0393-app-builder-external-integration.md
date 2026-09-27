# ADR 0393 — App-Builder external integration: two-way GitHub sync (file lane) + MCP control server (agent lane)

| | |
|---|---|
| **Status** | implemented (2026-07-17 — Phases 1–4; see § Implementation record for the as-built corrections) |
| **Deciders** | port architecture review |
| **Decision source** | `docs/steward/MYNDHYVE-DECISIONS.md` §3 (adversarially-verified research — 219 agents, 47/50 claims confirmed against live primary sources, 2026-07-17); `docs/steward/MYNDHYVE-GAP-ANALYSIS.md` dev-tools rows (§P2 lines 67–69, SKIP-list line 89) |
| **Supersedes** | **ADR 0307** client-extension scope (the deferral of a bespoke VS Code/Cursor file-sync extension is made **permanent**). ADR 0307's *host seams* are retained and extended, not discarded. |
| **Extends** | ADR 0306 (GitHub publish — `publishService.ts`, `github-publish` adapterOnly connection); ADR 0358 (App Architect agent tools — `catalog`/`get-design`/`render`); RFC 0020 (host MCP server); ADR 0087 (per-principal MCP tool gating) |
| **Relates to** | ADR 0342/0343 (the `canvas.app-builder` application MODEL as SSoT); ADR 0173 (multi-framework generators); ADR 0295 (host-side site serving); `docs/steward/LLM-EXCHANGE-AUDIT.md` (tracker-row obligation) |
| **RFC verdict** | **Host work only.** No OpenWOP wire surface. See § RFC gate. |

## Context

The MyndHyve baseline shipped a ~35-file `plugins/ide` subsystem plus a `vscode-extension/`
artifact (connect-to-IDE, sync status, build output, conflict detection/resolution, diff/merge
preview). ADR 0305 Phase H **scoped** — did not build — this, and ADR 0307 named the host seams a
client would consume while deferring the client artifact to a separate-repo product decision.

`docs/steward/MYNDHYVE-DECISIONS.md` §3 resolves that open decision with verified market evidence:

- **No leading app-builder ships an official IDE file-sync extension.** Lovable's documented
  integration is bidirectional GitHub sync (one active branch; builder edits push commits to that
  branch; pushes to the branch sync back into the builder; a rejected sync falls back to a
  `lovable-sync-<timestamp>` branch). Its documented IDE workflow is plain `git clone` + your own
  editor. Every VS Code extension found for Lovable/v0 is third-party.
- **MCP is the standard agent/control channel, not a file bridge.** v0's *official* MCP server is
  its documented IDE-integration path — editor-agnostic (Cursor, Claude Desktop, VS Code), OAuth
  via `npx mcp-remote` — and its tools are chat/session-oriented (create/manage projects, send
  messages, resolve paused tasks, preview URLs), with **no file sync/diff/merge over MCP**. No
  shipped product exposes builder WRITE-to-files over MCP; write-back is universally left to git.
- **A spec-compliant MCP server reaches VS Code with zero extension code** (VS Code implements the
  full MCP spec, GA 1.102). Building a bespoke extension is redundant surface.

**Decision, plainly:** make ADR 0307's client-extension deferral permanent. Ship two lanes —
**(a) a FILE lane:** two-way GitHub sync on a single active branch, extending the ADR 0306 publish
seam; **(b) an AGENT/CONTROL lane:** an MCP server exposing builder control tools that EXPOSE the
existing ADR 0358 agent tools + a few existing routes. Files move over git; agents ride MCP.

## Boundaries audit (with file:line)

The two lanes are built by composition; every seam already exists. What is owned where:

| Concern | Owner (file:line) | This ADR's use |
|---|---|---|
| GitHub I/O (token brokering, host-pinned egress) | `features/app-builder/publishService.ts:55` `publishToGitHub` — `brokeredFetch` provider `github-publish`, `apiHosts:['api.github.com']`, create-only, 200-file cap | **Outbound push** extends this: create-only becomes create-or-update (sha lookup) on the ONE active branch; inbound reads add `GET .../contents` + webhook receipt |
| Vendor-write injection safety | `github-publish` connection manifest — **`adapterOnly:true`**, `consumerNodes:[]` (ADR 0306 §1) | Unchanged. No node can carry the token; sync is route/service-side only. The governance property that makes run-initiated writes impossible-by-construction is preserved |
| App application-model SSoT | `host/canvasSurface.ts:329` `updateCanvasForTenant` (CAS); `:282` `createCanvasForTenant`; `:250` `getCanvasForTenant` — the `canvas.app-builder` MODEL (ADR 0342/0343) | **Inbound sync writes ONLY here**, through the single governed CAS owner below — never a second write site |
| The ONE governed CAS write for a design | `features/app-builder/surface.ts:88` `applyRepair({canvasId, expectedVersion, app})` — validates + `updateCanvasForTenant` under CAS | **Inbound sync applies imported model JSON through `applyRepair`** (same closed-world gate + CAS the agent-tool render uses) — no new write path |
| Tenant-scoped design read (+ version) | `features/app-builder/surface.ts:78` `getDesign({canvasId}) → {app, version}` | Backs both the outbound serialization and the MCP `get-design` control tool |
| Code materialization (lossy projection) | `features/app-builder/export/generators.ts:21` `ExportTarget`; `generateScrubbed` (secret-scrub + caps) | **Outbound** pushes generated framework source as build output (see § materialization) |
| Closed-world design validation | `features/app-builder/validateAppDoc.ts` | Inbound import must pass this BEFORE `applyRepair` — an invalid inbound model is a typed rejection, never a silent partial write |
| App Architect agent tools (chat-time) | `features/app-builder/agentTools.ts` — `openwop:app-builder.catalog` / `.get-design` / `.render` via `registerFeatureAgentTool` (ADR 0358) | The MCP control tools **EXPOSE these existing tools' handlers**, never re-implement them |
| Existing route-side publish | `features/app-builder/routes.ts:103` `POST .../canvases/:canvasId/publish`, gated by `code-publish` toggle + `workspace:write` | Repo-binding + outbound-sync routes join this router under the same gate |
| MCP server mount | `routes/mcp.ts:45` `POST /v1/host/openwop-app/mcp`, env-gated `OPENWOP_MCP_SERVER_ENABLED` | The control tools ride this existing mount — no new endpoint |
| MCP tool registry + gate | `host/mcpServerRegistry.ts:184` `listToolsForPrincipal` / `:171` `isToolAllowed` (ADR 0087: `mcpRequiresAuth` + `mcpFeatureToggle`, fail-closed, `principal.tenants[0]`-scoped) | Every control tool carries `mcpRequiresAuth:true` + `mcpFeatureToggle:'app-builder'`; anonymous/wildcard principals denied |
| MCP tool dispatch + input validation | `host/mcpServerRouter.ts:202` `dispatchToolsCall` — AJV-validates `arguments` against `inputSchema` before side-effects; `metadata.trustBoundary:'untrusted'` | Control tools inherit this; their `inputSchema` is generated from the agent tools' SSoT (parity test) |

### The load-bearing honesty: SSoT is the MODEL, not the files

The app builder's source of truth is the `canvas.app-builder` **application model** (ADR 0342/0343
document facets: screens, closed component tree, data models, operations, auth profile), NOT a tree
of framework source files. The ADR 0173 generators are a **one-way lossy projection**: `AppModel →
React/Vue/HTML/Flutter markup`, secret-scrubbed, escaped, "never executable model code"
(`generators.ts:9-11`). Generated `.tsx`/`.vue` markup **cannot be parsed back** into the closed
model reliably — hand-edits to generated files carry no round-trip meaning.

This is the decisive difference from Lovable, whose SSoT *is* the file tree, so its git round-trip is
symmetric. openwop's is **asymmetric**, and the ADR must be honest about it (see § materialization).

## Decision

### Lane A — File lane: two-way GitHub sync on a single active branch

**A1 — Materialization (what round-trips vs what is regenerated).**
The pushed repo contains two disjoint regions:

- **`app.model.json`** — the canonical serialization of `getDesign().app` (the ADR 0343 application
  document), committed at repo root. **This is the ONLY round-trippable artifact.** Inbound sync
  imports *only* this file back into the model.
- **Generated framework source** (`src/…`, the ADR 0173 `generateScrubbed` output for the linked
  export target) — committed as **build output**, like a checked-in `dist/`. It is regenerated on
  every outbound sync and **ignored on inbound** (a developer editing generated files is editing
  build output; a `README`/`OPENWOP-SYNC.md` note + a `.openwop/generated` marker path state this
  plainly). This is honest: we do not advertise file-level round-trip we cannot deliver.

Rationale for pushing generated code at all (rather than model-only): the developer wants readable,
diffable, deployable source (the Lovable value), and the export path already exists and is scrubbed.
Model-only would be a worse product; file-round-trip-of-generated-code would be a **dishonest claim**.
The two-region split is the only defensible materialization.

**A2 — Outbound (builder → GitHub).** Extends `publishToGitHub`: on a design save (opt-in per
canvas via a repo binding, A4), push a commit to the single active branch containing the refreshed
`app.model.json` + regenerated source. Create-only (ADR 0306) becomes **create-or-update** (sha
lookup on the active branch) so a second push is an update, not a per-file "already exists" warning.
Commit attribution: author `OpenWOP App Builder <noreply@…>`, message carries an
**`[openwop-sync]` actor marker** + the model version (`getDesign().version`) for the loop-prevention
check in A3. Still through `brokeredFetch` (token never leaves `api.github.com`, never logged).

**A3 — Inbound (GitHub → builder), webhook-driven.** A `github-publish`-scoped webhook (push events
on the active branch) hits a host-ext route. On receipt:
1. **Loop prevention (skip-self):** if the head commit carries the `[openwop-sync]` actor marker
   AND its recorded model version equals the canvas's current version, it is our own echo — ack and
   drop (no build). This is the skip-ci/actor-marker convention; the version tiebreak defends against
   a marker on a genuinely newer external commit.
2. Fetch `app.model.json` at the pushed ref (`GET .../contents`, brokered).
3. **Bounded import:** `validateAppDoc` closed-world. Invalid → the whole push is rejected (A5),
   never a partial apply.
4. Apply via `surface.applyRepair({canvasId, expectedVersion: currentVersion, app})` — the ONE
   governed CAS write. CAS success advances the version.

**A4 — Repo binding (admin).** A canvas↔repo↔branch binding (stored on the canvas facet / a small
KV) established by an **admin** action (`workspace:admin` — a stronger gate than the `workspace:write`
publish, because it wires a durable external write channel + a webhook that can mutate tenant state).
Binding stores: owner/repo, active branch, export target, webhook secret ref. One active branch per
canvas (the Lovable constraint); no multi-branch fan-in in v1.

**A5 — Conflict policy (fallback branch).** Two conflict classes, both resolved WITHOUT clobbering:
- **CAS conflict** (canvas changed since the webhook's `expectedVersion`): the inbound model can't
  apply cleanly. Push the *inbound* model onto a **`openwop-sync-<timestamp>` fallback branch** and
  surface a notice; the active branch and the live canvas are untouched. (Lovable's exact model.)
- **Validation rejection** (A3.3): same fallback-branch treatment — the rejected content is preserved
  on `openwop-sync-<timestamp>` with the validation errors in the commit/notice, never applied.

### Lane B — Agent/control lane: MCP control server

**B1 — Registration seam (no parallel architecture).** The existing MCP registry
(`mcpServerRegistry.ts`) is **workflow-backed** — it scans workflow definitions for
`core.openwop.mcp.expose-tool` nodes. The App Architect control capabilities already exist as
`registerFeatureAgentTool` chat tools (`agentTools.ts`) + a few routes. To expose them over MCP
**without a second tool-registry**, each control tool is a **builtin one-node workflow** (the
`builtinWorkflows` half of `allWorkflowDefs`, `mcpServerRegistry.ts:48`) whose single node invokes
the **existing agent-tool handler / surface function** and whose `expose-tool` config carries the
`inputSchema`. This inherits, for free: the ADR 0087 gate (`isToolAllowed`), AJV input validation
before side-effects (`mcpServerRouter.ts:236`), the `trustBoundary:'untrusted'` run path, and the
per-principal `tools/call` rate limit (`routes/mcp.ts:55`). **No handler logic is duplicated** — the
builtin workflow node is a thin adapter over the ADR 0358 handlers, and its `inputSchema` is the
agent tool's schema (parity-test-pinned, B4).

**B2 — Control tool set (read-plus-control, NEVER file writes).** Per §3, v0's shape — chat/session
control, not file sync:

| MCP tool | Source it exposes | Effect tier |
|---|---|---|
| `openwop:app-builder.mcp.create-project` | `createCanvasForTenant` (blank `canvas.app-builder`) | write (draft) |
| `openwop:app-builder.mcp.open-project` | `getDesign` / `getCanvasForTenant` (returns canvasId + version) | read |
| `openwop:app-builder.mcp.get-design` | `agentTools` `get-design` handler | read |
| `openwop:app-builder.mcp.catalog` | `agentTools` `catalog` handler | read |
| `openwop:app-builder.mcp.send-build-prompt` | `agentTools` `render` handler (compose → validate → `applyRepair` CAS) | write (draft) |
| `openwop:app-builder.mcp.get-preview-url` | the ADR 0345 sanitized share/deep-link projection | read |
| `openwop:app-builder.mcp.resolve-paused-task` | the existing HITL interrupt-resolution route (v0's resolve-paused-task) | write (gated) |

**Explicitly NOT shipped:** any `read-file` / `write-file` / `diff` / `merge` MCP tool. Write-back to
files is the git lane's job. This is the verified market boundary (§3, open question 6).

**B3 — Auth (RFC 0020 / ADR 0087 pattern).** Every control tool metadata: `mcpRequiresAuth:true` +
`mcpFeatureToggle:'app-builder'`. `isToolAllowed` denies anonymous/wildcard/toggle-off principals,
fail-closed, `principal.tenants[0]`-scoped. The server mount stays env-gated
(`OPENWOP_MCP_SERVER_ENABLED`), and OAuth follows the RFC 0020 remote-MCP pattern (`npx mcp-remote`
precedent) — no bespoke device-pairing scheme (the ADR 0307 "no invented pairing" rule holds).

**B4 — LLM-exchange obligation.** Each control tool's `inputSchema` is generated from the ADR 0358
agent-tool SSoT (catalog schema from `componentCatalog.ts`, never hand-copied) with a
`promptCatalogParity`-style parity test pinning MCP-tool schema ↔ agent-tool schema. A new row lands
in `docs/steward/LLM-EXCHANGE-AUDIT.md` ("app-builder — MCP control lane", pattern B, tool-mediated) with its
tripwire, per the tracker obligation (a new model-facing surface lands with its row).

## Feature evaluation matrix (10 rows)

| # | Dimension | Ruling |
|---|---|---|
| 1 | **Feature-package architecture** | No new feature package. Both lanes extend `features/app-builder/` (new `githubSync.ts` service + `mcpControlTools.ts` builtin-workflow registrations) + the existing `github-publish` connection + `routes/mcp.ts` mount. ADR 0001 boundary respected: GitHub I/O stays in `publishService`/broker; the model SSoT stays in `canvasSurface`/`surface.applyRepair`. |
| 2 | **Toggle / admin UI** | **Extension of the existing `app-builder` toggle** (ON, tenant, Canvases). Two-way sync is an admin-only capability under `app-builder` — no third top-level toggle; if a finer gate is wanted, a `code-sync` sub-toggle (OFF, tenant, Canvases) mirroring `code-publish`, defaulting OFF because inbound webhooks mutate tenant state. Repo binding lives in the editor header near the existing ADR 0306 Publish control. |
| 3 | **Workflow packs** | The MCP control tools ARE builtin one-node workflows (B1) — that is their required workflow surface. No user-facing `feature.app-builder.workflows` chain change. |
| 4 | **Node packs** | **None, by design.** Sync is route/service-side (adapterOnly preserved); no sync node exists or should — a run-initiated push would reintroduce the ADR 0306 governance hole. Recorded as a deliberate non-node. |
| 5 | **AI-chat / agent packs** | The App Architect agent pack is unchanged. The MCP control tools EXPOSE its existing ADR 0358 tools to external agents; no new agent persona, no second chat (single-chat rule intact — MCP is an external-process channel, not an in-app chat surface). |
| 6 | **RBAC** | **Repo binding + webhook wiring = `workspace:admin`** (durable external write channel). Outbound publish stays `workspace:write` (ADR 0306). Inbound webhook applies through `applyRepair`, which re-checks tenant + CAS; the webhook principal is the binding's owning tenant (HMAC-verified secret, never a wildcard). MCP control tools = ADR 0087 per-principal gate (`mcpRequiresAuth` + `app-builder` toggle, `tenants[0]`-scoped). |
| 7 | **Replay / fork safety** | **Inbound-sync-triggered applies must be idempotent.** The A3 skip-self check (actor marker + version tiebreak) makes a redelivered webhook a no-op; `applyRepair`'s CAS (`expectedVersion`) makes a duplicate apply a typed conflict → fallback branch, never a double-write. No run is forked by sync; the model write is an ordinary tenant-store CAS op (the ADR 0358 replay posture — runs snapshot definitions, canvas writes are ordinary store ops). GitHub outbound is a non-replayable side effect confined to the route/service, never a workflow node (so ADR 0341 side-effect-suppression on replay/fork has nothing to suppress here). |
| 8 | **Idempotency / dedup** | Webhook receipts deduped by delivery id; outbound commits are content-addressed (identical model → identical `app.model.json` → GitHub no-ops the blob). The 200-file cap (ADR 0306) still bounds outbound; generated source is bounded by the model size. |
| 9 | **Observability** | One structured line per outbound push (repo + counts + version, never token/content — the `publishService.ts:107` `github_publish` convention) and per inbound receipt (delivery id, decision: applied / skipped-self / fallback-branch / rejected). MCP control calls ride the existing `mcp_tool_call` / `mcp_tool_denied` lines (`mcpServerRouter.ts:219,257`). |
| 10 | **RFC gate** | **Host-ext, no new RFC.** GitHub sync is `adapterOnly` vendor-write under existing governance (ADR 0292/0306); the MCP control server rides the already-Accepted **RFC 0020** (host MCP composition) + ADR 0087 gating; the model↔file materialization is internal. Nothing touches the OpenWOP wire, capability handshake, or `canvas.app-builder.export[]` normative facet. See § RFC gate. |

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Outbound hardening** | `publishToGitHub` create-only → create-or-update on the active branch; emit `app.model.json` alongside generated source; `[openwop-sync]` actor marker + model-version in commits; repo binding store + `workspace:admin` bind route + editor UI | vitest (round-trip serialize/deserialize `app.model.json`); ADR 0306 injection-skip pin still green |
| **2 — Inbound webhook sync** | `github-publish` webhook route (HMAC verify) → skip-self check → fetch model → `validateAppDoc` → `applyRepair` CAS; fallback-branch on CAS conflict OR validation rejection; observability lines | vitest (skip-self idempotency; CAS-conflict → fallback branch; invalid model → rejected, not applied); a redelivered-webhook no-op test |
| **3 — MCP control server** | 7 builtin one-node workflows (B2) over the ADR 0358 handlers + routes; `mcpRequiresAuth` + `app-builder` toggle metadata; schema parity test; `docs/steward/LLM-EXCHANGE-AUDIT.md` row + tripwire | vitest (tools/list gated projection; anonymous denied; inputSchema↔SSoT parity); MCP `tools/call` untrusted-boundary test |
| **4 — Docs + lockstep** | `OPENWOP-SYNC.md` operator doc (which files round-trip, conflict behavior, MCP client setup incl. OAuth `mcp-remote`); FEATURES + ROADMAP rows; **ADR 0307 Status correction note** (supersession); ADR 0306 cross-ref | `npm run ci`; ADR/FEATURES discipline check |

## Alternatives weighed

- **Bespoke VS Code / Cursor extension** — **rejected** (verified §3): no leading app-builder ships
  one; VS Code reaches MCP with zero extension code; it would be a separate-repo artifact with its
  own maintenance + the ADR 0307 "consumer-less surface" trap. Making 0307's deferral permanent is
  the honest close.
- **CLI sync tool** (a `openwop app-builder pull/push` in the openwop-cli repo) — deferred, not
  rejected: the git lane already gives clients `git clone` + any editor (the Lovable IDE workflow),
  so a CLI adds convenience, not capability. Revisit if operators ask; it would ride the same routes.
- **MCP file tools** (`read-file`/`write-file`/`diff`/`merge` over MCP) — **rejected** (verified §3):
  no shipped product exposes builder file-writes over MCP; write-back is universally git's job.
  Adding them would fragment the write path away from the governed CAS owner.
- **Push model-only (no generated source)** — rejected: worse product; a developer wants readable,
  deployable source. The two-region split (A1) gives both without a dishonest round-trip claim.
- **Symmetric file round-trip (parse generated code back to the model)** — rejected as dishonest:
  the generators are a lossy one-way projection (`generators.ts`); generated markup cannot be
  reliably reparsed to the closed model. `app.model.json` is the only sound round-trip artifact.

## Open questions

1. **Round-trip file scope.** v1 round-trips only `app.model.json`. Should a curated subset of
   *authored assets* (e.g. a `theme.json`, static content files) become round-trippable too? Deferred
   until a real editing-in-git demand appears; each added file needs its own bounded import + validator.
2. **Monorepo / subdirectory targets.** v1 binds a canvas to a repo root. Binding to a subdirectory
   (app-builder output as one package in a monorepo) is a path-prefix extension — deferred.
3. **MCP write-back if the market moves.** §3 open question 6: no shipped product exposes builder
   file-writes over MCP today. If that changes, the seam to add is a governed MCP tool, still routing
   through `applyRepair` — recorded as the activation trigger, not built.
4. **Multi-branch / PR-based sync.** v1 is single-active-branch (Lovable's constraint). A PR-review
   inbound flow (sync applies only on merge to the active branch) is a natural v2.
5. **Managed vs BYO GitHub App.** v1 rides the ADR 0306 fine-grained-PAT `github-publish` connection.
   A GitHub App (finer webhook + org install) is the ADR 0306-recorded OAuth follow-on; inherit its
   decision.

## RFC gate

**Host work only — no new OpenWOP RFC.** Checked against the CLAUDE.md rule:

- The MCP control server rides the **already-Accepted RFC 0020** (host MCP server composition) and
  the ADR 0087 gating pattern — advertising these tools is honest host work, not a new wire claim.
- GitHub sync is an `adapterOnly` **vendor WRITE** under existing governance (ADR 0292 finding /
  ADR 0306) — a governed external egress, never a wire capability.
- The model↔file materialization, webhook route, and repo binding are all under the non-normative
  `/v1/host/openwop-app/*` host-extension prefix. Nothing touches a run-event field, capability
  flag, event type, endpoint contract, auth/scale profile, the `canvas.app-builder.export[]`
  normative facet, or a `MUST`.

## Implementation record (2026-07-17)

| Phase | Landed as | Gate result |
|---|---|---|
| 1 — Outbound hardening | `syncBinding.ts` (side `DurableCollection`, sealed secret) + `githubSync.ts` + bind/sync routes + `SyncModal` editor UI (4 locales) | `githubSync.test.ts` + `app-builder-sync.test.ts` green; ADR 0306 pins green |
| 2 — Inbound webhook | `syncWebhook.ts` + public `/app-builder-sync/webhook/:webhookId` (raw-body HMAC, auth allow-listed) | `app-builder-sync-webhook.test.ts` green (skip-self, dedup, basis-fallback, invalid-fallback, apply, toggle-off) |
| 3 — MCP control server | `renderCore.ts` extraction + `mcpControlNodes.ts` + `mcpControlWorkflows.ts` (+ audit row) | `app-builder-mcp-control.test.ts` green (roundtrip, gating, parity, no-file-tools) |
| 4 — Docs + lockstep | `OPENWOP-SYNC.md`, FEATURES/ROADMAP rows, 0306/0307 cross-refs, this record | `npm run ci` |

**Correction notes (as-built deviations, architect-ruled at implementation):**

1. **A4 authorization:** the ADR named `workspace:admin`, a scope that does not exist in
   this host's lattice. Landed as a new **`host:code-sync:manage`** management scope
   (reserved to built-in admin/owner, never mintable onto a custom role — the
   territories/commissions/dealers precedent in `accessControlService.ts`).
2. **A2 mechanics:** per-file create-or-update `PUT /contents` cannot deliver the stated
   semantics (ONE marker commit; content-addressed no-op) — it makes a commit per file,
   2N calls, and a torn branch on mid-loop abort. Landed as **one atomic Git Data API
   commit** (blobs→tree→commit→fast-forward-only ref update, one retry) in
   `githubSync.ts`; `publishToGitHub` (ADR 0306) is untouched. Stale generated files are
   deleted via a `.openwop/generated.json` manifest diff — never developer files.
3. **A3/A5 basis check:** the "canvas changed since the webhook's expectedVersion"
   conflict class is implemented as a **fail-closed basis check**: the pushed manifest's
   `modelVersion` must equal the live canvas version; mismatch (or a missing/unreadable
   manifest) → fallback branch, never an apply. The fallback is one ref-create pointing
   at the pushed commit (the inbound content, preserved at a stable ref).
4. **Inbound strictness:** `validateAppDoc` coerces a non-array `screens` to `[]` (a
   legitimate mid-edit editor state) — on the import path that would wipe a canvas to an
   empty app from one malformed hand-edit. Inbound additionally requires ≥1 screen with
   exactly one `isInitial` before validation.
5. **B2 naming/shape:** the write tool landed as **`app-builder-render-design`** (its
   input is a composed design document, not a chat prompt — `send-build-prompt` promised
   a contract the tool does not have), and the "one-node workflow" is the ADR 0087
   **2-node expose→backing shape** (the registry's static-scan contract). The render
   pipeline was **extracted to `renderCore.ts`** and is shared verbatim by the chat
   agent tool and the MCP node — one owner, two gates. `resolve-paused-task` is
   allowlisted to this tenant's `app-builder.design`/`app-builder.repair` interrupts.
6. **Webhook addressing:** the public route is keyed by an opaque per-binding
   `webhookId` (`/app-builder-sync/webhook/:webhookId`) — a point lookup (no collection
   scan) riding the connections-inbound posture; the HMAC signature remains the only
   credential.

## Consequence for ADR 0307

Phase H's client-extension residue is **closed permanently** by this ADR. In the lockstep pass,
ADR 0307 receives a `Status:` correction note — *"Superseded in part by ADR 0393: the VS Code/Cursor
client-extension is a permanent non-ship; the host seams named here are extended by 0393's GitHub
sync + MCP control lanes"* — per the correct-don't-rewrite convention. The seams ADR 0307 named
(design read, versioned CAS push, generators, publish, standard auth) are exactly the seams 0393
composes; none is discarded.
