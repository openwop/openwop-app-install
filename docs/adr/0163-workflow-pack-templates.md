# ADR 0163 — Workflow packs as first-class editable templates (retire the throwaway-demo builder model)

**Status:** implemented — all 7 phases (2026-06-27; architect-reviewed per phase; R1–R5 folded in)
**Date:** 2026-06-27

## Implementation record

| Phase | What | Status |
|---|---|---|
| 1 — Ownership index (security gate) | `host/workflowOwnership.ts` (per-tenant index over the global registry) + scoped `GET /workflows` (closed an enumeration leak) + IDOR-guarded `DELETE` + ownership-on-`POST`. IDOR route test. | ✅ |
| 2 — Pack→template glue | `GET /workflow-chains` + `POST /workflows/from-chain` (expand → fresh owned id → register + own; `warnings[]` for unresolved typeIds). Route test. | ✅ |
| 3 — Dashboard on the index | `builder/persistence/backendStore.ts` (backend-primary, localStorage draft/offline fallback, migrate-copy); dashboard async list; BuilderTab backend-first; debounced write-through. | ✅ |
| 4 — Pack-fed gallery | `listChainTemplates`/`instantiateChain` + `ChainTemplateModal` (JSON-Schema param form, graceful fallback); gallery section + pack chip; legacy PREMADE demoted to "Starter examples". 4-locale i18n. | ✅ |
| 5 — Connector "needs setup" | `/connections` CTA on `PreflightBanner` (run-gate) + the Inspector missing-surface warning — invitation, not failure. Reused existing affordances (no parallel banner). | ✅ |
| 6 — Assignment + de-demo | Neutral `workflows/workflowsClient.ts`; agent-portfolio + project-workflows pickers now list the caller's real workflows (created ones assignable); assigned cards resolve real names. De-demo already correct (banner anon-only). | ✅ |
| 7 — Download from registry (optional) | Chain loader scans `OPENWOP_PACK_DIR`, so a `kind:"workflow-chain"` pack in `OPENWOP_INSTALL_PACKS` is fetched + Ed25519/SRI-verified from packs.openwop.dev at boot and loaded as a template (the production path node packs use). | ✅ |

> **Deferred follow-ons (non-blocking):** the ADR 0149 catalog authored as chain packs (the *content* that fully retires the legacy PREMADE placeholders — P4 built the rail); a dashboard-card "Assign to…" shortcut (the agent/project editors are the established assignment surface); an in-app browse-and-click pack marketplace (install-without-restart; P7 ships the boot-install capability); converging chat's `@workflow` mentions onto the backend ownership index (P3 kept the sync `localStore` API for them).
>
> **Follow-on status (2026-06-27, this branch):**
> - ✅ **Chat `@workflow` convergence** — the `/` picker + LLM tool list now merge the caller's backend-owned workflows (async cache over the P6 `workflowsClient`, deduped backend-first); fail-safe to demo+localStorage. `chat/lib/workflowMentions.ts`.
> - ✅ **Dashboard "Assign to…" shortcut** — `builder/AssignWorkflowModal.tsx`; a convenience over `updateRosterEntry`/`updateWorkflows` (append-deduped, idempotent), not a new assignment model.
> - ✅ **ADR 0149 lighthouse content** — the 5 zero-config workflows authored as a vendored RFC 0013 chain pack (`examples/workflow-chain-packs/lighthouse/`); appears in the P4 gallery. The remaining connector-bound 15 are incremental per ADR 0149.
> - ✅ **In-app marketplace (runtime install, no restart)** — `POST …/workflow-chain-packs/install` (superadmin-gated; reuses the Phase-7 Ed25519/SRI-verified installer) + `reloadWorkflowChainPacks()` hot-reload, surfaced as an "Install from registry" modal in the builder gallery. Scoped to `kind:"workflow-chain"` packs (node/agent runtime install needs a node-catalog rebuild — deferred). Install is **by name@version** (the production mechanism, identical to `OPENWOP_INSTALL_PACKS`); a **searchable remote catalog browse** is a further increment — it needs a registry catalog API that the current registry surface (`/v1/packs/-/search` returns node typeIds, not browsable pack manifests) does not expose, so that belongs in openwop-registry, not invented host-side.
>
> **All four ADR 0163 follow-ons are now landed.**

> **How packs reach production (decision, architect-reviewed 2026-06-28).** A
> workflow-chain pack reaches the live host's gallery via **registry boot-install**
> — its name@version is listed in `OPENWOP_INSTALL_PACKS`, and at boot
> `ensureRegistryPacksInstalled` fetches + **Ed25519/SHA-256-SRI-verifies** it from
> packs.openwop.dev into the install dir, which the chain loader scans (ADR 0152
> Phase 7). This is how the live `core.openwop.workflows.{lighthouse,market-intel}`
> packs are served on app.openwop.dev. The decision — over the alternative of
> vendoring `examples/workflow-chain-packs/` into the deploy image — was made on
> **single-source-of-truth + provenance**: the registry artifact is the one
> authoritative, signature-verified copy, and it *is* the "publish to the registry →
> install on the app" product story. Two clinchers: (1) the app already boot-installs
> 17 `core.openwop.*` **node** packs via the identical path, so workflow packs ride
> it with zero new failure modes — whereas vendoring would ship them **unsigned**
> (path-loaded, no verify), less trustworthy than the node packs beside them; (2)
> vendoring `examples/` while the same packs are in `OPENWOP_INSTALL_PACKS` triggers
> the loader's deliberate `workflow_chain_id_conflict` (the **"no silent shadow"**
> guard in `host/workflowChainPackLoader.ts`), and relaxing that guard to dedupe would
> reverse a real safety invariant. **`examples/workflow-chain-packs/` is therefore the
> dev/authoring/test root only** — intentionally NOT vendored into the prod image (it
> simply doesn't exist there, so the loader's `existsSync` skips that root); the
> registry-install dir is the prod root. The runtime in-app marketplace
> (`POST …/workflow-chain-packs/install`) is for single-instance / durable-FS hosts;
> on the multi-instance Cloud Run deploy (`maxScale=5`) it is per-instance + ephemeral,
> so `OPENWOP_INSTALL_PACKS` is the durable mechanism there. *Revisit only if* an
> air-gapped/offline deploy target appears, or cold-start registry reachability proves
> unreliable in practice.

> **Architect review — CRITICAL finding + required changes (R1–R5):**
> **R1 (CRITICAL, hard prerequisite).** `workflowsRegistry` is **GLOBAL, not per-tenant**
> (`wfreg:<workflowId>`, unscoped `listRegisteredWorkflows()` + route). Its job is global
> by-id resolution for run/`:fork`/agents/projects. **Repointing the dashboard at it as-is
> is a cross-tenant data leak (IDOR).** Do NOT make the global registry per-tenant
> (breaks the resolution contract). **Compose:** add a **per-subject ownership index**
> (a `DurableCollection` keyed by `subject` → owned `workflowId`s) OVER the global
> registry; the registry stays the by-id resolver, the index governs the dashboard list +
> IDOR-guarded get/delete. This is Phase 1 and gates everything.
> **R2.** "Use template" mints a **fresh unique owned `workflowId` per instance** — NOT
> ADR 0152's deterministic `chainId:expansionId` (collides across users in the global
> store). Expand-once → re-id → store (still `:fork`-safe: the stored def resolves
> verbatim).
> **R3.** Key the ownership index by **subject (user OR anon-session)** so the anon "try
> it" path survives; anon gets an anon-scoped owner or stays on localStorage.
> **R4.** Migration imports only the **caller's own** localStorage into their **own**
> ownership; localStorage demotes to a draft tier (no forced migration); anon→signed-in
> claim handled explicitly. No cross-subject import.
> **R5.** Reorder phases: the per-subject ownership/IDOR layer is **Phase 1** — retire the
> leak BEFORE the dashboard reads the registry.
**Depends on:** ADR 0152 (workflow-chain pack loader), RFC 0013 (`Accepted`), ADR 0046 (projects), the roster/agent-portfolio model, the workflow registry

> **Intent (verbatim from the maintainer).** "An app can download the workflow packs
> and they are stored as templates, fully functional, fully real. Once a user picks a
> template, it should be fully editable in the builder — they can add new nodes and
> connectors and run the workflows, assign the workflows to agents and projects, etc.
> Remove any bad assumptions and poor implementations from the past where we were
> treating this as a throwaway demo." If the workflow-pack or builder architecture
> needs rewiring, that's on the table.

> **Reframe this corrects.** A prior turn argued templates must be "demo-runnable" or
> they're broken. That was the throwaway-demo assumption talking. In a real app, a
> template whose node needs a connector should **invite the user to connect it** — not
> be dumbed down to toy nodes. "Add nodes and connectors and run" is the product, not a
> failure mode.

---

## The throwaway-demo assumptions to remove (audited, file:line)

| # | Assumption / poor implementation | Where | Why it's wrong for the intent |
|---|---|---|---|
| 1 | **"Your workflows" is localStorage-only** | `builder/persistence/localStore.ts:1-6`; `WorkflowsDashboard.tsx:6` | Workflows aren't durable, multi-device, or assignable to agents/projects until a RUN transiently registers them. Not real. |
| 2 | **Templates restricted to 5 demo-executable nodes** | `builder/templates/premadeWorkflows.ts:6` | Hardcodes toy graphs (`noop/delay/uppercase/approval/chat`) faking RAG/ETL/review. Real packs use real nodes. |
| 3 | **Templates are inline hardcoded constants** | `premadeWorkflows.ts:118-541` | No pack feed, no versioning, no download. Can't reflect packs published at packs.openwop.dev. |
| 4 | **"Use template" clones to localStorage** | `premadeWorkflows.ts:548-560`; `WorkflowsDashboard.tsx:181` | A throwaway local copy — not a real backend workflow you can run/assign/replay. |
| 5 | **No pack→template instantiate flow** | (missing) | No expand-chain→register-workflow path; the ADR 0152 loader expands but nothing instantiates. |
| 6 | **No backend template/chain-list surface** | `routes/packs.ts:108` ("Sample doesn't ship a real catalog") | The gallery can only read the frontend constant; installed packs are invisible to it. |
| 7 | **Demo-session messaging** | `InMemoryHostBanner.tsx`; builder i18n "reset after 24 hours" | Tells users their work is disposable — the opposite of the intent. |
| 8 | **No "needs connector setup" affordance** | `palette/nodeCatalog.ts:104-109` (only `missingHostSurfaces`) | A real template with an unconfigured connector should prompt "connect this", not silently fail. |

---

## What already exists (compose, don't rebuild)

The backend foundation for "real" is **already here** — the throwaway-ness is almost
entirely the frontend's localStorage layer + missing glue routes:

| Capability | Exists at | Reuse |
|---|---|---|
| Durable, per-tenant workflow store + full CRUD | `host/workflowsRegistry.ts` (register/get/list/delete; KV-backed) + `routes/workflows.ts` | **The single source of truth** for "your workflows" — replace localStorage with this. |
| RUN already resolves from the registry/catalog | `workflowCatalog.getWorkflow` (catalog source A → registry) | A registry workflow is already runnable + `:fork`-replayable. |
| Assign to **agent** | roster `RosterEntry.workflows: string[]` (`rosterService.ts`) — bare backend `workflowId`s | A registry workflow id drops straight into a portfolio. |
| Assign to **project** | `Project.workflows: string[]` (`features/projects`, ADR 0046) | Same — references backend `workflowId`. |
| **Chain expansion** (frozen, deterministic) | `host/workflowChainPackLoader.ts` (ADR 0152) — `expandChain` + `loadWorkflowChainPacks` + `listChains`/`getChain` | The pack→workflow engine; just needs a route to expand→register. |
| Full **node palette** (all real nodes) | `palette/catalogRegistry.ts` ← `GET …/node-catalog` | The builder can already place every real node — no 5-node limit in the builder itself. |
| Workflow packs **published** | packs.openwop.dev (RFC 0013) + the vendored-pack pattern | The template source. |

**Conclusion:** this is a **rewire that composes existing seams**, not a new parallel
system. The registry becomes the builder's source of truth; the template gallery is fed
by installed workflow-chain packs; "Use template" = expand→register; assignment is free.

---

## Decision

Make **workflow-chain packs the first-class source of builder templates**, and make the
**backend workflow registry the source of truth** for the builder — retiring the
localStorage-only / hardcoded-demo model.

1. **Templates come from installed workflow packs.** A backend route lists the chains in
   installed/vendored workflow-chain packs (`listChains()` → REST). The builder template
   gallery reads that — not a hardcoded constant. Packs are vendored now (RFC 0013), and
   an app can install more from packs.openwop.dev (download/fetch is a later increment).
2. **"Use template" instantiates a real workflow.** A new endpoint expands the chain
   (ADR 0152 `expandChain`, with the author's parameters) → `registerWorkflow` → returns
   a durable, per-tenant `workflowId`. The builder opens THAT — fully editable.
3. **The builder reads/writes via a per-subject ownership index over the registry (R1).**
   "Your workflows" lists the caller's OWNED workflow ids (a `DurableCollection` keyed by
   subject), resolving each definition from the registry — durable + multi-device + IDOR-
   safe. The global registry stays the by-id resolver for run/`:fork`/agents/projects;
   the ownership index is the dashboard + authz layer. Edits persist through it.
   localStorage demotes to an offline draft cache.
4. **Editing is unrestricted.** The full node palette (incl. connector-consumer nodes) is
   already available; a template is a normal `WorkflowDefinition` — add nodes/connectors,
   run, fork. No 5-node limit.
5. **Connectors are an invitation, not a failure.** When a placed node needs a connector
   not yet configured, show a "connect this" affordance (extend the existing
   `missingHostSurfaces` chip) linking to *Access & data → Connections*. Running surfaces
   an actionable "configure X" — never a silent break.
6. **Assignment is first-class.** From a real registry workflow, assign to an **agent**
   portfolio (`RosterEntry.workflows`) or a **project** (`Project.workflows`) — both
   already key on backend `workflowId`. Add the gallery/detail affordance.
7. **Drop the disposable framing** where the registry now persists (the 24h-reset /
   InMemoryHostBanner messaging) — keep an honest "in-memory host" note only where the
   host genuinely lacks durable storage.

---

## Phased plan (do NOT execute on this ADR alone — architect-review first)

| Phase | Scope | Gate |
|---|---|---|
| **1 — Per-subject ownership index (R1/R5, the security gate)** | A `DurableCollection` keyed by `subject` → owned `workflowId`s over the global registry; scoped list + IDOR-guarded get/delete routes; `subject` = user OR anon-session (R3). | A tenant/subject sees ONLY its own workflows; cross-tenant read denied. **Retire the leak before any dashboard repoint.** |
| **2 — Pack→template glue** | `GET …/workflow-chains` (from `listChains()`) + `POST …/workflows/from-chain` (expand → **fresh unique owned id** (R2) → register + index → return). | A vendored chain → instantiate → owned registry workflow runs + `:fork` replays. |
| **3 — Dashboard on the ownership index** | "Your workflows" + "Use template" read/write via Phase 1 (not localStorage). localStorage → draft cache; import caller's own drafts (R4). | Dashboard reflects backend; survives reload/device; appears for assignment. |
| **4 — Pack-fed template gallery** | Gallery sources from installed workflow packs (retire/convert hardcoded `PREMADE_WORKFLOWS`); seed the ADR 0149 catalog as chain packs over published nodes. | Gallery shows the real workflows; "Use template" instantiates them. |
| **5 — Connector affordance** | "Needs connection" chip + CTA on builder nodes; run-time `connection_required` → actionable prompt. | A connector-bound template guides setup instead of failing opaquely. |
| **6 — Assignment + de-demo** | Assign-to-agent / assign-to-project from the gallery + workflow detail; retire disposable messaging where the registry persists. | Pick template → edit → run → assign, end to end. |
| **7 — Download from registry** | Optional: install workflow packs from packs.openwop.dev at runtime (SDK `RegistryClient`) — the "app downloads packs" arc. | A pack installed from the registry appears as a template. |

---

## RFC gate verdict

**Host-extension — no new wire RFC.** Listing installed chains, expanding (RFC 0013,
`Accepted`), registering to the workflow registry, and assigning to agents/projects all
ride existing accepted surfaces. The new routes are non-normative
`/v1/host/openwop-app/*`. **Possible additive capability advertisement** (e.g.
`capabilities.workflows.templatesFromPacks`) so clients can discover the gallery source —
additive, host-internal. The download-from-registry increment (Phase 6) uses the existing
registry HTTP API + SDK client — no new RFC. If template/pack *install* needs a new
normative contract (unlikely — it reuses the registry API), that's the only RFC trigger.

---

## Open questions / decisions checklist

- [ ] **localStorage fate:** demote to an offline draft cache (sync-on-reconnect) vs.
  remove entirely. (Lean: keep as an unsynced "scratch" tier, registry = SoT.)
- [ ] **Migration:** auto-import existing localStorage workflows into the registry on
  first load (per tenant/user), or leave them as local-only legacy?
- [ ] **The ADR 0149 catalog as chain packs:** author the 20 real-work workflows as
  workflow-chain packs (over published nodes) to feed the gallery — how many ship vendored
  vs installed-on-demand?
- [ ] **`PREMADE_WORKFLOWS` disposition:** delete, or convert the genuinely-useful ones
  (RAG, approval-gate) into vendored chain packs so nothing regresses.
- [ ] **Parameter-prompt UX:** "Use template" on a chain with `parameters` needs a form
  (RFC 0013 author-time params) before expand — new builder UI.
- [ ] **Tenant/RBAC:** which roles may instantiate / assign / delete registry workflows.
- [ ] **Connector affordance scope:** extend `missingHostSurfaces` to connectors, or a
  new `requiresConnections` node-catalog field surfaced from pack manifests.
