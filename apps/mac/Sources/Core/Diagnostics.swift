import Foundation

public enum Diagnostics {
    /// Plain text a user can paste into a support request. Contains no manuscript content.
    public static func summary(
        appVersion: String, macOS: String, report: SetupReport?, location: ServerLocation?
    ) -> String {
        var lines = ["Scrivener MCP \(appVersion)", "macOS \(macOS)"]
        if let runtime = report?.runtime {
            lines.append("Node \(runtime.version) (\(runtime.source))")
        }
        if let location {
            lines.append("Server: \(location.script.path)")
        }
        for client in report?.clients ?? [] {
            let state = client.status ?? client.outcome ?? "unknown"
            let note = client.message.map { " - \($0)" } ?? ""
            lines.append("\(client.name): \(state)\(note)")
        }
        if let startup = report?.startup {
            lines.append(
                startup.ok
                    ? "Start-up test: passed, \(startup.toolCount ?? 0) tools in \(startup.ms) ms"
                    : "Start-up test: FAILED - \(startup.error ?? "unknown error")"
            )
        }
        return lines.joined(separator: "\n")
    }
}
