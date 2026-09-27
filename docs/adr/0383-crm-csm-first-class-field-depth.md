# ADR 0383 — CRM/CSM first-class field depth (CRM-2 / CRM-3)

Status: Accepted — implemented (three PRs: CSM → Company → Contact)

Date: 2026-07-17

Lane: feature data-model depth (KV-blob stores — NO SQL migration) — no toggle, no wire

RFC verdict: **host work only.** Additive optional fields on host-ext KV entities touch nothing
on the OpenWOP wire.

## Context

Several CRM/CSM attributes a real deployment expects as first-class were customFields-only or
absent (DATA-ASSESSMENT **CRM-2** / **CRM-3**):

- **CSM Account** — no `renewalDate`, `arr`, `owner` (and no customFields map at all).
- **Company** — `size`/`revenue` absent (`size` lived in `customFields.employees`; no revenue).
- **Contact** — `title`/`address`/`leadSource` customFields-only; **phone** existed ONLY as an
  `identifiers[]` entry (ADR 0263, the identity-resolution SoT), not a surfaced field.

All three entities are KV-blob `DurableCollection`s (`crm:contact`/`crm:company`/`csm:account`
over `host_ext_kv`), and the read path already tolerates rows missing optional keys — so a field
promotion is a **TypeScript interface + write-path change + optional backfill, NO SQL migration**.

## Decision

Promote the fields to first-class, additively, in **three independent PRs** (each ships +
tests + reverts alone): **CSM (cleanest) → Company (adds a backfill) → Contact (phone model)**.

Cross-cutting rulings (architect-reviewed):

1. **Phone is a DERIVED first-class field, not a second stored column.** `identifiers[]` stays
   the sole identity-resolution SoT (indexed in `cdp:contact-ident` via `reindexContact`). The
   "first-class phone" is a **projection** over `identifiers[].find(type==='phone')` on read, and
   a `phone` input on create/update routes to the existing `addContactIdentifier` upsert
   (normalize + reindex). This gives an editable top-level phone with **zero drift window** and
   identity resolution unchanged — strictly better than a synced dual-store. No new
   `IDENTIFIER_TYPES` entry (phone already in the closed vocabulary).

2. **Backfill via `APP_MIGRATIONS`, not an ad-hoc pass.** Company `customFields.employees` →
   `size` is a forward-only, idempotent `APP_MIGRATION` entry (the framework exists for exactly
   this). The demo seeder and any demo **segment** filtering `customFields.employees` move to
   `size` in the same PR (the one migration hazard). Contact needs no backfill (title/address/
   leadSource were never seeded as customFields).

3. **Field types + fail-closed validation** (promoted fields leave the customFields validation
   seam, so each gets its own bounded validator that 400s a bad value, never silently mangles):

   | Field | Type | Validation |
   |---|---|---|
   | Contact `title` / `address` / `leadSource` | bounded string (`leadSource` FREE, not enum) | `cleanString` caps |
   | Company `size` | non-negative integer (employee count) | `Number.isInteger` ≥ 0 |
   | Company `revenue`, CSM `arr` | non-negative **number, MAJOR units** (matches the commerce `price: number` convention — minor units only at the Stripe boundary) | finite ≥ 0 |
   | CSM `renewalDate` | ISO date string | `Date.parse` guard |
   | CSM `owner` | opaque subject id string | bounded |

   Contact `address` is PII → added to `declarePiiFields('crm.contact', …)`. Phone stays under
   the already-declared `identifiers`.

4. **Frontend = plain labelled inputs**, not the commerce ProductForm dynamic-customFields
   machinery — these are fixed known fields. Full 4-locale i18n per field (the `check-i18n` gate
   is FATAL).

5. **Node packs**: reads auto-flow through the surface projection; the WRITE nodes
   (`create-contact`/`create-company`) that must accept the new inputs get a manifest input-doc +
   `index.mjs` + version bump. CSM account create/update is **route-only** (mirrors `crm/surface`),
   so CSM needs no node change.

## Alternatives weighed

- **Phone as the only store, migrate identity-resolution to read the scalar** — rejected: risky
  rewrite of `contactIdentityService` dedup for no benefit; the derived-projection keeps the SoT.
- **Phone scalar + identifiers[] independent (no sync)** — rejected: two phones can disagree.
- **Ad-hoc inline backfill** — rejected: `APP_MIGRATIONS` is the single owner of blob backfills.
- **One big PR** — rejected: three additive entities sequence cleanly with independent test/revert
  gates (Company's migration is a real gate).

## As-built (updated per PR)

| PR | Scope |
|---|---|
| 1 — CSM | `renewalDate`/`arr`/`owner` on Account: `csm/accountsService.ts` + `csm/routes.ts` + `csmClient`/`CsmPage`/i18n + `demoOpsPlanningSeed` + `test/csm-account-depth.test.ts`. No migration, no node pack. |
| 2 — Company | `size`/`revenue` on Company + `APP_MIGRATION 4` (`backfill-company-size-from-employees`, idempotent lift+drop): `crm/entities/companies.ts` + `host/appMigrations.ts` + `orgRoutes.ts` + `crmOrgClient`/`CompanyDetailPage`/i18n + `demoCrmSeed` (writes `size`) + `test/company-field-depth.test.ts`. No SQL migration; no node pack (reads auto-flow the strip surface; the create-company node accepts new inputs via the route). |
| 3 — Contact | `title`/`address`/`leadSource` (stored) + **derived** `phone` (read-only projection of the phone identifier; a `phone` write-input upserts the identifier + reindexes — never a stored scalar, verified by a raw-store test) + `address` added to `declarePiiFields`: `crm/contactsService.ts` + `crm/routes.ts` + `crm/surface.ts` + `feature.crm.nodes` create-contact (v1.1.0, pack 1.7.0) + `crmClient`/`ContactsTab`/i18n + `demoCrmSeed` (title/leadSource) + `test/contact-field-depth.test.ts` (incl. phone-never-persisted + identity-resolution-off-the-identifier). |

Cross-references ADR 0212 (CSM account model), ADR 0263 (contact identifiers), DATA-ASSESSMENT CRM-2/CRM-3.
