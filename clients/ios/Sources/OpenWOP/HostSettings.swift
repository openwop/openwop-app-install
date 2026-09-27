// ADR 0181 Phase D — host-origin validation + persistence, PARITY with the
// desktop shell's pure logic (`clients/desktop/src/url.js` / `settings.js`):
// http(s) only, schemeless host:port coerced to http, trailing slash stripped,
// recent list deduped + capped at 8. Persisted in UserDefaults (the iOS
// analogue of the desktop's userData settings.json).

import Foundation

enum HostSettings {
    private static let hostKey = "openwop.host"
    private static let recentKey = "openwop.recentHosts"
    private static let maxRecent = 8

    /// Mirror of `url.js parseHostOrigin`: returns the normalized origin or nil.
    static func parseHostOrigin(_ input: String) -> String? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        let hasScheme = raw.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*://"#, options: .regularExpression) != nil
        let withScheme = hasScheme ? raw : "http://\(raw)"
        guard let url = URL(string: withScheme),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        var origin = "\(scheme)://\(host)"
        if let port = url.port { origin += ":\(port)" }
        return origin
    }

    static var host: String? {
        get { UserDefaults.standard.string(forKey: hostKey) }
    }

    static var recent: [String] {
        UserDefaults.standard.stringArray(forKey: recentKey) ?? []
    }

    /// Mirror of `settings.js selectHost`: validate, persist, front the recents.
    @discardableResult
    static func selectHost(_ input: String) -> String? {
        guard let origin = parseHostOrigin(input) else { return nil }
        var list = recent.filter { $0 != origin }
        list.insert(origin, at: 0)
        UserDefaults.standard.set(origin, forKey: hostKey)
        UserDefaults.standard.set(Array(list.prefix(maxRecent)), forKey: recentKey)
        return origin
    }

    static func clearHost() {
        UserDefaults.standard.removeObject(forKey: hostKey)
    }
}
