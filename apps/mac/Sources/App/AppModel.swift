import AppKit
import Observation
import ScrivenerMCPCore

struct AppRow: Identifiable, Equatable {
    let id: String
    let name: String
    let symbol: String
    let appURL: URL?
    let restartHint: String
    var state: ConnectionState
    var busy = false
    var isRunning = false
}

struct Notice: Equatable {
    enum Kind { case success, info, error }
    let kind: Kind
    let text: String
    var restartRowID: String?
}

@MainActor
@Observable
final class AppModel {
    enum Phase: Equatable { case loading, ready, failed(String) }

    var phase: Phase = .loading
    var rows: [AppRow] = []
    var startup: SetupReport.Startup?
    var isTesting = false
    var notice: Notice?
    var projects: [URL] = []
    var isFindingProjects = false
    var update: ReleaseInfo?
    private(set) var report: SetupReport?

    private var runner: SetupRunner?
    private var location: ServerLocation?

    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var allHealthy: Bool {
        let relevant = rows.filter { $0.state != .manual }
        return !relevant.isEmpty && relevant.allSatisfy { $0.state.isHealthy }
    }

    var needsAttention: Bool {
        rows.contains { $0.state == .needsRepair || { if case .problem = $0.state { true } else { false } }($0) }
    }

    var menuSymbol: String {
        allHealthy ? "books.vertical.fill" : "books.vertical"
    }

    // MARK: Lifecycle

    func bootstrap() async {
        do {
            let location = try ServerLocator.locate()
            self.location = location
            runner = SetupRunner(location: location)
            await refresh()
            Task { update = await UpdateChecker.latestRelease().flatMap { UpdateChecker.isNewer($0.version, than: appVersion) ? $0 : nil } }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func refresh() async {
        guard let runner else { return }
        do {
            apply(try await runner.run(.check(verify: false)))
            phase = .ready
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    // MARK: Actions

    func testConnection() async {
        guard let runner, !isTesting else { return }
        isTesting = true
        defer { isTesting = false }
        do {
            let report = try await runner.run(.check(verify: true), timeout: 180)
            apply(report)
            startup = report.startup
            if let startup = report.startup {
                notice = startup.ok
                    ? Notice(kind: .success, text: "The server starts correctly and offers \(startup.toolCount ?? 0) tools.")
                    : Notice(kind: .error, text: "The server did not start: \(startup.error ?? "unknown error")")
            }
        } catch {
            notice = Notice(kind: .error, text: error.localizedDescription)
        }
    }

    func connect(_ id: String) async {
        await act(on: [id], busyText: "connect") { runner in
            try await runner.run(.connect(clientIDs: [id], verify: false))
        } done: { [self] report in
            guard let client = report.clients?.first else { return }
            let state = ConnectionState(client: client)
            if case .problem(let message) = state {
                notice = Notice(kind: .error, text: message)
            } else if id == "raycast" {
                notice = Notice(kind: .info, text: "Confirm the Install Server dialog in Raycast to finish.")
            } else {
                let row = rows.first { $0.id == id }
                notice = Notice(
                    kind: .success,
                    text: "Connected to \(client.name). \(row?.restartHint ?? "Restart it to finish.")",
                    restartRowID: row?.isRunning == true ? id : nil
                )
            }
        }
    }

    func connectAll() async {
        let ids = rows.filter { $0.state == .notConnected || $0.state == .needsRepair }.map(\.id)
        guard !ids.isEmpty else { return }
        await act(on: ids, busyText: "connect") { runner in
            try await runner.run(.connect(clientIDs: ids, verify: false))
        } done: { [self] report in
            let failures = report.clients?.filter { ConnectionState(client: $0) != .connected } ?? []
            let running = rows.filter { ids.contains($0.id) && $0.isRunning }
            notice = failures.isEmpty
                ? Notice(kind: .success, text: running.isEmpty ? "All set." : "All set. Restart \(running.map(\.name).joined(separator: ", ")) to finish.")
                : Notice(kind: .error, text: failures.compactMap(\.message).first ?? "Some apps could not be connected.")
        }
    }

    func disconnect(_ id: String) async {
        await act(on: [id], busyText: "disconnect") { runner in
            try await runner.run(.disconnect(clientIDs: [id]))
        } done: { [self] _ in
            notice = Notice(kind: .info, text: "Disconnected. Your other settings were not changed.")
        }
    }

    func restart(_ id: String) async {
        guard let url = rows.first(where: { $0.id == id })?.appURL else { return }
        let running = NSWorkspace.shared.runningApplications.filter {
            $0.bundleURL?.standardizedFileURL == url.standardizedFileURL
        }
        running.forEach { $0.terminate() }
        for _ in 0..<50 where !running.allSatisfy(\.isTerminated) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
        notice = nil
        await refresh()
    }

    func findProjects() async {
        isFindingProjects = true
        defer { isFindingProjects = false }
        projects = await Task.detached { Self.spotlightProjects() }.value
    }

    func copyDiagnostics() {
        let text = Diagnostics.summary(
            appVersion: appVersion,
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            report: report,
            location: location
        )
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        notice = Notice(kind: .info, text: "Diagnostics copied. Paste them into your support request.")
    }

    // MARK: Internals

    private func act(
        on ids: [String], busyText: String,
        _ work: (SetupRunner) async throws -> SetupReport,
        done: (SetupReport) -> Void
    ) async {
        guard let runner else { return }
        setBusy(ids, true)
        defer { setBusy(ids, false) }
        do {
            let report = try await work(runner)
            await refresh()
            done(report)
        } catch {
            notice = Notice(kind: .error, text: error.localizedDescription)
        }
    }

    private func setBusy(_ ids: [String], _ busy: Bool) {
        for index in rows.indices where ids.contains(rows[index].id) { rows[index].busy = busy }
    }

    private func apply(_ report: SetupReport) {
        self.report = report
        let running = NSWorkspace.shared.runningApplications.compactMap { $0.bundleURL?.standardizedFileURL }
        rows = (report.clients ?? []).compactMap { client in
            guard let info = ClientCatalog.info(for: client.id) else { return nil }
            let url = ClientCatalog.appURL(for: info)
            let previousBusy = rows.first { $0.id == client.id }?.busy ?? false
            return AppRow(
                id: client.id, name: client.name, symbol: info.symbol, appURL: url,
                restartHint: info.restartHint, state: ConnectionState(client: client),
                busy: previousBusy,
                isRunning: url.map { running.contains($0.standardizedFileURL) } ?? false
            )
        }
    }

    nonisolated private static func spotlightProjects() -> [URL] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = ["kMDItemFSName == '*.scriv'c && kMDItemContentTypeTree == 'public.folder'"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map { URL(fileURLWithPath: String($0)) }
            .filter { $0.pathExtension == "scriv" && !$0.path.contains("/.Trash/") && !$0.path.contains("/Backups/") }
            .prefix(12)
            .map { $0 }
    }
}

extension AppModel {
    /// A model with fixed content for previews and screenshots. It never runs the helper.
    static func sample(_ kind: SampleKind) -> AppModel {
        let model = AppModel()
        model.phase = .ready
        func row(_ id: String, _ state: ConnectionState, running: Bool = false) -> AppRow {
            let info = ClientCatalog.info(for: id)!
            let name = ["claude-desktop": "Claude Desktop", "cursor": "Cursor", "vscode": "VS Code",
                        "boltai": "BoltAI", "raycast": "Raycast", "lm-studio": "LM Studio",
                        "claude-code": "Claude Code"][id] ?? id
            return AppRow(id: id, name: name, symbol: info.symbol, appURL: nil,
                          restartHint: info.restartHint, state: state, isRunning: running)
        }
        switch kind {
        case .allConnected:
            model.rows = [row("claude-desktop", .connected), row("boltai", .connected), row("raycast", .manual)]
            model.notice = Notice(kind: .success, text: "The server starts correctly and offers 15 tools.")
        case .mixed:
            model.rows = [
                row("claude-desktop", .notConnected, running: true), row("boltai", .needsRepair),
                row("cursor", .problem("The settings file is not valid JSON, so it was left untouched.")),
                row("raycast", .manual),
            ]
        case .empty:
            model.rows = []
        case .failed:
            model.phase = .failed("The bundled Scrivener MCP server could not be found.")
        }
        return model
    }

    enum SampleKind { case allConnected, mixed, empty, failed }
}
