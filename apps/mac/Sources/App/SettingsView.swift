import AppKit
import SwiftUI

struct SettingsView: View {
    let model: AppModel
    @AppStorage("showMenuBarIcon") private var showMenuBarIcon = true
    @State private var confirmingRemoval = false

    var body: some View {
        Form {
            Section("General") {
                Toggle("Open Draftbridge when I log in", isOn: Binding(
                    get: { model.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
                if let message = model.loginItemMessage {
                    Text(message).font(.caption).foregroundStyle(.orange)
                }
                Toggle("Show Draftbridge in the menu bar", isOn: $showMenuBarIcon)
                Text("The menu bar icon shows at a glance whether your AI apps are connected. If you turn it off, closing the window quits Draftbridge.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Connections") {
                LabeledContent("Check that everything works") {
                    Button {
                        Task { await model.testConnection() }
                    } label: {
                        HStack(spacing: 6) {
                            if model.isTesting { ProgressView().controlSize(.small) }
                            Text(model.isTesting ? "Testing..." : "Test connection")
                        }
                    }
                    .disabled(model.isTesting)
                }
                LabeledContent("Stop using Draftbridge") {
                    Button("Remove from all AI apps...", role: .destructive) { confirmingRemoval = true }
                        .disabled(model.connectedRows.isEmpty && !model.needsAttention)
                }
                Text("Removing deletes only the entry Draftbridge added to each app. Your manuscripts and the apps' other settings are not touched.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("About") {
                LabeledContent("Version", value: model.appVersion)
                LabeledContent("Support") {
                    Link("Report a problem", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/issues/new?labels=mac-app")!)
                }
                LabeledContent("Diagnostics") {
                    Button("Copy diagnostics") { model.copyDiagnostics() }
                }
                Text("Draftbridge is free software under the AGPL-3.0 license by WritersLogic, Inc. It is independent and is not affiliated with, endorsed by, or sponsored by Literature & Latte, the makers of Scrivener.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 480)
        .fixedSize(horizontal: false, vertical: true)
        .confirmationDialog("Remove Draftbridge from your AI apps?", isPresented: $confirmingRemoval) {
            Button("Remove", role: .destructive) { Task { await model.disconnectAll() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You can connect again at any time.")
        }
        .onAppear { model.refreshLaunchAtLogin() }
    }
}

enum AboutPanel {
    @MainActor static func show() {
        let credits = NSMutableAttributedString(
            string: "Let your AI assistant read, search and safely edit your Scrivener manuscripts.\n\nFree software under the AGPL-3.0 license by WritersLogic, Inc. Draftbridge is independent and is not affiliated with, endorsed by, or sponsored by Literature & Latte.",
            attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]
        )
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        credits.addAttribute(.paragraphStyle, value: style, range: NSRange(location: 0, length: credits.length))
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Draftbridge for Scrivener",
            .credits: credits,
        ])
        NSApp.activate(ignoringOtherApps: true)
    }
}
