import Foundation

/// Runs the bundled `scrivener-setup` helper and decodes its JSON report.
public struct SetupRunner: Sendable {
    public let location: ServerLocation

    public init(location: ServerLocation) {
        self.location = location
    }

    public enum Action: Sendable {
        case check(verify: Bool)
        case connect(clientIDs: [String], verify: Bool)
        case disconnect(clientIDs: [String])
    }

    func arguments(for action: Action) -> [String] {
        var args = [
            location.setupScript.path, "--json", "--yes",
            "--node", location.node.path, "--script", location.script.path,
        ]
        func clients(_ ids: [String]) -> [String] { ids.flatMap { ["--client", $0] } }
        switch action {
        case .check(let verify):
            args += ["--check"] + (verify ? [] : ["--no-verify"])
        case .connect(let ids, let verify):
            args += clients(ids) + (verify ? [] : ["--no-verify"])
        case .disconnect(let ids):
            args += ["--remove"] + clients(ids)
        }
        return args
    }

    public func run(_ action: Action, timeout: TimeInterval = 120) async throws -> SetupReport {
        let args = arguments(for: action)
        let node = location.node
        let (stdout, stderr) = try await Task.detached(priority: .userInitiated) {
            try Self.execute(node: node, arguments: args, timeout: timeout)
        }.value
        guard !stdout.isEmpty else {
            let detail = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            throw SetupError.unreadableOutput(detail.isEmpty ? "No output." : String(detail.suffix(400)))
        }
        do {
            return try SetupReport.decode(stdout)
        } catch let error as SetupError {
            throw error
        } catch {
            throw SetupError.unreadableOutput(String(decoding: stdout.prefix(200), as: UTF8.self))
        }
    }

    private static func execute(
        node: URL, arguments: [String], timeout: TimeInterval
    ) throws -> (Data, Data) {
        let process = Process()
        process.executableURL = node
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            throw SetupError.launchFailed(error.localizedDescription)
        }

        let timedOut = TimedOutFlag()
        let killer = DispatchWorkItem {
            timedOut.set()
            process.terminate()
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)

        // Drain both pipes concurrently so a full buffer can never block the helper.
        let group = DispatchGroup()
        let errBox = DataBox()
        group.enter()
        DispatchQueue.global().async {
            errBox.set(err.fileHandleForReading.readDataToEndOfFile())
            group.leave()
        }
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        group.wait()
        killer.cancel()

        if timedOut.value { throw SetupError.timedOut }
        return (outData, errBox.value)
    }
}

private final class TimedOutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.lock(); flag = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
}

private final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func set(_ new: Data) { lock.lock(); data = new; lock.unlock() }
    var value: Data { lock.lock(); defer { lock.unlock() }; return data }
}
