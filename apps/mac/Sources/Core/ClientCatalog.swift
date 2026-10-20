import Foundation

/// Display details for the AI apps the setup helper knows about.
public struct ClientInfo: Sendable, Equatable {
    public let id: String
    public let appName: String?
    public let symbol: String
    public let restartHint: String
    public let downloadURL: URL?
}

public enum ClientCatalog {
    public static let all: [ClientInfo] = [
        .init(id: "claude-desktop", appName: "Claude.app", symbol: "bubble.left.and.text.bubble.right",
              restartHint: "Quit Claude with Cmd+Q and reopen it.", downloadURL: URL(string: "https://claude.ai/download")),
        .init(id: "claude-code", appName: nil, symbol: "terminal",
              restartHint: "Start a new Claude Code session.", downloadURL: nil),
        .init(id: "cursor", appName: "Cursor.app", symbol: "cursorarrow.rays",
              restartHint: "Quit Cursor and reopen it.", downloadURL: URL(string: "https://cursor.com")),
        .init(id: "vscode", appName: "Visual Studio Code.app", symbol: "chevron.left.forwardslash.chevron.right",
              restartHint: "Reload the VS Code window.", downloadURL: URL(string: "https://code.visualstudio.com")),
        .init(id: "lm-studio", appName: "LM Studio.app", symbol: "cpu",
              restartHint: "Quit LM Studio and reopen it.", downloadURL: URL(string: "https://lmstudio.ai")),
        .init(id: "boltai", appName: "BoltAI.app", symbol: "bolt",
              restartHint: "In BoltAI choose Settings, Plugins, then Reload Config.", downloadURL: URL(string: "https://boltai.com")),
        .init(id: "raycast", appName: "Raycast.app", symbol: "command",
              restartHint: "Confirm the Install Server dialog in Raycast.", downloadURL: URL(string: "https://raycast.com")),
    ]

    public static func info(for id: String) -> ClientInfo? {
        all.first { $0.id == id }
    }

    /// First existing install location of the app, if any.
    public static func appURL(
        for info: ClientInfo,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> URL? {
        guard let name = info.appName else { return nil }
        let candidates = [
            URL(fileURLWithPath: "/Applications").appendingPathComponent(name),
            home.appendingPathComponent("Applications").appendingPathComponent(name),
        ]
        return candidates.first { exists($0.path) }
    }
}
