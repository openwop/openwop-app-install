# ADR 0181 — Native desktop / mobile shell (thin single-bundle web wrapper + feature-detected native bridge)

**Status:** implemented — finished + display-verified 2026-07-06 (originally Proposed 2026-07-01; see the completion note below the phase table). Remaining external gates: Apple signing/notarization (needs a Developer ID) and the Xcode iOS build — infrastructure, not code.
Originally: Proposed — 2026-07-01 · **all phases worked through** 2026-07-01. Phase A (SPA seam) in `frontend/react/`; Phases B/C/E (Electron shell + lifecycle) in `clients/desktop/` (pure logic unit-tested, runtime files parse-checked); Phase D (iOS) a documented scaffold in `clients/ios/` (Xcode-gated, not sandbox-buildable). The OQ "where does the shell live" is **resolved to `clients/`** (a monorepo package, isolated from the app build — architect-blessed). See the phase table.
**Superseded in part by ADR 0413** (2026-07-18): for the **participant** client, ADR 0413 replaces this thin-WebView-shell doctrine with a native-rendered Expo/React Native app (the KickTodo consumer app needs native UX/offline/push a WebView cannot deliver). This ADR still governs the **desktop Electron shell** and the **web PWA workbench**; the iOS `WKWebView` shell here becomes a transition/host-compatibility harness, retired only after ADR 0413 reaches release parity with a tested install-migration path. The "one SPA everywhere / no second UI" thesis remains correct for the workbench and is the reason 0413's reuse is scoped to *contracts/client/tokens, not screens*.

**Depends on / relates to:** ADR 0168 (headless host profile + "the CLI already exists — extend it, don't fork a second system"). ADR 0001 (feature-first package architecture; "reuse, never recreate"). ADR 0073 (`EmbeddedChatPanel` — the shared-UI reuse ethos). ADR 0182 (self-hosted local executor — the desktop shell is what makes that turnkey; Phase E here depends on it).
**Surface:** a NEW non-normative **client** surface (a native shell that wraps the existing React SPA). **NO new RFC.** The shell is a browser wrapper over the already-published host surface (`/.well-known/openwop`, `/v1/runs`, `/v1/workflows`, `/v1/agents`, SSE). It advertises nothing on the wire and rides only capabilities the host already exposes.

## Why this exists

openwop-app is "100% headless-capable" (ADR 0168 Part A): the backend is a standalone Express host with zero browser-global dependencies, and the React SPA is purely a view over the REST+SSE API. Today that SPA is only reachable as a browser tab (Firebase Hosting `app` target, or a self-hosted backend serving its own origin). Three capabilities the web platform cannot deliver are increasingly wanted:

1. **OS-native notifications** for the events users already wait on — a run finishing, and a **HITL interrupt card being raised** (the RFC 0005 interrupt primitive: "the agent needs your input"). In a browser tab these are easy to miss.
2. **A persistent unread/attention signal** — a dock/taskbar badge count and a foreground attention cue.
3. **A path to being the local execution host** (ADR 0182) — a desktop app on the user's machine can manage a local backend + a locally-logged-in provider CLI, which a browser tab structurally cannot.

The wrong way to get these is a second UI. This ADR records the **thin-shell, single-bundle, feature-detected** approach so we get native niceties with **zero UI duplication**.

## The load-bearing constraint (read first): one bundle, never a fork

The central discipline is that **the exact same `frontend/react` build runs in every runtime**: a browser tab, a desktop window, and (later) a mobile webview. The shells **do not ship a copy of the SPA**; they load it from a configured host origin (the same bytes the backend/Hosting already serves). This is the ADR 0168 lesson applied to the view layer: a bundled second copy of the SPA is a "second system" that drifts. If a feature works in the browser, it works in the shell, because it *is* the browser build.

## Decision

Ship a **thin native shell** over the existing SPA, in phases, governed by four rules:

### 1. Single bundle, N runtimes, zero UI duplication
The shell bundles only a tiny **"connect to host" setup page** (one input → the host origin, default the self-hosted backend or `app.openwop.dev`). On launch it persists that origin to the per-user app-data dir and **loads the host's own origin**, where the backend/Hosting serves the production `frontend/react` build. No SPA bytes ship inside the app package.

### 2. A feature-detected native bridge (`frontend/react/src/native/nativeBridge.ts`)
The SPA detects it is inside a shell by an **injected global** (`window.openwopNative`) carrying a discriminator (`kind: "electron" | "ios"`) — **never a build flag**. The bridge surface is deliberately tiny and serialization-safe (string/number only) and **never throws**:

- `setBadgeCount(n)` — paint/clear the dock/taskbar unread badge.
- `notify(params) → Promise<boolean>` — fire an OS notification; resolves `true` when shown.
- `onNotificationActivated(cb) → unsubscribe` — route a notification click to an in-app path.

In a plain browser tab, `window.openwopNative` is absent and **every call degrades to a no-op/`false`**, and the caller falls back to the existing Web Notifications path. One codebase, decided at runtime; a broken/old shell can never take down the browser experience.

### 3. Native niceties only where the web can't
The shell's main process adds exactly what a tab cannot: OS notifications on **run-finished** and **interrupt-raised** (suppressing the conversation the user is actively viewing — window focused *and* that chat open); a **dock/taskbar unread badge**; a **foreground attention cue** (macOS dock bounce / Windows-Linux taskbar flash, because the frontmost app suppresses toast banners); **multiple windows** and **multiple hosts** (a window per host origin); the **native menu** (so Cmd/Ctrl-A/C/V/X/Z work inside webview text fields); browser-style file **drag-and-drop**; and **microphone permission** wiring for the composer's dictation button. Each is a thin main-process handler; none touch the SPA's logic.

### 4. Reuse the SPA and the API — add no wire, fork no UI
The shell imports nothing from `backend/`, adds no endpoint, and advertises no capability. Notification events map onto **existing** run/interrupt state the SPA already tracks (the interrupt-card raise is already an observable state transition), not a new event type. Packaging is standard `electron-builder` (dmg/zip/AppImage/deb/nsis), signed + notarized.

## Boundaries & duplication (architect self-review)

- **No second UI.** The shell serves the same SPA bytes; a bundled copy is explicitly disallowed (rule 1). Mirrors ADR 0168's "don't stand up a second system."
- **No second bridge shape.** `nativeBridge.ts` is the single seam; features consume it, they don't reach into `window.*` ad hoc.
- **No wire change.** The shell rides `/.well-known/openwop` + REST+SSE; if a future shell feature needs new host behavior, that is host work behind its own ADR (and an RFC only if it touches the wire) — not smuggled into the shell.
- **Notification taxonomy reuses existing state.** "Run finished" / "interrupt raised" / "host disconnected" derive from state the SPA already has; we do not add a notification event to the protocol.

## Alternatives considered

| Option | Why not (now) |
|---|---|
| **Tauri** (Rust + system webview) | Smaller binaries, but the system-webview variance (Safari/WebKit on macOS vs WebView2 on Windows) reintroduces the cross-engine bugs the single-Chromium Electron shell avoids, and it intercepts file drops by default (extra work to reach the SPA's HTML5 drop handler). Reconsider if binary size becomes the dominant constraint. |
| **PWA / "Add to Home Screen" only** | No reliable OS dock badge, no dock-bounce attention cue, no multi-window, and — decisively — no ability to manage a **local backend + provider CLI** (ADR 0182). A PWA can cover *some* notification cases and remains the browser-path fallback, but not the local-host story. |
| **Native rewrite (SwiftUI/Compose UI)** | Violates rule 1 (single bundle) — a second UI that drifts. The whole point is one SPA everywhere. |
| **Bundle the SPA inside the app** | Version-skew between a stale bundled SPA and a newer backend. Rejected in favor of "zero UI duplication" — load the host origin. |

## Phased implementation plan

| Phase | Scope | Ships value | Gate |
|---|---|---|---|
| **A** ✅ *implemented 2026-07-01* | `frontend/react/src/native/nativeBridge.ts` seam (feature-detected `window.openwopNative`, never-throws, no-op in browser) + wired into the **existing** `notificationStore` (`fireDesktopNotification` native branch, shared `navigateToActionUrl`, unread→`setNativeBadgeCount`, `onNativeNotificationActivated`) — no parallel notifier. | Yes — the browser path is unchanged; the seam is inert until a shell injects. | FE build gate green (entry 167.7 kB); 13 bridge unit tests + notification regression tests pass. |
| **B** ✅ *implemented 2026-07-01* | Thin Electron shell in `clients/desktop/`: `setup/index.html` (connect-to-host), `src/preload.js` (injects `window.openwopNative` via `contextBridge`; hardened), `src/main.js` (`BrowserWindow` loads the host origin, `Notification` + `setBadgeCount` IPC), `src/url.js` + `src/settings.js` (pure). | Yes — the desktop app exists. | 11 `node --test` assertions (url + settings); `main.js`/`preload.js` parse-checked (Electron runtime needs a display). |
| **C** ✅ *implemented 2026-07-01 (packaging/signing deferred)* | Multi-window / multi-host, native menu (Edit/View/Window/Server/Help), notification-click routing (`native:notification-activated`), `electron-builder` config in `package.json`. **Signing + notarization deferred** (needs an Apple identity, not sandbox-doable). | Yes | Menu/multi-window in `main.js` (parse-checked); `electron-builder` targets configured. |
| **D** ✅ *scaffold 2026-07-01* | iOS SwiftUI/`WKWebView` shell — a **documented scaffold** in `clients/ios/README.md` (bridge parity, Swift sketch) scoped down for v1 (no APNs / background / localhost-proxy). **Xcode-gated**: not buildable in the headless sandbox, so source-only. | Yes — mobile (once built in Xcode). | Shares the desktop pure logic; Swift wrapper documented. |
| **E** ✅ *implemented 2026-07-01* | `clients/desktop/src/serverManager.js` — `ManagedProcesses` spawns/adopts/stops a local backend + the `@openwop/subscription-provider` shim (ADR 0182 Phase 4); **owns only what it starts**. | Yes — the "download → your machine is the host with your subscription" flow. | 5 `node --test` assertions (spawn/adopt/idempotent/stop-owned-not-adopted/stopAll). |

All phases were worked through; the residuals were **infrastructure gates, not design gaps**: Electron GUI run, Apple signing/notarization, and the Xcode iOS build require a display / developer account and are not verifiable in a headless sandbox. The pure logic behind each is unit-tested (26 desktop assertions).

### Completion note (2026-07-06 — the finish pass, run on a machine WITH a display)

The display gate is closed. What this pass added/verified:

- **Self-test mode** (`OPENWOP_SHELL_SELFTEST=1 npx electron .`) — launches the real shell
  against an isolated userData dir, asserts (1) the setup page renders with BOTH preload
  bridges injected, (2) the real `setup:save-host` path persists + navigates, (3) the
  **remote host origin** receives `window.openwopNative` with `kind: 'electron'`; captures
  screenshots + a JSON report and exits 0/1. First-ever real run **passed against the live
  `app.openwop.dev`** — the deployed SPA's Phase-A bridge detected the shell. This is now the
  repeatable verification story the original phases lacked.
- **Setup page finished** — brand mark, the persisted-but-never-rendered **recent-hosts
  list**, and the hosted-demo quick action (see the resolved OQs).
- **Phase E actually wired** (correction: the 2026-07-01 pass shipped `ManagedProcesses`
  but `main.js` never imported it). Now config-gated: a `localServer: {command[], probeUrl,
  origin}` block in `settings.json` grows the Server menu with Start/Stop Local Host;
  `will-quit` stops only owned processes. No config ⇒ byte-inert. The installer story that
  would WRITE that config remains ADR 0052/0182 follow-on work.
- **Branding/packaging** — `build/icon.png` generated from the SPA's own `OpenWOP.svg` by
  Electron itself (`tools/make-icon.js` — the icon can't drift from the product brand);
  unsigned mac artifacts (dmg/zip) built via `electron-builder` and the packaged .app
  re-verified with the same self-test. Signing/notarization stays Apple-identity-gated.
- **Phase D graduated from scaffold to a BUILDABLE target (2026-07-06, second finish
  pass)**: full Swift sources (`clients/ios/Sources/OpenWOP/` — SwiftUI setup screen with
  UX parity to the desktop page, `WKWebView` + the `kind:'ios'` bridge via
  `WKUserScript`/`WKScriptMessageHandler`, `UNUserNotificationCenter` notifications +
  badge + tap-routing, host validation mirroring `url.js`), an `xcodegen` `project.yml`,
  and the same self-test pattern (`OPENWOP_IOS_SELFTEST=1` probes the bridge on the loaded
  host origin, printed via `simctl launch --console-pty`). **Compiles clean against the
  iphonesimulator SDK** (unsigned) and runs in the Simulator. Device signing +
  TestFlight remain the Apple-Developer-ID gate, exactly like the mac notarization.

### Remaining steps (2026-07-06 — everything left is credential/distribution work, no code)

Every code path is implemented and verified (desktop self-test + packaged .app against the
live host; iOS simulator run with the bridge probe returning `kind:'ios'`). What remains
requires an **Apple Developer Program membership** (developer.apple.com/programs, US$99/yr)
and, later, distribution decisions:

1. **macOS signing + notarization** (unblocks distributing the dmg/zip outside this machine
   — unsigned builds trip Gatekeeper on download):
   - Create a **Developer ID Application** certificate in the Apple Developer portal;
     export it as a `.p12`.
   - Build signed: `CSC_LINK=<path-to-p12> CSC_KEY_PASSWORD=<pw> npm run build:mac`
     (drop `CSC_IDENTITY_AUTO_DISCOVERY=false`).
   - Notarize: add `"notarize": true` under `build.mac` in `clients/desktop/package.json`
     with `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` env — electron-builder
     staples the ticket automatically.
2. **iOS device + TestFlight** (the simulator needs none of this):
   - `xcodegen generate`, open `clients/ios/OpenWOP.xcodeproj`, set the Team under
     Signing & Capabilities (automatic signing) — device runs work immediately.
   - TestFlight/App Store: archive via `xcodebuild archive` + `-exportArchive` (or Xcode
     Organizer), upload with `xcrun altool`/Transporter. App Store review also wants the
     1024-pt marketing icon — reuse `clients/desktop/tools/make-icon.js` output.
3. **Windows/Linux desktop artifacts** — ~~needs Windows (or wine) / a Linux box~~
   **DONE unsigned (2026-07-06, correction):** the original platform-gate assumption was
   too pessimistic — modern electron-builder cross-packages NSIS + AppImage/deb from
   macOS with no wine. Verified locally for arm64 AND x64 (`npm run build:win` /
   `build:linux`, add `--x64`), after fixing three metadata blockers (path-unsafe scoped
   `executableName`, missing `homepage`, missing `author.email` — ADR 0291 addendum).
   What remains platform/credential-gated is only **Windows code-signing**
   (Authenticode cert, best on Windows CI); unsigned installers work today.
4. **Distribution surface** (a decision, not a gate): where the artifacts live — a GitHub
   Release on this repo, the `openwop.dev /install/` bundle (ADR 0052's lane), or both; and
   whether the desktop app gets auto-update (electron-builder's updater needs a publish
   target — deliberately NOT wired yet, since the shell loads the server-served SPA and the
   shell itself changes rarely).
5. **Optional follow-ons recorded elsewhere**: the installer that writes the Phase E
   `localServer` config block (ADR 0052/0182 lane), and the deferred
   MediaRecorder→server-transcription dictation path (would ride ADR 0108's seam under its
   own ADR).

## Open questions / decisions

- [x] **Where does the shell code live?** **RESOLVED 2026-07-01 → `clients/desktop/`** (a monorepo package with its own `package.json`, NOT swept by `scripts/ci.sh`, NOT imported by `backend/`/`frontend/` — verified by a grep gate). The architect ruled this materially equivalent to a sibling repo for isolation while keeping it reviewable with the ADRs; `clients/` sits beside the existing `tools/`/`examples/`. A later extraction to a standalone repo remains possible without code change.
- [x] **Default host origin** — **RESOLVED 2026-07-06 → both, self-hosted first.** The input's
  placeholder/prefill stays `http://localhost:8000` (the ADR 0182 local-host story is the
  desktop's differentiating capability), and the setup page adds a one-click
  **"Use the hosted demo (app.openwop.dev)"** secondary action plus the persisted
  **recent-hosts list** (stored since Phase B but previously never rendered — closed with
  this finish pass).
- [x] **Notification event set** — **CONFIRMED 2026-07-06**: v1 = run-finished +
  interrupt-raised + host-disconnected. Per-turn completion is deliberately excluded
  (notification fatigue; the badge already conveys activity) — revisit only on user ask.
- [x] **iOS scope** — **CONFIRMED 2026-07-06**: v1 excludes APNs/background/localhost-proxy
  (the Phase D scaffold stands as documented; Xcode-gated).
- [x] **Dictation** — **CONFIRMED 2026-07-06**: inside the shell the Web Speech API is
  unavailable; the SPA's existing feature-detect renders the mic affordance disabled
  ("dictation unavailable"). A MediaRecorder→server-transcription path stays deferred
  (would be host work under its own ADR, riding ADR 0108's transcription seam).

## Verification (when implemented)

- Phase A: `nativeBridge` no-op path unit-tested (browser → `false`/no-op, no throw); FE build gate green (tsc + token/CSS + i18n parity).
- Phase B/C: Electron main-process logic unit-tested (`node --test`): setup-URL parsing, badge counting, notification suppression for the focused conversation, host-origin loading. Manual light/dark + multi-window verification.
- No backend tests change (the shell adds no host code) — a `grep` gate asserts the shell imports nothing from `backend/`.
