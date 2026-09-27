# OpenWOP Desktop (Electron) — ADR 0181 Phases B–E

A thin Electron shell around the **server-served** OpenWOP SPA. Zero UI
duplication: it bundles only a "connect to host" setup page, then loads the
host's own origin (the same bytes a browser loads). It adds the OS niceties a
browser tab can't: notifications, a dock/taskbar unread badge, a native menu,
multiple windows/hosts, and (Phase E) lifecycle management of a local backend +
subscription shim.

## Run (dev)

```bash
cd clients/desktop
npm install          # electron + electron-builder
npm start            # launches the shell; enter a host URL (e.g. http://localhost:8000)
```

The setup page offers the self-hosted default (`http://localhost:8000`), a
one-click **hosted demo** (`app.openwop.dev`), and your **recent hosts**.

## Self-test (the display-gate closer)

```bash
npm run selftest     # exits 0/1; screenshots + selftest-report.json in ./selftest-out
```

Launches the REAL shell against an isolated userData dir and verifies, end to
end: the setup page renders with both preload bridges injected → the real
`setup:save-host` IPC persists + navigates → the **remote host origin** receives
`window.openwopNative` (`kind: 'electron'`). Override the probed host with
`OPENWOP_SHELL_SELFTEST_HOST` (default `https://app.openwop.dev`). First
verified run: 2026-07-06, against the live demo host — pass.

## Package (unsigned)

```bash
npm run build:mac        # dmg + zip into dist/ (CSC_IDENTITY_AUTO_DISCOVERY=false for unsigned)
npm run build:linux      # AppImage + deb — cross-builds fine FROM macOS (host arch; add --x64 for Intel)
npm run build:win        # NSIS installer — also cross-builds from macOS, no wine needed unsigned
```

All three platforms package from a single macOS machine (verified: arm64 + x64
NSIS/AppImage/deb). Only **signing** is platform/credential-gated — mac
signing/notarization needs the Apple Developer ID (ADR 0181 § Remaining
steps); Windows Authenticode needs a cert and is best done on Windows CI.

`build/icon.png` is generated from the SPA's own brand mark — regenerate with
`npx electron tools/make-icon.js` if `frontend/react/public/OpenWOP.svg`
changes. **Signing/notarization requires an Apple Developer ID** and is the one
remaining external gate (documented in ADR 0181).

## White-labeling + enterprise vs demo mode (ADR 0291)

The shell brands **only its pre-connection chrome** (setup page, native menu,
app name/icon). Everything after connect is the host's own server-served SPA —
re-brand that with the app's `VITE_BRAND_*` seam per
[`frontend/react/WHITE-LABEL.md`](../../frontend/react/WHITE-LABEL.md); the two
seams share the same vocabulary and never overlap.

Everything lives in **[`branding.json`](branding.json)** — edit it, then:

```bash
npm run apply-branding            # sync productName/appId into package.json (electron-builder)
npx electron tools/make-icon.js   # re-render build/icon.png from your iconSvg
npm run build:mac                 # package under your identity
```

| Field | Default | Controls |
|---|---|---|
| `productName` | `OpenWOP` | App name: setup page, Help menu, packaged app (via apply-branding) |
| `appId` | `dev.openwop.desktop` | Bundle/app id for the packaged artifact |
| `mode` | `demo` | `demo` = hosted-demo quick-connect on the setup page; `enterprise` = every demo affordance removed |
| `defaultHost` | `http://localhost:8000` | Setup-page prefill/placeholder |
| `demoHost` | `https://app.openwop.dev` | Demo quick-connect target; force-cleared in `enterprise` mode |
| `lockedHost` | `null` | **Enterprise pinning**: when set, the shell always loads this origin — setup page and "Change Server…" disappear; beats any saved host |
| `helpUrl` | `https://app.openwop.dev` | Help-menu link; `null` removes the Help menu |
| `accent` | `#b95c3a` | Setup-page accent (buttons, monogram) |
| `iconSvg` / `iconPlate` | the OpenWOP mark / `#f4f1ea` | Source SVG + plate tone for `make-icon.js` (path relative to this dir) |

Any missing/malformed field falls back to the stock OpenWOP value
(`src/branding.js`, unit-tested). A non-`OpenWOP` `productName` swaps the setup
page's OpenWOP mark for an accent monogram automatically.

**Demo mode** (stock) — setup page with the hosted-demo one-click connect;
point it anywhere, including `app.openwop.dev`.

**Enterprise mode** — set `mode: "enterprise"` and (usually) `lockedHost` to
your company origin. The shell then boots straight into your host, with no way
to repoint it from the UI. Pair it with the backend's enterprise lockdown
(SHELL-1 in `WHITE-LABEL.md`): `VITE_BRAND_APP_GATE_MODE=sign-in` on the SPA
build, `OPENWOP_DEPLOY_POSTURE=auth` on the backend, and your IdP via
SAML/SCIM — the shell inherits the sign-in gate because it renders the host's
SPA. Example:

```json
{
  "productName": "Acme Flow",
  "appId": "example.acme.flow",
  "mode": "enterprise",
  "lockedHost": "https://flow.acme.example",
  "helpUrl": "https://support.acme.example",
  "accent": "#2563eb",
  "iconSvg": "./acme-mark.svg"
}
```

Verify with `npm run selftest` — it asserts the setup page renders your
`productName`, that the demo button matches the posture (absent in
enterprise), and that a pinned build loads `lockedHost` directly (the report
records the skipped setup legs). `OPENWOP_SHELL_BRANDING=/path/to/branding.json`
overrides the bundled file for testing.

## What's here

| File | Role | Phase | Verified |
|---|---|---|---|
| `src/url.js` | host-origin normalize/validate (pure) | B | ✅ `node --test` |
| `src/settings.js` | persisted host + recent list + optional `localServer` config (pure) | B/E | ✅ `node --test` |
| `src/branding.js` + `branding.json` | white-label branding + demo/enterprise posture (ADR 0291, pure) | — | ✅ `node --test` |
| `tools/apply-branding.js` | syncs branding.json → package.json builder fields | — | ✅ `node --test` |
| `src/serverManager.js` | own-what-you-start lifecycle (pure) | E | ✅ `node --test` |
| `src/preload.js` | injects `window.openwopNative` + the setup bridge via `contextBridge` | B | ✅ self-test |
| `src/main.js` | window, IPC (notify/badge/recent), native menu, multi-window, local-host wiring, self-test | B/C/E | ✅ self-test |
| `setup/index.html` | connect-to-host page (brand, demo quick-connect, recent hosts) | B | ✅ self-test screenshot |
| `tools/make-icon.js` | renders `build/icon.png` from the SPA's `OpenWOP.svg` | C | ✅ run |

## Security posture (architect ruling)

- `BrowserWindow`: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`. The renderer loads a **remote** host origin and only
  ever sees the tiny `window.openwopNative` surface (strings/numbers).
- `setup:save-host` / `setup:recent-hosts` are guarded to accept **only
  `file://` senders** — a remote host can never repoint the shell or read your
  host list.

## Phase E — turnkey local subscription (with ADR 0182)

`serverManager.ManagedProcesses` launches a local `openwop-app-backend` (wired
to the `@openwop/subscription-provider` shim via `OPENWOP_SUBSCRIPTION_ENDPOINT`)
and tears down **only what it started** — an already-running backend/shim is
adopted, never killed.

Wiring is **config-gated**: add to the app's `settings.json`
(`~/Library/Application Support/<app>/settings.json` on macOS):

```json
{
  "localServer": {
    "command": ["node", "/path/to/openwop-app/backend/typescript/lib/index.js"],
    "probeUrl": "http://localhost:8000/api/readiness",
    "origin": "http://localhost:8000"
  }
}
```

The **Server** menu then grows **Start/Stop Local Host**. No config ⇒ the items
don't exist and the block is inert. (An installer that writes this config is
ADR 0052/0182 follow-on work.)

## Not part of the app build

This package has its own `package.json`/deps and is **not** swept by
`scripts/ci.sh` or imported by `backend/` or `frontend/`. It targets any OpenWOP
host over the published REST+SSE surface.
