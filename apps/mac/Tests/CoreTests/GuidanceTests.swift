import Foundation
import Testing
@testable import ScrivenerMCPCore

@Suite struct SetupStageTests {
    @Test func noAppsMeansNoApps() {
        #expect(SetupStage.stage(for: []) == .noApps)
    }

    @Test func recommendsTheMostPreferredUnconnectedApp() {
        let stage = SetupStage.stage(for: [("cursor", .notConnected), ("claude-desktop", .notConnected), ("raycast", .manual)])
        #expect(stage == .connectFirst(id: "claude-desktop"))
    }

    @Test func aManualOnlyMachineStillGetsARecommendation() {
        #expect(SetupStage.stage(for: [("raycast", .manual)]) == .connectFirst(id: "raycast"))
    }

    @Test func aBrokenAppOutranksAConnectedOne() {
        #expect(SetupStage.stage(for: [("claude-desktop", .connected), ("cursor", .problem("bad"))]) == .needsAttention)
        #expect(SetupStage.stage(for: [("claude-desktop", .connected), ("boltai", .needsRepair)]) == .needsAttention)
    }

    @Test func oneConnectedAppIsReadyEvenWithOthersLeftOff() {
        #expect(SetupStage.stage(for: [("claude-desktop", .connected), ("cursor", .notConnected)]) == .ready)
    }
}

@Suite struct ProjectInfoTests {
    private func project(_ name: String, _ seconds: TimeInterval?) -> ProjectInfo {
        ProjectInfo(url: URL(fileURLWithPath: "/p/\(name).scriv"), modified: seconds.map { Date(timeIntervalSince1970: $0) })
    }

    @Test func sortsNewestFirstThenUndatedByName() {
        let sorted = ProjectInfo.sortedByRecency([project("b", nil), project("old", 10), project("a", nil), project("new", 99)])
        #expect(sorted.map(\.name) == ["new", "old", "a", "b"])
    }

    @Test func namesDropTheExtension() {
        #expect(project("My Novel", 1).name == "My Novel")
    }

    @Test func filtersTrashBackupsAndScrivenerInternals() {
        #expect(ProjectInfo.isUsableProjectPath("/Users/a/Documents/Novel.scriv"))
        #expect(!ProjectInfo.isUsableProjectPath("/Users/a/.Trash/Novel.scriv"))
        #expect(!ProjectInfo.isUsableProjectPath("/Users/a/Documents/Backups/Novel.scriv"))
        #expect(!ProjectInfo.isUsableProjectPath("/Users/a/Library/Application Support/Scrivener/Templates/X.scriv"))
        #expect(!ProjectInfo.isUsableProjectPath("/Users/a/Documents/Novel.scriv.zip"))
    }

    @Test func describesEditsRelativeToNowAndSkipsUnknownDates() {
        let now = Date(timeIntervalSince1970: 100_000)
        #expect(project("x", nil).editedDescription(now: now) == nil)
        #expect(project("x", 100_000 - 3 * 3600).editedDescription(now: now)?.hasPrefix("Edited ") == true)
    }
}
