# ADR 0386 — Entities: headless content-modeling (user-defined types, taxonomies, entityApi)

**Status:** implemented (Phases 1–6, 2026-07-17, branch `feat/adr0386-entities`)
**Date:** 2026-07-17

**Implementation record + correction notes (2026-07-17):**

| Phase | Landed as |
|---|---|
| 1 — Types + entity CRUD | service/routes/RBAC/SPA page; type-name uniqueness is STRUCTURAL (deterministic key `${tenant}:${projectKey}:${name}` + CAS-from-null — the /architect TOCTOU finding) |
| 2 — Taxonomies + relationships | + `reference`/`media` field kinds via the seam; onDelete enforced (restrict default, cascade depth-limited, set-null blocked on required refs) over a reverse-ref index |
| 3 — Query + import/export | bounded post-filter + sort + cursor; NDJSON import w/ content-hash idempotency ids through the one validator |
| 4 — entityApi + webhooks | dual auth (Bearer `owk_` via `developer-keys.verifyApiKey`); publish gate (drafts 404 to keys); `openwop-app.entities.entity-written` (ids-only payload) via `hostEventDispatcher` |
| 5 — Schema graph | lazy `/entities/schema` over the existing xyflow dep |
| 6 — Surface + pack + tools | `ctx.features.entities` (7 ops) + `feature.entities.nodes` v1.0.0 (6 action nodes, ADR 0162 ids) + read-only chat tools (`describe-type` SCHEMA_READ_EXEMPT + `query`) + promptCatalogParity pins |

- **Correction — `projectId` is the existing ADR 0046 Project subject.** The open
  question "thin owned handle" resolved to REUSE: a supplied `projectId` must
  resolve via `projects/projectsService.getProject` (the 8-feature import
  convention); entities mints NO second project concept.
- **Correction — the "on entity written" trigger NODE became a host-event
  binding.** The established seam (ADR 0208; `routes/hostEvents.ts` explicitly
  reserves RFC 0099 trigger-subscriptions for the wire) is: users bind
  `openwop-app.entities.entity-written` → a workflow via `/host-events/bindings`. A pack
  trigger node would have been a second trigger path.
- **Correction — the `ref` kind is spelled `reference`** (the seam's existing
  vocabulary); `media` was added TO the seam (`host/customFields`) with CRM +
  commerce explicitly pinning their narrower vocabularies.
- **Deferred (recorded):** relationship `cardinality` ships as declared
  modelling metadata (schema graph); write-time enforcement is future work.
- **Grade pass (2026-07-17, same-day):** /grade-code + /grade-ux + /grade-data
  fixes applied — atomic plan-then-execute cascade delete (a 409 never leaves
  partial state; stale ref-idx markers self-heal via a liveness check, no
  "phantom restrict"), type-delete guard recounts from the bounded row slice +
  refuses while another type's `reference` field targets it, keyset query
  cursor (offset cursors skipped/duplicated under concurrent writes), filter
  value-type validation, draft schemas filtered from API-key `GET /types`,
  filtered Load-More uses the query cursor, stored reference values always
  selectable on edit, confirms on term/relationship delete, `.builder-canvas`
  theming + Controls + aria on the schema graph, localized enum chips,
  `ui-input` form primitives. **Residual (recorded, low):** the acting-member
  header is self-asserted (the app-wide orgs/cdp convention — safe under the
  tenant==principal model; revisit if multi-principal orgs land); ref/term
  index writes are post-row (a crash can strand a marker — tolerated on read
  via the liveness check); removed-field keys linger in `entity.values`
  (ignored on read); friendly-error microcopy + responsive stacking polish.
**Depends on:** ADR 0001 (feature-package architecture), ADR 0006 (RBAC scopes),
ADR 0014 (FeatureModule / `ctx.<feature>` surfaces), ADR 0015 (workspace-as-tenant),
ADR 0257 (shared custom-field seam), ADR 0270 (developer-keys / scoped API keys),
ADR 0058 (chat-drivability = agent + nodes), ADR 0162 (idempotent creation ids).
**Owner of user-defined types:** a NEW feature-package `src/features/entities/`.
**Surface:** `/v1/host/openwop-app/entities/*` + `host.openwop-app.entities`
(host-extension, NON-NORMATIVE — no RFC).
**MyndHyve §:** Platform Core — headless content-modeling (P1.1 in `docs/steward/MYNDHYVE-GAP-ANALYSIS.md`).
**Authored with:** the dual-track `/architect` skill (boundaries + capability honesty).

---

## Context

`docs/steward/MYNDHYVE-GAP-ANALYSIS.md` names the entity / headless-content-modeling system as
**"the single largest platform-core hole"** (P1.1, size L, no ADR yet). MyndHyve
ships a Strapi-style content platform: user-defined **content types** (schema-defined
fields), **taxonomies** with ordered terms, generic **entity CRUD + query** (server
filters, pagination), **relationships** with an ER-style schema visualization, an
**entity REST API** usable with project-scoped API keys, plus webhooks and
import/export. openwop-app has **none of this generic capability** — it has only
**typed custom fields on three fixed CRM entities**
(`backend/typescript/src/features/crm/entities/fieldDefs.ts:26` — `FieldType` over
`company`/`deal`/`contact` only). There is no way for a deployment to define a
*new* content type (e.g. `Recipe`, `JobPosting`, `Property`), give it fields, relate
it to another type, query it with filters, or expose it over an API key.

The user problem: a white-label adopter modelling a domain openwop's fixed features
don't cover today has to fork the codebase. The generic engine closes that hole and —
because it plugs into ADR 0014 — makes every user-defined type readable and writable
by the workflow engine and the one AI chat (`ctx.entities` + node pack + tools). That
last property is the strategic payoff: it turns "define a content type" into "give the
AI a typed, queryable store it can read before it writes and write through validation".

This ADR records the decision for **this host**. Everything lands under
`/v1/host/openwop-app/*` (non-normative); nothing touches the OpenWOP wire (see
**RFC verdict**).

## Boundaries audit first (single-owner declarations)

The failure mode this section guards against is the ADR 0004 orgs↔accessControl
collision (a parallel system shadowing an existing owner) and the ADR 0009 §Alt-2
temptation (a generic content-block store that muddies two features). `entities`
owns **exactly one** thing — *user-defined content types and their instances* — and
must not annex any of the following:

| Concern | Single owner (file:line) | What `entities` may / may NOT do |
|---|---|---|
| **CRM records** (contact/company/deal) + typed custom fields on them | `crm/entities/fieldDefs.ts:26,40` (`FieldDef`, `crm:fielddef` store); ADR 0008/0383 | `entities` does **NOT** absorb CRM's fixed entities. CRM keeps company/deal/contact as first-class, org-scoped, identity-resolving records. `entities` is the engine for **net-new** types only. **Migrating CRM onto `entities` is explicitly a NON-GOAL in v1** (see Open questions). |
| **The custom-field *shape* seam** (field-def validation, per-value loop) | `host/customFields/index.ts` (`buildFieldSpec`/`validateFieldValues`, ADR 0257 — "entity-agnostic custom-field seam") | `entities` **REUSES** this seam for `EntityType.fields` validation — it does NOT fork a second field validator. The distinction is load-bearing: the seam **adds fields to a caller-owned entity**; `entities` **mints the entity itself**. "Add a column" vs "define a table". |
| **CMS pages + sections** | `cms/cmsService.ts`; ADR 0009 (`cms:page`) | **Pages are NOT entities.** ADR 0009 §Alt-2 already rejected a generic content-block store shared with custom fields: *sections are typed, ordered, render-targeted fragments with their own sanitization*. Entities are **queryable typed records** (filter/relate), a different read model. `entities` never renders; `cms` never queries by field. No overlap, no shared store. |
| **Knowledge / RAG documents** | `kb/`; ADR 0011 | `entities` is structured records, not chunked/embedded documents. An entity may *reference* a KB doc by id, never own retrieval. |
| **API-key issuance + verification** | `developer-keys/apiKeyService.ts:31,110` (`devkey:record`, `verifyApiKey`, `ApiKeyRecord.scopes[]`); ADR 0270 | `entities` **adds a scope *grammar*** (`entities:<typeName>:read|write`, `entities:admin`) that `developer-keys` keys carry, and calls `verifyApiKey` at its route boundary. It does **NOT** mint a second key store or a bespoke token format. |
| **Orgs / members / roles / RFC 0049 scopes** | `host/accessControlService.ts`; ADR 0006/0015 | `entities` **inherits** `authorizeOrgScope` (read/write/admin tiers) — no parallel RBAC (the ADR 0004 lesson). |
| **Durable webhook delivery** | `host/webhookDeliveryWorker.ts` + `host/hostEventDispatcher.ts` | `entities` emits a host event on write; the **existing** HMAC-signed, retried, dead-lettered worker delivers it. No new delivery path. |

**The loud non-goals** (stated so a later contributor cannot quietly break them):
`entities` is NOT a second CRM, NOT a page/CMS store, NOT a second custom-field
*validator*, NOT a second API-key store, NOT a second RBAC system, NOT a second
webhook deliverer. It is one thing: the generic store for **types users define at
runtime**.

## Decision & data model

A new `entities` feature-package (toggle `entities`, default **OFF**,
`bucketUnit: tenant`) owns four KV-blob record kinds, tenant + **project**-scoped,
RBAC-gated and IDOR-guarded. It is a full ADR 0014 **FeatureModule** (service → REST
face + workflow-surface face + pack face).

### The model

```
EntityType {
  typeId, tenantId, projectId,            // project = a modelling namespace within the workspace
  name,                                    // machine key (slug, unique per tenant+project), immutable
  displayName, description?,
  fields: FieldSpec[],                     // REUSES host/customFields FieldSpec (ADR 0257), kinds extended
  status: 'draft' | 'published',           // publish gates the entityApi + write nodes for the type
  createdBy, createdAt, updatedAt
}
FieldSpec (from host/customFields, kinds extended for this engine):
  kind: 'text' | 'number' | 'boolean' | 'date' | 'select'   // from the seam
      | 'ref'                                                 // → another EntityType (this ADR)
      | 'media'                                               // → a Media token (ADR 0007; ref, never bytes)
  { key, label, required, options? (select), refTypeId? (ref), ... }

Taxonomy { taxonomyId, tenantId, projectId, name, displayName }
Term     { termId, taxonomyId, tenantId, parentId?, order:number, slug, label }   // ordered, optionally nested

Entity {
  entityId, tenantId, projectId, typeId,
  values: Record<fieldKey, string|number|boolean|null|string[]>,   // closed-world-validated against the type
  termIds?: string[],                                              // taxonomy membership
  createdBy, createdAt, updatedBy, updatedAt
}

Relationship {
  relId, tenantId, projectId, fromTypeId, toTypeId,
  cardinality: 'one-one' | 'one-many' | 'many-many',
  onDelete: 'restrict' | 'cascade' | 'set-null'                   // default 'restrict'
}
```

### Storage shape — KV blob, NO SQL migration (ADR 0383 precedent)

Every record kind is a `DurableCollection<T>` over `host_ext_kv`
(`entity:type` / `entity:record` / `entity:taxonomy` / `entity:term` /
`entity:relationship`), keyed by its id and tenant-indexed
(`listForTenantIndexed`) — the same shape ADR 0383 justified for CRM/CSM field
depth and `developer-keys` uses for `devkey:record`. **Justification:** entity
`values` is a typed JSON blob; the read path tolerates rows missing optional keys;
adding a type or a field is a write-path + validator change, never a schema
migration. A relational table-per-user-type would require **runtime `CREATE TABLE`
/ `ALTER TABLE`** — a DDL surface we deliberately do not expose (security + the
migration-integrity gate). KV keeps the whole engine additive.

### Indexing & query strategy (server-side filter + pagination)

Naïvely listing a type by scanning the whole tenant would repeat the run-snapshot
O(tenant) scan incident. So:

- **A per-`(tenant, projectId, typeId)` index collection** (`entity:by-type`, a
  membership list of entityIds) makes "list entities of type X" O(type rows), not
  O(tenant) — mirroring CRM's per-scope indexing.
- **Query = fetch the type's page + post-filter in memory over that bounded page.**
  Equality/`in`/range/text-contains over `values`, sorted, cursor-paginated
  (`limit` capped, opaque cursor). This is the same "list-then-filter a bounded set"
  posture as `segmentsService` / `listApiKeys`.
- **Honest ceiling:** free-form field filtering is post-fetch, so it is bounded by a
  per-type row cap (default proposal **10 000 rows / type / tenant**) and a
  per-tenant type cap. Promoting hot filter fields to an indexed projection (or a
  SQL side-table) is deferred (Open questions) — we ship the honest bounded engine
  and name the limit rather than pretend at unbounded query.
- **Ref + term lookups** get their own tiny index collections
  (`entity:ref-idx` / `entity:term-idx`) so "entities referencing X" and "entities
  in term T" don't scan.

### Webhooks — ride the existing durable seam

An entity write emits a host event `entity.written` (`{ typeName, entityId, op }`)
through `host/hostEventDispatcher.ts`. Subscribers registered on the **existing**
webhook machinery are delivered by `host/webhookDeliveryWorker.ts` — HMAC-signed
(`spec/v1/webhooks.md` recipe), exponential-backoff retried, dead-lettered. `entities`
writes **no** delivery code. (`entity.written` is a host-extension event on the host
dispatcher, **not** a normative OpenWOP run-event — see RFC verdict.)

### Import / export — NDJSON, through the one validator

`GET …/types/:name/export` streams one entity per line (NDJSON); `POST …/types/:name/import`
reads NDJSON and validates **each row through the same closed-world validator** the
routes/surface/nodes use (the CRM import precedent — one validation choke point, no
drift between entry points). Import is idempotency-keyed per row so a re-run doesn't
double-create.

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | **Feature-package + toggle** | New `src/features/entities/` (service + REST + surface + pack faces). Toggle `entities`, **default OFF**, `category: 'Platform'`, `bucketUnit: 'tenant'`, `salt: 'entities'`. Appended to `BACKEND_FEATURES`. |
| 2 | **Admin / toggle UI** | Standard feature toggle in the admin catalog (backend authority via `resolveOne('entities')`). No bespoke admin engine. |
| 3 | **`ctx.entities` workflow surface** (ADR 0014 face 2) | `host.openwop-app.entities` binding: `list` / `get` / `query` / `create` / `update` / `delete`. Reads replay from the FeatureSurfaceRegistry cache; writes are idempotency-keyed (row 9). Tenant+project from the run scope, **never** node args (CTI-1); the service enforces the tenant+project key. **This is the big AI win** — a user-defined type becomes a store the engine and chat can read-before-write and write-through-validation. |
| 4 | **Node pack `feature.entities.nodes`** | Entity `create` / `update` / `delete` / `query` / `get` nodes calling `ctx.entities`, capability-gated on `host.openwop-app.entities`. A **trigger** node "on entity written" bridges the `entity.written` host event into a run (the RFC 0083/0099 trigger-bridge precedent, ADR 0175). |
| 5 | **Envelopes / schema handshake** | **No new RFC 0021 envelope KIND.** Per the CLAUDE.md three-lanes rule, a type's schema is a *catalog/tool ask*, not an in-run intent envelope — an `EntityType` is exactly like a node/component/artifact schema (which the rule says are tool asks, not envelope kinds). Chat authoring rides **chat-time tools** (`registerFeatureAgentTool`, pack-allowlisted) + `ctx.entities`. The dynamic per-type schema is served by an `entities.describe-type` **catalog tool whose output is GENERATED from the `EntityType` SSoT** (never hand-copied), pinned by a `promptCatalogParity.test.ts` (the two-real-drifts lesson). Schema-carrying tool output is `SCHEMA_READ_EXEMPT` (never compacted). |
| 6 | **Agent pack** | **None in v1** (honest). Type modelling is a small admin surface; per ADR 0058 + "no second chat", modelling is driven through the **one chat scoped to a generic agent** with the entities tools/nodes — a dedicated "Content Modeler" persona adds no capability at core. A modeler agent pack is deferred (Open questions) until demand, per the capability-at-core rule (nothing unique to a named agent in source). |
| 7 | **Public surface** | **None in v1.** `entityApi` is **authed** — project API key or user token, always. There is no anonymous public-by-slug read (unlike CMS): entities may hold operational data, so read defaults closed. A per-type "public read" opt-in flag is deferred (Open questions). Stated explicitly so nobody assumes a public face exists. |
| 8 | **RBAC** | Inherits `authorizeOrgScope` (ADR 0006/0009 three-tier): **read = `workspace:read`**, **entity write = `workspace:write`**, **type-admin ops** (create/alter/delete `EntityType`, taxonomy admin, relationship admin) = **`host:members:manage`** (admin/owner). **Dual auth:** a user token resolves membership-derived scopes; a **project API key** carries the scope grammar `entities:<typeName>:read|write` / `entities:admin`, verified via `developer-keys.verifyApiKey` and matched fail-closed against `(tenantId, projectId, typeName)`. Every read/write re-verifies tenant+project → **404 on cross-scope** (no existence leak; the IDOR shape `developer-keys` already uses). |
| 9 | **Replay / fork safety** | Entity writes from a run supply a deterministic id `entity:${runId}:${nodeId}` (ADR 0162 pattern, the `crm/surface.ts` precedent) so a re-run/`:fork` of a node never double-creates. Surface reads route through the recorded-invocation cache (ADR 0014 invariant 3). Import rows carry per-row idempotency keys. |
| 10 | **Frontend** | `frontend/react/src/features/entities/`: (a) **Types editor** — define a type, add/reorder fields (schema-driven, reuses the field-kind form vocabulary); (b) **Taxonomy manager** — taxonomies + ordered/nested terms; (c) **Entity list / detail / edit** with server filters + pagination and **dirty-tracking** on edit; (d) **Schema graph** page — ER-style type/relationship visualization over the **existing xyflow** canvas dep (reuse, not a new graph lib; honor the xyflow theming rules). All in the shared `ui/` system (`.surface-card`/`.chip`/`ui/icons`, no emoji-as-icon, full 4-locale i18n — the `check-i18n` gate is FATAL). Nav via `FRONTEND_FEATURES` + a `GROUP_ORDER` entry (`Platform`/`Content` adjacency). |

## Phased plan

Each phase ships with tests and reverts alone.

- **Phase 1 — Types + entity CRUD.** `entitiesService` + `EntityType`/`Entity` KV
  stores + per-type index; REST routes (type create/list/get + entity CRUD),
  closed-world `values` validation via the ADR 0257 seam (kinds `text/number/bool/
  date/select`); RBAC three-tier; toggle. Frontend types editor + entity list/detail/edit.
- **Phase 2 — Taxonomies + relationships.** `Taxonomy`/`Term` (ordered, nested) +
  `Relationship` (cardinality + `onDelete`, default `restrict`); `ref`/`media` field
  kinds + ref/term indexes; taxonomy manager UI.
- **Phase 3 — Query/filter + import/export.** Server-side filter/sort/paginate over
  the bounded per-type page; NDJSON import (per-row idempotency, one validator) +
  export stream.
- **Phase 4 — entityApi keys + webhooks.** The `entities:<type>:read|write` scope
  grammar over `developer-keys` (compose `verifyApiKey`, no new key store); dual-auth
  route guard; `entity.written` host event → the **existing** webhook delivery worker.
- **Phase 5 — Schema visualization UI.** ER graph of types + relationships over
  xyflow (reuse), theming-safe in light/dark.
- **Phase 6 — `ctx.entities` + node pack + chat tools.** ADR 0014 surface + replay
  cache; `feature.entities.nodes` (CRUD/query + on-entity-written trigger); chat-time
  tools + the `entities.describe-type` catalog tool with the `promptCatalogParity`
  parity test.

## Alternatives weighed

1. **Extend the CRM custom-field seam to arbitrary entities** (let
   `host/customFields` mint new entity *types*). **Rejected.** That seam adds fields
   to a **caller-owned** entity; making it define the entity conflates "add a column"
   with "define a table" and would drag CRM's org-scoping + identity-resolution
   assumptions into a generic engine. We take the *right* half — **reuse
   `buildFieldSpec`/`validateFieldValues` for `EntityType.fields`** — without owning
   CRM's records. Complementary, not merged.
2. **Build on `cms` sections** (model entities as page sections). **Rejected.** ADR
   0009 §Alt-2 already refused a generic store shared with custom fields: sections are
   typed, ordered, **render-targeted** fragments; entities are **queryable typed
   records** (filter/relate/API), a fundamentally different read model. Sharing the
   store would muddy both — the exact drift ADR 0009 warned against.
3. **Integrate an external headless CMS** (Strapi/Contentful via MCP). **Rejected as
   the primary.** It fragments the data into a second system, forfeits tenant
   isolation / BYOK / replay guarantees, and *loses the entire payoff* — a **native**
   store the workflow engine + one chat read/write through `ctx` + tools. MCP stays
   available to pull *from* an external CMS as `<UNTRUSTED>`-fenced content, never as
   the store of record or the in-run intent channel.

## Open questions & assumptions

> **Correction note (2026-07-17, same-day architect review):** two items were
> missing from this list and are now owned by follow-up ADRs. (1) **Content
> localization** — `Entity.values` shipped with no locale dimension, an
> *unexamined omission* (CMS sections localize per ADR 0064; a headless
> content-modeling engine must too). Owned by **ADR 0406** (per-locale overlays
> over the core `host/i18n` chain + the locale-settings promotion). (2) **The
> delivery half** — nothing rendered an entity (no CMS section could reference
> one, and the deferred public read left anonymous surfaces closed), which made
> the engine read as a database UI rather than content modeling. Owned by
> **ADR 0407** (entity-backed `entityList`/`entityDetail` sections on the
> productGrid reference-not-copy pattern; RESOLVES the "public read-through
> per-type flag" question below via `EntityType.publicRead` + entry-level
> `status`). One boundary nuance recorded for 0407: a cms section may CARRY a
> bounded query spec as authored config; the query still EXECUTES only in this
> feature — cms implements no query engine, entities still renders nothing.
> **Superseding directive (same day):** the maintainer set the end-state — ONE
> content kernel, not two coexisting content stores. **ADR 0408** commits the
> program: this engine becomes the app's single content store; `cms` keeps its
> UX/workflow/vocabulary as a domain façade and stores pages as a system
> `cms.page` type (blocks field kind via a seam validator registry). This ADR's
> "Pages are NOT entities" boundary row therefore holds only until ADR 0408
> Phase C; the §Alt-2-derived STORE separation is superseded, while the
> vocabulary/sanitization ownership it protected is preserved inside the kind.

- **CRM (and commerce) migration onto `entities` — explicitly DEFERRED / non-goal in
  v1.** CRM keeps company/deal/contact as fixed first-class entities (ADR 0008/0383,
  with identity resolution + org scoping `entities` does not model). A future
  unification is a **separate ADR**, not an assumption of this one. The two coexist:
  fixed features for fixed domains; `entities` for user-defined ones.
- **KV scale / indexing ceiling.** List-by-type is O(type rows/tenant) via the index;
  free-form field filter is post-fetch over a bounded page. Assumed acceptable to
  **≤ 10 000 rows/type/tenant** (proposed cap) and a per-tenant type cap. Promoting
  hot filter fields to an indexed projection or a SQL side-table is deferred (watch
  the DB-growth watchlist / O(tenant)-scan incident).
- **Public read-through per-type flag** (CMS-style anonymous by-slug read) — deferred;
  v1 is authed-only.
- **Content-Modeler agent pack** — deferred until demand (v1 drives modelling through
  the one chat + tools).
- **`ref` on-delete default = `restrict`** (assumption; `cascade`/`set-null` opt-in
  per relationship). `media` kind stores a Media token (ADR 0007), never bytes.
- **Managed-vs-personal project scoping** — `projectId` is a modelling namespace
  inside the workspace (tenant stays the isolation boundary per ADR 0015); assumed a
  thin owned handle, not a new tenancy layer.

## RFC verdict — host-extension, no wire RFC

**Verified host work only.** Everything lands under `/v1/host/openwop-app/entities/*`
+ the non-normative `host.openwop-app.entities` surface — the exact ADR 0014 pattern
(`spec/v1/host-extensions.md`, capability-advertised, toggle-aware, replay-safe,
BYOK-clean). Nothing touches the OpenWOP wire: **no** new run-event field, capability
flag, normative event type, endpoint contract, auth/scale profile, or `MUST`. The
`entityApi` is a host-ext REST surface; project API keys ride the already-shipped
`developer-keys` primitive (ADR 0270); webhooks ride the already-shipped
`spec/v1/webhooks.md` delivery (`entity.written` is a **host-extension** event on the
host dispatcher, not a normative run-event). `ctx.entities` rides ADR 0014's sanctioned
`host.openwop-app.<feature>` extension — its promotion to a **normative** cross-host
`host.entities` would be a future RFC, explicitly out of scope here. No `openwop` RFC
required for this ADR.
