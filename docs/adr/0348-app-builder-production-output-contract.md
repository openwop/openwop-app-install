# ADR 0348 — App-builder production output contract (parity, preflight, lineage, OpenAPI)

Status: implemented (2026-07-10) — 6a #1695, 6b/6c/6d #1696; 6e (backend adapter) deferred pending the stack decision

**Program:** ADR 0342 Phase 6. **Depends on / composes:** ADR 0343 1c (the
capability manifests + `sourceAddress` convention + the RECORDED parity gaps
its honesty suite exposed), ADR 0346 (pack pipeline), ADR 0173/0306 (export →
Media, publish), gap doc §5.2 PR-08, §5.6 DA-10/11/12, §5.7 EX-02/03/04.
**Toggle:** `code-export`/`code-publish` (unchanged).
**Surface:** host feature + generators; no wire (`canvas.app-builder.export[]`
stays untouched — the ADR 0173 rule).

## Decision

| Slice | Scope |
|---|---|
| **6a — close the recorded parity gaps** | `themeColors` reach EVERY target's generated theme (tailwind/nextjs: `--app-primary` CSS vars + var-referencing primary styles; styled: CSS vars through the styled defs; RN: baked primary in the styles; Flutter: `ColorScheme.fromSeed`), and `hideOn`/`columnsMobile` gain real media queries on react-styled. Manifests flip IN THE SAME CHANGE (the honesty suite enforces both directions). RN/Flutter responsive stays honestly absent — platform-idiomatic breakpoints are a recorded follow-up, never a fake claim. |
| **6b — export preflight (PR-08)** | The export route consults the target's manifest against the DOCUMENT's used facets: unsupported actions/bindings/app-contract facets → structured `preflight` warnings in the export response (block only on explicit `strict`). |
| **6c — output lineage (the ADR 0343 deferral)** | Export appends `outputLineage[]` (`{canvasVersion, target, generatorPackVersion, assetId, hash}`) to the canvas via CAS — the writer the facet was waiting for; schema lands WITH it. |
| **6d — OpenAPI generation (DA-10)** | A new export artifact: `openapi.json` generated from `models[]`/`operations[]` (closed field lists → JSON Schema; `sourceAddress` refs in `x-openwop-source`), emitted alongside code for targets when the document declares operations. |
| **6e — backend generator adapter (DA-11/12)** | Deferred to its own slice/ADR when the first stack is chosen — migrations + SBOM + conformance fixtures come with it (the ADR 0342 open question). |

## RFC verdict
None — host-internal generators/exports; nothing advertised.

## Phases

| Slice | Status |
|---|---|
| 6a | landed (this PR) — themeColors real on ALL 7 targets (tailwind/nextjs CSS vars + var-referencing primary button; styled defs re-based on `var(--app-primary, …)` + theme.css; RN baked primary; Flutter `ColorScheme.fromSeed`); react-styled gains `HideOn` media wrapper + `GridBox $colsM`; manifests flipped IN THE SAME CHANGE (honesty suite green both directions); RN/Flutter responsive stays honestly absent. Also repairs the 4d gap: `packs.d.ts` typed for capture/repair/apply-repair (main tsc clean again) |
| 6b | landed (#1696) — `preflightExport` compares the DOCUMENT used facets (actions/bindings/models/operations/auth/env/responsive) against the target manifest; notes ride the export response additively; explicit `strict` 422s with the notes |
| 6c | landed (#1696) — **as-built correction**: lineage lives in a durable SIDE collection (`app-builder:export-lineage`), NOT the document facet — a document append would bump the canvas version and 409 any live editor session at export time. Entries carry the sha256 zip hash as the durable identity, capped 100, tenant-scoped; `GET .../canvases/:id/exports` lists them. The ADR 0343 `outputLineage` document facet is retired in favor of this |
| 6d | landed (#1696) — `openapi.json` generated from models/operations (closed field lists to OpenAPI 3.1 schemas; kind-idiomatic methods; `x-openwop-source` canvas addresses; bearer security for authed ops) and shipped INSIDE the export bundle on both delivery paths, only when operations are declared |
| 6e | deferred (stack decision pending) |
