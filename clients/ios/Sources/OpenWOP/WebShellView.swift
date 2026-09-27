// ADR 0181 Phase D — the WKWebView shell + the `window.openwopNative` bridge
// (kind: 'ios'), PARITY with the desktop preload: setBadgeCount, notify (local
// notifications via UNUserNotificationCenter), onNotificationActivated routing
// a tap back to the SPA. A small translucent gear overlay opens "change server"
// (the iOS stand-in for the desktop's Server menu).
//
// SELF-TEST (the desktop pattern, ADR 0181 §Verification): launching with the
// env `OPENWOP_IOS_SELFTEST=1` probes `window.openwopNative.kind` after the
// remote page loads and prints a parseable `[selftest]` line to stdout —
// captured by `xcrun simctl launch --console-pty`, so CI/a human can verify the
// bridge on the REAL host origin without a UI driver.

import SwiftUI
import WebKit
import UserNotifications

struct WebShellView: View {
    let url: URL
    @ObservedObject var model: ShellModel

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            WebViewRepresentable(url: url)
            // An enterprise build pinned to one host has no server to change to.
            if Branding.lockedHost == nil {
                Button {
                    model.changeServer()
                } label: {
                    Image(systemName: "gearshape")
                        .padding(10)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .accessibilityLabel("Change server")
                .padding(16)
                .opacity(0.6)
            }
        }
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // The bridge the SPA's nativeBridge.ts feature-detects — same minimal,
        // serialization-safe surface as the desktop preload, kind 'ios'.
        let bridge = """
        window.openwopNative = { kind: 'ios',
          setBadgeCount: n => webkit.messageHandlers.native.postMessage({ t: 'badge', n: Number(n) || 0 }),
          notify: p => (webkit.messageHandlers.native.postMessage({ t: 'notify',
            title: String((p && p.title) || ''), body: String((p && p.body) || ''),
            tag: (p && p.tag) ? String(p.tag) : undefined,
            navigatePath: (p && p.navigatePath) ? String(p.navigatePath) : undefined }), Promise.resolve(true)),
          onNotificationActivated: cb => { if (typeof cb === 'function') { window.__owpActivate = cb; }
            return () => { if (window.__owpActivate === cb) window.__owpActivate = null; }; } };
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(context.coordinator, name: "native")
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        context.coordinator.attach(web)
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}
    func makeCoordinator() -> Bridge { Bridge() }
}

/// The iOS analogue of the desktop `ipcMain` handlers: receives the bridge
/// messages and drives UNUserNotificationCenter + the app badge; routes a
/// notification tap back into the SPA via `window.__owpActivate(path)`.
final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate, UNUserNotificationCenterDelegate {
    private weak var webView: WKWebView?
    private var permissionRequested = false

    func attach(_ web: WKWebView) {
        webView = web
        UNUserNotificationCenter.current().delegate = self
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard m.name == "native", let body = m.body as? [String: Any], let t = body["t"] as? String else { return }
        switch t {
        case "badge":
            let n = max(0, (body["n"] as? NSNumber)?.intValue ?? 0)
            UNUserNotificationCenter.current().setBadgeCount(n)
        case "notify":
            requestPermissionIfNeeded()
            let content = UNMutableNotificationContent()
            content.title = body["title"] as? String ?? ""
            content.body = body["body"] as? String ?? ""
            if let path = body["navigatePath"] as? String { content.userInfo = ["navigatePath": path] }
            // Coalesce duplicates by tag (SSE reconnect racing REST) — the
            // desktop uses the Notification tag; here the request identifier.
            let id = (body["tag"] as? String) ?? UUID().uuidString
            let req = UNNotificationRequest(identifier: id, content: content, trigger: nil)
            UNUserNotificationCenter.current().add(req)
        default:
            break
        }
    }

    private func requestPermissionIfNeeded() {
        guard !permissionRequested else { return }
        permissionRequested = true
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    }

    // Notification tap → foreground the SPA path (parity with the desktop's
    // `native:notification-activated`).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let path = response.notification.request.content.userInfo["navigatePath"] as? String {
            let js = "if (window.__owpActivate) window.__owpActivate(\(jsString(path)));"
            DispatchQueue.main.async { self.webView?.evaluateJavaScript(js) }
        }
        completionHandler()
    }

    // Foreground presentation: show banners even while the app is frontmost
    // (the SPA suppresses the actively-viewed conversation itself).
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .badge, .sound])
    }

    // Self-test probe (see the file header).
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard ProcessInfo.processInfo.environment["OPENWOP_IOS_SELFTEST"] == "1" else { return }
        webView.evaluateJavaScript("window.openwopNative ? String(window.openwopNative.kind) : null") { value, _ in
            let kind = (value as? String) ?? "null"
            let host = webView.url?.absoluteString ?? "?"
            print("[selftest] {\"remoteBridge\":\"\(kind)\",\"url\":\"\(host)\"}")
        }
    }

    private func jsString(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        return "'\(escaped)'"
    }
}
