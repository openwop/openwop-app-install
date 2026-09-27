# ADR 0340 — Canvas catalog prop/option labels: the `prop_*`/`opt_*` key contract

Status: implemented (2026-07-10)

## Context

Every catalog-driven property label in the canvas chassis rendered hardcoded
English: `PropertyField` printed `p.label ?? p.name` verbatim and enum
`<option>`s printed the raw value (`PropertyForm.tsx`). This was flagged three
times across the trackers (CODEBASE `SL-7`, UX `GS-5`/`SLUX-8`) as the one
framework-wide localization hole — the backend component catalog (app-builder's
42 distinct props), the slides block catalog, and every type's FE `propDefs`
all flowed through it. Slides had already worked around it locally with a
`LocalizedEnumWidget` resolving `opt_<field>_<value>` keys from its own
namespace (#1594) — a correct pattern trapped inside one type.

## Decision

Promote the slides pattern to a **chassis-level FIXED key contract**, extending
the one that already exists for frame vocabulary (`types.ts` — the chassis
reads `frameDefaultName`, `framesLabel`, … from the type's own namespace):

- `PropertyField` accepts an optional `tt` (the type-namespace translator the
  chassis already binds via `def.i18nNamespace`) and resolves:
  - labels: `tt('prop_<name>', { defaultValue: p.label ?? p.name })`
  - enum options: `tt('opt_<name>_<value>', { defaultValue: value })`
- **The code label is the fallback**, so adoption is incremental and a missing
  key can never blank a control. The `en` catalogs mirror the code labels
  (the cross-locale parity gate requires all four locales).
- Keys live in **each type's own namespace** (slides/drawings/cad/
  campaign-studio/app-builder) — the namespace stays the single owner of its
  vocabulary; no new namespace, no schema/type change, no second owner.
- `check-i18n`'s constructed-prefix scanner now also reads `` tt(`…${ ``
  templates, so the dynamic families aren't reported as orphans.

## Alternatives weighed

- **A `labelKey` field on `CanvasPropDef`** — rejected: ripples through the
  backend catalog types and the pack-declared types for no gain over the key
  convention; the name IS a stable key.
- **One shared `canvas-props` namespace** — rejected: splits a type's
  vocabulary across two namespaces and violates the feature-package boundary
  for catalog words that belong to the feature.
- **Per-component keys (`prop_<component>_<name>`)** — deferred: needed only
  for the two app-builder names whose label differs per component (`value`,
  `active`); those stay on their code-label fallback. Re-open when a
  translator actually needs them (requires threading the component type into
  `PropertyField`).

## Deliberate non-coverage (recorded)

- **Identifier vocabularies keep raw values:** icon-name enums
  (`icon`/`name`), numeric levels, and CAD SI units (`mm`/`cm`/`m`/`in`) are
  identifiers, not prose — no `opt_*` keys.
- The two label-conflicted app-builder props above.

## Phase record

| Phase | Landed |
|---|---|
| Seam (`PropertyField` `tt` + chassis pass-through ×5 call sites) | this ADR's PR |
| Key catalogs ×4 locales: slides 28 · drawings 16 · cad 1 · campaign-studio 17 · app-builder 83 | this ADR's PR |
| `check-i18n` `tt(`-template recognition | this ADR's PR |
