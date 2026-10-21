import CryptoKit
import Foundation

/// Build-time licensing settings. A build with no public keys has licensing switched off, which is
/// how development builds and community builds from source behave.
public struct LicenseConfig: Sendable, Equatable {
    public enum ConfigError: Error, Equatable { case malformed(String) }

    public let baseURL: URL
    public let publicKeys: [String: Data]
    public let checkoutURL: URL
    public let priceLabel: String
    public let requireActivation: Bool

    public var signingKeys: [String: Curve25519.Signing.PublicKey] {
        publicKeys.compactMapValues { try? Curve25519.Signing.PublicKey(rawRepresentation: $0) }
    }

    /// `nil` when the build has no licensing keys at all. Throws when keys are present but the rest
    /// is unusable, so a misconfigured paid build fails closed instead of shipping unlocked.
    public static func load(info: [String: Any]) throws -> LicenseConfig? {
        guard let rawKeys = info["DBLicensePublicKeys"] as? [String: String], !rawKeys.isEmpty else { return nil }
        var keys: [String: Data] = [:]
        for (kid, text) in rawKeys {
            guard let data = Data(base64Encoded: text), (try? Curve25519.Signing.PublicKey(rawRepresentation: data)) != nil else {
                throw ConfigError.malformed("public key \(kid)")
            }
            keys[kid] = data
        }
        guard let base = (info["DBLicenseBaseURL"] as? String).flatMap(URL.init(string:)), base.scheme == "https" else {
            throw ConfigError.malformed("DBLicenseBaseURL")
        }
        guard let checkout = (info["DBLicenseCheckoutURL"] as? String).flatMap(URL.init(string:)), checkout.scheme == "https" else {
            throw ConfigError.malformed("DBLicenseCheckoutURL")
        }
        guard let price = info["DBLicensePrice"] as? String, !price.isEmpty else {
            throw ConfigError.malformed("DBLicensePrice")
        }
        return LicenseConfig(
            baseURL: base, publicKeys: keys, checkoutURL: checkout, priceLabel: price,
            requireActivation: info["DBLicenseRequireActivation"] as? Bool ?? true
        )
    }
}

public protocol LicenseStore: Sendable {
    func load() -> StoredLicense?
    func save(_ license: StoredLicense)
    func clear()
}

public protocol LicenseTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, Int)
}

public struct URLSessionTransport: LicenseTransport {
    public init() {}

    public func send(_ request: URLRequest) async throws -> (Data, Int) {
        var request = request
        request.timeoutInterval = 15
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}

public enum EntryResult: Equatable, Sendable {
    case accepted(LicenseState)
    case failed(String)
}

public actor LicenseService {
    private let config: LicenseConfig?
    private let verifier: LicenseVerifier
    private let store: LicenseStore
    private let transport: LicenseTransport
    private let deviceID: String
    private let deviceName: String
    private let now: @Sendable () -> Date

    /// How often the revocation list is fetched.
    public static let revocationInterval: TimeInterval = 86_400

    public init(
        config: LicenseConfig?, store: LicenseStore, transport: LicenseTransport = URLSessionTransport(),
        deviceID: String, deviceName: String, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.config = config
        self.verifier = LicenseVerifier(keys: config?.signingKeys ?? [:], requireActivation: config?.requireActivation ?? false, deviceID: deviceID)
        self.store = store
        self.transport = transport
        self.deviceID = deviceID
        self.deviceName = deviceName
        self.now = now
    }

    public var isRequired: Bool { config != nil }

    public func state() -> LicenseState {
        guard config != nil else { return .notRequired }
        return verifier.state(for: store.load() ?? StoredLicense(), now: now())
    }

    /// Checks a pasted key offline, stores it, and activates this Mac when the build requires that.
    public func enter(key: String) async -> EntryResult {
        guard config != nil else { return .accepted(.notRequired) }
        let token = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let license: LicensePayload
        do {
            license = try verifier.license(from: token, now: now())
        } catch {
            return .failed("That is not a valid Draftbridge license key. Paste the whole key from your receipt.")
        }
        var stored = store.load() ?? StoredLicense()
        if let list = stored.revocations, verifier.revokedIDs(from: list).contains(license.id) {
            return .failed("This license was refunded or withdrawn.")
        }
        if stored.token != token { stored.receipt = nil }
        stored.token = token
        store.save(stored)
        if state() == .licensed(LicenseInfo(id: license.id, email: license.email, seats: license.seats)) {
            return .accepted(state())
        }
        return await activate()
    }

    /// Claims a seat for this Mac. A receipt is stored so the app works offline afterwards.
    public func activate() async -> EntryResult {
        guard let config, var stored = store.load(), let token = stored.token else {
            return .failed("Enter a license key first.")
        }
        let body: [String: String] = ["license": token, "device": deviceID, "name": deviceName]
        do {
            let (data, status) = try await post(config.baseURL.appendingPathComponent("v1/draftbridge/activate"), body)
            switch status {
            case 200:
                guard let receipt = (try? JSONDecoder().decode(ReceiptResponse.self, from: data))?.receipt else {
                    return .failed("The license server sent an unexpected reply. Please try again.")
                }
                stored.receipt = receipt
                guard let license = try? verifier.license(from: token, now: now()), verifier.hasReceipt(receipt, for: license) else {
                    return .failed("The license server sent an unexpected reply. Please try again.")
                }
                store.save(stored)
                return .accepted(state())
            case 409:
                let seats = (try? JSONDecoder().decode(SeatResponse.self, from: data))?.seats
                let count = seats.map { "\($0) Macs" } ?? "the maximum number of Macs"
                return .failed("This license is already active on \(count). Deactivate one in Draftbridge Settings, or contact support.")
            case 403:
                return .failed("This license was refunded or withdrawn.")
            case 400, 404, 422:
                return .failed("That license key was not recognized.")
            default:
                return .failed("The license server had a problem (code \(status)). Please try again in a few minutes.")
            }
        } catch {
            return .failed("Could not reach the license server. Check your connection and try again.")
        }
    }

    /// Releases this Mac's seat and forgets the key. Returns false when the seat could not be released.
    public func deactivate() async -> Bool {
        guard let config, let token = store.load()?.token else { return true }
        let released: Bool
        do {
            let (_, status) = try await post(config.baseURL.appendingPathComponent("v1/draftbridge/deactivate"), ["license": token, "device": deviceID])
            released = (200..<300).contains(status) || status == 404
        } catch {
            released = false
        }
        if released { store.clear() }
        return released
    }

    /// Removes the key from this Mac without contacting the server.
    public func forget() {
        store.clear()
    }

    /// Fetches the signed revocation list at most once a day. Failures change nothing: a Mac that is
    /// offline keeps its licensed state.
    public func refreshRevocations(force: Bool = false) async {
        guard let config else { return }
        var stored = store.load() ?? StoredLicense()
        guard stored.token != nil else { return }
        if !force, let last = stored.lastRevocationCheck, now().timeIntervalSince(last) < Self.revocationInterval { return }
        var request = URLRequest(url: config.baseURL.appendingPathComponent("v1/draftbridge/revocations"))
        request.setValue("text/plain", forHTTPHeaderField: "Accept")
        guard let (data, status) = try? await transport.send(request), status == 200,
              let list = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let issued = verifier.revocationIssuedAt(list)
        else { return }
        // A replayed older list must not undo a newer one.
        if let current = stored.revocations, let known = verifier.revocationIssuedAt(current), issued < known {
            stored.lastRevocationCheck = now()
        } else {
            stored.revocations = list
            stored.lastRevocationCheck = now()
        }
        store.save(stored)
    }

    private func post(_ url: URL, _ body: [String: String]) async throws -> (Data, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)
        return try await transport.send(request)
    }

    private struct ReceiptResponse: Decodable { let receipt: String }
    private struct SeatResponse: Decodable { let seats: Int? }
}
