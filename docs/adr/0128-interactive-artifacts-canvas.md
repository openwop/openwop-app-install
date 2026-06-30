# ADR 0128 — Interactive artifacts canvas (live HTML/React/Mermaid/chart render)

**Status:** in-progress — **Phase 1 implemented** (2026-06-24): registered the interactive artifact TYPES (`interactive.{html,react,mermaid,chart}`) in the ADR 0055 registry with per-type JSON Schemas (additionalProperties:false). TYPES ONLY — NO renderer yet: an emitted interactive artifact validates + persists, but the workbench falls back to raw, and the live-render capability is NOT advertised (honest). The CSP-sandboxed canvas renderer (Phase 2) is the load-bearing security piece requiring /architect + /browser. Toggle `interactive-artifacts` OFF/tenant. Phases 2–6 pending. **Date:** 2026-06-23
**Toggle:** `interactive-artifacts` · default **OFF** · `bucketUnit: tenant` (a new code-rendering surface — opt-in per tenant; the sandbox is load-bearing, so it ships gated).
**Surface:** host-extension — **new interactive artifact TYPES** in the ADR 0055 registry (`html`/`react`/`mermaid`/`chart`) + a CSP-sandboxed **canvas renderer** inside the existing chat artifact surface (ADR 0069 workbench / preview). No new HTTP route; no new wire run-event.
**Depends on / composes (all implemented — this EXTENDS, it does not recreate):**
- **ADR 0069 (Chat artifact workbench + revision lifecycle)** — the workbench preview/raw/revisions/diff/provenance tabs (`frontend/react/src/chat/artifacts/ArtifactWorkbench.tsx`). Today its preview renders `Markdown` (`ArtifactWorkbench.tsx:155`) or an `<img>` (`:153`) — **there is NO live HTML/React/Mermaid execution**. This ADR adds an interactive-render path to that exact surface.
- **ADR 0055 (Host artifact-type registry, RFC 0071/0075)** — `host/artifactTypes.ts` owns the known types + per-type render/export facets. Register `html`/`react`/`mermaid`/`chart` as **host-native interactive types** with JSON Schemas, exactly as `doc.*` types are registered (`host/artifactTypes.ts`, ADR 0055 Phase 1). No parallel type system (ADR 0055 §"per-feature artifact validation — rejected, the parallel-system smell").
- **ADR 0083 (Run-output artifacts — the producer)** — `host/runArtifactStore.ts` + `host/artifactProjection.ts` already persist a run/agent output as a durable artifact and project it (`source:'run-event'`). An interactive artifact is the **same projection** with an interactive `artifactTypeId` — the producer/store/projection are reused untouched; only the RENDERER is new.
- **ADR 0051 (A2UI agent-authored chat surfaces)** — reuse its **host-pinned-catalog, fail-closed** safety discipline (`frontend/react/src/chat/a2ui/catalog.ts:27` "closed component allowlist"; the five `a2ui-surface-no-*` invariants). The interactive-artifact canvas is the **opposite trust posture from A2UI** (A2UI is declarative-no-code; this DOES run model-authored HTML/JS) — so the sandbox, not a catalog, is the containment; A2UI's "render only what the host pinned, reject everything else, never eval outside the boundary" *posture* is what we inherit.
- **ADR 0007 (Media) / ADR 0013 (Sharing)** — referenced assets + export follow the existing media-token + sharing policy (no remote/guessable URLs).

**RFC verdict:** **EVALUATE — registering a new artifact TYPE = host-ext, NO RFC; a normative cross-host type = NEW `openwop` RFC.** Per ADR 0055 §"RFC gate": RFC 0071/0075 are Accepted, so registering a host-native artifact type + advertising its facets is **host implementation, NO new RFC** — provided we advertise `host.artifactTypes` only for types actually rendered (`OPENWOP_REQUIRE_BEHAVIOR=true` honesty). **BUT** if `html`/`react`/`mermaid`/`chart` are to be claimed as **normative, cross-host** artifact types (a peer host MUST render them identically, or a new `artifact.created` field), THAT touches the wire → a **new `openwop` RFC first** (the deferred-forever path ADR 0083 §"RFC verdict" deliberately avoids). **Recommendation: scope v1 to host-native interactive types rendered in THIS host's chat canvas (host-ext); a cross-host normative interactive-artifact type is a future RFC.** **SECURITY is the central design concern — run `/architect` (the sandbox/CSP threat model) + `/browser` (the xyflow/CSP iframe precedent) before merge.**

> **Origin.** `docs/research/2026-06-23-ai-chat-competitive-analysis.md` §11 (LibreChat line 785: "Artifacts / canvas (React/HTML/Mermaid) — Partially exists (workbench; no live React/HTML render) · Medium · Enhance"; Open WebUI line 688; LobeHub line 735), §2 line 86 ("Artifacts / canvas — PARTIAL. **ABSENT:** code interpreter / live execution, interactive canvas"). Competitor impl: **LibreChat** `client/src/components/Artifacts/` + `api/app/clients/prompts/artifacts.js` (React Tailwind+shadcn+recharts+lucide / single-file HTML/CSS/JS / Mermaid, version history, iframe-sandboxed — research §5.2 line 317); **Open WebUI** `src/lib/components/chat/Artifacts.svelte` (sandboxed iframe HTML/SVG/code w/ CSP — §3.2 line 166); **LobeHub** `src/features/{EditorCanvas,PageEditor,TopicCanvas}/` + `packages/editor-runtime/` (§4.2 line 247); **AnythingLLM** `.../Chartable/` (inline data-viz charts, 10 types — §6.2 line 357); **Jan** `web-app/src/components/HtmlArtifact.tsx` (strict CSP-sandboxed iframe, scripts/network off by default — §7.2 line 454). **This FOLDS in the inline data-viz `chart` artifact** (AnythingLLM Chartable) as one of the registered interactive types.

---

## Context — boundaries audit first (MANDATORY)

The naive build is "a new canvas store + a new artifact pipeline + a bespoke HTML renderer." Every piece except the *sandboxed renderer* already exists; recreating any is the `no-parallel-architecture` violation (ADR 0083 was written precisely to stop the repeatedly-deferred "second artifact path").

| Concern | Existing owner (file:line) | How the canvas reuses it |
|---|---|---|
| Artifact-type registry + validation + facets | ADR 0055 `host/artifactTypes.ts` | **Register** `html`/`react`/`mermaid`/`chart` as host-native types (JSON Schema per type, served at `/schemas/artifacts/{id}.schema.json`). NOT a new registry. |
| Producing a run/agent output as a durable artifact | ADR 0083 `host/runArtifactStore.ts` (deterministic `${runId}:${nodeId}`, replay-safe) | An interactive output is persisted by the SAME producer; only its `artifactTypeId` + payload differ. NOT a new store. |
| Projecting an artifact for chat | ADR 0083/0069 `host/artifactProjection.ts` (`source:'run-event'`/`media`/`document`) | An interactive artifact projects identically; the workbench routes serve it unchanged. NOT a new projection. |
| The chat artifact UI (preview/raw/revisions/diff/provenance) | ADR 0069 `frontend/react/src/chat/artifacts/ArtifactWorkbench.tsx` (preview = `Markdown` `:155` / `<img>` `:153`) | **EXTEND the preview tab**: when `artifactTypeId ∈ {html,react,mermaid,chart}`, render the sandboxed canvas instead of Markdown. NOT a new modal/surface. |
| Closed-catalog / fail-closed safety posture | ADR 0051 `frontend/react/src/chat/a2ui/catalog.ts:27` (closed allowlist, reject-unknown, never-eval-outside-boundary) | Reuse the *posture* (host owns the containment; an unrenderable/over-budget artifact falls back to the existing `<Notice>`/raw view, never partial-evals). The containment here is the **iframe sandbox**, not a component catalog (this path DOES run model code, by design). |
| Revision history + diff | ADR 0069 (`DocumentVersion`/projection revisions + `host/textDiff.ts`) | Interactive artifacts get version history + a source-text diff for free (HTML/React source is text; chart spec is JSON → existing JSON diff). |
| Referenced assets + export | ADR 0007 Media / ADR 0013 Sharing | Any image the canvas references is a tenant-scoped media token (no remote/guessable URL — the A2UI `media-asset-url-tenant-scoped` invariant). |

**Net new (small, and concentrated on safety):** (1) four registered interactive artifact types + their schemas (ADR 0055 registration); (2) **the CSP-sandboxed iframe canvas renderer** in the workbench preview tab — *this is the load-bearing piece*; (3) a `mermaid`/`chart` render path (a vendored, no-network renderer); (4) the toggle gate. **No new store, no new projection, no new producer, no new route, no new wire event.**

---

## Decision

Ship an **`interactive-artifacts` feature (default-OFF, `bucketUnit:tenant`)** that registers four **host-native interactive artifact types** in the ADR 0055 registry — `html`, `react`, `mermaid`, `chart` — and renders them **live, in a strict CSP-sandboxed iframe**, inside the existing ADR 0069 artifact workbench preview tab. Model-generated HTML/React/Mermaid/chart-spec output (persisted by the ADR 0083 producer) becomes a live, interactive canvas in chat. **The app does NOT execute arbitrary model code anywhere except inside the locked-down iframe sandbox.**

### SECURITY — the central, load-bearing design concern

This feature deliberately RUNS model-authored code (the opposite of A2UI's declarative-only posture), so the sandbox IS the feature. The non-negotiable invariants:

- **Sandboxed iframe, `sandbox="allow-scripts"` ONLY — never `allow-same-origin`.** Granting both `allow-scripts` + `allow-same-origin` lets the framed script reach back into the parent origin (cookies, `localStorage`, the session) and defeats the sandbox entirely. We grant `allow-scripts` (so HTML/React/Mermaid can run) but **NOT** `allow-same-origin` — the frame is opaque-origin, cannot touch `app.openwop.dev` storage/cookies, cannot read the auth session.
- **Strict CSP on the frame document, network-gated by default.** `default-src 'none'; script-src 'unsafe-inline' <vendored libs only>; style-src 'unsafe-inline'; img-src data: <tenant-media-origin>; connect-src 'none'` — **no outbound fetch/XHR/WebSocket** (no exfiltration of anything the frame is fed; no SSRF/tracking-pixel; no calling the backend). The Jan / Open WebUI / LibreChat posture: scripts on, network off.
- **Served from a separate sandbox origin, not the app origin.** The frame document is delivered via `srcdoc` (or a dedicated `*.sandbox` origin), so even a sandbox-escape can't ride the app's cookies. No app token, no `Authorization` header, ever enters the frame.
- **React/Mermaid run as vendored libraries, no CDN.** No `script-src` to a remote CDN (that would be both a network-egress hole and a supply-chain vector). React/recharts/mermaid are bundled into the sandbox document.
- **Fail-closed, reuse the ADR 0051 fallback.** An artifact of an unregistered/unrenderable type, an over-budget payload, or a malformed spec falls back to the existing raw/`<Notice>` view — **never** a half-eval. Same posture as `a2ui/catalog.ts` reject-unknown.
- **Untrusted-content taint preserved.** An interactive artifact produced from a node that consumed untrusted MCP/A2A content carries `meta.contentTrust:'untrusted'` (ADR 0027/0051); the canvas renders it sandboxed AND surfaces the untrusted badge — and an untrusted-authored canvas cannot advance an approval (the existing `untrusted_content_blocks_approval` rule, ADR 0051).
- **No secret rendering.** Payloads are SR-1 redacted before storage (ADR 0083 already secret-scrubs run outputs); the canvas never receives credential material.

**`/architect` (sandbox/CSP threat model: same-origin escape, network egress, parent-DOM reach, postMessage surface) + `/browser` (the xyflow/CSP iframe precedent — `frontend/react/src/builder/canvas/` already vendors a third-party iframe-ish surface under CSP; validate light + dark, ARIA, and that no hardcoded-light/network leak ships) are REQUIRED before merge.**

### Data model — registered types only (extends ADR 0055; NO new store)

```ts
// host/artifactTypes.ts — register four host-native interactive types (ADR 0055 Phase 1 shape):
//   { artifactTypeId: 'html',    schema: …, render: { interactive: true }, registrationSource: 'host' }
//   { artifactTypeId: 'react',   schema: …  (single-file component source + optional props) }
//   { artifactTypeId: 'mermaid', schema: …  (a mermaid diagram source string) }
//   { artifactTypeId: 'chart',   schema: …  (a typed chart spec — folds AnythingLLM Chartable's ~10 chart types) }
// The PAYLOAD (source text / chart spec) is stored by the EXISTING runArtifactStore (ADR 0083),
// projected by the EXISTING artifactProjection. No new persistence.
```

### RBAC & isolation
Inherits ADR 0069/0083 artifact authorization verbatim: a projection resolves org FROM the source record and authorizes via `resolveEffectiveAccess(workspace:read)`; non-visible → 404 (never 403). The routes already **fail closed on a missing principal** (ADR 0083 MED-1, `requireSubject` → 401). The toggle gates whether the *interactive renderer* activates; the underlying artifact is still authz'd per-record. No new IDOR surface.

### Replay / fork
None new. The interactive artifact is persisted by the ADR 0083 producer under the deterministic `${runId}:${nodeId}` key (insert-only CAS, replay-fork-gated) — a re-execution returns the same artifactId, never re-mints. The source text / chart spec is the durable payload; the *rendered* canvas is ephemeral client-side derivation (re-rendered deterministically from the stored source). Nothing new touches the event log.

---

## Feature Evaluation Matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | A thin `interactive-artifacts` registration (host-native types via `host/artifactTypes.ts`) + the FE canvas renderer in `chat/artifacts/`. Composes ADR 0055/0069/0083; no parallel package logic. |
| 2 | Toggle / admin | `interactive-artifacts` toggle, default **OFF**, `bucketUnit:tenant` (the sandbox is load-bearing — gated rollout). |
| 3 | Workflow surface | None net-new — an interactive output is an ordinary run/agent output captured by the ADR 0083 producer. |
| 4 | Node pack | None required (any node emitting HTML/React/Mermaid/chart text is captured). A future `core.openwop.chart` sugar node is optional, deferred. |
| 5 | AI-chat envelopes | None new — the artifact projects through the existing workbench; distinct from A2UI (declarative forms) which stays the agent-authored-*form* path. |
| 6 | Agent pack | None — any capability-activated agent's output is captured if it emits an interactive type. |
| 7 | Public surface | None — the canvas renders inside the auth-scoped chat; the sandbox frame is opaque-origin with no app token. |
| 8 | RBAC + isolation | Inherits ADR 0069/0083 per-record authz (org-from-source, 404-not-403, fail-closed-on-missing-principal); toggle-gated renderer; **iframe origin isolation** is the runtime boundary. |
| 9 | Replay / fork | None new — ADR 0083 deterministic-key producer; rendered canvas is ephemeral, re-derived from stored source. |
| 10 | Frontend | Extend `ArtifactWorkbench.tsx` preview tab with a sandboxed-iframe canvas (replacing `Markdown`/`<img>` for the four interactive types); fallback to raw/`<Notice>` on unrenderable. Light + dark validated via `/browser`. |

---

## Phased plan

1. **Register the artifact types + schemas (ADR 0055).** Add `html`/`react`/`mermaid`/`chart` host-native types + per-type JSON Schemas; advertise `host.artifactTypes` only once the renderer is wired (capability honesty, `OPENWOP_REQUIRE_BEHAVIOR=true`).
2. **The sandboxed HTML canvas (the load-bearing piece).** The `srcdoc` iframe, `sandbox="allow-scripts"` (NO `allow-same-origin`), strict CSP (`connect-src 'none'`, no remote `script-src`), opaque origin. `/architect` threat-model review + `/browser` validation BEFORE this lands. Fallback to raw on any failure.
3. **Mermaid + chart.** Vendored (no-CDN) mermaid renderer + a typed chart renderer (fold AnythingLLM Chartable's ~10 types) inside the same sandbox document.
4. **React canvas.** Single-file React component source compiled/run in-sandbox (vendored React + recharts + lucide, no CDN) — the LibreChat shape, but network-off.
5. **Revision/diff + export.** Reuse ADR 0069 revision history + source-text/JSON diff; export follows ADR 0057/0013 facets. (Mostly free — interactive source is text/JSON.)
6. **Tests + security proof.** No-same-origin assertion, no-network-egress assertion (a frame `fetch` is blocked), no-parent-DOM-reach, no-secret-rendering, untrusted-blocks-approval, fail-closed-on-unknown-type, replay determinism, cross-tenant 404. The A2UI security-test suite (`a2ui-render-invariants.test.tsx`) is the template.

## Alternatives weighed

1. **A new universal "canvas" store + a bespoke artifact pipeline.** Rejected — ADR 0083 was written specifically to stop the repeatedly-deferred second artifact path; the producer/store/projection/registry/workbench all exist. This is a renderer + four type registrations, nothing more.
2. **Render model HTML directly in the app DOM via `dangerouslySetInnerHTML` (+ DOMPurify).** Rejected as the primary path — sanitized inline HTML can't run interactive scripts (the point of a canvas) and a single sanitizer bypass executes in the *app* origin (session/cookie reach). The sandboxed iframe is the only posture that runs scripts AND contains them. (DOMPurify-only is the AnythingLLM static-markdown path, fine for prose, insufficient for an interactive canvas.)
3. **Grant the iframe `allow-same-origin` for convenience (asset access).** Rejected categorically — `allow-scripts`+`allow-same-origin` together is a sandbox no-op (the OWASP/Jan/LibreChat warning). Assets come via `img-src data:`/tenant-media-origin only.
4. **Allow the canvas network access (load remote data/CDN libs).** Rejected — `connect-src 'none'` + no remote `script-src` is the exfiltration/SSRF/supply-chain defense; libs are vendored. A future *opt-in, host-mediated* fetch would be its own ADR + an SSRF-guarded proxy (RFC 0076 posture), not a default.
5. **Make these cross-host normative artifact types now.** Rejected for v1 — that's the wire (a peer host MUST render them) → an `openwop` RFC, the deferred-forever path. Ship host-native first (ADR 0055's own Phase-1 sequencing: native types first, cross-host claims later).

## RFC gate (the spec question, explicitly)

**EVALUATE → v1 = NO new RFC; a normative cross-host interactive type = NEW `openwop` RFC first.**
- **Registering host-native artifact types** (`html`/`react`/`mermaid`/`chart`) in the ADR 0055 registry + advertising their render facets is **host implementation over Accepted RFC 0071/0075** — no new RFC (ADR 0055 §"RFC gate"). Advertise only types actually rendered (honesty).
- **The RFC trigger (deferred, explicit):** claiming these as **normative cross-host** artifact types (a peer host MUST render `react`/`html`/`mermaid`/`chart` identically) or adding a new normative field to `artifact.created` touches the wire → a **new `openwop` RFC first** (the ADR 0083 §"RFC verdict" boundary — a cross-host normative `artifact.created` is a separate RFC if ever wanted). Until then these are non-normative host-native types served via the existing `/v1/host/openwop-app/artifacts*` routes.

## Open questions

1. **OQ-1 — React execution model.** Transpile the single-file component in-sandbox (Babel-standalone, vendored) vs require pre-compiled output? Lean: in-sandbox transpile (matches LibreChat's single-file authoring) — but it adds a vendored Babel to the frame; weigh bundle cost vs authoring ergonomics in Phase 4.
2. **OQ-2 — `connect-src` ever non-`'none'`?** Some charts want a data URL. v1: data inlined in the artifact payload (no network). A host-mediated fetch is a deliberate future ADR, not a default loosening.
3. **OQ-3 — Sandbox origin delivery.** `srcdoc` (simplest, opaque-origin) vs a dedicated `*.sandbox.app.openwop.dev` origin (stronger isolation, needs hosting/CSP config). Lean: `srcdoc` for v1; promote to a separate origin if the threat model (`/architect`) demands it.
4. **OQ-4 — Chart type coverage.** Match AnythingLLM Chartable's ~10 types, or a smaller v1 set (line/bar/pie/area)? Lean: the common four first, extend the schema additively.
5. **OQ-5 — Editability.** Is the canvas read-only (render the model's output) or user-editable (LobeHub `EditorCanvas`)? v1: read-only render + the existing revision history (a model revise = a new revision); in-place editing is a follow-on (it intersects ADR 0069 promotion).
6. **OQ-6 — Interactive-artifact size budget.** HTML/React source + chart spec cap (mirror the ADR 0083 ~1 MB inline cap); over-budget falls back to raw. Confirm the cap.

> **Phase 2 (sandbox renderer) implemented** (2026-06-24):** `SandboxedArtifactFrame` renders untrusted interactive-artifact HTML in a maximally-isolated iframe — `sandbox="allow-scripts"` WITHOUT allow-same-origin (opaque/null origin: no parent DOM/cookie/storage access, no credentialed requests; default sandbox blocks top-nav/popups/forms) + an injected `default-src 'none'` CSP (no connect-src → no exfiltration). The untrusted body goes ONLY into the iframe srcdoc — never the parent DOM (no dangerouslySetInnerHTML). Toggle-gated (`interactive-artifacts`). Reviewed via /architect (security-focused GO — the no-same-origin sandbox + no-egress CSP is the correct posture; a separate sandbox domain is a future Spectre-class hardening). /code-review + /ux-review clean. 5 security tests assert the isolation invariants. The kind-dispatch wiring into the artifact detail view (Phase 2b) + Mermaid/chart renderers + the live-edit canvas (Phases 3+) pending.

> **Phase 2b (dispatch wiring) implemented** (2026-06-24):** the `ArtifactWorkbench` preview now routes an `interactive.*` artifact to the security-reviewed `SandboxedArtifactFrame` (PR #807) — everything else stays the inert Markdown preview. The frame is lazy-split (the PR #804 pattern; entry budget held at 163.8 kB; it renders only for the rare interactive preview, behind a Suspense loading-card fallback). So an interactive artifact opened in the workbench now renders in the origin-isolated sandbox end-to-end. /architect (the frame's posture was security-reviewed in Phase 2; this thin dispatch inherits it), /code-review + /ux-review clean; artifact tests 14/14 (no regression). Mermaid/chart renderers + the live-edit canvas (Phase 3) pending.

> **Phase 3 (mermaid artifact renderer) implemented** (2026-06-24):** an `interactive.mermaid` artifact (whose body is Mermaid SOURCE) now renders as a DIAGRAM in the workbench preview via the ADR 0129 sandboxed `MermaidDiagram` (securityLevel:'strict' + a no-script null-origin iframe), NOT as raw HTML. The workbench dispatch now routes `=== 'interactive.mermaid'` → MermaidDiagram; other `interactive.*` → SandboxedArtifactFrame (Phase 2b); else Markdown. Composes the two shipped security-reviewed renderers (0128 + 0129) — no new renderer. Lazy (MermaidDiagram is its own chunk; entry 162.4 kB). /architect (inline — composes the two already-security-reviewed renderers; no new untrusted-content path), /code-review + /ux-review clean (reuses MermaidDiagram's a11y; consistent Suspense fallback). Artifact tests 14/14 (non-mermaid interactive.* unaffected) + MermaidDiagram's 5 security tests cover it. The chart renderer + live-edit canvas (Phases 4+) remain.

> **Phase 4 (chart renderer) implemented** (2026-06-24):** an `interactive.chart` artifact (`{chartType, data, options}`) renders as inline SVG via `ChartRenderer` (bar + line, the common cases). A chart is untrusted MODEL-GENERATED DATA (not code), so — unlike the HTML/Mermaid renderers (sandboxed iframes) — it renders VIA REACT: every label/number goes through JSX/textContent (auto-escaped), NO innerHTML, NO eval, and crucially NO charting-library dependency (a hand-rolled SVG, strictly lower-risk than the renderers fully /architected). A malformed/unsupported spec DEGRADES to the raw JSON (never throws/blanks). Lazy (its own 0.92 kB chunk; entry 162.4 kB). /architect (inline — untrusted-DATA renderer, React-escaped, no dep, parse-fallback — lower-risk than the code renderers), /code-review + /ux-review clean (SVG role=img + aria-label; token colors; no hex/dangerouslySetInnerHTML). 5 tests (bar/line SVG, malformed→raw, unsupported→raw, script-label inert). ADR 0128 now covers HTML sandbox + Mermaid + chart; only the live-edit canvas (Phase 5+) remains.

> **Phase 5 (live-edit canvas) implemented** (2026-06-24):** the ArtifactWorkbench preview wraps an `interactive.*` artifact in an EPHEMERAL live-edit canvas — an **Edit** toggle reveals a scratch `<textarea>` (seeded from the persisted source) whose DEBOUNCED draft (`renderSrc`, 250ms) feeds the SAME security-reviewed sandboxed renderer (MermaidDiagram / ChartRenderer / SandboxedArtifactFrame); **Reset** re-seeds, **Done** exits. /architect (Track A, security): GO — **NO new untrusted-content path** (the edited draft renders through the EXACT same origin-isolated / no-egress-CSP / no-innerHTML renderers; edited-vs-persisted source is identical from the isolation's view), **ephemeral** (local React state ONLY — no persistence, no revision write, no server call, so no replay/data surface; the read-only-in-v1 stance is preserved — a preview, not a save), the textarea draft is only ever rendered INSIDE the sandbox (never innerHTML'd into the parent), debounced so a fast typist doesn't thrash the iframe re-mount, and editing resets on artifact change. /code-review + /ux-review clean (0 banned/hex/innerHTML, canvas CSS is token-only, textarea aria-labelled, i18n×4, entry 163.1 kB). 3 tests (load + edit-canvas reveal + error). **ADR 0128 is now substantially complete** (sandboxed HTML + mermaid + chart + live-edit canvas).

---

## Follow-up action — surfacing audit (2026-06-24)

**Audit verdict:** 🟠 the renderer chain (HTML sandbox + Mermaid + chart + live-edit canvas)
is real, security-reviewed, and wired — but **nothing in the app PRODUCES `interactive.*`
artifacts**, and there is no "create a canvas" entry point. The render path only fires if an
agent/run happens to emit an artifact stamped `interactive.{html,react,mermaid,chart}`. So a
normal user never sees one: the feature is render-complete but producer-less.

**Correction (2026-06-24, deeper trace) — the gap is NOT just a missing producer; the
render path is currently UNREACHABLE.** The workbench renderer dispatches on
`ArtifactProjection.artifactTypeId === 'interactive.*'` (`chat/artifacts/ArtifactWorkbench.tsx:208`),
but **no projection ever carries an `interactive.*` artifactTypeId**:
- The run-artifact path (ADR 0083, `host/runArtifactStore.ts`) stores **no `artifactTypeId`
  at all** — `RunArtifactRecord` has no such field, and `host/artifactProjection.ts` adds none
  for `source:'run-event'`. So a node emitting `outputs.artifact:{artifactTypeId,…}` (the
  code-exec Phase-4b shape) does **not** surface that type to the workbench.
- The document path DOES set one, but `documentToArtifact` (`host/artifactProjection.ts:157`)
  **hardcodes `artifactTypeId = 'doc.' + doc.kind`** — it can only ever yield `doc.*`, never
  `interactive.mermaid`.

So shipping a producer agent/node pack ALONE would be a **no-op** — the artifacts still would
not render. The corrected, ordered work is a backend-plumbing prerequisite FIRST, then the
producer:
1. **Carry `artifactTypeId` to the workbench.** Persist a bound `artifactTypeId` on the
   document record (the `assemble` node already computes `asm.artifactTypeId` + emits
   `artifact.created`, but it is not stored) and have `documentToArtifact` prefer it over the
   `doc.<kind>` heuristic (still gated on `isRegisteredArtifactType`, so it stays honest).
   Replay-sensitive (the projection is read-only over immutable records) — needs `/architect`
   on the store contract + a backend unit test asserting the projection surfaces the type.
2. **Producer (ADR 0058 chat-drive):** a "Visualizer"/"Canvas" agent that creates a document
   whose content is the raw source (mermaid/HTML/chart-JSON — the renderer reads
   `revision.content` verbatim, NOT a structured payload) and binds the `interactive.<kind>`
   type, plus a prompt-library (ADR 0116) entry. No bespoke authoring UI.
3. **Browser-verify** the actual render (sandboxed iframe / Mermaid / chart) — this is the
   load-bearing confirmation a static build cannot give.

**Boundary check:** reuse the Documents store + the artifact projection + the agent surface
(ADR 0058) — no second artifact store, no second chat. **Status:** diagnosed; deferred from
the 2026-06-24 surfacing sweep because it is a backend-plumbing + browser-verified change,
not the pure-FE/pack fix the other audit items were. Tracked here rather than shipped as a
non-rendering producer (which would falsely read as "done").

> **Phase 6 (producer pipe) implemented** (2026-06-25): **the run-event path, not the
> document path.** On building it, the run-event producer (ADR 0083) is the right owner — a
> chat-produced diagram is a run output, not a managed/capped Document — and it completes the
> already-intended-but-dead code-exec `outputs.artifact` wiring as a bonus.
> 1. **Carry `artifactTypeId` to the workbench (run-event path).** `RunArtifactRecord` gains
>    `artifactTypeId?`; `persistRunArtifact` detects a typed `{ artifact: { artifactTypeId,
>    payload, title? } }` output envelope (`detectTypedArtifact`) — placed AFTER the
>    doc/media/serve detection (so real documents still LINK, not duplicate) and **skipping
>    document-backed envelopes** (those with a `documentId` → zero behavior change for the
>    `assemble` node) — and persists the declared type + the payload as content (raw string
>    verbatim, e.g. mermaid source; an object is JSON-serialized for the chart renderer).
>    `runArtifactToArtifact` surfaces it (registered-gated). Replay-safe (writeRow insert-only
>    on the deterministic key). This also makes code-exec's `code.execution-result` artifact
>    carry its type for the first time.
> 2. **Producer (ADR 0058 chat-drive).** `packs/feature.interactive-artifacts.nodes` — a
>    `render` node mapping `kind` → `interactive.{mermaid,chart,html,react}` + emitting the
>    typed envelope (UNTRUSTED), plus `packs/feature.interactive-artifacts.agents` — the
>    **Visualizer** persona allow-listed to that node. Both wired via the feature's
>    `requiredPacks` (mount at boot; the agent surfaces in `GET /v1/agents`). No new chat
>    surface, no bespoke authoring UI.
> 3. **Backend test** (`test/interactive-artifact-producer.test.ts`, 11 cases):
>    `detectTypedArtifact` (mermaid / chart / document-backed-skip / unregistered-skip) +
>    `persistRunArtifact → runArtifactToArtifact` surfacing `interactive.mermaid` + the
>    untyped-output-unchanged guard + the producer node. tsc clean; the full backend suite
>    shows no NEW failures (the 2 pre-existing `example-data-seeder-registry` failures are on
>    `origin/main` too). **Remaining: the `/browser` visual-render confirmation** (sandboxed
>    iframe / Mermaid SVG / chart) — the one thing a static build can't give.
