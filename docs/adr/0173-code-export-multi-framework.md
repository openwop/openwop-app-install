# ADR 0173 — Code Export (multi-framework source generation)

**Status:** implemented (Phases 1–3 — 2026-07-01). P1 generators + `POST …/canvases/:id/export`
→ Media-token download · P2 `ctx.features['app-builder'].export` surface +
`feature.app-builder.nodes.export` (pack 1.1.0) · P3 editor Export control (4-locale i18n).
`canvas.app-builder.export` left `['json']` (wire-clean); RN/Flutter + DeploymentService/
GitHub-push deferred. Tests: `code-export-route.test.ts` (9). Backend tsc/vitest + frontend
build/eslint green.
**Date:** 2026-07-01

> **§Deferred-work follow-on landed (2026-07-01):** React Native + Flutter generators shipped (all 6 targets now wired). GitHub-push export remains operator last-mile (live token, brokered egress).
**Track:** A (Software & App Architecture) — extends the `app-builder` feature under
`/v1/host/openwop-app/*`. **No OpenWOP wire change → no RFC** (see § /prd compatibility).
**Depends on / composes:** `app-builder` (the `canvas.app-builder` artifact + canvas
store), Media (ADR 0007 / RFC 0055 — generated ZIP is a media asset token), ADR 0014
(the first `ctx.features['app-builder']` surface), ADR 0006 (RBAC), ADR 0015 (tenant).
**Owner:** EXTENDS `backend/typescript/src/features/app-builder/` — NOT a new package.
**Toggle:** `code-export` (default **OFF**, `bucketUnit: tenant`) gating the export
route/UI; the app-builder feature itself is unchanged.
**MyndHyve baseline:** `src/core/export/` (`ExportService`, `generators/*` ~5,900 LOC,
`export/types.ts`, `exportSecurity.ts`, `DeploymentService`).

> **Port context.** MyndHyve's App Builder can emit framework-native source
> (React+Tailwind, React+styled, Vue+Tailwind, HTML/CSS wired; React Native + Flutter
> **Partial — coded, not wired**) from a built app. openwop-app already has the
> **`app-builder`** feature with an equivalent app model (`canvas.app-builder`); this
> ADR adds the export capability **onto** it.

---

## Context — boundaries & pre-existing-surface audit (done first)

The app model this generates from **already exists** and maps ~1:1 to MyndHyve's
`AppExportContext`: the **`canvas.app-builder` artifact type**
(`features/app-builder/artifactTypes.ts:14-70`) — `{ name, description?, theme,
screens:[{ id, name, route?, components: tree }], connectors[] }`, `additionalProperties:
false`, screens ≤ 60, component tree ≤ 200 nodes, validated against a **closed-world
component catalog** (`host/canvasComponentCatalog.validateComponentTree`) — never
executable code. That closed model IS the generator input.

**Single owners this feature composes (does not fork):**
- **App model → `app-builder`.** The canvas store (`getCanvasForTenant`) + routes
  under `/v1/host/openwop-app/app-builder/orgs/:orgId` (`routes.ts:46-94`, toggle +
  `authorizeOrgScope`). The generator reads the same tenant canvas; export is a new
  route **alongside** the existing four (`GET /catalog`, `POST /canvases/from-artifact`,
  `GET/PATCH /canvases/:id`) — existing routes untouched.
- **File bytes / download → Media (RFC 0055).** `mediaStorage`/`mediaService.createAsset`
  mints a serve token; bytes are served by `GET /v1/host/openwop-app/assets/:token`
  (`routes/mediaAssets.ts:110` — public, token-authed, tenant-isolated; a token minted
  for tenant A never resolves to B). **The generated ZIP is a Media asset — NOT a new
  blob store.**
- **Secret/PII scrub → the export-security discipline** (port MyndHyve `exportSecurity.ts`:
  sensitive-data scrub, size/file caps, filename sanitization) applied server-side
  before the ZIP is written.

**Collision-free:** every existing `export` route is owned elsewhere and unrelated —
`portability` owns the host-config `GET …/export` (RFC 0098 bundle); `chat-export` owns
conversation export; `routes/packs.ts` owns `/v1/packs/export`. **No collision** on an
app-builder-scoped export path. `app-builder` has **no `ctx.features` surface today**,
so this adds the first one (additive — `BackendFeature.surface` is optional).

## Decision

Add **server-side multi-framework source generation** to `app-builder`, gated by a new
`code-export` toggle. A `POST …/app-builder/orgs/:orgId/canvases/:canvasId/export
{ target, format }` route runs the generator over the tenant canvas, scrubs + zips the
output, writes it as a **Media asset**, and returns a serve token. Also exposed as
`ctx.features['app-builder'].export(...)` (ADR 0014) + a `feature.app-builder.nodes`
export node, so a workflow/agent can generate source.

### Port-not-clone corrections (the MyndHyve warts we do NOT inherit)

| MyndHyve shape | Correction here | Why |
|---|---|---|
| Generation + ZIP is **client-side** (`JSZip`/`file-saver`) | Generation + zip is **server-side**; output is a Media asset served by `/assets/:token` | Tenant-isolated bytes, size/abuse caps, no client trust; consistent with every other openwop-app download |
| RN + Flutter generators shipped **Partial (not wired)** | Ship ONLY the 4 wired targets (react-tailwind, react-styled, vue-tailwind, html-css); RN/Flutter are an explicit deferral | Never inherit a Partial (scope-rule §2) |
| `DeploymentService` (export-then-deploy, GitHub push) | **Deferred** — deploy/GitHub-push egress is a Connections-brokered follow-on, not Phase 1 | Egress + third-party auth is its own governed surface (ADR 0024/0037) |
| A catalog component with no framework mapping | **Degrades to a `warnings[]` entry**, never errors | Keeps export additive over the evolving closed catalog |

### The model

The export request/response are **host-extension shapes** (no wire schema):
```
POST …/canvases/:canvasId/export
  { target: 'react-tailwind'|'react-styled'|'vue-tailwind'|'html-css', format: 'zip' }
→ { assetToken, fileCount, sizeBytes, warnings: string[] }   // token → /assets/:token
```
Generators are per-framework modules ported under `features/app-builder/export/`, each
walking the closed component tree → `ExportedFile[]` (the MyndHyve per-generator shape,
minus the common-IR that never existed there).

## Phased implementation plan

- **Phase 1 — generator core + REST.** Port the 4 wired generators + `exportSecurity`
  scrub/caps into `features/app-builder/export/`; add the `POST …/export` route
  (toggle `code-export` + `authorizeOrgScope` write) that reads the tenant canvas,
  generates, scrubs, zips, writes a Media asset, returns the token. Route-harness tests
  (toggle gate, RBAC, IDOR, unmapped-component→warning, size cap).
- **Phase 2 — extension surface.** First `ctx.features['app-builder'].export(orgId,
  canvasId, target)` surface + `feature.app-builder.nodes` export node (role:action;
  recorded output = the asset token, replay-safe). **Core-app extension surface complete.**
- **Phase 3 — frontend.** An **Export** action in `AppBuilderEditorPage.tsx` (target
  picker + download via the asset token); designed empty/error/warnings states; `ui/`
  tokens; gated on `code-export`. (No agent pack — code export is a deterministic
  transform, not an AI surface; honest "none".)
- **Deferred (logged):** RN/Flutter generators; `DeploymentService`/GitHub-push (a
  Connections-brokered egress ADR); `github` export format.

## /prd five-architect compatibility pass (additive-&-protocol check)

| Architect | Verdict |
|---|---|
| **Spec** | No new wire vocabulary. Export is a `/v1/host/openwop-app/*` host-extension route; nothing normative. **N/A.** |
| **Schema** | No new/changed wire schema. The `canvas.app-builder` artifact schema is **unchanged**. ⚠️ **Trap avoided:** discovery advertises each artifact type's `export[]` facets (`routes/discovery.ts:1200`); we do **NOT** append framework targets to `canvas.app-builder.export` (stays `['json']`) — mutating that array *would* change the normative RFC 0071/0075 capability and require an RFC. Export lives on its own host-ext route instead. |
| **Security** | Generated source scrubbed for secret-shaped tokens + size/file caps + filename sanitization (ported `exportSecurity`); output is a tenant-isolated Media token (never cross-tenant); the closed component catalog means the generator emits templated JSX/HTML, never model-authored executable code. Deploy/GitHub egress deferred (would ride brokered egress). |
| **Conformance** | No capability advertised → no conformance scenario needed; `canvas.app-builder.export:['json']` stays behaviorally honest under `OPENWOP_REQUIRE_BEHAVIOR`. |
| **Compatibility** | **Additive.** New route + optional `surface` + new node + UI; zero change to existing app-builder routes/behavior/schema. Toggle OFF ⇒ app-builder byte-identical. Reversible (toggle + revert). |

**RFC gate: none.** Pure host-extension.

## Alternatives considered
1. **Append framework targets to `canvas.app-builder.export[]`.** Rejected — mutates the
   normative artifact-type capability advertisement (needs an RFC); a host-ext route is
   wire-clean and equally capable.
2. **Client-side generation (MyndHyve parity).** Rejected — bytes must be tenant-isolated
   + capped; server-side generate→Media is the app's download discipline.
3. **A new `code-export` feature package.** Rejected — it has no model of its own; it is
   a transform over the `app-builder` canvas. A parallel package would fork the app model.

## Open questions
- [ ] **RN/Flutter.** Port when a consumer needs mobile targets; they're Partial upstream.
- [ ] **Deploy/GitHub push.** A Connections-brokered egress surface — its own ADR.
- [ ] **Zip dependency.** Server-side zip adds one backend dep; confirm the bundle/image impact.
