# ADR 0347 — App-builder signed content ecosystem (kits, template variables, catalog growth)

Status: Accepted (2026-07-10) — 5a implemented; 5b/5c pending; 5d deferred (first-consumer rule)

**Program:** ADR 0342 Phase 5. **Depends on / composes:** ADR 0344 2c (child
constraints — annotations land here with their consumers), ADR 0346 (pack
pipeline lessons: normative name grammars, dead-type rule, in-tree trust
posture), ADR 0305 F (screen templates — the single-screen precedent kits
generalize), ADR 0194 (tombstones), RFC 0095/ADR 0033 (pack-kind precedent).
**Research:** gap doc §5.3 CT-01/04/05/06/07.
**Toggle:** `app-builder` (unchanged; content packs decoupled from toggle state).
**Surface:** host pack loader + host-ext route + editor UI; no wire.

---

## Context

- Single-screen templates shipped in ADR 0305 F (`screenTemplates.ts`, the
  palette Templates tab + `TemplateGallery` preview); kits (multi-screen +
  connectors + variables) and DISTRIBUTABLE content did not.
- The ADR 0346 4a lesson binds here: pack-kind manifests can carry NORMATIVE
  name grammars — a new `canvas-content` kind is a HOST-PRIVATE convention
  (`kind` unrecognized by the spec loaders is simply kind-filtered out), and
  **promoting it to a normative cross-host kind requires an RFC first** (the
  standing 0342 watch-item).
- Marketplace truth (CT-06): ratings/install counts come only from the real
  Marketplace projections; template UI must not invent premium metadata.

## Decision

| Slice | Scope |
|---|---|
| **5a — canvas-content kits + template variables (CT-04/05)** | A host-private `kind:"canvas-content"` pack: `kits[]` of `{kitId, version, label, description, canvasTypeId, variables (JSON-Schema-lite: name/type/default/description), screens[], connectors[], catalogDependencies[]}`. A generic host loader (the artifactTypePackLoader pattern: kind-filter, validate, in-process registry, tombstone-aware) + a `GET <base>/kits` route on the canvas-editor factory (toggle-gated, type-scoped). Instantiation is CLIENT-side in the editor (the doc is client state): a variable form → `{{var}}` substitution into string props → screens+connectors inserted with collision-safe id remap in ONE history commit; the save-path validator remains the gate. First content: a `vendor.openwop.app-builder.kits` pack with an auth kit (login/register/reset + connectors). |
| **5b — curated catalog growth (CT-01)** | Value-ordered additions (form group w/ child constraints from ADR 0344 2c, textarea, date/time, file-upload placeholder, nav bar, side nav, search/filter, video placeholder) — EACH lands renderer + validator + AI catalog line + ALL 7 generators + parity tests in ONE PR (the 0305 C single-PR rule). One component per PR; the recorded generator parity gaps (themeColors/responsive) are Phase-6 work, not blockers here. |
| **5c — Marketplace truth (CT-06)** | Kit/template galleries show install/rating data ONLY from the real Marketplace projection; favorites stay local prefs (the palette-favorites precedent). No invented premium metadata. |
| **5d — pack-contributed components (CT-07/AI-10)** | Declarative component defs from packs render ONLY through the sandboxed UI-plugin seam (RFC 0130 PreviewPanel precedent); host validators/generators must know the type or mark it non-exportable. Deferred until a concrete pack exists (first-consumer rule). |

## RFC verdict

None — `canvas-content` stays a host-private registry convention (unrecognized
`kind`s are inert to conformant hosts). Promotion to a normative cross-host
kind = RFC first (flagged loudly, the 0342 watch-item).

## Phases

| Slice | Status |
|---|---|
| 5a | landed (this PR) — generic host loader (kind-filter, bounded validation, tombstone-aware, kit-id conflict detection), boot-wired; kits ride the EXISTING catalog response (additive — no new route); `vendor.openwop.app-builder.kits` ships the auth-flow kit (3 screens, 4 connectors, appName/accentColor variables); editor: chassis-owned gallery entry + variable form + JSON-escaped `{{var}}` substitution + ONE history commit, type-owned `insertKit` (collision-safe id remap, nav/connector remap, single-home preserved, vertical offset). Kit content closed-world-pinned against the live catalog in tests |
| 5b | IN PROGRESS — `form` group landed 2026-07-12 (the first REAL ADR 0344 2c constrained container: allowedChildTypes = controls+copy+button, minChildren 1 soft; renderer + validator pin + AI catalog line + all 7 generators + parity/constraint tests in one PR; nodes pack →1.6.1). `textarea` landed 2026-07-12 (joins the form's allowedChildTypes). `dateInput` (date/time/datetime) landed 2026-07-12. `fileUpload` placeholder landed 2026-07-12. `navBar` (constrained container of link/button, 1–8) landed 2026-07-12. `sideNav` (link/button/divider, 1–12) landed 2026-07-12. `search` + `video` landed 2026-07-12 — the 5b value-ordered list is COMPLETE (form, textarea, dateInput, fileUpload, navBar, sideNav, search, video; catalog 35→43). Further growth is demand-driven, not a standing queue. Exemplar retrofit (grade pass 2026-07-12): the Aurora seed Login + the Contact-form template + the auth-flow kit (→1.1.0) now wrap inputs in `form`, the seed Home carries a `navBar`, and the prompt gains nav-container guidance — the reference corpus no longer contradicts the prompt's own rules. Durable guard (grade pass 2026-07-12): `__tests__/referenceCorpusExemplar.test.ts` is a TRIPWIRE — it walks the seed + all templates + all loaded kits and fails if any `stack`/`grid` directly holds an input cluster (≥2 fields, or ≥1 field + submit) that belongs in a `form`; field vocab derived from the catalog SSoT (minus form/search/button/fab); scoped to stack/grid (accordion grouping allowed) and to `form` (nav rule deferred — would fire on legit footer links). It immediately caught a 4th drifted exemplar the manual pass missed (the `login` screen TEMPLATE), now fixed. |
| 5c | — |
| 5d | deferred (first-consumer rule) |
