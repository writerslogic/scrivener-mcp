import Foundation

/// Where the bundled Node runtime and server live.
public struct ServerLocation: Sendable, Equatable {
    public let node: URL
    public let script: URL
    public let setupScript: URL

    public init(node: URL, script: URL, setupScript: URL) {
        self.node = node
        self.script = script
        self.setupScript = setupScript
    }
}

public enum ServerLocator {
    /// Looks inside the app bundle first. For development, `SCRIVENER_MCP_DEV_ROOT` points at a
    /// built checkout of the repository and `SCRIVENER_MCP_DEV_NODE` at a Node binary.
    public static func locate(
        resourceURL: URL? = Bundle.main.resourceURL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileExists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) || FileManager.default.fileExists(atPath: $0) }
    ) throws -> ServerLocation {
        if let root = environment["SCRIVENER_MCP_DEV_ROOT"] {
            let rootURL = URL(fileURLWithPath: root)
            let node = URL(fileURLWithPath: environment["SCRIVENER_MCP_DEV_NODE"] ?? "/opt/homebrew/bin/node")
            return try validated(
                ServerLocation(
                    node: node,
                    script: rootURL.appendingPathComponent("dist/index.js"),
                    setupScript: rootURL.appendingPathComponent("dist/cli/setup.js")
                ),
                fileExists: fileExists
            )
        }
        guard let resources = resourceURL else {
            throw SetupError.serverNotFound("The app has no resources folder.")
        }
        return try validated(
            ServerLocation(
                node: resources.appendingPathComponent("runtime/bin/node"),
                script: resources.appendingPathComponent("server/dist/index.js"),
                setupScript: resources.appendingPathComponent("server/dist/cli/setup.js")
            ),
            fileExists: fileExists
        )
    }

    private static func validated(
        _ location: ServerLocation, fileExists: (String) -> Bool
    ) throws -> ServerLocation {
        for url in [location.node, location.script, location.setupScript]
        where !fileExists(url.path) {
            throw SetupError.serverNotFound("Missing \(url.lastPathComponent) at \(url.path).")
        }
        return location
    }
}
