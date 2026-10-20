import Foundation

public struct ReleaseInfo: Sendable, Equatable {
    public let version: String
    public let pageURL: URL
}

public enum UpdateChecker {
    /// True when `candidate` is a newer dotted version than `current` (leading "v" ignored).
    public static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ v: String) -> [Int] {
            v.trimmingCharacters(in: CharacterSet(charactersIn: "vV")).split(separator: ".").map {
                Int($0.prefix { $0.isNumber }) ?? 0
            }
        }
        let a = parts(candidate), b = parts(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    public static func latestRelease(
        fetch: @Sendable (URL) async throws -> Data = { url in try await URLSession.shared.data(from: url).0 }
    ) async -> ReleaseInfo? {
        guard let url = URL(string: "https://api.github.com/repos/writerslogic/scrivener-mcp/releases/latest"),
              let data = try? await fetch(url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = json["tag_name"] as? String,
              let html = (json["html_url"] as? String).flatMap(URL.init(string:))
        else { return nil }
        return ReleaseInfo(version: tag, pageURL: html)
    }
}
