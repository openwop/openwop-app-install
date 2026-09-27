# Entities (C9) — chat-first port review

**Scope:** `backend/typescript/src/features/entities/*` + `frontend/react/src/features/entities/*`,
pack `packs/feature.entities.nodes`, ADRs 0386 (headless content-modeling) /
0406 (localization) / 0407 (publishing + public read) / 0408–0409 (system-type
façades). Toggle `entities` default OFF; sub-toggle `entities-localization` OFF.

**Bottom line:** This feature **already rides the engine**, and rides it well —
it is a reference-grade ADR 0308 (feature-registered chat tools) + ADR 0014
(`ctx.features.entities` workflow surface) + ADR 0208 (host-event → workflow
binding) implementation. There is **no orphaned workflow, no toothless persona,
no parallel owner, and no second chat.** The ADR is scrupulously honest about
what it did *not* build (row 6: "Agent pack — None in v1"; Open questions:
Content-Modeler persona deferred). The only genuine chat-first gap is that the
**chat lane is read-only for a human** — a user cannot author a type or a record
by describing intent, because there is no entities agent persona and the write
path is workflow-nodes-only + the bespoke REST form. That gap is *deferred
honestly by the ADR*, not faked. The bespoke frontend is a legitimate
headless-CMS admin console (structural schema editing + read surfaces), almost
all of it PAGE-LEGIT. **The demolition list is empty.**

---

### Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Describe content model in chat (`openwop:entities.describe-type`) | `registerFeatureAgentTool`, SSoT-generated catalog, `SCHEMA_READ_EXEMPT`, fails EMPTY without acting user | **RIDES** | Leave alone — `agentTools.ts:32-75` is a model implementation |
| Query records in chat (`openwop:entities.query`) | feature-registered read tool, typed failure not empty, toggle-gated, system-type-blind | **RIDES** | Leave alone — `agentTools.ts:77-152` |
| Read/query/get in workflows (`ctx.features.entities`) | ADR 0014 surface face, tenant from run scope (CTI-1), system types blind to generic reads | **RIDES** | Leave alone — `surface.ts:82-149` |
| Create/update/delete in workflows | surface writes through closed-world validation; deterministic `entity:<runId>:<nodeId>` id (ADR 0162) → replay/fork-safe | **RIDES** | Leave alone — `surface.ts:150-200` |
| "On entity written" automation | `emitHostEvent('openwop-app.entities.entity-written')` → generic host-event→workflow binding seam | **RIDES** | Leave alone — `entitiesService.ts:494` → `hostEventDispatcher.ts:198-209` |
| Node executors (`feature.entities.nodes.*`, 6 nodes) | thin wrappers over the surface, inputs-win merge, id idempotency | **ADAPTER** | Leave; watch for drift from surface signature |
| Define/alter/delete entity types (schema) | bespoke type-builder form → `POST/PATCH/DELETE /types` | **PAGE-LEGIT** | Keep the admin page; **additive** port = modeler persona + type-write tools (deferred, below) |
| Create/edit/delete records | bespoke entity form → `POST/PATCH/DELETE …/entities` | **PAGE-LEGIT** | Keep; **additive** chat write path deferred |
| Taxonomies + terms | bespoke `TaxonomyPanel` CRUD | **PAGE-LEGIT** | Keep as admin page |
| Relationships (ER policies) | bespoke editor in `EntitiesPage.tsx:828-903` | **PAGE-LEGIT** | Keep as admin page |
| Filter / query bar + free-text search | bespoke read UI over `/query` | **PAGE-LEGIT** | Keep — read surface |
| Export / import NDJSON | bespoke, round-trips through the one validator | **PAGE-LEGIT** | Keep — data-ops, closed-world on import (`routes.ts:341-355`) |
| Schema graph (ER view) | read-only xyflow, tokened, `nodesConnectable={false}` | **PAGE-LEGIT** | Keep — honest read projection (`SchemaGraphPage.tsx`) |
| Public anonymous read API | opt-in, fail-closed, uniform 404, projection-only | **PAGE-LEGIT** | Keep — this is the headless-delivery product (`routes.ts:551-621`, `publicRead.ts`) |
| Publish / public-read / entry draft-live toggles | bespoke buttons → `PATCH /types` / `PATCH …/entities` | **PAGE-LEGIT** (with an honesty note, below) | Keep; consider an approval gate on `publicRead` (deferred) |

**Counts:** RIDES 5 · ADAPTER 1 · PARALLEL 0 · THEATER 0 · PAGE-LEGIT 8

---

### Blockers (from scouting) — each with the honest alternative

1. **The chat lane is READ-ONLY; there is no human chat-driven write path.**
   `agentTools.ts` registers exactly two tools, both read-only (`describe-type`,
   `query`). Writes exist only on (a) the workflow node lane (needs an author to
   *build a workflow* first) and (b) the bespoke REST form. So "add a `launchDate`
   date field to Product" or "create a product called X" **cannot be done by
   describing intent** — the Agency test's action-tool half is unimplemented.
   *This is not THEATER:* no persona claims to author (ADR row 6 says "None in
   v1"), so nothing lies. **Honest alternative:** an *additive* Content-Modeler
   agent pack (capability-at-core, activated via `agentProfile`) + two new
   **action** tools (`entities.author-type`, `entities.write-record`) that share
   the routes' `requireEntitiesScope` predicate (one helper, route + tool both
   call it) and fail *typed*, feeding through the existing type/record validators.
   The ADR already files this as an Open Question ("Content-Modeler agent pack —
   deferred until demand"). Keep it deferred-visible; do not fake it.

2. **No canvas trait for schema editing.** The interface test routes *structural
   editing* → a canvas trait, but schema modelling is a form (`EntitiesPage.tsx`
   type-builder) and the ER view is a **read-only** graph (`SchemaGraphPage.tsx`,
   `nodesConnectable={false}`, `elementsSelectable={false}`). There is no editable
   entity-schema canvas. *Not a blocker to correctness* — the form works and is
   PAGE-LEGIT admin — but it is the second additive port target if entities ever
   graduates to a "model your data visually" surface. **Alternative:** an editable
   schema canvas type over the existing canvas chassis + xyflow, applying
   type-edits through the same `updateEntityType` validator. Deferred, not owed.

3. **`publicRead` / publish flips have no approval gate.** Any
   `host:members:manage` holder flips a content type to anonymous-internet-readable
   directly (`onTogglePublicRead` → `PATCH /types`, `EntitiesPage.tsx:349-362`;
   route `routes.ts:221-244`). The platform's own precedent for consequential
   public exposure is approval-gated (CLAUDE.md: "Both paid listing lanes are
   approval-gated… multi-tenant phishing/squat vector"). Entities is single-owner
   here and does **not** reimplement approvals, so this is an *absence* of the
   HITL owner, not a PARALLEL of it. **Alternative (deferred):** route
   `publicRead: true` through the reviews-inbox approval kind when the workspace
   has >1 admin. Low priority; note it, don't build it speculatively.

---

### Demolition list (with regression pins)

**Empty.** No bespoke surface here duplicates an owned primitive:

- No second chat / "talk to AI" textarea in `EntitiesPage.tsx` or
  `SchemaGraphPage.tsx` (grep-clean) — the single-chat rule holds.
- No orphaned `WorkflowDefinition` and no `startWorkflowRun` in the feature
  (grep-clean) — nothing to ignite or retract.
- No hand-copied schema prompt — `describe-type` output is generated by
  `projectType` and pinned by `__tests__/promptCatalogParity.test.ts`.
- The type/record/taxonomy/relationship forms are genuine admin/structural
  surfaces, not shadows of approvals/conversations/schedules/canvas owners.

*Regression pin to ADD (cheap, prevents future drift):* a test asserting the
entities feature registers **only read-role** chat tools until a modeler persona
ships — i.e. `ENTITIES_*_TOOL_ID` set stays `{describe-type, query}` — so a
future "author-type" action tool can't be silently added to the ADR 0315
default-on baseline without a pack allowlist. (Today the two tools are honest;
the pin guards the port in blocker 1.)

---

### New-code inventory (only if the deferred ports are commissioned — all ADDITIVE)

- **Modeler persona:** `feature.entities.agents` pack (one generic Content-Modeler
  profile; nothing unique-to-a-named-agent in source — capability-at-core).
- **Two action tools:** `entities.author-type`, `entities.write-record` in
  `agentTools.ts`, sharing `requireEntitiesScope` (extract the predicate to one
  helper the routes already imply), typed failure + one bounded repair on the
  authoring path, pack-allowlisted (never default-on).
- **(Optional) editable schema canvas:** a canvas type over the existing chassis;
  no new graph lib (reuse xyflow as `SchemaGraphPage` already does).
- Reads/seams already exist (`entityLocaleContext`, `projectType`, host-event
  binding) — **no new store, no new wire RFC** (host-extension routes only).

This is deliberately small because the engine lanes are already correct.

---

### Phased plan (only if ports are commissioned — gated on real gates)

- **Phase 0 (now):** land the regression pin above (read-only-tool-set assertion).
  Gate: `npm run ci` green. No behavior change.
- **Phase 1:** extract `requireEntitiesScope` into a shared predicate helper;
  add `entities.author-type` + `entities.write-record` action tools + the
  `feature.entities.agents` persona; drive type/record authoring through the ONE
  chat scoped to that agent (`navigate('/?agent=…')`). Keep the admin form (it is
  PAGE-LEGIT). Close with /code-review + /ux-review; apply fixes.
- **Phase 2 (optional):** editable schema canvas over the chassis, applying edits
  through `updateEntityType`. Close with /code-review + /ux-review.
- **Phase 3 (optional):** approval gate on `publicRead` for multi-admin
  workspaces via the reviews inbox.

**Never demolish the admin console** — it is not a replacement target; the chat
path is additive to it.

---

### Deferred honestly

- **Content-Modeler agent pack + chat write tools** — *the* chat-first gap;
  already an ADR 0386 Open Question. Deferred until demand, stated not faked.
- **Editable schema canvas** — no canvas trait exists for schema today; the ER
  view is honestly read-only.
- **Approval gate on public exposure** — absent, not owed for a single-admin
  workspace; noted as a risk-scaled follow-up.
- **Localization** (`entities-localization`) — fully built and fail-closed but
  toggled OFF; reviewed on merits and rides the same read tools/nodes correctly
  (`agentTools.ts:61-64`, `surface.ts:48-57`). Nothing to port.
