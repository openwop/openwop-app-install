# ADR 0840 — RFC 0238: serve the front-end plugin boundary at its normative path

Status: **Accepted** (2026-10-06; architect-reviewed, 1 Critical + 4 High folded in)

Implements OpenWOP **RFC 0238** (`Active`, suite 2.45.23) for this host. openwop-app
is the only matrix host advertising `uiPlugins`, so the RFC's `Accepted` rests on this
host recording the four `openwop.requirement.0238.ui-plugin.*` ids `executed-pass` on a
certified production bundle. Product-owner go-ahead: 2026-10-06.

Builds on ADR 0300 (the plugin loader), ADR 0367 (the trusted main-frame lane) and
ADR 0493 (the isolation self-test).

## Context

Four critical SECURITY invariants guard front-end plugins: isolation, deny-egress, the
closed host-RPC allowlist and no BYOK material across the boundary. Their only witness
was the v1 seam `POST /v1/host/sample/ui-plugin/rpc`, and v1 is retired. RFC 0238 mints
an HTTP observation path: a frame document whose isolation and egress policy travel in
response headers, and a per-plugin dispatch operation.

**Measured on `3d225907e`**, this host enforces the boundary, but mostly where HTTP
cannot see it:

1. **The manifest half of the allowlist runs only in the browser.** The server RPC
   (`routes/uiPlugins.ts`, a literal `/v1/host/openwop-app/ui-plugin/rpc`) uses the host's
   full `HOST_UI_PLUGIN_API`, because the request does not name the calling plugin. The
   plugin's own `hostApi` is checked only in `PluginFrame.makePluginMessageHandler`.
2. **Isolation and egress live in the parent page.** The iframe has `sandbox="allow-scripts"`,
   and its `srcdoc` carries a `<meta>` deny-egress CSP injected by `withPluginCsp`.
3. **The header defense-in-depth is already broken on app.openwop.dev.** Firebase
   Hosting applies the app's own CSP (`default-src 'self'; connect-src 'self' https://*.run.app …`)
   to every non-static path, API rewrites included. The one plugin override in
   `firebase.json` targets `/api/v1/host/openwop-app/ui-plugin/packs/**/entry`, a path
   the SPA no longer calls (it fetches `/api/host/openwop-app/…`). So entry responses on
   app.openwop.dev carry the APP CSP today. Nothing is exploitable now, because the
   `srcdoc` meta CSP and the sandbox attribute are what actually hold. Under RFC 0238 the
   header becomes the boundary, so this cannot stay.
4. **The v2 discovery root carries no `uiPlugins` record** (verified live by the
   corpus steward), so the scenario would record every leg `inapplicable`.
5. **Packs load from the vendored `packs/` directory with no signature check.** The
   only verified lane is ADR 0367's trusted main-frame lane, whose keyring is not scoped
   per pack and whose trust grants main-frame execution.

## Decision

### D1 — Two v2 operations, one dispatcher

Mount, beside the protocol surface:

- `GET /host/ui-plugins/:packName/:pluginId/frame` (`getUiPluginFrame`)
- `POST /host/ui-plugins/:packName/:pluginId/rpc` (`dispatchUiPluginRequest`)

Both resolve the plugin through `listFrontendPluginPacks()` (plus D5's operator-installed
packs). An unknown pack or plugin answers `404 not_found`, the same as absence.

**The RPC's allowlist is the served plugin's `hostApi`**, which `listFrontendPluginPacks`
already computes as the manifest's `hostApi` ∩ the host's set. That is the change that
moves the manifest half server-side. Everything else is the existing
`createUiPluginDispatcher` and the existing tenant-scoped, type-pinned, toggle-gated
canvas handlers (`dispatcherForTenant`), with the allowlist injected rather than fixed.

- **Validation:** the body's `message` is validated against the vendored
  `schemas/v2/ui-plugin-message.schema.json`. A body that does not validate,
  including a `method` outside the closed `ui-plugin/1` enum such as `host.exec`, answers
  `400 validation_error`. A validated request always answers `200` with the
  `ui-plugin/1` envelope; a refusal is `ok:false` inside it.
  The wrapper itself (no `message`) is also `400 validation_error`, not the vendor
  route's `invalid_request` (architect #5).
- **Order:** the plugin is resolved first, so an unknown plugin is `404` whatever the
  body. The witness relies on that `404` to read "fixture not installed".
- **Authority:** `requireProtocolScope(req, 'artifacts:read')` on the route
  (`host/protocolAuthorization.ts`, so ADR 0745's call-site scan covers it), then
  per-method authority as the caller,
  exactly as today (`canvasReadAllowed`, and `workspace:write` for `artifact.write`).
  The route grants nothing the caller's credential does not hold.
- **No BYOK:** unchanged. No handler resolves secrets, and no error message carries one.

### D2 — The frame is the document the plugin runs in

The frame response is the plugin's entry HTML, served with:

```
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:[; connect-src <declared connectSrc>]
X-Content-Type-Options: nosniff
Cache-Control: no-store
```

- `allow-same-origin` never appears. The header's `sandbox` gives the document an opaque
  origin however it is embedded.
- `connect-src` appears only for a plugin that declares `connectSrc`, with exactly those
  sources. No installed plugin declares one today.
- One function builds this header (`pluginFrameCsp(plugin)` in `host/uiPluginRpc.ts`),
  replacing `pluginIframeCsp()`. Both the route and the tests read it.
- Scope: `requireProtocolScope(req, 'manifest:read')`. The frame carries no tenant data
  and no credential.
- **The frame must reach this handler from a browser (architect #1, Critical).**
  `features/publishing/routes.ts` serves the SPA shell on every v2 root, `/host/*`
  included, to any request `isProtocolClient` rejects: `Accept: text/html` and no
  `OpenWOP-Version`. That is exactly what an iframe `src` load sends, and only
  `/host/openwop-app` is excluded (`isVendorPath`). Unfixed, the SPA would mount its own
  shell inside the plugin frame while the suite (which sends the header) certified the
  route. The shell handler, the single owner of that decision, therefore excludes every
  operation whose response IS a document, read from the vendored OpenAPI (operations
  producing `text/html`, today `getUiPluginFrame`), never a path literal. Witness: a
  headerless `GET …/frame` with `Accept: text/html` returns the plugin's HTML and CSP.

  > **Corrected during implementation (same day): the fix belongs in the negotiator,
  > not the shell handler.** Tracing it showed the shell handler only sees the request
  > because the negotiator (`middleware/protocolVersion.ts`) classified it a SHARED
  > NAME (ADR 0646) and therefore left it unrewritten; a protocol client is rewritten
  > onto `/v1/…`, where the operation is registered. Excluding the path in the shell
  > handler would only turn the shell into a 404. A document operation has no SPA page
  > behind it, so it is never a shared name: the negotiator treats it as a protocol
  > request whatever the `Accept` header says. And the OpenAPI is not vendored here,
  > so the set is named by `operationId` (`DOCUMENT_OPERATION_IDS = ['getUiPluginFrame']`),
  > resolved to path templates through the vendored `path-manifest.json`.
  > *Correction, also same day:* the first draft of this note promised a test checking
  > the ids against the conformance package's OpenAPI. The package ships no OpenAPI
  > (`node_modules/@openwop/openwop-conformance` has none), so that check has nothing
  > to read. The binding is the `operationId` lookup, and the guarantee is the HTTP
  > witness that a headerless `text/html` load of the frame returns the plugin
  > (`test/adr0840-ui-plugin-observation-path.test.ts`), which binds once the corpus
  > pin carries RFC 0238 and is pinned to its pre-pin reason until then.

**The SPA mounts plugins only from this URL** (RFC 0238 §B.5).
`PluginFrame` sets `src` to the frame URL the host returns in the `/packs` listing
(`framePath`, beside `entryPath` and `trustedEntryPath`: the SPA never builds a plugin
path itself, architect #6), served same-site through `/api`, and
keeps `sandbox="allow-scripts"` on the element as a second, independent boundary.
`withPluginCsp`, the `srcdoc` path and the entry route's role as the mount source are
removed. The entry route stays only as long as something else reads it (D7).

`IsolationSelfTest` (ADR 0493) loads its host-authored probe page through the same
frame mechanism, served by the frame route as a built-in probe, instead of a `srcdoc`
with the client's `PLUGIN_CSP`. A self-test of a mechanism plugins no longer use would
witness nothing (architect #7).

> **Found while moving it (2026-10-06): the probe's egress leg was vacuous.** It
> fetched `https://example.invalid/`, and `.invalid` never resolves, so the fetch
> rejected with or without any policy and the leg reported "blocked" either way. The
> probe (now `host/uiPluginIsolationProbe.ts`) counts egress as blocked only when the
> browser fires `securitypolicyviolation`, which only an enforced policy does, and
> fetches a resolvable host so a missing policy shows up as "fetch resolved".

### D3 — Firebase must not replace the frame's CSP

`firebase.json` gains a header rule for `/api/host/ui-plugins/**` and `/host/ui-plugins/**`
carrying the exact D2 policy (no `connect-src`). The stale `/api/v1/…/entry` rule is
replaced by the live `/api/host/openwop-app/ui-plugin/packs/**/entry` path.

A Firebase header rule cannot vary per plugin, so the rule is the no-`connect-src`
policy. **A guard test fails if any installed plugin declares `connectSrc`.** Allowing
one needs a design (for example, serving that plugin's frame from the Cloud Run origin)
and a correction here, never a silently wrong header.

**Measured before the SPA switches, not assumed (architect #2).** Two Firebase rules
match the frame path (the global app CSP and this one). Whether the specific rule wins,
and whether Firebase replaces the origin's header or adds a second, decides whether the
browser enforces the plugin policy (two headers intersect, which is safe; a replacement
is not). P3 measures it on a Firebase preview channel, reading the raw header lines.

> **Measured 2026-10-06 on production (`447b9a9bf`): Firebase REPLACES the origin's
> header.** The live entry response
> (`/api/host/openwop-app/ui-plugin/packs/…/entry`, no matching plugin rule) carries
> exactly one `Content-Security-Policy` line, the app's
> (`default-src 'self'; connect-src 'self' https://*.run.app …`), and none of the
> origin's deny-egress policy. So the plugin policy on app.openwop.dev now depends
> entirely on the plugin rule beating the global rule. If it lost, a frame mounted by
> `src` would run under the app policy, which is WEAKER than today's `srcdoc` meta
> policy: a regression, not a neutral change. **Gate:** precedence is measured on a
> Firebase preview channel (`firebase hosting:channel:deploy`, which proxies to the
> same Cloud Run rewrites and applies the same header rules) BEFORE this merges, by
> reading the raw `Content-Security-Policy` lines on a `/api/host/ui-plugins/…/frame`
> path. After every production deploy, `verify-deploy.sh` reads them again
> (`plugin csp`).
>
> **Measured on preview channel `ce-0840` (2026-10-06): the plugin rule wins.**
> `/api/host/ui-plugins/…/frame` and `/host/ui-plugins/…/frame` each carried exactly
> one CSP line, the frame policy (`sandbox allow-scripts; default-src 'none'; …`); the
> live `…/packs/**/entry` path now carries the deny-egress policy; a control path
> (`/api/runs/…`) kept the app policy. So a later, more specific header rule replaces
> the global one for the same key. A `404` carried no CSP at all, so the probe line in
> `verify-deploy.sh` reads a path that must answer `200`.

The build's hosting check (`check-hosting-wire-rewrites`) gains an assertion that both
frame sources carry a CSP whose `sandbox` admits `allow-scripts` and not
`allow-same-origin`. Post-deploy, `verify-deploy.sh` reads the frame's CSP through
app.openwop.dev, because that header is the only thing that shows Firebase did not
replace it.

### D4 — The v2 `uiPlugins` record

`buildV2Advertisement` projects, under the same `presentationEnabled('uiPlugins')` gate
as v1:

```
uiPlugins: { status: 'experimental', since: '2.0', until: '2.1', witness: 'witnessable-gated',
             isolation, surfaces, hostApi, maxEntryBytes, served: true }
```

The facets come from `uiPluginsCapability()`, the existing single source. `served: true`
is advertised only when D1's routes are registered (the same module exports both), so
advertising and serving cannot drift. This needs the vendored v2 schemas at suite
**2.45.23** (the closed root rejects `served` before it).

### D5 — The fixture pack is operator-installed under pack-scoped trust

The `ui-plugin-pack-narrow` fixture is vendored into `conformance-fixtures/frontend-plugin-packs/`
by `scripts/sync-fixtures.sh`, but **never loaded by default**. It loads only when the
operator sets `OPENWOP_UI_PLUGIN_OPERATOR_TRUST`, a JSON list of
`{ pack, publicKey, signature }`:

- `pack` names exactly one pack. The entry trusts that pack and nothing else.
- `signature` is a detached Ed25519 signature, made by the operator, over a canonical
  statement `{"pack","version","manifestSha256","entrySha256"}` (keys sorted, no
  whitespace). Signing `pack.json ‖ entry` was the first draft and was rejected: with no
  framing, bytes can move between the two and still verify (architect #4). Verification
  uses the existing Ed25519 primitive (`verifyDetachedPinned`), so there is one verify
  implementation. The frame route re-checks `entrySha256` on the bytes it serves. A
  mismatch or a missing file refuses the pack with a WARN. A refused pack is simply absent, so it fails
  closed and the scenario records `inapplicable`.
- It is a separate trust root from ADR 0367's keyring on purpose. That keyring grants
  main-frame execution to any pack its key signed. This one grants sandboxed install
  of one named pack.

No conformance signing key is distributed. The operator generates one, signs, and puts
the public half and the signature in the env var (or a secret). The private half never
reaches the service.

### D6 — The fixture artifact

When D5 loads the fixture, the host ensures (idempotently, on boot) an app-builder canvas
`ui-plugin-narrow-artifact` in the tenant named by the trust entry's REQUIRED `tenant`. An implicit default
(the first `OPENWOP_API_KEYS` tenant) was rejected as hidden coupling (architect #8).
Its state contains the literal, unresolved text `{{secrets.openwop-conformance-canary-secret}}`.

The conformance credential reads it through the normal predicate. A canvas with no
`ownerSubject` is readable by any caller in its tenant (`canvasReadAllowed`,
`host/canvasSurface.ts`), and `ensureCanvasForTenant` creates exactly that. The
app-builder feature must also resolve ON for that tenant (`resolveCanvasTypeAccess`);
P3 measures that on production. Nothing is
special-cased in the handlers.

> **CORRECTED 2026-10-07 — "nothing is special-cased" did not survive production, and
> the P3 measurement named above was never run before the first cut.** The certified
> bundle for `d38aa0277` recorded `openwop.requirement.0238.ui-plugin.rpc-allowlist`
> `executed-fail`: the control `artifact.read` returned `artifact_not_found`. Cause,
> measured on production: `OPENWOP_BILLING_PLAN_FEATURES` puts app-builder on a paid
> tier and `conformance-prod` resolves on `free`. Its `OPENWOP_BILLING_EXEMPT_TENANTS`
> entry exempts limits and credits only, by ADR 0821's deliberate rule, so
> `resolveCanvasTypeAccess` refused (`blockedBy:'plan'`). The host's own demo canvas
> was refused the same way, which ruled out the fixture path. The check that misled
> me: the toggle-assignments listing reported app-builder `enabled:true`, because
> that listing does not apply the plan gate. The local proof passed because it ran
> with no plan narrowed.
>
> **Decision (product owner, 2026-10-07):** a fixture-only carve-out. The rpc
> route passes `ui-plugin-narrow-artifact` as the one plan-exempt artifact id, and
> only when the trusted fixture pack is called in its trusted tenant.
> `resolveArtifact` skips the canvas-type plan gate for that id alone. Every other
> canvas in that tenant stays paywalled, so ADR 0821's rule is unchanged.
> `test/adr0840-fixture-plan-gate.test.ts` pins both halves under a narrowed plan,
> and was sabotage-checked red. Rejected: making billing-exempt tenants feature-exempt,
> which reverses ADR 0821; and a per-tenant plan setting, a general mechanism that
> would give `conformance-prod` every paid feature.
>
> **Second defect found in the same trace:** canvas ids are global keys, and
> `ensureCanvasForTenant` treated "not in my tenant" as absent. Its `put` would move
> another tenant's row into the caller. The fixed demo id `ui-plugin-demo` already did
> that for every second tenant. `ensureCanvasForTenant` now refuses an id another
> tenant owns (`409 conflict`, nothing written, no phantom index marker) and inserts
> with `putIfAbsent`. The demo artifact's id is now derived from its tenant.

### D7 — The old host-global RPC path goes

`POST /v1/host/openwop-app/ui-plugin/rpc` cannot know which plugin is calling, so it can
only ever enforce the host half. Once `PluginFrame` calls the per-plugin path, the vendor
route and its v1 conformance alias (`/v1/host/sample/ui-plugin/rpc`, v1 retired by ADR
0812) are deleted **in the release after**, not the same one (architect #3). The backend
deploys first, so deleting them together would break every SPA still running the old
bundle for the length of the window, and cached tabs for longer. Keeping it one release
is no weaker than today. The `/packs` listing and the trusted lane are unchanged.

> **DONE 2026-10-07 (the release after).** The per-plugin frame and rpc shipped in
> #4509, and three production deploys of that frontend followed the same day
> (`d38aa0277`, `e33f3a19c`, `90e7f78ee`). Before deleting, I measured that no frontend
> code, pack or script on `main` still called either path. Deleted:
> `POST /host/openwop-app/ui-plugin/rpc`, the test-seam alias `/host/sample/ui-plugin/rpc`,
> `registerUiPluginRoutes` and its `registerAllRoutes` entry, and the test-seam
> `conformance-canary` auto-create, whose only driver was the alias.
> The dispatcher (`dispatcherForTenant` / `dispatchForPlugin`) and all its unit
> tests are unchanged, including stale-write `artifact_conflict` with no persist.
> `test/ui-plugin-seam-route.test.ts` now witnesses the deletion:
> - both old paths 404, while the RFC 0238 `rpcPath` on the same app answers the
>   same body;
> - sabotage-checked: restoring the old routes turns it red.
>
> `test/headless-profile.test.ts` takes the isolation probe as its presentation
> mount signal, because the per-plugin rpc 404s an unknown plugin even when mounted.
> Consequence: the corpus's RFC 0117 `frontend-plugin-packs` host-RPC rows, which
> post to `/v1/host/sample/ui-plugin/rpc`, now soft-skip as `blocked` under the test
> seam too. They already could not run against production (v1 retired), and the
> RFC 0238 scenario witnesses the same allowlist on the v2 path.

## Architect review (2026-10-06) — folded in

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | Critical | The publishing SPA-shell handler answers headerless `text/html` requests on `/host/*`, so an iframe `src` would mount the shell, not the plugin; the suite cannot see it | D2: the shell owner excludes document operations derived from OpenAPI; headerless HTTP witness |
| 2 | High | Firebase rule precedence and replace-vs-append unmeasured | D3: measured on a preview channel before the SPA switches |
| 3 | High | Deleting the vendor RPC in the same release breaks old SPAs in the deploy window | D7: delete one release later |
| 4 | High | `pack.json ‖ entry` signature has no framing | D5: sign a canonical hash statement; one verify primitive; re-hash at serve |
| 5 | High | Wrapper errors were `invalid_request`; v2 needs `validation_error`. Corpus: `host.announce` missing from the message enum | D1; gap reported upstream |
| 6 | Medium | The SPA would construct the frame path | D2: `framePath` in `/packs` |
| 7 | Medium | `IsolationSelfTest` would probe the retired `srcdoc` mechanism | D2: probe through the frame route |
| 8 | Medium | Fixture tenant defaulted implicitly | D6: `tenant` required |
| 9 | Medium | Scope gate unnamed | D1/D2: `requireProtocolScope` |

## Alternatives

- **Keep the vendor RPC and add the plugin id to its body.** It would enforce the
  manifest half, but the suite cannot find a vendor path. RFC 0238 §Alternatives 5
  rejects it for that reason.
- **Serve the frame from the Cloud Run origin** to avoid Firebase entirely. An iframe
  navigation cannot carry a bearer header, and the session cookie is first-party to
  app.openwop.dev, so the frame would have to be unauthenticated. `manifest:read` is a
  low bar, but a second unauthenticated document origin is a larger change than one
  Firebase rule. It remains the escape hatch if a plugin ever needs `connectSrc` (D3).
- **Reuse ADR 0367's keyring for the fixture.** Rejected: it is not pack-scoped, and its
  trust means main-frame execution. Conformance must never be the reason a key can run
  code in the main frame.
- **Vendor the fixture into `packs/` like the reference plugins.** Rejected by
  RFC 0238 §D.1: the trust MUST be an explicit operator act and off by default.

## Consequences

- Real plugin traffic gains the server-side manifest check, not just the suite.
- The frame on app.openwop.dev finally carries a plugin CSP header. Today's entry
  responses carry the app's.
- A plugin can no longer be mounted with a weaker policy than the one the suite reads,
  because the SPA has no other way to mount it.
- Operators who want the certification set two things: the trust env var and (by
  default) nothing else. Everyone else sees no fixture and no change.

## Implementation plan

| Phase | Work | Witness |
|---|---|---|
| **P0** | Vendored schemas + suite at 2.45.23 (with the corpus pin bump). | the v2 root validates with `served` |
| **P1** | D1 routes + allowlist from the plugin + schema validation; D4 record. | host tests: declared method `ok:true`; undeclared `method_not_allowed` unexecuted; `host.exec` 400; unknown plugin 404; `served` absent when the routes are not registered |
| **P2** | D2 frame + `pluginFrameCsp`; SPA mounts by `src`; D7 deletes the vendor RPC. | CSP parsed with the suite's own `parseCsp`/`judge*` rules; frontend test that no `srcdoc` path remains |
| **P3** | D3 Firebase rules + build check; D5 operator trust + fixture; D6 artifact. | a sabotaged signature or a second pack under one entry refuses the load |
| **P4** | `OPENWOP_TARGET_MAJOR=2` local run of `v2-ui-plugin-boundary`: four legs `executed-pass`. Gate, merge, deploy (user-confirmed), set the trust env, certified cut. | the bundle records the four ids `executed-pass` |

## Open questions

- [x] Does `canvasReadAllowed` admit the conformance key for a host-created canvas?
      Yes: an owner-less canvas is tenant-readable (D6).
- [x] `IsolationSelfTest`: re-pointed at the frame mechanism (D2).
- [x] Cookie sessions and `manifest:read`: `requireProtocolScope` passes a caller in
      their own personal workspace, and is a no-op while RFC 0049 enforcement is off.
- [ ] Is the app-builder feature ON for the conformance tenant on production? (P3)
- [ ] Corpus gap, reported to the steward: the v2 `ui-plugin-message` `method` enum
      omits `host.announce`, which the v2 `uiPlugins.hostApi` facet admits. Here
      `host.announce` stays frame-local in the SPA and is never forwarded, so D1's
      validation does not refuse real traffic.
