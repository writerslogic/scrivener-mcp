import Foundation

/// What the app shows for one AI app, derived from a setup report entry.
public enum ConnectionState: Equatable, Sendable {
    case connected
    case needsRepair
    case notConnected
    /// The app has no config file (Raycast); connection happens in its own dialog.
    case manual
    case problem(String)

    public init(client: SetupReport.Client) {
        switch client.status ?? client.outcome {
        case "configured", "added", "repaired", "unchanged":
            self = .connected
        case "outdated":
            self = .needsRepair
        case "missing", "removed":
            self = .notConnected
        case "link", "skipped":
            self = .manual
        case "unreadable", "failed":
            self = .problem(client.message ?? "The app's settings file could not be read.")
        default:
            self = .notConnected
        }
    }

    public var isHealthy: Bool { self == .connected }
}
