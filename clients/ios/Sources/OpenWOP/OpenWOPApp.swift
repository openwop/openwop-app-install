// ADR 0181 Phase D — the iOS shell entry point. Same single-bundle rule as the
// desktop shell: the app ships only native setup chrome; the UI is the host
// origin's own server-served SPA.

import SwiftUI

@main
struct OpenWOPApp: App {
    @StateObject private var model = ShellModel()

    var body: some Scene {
        WindowGroup {
            if let host = model.host, let url = URL(string: host) {
                WebShellView(url: url, model: model)
                    .ignoresSafeArea(edges: .bottom)
            } else {
                SetupView(model: model)
            }
        }
    }
}

/// App-wide state: the active host origin (nil ⇒ show setup).
final class ShellModel: ObservableObject {
    @Published var host: String?

    init() {
        // Enterprise pinning (ADR 0291): lockedHost beats the saved host, so a
        // stale UserDefaults entry can never unpin an enterprise build.
        host = Branding.lockedHost ?? HostSettings.host
    }

    /// Validate + persist + activate a host. Returns false when invalid.
    @discardableResult
    func connect(_ input: String) -> Bool {
        guard let origin = HostSettings.selectHost(input) else { return false }
        host = origin
        return true
    }

    func changeServer() {
        HostSettings.clearHost()
        // A pinned enterprise build has no server to change to — stay pinned.
        host = Branding.lockedHost
    }
}
