import Foundation

/// What the setup screen should lead with, derived from the state of every AI app found.
public enum SetupStage: Equatable, Sendable {
    /// No supported AI app is installed.
    case noApps
    /// Nothing is connected yet. `id` is the app to recommend connecting first.
    case connectFirst(id: String)
    /// At least one app is broken or out of date.
    case needsAttention
    /// At least one app is connected and none needs fixing.
    case ready

    /// Apps in the order we recommend them to someone who has not chosen yet.
    public static let preference = ["claude-desktop", "boltai", "cursor", "vscode", "lm-studio", "raycast", "claude-code"]

    public static func stage(for apps: [(id: String, state: ConnectionState)]) -> SetupStage {
        guard !apps.isEmpty else { return .noApps }
        let needsFixing = apps.contains { app in
            if case .problem = app.state { return true }
            return app.state == .needsRepair
        }
        if needsFixing { return .needsAttention }
        if apps.contains(where: { $0.state == .connected }) { return .ready }
        let candidates = apps.filter { $0.state == .notConnected || $0.state == .manual }
        let best = candidates.min { rank($0.id) < rank($1.id) }
        return best.map { .connectFirst(id: $0.id) } ?? .noApps
    }

    private static func rank(_ id: String) -> Int {
        preference.firstIndex(of: id) ?? preference.count
    }
}

/// A Scrivener project found on disk.
public struct ProjectInfo: Equatable, Sendable, Identifiable {
    public let url: URL
    public let modified: Date?

    public var id: URL { url }
    public var name: String { url.deletingPathExtension().lastPathComponent }

    public init(url: URL, modified: Date?) {
        self.url = url
        self.modified = modified
    }

    /// Most recently edited first. Projects with no known date sort last, then by name.
    public static func sortedByRecency(_ projects: [ProjectInfo]) -> [ProjectInfo] {
        projects.sorted { a, b in
            switch (a.modified, b.modified) {
            case let (x?, y?) where x != y: return x > y
            case (.some, .none): return true
            case (.none, .some): return false
            default: return a.name.localizedStandardCompare(b.name) == .orderedAscending
            }
        }
    }

    /// Whether a Spotlight hit is a real project rather than a trashed or automatic backup copy.
    public static func isUsableProjectPath(_ path: String) -> Bool {
        path.hasSuffix(".scriv")
            && !path.contains("/.Trash/")
            && !path.contains("/Backups/")
            && !path.contains("/Library/Application Support/Scrivener/")
    }

    /// "Edited 3 hours ago", or nothing when the date is unknown.
    public func editedDescription(now: Date = Date()) -> String? {
        guard let modified else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return "Edited " + formatter.localizedString(for: modified, relativeTo: now)
    }
}
