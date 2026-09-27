# ADR 0345 — App-builder safe interactive runtime (sanitized share, state, closed actions, mocks)

Status: Accepted (2026-07-10) — 3a–3d implemented; 3e pending

**Program:** ADR 0342 Phase 3. **Depends on / composes:** ADR 0343 (the facets
this runtime executes: stateVariables/actions/bindings/operations/sharePolicy),
ADR 0344 (chassis mechanics; the deferred workspace-tab + entity-graph seams
land HERE with their first consumer), ADR 0310 (`InteractiveViewer` — the one
tap-through runtime), ADR 0305 D (preview + share), ADR 0028/0033 (governed
connections for live mode).
**Research:** gap doc §5.2 PR-02..05, §5.5 DS-08, §5.6 DA-05/06/08/14.
**Toggle:** `app-builder` (unchanged) + ONE new sub-toggle `app-live-preview`
(OFF, tenant, Canvases) gating ONLY the consented live-connector mode (3e).
**Surface:** host-ext + frontend; no wire.

---

## Context (seam audit, 2026-07-10)

- `InteractiveViewer` (`canvas/InteractiveViewer.tsx`) is the ONE tap-through
  runtime (editor preview page, chat viewer, public share all mount it); its
  only state is `activeId` + a transition key; the only action is the delegated
  `data-cv-nav` click (`:100-104`). No state store, no action dispatch exists.
- **The public share returns the RAW document** — the `app_builder_canvas`
  resolver (`sharingService.ts:90-101`) passes `c.state` through, so sample
  rows AND the ADR 0343 facets (models, operations incl. mock rows,
  envRequirements, authProfile) are all published verbatim today (the recorded
  FEATURES.md data-posture note, now larger than when it was written).
- Live-mode egress owners already exist: `host/brokeredEgress.brokeredFetch`
  (governed adapter calls — the GitHub-publish precedent) and
  `host/connectionInjection.makeConnectionSafeFetch`.

## Decision

Make preview a truthful application simulator and the public share a sanitized
projection — in the existing runtime and resolver, never a parallel one.

| Slice | Scope | Placement |
|---|---|---|
| **3a — sanitized share (DS-08; FIRST — it is a live exposure)** | `sharePolicy` facet lands NOW (schema + validator + coerceApp), WITH enforcement: the share resolver applies `projectAppForShare(state)` — default **redacts** `dataSources[].rows` + `operations[].mock.rows` and **strips** `envRequirements`/`authProfile`/`designSystemRef`/`brandRef` (not needed to render); `sharePolicy.sampleData:'include'` / `perSource` flags opt sample rows back in. Mint-time disclosure copy in the share affordance. This flips the documented publish-verbatim posture in the SAFE direction (FEATURES row updated). | backend feature (`shareProjection.ts`) applied in the ONE resolver; no route change |
| **3b — ephemeral state + closed action interpreter (PR-02/03)** | `PreviewStateStore` (plain React state INSIDE `InteractiveViewer`, initialized from `doc.stateVariables`, reset on doc/version change — never Zustand/global); renderer stamps `data-cv-act` (READ mode, nodes with `actions[]`); the delegated handler resolves the node's `actions[]` from the doc and runs a DETERMINISTIC interpreter over the closed kinds: `navigate` (the existing path), `set-state`, `open-modal`/`close-modal` (frame-as-modal v1), `submit-form`/`invoke-operation` → 3c. Binding paths `state.X` resolve in the renderer ctx (the `{{field}}` precedent). **No eval, no expression language.** | chassis runtime hooks (type-blind: the type supplies the action resolver) + app-builder resolver |
| **3c — mock operation runtime + diagnostics (DA-14, PR-05)** | `invoke-operation` resolves the operation's `mock` (`status`/`rows`/`message`): `op.X.*` binding paths read the mock rows; `onSuccess`/`onError` followups run; a preview **diagnostics drawer** lists the action/operation trace (localized, capped). Designed loading/error/empty states ride the mock status switches. | chassis drawer slot + app-builder operation resolver |
| **3d — Data workspace (models/operations/state editors + entity graph)** | The ADR 0344-deferred seams land WITH their consumer: a `workspaceTabs` slot on `CanvasTypeDefinition`; the app-builder contributes a Data tab (models/fields/relationships + operations + state variables, schema-driven forms over the 0343 facets) and reuses `GraphSurface` for the entity-relationship view (second graph mount). | chassis slot + feature tab |
| **3e — consented live mode (PR-04)** | OFF-by-default `app-live-preview` sub-toggle; live calls run HOST-side through the governed egress owners against the operation's `adapterRef`, behind an explicit per-session user consent + a visible environment badge; mock-first always; traces redacted. Credentials never reach the document or the browser. | backend host-ext route + existing egress owners |

## Alternatives weighed

- **A browser-side operation runner** (fetch from the preview). Rejected: the
  document is untrusted content; arbitrary egress from the renderer is the
  exfiltration channel the doc's §8 table bans. Host-brokered only.
- **Zustand/global preview state.** Rejected: preview state is ephemeral by
  definition (PR-02); a global store invites persistence and cross-canvas leak.
- **Sanitizing in the FRONTEND share page.** Rejected: the wire response IS the
  leak; projection must happen server-side in the resolver.

## RFC verdict

None — host-ext + frontend; the sub-toggle is host-internal; nothing advertised.

## Phases

| Slice | Status |
|---|---|
| 3a | landed (this PR) — `projectAppForShare` in the sharing resolver (rows redacted by default; operations/env/auth/refs stripped); `sharePolicy` facet at both gates with soft perSource cross-refs; chassis `share.disclosureKey` confirm + app-builder disclosure copy (4 locales). FEATURES data-posture note updated |
| 3b | landed (this PR) — chassis mechanics (ephemeral vars store reset with the doc, frame-as-modal overlay w/ labeled close, delegated `data-cv-act`, `onTrace` seam) + app-builder semantics (`previewRuntime.ts`: navigate/set-state/open-close-modal; invoke-operation/submit-form = LOUD trace no-op until 3c); renderer stamps act paths + resolves `state.*` bindings (fallback+format; other roots → fallback until 3c). As-built: interactive form INPUTS (two-way change events) move to 3c with submit-form |
| 3c | landed (this PR) — invoke-operation/submit-form execute the operation's declared mock (never a network call): result under the reserved `op.<id>` key, ok/error followups (navigate + setState), op-path bindings + op-rows LIST unroll in the renderer; generic diagnostics drawer in the chassis viewer (trace, capped 100, doc-reset) with per-operation ok/error/empty designed-state switches (PR-05) — editor preview page only, never the share. As-built: interactive two-way form INPUTS still deferred (recorded; needs a change-event payload channel) |
| 3d | landed (this PR) — chassis `workspaceTabs` slot (switcher beside the Graph toggle; commitDoc = the ONE history seam) + the app-builder Data tab: state-variable/model/operation editors over the 0343 facets (\w-safe generated ids, bounded JSON mock editor w/ announced rejection) + the entity-relationship view REUSING GraphSurface (DA-03; session-ephemeral positions — the schema stores no model geometry; drag-to-connect adds a relationship). First consumer proves the ADR 0344-deferred seams |
| 3e | DEFERRED (recorded) — a live-invoke route today would broker to NOTHING: `operations.adapterRef` names installed operation adapters, and that seam is EX-01 work landing with the Phase 5/6 pack ecosystem. Activation trigger (the ADR 0307 pattern): when the first operation-adapter pack exists, 3e lands as `app-live-preview` (OFF, tenant) + a host-ext invoke route through `brokeredEgress`/`connectionInjection` with per-session consent + environment badge. Mock-first remains the preview default permanently |
