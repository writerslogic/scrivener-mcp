import Foundation
import Testing
@testable import ScrivenerMCPCore

@Suite struct SetupReportTests {
    let sample = """
    {"schemaVersion":1,"mode":"check","ok":false,
     "runtime":{"node":"/n/bin/node","npx":null,"version":"v22.1.0","major":22,"source":"explicit"},
     "clients":[
       {"id":"claude-desktop","name":"Claude Desktop","configPath":"/c.json","status":"configured"},
       {"id":"cursor","name":"Cursor","configPath":"/m.json","status":"outdated"},
       {"id":"boltai","name":"BoltAI","configPath":"/b.json","status":"unreadable","message":"bad json"},
       {"id":"raycast","name":"Raycast","configPath":null,"status":"link"}],
     "startup":{"ok":true,"serverName":"scrivener-mcp","serverVersion":"0.12.0","toolCount":15,"ms":900}}
    """

    @Test func decodesTheCliContract() throws {
        let report = try SetupReport.decode(Data(sample.utf8))
        #expect(report.clients?.count == 4)
        #expect(report.startup?.toolCount == 15)
        #expect(report.runtime?.major == 22)
    }

    @Test func mapsStatusesToStates() throws {
        let clients = try #require(SetupReport.decode(Data(sample.utf8)).clients)
        let states = clients.map(ConnectionState.init(client:))
        #expect(states[0] == .connected)
        #expect(states[1] == .needsRepair)
        #expect(states[2] == .problem("bad json"))
        #expect(states[3] == .manual)
    }

    @Test func mapsOutcomesAfterActions() {
        #expect(ConnectionState(client: .init(id: "a", name: "A", outcome: "added")) == .connected)
        #expect(ConnectionState(client: .init(id: "a", name: "A", outcome: "repaired")) == .connected)
        #expect(ConnectionState(client: .init(id: "a", name: "A", outcome: "removed")) == .notConnected)
        #expect(ConnectionState(client: .init(id: "a", name: "A", outcome: "failed", message: "x")) == .problem("x"))
    }

    @Test func rejectsAnUnknownSchemaVersion() {
        let json = #"{"schemaVersion":2,"mode":"check","ok":true}"#
        #expect(throws: SetupError.unsupportedSchema(2)) {
            try SetupReport.decode(Data(json.utf8))
        }
    }
}

@Suite struct LocatorTests {
    @Test func findsTheBundledLayout() throws {
        let resources = URL(fileURLWithPath: "/App/Contents/Resources")
        let location = try ServerLocator.locate(resourceURL: resources, environment: [:], fileExists: { _ in true })
        #expect(location.node.path == "/App/Contents/Resources/runtime/bin/node")
        #expect(location.setupScript.path == "/App/Contents/Resources/server/dist/cli/setup.js")
    }

    @Test func reportsWhichFileIsMissing() {
        let resources = URL(fileURLWithPath: "/App/Contents/Resources")
        #expect(throws: SetupError.self) {
            try ServerLocator.locate(resourceURL: resources, environment: [:], fileExists: { !$0.hasSuffix("setup.js") })
        }
    }

    @Test func honoursTheDevelopmentOverride() throws {
        let env = ["SCRIVENER_MCP_DEV_ROOT": "/repo", "SCRIVENER_MCP_DEV_NODE": "/usr/local/bin/node"]
        let location = try ServerLocator.locate(resourceURL: nil, environment: env, fileExists: { _ in true })
        #expect(location.node.path == "/usr/local/bin/node")
        #expect(location.script.path == "/repo/dist/index.js")
    }
}

@Suite struct RunnerTests {
    let location = ServerLocation(
        node: URL(fileURLWithPath: "/r/node"), script: URL(fileURLWithPath: "/s/index.js"),
        setupScript: URL(fileURLWithPath: "/s/cli/setup.js"))

    @Test func buildsConnectArguments() {
        let args = SetupRunner(location: location).arguments(for: .connect(clientIDs: ["cursor", "boltai"], verify: false))
        #expect(args.contains("--json") && args.contains("--yes"))
        #expect(args.contains("--no-verify"))
        #expect(Array(args.suffix(5)) == ["--client", "cursor", "--client", "boltai", "--no-verify"])
        #expect(args.starts(with: ["/s/cli/setup.js"]))
    }

    @Test func buildsDisconnectArguments() {
        let args = SetupRunner(location: location).arguments(for: .disconnect(clientIDs: ["vscode"]))
        #expect(args.contains("--remove"))
        #expect(!args.contains("--check"))
    }

    @Test func aMissingNodeIsALaunchFailure() async {
        let runner = SetupRunner(location: location)
        await #expect(throws: SetupError.self) {
            try await runner.run(.check(verify: false), timeout: 5)
        }
    }
}

@Suite struct CatalogTests {
    @Test func everySetupClientHasDisplayInfo() {
        let ids = ["claude-desktop", "claude-code", "cursor", "vscode", "lm-studio", "boltai", "raycast"]
        for id in ids { #expect(ClientCatalog.info(for: id) != nil) }
    }

    @Test func prefersTheSystemApplicationsFolder() {
        let info = ClientCatalog.info(for: "cursor")!
        let url = ClientCatalog.appURL(for: info, home: URL(fileURLWithPath: "/Users/u"), exists: { _ in true })
        #expect(url?.path == "/Applications/Cursor.app")
    }
}

@Suite struct DiagnosticsTests {
    @Test func listsEachAppAndTheStartupResult() throws {
        let report = try SetupReport.decode(Data(
            #"{"schemaVersion":1,"mode":"check","ok":true,"clients":[{"id":"cursor","name":"Cursor","status":"configured"}],"startup":{"ok":false,"error":"boom","ms":5}}"#.utf8))
        let text = Diagnostics.summary(appVersion: "1.0", macOS: "27.0", report: report, location: nil)
        #expect(text.contains("Cursor: configured"))
        #expect(text.contains("FAILED - boom"))
    }
}

@Suite struct UpdateTests {
    @Test func comparesDottedVersions() {
        #expect(UpdateChecker.isNewer("v1.2.0", than: "1.1.9"))
        #expect(UpdateChecker.isNewer("1.10", than: "1.9.3"))
        #expect(!UpdateChecker.isNewer("1.0.0", than: "1.0"))
        #expect(!UpdateChecker.isNewer("0.9", than: "1.0"))
    }

    @Test func parsesTheLatestRelease() async {
        let body = #"{"tag_name":"v2.0.0","html_url":"https://github.com/writerslogic/scrivener-mcp/releases/tag/v2.0.0"}"#
        let info = await UpdateChecker.latestRelease(fetch: { _ in Data(body.utf8) })
        #expect(info?.version == "v2.0.0")
        let none = await UpdateChecker.latestRelease(fetch: { _ in throw URLError(.notConnectedToInternet) })
        #expect(none == nil)
    }
}
