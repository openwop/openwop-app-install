// ADR 0291 — white-label branding for the iOS shell.
//
// PARITY with the desktop shell's `src/branding.js`: the shell brands only its
// pre-connection chrome (the setup screen); once connected, the UI is the host
// origin's own server-served SPA, which carries the VITE_BRAND_* white-label
// identity. The knobs live in Info.plist (authored in `project.yml` under
// `info.properties`, the OWP* keys) so an adopter re-brands without touching
// Swift. Anything missing/malformed falls back to the stock OpenWOP value.

import SwiftUI

enum Branding {
    private static func string(_ key: String) -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static var productName: String { string("OWPProductName") ?? "OpenWOP" }

    /// `demo` (stock: hosted-demo quick-connect shown) or `enterprise`
    /// (every demo affordance removed; `lockedHost` honored).
    static var isEnterprise: Bool { string("OWPMode") == "enterprise" }

    static var defaultHost: String {
        string("OWPDefaultHost").flatMap(HostSettings.parseHostOrigin) ?? "http://localhost:8000"
    }

    /// Demo quick-connect target; nil in enterprise mode (force-cleared, same
    /// rule as the desktop shell: a leftover config entry can't resurface it).
    static var demoHost: String? {
        guard !isEnterprise else { return nil }
        guard let configured = string("OWPDemoHost") else { return "https://app.openwop.dev" }
        return HostSettings.parseHostOrigin(configured)
    }

    /// Enterprise pinning: when set, the shell always loads this origin and
    /// the setup screen never shows.
    static var lockedHost: String? {
        string("OWPLockedHost").flatMap(HostSettings.parseHostOrigin)
    }

    /// Accent for the setup chrome (stock: the OpenWOP clay #b95c3a).
    static var accent: Color {
        parseHexColor(string("OWPAccentColor") ?? "") ?? Color(red: 0.725, green: 0.361, blue: 0.227)
    }

    /// #rgb / #rrggbb → Color; nil on anything else (falls back to clay).
    static func parseHexColor(_ input: String) -> Color? {
        var hex = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
        guard hex.count == 6, let value = UInt64(hex, radix: 16) else { return nil }
        return Color(
            red: Double((value >> 16) & 0xff) / 255.0,
            green: Double((value >> 8) & 0xff) / 255.0,
            blue: Double(value & 0xff) / 255.0
        )
    }
}
