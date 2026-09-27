# OpenWOP iOS shell (ADR 0181 Phase D)

A thin SwiftUI + `WKWebView` shell that, like the desktop shell, loads the
**server-served SPA** rather than bundling a copy. Same single-bundle principle:
the app ships only native setup chrome; the UI comes from the host origin.

> **Build status: BUILDABLE + simulator-verified (2026-07-06).** The scaffold
> became a real target: full Swift sources in `Sources/OpenWOP/`, an `xcodegen`
> `project.yml`, and a self-test env (`OPENWOP_IOS_SELFTEST=1`) that probes the
> injected bridge on the loaded host origin and prints a parseable `[selftest]`
> line (captured via `simctl launch --console-pty` — the iOS analogue of the
> desktop `npm run selftest`). What still needs an Apple **Developer ID**:
> signing for a physical device + TestFlight/App Store — simulator builds are
> unsigned and fully verifiable.
>
> ```bash
> cd clients/ios
> xcodegen generate
> # compile (no runtime needed):
> xcodebuild -project OpenWOP.xcodeproj -target OpenWOP -sdk iphonesimulator26.5 \
>   ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
> # run + verify (needs an iOS simulator runtime; one-time `xcodebuild -downloadPlatform iOS`):
> xcrun simctl boot "iPhone 17"   # any available device
> xcrun simctl install booted build/Debug-iphonesimulator/OpenWOP.app
> SIMCTL_CHILD_OPENWOP_IOS_SELFTEST=1 xcrun simctl launch --console-pty \
>   --terminate-running-process booted dev.openwop.ios
> # → [selftest] {"remoteBridge":"ios","url":"https://app.openwop.dev/"}
> #   (simctl passes child env via the SIMCTL_CHILD_ prefix — trailing
> #    NAME=value tokens are launch ARGUMENTS, not env)
> ```
>
> `OpenWOP.xcodeproj` and `build/` are generated artifacts (gitignored);
> `project.yml` + `Sources/` are the source of truth.

## White-labeling + enterprise vs demo mode (ADR 0291)

Same rule as the desktop shell: the app brands **only its native setup
chrome** — the loaded UI is the host's own SPA, white-labeled server-side via
`VITE_BRAND_*` ([`frontend/react/WHITE-LABEL.md`](../../frontend/react/WHITE-LABEL.md)).
All knobs live in **`project.yml`** (no Swift edits), read at runtime by
`Sources/OpenWOP/Branding.swift`:

| `project.yml` key | Default | Controls |
|---|---|---|
| `OWPProductName` | `OpenWOP` | Name on the setup screen |
| `OWPMode` | `demo` | `demo` shows the hosted-demo quick-connect; `enterprise` removes it |
| `OWPDefaultHost` | `http://localhost:8000` | Setup prefill/placeholder |
| `OWPDemoHost` | `https://app.openwop.dev` | Demo quick-connect target; force-cleared under `enterprise` |
| `OWPLockedHost` | *(blank)* | **Enterprise pinning**: always load this origin; setup screen + the change-server gear never show |
| `OWPAccentColor` | `#b95c3a` | Setup-screen accent |
| `CFBundleDisplayName` / `PRODUCT_BUNDLE_IDENTIFIER` | `OpenWOP` / `dev.openwop.ios` | Home-screen name + bundle id |

Missing/blank values fall back to the stock OpenWOP identity. After editing,
re-run `xcodegen generate` and rebuild. For a full enterprise install, pair
`OWPMode: enterprise` + `OWPLockedHost` with the backend lockdown recipe
(SHELL-1 in `WHITE-LABEL.md`) — the shell inherits the host's sign-in gate
because it renders the host's SPA.

## Scope (v1)

- Native setup screen (enter a host URL), recent hosts, `WKWebView` load.
- The `window.openwopNative` bridge injected via a `WKUserScript` +
  `WKScriptMessageHandler`, so the SPA's `nativeBridge.ts` feature-detects it
  exactly as in the desktop shell (`kind: "ios"`).
- Foreground local notifications + app badge via `UNUserNotificationCenter` /
  `UIApplication.shared.applicationIconBadgeNumber`.
- Notification-tap routing back into the SPA (`native:notification-activated`).

Out of scope for v1 (mirrors the desktop scope-down): APNs push, background
polling, and any localhost proxy/CORS shim. Release builds keep App Transport
Security defaults (remote hosts must be `https://`); debug builds may allow
`http://` for local development.

## The native bridge (parity with the desktop preload)

The injected script exposes the same minimal, serialization-safe surface the
desktop `preload.js` exposes, discriminated by `kind: "ios"`:

```js
window.openwopNative = {
  kind: "ios",
  setBadgeCount: (n) => window.webkit.messageHandlers.native.postMessage({ t: "badge", n }),
  notify: (p) => { window.webkit.messageHandlers.native.postMessage({ t: "notify", ...p }); return Promise.resolve(true); },
  onNotificationActivated: (cb) => { /* registered; the Swift side calls window.__owpActivate(path) */ }
};
```

The Swift `WKScriptMessageHandler` receives `{ t: "badge" | "notify", … }` and
calls `UNUserNotificationCenter` / sets the badge — the iOS analogue of the
desktop `ipcMain` handlers in `src/main.js`.

## Minimal shell (sketch)

`Sources/OpenWOP/AppShell.swift` (illustrative — the real target adds the
message handler + notification delegate):

```swift
import SwiftUI
import WebKit

struct WebView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let bridge = """
        window.openwopNative = { kind: 'ios',
          setBadgeCount: n => webkit.messageHandlers.native.postMessage({t:'badge',n}),
          notify: p => (webkit.messageHandlers.native.postMessage({t:'notify',...p}), Promise.resolve(true)),
          onNotificationActivated: cb => { window.__owpActivate = cb; return () => { window.__owpActivate = null }; } };
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(context.coordinator, name: "native")
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.load(URLRequest(url: url))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) {}
    func makeCoordinator() -> Bridge { Bridge() }
}

final class Bridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        // { t: "badge", n } → applicationIconBadgeNumber; { t: "notify", … } → UNUserNotificationCenter
    }
}
```

## Next steps to make it buildable

1. `xcodegen`/manual `.xcodeproj` with the `OpenWOP` scheme, iOS 18 target.
2. Implement `Bridge` (badge + `UNUserNotificationCenter`) and the notification
   delegate that calls `window.__owpActivate(path)` on tap.
3. Reuse the desktop host-origin validation rules (`clients/desktop/src/url.js`)
   in Swift so the two shells agree on what a valid host is.
