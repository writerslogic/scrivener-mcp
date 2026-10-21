import AppKit
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

struct ScrivenerMCPApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        Window("Marginalia for Scrivener", id: "main") {
            ContentView(model: model)
                .task { await model.bootstrap() }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    Task { await model.refresh() }
                }
        }
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .help) {
                Link("Marginalia Help", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/blob/main/docs/install-mac.md")!)
                Button("Copy Diagnostics") { model.copyDiagnostics() }
            }
        }

        MenuBarExtra("Marginalia", systemImage: model.menuSymbol) {
            MenuBarContent(model: model)
        }
        .menuBarExtraStyle(.menu)
    }
}

struct MenuBarContent: View {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(model.allHealthy ? "Everything is connected" : "Not fully connected")
        Divider()
        Button("Open Marginalia") {
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Check connections") { Task { await model.refresh() } }
        Divider()
        Button("Quit") { NSApp.terminate(nil) }.keyboardShortcut("q")
    }
}
