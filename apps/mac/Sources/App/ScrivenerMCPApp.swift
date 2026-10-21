import AppKit
import ScrivenerMCPCore
import SwiftUI

@main
struct Launcher {
    static func main() {
        let args = CommandLine.arguments
        if let index = args.firstIndex(of: "--render-previews"), index + 1 < args.count {
            MainActor.assumeIsolated { PreviewRenderer.renderScreens(to: args[index + 1]) }
            return
        }
        if let index = args.firstIndex(of: "--render-icon"), index + 1 < args.count {
            MainActor.assumeIsolated { PreviewRenderer.renderIconSet(to: args[index + 1]) }
            return
        }
        ScrivenerMCPApp.main()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// With no menu bar icon there would be no way back to a closed window, so quit with it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        !UserDefaults.standard.bool(forKey: "showMenuBarIcon", default: true)
    }
}

private extension UserDefaults {
    func bool(forKey key: String, default fallback: Bool) -> Bool {
        object(forKey: key) == nil ? fallback : bool(forKey: key)
    }
}

struct ScrivenerMCPApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel()
    @AppStorage("showMenuBarIcon") private var showMenuBarIcon = true

    var body: some Scene {
        Window("Draftbridge for Scrivener", id: "main") {
            ContentView(model: model)
                .task { await model.bootstrap() }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    Task { await model.refresh() }
                }
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in
                    model.refreshRunning()
                }
                .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in
                    model.refreshRunning()
                }
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 640, height: 780)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("About Draftbridge") { AboutPanel.show() }
            }
            CommandGroup(replacing: .help) {
                Link("Draftbridge Help", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/blob/main/docs/install-mac.md")!)
                Button("Copy Diagnostics") { model.copyDiagnostics() }
                Link("Report a Problem", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/issues/new?labels=mac-app")!)
            }
            CommandGroup(after: .newItem) {
                Button("Check Connections") { Task { await model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }

        Settings {
            SettingsView(model: model)
        }

        MenuBarExtra("Draftbridge", systemImage: model.menuSymbol, isInserted: $showMenuBarIcon) {
            MenuBarContent(model: model)
        }
        .menuBarExtraStyle(.menu)
    }
}

struct MenuBarContent: View {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(summary)
        if !model.rows.isEmpty {
            Divider()
            ForEach(model.rows) { row in
                Label(row.name + suffix(for: row.state), systemImage: symbol(for: row.state))
            }
        }
        Divider()
        Button("Open Draftbridge") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        if model.scrivener.isInstalled {
            Button("Open Scrivener") { model.openScrivener() }
        }
        Button("Check Connections") { Task { await model.refresh() } }
        SettingsLink { Text("Settings...") }
        Divider()
        Button("Quit Draftbridge") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }

    private var summary: String {
        switch model.stage {
        case .ready: "Connected to your AI apps"
        case .needsAttention: "Needs attention"
        case .connectFirst: "Not connected yet"
        case .noApps: "No AI apps found"
        }
    }

    private func suffix(for state: ConnectionState) -> String {
        switch state {
        case .connected: ""
        case .needsRepair: ", needs update"
        case .notConnected: ", not connected"
        case .manual: ", set up in app"
        case .problem: ", problem"
        }
    }

    private func symbol(for state: ConnectionState) -> String {
        switch state {
        case .connected: "checkmark.circle.fill"
        case .needsRepair: "exclamationmark.circle.fill"
        case .notConnected: "circle"
        case .manual: "arrow.up.forward.app"
        case .problem: "xmark.octagon.fill"
        }
    }
}
