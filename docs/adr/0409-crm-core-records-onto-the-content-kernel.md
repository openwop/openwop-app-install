# ADR 0409 — CRM core records onto the content kernel (contact / company / deal as system types)

**Status:** implemented (2026-07-18) — company + deal migrated to the kernel;
contact COEXISTS (Phase-4 architect ruling); the generic entities API is
security-hardened against system-type exposure; legacy-store cleanup scheduled
one release out.
**Date:** 2026-07-18

> **Deploy-sequenced follow-ons** (KERNEL-6 straggler re-sweep + LEGACY-CLEANUP):
> paste-ready migrations + arming checklist in
> [`docs/DEPLOY-KERNEL-SEQUENCING.md`](../DEPLOY-KERNEL-SEQUENCING.md). They MUST
> land the release AFTER this program deploys (the v8 back-to-back lesson). The
> re-sweep logic itself is built + tested (`makeKernelAdapter.migrate({overwriteIfNewer})`).

**Phase-5 resolution (2026-07-18, dividends).** The originally-planned Phase-5
dividends resolved as follows — recorded rather than manufactured:
- **"Generic RBAC-gated query / `entityList` over CRM" — WITHDRAWN.** The
  Phase-4 security fix correctly makes system types (crm.company/deal)
  **invisible to the generic entities API + anonymous surface** (they're
  `neverPublic` and façade-only). So generic query over CRM is not a dividend —
  it would be the org-RBAC bypass we closed. The CRM façade (`listCompanies`/
  `listDeals`, org-scoped) remains the sole query path. No `entityList`-of-CRM
  (CRM is private, `neverPublic`).
- **Unified retention — ALREADY DELIVERED.** company/deal retention rides the
  kernel adapter unchanged (the RI-7 registered purger calls the adapter's
  `listForTenant`/`delete`); no additional work.
- **Delete legacy modules / stores — DEFERRED one release (by design).** The
  legacy `crm:company`/`crm:deal` collections stay READ-DARK for the rollback
  window; a next-release cleanup migration removes them (the cms.page-migration
  precedent). Deleting now would forfeit rollback safety.

Net: the CRM half of the one-content-kernel program is **company + deal on the
kernel, contact coexistent, security-hardened** — a deliberate, honest end state.

**Phase-4 decision (2026-07-18, contact = COEXIST — architect gate):** contact
STAYS in its own `crm:contact` store; it is NOT migrated to the kernel. The
gate ruled option **C (coexist)** over **A (migrate via a façade
`contactId→tenantId` index)** after eliminating every clean A (A′ id-encoding
breaks id-preservation; A″ tenantId-param breaks the honesty gate + cascades
every caller; B kernel-global-index was already rejected). The decider is the
**risk/value ratio**: contact is the LOWEST-value migration (tenant-scoped → no
org-query dividend; its identity graph + merge/tombstones + retention machinery
stay façade-owned regardless, so migrating only its bytes buys near-nothing)
and the HIGHEST-risk (a consistency-critical index + 2× reads on the hottest,
most PII-heavy read path — `getContact(contactId)` is tenant-less and called
across cdp/commerce/forms/journeys/webinars + to follow tombstones). This is
"fixed features for fixed domains" at the RECORD level — the per-record-type
coexistence this ADR sanctioned from the start. **The program's convergence is
substantially realized** (pages 0408, company + deal 0409, commerce.product
0410); contact is the natural exception. **Falsifiability:** revisit A only if a
unified cross-record kernel query that must include contacts materializes, or
the standalone `crm:contact` store becomes a maintenance burden.

**SECURITY FIX shipped in Phase 4 (2026-07-18) — system types are invisible to
the generic entities API.** Reviewing Phase 5's "generic query over CRM"
dividend surfaced a pre-existing hole (from ADR 0408 cms.page, AMPLIFIED by
company/deal to PII-adjacent data): a user with `workspace:read` + the
`entities` toggle ON could hit the GENERIC `/entities/types/crm.company/query`
route (or the `describe-type`/`query` chat tools, or the `ctx.features.entities`
surface) and read `crm.company`/`crm.deal` rows **across all orgs**, bypassing
the CRM façade's per-org `authorizeOrgScope`. Fixed: SYSTEM types are refused by
the generic user-facing entities surface — `requireEntitiesScope` 404s a system
type (all per-type routes, session + apikey), the `/types` list + `describe-type`
tool + `ctx.features.entities` read verbs filter them out, and the query tool/
surface return empty. Writes were already blocked (`assertNotSystemWrite`).
System types remain reachable ONLY through their owning façade (cms/crm/
commerce) and — for `publicRead` non-`neverPublic` types like commerce.product —
the anonymous read. Pinned by `entities-system-type-isolation.test.ts` (route +
surface). Also fixed a latent tsc error in the Phase-3 deal test (missing
`createDeal` reference-resolver callbacks — vitest doesn't type-check).

**Phase-3 note (2026-07-18, deal):** `crm.deal` system type (`neverPublic`);
full `Deal` → `ext.deal`, scalars (`org_id`/title/pipeline_id/stage_id/amount/
currency/company_id/contact_id/deal_status/close_date) → `values`; the same
tenant-aware kernel adapter as company, **simpler — deals have no merge/CAS**.
Stage history (`crm:stagehistory`) stays its own façade store; the relink/
unlink cascades route through the adapter's `listForTenant`. APP_MIGRATION 11
(`crm:deal`→kernel, id-preserving, idempotent). Honesty gate held: **all 28
CRM/deal suites (158 tests) pass UNMODIFIED**. (The 7 `documents-export` EPUB
failures on the current main are pre-existing/environmental from an unrelated
ADR 0400 lane — confirmed failing with this branch's changes stashed.)

**Resequence (2026-07-18, architect gate):** the phased plan below is executed
**company → deal → contact**, not contact-first. Reason: `getCompany(tenant,org,id)`
and `getDeal(tenant,org,id)` are tenant+org-scoped → they map DIRECTLY to
`getSystemEntity(tenant,type,id)` + a `values.org_id` check (the cms.page
`getPage` precedent), the clean case. `getContact(contactId)` is **tenant-less**
(the store is keyed by `contactId` alone; a global point lookup) while the kernel
is tenant-namespaced — the hard case, deferred to last (its gate decides a
façade `contactId→tenantId` index vs ADR-sanctioned coexistence; a kernel global
index was **rejected** — it would deform the kernel for a CRM quirk).

**Phase-2 note (2026-07-18, company):** `crm.company` system type (`neverPublic`);
full `Company` → `ext.company` (SoT), queryable scalars (`org_id`/name/domain/
industry/size/revenue/merged_into) → `values`; the service functions route
through a tenant-aware kernel adapter (the tenant-less `companies.get(id)` shape
is gone — every caller has the tenant); `authorizeOrgScope` + the cross-org
404 IDOR guard preserved (façade re-checks `org` after the kernel get). New
kernel primitives: **`casSystemEntity`** (byte-identical CAS over `ext.<domain>`
for the merge path — companies + later contacts) and **`listAllSystemRows`**
(global cross-tenant scan, migrations only — the `employees→size` backfill now
runs on kernel rows). APP_MIGRATION 10 (`crm:company`→kernel, id-preserving,
idempotent; runs after mig 4 so firmographics are pre-promoted). Honesty gate
held: **all 26 CRM suites (151 tests) pass UNMODIFIED**; the mint memo was
dropped (the cms.page storage-reset lesson).

**Phase-1 implementation note (2026-07-18):** shipped the `neverPublic` guard
only; the mooted `ext.customFields` validation hook was **dropped** (architect
gate): `putSystemEntity` already stores non-extension-kind `ext` keys blind, and
custom fields are runtime per-org additions the FAÇADE validates upfront via its
own ADR 0257 seam — a kernel-side validator would duplicate that (two owners of
custom-field validation, the drift anti-pattern). `neverPublic` landed as an
`EntityTypeRecord` flag with TWO locks: `updateEntityType` refuses to set
`publicRead` on it (lock 1), and the single anonymous-read funnel
`gatePublicType` refuses it outright even if `publicRead` were force-set (lock 2
— one line closes both public routes AND the crawler-prerender resolver, which
all route through `readPublicEntities`). Pinned by `entities-neverpublic.test.ts`
incl. a genuine lock-2 construction (a type carrying both flags via re-mint still
404s) + a positive control (cms.page-style publicRead not regressed).
**Program:** the first of the two "onto the kernel" follow-ons ADR 0408 deferred
(the other is **ADR 0410** — commerce product catalog). Both apply the ADR 0408
Phase C **cms.page façade template** to a fixed-domain feature.
**Depends on / composes:** ADR 0408 (one content kernel — the system-type + `ext`
channel + `putSystemEntity` façade pattern this ADR reuses), ADR 0386 (entities
engine), ADR 0008 (CRM), ADR 0213 §2 (contact tenant-scope vs company/deal
org-scope + custom-field seam), ADR 0209 §2 (contact merge / tombstones), ADR
0383 (CRM first-class field depth), ADR 0257 (custom-field seam), ADR 0162
(idempotent run ids), ADR 0006 (RBAC), ADR 0024 §4 (durable acting principal).
**Surface:** internal storage re-platform of three CRM record types. The entire
CRM API (`/v1/host/openwop-app/crm/*`, `ctx.features.crm`, `feature.crm.nodes`,
agent tools) is **unchanged**. Host-extension, **no new RFC**.

---

## Recommendation up front (read this first)

**Adopt the cms.page pattern for the three CORE RECORD types only — but treat
this as VALUE-GATED, not automatic.** Unlike pages (render-first, almost no
domain machinery), CRM carries a thick domain layer the kernel does not model:
an **identity graph** (contact `identifiers[]` + dedup/merge/tombstones), a
**split scoping model** (contacts tenant-scoped, company/deal org-scoped), and
**org-scoped RBAC**. All of that MUST stay in a CRM façade. So the honest benefit
of this migration is **substrate unification** — one content store with one
retention / localization / backup / generic-query / AI-readability substrate, and
the deletion of duplicated per-entity storage+index code — **not** domain
simplification (the façade stays thick).

Therefore: **coexistence (the status quo) remains defensible.** This ADR is
worth executing if the maintainer values a single content substrate enough to
pay the façade-preservation + migration cost; if not, the two-stores world CRM
lives in today is a legitimate end state. The plan below is written so it can be
**abandoned after Phase 1** (kernel-capability prep, independently useful) with
no CRM behavior change.

## Context — what CRM is, and why it is harder than pages

CRM owns three first-class record types with **fixed, code-owned schemas**:

- **Contact** — `crm:contact`, **TENANT-scoped** (no `orgId`; a person spans orgs,
  ADR 0213 §2). Carries name/email/company/stage/owner + `identifiers[]` (an
  email/phone identity index, `contactIdentityService`), merge tombstones
  (`mergedInto`, ADR 0209 §2), a `lastTriage` projection, and TENANT-scoped
  custom fields.
- **Company** — `crm:company`, **ORG-scoped**. name/domain/industry + ADR 0383
  firmographics (`size`/`revenue`), org-scoped custom fields, merge tombstones.
- **Deal** — `crm:deal`, **ORG-scoped**. title/pipelineId/stageId/amount/currency
  + soft refs `companyId`/`contactId`, org-scoped custom fields, stage history.

Around them sit **~18 operational stores** — pipelines, activities, tasks,
segments, snapshots, merge-events, the identity index, suppression, gmail-sync,
bookings, sign-requests, stage-history. These are **NOT content records**
(they're events, indexes, and operational state); they are **explicitly out of
scope** and stay exactly where they are.

The kernel (post-0408) already models what the three record types need for
storage: system types (code-owned schema, generic writes blocked), the `ext`
channel for structured/blind metadata, `putSystemEntity`/`get`/`list`/`delete`,
generic query, and localization. What it does **not** model — and what the façade
keeps — is the identity graph, merge, org RBAC, and the split scoping.

## Boundaries audit (single-owner declarations)

| Concern | Owner after this ADR |
|---|---|
| Content storage / generic query / retention / localization substrate | `features/entities` kernel — gains `crm.contact`/`crm.company`/`crm.deal` system types |
| Identity resolution (find-or-create by identifier, `identifiers[]` index) | **`features/crm` façade — UNCHANGED.** Runs BEFORE the kernel write; the kernel stores the resolved row, never resolves identity |
| Merge / tombstones (`mergedInto`, relink referrers) | **`features/crm` façade — UNCHANGED.** A tombstone is a `values`/`ext` state; merge logic is domain code |
| Org-scoped RBAC (`authorizeOrgScope`) + contact tenant-scope | **`features/crm` façade — UNCHANGED.** The façade owns EVERY read/write authorization; the kernel's anonymous public read MUST refuse `crm.*` types |
| Typed field vocabulary (ADR 0383) + custom fields (ADR 0257) | Fixed fields → the system type's code-owned schema; **custom fields → `ext.customFields`**, validated by the CRM façade's existing seam (kernel stores `ext` blind) |
| Pipelines / activities / tasks / segments / snapshots / identity index / bookings / sign / gmail-sync | **`features/crm` — UNCHANGED.** Not content; not migrated |
| The CRM API + `ctx.features.crm` + `feature.crm.nodes` + agent tools | **`features/crm` façade — UNCHANGED** (the honesty gate) |

**The loud non-goals:** `crm.*` types are **NEVER `publicRead`** (CRM is
operational/PII-adjacent data — the anonymous `public-entities` surface must
refuse them, defense-in-depth below); the kernel does **NOT** absorb identity
resolution, merge, org RBAC, or the operational stores; the CRM wire is
**unchanged**.

## Decision

### D1 — Three system-reserved kernel types; the CRM service becomes the façade

`crm.contact` / `crm.company` / `crm.deal` are minted as **system types**
(`mintSystemType`, dotted names, code-owned schema, generic writes blocked — the
ADR 0408 D1 machinery, unchanged). `crmEntitiesService` + `contactsService` become
the **domain façade**: they keep every exported function signature (routes,
surface, packs, tests unchanged) and store rows via `putSystemEntity` /
`getSystemEntity` / `listSystemEntities` / `deleteSystemEntity`, **id-preserving**
(`contactId`/`companyId`/`dealId` = `entityId`), so the identity index, merge
tombstones, stage history, and every stored reference keep their keys.

### D2 — Scoping: contact tenant-scope, company/deal org-scope, in ONE kernel

The kernel is tenant-scoped with a `projectId` namespace. Mapping:

- **Contact** → tenant-scoped kernel rows (`projectId: ''`) — matches today.
- **Company / Deal** → tenant-scoped kernel rows with **`org_id` as a queryable
  `values` field** (the cms.page `org_id` precedent). The façade filters every
  read by `org_id` and enforces `authorizeOrgScope` — the kernel never authorizes;
  it only stores + queries. A generic kernel query over `crm.company` returns
  rows across orgs, so the façade's RBAC-gated read is the ONLY sanctioned path;
  the never-public guard (D5) plus the façade wrapper keep cross-org rows
  unreachable without authorization.

### D3 — Fields: fixed schema in `values`, custom fields in `ext`, identity in `ext`

- **Fixed ADR 0383 fields** (name, stage, amount, size, revenue, …) → kernel
  `values` (scalars, queryable). The kernel type declares them; `putSystemEntity`
  validates them through the ONE seam.
- **Custom fields** (ADR 0257, per-org for company/deal, per-tenant for contact)
  → **`ext.customFields`**, validated by the CRM façade's existing
  `validateCustomFields` before the kernel write; the kernel stores `ext` blind.
  This resolves the system-type tension (fixed schema is code-owned; custom
  fields are runtime): they ride the extension channel, not the fixed schema.
  **Bonus available, not required:** a custom field flagged `localizable` would
  get per-locale overlays for free (ADR 0406) — deferred, but the substrate is
  there.
- **Identity** (`identifiers[]`) → `ext.identifiers` (the façade's identity index
  stays the SoT for lookup; the row's copy is the projection). **`phone` stays
  DERIVED** from `identifiers[]` at read time — never a stored scalar (the ADR
  0383 rule holds: the façade computes it, the kernel stores no phone).
- **Soft refs** (`companyId`/`contactId` on a deal) → `values` id strings,
  **façade-resolved** — NOT the kernel's generic relationship/onDelete engine
  (deal→company is a domain reference with CRM semantics, not a cascade policy).

### D4 — Merge / tombstones stay domain logic

A merge (ADR 0209 §2) relinks referrers and sets `mergedInto` — pure façade
logic. On the kernel a tombstone is just a row with a `merged_into` value that
the façade excludes from `listContacts`/duplicate groups. `putSystemEntity`
already blocks GENERIC writes to system types, so nothing can bypass the façade's
merge invariants.

### D5 — RBAC: `crm.*` is NEVER publicly readable (the critical guard)

Pages could opt into `publicRead`; **CRM must not.** Two layers:
1. The CRM façade never sets `publicRead` on `crm.*` types.
2. **Defense-in-depth:** system types gain an optional `neverPublic: true` flag
   (set on all `crm.*` types); `updateEntityType`'s publicRead carve-out (ADR
   0408 Phase D) **rejects** flipping `publicRead` on a `neverPublic` type, and
   the anonymous `public-entities` route refuses `neverPublic` types even if a
   flag were somehow set. A test pins that a `crm.contact` can never be served
   anonymously.

### D6 — Replay / idempotency unchanged

CRM writes from runs already use deterministic ids (ADR 0162, `crm/surface.ts`);
`putSystemEntity` preserves put-semantics, so a re-run/`:fork` re-derives the same
`entityId` and converges. The durable acting principal (ADR 0024 §4) still gates
the surface writes in the façade.

## Phased plan (abandonable after Phase 1)

- **Phase 1 — Kernel-capability prep (no CRM change).** `neverPublic` system-type
  flag + the publicRead-rejection guard + the anonymous-route refusal;
  `putSystemEntity` `ext.customFields` validation hook (accept a façade-supplied
  validator). Independently useful; ships with tests; **CRM untouched** — the
  safe stop point.
- **Phase 2 — Contact façade + migration.** `crm.contact` system type (tenant-
  scoped); `contactsService` stores via the kernel, id-preserving; identity index
  + merge tombstones preserved; APP_MIGRATION for `crm:contact` (idempotent,
  concurrency-safe, legacy read-dark one release). **Honesty gate: all contact
  route/surface/pack/identity/merge tests pass UNMODIFIED.**
- **Phase 3 — Company façade + migration** (`org_id` in values; org RBAC in the
  façade; ADR 0383 firmographics; company merge). Same honesty gate.
- **Phase 4 — Deal façade + migration** (pipeline/stage/refs; stage history stays
  its own store). Same honesty gate.
- **Phase 5 — Dividends.** Generic **RBAC-gated** query/`entityList` over CRM
  records (never anonymous); unified retention + optional custom-field
  localization; delete the three per-entity storage/index modules the façade no
  longer needs. Legacy stores' cleanup migration.

Each record type is an independent phase with its own migration and honesty gate;
a phase reverts alone.

## Alternatives weighed

1. **Coexistence — do nothing (the status quo).** CRM keeps its own stores.
   **Defensible** and the honest baseline: CRM's domain machinery means the
   façade stays thick either way, so the only thing gained by migrating is
   substrate unification. Recommended IF that substrate value isn't wanted.
2. **Migrate ALL of CRM (operational stores too).** Rejected — activities/tasks/
   segments/merge-events/identity-index are events/indexes, not content records;
   forcing them into the kernel muddies the "content store" boundary for no gain.
3. **CRM adopts only the kernel's QUERY engine, keeps its own stores.** Rejected —
   two storage substrates with one query layer is worse coupling than either
   clean option.
4. **Unify contact/company/deal into ONE kernel type with a `kind` field.**
   Rejected — they have genuinely different schemas, scoping (tenant vs org), and
   RBAC; three system types with a shared façade is the honest model (mirrors how
   cms.page is one type, not "content with a kind").

## Open questions & assumptions

- **Is substrate unification worth the cost?** The load-bearing open question —
  the maintainer's call (see Recommendation). Phase 1 is a no-regret prerequisite
  either way.
- **Identity index as a kernel concern?** Assumed NO in v1 — the identity graph
  stays a façade store; the kernel row carries a projection. A future "kernel
  secondary indexes" capability could absorb it, but that is its own ADR.
- **Contact tenant-scope convention.** Assumed `projectId: ''` (tenant root) is
  the right home; revisit if CRM ever needs a project namespace.
- **Custom-field localization** — available for free on the kernel (ADR 0406) but
  deferred; enabling it is a follow-on, not part of this migration.
- **Cross-feature reads** (commerce/CDP that read CRM records) — must continue to
  go through the CRM façade, never the kernel directly, so RBAC/scope hold. A
  guard test enforces "no feature imports `crmEntitiesService`'s kernel path
  directly."

## RFC verdict — host-extension, no wire RFC

A storage re-platform of three record types behind an unchanged CRM API +
`ctx.features.crm` (host-extension, non-normative). No run-event field,
capability flag, endpoint contract, or normative behavior changes. No new RFC.
