# UI Plugins (b3) — chat-first port review

**Scope:** `backend/typescript/src/features/ui-plugins` + `frontend/react/src/features/ui-plugins`, plus the core RPC seam `backend/typescript/src/host/uiPluginRpc.ts` and `backend/typescript/src/routes/uiPlugins.ts` (owned by core, not this feature), and the one cross-feature consumer `frontend/react/src/features/canvas-packs/PackCanvasEditorPage.tsx`.

**Headline verdict: nothing to port to chat.** UI-plugins is a *platform extensibility / isolation primitive* (RFC 0117/0119, ADR 0300 + ADR 0367), not an intelligence feature. It declares **no workflow, no node pack, no agent pack** — and correctly so: a sandboxed front-end plugin is UI, not an AI surface (`backend/.../ui-plugins/feature.ts:16-19`). The skill's core question ("does this express intelligence through the engine or fake it with bespoke UI?") largely does not apply; the feature already **rides the canvas owner, the pack-signature owner, the discovery single-source, and the canvas editor chassis**, with the demo/witness page as an honest read-only surface. The one substantive finding is an **authority-parity gap** (per-plugin `hostApi` narrowing is enforced FE-only, not on the HTTP RPC route) — low severity (tenant-scoped, no priv-esc), but real.

---

## Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| Advertise `uiPlugins` capability + isolation mechanism | `uiPluginsCapability()` single-source, imported verbatim by discovery (`routes/discovery.ts:46,381`) and by the loader (`frontendPluginPacks.ts:44-45,105-110`) | **RIDES** (discovery owner; advertise/serve non-drift) | none |
| List host-honored plugins (`GET /packs`) | Directory scan of vendored `packs/*` `kind:"frontend-plugin"`, schema-validated, ∩ advertised surfaces/hostApi (`frontendPluginPacks.ts:115-161`) | **PAGE-LEGIT** (read-only projection) | keep as page/JSON |
| Serve sandbox entry bytes (`GET /packs/:name/.../entry`) | Traversal-guarded, size-capped file serve under deny-egress CSP (`routes.ts:85-94`, `frontendPluginPacks.ts:253-286`) | **ADAPTER** (thin host serve; no owner shadowed) | keep; watch drift |
| Mount plugin in sandboxed iframe + drive `ui-plugin/1` | `PluginFrame` opaque-origin `srcdoc` + CSP, forwards to the single-source dispatcher (`PluginFrame.tsx:136-201`, `pluginClient.ts:71-78`) | **RIDES** (mirrors `chat/artifacts/SandboxedArtifactFrame`; forwards, never a 2nd dispatcher) | none |
| `artifact.read` / `artifact.write` over RPC | Bound 1:1 to `host.canvas` optimistic-concurrency (`routes/uiPlugins.ts:71-94` → `getCanvasForTenant`/`updateCanvasForTenant`; conflict → `artifact_conflict`) | **RIDES** (canvas owner, ADR 0153; no persist on stale token) | none |
| Trusted (T1) main-frame lane (`GET /trusted/...entry.mjs` + `TrustedPluginHost`) | Verify-at-every-serve via pinned keyring, gated by `trusted-plugins` kill-switch toggle (`routes.ts:104-123`, `TrustedPluginHost.tsx:38-67`) | **RIDES** (pack-signature owner `host/packSignature`; ADR 0367 P2) | none |
| Trust-tier live labeling (`tier` field) | `verifyPinned` + `verifyDetachedPinned` computed at request time, never a cached claim (`routes.ts:54-75`) | **ADAPTER** (honest projection of the live verify verdict) | keep |
| Demo/canary artifact provisioning (`POST /demo-artifact`) | Idempotent per-tenant canvas, deterministic id `ui-plugin-demo` (`routes.ts:126-139` → `ensureCanvasForTenant`) | **RIDES** (canvas owner; erasure via `registerCanvasErasure`, `canvasSurface.ts:535`) | none |
| `canvas-preview` plugin as canvas-editor PreviewPanel | Discovered by `canvasTypes` match, mounted as `CanvasEditorPage` PreviewPanel via the shared `PluginFrame` (`PackCanvasEditorPage.tsx:46-88`) | **RIDES** (canvas chassis; RFC 0130) | none |
| `host.announce` a11y relay / `host.toast` / `host.navigate` | FE-local live-region relay behind the same declared-hostApi gate; length-capped + rate-limited (`PluginFrame.tsx:114-130`); witness no-ops server-side (`routes/uiPlugins.ts:96-104`) | **ADAPTER** (rides the host page's live region; witness parity) | keep |
| The witness/demo PAGE (`/ui-plugins`, admin-tier nav) | Lists plugins, shows the four falsifiable "legs", mounts the reference viewer; `useFeatureAccess('ui-plugins')`, off by default (`UiPluginsPage.tsx`, `routes.tsx`) | **PAGE-LEGIT** (read-only witness; honest empty/not-enabled states) | keep |

**Counts: RIDES 6 · ADAPTER 3 · PARALLEL 0 · THEATER 0 · PAGE-LEGIT 2.**

---

## Contract scouting (evidence)

- **Declared orchestration:** none. `feature.ts:16-19` states explicitly "No node pack … no agent pack (not an AI surface)." Grep for `startWorkflowRun` / `registerFeatureAgentTool` / `agentProfile` / `WorkflowDefinition` in both packages returns **empty**. There is nothing to ignite — the absence is honest, not theater.
- **Owner instantiation (the RIDES grep):** the RPC handlers call the real canvas owner — `getCanvasForTenant` / `updateCanvasForTenant` / `ensureCanvasForTenant` (`routes/uiPlugins.ts:31,55-94`), not a shadow store. The demo route calls `ensureCanvasForTenant` (`routes.ts:129`). The trust lane calls the real signature owner `verifyPinned` / `verifyDetachedPinned` / `loadPinnedKeyring` (`routes.ts:27,68-69,110-118`).
- **Single dispatcher, not a second one:** `createUiPluginDispatcher` in `host/uiPluginRpc.ts:157` is the one source; both the product route and the conformance alias bind the same `handleRpc` (`routes/uiPlugins.ts:135-147`). The FE `PluginFrame` forwards to `POST …/ui-plugin/rpc` (`pluginClient.ts:71-78`) rather than re-implementing dispatch — the loader is a "thin, isolation-preserving bridge" (`PluginFrame.tsx:22-27`).
- **One loader, not forked:** `canvas-packs` imports `PluginFrame` from `ui-plugins`, explicitly "reused here, never forked (the DESIGN §5 one-loader rule)" (`PackCanvasEditorPage.tsx:16-19`).
- **Honesty loop closes on all four advertised "legs":** isolated = `sandbox="allow-scripts"` without `allow-same-origin` (`PluginFrame.tsx:42`, `uiPluginRpc.ts:83-85`); egress-denied = `default-src 'none'` CSP with no `connect-src`, injected as first `<head>` child (`PluginFrame.tsx:37-51`, `uiPluginRpc.ts:67-75`); allowlist-bound = `makePluginMessageHandler` rejects undeclared methods with `method_not_allowed` before contacting the host (`PluginFrame.tsx:108-113`) and the host re-checks (`uiPluginRpc.ts:164`); no-BYOK = no credential-bearing method in `HOST_UI_PLUGIN_API` (`uiPluginRpc.ts:38`). Every claim has a real read behind it.
- **Card-mechanism test:** N/A — the feature renders no chat cards, no interrupt cards, no A2UI surfaces. It is not a chat surface.

---

## Blockers / findings (each with the honest alternative)

**F1 — Authority-parity gap: per-plugin `hostApi` narrowing is FE-only (low severity, real).**
The FE bridge builds its allow-set from the *calling plugin's* declared `hostApi` (`PluginFrame.tsx:105` — `new Set(plugin.hostApi)`), so a plugin that declared only `artifact.read` cannot postMessage an `artifact.write`. But the HTTP RPC route carries **no plugin identity** and uses the **full host set**: `ALLOWLIST = new Set(HOST_UI_PLUGIN_API)` (`routes/uiPlugins.ts:64-66,108,113-114`), with the code comment conceding "each plugin's manifest `hostApi[]` would further narrow it, but the witness exercises the host-recognized set." Consequence: any authenticated tenant user hitting `POST /v1/host/openwop-app/ui-plugin/rpc` directly can invoke **any** of the five methods regardless of a plugin's declared narrowing — the per-plugin allowlist is a client-side control, not a server boundary. This is the 0458-B1 lesson shape ("the chassis surface you forgot").
*Severity:* low. The methods are tenant-scoped and non-privileged (read/write your own canvas, toast, navigate, announce) — no cross-tenant reach (`routes/uiPlugins.ts:19` and `resolveArtifact` → `getCanvasForTenant(tenantId, …)`), no privilege escalation over what the tenant's canvas API already grants. The *sandbox* remains the real confinement boundary; only the per-plugin narrowing is unenforced server-side.
*Honest alternative:* either (a) document that per-plugin `hostApi` is a sandbox-side control by design and the RPC route's boundary is tenant-scope + the closed host set (make the invariant explicit in `uiPluginRpc.ts`), or (b) thread the calling plugin id + its manifest `hostApi` into the RPC envelope and intersect server-side so route and bridge share one predicate (the skill's authority-parity ideal). Given the sandbox is the load-bearing boundary, (a) is the proportionate fix; (b) only matters if a non-sandboxed caller of the route is ever in the threat model.

**F2 — No operator install/download flow (deferred honestly, not a blocker).** Plugins are **vendored in-tree** (`packs/*`) and discovered by directory scan (`frontendPluginPacks.ts:51,115-161`); signature verification for downloaded packs is explicitly "the registry-fetch path (packs.openwop.dev), not this in-tree loader" (`frontendPluginPacks.ts:22-27`). The page lists what ships; an operator cannot add/remove a plugin from the UI. This is correct scoping for the graduation witness, but it means "download a plugin" is deferred — see Deferred honestly.

---

## Demolition list (with regression pins)

**None.** There is no bespoke intelligence UI, no toothless agent, no orphaned workflow, no parallel owner, and no bespoke approve/submit button duplicating HITL. The page is a legitimate read-only witness with honest not-enabled / empty states (`UiPluginsPage.tsx:47-49,81-82`). Nothing to demolish.

Regression pins already in place that a port must not break: `frontendPluginPacks.test.ts` (host filter + traversal/size caps), `PluginFrame.test.tsx` + `TrustedPluginHost.test.tsx` (allowlist reject, opaque-origin mount, error states), and `routes/__tests__/uiPlugins.test.ts` + the conformance `frontend-plugin-packs` scenario (closed allowlist + version-token concurrency). If F1(b) is ever taken, add a route-level test asserting a method outside the *calling plugin's* declared `hostApi` is rejected server-side.

---

## New-code inventory

**Empty for the chat-first port** — there is no chat-first port to do. The only *optional* work is F1's authority-parity hardening (a plugin-id field on the RPC envelope + a server-side intersect, plus one test) if the direct-HTTP threat model warrants it, and F2's registry-download path if/when RFC 0117 §Signing registry fetch is graduated. Both are extensibility-primitive work, not intelligence-to-chat work.

---

## Phased plan

No phased port is warranted. If the team elects the two optional items, sequence them independently of any chat work:

1. **F1 (optional, low priority):** make the RPC-route authority model explicit — either document the sandbox-is-the-boundary invariant in `uiPluginRpc.ts`, or thread plugin id + manifest `hostApi` through the envelope and intersect server-side. Close with `/code-review`; add the route-level allowlist test.
2. **F2 (deferred, RFC-gated):** the registry-fetch + signature-verify download path is a graduation of the in-tree loader; it rides the existing `packSignature` owner and needs no chat surface. Gate on the RFC 0117 §Signing registry contract being Accepted (per CLAUDE.md's spec-change rule) before host work.

---

## Deferred honestly

- **Operator plugin install/download** — deferred to the registry-fetch path (packs.openwop.dev); today only in-tree vendored packs load (`frontendPluginPacks.ts:22-27,51`). Stated, not faked.
- **Per-plugin `hostApi` narrowing on the HTTP route** — currently FE-only by design (F1); server boundary is tenant-scope + the closed host set. Named, low severity.
- **Rollout state:** both toggles (`ui-plugins`, `trusted-plugins`) ship **off by default** (`feature.ts:34`, `routes.ts:43-51`). Off is a rollout state, not theater — every capability above has a real execution path when enabled.
