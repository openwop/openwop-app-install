# ADR 0406 — Entity localization: per-locale field values on user-defined types

**Status:** implemented — Phases 1–5 (2026-07-17, #2003 / #2006 / `feat/adr0406-phase3`)
**Date:** 2026-07-17

**Phase-4/5 implementation notes (2026-07-17):** `ctx.features.entities.get/
query` + the pack nodes take an EXPLICIT `locale` arg (replay-deterministic —
part of the recorded invocation, never ambient); the resolved view drops the
overlay map (one locale in, one locale out); surface writes pass
status/overlays through the same fail-closed gate as the routes. Pack bumped
1.0.0→1.1.0 in its three pin sites (pack.json / feature.ts / entities-packs
test). `describe-type` + a new authed `GET …/entities/locale-context` serve
the workspace locale context from the ONE resolver (`entityLocaleContext`) —
the editor and models never re-derive toggle+settings. Editor: `Localizable`
checkbox on string fields; sparse per-locale translation groups on the entity
form (empty inputs never persist; base value shown as placeholder).

**Phase-2/3 implementation notes (2026-07-17):** overlays landed per D1–D3/D5
(`localizable` string-only on the seam; `Entity.localizations` sparse
overlays through the ONE validator in partial posture; `resolveLocalizedValues`
wraps `resolveSection` — one algorithm, two callers; explicit `?locale=` wins
on the non-normative public read, Accept-Language otherwise;
`Content-Language` + `Vary`; overlays never on the anonymous wire).
Corrections: (a) the **settings anchor is the tenant's PRIMARY org**
(`listOrgs(tenantId)[0]`) — entities are tenant-scoped with no org column;
multi-org tenants remain the recorded open question. (b) The ADR 0408 D2
**field-kind registry** landed here as the bare seam
(`registerFieldKindValidator`, built-ins non-overridable, registered kinds NOT
authoring-visible); the cms `blocks` registration waits for Phase C's storage
wiring — registering a kind the vocabulary can't yet store would be dead
config. (c) The NDJSON export route had silently projected AWAY entry status —
fixed alongside overlays (both round-trip; overlay rows error per-row when the
toggle is off, never a silent drop).

**Phase-1 implementation note (2026-07-17):** the settings promotion landed as
specified (store key `cms:langsettings` retained, cms routes unchanged, cms
re-exports the symbols so consumers are byte-identical — all 40 pre-existing
localization tests pass unmodified). Bonus recorded: `publishing/
prerenderService` had imported the settings FROM the cms feature (a
feature→feature edge); it now imports the core module — the promotion deleted
an existing boundary violation, not just enabled entities.
**Toggle:** NEW `entities-localization`, **default OFF** (opt-in; meaningful only when
`entities` is ON). OFF ⇒ the entities feature is byte-identical to today — no overlays
delivered, no negotiation, no locale UI.
**Depends on / composes:** ADR 0386 (entities — owns user-defined types/records),
ADR 0064 (CMS content localization — established `host/i18n/` as CORE-shared infra +
the per-org `ContentLanguageSettings` model), ADR 0205 (CMS locale governance),
ADR 0257 (shared custom-field seam), ADR 0014 (`ctx.<feature>` surfaces), ADR 0006
(RBAC), RFC 0103 (Accepted — the normative localized-content resolution model).
**Surface:** extends the existing host-extension `/v1/host/openwop-app/entities/*`;
promotes per-org locale settings from the `cms` feature to a core-shared owner
(`host/contentLocales/`).
**RFC gate:** **NO new RFC.** Rides Accepted RFC 0103's resolution model on a
non-normative host-extension surface (the ADR 0064 precedent). The `capabilities.i18n`
advertisement is unchanged.
**Program:** Phase B of the **ADR 0408 one-content-kernel program**. Scalar-field
overlays (this ADR) and block-internal overlays (the `blocks` kind's own
`resolveLocale`, ADR 0408 D2) are ONE localization model with kind-scoped depth —
`resolveLocalizedValues` is the single dispatch point; nothing is built twice.
**Origin:** architect options-evaluation 2026-07-17 ("entities stand-alone vs. fold
into CMS; where multi-language belongs"). The placement verdict: entities stays
stand-alone (ADR 0386 Alt-2 + ADR 0009 §Alt-2 hold from both directions); the
substantive gap is that a feature billing itself as *headless content-modeling* has
no per-locale content values — CMS sections do (ADR 0064), entity `values` do not.

---

## Context

ADR 0386 shipped the entities engine (user-defined types, taxonomies, relationships,
query, NDJSON import/export, entityApi, `ctx.features.entities`, chat tools) with **no
locale dimension anywhere**: `Entity.values` is a flat `Record<fieldKey, …>`; the only
i18n in the package is UI-chrome string translation (the mandatory 4-locale gate),
which is app-chrome i18n, not user-content i18n. The omission was unexamined — it
appears nowhere in ADR 0386's otherwise thorough deferral list. (A same-day correction
note on ADR 0386 now points here.)

Meanwhile the localization *machinery* already exists as core infra, built by ADR 0064
explicitly so "any future feature MAY localize":

- `host/i18n/` — `negotiateLocale` (Accept-Language parsing, never-throw) +
  `resolveSection` (the RFC 0103 §C normative shallow merge: exact → language family →
  base), with a core-purity guard test (imports nothing from `features/`).
- Per-org `ContentLanguageSettings { baseLocale, supportedLocales[], … }` — currently
  stored as `cms:langsettings` and owned by the `cms` feature (ADR 0064 D4). This is
  the one contested owner this ADR must resolve (see D4).

**Honesty note — this is a net-new enhancement, not a port omission.** The MyndHyve
baseline (`docs/steward/MYNDHYVE-BASELINE.md`) shows no per-locale entity values in its entity
system either; localized field values close a gap against the *headless-CMS category*
(Contentful/Strapi ship per-locale entries as table stakes), not against the port
parity target. Urgency is accordingly product-driven, not parity-driven.

## Boundaries audit first (single-owner declarations)

| Concern | Single owner | What this ADR does |
|---|---|---|
| User-defined types + records | `features/entities` (ADR 0386) | Gains an optional overlay field + locale-aware reads. No new store. |
| Locale negotiation + overlay merge | `host/i18n/` (ADR 0064 D2) | **Reused.** A values-level wrapper generalizes the same chain (D3); resolution stays byte-identical to RFC 0103 §C. No fork. |
| Per-org locale settings | today `features/cms` (`cms:langsettings`, ADR 0064 D4) | **Promoted to core** (`host/contentLocales/`) so cms AND entities consume ONE locale truth per org (D4). Features must not import each other; a second `entities:langsettings` would drift — the exact two-systems failure this app's reviews exist to catch. |
| Field-shape validation | `host/customFields` (ADR 0257) | **Reused.** Overlays validate through `validateFieldValues`; the seam gains one optional flag (`localizable`) exactly as it gained the `media` kind in ADR 0386 — with CRM/commerce pinning it out of their narrower vocabularies. |
| Translator narrowing grants | `features/cms` (`cms:localegrant`, ADR 0205 D1) | **Not annexed, not generalized in v1.** Per-type translator grants for entities are deferred until demand (Open questions). |
| CMS pages/sections | `features/cms` (ADR 0009) | Untouched. Pages are still not entities; entities still never render. |

**Nav/IA resolution (recorded so it is not re-litigated):** folding `/entities` into
the CMS nav is architecturally wrong-shaped — `Content` is an **admin-tier** nav group
(`chrome/features.tsx` filters `WORKSPACE_NAV`/`ADMIN_NAV` by tier) while entities is
a **workspace-tier** product surface. Setting `group: 'Content'` on entities would
mint a lone "Content" header in the workspace sidebar (no adjacency with CMS, which
lives in the admin rail), and demoting entities to admin-tier would hide a daily-use
product surface behind admin chrome. GROUP_ORDER already places `Content` and
`Platform` adjacent. **No nav change.**

## Decision

### D1 — Data model: sparse per-locale overlays on the Entity (additive)

Mirror ADR 0064 D1 exactly — one optional field, backward-compatible; every existing
entity deserializes unchanged:

```ts
export interface Entity {
  // …unchanged (ADR 0386)…
  values: Record<string, EntityValue>;                       // base-locale values (unchanged)
  localizations?: Record<string, Record<string, EntityValue>>; // NEW — sparse per-locale overlays
}
```

Overlay keys follow the same constraints as CMS (`^[a-z]{2}(-[A-Z]{2})?$`, never the
org's `baseLocale`). Each overlay is a **partial** map over the type's `localizable`
field keys only. Overlays are **embedded**, so NDJSON export/import, content-hash
idempotency, and the one-validator choke point (ADR 0386 Phase 3) carry locales for
free — no second serialization path.

### D2 — Schema: `localizable` on the ADR 0257 seam

`FieldSpec` gains an optional `localizable?: boolean`, meaningful only for
text-carrying kinds (`text`, `select` label-like usage is NOT localizable — options
are schema, not content). Non-text kinds reject the flag at type-save time
(closed-world). CRM and commerce pin the flag out of their vocabularies — the exact
`media`-kind precedent from ADR 0386.

Overlay writes validate per locale through `validateFieldValues` in its **partial
posture** (the entities update-path posture): only `localizable` keys are accepted,
`required` is a base-values invariant and is not enforced on overlays.

### D3 — Resolution: generalize the core merge, don't fork it

`host/i18n/` gains `resolveLocalizedValues(values, localizations, locale, baseLocale)`
— a values-level wrapper over the same normative chain (`exact → family → base`,
shallow merge). `resolveSection` becomes a thin adapter over it (or they share one
internal). One algorithm, RFC 0103 §C byte-identical, core-purity guard test extended.

### D4 — Locale settings: promote the owner, keep the data

`ContentLanguageSettings` moves to a core-shared service `host/contentLocales/`:

- The **store name stays `cms:langsettings`** — retained as a historical key so
  promotion is a pure ownership move with **zero data migration** (the ADR 0064 D6
  "operator env is the boundary-correct source" spirit: correctness over cosmetics).
- The **cms routes stay the management surface** (`GET/PUT …/cms/orgs/:orgId/language-settings`
  unchanged, same RBAC) and delegate to the core service. Wire + UI unchanged.
- `entities` consumes the core service **read-only** (which locales exist, what the
  base is). It mints no settings surface of its own.
- The `baseLocale ∉ supportedLocales` invariant enforcement moves with the service.

This is the headline decision. The rejected alternative — an entities-owned second
settings store — guarantees the drifted-org failure (pages in `pt-BR`, entities
claiming the org has no `pt-BR`).

### D5 — Reads: raw for the editor, resolved for delivery

- **Editor/admin reads** (`GET …/entities/:id`, list) return the raw record
  (`values` + `localizations`) so the editor authors every locale — ADR 0064 D3.
- **Resolved reads** (entityApi + an explicit opt-in on workspace reads) negotiate
  `Accept-Language` → `Content-Language` + `Vary: Accept-Language` via
  `negotiateLocale`, resolve through D3, and never leak the overlay map.
- **Explicit `?locale=` is permitted on entityApi and wins over the header.** RFC 0103
  forbids `?locale=` on the **normative** `/v1/content/*` surface; entityApi is a
  non-normative host-extension developer API where an explicit parameter is honest
  ergonomics (API consumers pin locales; browsers negotiate). Recorded as a deliberate,
  bounded deviation — the normative surface's rules are unchanged.
- **Query filters evaluate against BASE values only in v1** (the honest ceiling,
  matching ADR 0386's bounded-query posture). Results are returned resolved when a
  locale is in play. Filtering on localized values is deferred (Open questions).

### D6 — Workflow surface, nodes, chat tools: explicit locale, replay-safe

`ctx.features.entities.get/query` (and the corresponding `feature.entities.nodes`)
gain an **optional `locale` argument** — explicit, never ambiently negotiated inside a
run (the ADR 0064 §9 / `getPage({locale?})` precedent; request-scoped negotiation is
not replay-deterministic). Reads still ride the recorded-invocation cache.
`entities.describe-type` (SCHEMA_READ_EXEMPT) includes per-field `localizable` flags
and the org's locale set — generated from the SSoT, `promptCatalogParity` pins
extended.

### D7 — Toggle: its own gate, shared core

`entities-localization` (default OFF, `bucketUnit: tenant`) gates overlay writes,
resolved delivery, and the editor locale UI. It does **not** ride `cms-localization`
— a cms-named toggle gating entities behavior is a coupling smell; the two features
gate independently and compose the same core helpers. OFF ⇒ byte-identical: stored
overlays (if any) are simply ignored on delivery, exactly like ADR 0064 D7.

### D8 — RBAC

Overlay writes carry the same tier as entity writes (`workspace:write`); type-admin
changes to `localizable` flags ride the existing type-admin gate
(`host:members:manage`). No per-locale authority in v1 (ADR 0205's narrowing filter
stays cms-owned; see Open questions). Tenant+project IDOR guards are unchanged —
overlays live inside the row they guard.

## Phased plan

Each phase ships with tests and reverts alone.

- **Phase 1 — Settings promotion (no behavior change).** `host/contentLocales/`
  service over the existing `cms:langsettings` collection; cms routes/service
  delegate; invariant + tests move; core-purity guard (imports nothing from
  `features/`). Byte-identical wire.
- **Phase 2 — Schema + storage.** `localizable` on the seam (CRM/commerce pins),
  `Entity.localizations`, overlay validation (partial posture, localizable-keys-only),
  raw editor reads, NDJSON round-trip. Toggle lands (OFF).
- **Phase 3 — Resolved delivery.** `resolveLocalizedValues` in `host/i18n/`;
  entityApi negotiation (`Content-Language` + `Vary`, `?locale=` override); base-only
  filter rule enforced + documented in the route errors.
- **Phase 4 — Surface/nodes/tools.** `locale?` on `ctx.features.entities.get/query` +
  nodes; `describe-type` locale metadata; parity pins.
- **Phase 5 — Editor UI.** Per-field locale tabs on entity edit (the `SectionsEditor`
  locale-tab pattern: dirty buffers, copy-from-base), gated on the toggle + settings;
  4-locale chrome i18n; `ui/` cohesion.

## Alternatives weighed

1. **Entities-owned second locale settings store** — rejected; two locale truths per
   org drift (the review's dominant force).
2. **Ride the `cms-localization` toggle** — rejected; cross-feature toggle coupling,
   and an org may want localized pages without localized records (or vice versa).
3. **Per-locale entity rows** (a record per locale, MyndHyve's per-locale-section
   shape by analogy) — rejected; fragments identity, idempotency keys, references,
   export, and the query index. ADR 0064 already rejected this shape for sections;
   overlays-on-the-row is the established model.
4. **Merge entities into `cms`** — rejected; re-litigated and closed by the
   2026-07-17 architect review (ADR 0009 §Alt-2 + ADR 0386 Alt-2 hold from both
   directions; the read models differ — render-targeted fragments vs. queryable
   records).
5. **Do nothing** — rejected; a headless content-modeling feature without localized
   values undercuts the category claim, and the marginal cost is low with `host/i18n`
   already built.

## Open questions & assumptions

- **Per-surface locale sets.** v1 assumes ONE org locale set shared by pages and
  records. If real orgs need different sets (site in 6 locales, operational records
  in 2), `host/contentLocales` grows per-surface subsets — the promoted owner makes
  that additive. This is the recorded falsifiability condition from the review.
- **Translator grants for entities** (per-type/per-locale narrowing, ADR 0205's
  model) — deferred until demand.
- **Filtering/sorting on localized values** — deferred; requires per-locale index
  projections (the ADR 0386 indexed-projection deferral compounds here).
- **AI translate for entity overlays** — deferred; the generic JSON-translate prompt
  in `cms/translate.ts` is liftable to a shared home when this lands (the overlay
  sanitizer is CMS-specific; entities overlays are plain typed values and reuse
  `validateFieldValues` instead).
- **`capabilities.i18n` scope.** Unchanged: the advertisement claims negotiation on
  localizable content responses; entityApi is non-normative and simply behaves
  consistently with the claim. No advertisement change, no RFC.

## RFC verdict — host-extension, no wire RFC

Everything lands under `/v1/host/openwop-app/entities/*` + the non-normative
`host.openwop-app.entities` surface, riding Accepted RFC 0103's resolution model the
same way ADR 0064 does. No new run-event field, capability flag, endpoint contract,
or normative `MUST`. The one deliberate deviation (`?locale=` on entityApi) is
confined to the non-normative surface and recorded in D5.
