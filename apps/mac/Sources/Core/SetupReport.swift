import Foundation

/// The JSON contract printed by `scrivener-setup --json` (schemaVersion 1).
public struct SetupReport: Codable, Sendable, Equatable {
    public struct Runtime: Codable, Sendable, Equatable {
        public let node: String
        public let version: String
        public let major: Int
        public let source: String
    }

    public struct Client: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let name: String
        public let configPath: String?
        public let status: String?
        public let outcome: String?
        public let message: String?
        public let backup: String?

        public init(
            id: String, name: String, configPath: String? = nil, status: String? = nil,
            outcome: String? = nil, message: String? = nil, backup: String? = nil
        ) {
            self.id = id
            self.name = name
            self.configPath = configPath
            self.status = status
            self.outcome = outcome
            self.message = message
            self.backup = backup
        }
    }

    public struct Startup: Codable, Sendable, Equatable {
        public let ok: Bool
        public let serverName: String?
        public let serverVersion: String?
        public let toolCount: Int?
        public let error: String?
        public let ms: Int

        public init(
            ok: Bool, serverName: String? = nil, serverVersion: String? = nil,
            toolCount: Int? = nil, error: String? = nil, ms: Int = 0
        ) {
            self.ok = ok
            self.serverName = serverName
            self.serverVersion = serverVersion
            self.toolCount = toolCount
            self.error = error
            self.ms = ms
        }
    }

    public let schemaVersion: Int
    public let mode: String
    public let ok: Bool
    public let error: String?
    public let runtime: Runtime?
    public let clients: [Client]?
    public let startup: Startup?

    public static let supportedSchemaVersion = 1

    public static func decode(_ data: Data) throws -> SetupReport {
        let report = try JSONDecoder().decode(SetupReport.self, from: data)
        guard report.schemaVersion == supportedSchemaVersion else {
            throw SetupError.unsupportedSchema(report.schemaVersion)
        }
        return report
    }
}

public enum SetupError: Error, LocalizedError, Equatable {
    case serverNotFound(String)
    case launchFailed(String)
    case timedOut
    case unreadableOutput(String)
    case unsupportedSchema(Int)

    public var errorDescription: String? {
        switch self {
        case .serverNotFound(let detail):
            return "The bundled Draftbridge server could not be found. \(detail)"
        case .launchFailed(let detail):
            return "Could not run the setup helper. \(detail)"
        case .timedOut:
            return "The setup helper took too long to respond."
        case .unreadableOutput(let detail):
            return "The setup helper returned something unexpected. \(detail)"
        case .unsupportedSchema(let version):
            return "The setup helper speaks version \(version), which this app does not understand. Reinstall the app."
        }
    }
}
