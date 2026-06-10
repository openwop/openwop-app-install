# Frontend debt register

A short, honest ledger of known frontend debt with owners/target windows, so
complexity doesn't outrun the guardrails. Update it as items land or new debt is
taken on. Tracks the [enterprise architecture review](../../docs/FRONTEND-ENTERPRISE-ARCHITECTURE-REVIEW.md).

## Closed (enterprise-review remediation)

| Item | Resolution |
|---|---|
| Plaintext BYOK key reachable in `sessionStorage` via network recorder | Request-body redaction + recorder default-off in prod (Batch A) |
| No central browser-storage policy | `src/platform/storage.ts` + [STORAGE.md](STORAGE.md) (Batch A) |
| No CSP | `Content-Security-Policy-Report-Only` in `firebase.json` (Batch A) |
| No shared form/layout primitives | `ui/Field*`, `ui/Panel`/`Toolbar`/`MetadataRow` (Batch B) |
| 61 lint warnings; warn-only lint | Backlog cleared; rules ratcheted to error (Batch C) |
| `exactOptionalPropertyTypes` off | Enabled; 62 errors fixed (Batch D) |
| String-parsed HTTP status | `requestJson` + `ApiError` (Batch E) |
| Large entry bundle, no budget | Overlay + route lazy-loading; entry 190→140 kB gzip; budget gate (Batch F/G) |
| No frontend observability | Pluggable `platform/telemetry` (errors, API timing, web vitals) (Batch H) |
| `useChatSession` monolith | Extracted `chatPersistence` + `chatSessionReducer` (Batch I) |
| Thin tests | 72 → 130 unit tests + keyboard e2e (Batch I/J) |
| Stale README | Rewritten to current manifest (Batch K) |

## Open

| Item | Notes | Priority |
|---|---|---|
| ~~Chat decomposition — phase 2~~ | Done. From `useChatSession` (1739 lines) extracted: persistence (`lib/chatPersistence`), the message reducer (`lib/chatSessionReducer`), interrupt-resolution planning (`lib/interruptResolution`), the chat-turn SSE handler (`hooks/chatTurnSubscription`), and the workflow_run SSE handler (`hooks/workflowRunSubscription`) — hook now **973 lines**. Pinned by a 12-case integration harness: chat-turn (send→subscribe, stream→complete, cancel, fail, suspend→resolve) + workflow_run (dispatch→subscribe, node progress, run.completed, cancel→cancelled), including regressions driving the chat-turn handler with **real RunEventDoc shapes captured from app.openwop.dev** — both a failure stream AND a full happy-path completion (`openwop-free`→MiniMax M2). Verified against real success + failure. | — |
| ~~CSP enforcement~~ | Done — now **enforcing** (`Content-Security-Policy`, not report-only). `script-src` hash-pinned (no `'unsafe-inline'`, self-policed by `check-csp-script-hash.mjs`). Verified by a **runtime gate** (`scripts/check-csp-runtime.mjs`, wired into the e2e CI job): serves the built `dist/` under the enforcing policy and loads all 19 routes in Chromium asserting **0 violations** — this caught a real miss (`fonts.googleapis.com`/`fonts.gstatic.com`) that blind-flipping would have broken. Covers boot + navigation incl. Firebase-SDK init connects. `style-src 'unsafe-inline'` stays (xyflow injects runtime `<style>`). **Residual (low):** the interactive Google sign-in *popup* can't be driven headless — but it's a separate browsing context (own CSP, not the opener's) and its iframe/connect origins (`*.firebaseapp.com`, `identitytoolkit`, `securetoken`) + COOP `same-origin-allow-popups` are in place; hotfix-reversible. Worth a manual sign-in smoke on next deploy. | — |
| ~~Inline-style → utility/semantic classes~~ | Done (pending maintainer visual review). **DESIGN.md §10 overridden by maintainer decision**: static geometry/typography/chrome is no longer allowed inline. **Status: 1,249 → ~112 occurrences (≈91% migrated)** across 11 mechanical waves + 2 semantic-class waves (each tsc+lint gated; full build + 161 unit + 42 e2e green throughout; entry chunk 142→139 kB gzip as styles moved JS→CSS). Two-layer approach: (1) a ~150-class **token-anchored `u-*` utility layer** for static geometry/spacing/type/color; (2) **named semantic component classes** in `global.css` (`.wfprog-*`, `.notifpanel-*`, `.agentdetail-*`, …) for bespoke chrome (color-mix washes, box-shadows, absolute overlays, header type) — declarations relocated **verbatim** (visual no-op), dynamic halves split back to inline. **Remaining ~112 are all legitimate leave-inline:** ~101 genuinely-dynamic (status colors, measured px, progress widths, ring/size-driven avatars) per §10, plus ~11 single `style` props on icon/Field/layout components that don't accept `className` (migrating those needs a component-API change, out of scope). The enforced no-literal-color bar stays at 0 (several `color:white` literals were moved out of TSX into CSS as `var(--color-on-scrim)` — a net improvement). **Visual review owed:** maintainer should eyeball a preview deploy (pixel-diff isn't useful — rem→token normalization shifts ≤0.5px). | — |
| ~~Large files~~ | Done: `Inspector.tsx` (649→172), `BuilderShell.tsx` (641→355), `OrgsPage.tsx` (546→109), `BYOKWizard.tsx` (527→134) split into container + sibling view/helper modules (pure extraction, e2e-identical). | — |
| ~~Telemetry sink~~ | Done: opt-in `beaconReporter` (VITE_TELEMETRY_ENDPOINT) ships in `platform/telemetry`; `setReporter` still allows a custom vendor. | — |
| ~~Broader form migration~~ | Done. Every hand-rolled `<label htmlFor>` field migrated to the `Field` primitives, each verified by a render test (controls resolve by accessible label) and/or axe e2e: MemoryInspectorPage, PromptLibraryPage, RunsIndexPage, WorkflowInspector, node Inspector, **EdgeInspector** (Label/Path/Operator/Value), **KeysPage** (label + API key; warning/console kept as siblings), **KeyEntry** (render-prop `<Field>` for the input+show-button composite), **ModelGrid**, **defaultCards**, and the three HITL interrupt forms (Clarification/Approval/Refinement). `Field` gained `forwardRef` (autofocus refs) + a `containerStyle` fix. **Intentional exceptions:** NotificationPreferencesPanel uses a toggle-row label helper (checkbox rows — not Field's domain); WorkflowsDashboard's sort `<select>` sits in an inline-label flex toolbar (`.workflows-sort`) where Field's stacked label would restack the layout. | — |

## Live verification

`npm run smoke:live` (`scripts/smoke-live.mjs`) checks the client-layer contract
against real production infra (default `app.openwop.dev`): readiness,
capabilities shape (stream modes + aiProviders), BYOK endpoint + `credentialRefs[]`,
the anon chat-dispatch auth gate + error envelope, and anon-session issuance.
NOT in CI (live network).

A full streamed-completion was captured once with a signed-in Firebase token via
the **`openwop-free` (MiniMax) "Try it free"** managed provider (`provider:
'openwop-free', model: 'auto', credentialRef: 'managed:openwop-free'`) — the
real RunEventDoc shapes from that run are now baked into the integration-harness
regressions (success + failure). `openai`/`anthropic`/`google` managed targets
are NOT provisioned on the deploy (they return `managed_unknown`); the free tier
runs on `openwop-free` only.

## Quality metrics to watch

- Entry-chunk gzip (budget 160 kB, `scripts/check-bundle-budget.mjs`).
- Lint warning count (must stay 0; CI `--max-warnings=0`).
- Unit test count / e2e pass.
