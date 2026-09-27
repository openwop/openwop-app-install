# 0300 — Front-end plugin loader + reference pack (RFC 0117 / RFC 0119 graduation)

Status: implemented

## Context

RFC 0117 (front-end plugin packs) + RFC 0119 (isolation mechanism-neutrality) are
**Active** on the OpenWOP wire. The host already merged the *server-side* half:
`host/uiPluginRpc.ts` (the `ui-plugin/1` dispatcher, capability constants, deny-egress
CSP, sandbox tokens), the `POST /v1/host/openwop-app/ui-plugin/rpc` witness seam
(`routes/uiPlugins.ts`), and the discovery advert (`uiPlugins` from
`uiPluginsCapability()`, gated on `presentationEnabled('uiPlugins')`) — PRs #973/#979.
The pinned conformance suite ships `frontend-plugin-packs.test.ts`, and RFC 0119's
`capabilities.uiPlugins.isolation` is already the categorical enum.

The steward (openwop-1) verified the **wire-observable** legs on the deployed host by
hand — advert live, `method_not_allowed` on an undeclared method, `artifact_conflict`
(no persist, no secret) on a stale write. That covers 3 of the 4 protocol-tier
`frontend-plugin-*` invariants' wire legs + the 0119 advert.

**The remaining graduation bar is browser-runtime, not wire-observable:**
`frontend-plugin-isolation` (a real plugin runs in an opaque origin, no
`allow-same-origin`) and `frontend-plugin-egress` (a real plugin's outbound `fetch` is
CSP-blocked) are *behavioral* MUSTs the conformance suite cannot observe — they need a
real **downloaded-plugin-runs-isolated** boundary a steward observes in a browser.

There was **no front-end loader**: `frontend/react/src/plugins/uiPluginRpc.ts` is the
pure protocol layer (no DOM/postMessage), no `kind:"frontend-plugin"` pack shipped, and
nothing mounted a plugin. That gap is this ADR.

## Decision

Ship the host's front-end-plugin **loader boundary** + a **signed reference pack**, as a
self-contained `ui-plugins` feature package (ADR 0001), riding the already-Accepted
RFC 0117/0119 (no new RFC — host work only).

1. **Reference pack (B1)** — `packs/community.openwop.artifact-viewer/`, a
   `kind:"frontend-plugin"` pack: one `artifact-viewer` plugin, `hostApi:["artifact.read"]`,
   `entry.html` (self-contained, inline-only). Ed25519-signed (`pack.json.sig` +
   `pack.sig.json`, key `community-openwop-team-demo-1`). Validated against the vendored
   `schemas/frontend-plugin-manifest.schema.json`.

2. **Host serve leg (B1)** — `features/ui-plugins/frontendPluginPacks.ts` scans the
   vendored `packs/` for `kind:"frontend-plugin"`, schema-validates, and projects each
   plugin to the host-honored shape (surface/hostApi ∩ `uiPluginsCapability()`). Routes:
   `GET …/ui-plugin/packs`, `GET …/ui-plugin/packs/:name/plugins/:pluginId/entry`
   (size-capped, traversal-safe, deny-egress CSP header), `POST …/ui-plugin/demo-artifact`
   (per-tenant demo canvas for the viewer to `artifact.read`).

3. **Loader boundary (B2)** — `features/ui-plugins/PluginFrame.tsx` mounts the downloaded
   entry via `srcDoc` with `sandbox="allow-scripts"` (NO `allow-same-origin` → opaque
   origin) and the injected deny-egress CSP, bridging `postMessage ⇄ POST …/ui-plugin/rpc`.
   It enforces the plugin's declared `hostApi` as a client-side allowlist BEFORE forwarding
   — an undeclared method is answered `method_not_allowed`, never sent to the host. The
   `/ui-plugins` page (toggle `ui-plugins`, off by default) is the reachable witness surface.

4. **Isolation non-drift (B3, RFC 0119)** — the loader + the `/ui-plugin/packs` advert both
   read `hostIsolation()` = `uiPluginsCapability().isolation`. A test pins
   `served === advertised === 'cross-origin-iframe'`, so advertise and apply cannot drift.

### Why the loader reuses the host dispatcher, not a second one

`PluginFrame` is a thin isolation-preserving bridge: it forwards allowed requests to the
canonical `POST …/ui-plugin/rpc` seam (the single-source `dispatcherForTenant` that
enforces the host allowlist + tenant isolation + canvas concurrency). It never dispatches
host logic itself — no second dispatcher to drift ("No parallel architecture").

### Trust / signing posture

Mirrors `workflowChainPackLoader` R7: an in-tree vendored pack is trusted source (no
load-time signature check); the detached Ed25519 signature is the **registry-publish**
artifact (packs.openwop.dev verifies on fetch). The manifest schema is closed
(`additionalProperties:false`), so integrity is over `pack.json`; full-tarball signing is
the registry path. This is honest about what the signature covers.

## Alternatives weighed

- **Load the entry via iframe `src` from the backend origin** (real cross-origin) instead
  of `srcDoc`. Rejected: `sandbox` without `allow-same-origin` already yields an opaque
  origin regardless of `src`, and `srcDoc` + injected CSP is the established
  `SandboxedArtifactFrame` precedent that also works identically under jsdom tests. The
  backend still sets the CSP header on the entry endpoint as defense-in-depth.
- **A bespoke plugin dispatcher in the FE.** Rejected — would shadow the host seam.
- **Skip the reachable page; witness via vitest only.** Rejected — the isolation/egress
  legs are protocol-tier behavioral MUSTs needing a real steward browser observation, not
  a jsdom assertion.

## The four falsifiable legs (steward browser witness on `/ui-plugins`)

| Invariant | Witness (self-shown by the plugin, no dev tools) |
|---|---|
| `frontend-plugin-isolation` | "opaque origin ✓" (plugin reads `window.origin === 'null'`); iframe `sandbox="allow-scripts"`, no `allow-same-origin` |
| `frontend-plugin-egress` | Egress badge "BLOCKED ✓" — the plugin's on-load `fetch('https://example.com/exfil')` is CSP-blocked |
| `frontend-plugin-rpc-allowlist` | Allowlist badge "artifact.write → method_not_allowed ✓" — undeclared method rejected by the loader |
| `frontend-plugin-no-byok` | No credential-bearing method in the host allowlist; plugin holds no secrets |

## Implementation

| Phase | What | Tests |
|---|---|---|
| B1 | Reference `kind:"frontend-plugin"` pack + Ed25519 sig + vendored schema + host serve leg | `frontendPluginPacks.test.ts` (5) |
| B2 | `PluginFrame` loader + `/ui-plugins` page + `ui-plugins` feature (be+fe) | `PluginFrame.test.tsx` (7) |
| B3 | Isolation advertise/serve non-drift | `frontendPluginPacks.test.ts` §non-drift |
| B4 | Deploy; `uiPlugins` advertised live; `/ui-plugins` reachable | steward browser witness |

## Open questions / follow-ons

- **Load-time signature verification** — the registry-fetch path (packs.openwop.dev) is the
  verify point; an in-tree verify is deferred (R7 posture). Recorded, not built.
- **`route` / `settings-panel` surfaces** — the host advertises them; only `artifact-viewer`
  is exercised here. Adding a loader mount for the other two surfaces is additive.
- **`connectSrc` exceptions** — the schema allows a plugin to request `connect-src`
  entries; the reference pack requests none (pure deny-egress). Honoring them is a
  front-end-review-gated follow-on.

## Cross-refs

- RFC 0117 (front-end plugin packs), RFC 0119 (isolation mechanism-neutrality)
- `host/uiPluginRpc.ts` (the ui-plugin/1 single source), `routes/uiPlugins.ts` (the RPC seam)
- ADR 0128 (`SandboxedArtifactFrame` — the opaque-origin sandbox precedent)
- `SECURITY/invariants.yaml` `frontend-plugin-{isolation,egress,rpc-allowlist,no-byok}`
