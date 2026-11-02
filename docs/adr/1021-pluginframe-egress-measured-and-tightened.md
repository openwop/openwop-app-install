# ADR 1021 — plugin frame egress, measured and tightened

Status: Accepted (P1 implemented on `fix/pluginframe-egress`). Accepted after an
adversarial /architect pass on 2026-10-31. It had 3 Blockers, 4 Majors and 5
Minors; their resolutions are folded in below and listed under
"Architect pass".

This is follow-up `IA67-6` of ADR 1017 (M6). Feature `ui-plugins` (ADR 0300,
ADR 0840, RFC 0117 / RFC 0119 / RFC 0238). Gap ids use the prefix `PFE`.

## Context

ADR 1017 M1 measured that an interactive-artifact frame running scripts reaches
the network despite a `default-src 'none'` CSP. M6 noted, from a code read, that
the ui-plugins `PluginFrame` has the same posture: `sandbox="allow-scripts"` and
a deny-egress header CSP. It also noted that `/ui-plugins` says "Egress-denied —
default-src 'none', no network requests" in four locales. Plugins need scripts,
so ADR 1017's cure (static and `inert` until the viewer consents) does not fit.

### M1 — what the plugin frame can reach (measured)

`frontend/react/e2e/plugin-frame-egress.spec.ts` serves a frame document over HTTP
with the production header. That header is `pluginFrameCsp()`, imported from
`backend/typescript/src/host/uiPluginRpc.ts`. The spec mounts the document by
`src` under the production attribute, as `PluginFrame.tsx` does: `PLUGIN_SANDBOX`
(now in the import-free `ui-plugins/pluginSandbox.ts`) with
`referrerpolicy="no-referrer"`. The sinks are a local HTTP server, counting both
requests and TCP connections, and a UDP socket for WebRTC STUN. The browser was
Chromium 148.0.7778.96 under Playwright 1.60.

Served frame policy before this ADR:
`sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:`

| Channel | Frame posture alone | Control (shows the sink can see it) |
|---|---|---|
| fetch, XHR, sendBeacon, WebSocket, EventSource | blocked | leaks with no CSP header |
| `<img>`, CSS `background`, nested `<iframe>`, blob `Worker`, `rel=prefetch` | blocked | leaks with no CSP header |
| form submit | blocked | leaks with `allow-forms` on the attribute and no header |
| `window.open` | blocked | leaks with `allow-popups` on the attribute and no header |
| `top.location = …` | blocked | leaks with `allow-top-navigation` on the attribute and no header |
| **self-navigation** `location.href = sink?d=…` | **leaks** (request received) | — |
| **meta refresh** | **leaks** (request received) | — |
| **WebRTC** (`RTCPeerConnection` with a STUN server) | **leaks** (3 UDP packets) | — |
| WebRTC with CSP `webrtc 'block'` added | **still leaks** (3 UDP packets) | — |
| `rel=preconnect` | no connection | **not observable**: Chromium opened no socket to the loopback sink, even from an unsandboxed page, so this zero means nothing |

The architect pass then asked what the *embedding page* changes. So the spec
mounts the frame again, with the parent page under the app's own policy as
Firebase Hosting serves it. The spec reads that policy from `firebase.json` and
does not copy it. Its `frame-src` is `'self' https://apis.google.com
https://accounts.google.com https://*.firebaseapp.com`.

| Channel, parent under the production app CSP | Result |
|---|---|
| self-navigation to a third-party sink | **blocked** |
| meta refresh to a third-party sink | **blocked** |
| self-navigation / meta refresh to a `'self'` URL (control) | request received |
| WebRTC | **still leaks** (3 UDP packets) |

Four things the measurement showed that a code read did not:

- **The embedder's `frame-src` governs the frame's own navigations.** The frame's
  CSP has no directive for its own navigation, but the parent's does. On
  app.openwop.dev the frame can therefore navigate only to the four sources
  above. `https://*.firebaseapp.com` is still a real exfiltration target, since
  anyone can register a Firebase project. Wherever the SPA is served without that
  policy, the frame can navigate anywhere. That covers local dev and an adopter
  not on Firebase Hosting.

  > **Corrected by D9 (2026-10-31):** the user chose to remove
  > `https://*.firebaseapp.com`. The app `frame-src` is now `'self'` plus the two
  > Google hosts, so on app.openwop.dev a plugin's own navigation reaches only
  > this site and Google's sign-in hosts. The tables above record the policy as
  > it was measured.
- **The `sandbox` flags are enforced twice.** The header's `sandbox` directive
  re-imposes them, so a token on the iframe attribute alone changed nothing. A
  token has to be on both layers to take effect.
- **`form-action` does not fall back to `default-src`.** Forms were blocked only
  because neither sandbox layer has `allow-forms`. The existing unit test asserted
  `not.toMatch(/form-action/)` (`routes/__tests__/uiPlugins.test.ts`, since #973).
  That reads as "no form-action means none allowed", but it means the opposite.
- **WebRTC is reached under every policy tried.** The leg proves that a
  connection reaches a server the plugin names. It does not prove that data rides
  it, so the copy says "a server it chooses".

So, as in ADR 1017, the opaque origin holds, and the policy blocks every
subresource and request API. But a plugin can still send what it can read to a
server it chooses, with no click: over WebRTC anywhere, and by navigating its own
frame to whatever the embedding page's `frame-src` admits. The reference
`community.openwop.artifact-viewer` holds `hostApi: ["artifact.read"]`, so it can
read an artifact and send it out.

### M2 — the copy that overclaims (code read)

- `/ui-plugins` page, in four locales:
  - `legEgress`: "Egress-denied — … no network requests";
  - `boundaryExplainer`: "Four guarantees";
  - `liveExplainer`: "self-witnesses the four guarantees".
- The boundary self-test marks the egress leg PASS when one `fetch` raises a
  policy violation, under that same label.
- The `ui-plugins` toggle description in the admin feature list says
  "deny-egress".
- The `FEATURES.md` row says "egress-denied".
- The reference pack's own page (`packs/community.openwop.artifact-viewer/entry.html`)
  says "can make no network requests (deny-egress CSP)".
  - It also shows an "Egress BLOCKED ✓" badge, set from a `fetch` to
    `https://example.com` whose `.catch` counts as blocked.
  - That badge is vacuous: the fetch rejects with no policy at all, too. ADR 0840
    already fixed the same flaw in the isolation probe.

### M3 — the entry route ran plugin bytes as the host (code read, architect)

`GET /v1/host/openwop-app/ui-plugin/packs/:name/plugins/:pluginId/entry` served
the plugin's HTML with `pluginIframeCsp()`, which has **no `sandbox`**. Its
`firebase.json` rule had none either. Nothing in the SPA loads the route any more,
since ADR 0840 mounts plugins from the per-plugin `frame`. But it answers, so
opening it at top level runs the plugin's inline script as the host's own origin.
That origin holds the SPA's storage. RFC 0117 §2 says a host MUST NOT load plugin
bytes in its own execution context. The route's comment still described an
`srcdoc` meta policy that ADR 0840 deleted.

### M4 — a navigated frame keeps the RPC handle (code read, architect)

`PluginFrame` accepts a message when `ev.source === iframe.contentWindow`. A
frame's `contentWindow` is the same object after the frame navigates, so the page
it loads passes that check. That page has no deny-egress policy of its own. It
could call the plugin's `hostApi` methods and receive `host.documentChanged`
content.

### M5 — how grants are presented (code read)

The SPA has no install or consent flow for a plugin. Plugins come from the host's
`packs/` directory, and the `ui-plugins` toggle turns the feature on for a tenant.
The only place a grant is shown is the installed-plugins list on `/ui-plugins`,
as raw method chips (`artifact.read`). Nothing says "this plugin can see your
artifacts". After M1 that matters more, because a read grant is also a
send-elsewhere grant. Filed as `PFE-1`, not redesigned here.

### M6 — what the host advertises (code read)

`/.well-known/openwop` advertises `uiPlugins: { supported, isolation:
"cross-origin-iframe", surfaces, hostApi, maxEntryBytes }` (v1), and the v2 record
with `served: true`. No field names egress.

But advertising `uiPlugins` claims RFC 0117's `frontend-plugin-egress` invariant,
whose stated purpose is "so a plugin cannot exfiltrate host data". This host meets
the invariant's letter: it serves a deny-egress CSP, which is what the conformance
scenario `v2-ui-plugin-boundary` reads. Per M1 it does not meet the purpose, and
no frame CSP alone can. RFC 0117's amendment record rules that "runtime
enforcement … is a platform guarantee". M1 is a measurement against that premise.

This is a spec question. It goes to the lead and into the upstream issue draft.
This ADR changes no advert.

## Decision

**D1 — Measure it in the gate.** `e2e/plugin-frame-egress.spec.ts` runs in the
Playwright lane. It imports the production policy and attribute, copying nothing,
and asserts that the two sandbox layers agree. It asserts every row of M1:

- each blocked channel is blocked, and has a control that leaks;
- the three residual channels still leak with the frame posture alone;
- the embedder's `frame-src` blocks a third-party navigation and admits a
  `'self'` one;
- WebRTC ignores both.

The residual legs pin the premise of the copy. If a browser closes one, the spec
goes red and the copy can be revisited. `preconnect` is not asserted, because
nothing could make its zero meaningful.

**D2 — Add `form-action 'none'` and `base-uri 'none'`** to `pluginIframeCsp()`,
so the frame, the isolation probe and the entry route all carry them.
`firebase.json`'s four plugin rules carry them verbatim, and
`adr0840-firebase-frame-csp.test.ts` pins that.

- `form-action` closes nothing today, because the sandbox already blocks forms.
  It makes the policy alone block them if a future capability adds `allow-forms`.
- Witness for `form-action`: with `allow-forms` on both layers, the new policy
  blocks the submit, and the same policy without the directive does not.
- `base-uri` is hygiene and is **not measured**: it has no egress effect that the
  residual channels do not already have. It is added because it is the other
  directive with no `default-src` fallback.
- The conformance witness reads only `sandbox`, `default-src` and `connect-src`,
  so neither directive changes a conformance result.

**D3 — The entry route is served like a frame.** It now sends `pluginFrameCsp()`,
which includes `sandbox allow-scripts`, as does its `firebase.json` rule. Confirmed in production by the lead (a read-only GET, 2026-10-31): the route
answered `200 text/html` with the unsandboxed policy, so a plugin's script ran at
top level as app.openwop.dev. `adr0840-ui-plugin-observation-path.test.ts` fails
on that header and passes on the new one.

**Keep or remove?** The route is kept, sandboxed, and its removal is offered to
the lead rather than decided:

- Nothing in the SPA loads it. `ServedPlugin.entryPath` is listed but never
  read; plugins mount from the RFC 0238 `frame`.
- The corpus conformance suite does not call it: no `ui-plugin/packs` or `/entry`
  path appears in `../openwop/conformance/src`.
- Only host tests use it: `trusted-pack-committed.test.ts` ("the sandbox fallback
  entry still serves") and `frontendPluginPacks.test.ts` (the `entryPath`
  string).
- It is a vendor path (`/v1/host/openwop-app/…`), so adopters may have scripts
  against it. Nothing in this repo shows any.

Removing it would close the class outright: there would be no unsandboxed copy to
re-break. But it is a public behaviour change, and the sandboxed route is now
safe, so it is filed as `PFE-6` for the lead. Plugin HTML no longer runs as the host's
origin on any path this host serves.

**D4 — The sandbox stays exactly `allow-scripts`**, now pinned by equality rather
than by `toContain` / `not.toContain`. So it carries no `allow-top-navigation*`,
`allow-popups`, `allow-forms`, `allow-modals` or `allow-same-origin`. No declared
capability needs any of them.

**D5 — No parent-side teardown on navigation (measured, rejected).** The
architect pass proposed that `PluginFrame` count its iframe's `load` events and
unmount the frame on the second one. That would take the RPC handle away from a
page the plugin navigated to. It was built, then measured, then removed. A
parent counting loads (the spec's last row) misses a navigation in two ways:

- **Navigating before the plugin's own document finishes loading.** The only
  `load` the parent ever sees is the new page's. So the new page is "the plugin"
  and keeps the handle.
- **A navigation answered `204`.** The request is sent, no document loads, and
  no second `load` fires. A plugin can repeat this indefinitely.

A malicious plugin would use the first, so the teardown would stop only a plugin
that navigates by accident. It would also put a sentence on the page ("this page
stops a plugin that loads another page") that is true only for plugins that mean
no harm. The residual is stated instead:

- a page the frame navigates to keeps the plugin's `hostApi` grants;
- it receives `host.documentChanged` content.

It is the same author's code with the same grants, with no CSP. In production
the parent's `frame-src` limits where that page can come from (D9).

**D6 — No WebRTC block, because none works.** CSP `webrtc 'block'` was measured,
and Chromium 148 ignores it. Permissions Policy lists no WebRTC feature; that is
from the spec's feature list, not measured.

A script injected ahead of the plugin that deletes `RTCPeerConnection` was
rejected without being built. Even if it held, navigation would still leak, so it
would buy a claim rather than a boundary. And a page-level shim is the kind of
guard a fresh realm tends to get around.

The spec keeps a `webrtc 'block'` row that asserts the leak. The day Chromium
honours the directive, that row goes red and the directive can be added with
evidence.

**D7 — Say what is true.** Every M2 site now says three things:

- the plugin cannot read this page, cookies or storage;
- the policy blocks its own requests (fetch, images, forms and the like) to any
  site it did not declare;
- **a plugin can still send what it can read to a server it chooses**, by loading
  another page in its frame or over WebRTC.

The `/ui-plugins` page puts that last point in a warning `Notice` beside the legs
it qualifies, not in fine print. It closes with "Only turn on plugins whose
authors you would trust with what they can read."

The self-test's egress leg is relabelled "Requests blocked", which is what it
checks, and its blurb says that one fetch cannot show the residual gap. The
reference pack's badge counts only a `securitypolicyviolation` as blocked, the
same rule as the probe. "Did not declare" is there because a plugin's `connectSrc`
widens `connect-src` (RFC 0238 §B.4). `adr0840-firebase-frame-csp.test.ts` pins
that no installed plugin declares one today.

**D7a — The rule: every `hostApi` read grant is a disclosure to the plugin's
author.** Self-navigation, meta refresh and WebRTC stay open, so the control a
host actually has is what a plugin can READ. Anything a plugin can read
(`artifact.read` today; any future read method) must be treated as sent to
whoever wrote the plugin. Reviewing a plugin, enabling it, and adding a read
method to `HOST_UI_PLUGIN_API` are disclosure decisions, and the UI must present
them that way (`PFE-1`).

What the install/enable surface shows today (code read, step 4):

- **Install:** there is no install flow in the SPA. A `frontend-plugin` pack is
  served from the host's `packs/` directory (an operator action). No consent
  screen exists.
- **Enable:** the `ui-plugins` toggle, per tenant. Its description now names the
  risk generally ("anything it can read could reach its author"), but it names no
  plugin and no grant.
- **List:** `/ui-plugins` shows each plugin's grants as raw method chips
  (`artifact.read`). It never says "this plugin can see your artifacts".

So no surface presents a read grant as "this plugin can see X". That is `PFE-1`;
this ADR files it rather than redesigning the install flow.

**D8 — Adverts unchanged.** M6 goes to the lead as an RFC-gate question.

**D9 — Remove `https://*.firebaseapp.com` from the app's `frame-src`.** The
user chose option (b) on 2026-10-31, relayed by the lead. The options were:

- (a) keep it and name it as the residual;
- (b) remove it, and document the exact source adopters must add;
- (c) a host-served wrapper frame whose own `frame-src` admits only the plugin
  frame path.

What changed:

- `firebase.json`'s app-wide rule is the only place the app CSP lives, and its
  `frame-src` is now `'self' https://apis.google.com https://accounts.google.com`.
  No backend or SPA-shell copy of the app CSP exists. A grep for `frame-src`
  finds only the plugin builders and the published-site runtime
  (`siteRuntime.ts`, `frame-src https:`), a separate surface for public CMS
  pages.
- The demo does not need the wildcard. `frontend/react/.env.production` sets
  `VITE_FIREBASE_AUTH_DOMAIN=app.openwop.dev`, the custom domain the same Hosting
  site serves, so `'self'` covers the sign-in frame. DEPLOY.md already required
  that for the redirect flow.
- No white-label template or generator rewrites the CSP: the bundle ships this
  `firebase.json`.
- An adopter on the default auth domain must list the exact
  `https://<project>.firebaseapp.com`. README.md and DEPLOY.md say so, next to
  the steps that name that domain.
- `scripts/check-auth-frame-src.mjs`, in `npm run build`, fails on any Firebase
  wildcard (`*.firebaseapp.com`, `*.web.app`) and on a default-domain auth domain
  whose exact origin is missing. So the one deployment this would break fails
  its build instead of failing sign-in silently.
- The check takes a custom auth domain to be this site, because a build cannot
  see which domain Hosting serves. That half is the post-deploy check below.

The e2e spec measures navigation under the updated policy: blocked to a
non-admitted origin, reached for a `'self'` control. It also pins that the
policy names no Firebase wildcard. That the wildcard's host-matching admitted
any project is the CSP source-matching rule, not a measurement: the harness
cannot serve HTTPS on port 443.

**Residual after D9:** WebRTC, to any server, under every policy tried. Also
self-navigation to `'self'` and to the two Google hosts: data in a URL to this
site's own server or to Google's sign-in hosts.

**Post-deploy (deploy notes):** after this ships, do a real Google sign-in on
app.openwop.dev. The sign-in popup cannot be driven headless, and
`check-csp-runtime.mjs` says the same. DEPLOY.md carries the step.

## Alternatives considered

- **ADR 1017's static-until-consent frame.** Rejected: a plugin with scripts off
  does nothing.
- **CSP Embedded Enforcement (the iframe `csp` attribute).** This would make a
  page the frame navigates to unrenderable unless it accepts the deny-egress
  policy. That would close D5's residual (the navigated page running without a
  CSP) where a load counter cannot. Not measured. The navigation request still
  leaves, and it adds a negotiation every page a plugin can reach must answer. It
  is the strongest candidate for a follow-up, with the D9 (c) design.
- **Withdraw `artifact.read` from community plugins.** That removes the reference
  plugin's whole purpose. The honest framing is that a read grant is a disclosure
  to the plugin's author: `PFE-1`, and point 3 of the upstream issue draft.

## Architect pass (2026-10-31)

| # | Finding | Resolution |
|---|---|---|
| B1 | The measurement had no parent CSP; production's `frame-src` might change the navigation rows | Measured. It does: M1's second table, D1, D9 |
| B2 | A navigated frame keeps the RPC handle | Built, measured evadable (navigate before the first load, or a `204`), removed: D5 |
| B3 | The entry route serves plugin HTML on the host origin with no `sandbox` | D3 |
| M4 | The spec's first draft only logged | Every row is now an assertion with a control |
| M5 | The WebRTC leg proves a socket, not data | Copy says "a server it chooses"; M1 notes it |
| M6 | iframe `csp` attribute | Recorded under Alternatives, unmeasured |
| M7 | "Requests blocked" is false for a plugin declaring `connectSrc` | Copy says "to any site it did not declare"; D7 cites the pin |
| m8 | `form-action` safe? `base-uri`? | Safe (D2); `base-uri` added |
| m9 | Loopback sink and the fixed wait | The page unloads before each reset; loopback is kept, and `preconnect` is dropped as unobservable |
| m11 | RFC gate | Agreed; M6 cites the amendment ruling M1 contradicts |
| m12 | "No browser host can meet its purpose" was not measured | Reworded: no frame CSP alone can |

## Grades (2026-10-31, independent agents)

**grade-code: B+.** Findings and their resolutions:

- **Major: the navigation teardown is evadable** (a `204` loads nothing).
  Measured, together with a second way past it (navigating before the first
  load), so D5 is rejected and the teardown removed.
- **Minor: the host's own posts are not gated** after a navigation. Moot once D5
  was rejected; it is now a stated residual (D5).
- **Minor: key the iframe to its URL.** Moot once D5 was rejected.
- **Minor: the FE spec imports a backend source file.** A unit test now pins
  `uiPluginRpc.ts` import-free (`uiPlugins.test.ts`). The white-label zip ships
  both trees.
- **Minor: late requests.** Each mount loads a fresh host URL.
- **Minor: `base-uri` is not measured.** D2 now says so.
- **Minor: the self-test comment.** Reworded.
- **Nit: the spec header** now says what production's `frame-src` changes.

**grade-ux: B+.** Findings and their resolutions:

- **Major: the stopped state was a chip, a dead end.** Moot: D5 removed that
  state.
- **The WebRTC wording claimed data was sent.** It now reads "can open a WebRTC
  connection to any server".
- **"Did not declare" implied images and forms can be declared.** Reworded: only
  fetch-style calls can reach declared sites.
- **The self-test row reused the long sentence.** It now has its own label,
  `selfTestEgressLabel`: "Requests blocked (one fetch is checked)".
- **Spanish and Portuguese phrasing** fixed.
- **Toggle-description jargon:** it now reads "anything it can read could reach
  its author".
- **The pack page's badge colours in dark mode:** a `prefers-color-scheme`
  block added.
- **PFE-1 lacked sites and an acceptance criterion:** both added.

## RFC gate

None for this change. The policy gains directives, the entry route gains the
sandbox it lacked, and the copy changes. Nothing on the wire moves.

M6 is a spec question. The upstream issue is **drafted, pending the user**:
"RFC 0117 `frontend-plugin-egress`: a deny-egress CSP does not stop a scripted
plugin frame from exfiltrating" (openwop/openwop). The lead holds the draft
(`ia67-6-openwop-issue-draft.md`). It is not filed. Its table should gain M1's
second table: the embedder's `frame-src` is the one standard control over
navigation.

## Gaps

- [ ] `PFE-1` — grants are shown as raw method names: the chips in
  `UiPluginsPage.tsx`'s installed list. The enable point, the `ui-plugins` toggle
  description, names no grant at all.
  - Acceptance: wherever a plugin is listed or enabled, each grant has one
    plain-language line. For `artifact.read`, that line is "can see your
    artifacts, and could send what it sees elsewhere".
- [ ] `PFE-2` — the community pack's signature covers `pack.json` only, not
  `entry.html`. The trusted lane signs the module bytes; the sandbox lane does
  not. So "signed" on `/ui-plugins` does not vouch for the code that runs.
- [x] `PFE-3` — ADR 1017's artifact spec claimed its TCP counter covers a bare
  `preconnect`. Chromium 148 opens no such socket to the loopback sink, so that leg
  is uncovered. The header comment is corrected in this PR (logic unchanged), and
  the residue is recorded under ADR 1017 `IA67-16` / `IA67-10`.
- [ ] `PFE-4` — the upstream RFC 0117 issue (drafted, pending the user).
- [ ] `PFE-6` — remove the vendor `…/packs/:name/plugins/:pluginId/entry` route
  and `entryPath` (D3): unused by the SPA and by conformance; the lead decides.
- [x] `PFE-5` — `https://*.firebaseapp.com` removed from the app `frame-src` (D9,
  the user's decision of 2026-10-31), with a build check and adopter docs.
  Post-deploy: a real Google sign-in on app.openwop.dev.

## Implementation record

| Phase | What | Test |
|---|---|---|
| P1 | D1–D4, D7, D7a, D9 (D5 measured and rejected) | `e2e/plugin-frame-egress.spec.ts` (8 tests); `routes/__tests__/uiPlugins.test.ts`; `adr0840-firebase-frame-csp.test.ts`; `adr0840-ui-plugin-observation-path.test.ts` (entry route sandbox, frame `form-action`); `IsolationSelfTest.test.tsx`; `scripts/__tests__/authFrameSrc.test.ts` (D9) |

Sabotage witnesses, each applied, observed red, and reverted:

- Stripping `sandbox` from the entry route made the observation-path entry case
  red.
- For D9, re-adding the wildcard to `firebase.json` made both
  `authFrameSrc.test.ts` and `check-auth-frame-src.mjs` red. So did setting
  `VITE_FIREBASE_AUTH_DOMAIN=openwop-dev.firebaseapp.com` with no exact origin
  (the script red).
- Deleting `form-action 'none'` made six backend cases red (the four Firebase
  rules, the frame header and the unit pin), and made the e2e `form-action` test
  red.
