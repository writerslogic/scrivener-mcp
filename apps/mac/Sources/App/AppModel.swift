import AppKit
import Observation
import ScrivenerMCPCore
import ServiceManagement

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
}

/// What is known about the Scrivener app itself.
struct ScrivenerInfo: Equatable {
    static let bundleIdentifier = "com.literatureandlatte.scrivener3"

    var appURL: URL?
    var version: String?
    var isRunning = false

    var isInstalled: Bool { appURL != nil }

    static func current() -> ScrivenerInfo {
        let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleIdentifier)
        let version = url.flatMap { Bundle(url: $0)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String }
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty
        return ScrivenerInfo(appURL: url, version: version, isRunning: running)
    }
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
    var projects: [ProjectInfo] = []
    var isFindingProjects = false
    var hasSearchedProjects = false
    var scrivener = ScrivenerInfo()
    var update: ReleaseInfo?
    /// An app that was connected while running and has not been restarted since.
    var pendingRestartID: String?
    var launchAtLogin = false
    var loginItemMessage: String?
    private(set) var report: SetupReport?

    private var runner: SetupRunner?
    private var location: ServerLocation?

    var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    var stage: SetupStage {
        SetupStage.stage(for: rows.map { ($0.id, $0.state) })
    }

    var allHealthy: Bool {
        let relevant = rows.filter { $0.state != .manual }
        return !relevant.isEmpty && relevant.allSatisfy { $0.state.isHealthy }
    }

    var needsAttention: Bool { stage == .needsAttention }

    var connectedRows: [AppRow] { rows.filter { $0.state == .connected } }

    /// The app to feature on the first-run screen.
    var recommendedRow: AppRow? {
        guard case .connectFirst(let id) = stage else { return nil }
        return rows.first { $0.id == id }
    }

    var pendingRestartRow: AppRow? {
        rows.first { $0.id == pendingRestartID && $0.isRunning }
    }

    var menuSymbol: String {
        switch stage {
        case .ready: "books.vertical.fill"
        case .needsAttention: "exclamationmark.triangle.fill"
        default: "books.vertical"
        }
    }

    // MARK: Lifecycle

    func bootstrap() async {
        refreshRunning()
        refreshLaunchAtLogin()
        do {
            let location = try ServerLocator.locate()
            self.location = location
            runner = SetupRunner(location: location)
            await refresh()
            Task { await findProjects() }
            if appVersion != "dev" {
                Task { update = await UpdateChecker.latestRelease().flatMap { UpdateChecker.isNewer($0.version, than: appVersion) ? $0 : nil } }
            }
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

    /// Cheap refresh of which apps are running. Does not run the helper.
    func refreshRunning() {
        scrivener = ScrivenerInfo.current()
        let running = Self.runningAppURLs()
        for index in rows.indices {
            rows[index].isRunning = rows[index].appURL.map { running.contains($0.standardizedFileURL) } ?? false
        }
        if pendingRestartID != nil, pendingRestartRow == nil { pendingRestartID = nil }
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
        await act(on: [id]) { runner in
            try await runner.run(.connect(clientIDs: [id], verify: false))
        } done: { [self] report in
            guard let client = report.clients?.first else { return }
            let state = ConnectionState(client: client)
            let row = rows.first { $0.id == id }
            if case .problem(let message) = state {
                notice = Notice(kind: .error, text: message)
            } else if id == "raycast" {
                notice = Notice(kind: .info, text: "Confirm the Install Server dialog in Raycast to finish.")
            } else if row?.isRunning == true {
                pendingRestartID = id
                notice = nil
            } else {
                notice = Notice(kind: .success, text: "Connected to \(client.name). \(row?.restartHint ?? "Open it to start asking.")")
            }
        }
    }

    func connectAll() async {
        let ids = rows.filter { $0.state == .notConnected || $0.state == .needsRepair }.map(\.id)
        guard !ids.isEmpty else { return }
        await act(on: ids) { runner in
            try await runner.run(.connect(clientIDs: ids, verify: false))
        } done: { [self] report in
            let failures = report.clients?.filter { ConnectionState(client: $0) != .connected } ?? []
            let running = rows.filter { ids.contains($0.id) && $0.isRunning && $0.id != "raycast" }
            if failures.isEmpty {
                pendingRestartID = running.first?.id
                notice = running.count > 1
                    ? Notice(kind: .success, text: "All set. Restart \(running.map(\.name).joined(separator: ", ")) to finish.")
                    : running.isEmpty ? Notice(kind: .success, text: "All set.") : nil
            } else {
                notice = Notice(kind: .error, text: failures.compactMap(\.message).first ?? "Some apps could not be connected.")
            }
        }
    }

    /// Repairs apps that are broken or out of date. Apps the person has not connected are left alone.
    func repairAll() async {
        let ids = rows.filter {
            if case .problem = $0.state { return true }
            return $0.state == .needsRepair
        }.map(\.id)
        guard !ids.isEmpty else { return }
        await act(on: ids) { runner in
            try await runner.run(.connect(clientIDs: ids, verify: false))
        } done: { [self] report in
            let failures = report.clients?.filter { ConnectionState(client: $0) != .connected } ?? []
            if let message = failures.compactMap(\.message).first {
                notice = Notice(kind: .error, text: message)
            } else if let running = rows.first(where: { ids.contains($0.id) && $0.isRunning && $0.id != "raycast" }) {
                pendingRestartID = running.id
            } else {
                notice = Notice(kind: .success, text: "Fixed.")
            }
        }
    }

    func disconnect(_ id: String) async {
        await act(on: [id]) { runner in
            try await runner.run(.disconnect(clientIDs: [id]))
        } done: { [self] _ in
            if pendingRestartID == id { pendingRestartID = nil }
            notice = Notice(kind: .info, text: "Disconnected. Your other settings were not changed.")
        }
    }

    func disconnectAll() async {
        let ids = rows.filter { $0.state == .connected || $0.state == .needsRepair }.map(\.id)
        guard !ids.isEmpty else { return }
        await act(on: ids) { runner in
            try await runner.run(.disconnect(clientIDs: ids))
        } done: { [self] _ in
            pendingRestartID = nil
            notice = Notice(kind: .info, text: "Draftbridge was removed from your AI apps.")
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
        pendingRestartID = nil
        notice = nil
        await refresh()
    }

    func open(_ id: String) {
        guard let url = rows.first(where: { $0.id == id })?.appURL else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    func openScrivener() {
        guard let url = scrivener.appURL else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    func findProjects() async {
        guard !isFindingProjects else { return }
        isFindingProjects = true
        defer { isFindingProjects = false; hasSearchedProjects = true }
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

    // MARK: Login item

    func refreshLaunchAtLogin() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        loginItemMessage = nil
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            loginItemMessage = "macOS would not change this setting. Move Draftbridge to your Applications folder and try again."
        }
        refreshLaunchAtLogin()
    }

    // MARK: Internals

    private func act(
        on ids: [String],
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
        let running = Self.runningAppURLs()
        scrivener = ScrivenerInfo.current()
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
        if pendingRestartID != nil, pendingRestartRow == nil { pendingRestartID = nil }
    }

    private static func runningAppURLs() -> Set<URL> {
        Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleURL?.standardizedFileURL })
    }

    nonisolated private static func spotlightProjects() -> [ProjectInfo] {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        // No content-type clause: a .scriv bundle is not typed public.folder, so that clause matches nothing.
        process.arguments = ["kMDItemFSName == '*.scriv'c"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let found = String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .map(String.init)
            .filter(ProjectInfo.isUsableProjectPath)
            .filter { var isDirectory: ObjCBool = false; return FileManager.default.fileExists(atPath: $0, isDirectory: &isDirectory) && isDirectory.boolValue }
            .map { ProjectInfo(url: URL(fileURLWithPath: $0), modified: lastEdited(URL(fileURLWithPath: $0))) }
        return Array(ProjectInfo.sortedByRecency(found).prefix(50))
    }

    /// A project folder's own date barely changes; the project file inside it changes on every save.
    nonisolated private static func lastEdited(_ project: URL) -> Date? {
        let fm = FileManager.default
        let inside = (try? fm.contentsOfDirectory(at: project, includingPropertiesForKeys: nil)) ?? []
        let candidate = inside.first { $0.pathExtension == "scrivx" } ?? project
        return (try? candidate.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }
}

extension AppModel {
    /// A model with fixed content for previews and screenshots. It never runs the helper.
    static func sample(_ kind: SampleKind) -> AppModel {
        let model = AppModel()
        model.phase = .ready
        model.hasSearchedProjects = true
        func row(_ id: String, _ state: ConnectionState, running: Bool = false) -> AppRow {
            let info = ClientCatalog.info(for: id)!
            let name = ["claude-desktop": "Claude Desktop", "cursor": "Cursor", "vscode": "VS Code",
                        "boltai": "BoltAI", "raycast": "Raycast", "lm-studio": "LM Studio",
                        "claude-code": "Claude Code"][id] ?? id
            return AppRow(id: id, name: name, symbol: info.symbol, appURL: nil,
                          restartHint: info.restartHint, state: state, isRunning: running)
        }
        let now = Date()
        let sampleProjects = [
            ProjectInfo(url: URL(fileURLWithPath: "/Users/you/Documents/The Salt Road.scriv"), modified: now.addingTimeInterval(-3 * 3600)),
            ProjectInfo(url: URL(fileURLWithPath: "/Users/you/Documents/Short Stories.scriv"), modified: now.addingTimeInterval(-4 * 86400)),
            ProjectInfo(url: URL(fileURLWithPath: "/Users/you/Documents/Screenplay Draft.scriv"), modified: now.addingTimeInterval(-40 * 86400)),
        ]
        let installed = ScrivenerInfo(appURL: URL(fileURLWithPath: "/Applications/Scrivener.app"), version: "3.4", isRunning: false)
        switch kind {
        case .allConnected:
            model.rows = [row("claude-desktop", .connected, running: true), row("boltai", .connected), row("raycast", .manual)]
            model.projects = sampleProjects
            model.scrivener = installed
            model.notice = Notice(kind: .success, text: "The server starts correctly and offers 15 tools.")
        case .firstRun:
            model.rows = [row("claude-desktop", .notConnected, running: true), row("cursor", .notConnected), row("raycast", .manual)]
            model.projects = sampleProjects
            model.scrivener = installed
        case .restart:
            model.rows = [row("claude-desktop", .connected, running: true), row("raycast", .manual)]
            model.pendingRestartID = "claude-desktop"
            model.projects = sampleProjects
            model.scrivener = ScrivenerInfo(appURL: installed.appURL, version: "3.4", isRunning: true)
        case .mixed:
            model.rows = [
                row("claude-desktop", .notConnected, running: true), row("boltai", .needsRepair),
                row("cursor", .problem("The settings file is not valid JSON, so it was left untouched.")),
                row("raycast", .manual),
            ]
            model.scrivener = installed
        case .noScrivener:
            model.rows = [row("claude-desktop", .connected)]
        case .empty:
            model.rows = []
            model.scrivener = installed
        case .failed:
            model.phase = .failed("The bundled Draftbridge server could not be found.")
        }
        return model
    }

    enum SampleKind: CaseIterable { case allConnected, firstRun, restart, mixed, noScrivener, empty, failed }
}
