// ADR 0181 Phase D — the native "connect to host" screen: UX parity with the
// desktop `setup/index.html` (localhost prefill, hosted-demo quick action,
// persisted recent hosts). White-labeled via Branding (ADR 0291): product
// name, accent, default host, and the demo quick-connect (demo posture only).

import SwiftUI

struct SetupView: View {
    @ObservedObject var model: ShellModel
    @State private var input = Branding.defaultHost
    @State private var error: String?
    private let accent = Branding.accent

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Spacer()
            HStack(spacing: 10) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(accent)
                Text(Branding.productName).font(.headline)
            }
            .padding(.bottom, 18)

            Text("Connect to your \(Branding.productName) host")
                .font(.title3).bold()
                .padding(.bottom, 2)
            Text("Enter the URL of a running \(Branding.productName) server. The app loads that host's own interface.")
                .foregroundStyle(.secondary)
                .padding(.bottom, 20)

            Text("Host URL").font(.caption).padding(.bottom, 4)
            TextField(Branding.defaultHost, text: $input)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit(connect)

            Button(action: connect) {
                Text("Connect").bold().frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(accent)
            .padding(.top, 12)

            if let demoHost = Branding.demoHost {
                Button {
                    input = demoHost
                    connect()
                } label: {
                    Text("Use the hosted demo (\(URL(string: demoHost)?.host ?? demoHost))")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .padding(.top, 8)
            }

            if let error {
                Text(error).font(.footnote).foregroundStyle(.red).padding(.top, 8)
            }

            if !HostSettings.recent.isEmpty {
                Text("RECENT HOSTS")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.top, 20).padding(.bottom, 4)
                ForEach(HostSettings.recent.prefix(8), id: \.self) { h in
                    Button {
                        input = h
                        connect()
                    } label: {
                        Text(h).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .padding(.bottom, 4)
                }
            }
            Spacer()
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: 460)
    }

    private func connect() {
        error = nil
        if !model.connect(input) {
            error = "That does not look like a valid http(s) host URL."
        }
    }
}
