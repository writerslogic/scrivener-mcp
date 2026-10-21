import CryptoKit
import Foundation
import Testing
@testable import ScrivenerMCPCore

// MARK: - Test doubles

private struct Signer {
    let key = Curve25519.Signing.PrivateKey()
    let kid: String

    init(kid: String = "k1") { self.kid = kid }

    var publicKeys: [String: Curve25519.Signing.PublicKey] { [kid: key.publicKey] }

    func seal(_ payload: [String: Any], prefix: String, domain: String) -> String {
        let json = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let text = SignedBlob.base64URLEncode(json)
        let signature = try! key.signature(for: Data((domain + "\n" + text).utf8))
        return "\(prefix).\(text).\(SignedBlob.base64URLEncode(signature))"
    }

    func license(id: String = "lic_1", email: String = "a@b.co", iat: Int = 1_000_000, product: String = "draftbridge", kid: String? = nil) -> String {
        seal(["v": 1, "kid": kid ?? self.kid, "id": id, "email": email, "iat": iat, "seats": 2, "product": product],
             prefix: "DB1", domain: "draftbridge-license-v1")
    }

    func receipt(id: String = "lic_1", device: String, iat: Int = 1_000_000) -> String {
        seal(["v": 1, "kid": kid, "id": id, "dev": device, "iat": iat], prefix: "DBR1", domain: "draftbridge-receipt-v1")
    }

    func revocations(ids: [String], iat: Int = 1_000_000) -> String {
        seal(["v": 1, "kid": kid, "iat": iat, "ids": ids], prefix: "DBX1", domain: "draftbridge-revocations-v1")
    }
}

private final class MemoryStore: LicenseStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: StoredLicense?
    func load() -> StoredLicense? { lock.withLock { value } }
    func save(_ license: StoredLicense) { lock.withLock { value = license } }
    func clear() { lock.withLock { value = nil } }
}

private final class Clock: @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    init(_ date: Date) { current = date }
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }
}

private final class FakeTransport: LicenseTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [URL] = []
    var respond: @Sendable (URLRequest) throws -> (Data, Int) = { _ in throw URLError(.notConnectedToInternet) }

    var requested: [URL] { lock.withLock { calls } }

    func send(_ request: URLRequest) async throws -> (Data, Int) {
        lock.withLock { calls.append(request.url!) }
        return try respond(request)
    }
}

private let epoch = Date(timeIntervalSince1970: 2_000_000)

private func config(for signer: Signer, requireActivation: Bool) -> LicenseConfig {
    try! LicenseConfig.load(info: [
        "DBLicensePublicKeys": [signer.kid: signer.key.publicKey.rawRepresentation.base64EncodedString()],
        "DBLicenseBaseURL": "https://license.example.com",
        "DBLicenseCheckoutURL": "https://buy.example.com/draftbridge",
        "DBLicensePrice": "$14.99",
        "DBLicenseRequireActivation": requireActivation,
    ])!
}

private func service(
    _ signer: Signer, requireActivation: Bool, store: MemoryStore = MemoryStore(),
    transport: FakeTransport = FakeTransport(), clock: Clock = Clock(epoch), device: String = "device-A"
) -> LicenseService {
    LicenseService(
        config: config(for: signer, requireActivation: requireActivation), store: store, transport: transport,
        deviceID: device, deviceName: "Test Mac", now: { clock.now }
    )
}

// MARK: - Tokens

@Suite struct LicenseTokenTests {
    private func verifier(_ signer: Signer, requireActivation: Bool = false, device: String = "device-A") -> LicenseVerifier {
        LicenseVerifier(keys: signer.publicKeys, requireActivation: requireActivation, deviceID: device)
    }

    @Test func acceptsAGenuineLicense() throws {
        let signer = Signer()
        let payload = try verifier(signer).license(from: signer.license(email: "ann@example.com"), now: epoch)
        #expect(payload.email == "ann@example.com")
        #expect(payload.id == "lic_1")
    }

    @Test func rejectsATokenSignedByAnotherKey() {
        let genuine = Signer(), forger = Signer()
        #expect(throws: LicenseError.badSignature) {
            try verifier(genuine).license(from: forger.license(), now: epoch)
        }
    }

    @Test func rejectsATamperedPayload() {
        let signer = Signer()
        let token = signer.license(email: "ann@example.com")
        var parts = token.split(separator: ".").map(String.init)
        let tampered = String(data: SignedBlob.base64URLDecode(parts[1])!, encoding: .utf8)!.replacingOccurrences(of: "ann@", with: "bob@")
        parts[1] = SignedBlob.base64URLEncode(Data(tampered.utf8))
        #expect(throws: LicenseError.badSignature) {
            try verifier(signer).license(from: parts.joined(separator: "."), now: epoch)
        }
    }

    @Test func rejectsAnUnknownKeyID() {
        let signer = Signer()
        #expect(throws: LicenseError.unknownKey) {
            try verifier(signer).license(from: signer.license(kid: "rotated-away"), now: epoch)
        }
    }

    @Test func rejectsAnotherProduct() {
        let signer = Signer()
        #expect(throws: LicenseError.malformed) {
            try verifier(signer).license(from: signer.license(product: "writersproof"), now: epoch)
        }
    }

    @Test func aSignatureForOneKindOfTokenCannotBeReusedAsAnother() {
        let signer = Signer()
        let revocations = signer.revocations(ids: ["lic_1"])
        let relabelled = "DB1" + revocations.dropFirst("DBX1".count)
        #expect(throws: LicenseError.badSignature) {
            try verifier(signer).license(from: relabelled, now: epoch)
        }
    }

    @Test func rejectsMalformedText() {
        let signer = Signer()
        for text in ["", "DB1", "DB1.a", "DB1.a.b.c", "XX1.e30.AAAA", "DB1.!!!.@@@"] {
            #expect(throws: LicenseError.malformed) { try verifier(signer).license(from: text, now: epoch) }
        }
    }

    @Test func clockSkewBoundary() throws {
        let signer = Signer()
        let limit = Int(epoch.timeIntervalSince1970 + LicenseVerifier.allowedClockSkew)
        _ = try verifier(signer).license(from: signer.license(iat: limit - 1), now: epoch)
        _ = try verifier(signer).license(from: signer.license(iat: limit), now: epoch)
        #expect(throws: LicenseError.malformed) {
            try verifier(signer).license(from: signer.license(iat: limit + 1), now: epoch)
        }
    }
}

// MARK: - State

@Suite struct LicenseStateTests {
    private func state(_ signer: Signer, _ stored: StoredLicense, requireActivation: Bool, device: String = "device-A") -> LicenseState {
        LicenseVerifier(keys: signer.publicKeys, requireActivation: requireActivation, deviceID: device).state(for: stored, now: epoch)
    }

    @Test func noKeyMeansUnlicensedAndSetupIsLocked() {
        let result = state(Signer(), StoredLicense(), requireActivation: false)
        #expect(result == .unlicensed)
        #expect(!result.allowsSetup)
    }

    @Test func aStoredKeyThatNoLongerVerifiesIsInvalid() {
        let result = state(Signer(), StoredLicense(token: Signer().license()), requireActivation: false)
        #expect(result == .invalid)
        #expect(!result.allowsSetup)
    }

    @Test func aRevokedLicenseIsLockedEvenWithAValidReceipt() {
        let signer = Signer()
        let stored = StoredLicense(token: signer.license(), receipt: signer.receipt(device: "device-A"), revocations: signer.revocations(ids: ["lic_1"]))
        #expect(state(signer, stored, requireActivation: true) == .revoked)
    }

    @Test func aRevocationListSignedByAnotherKeyIsIgnored() {
        let signer = Signer(), forger = Signer()
        let stored = StoredLicense(token: signer.license(), revocations: forger.revocations(ids: ["lic_1"]))
        #expect(state(signer, stored, requireActivation: false).allowsSetup)
    }

    @Test func activationNeedsAReceiptForThisMacAndThisLicense() {
        let signer = Signer(), token = signer.license()
        #expect(state(signer, StoredLicense(token: token), requireActivation: true) == .needsActivation(.init(id: "lic_1", email: "a@b.co", seats: 2)))
        #expect(state(signer, StoredLicense(token: token, receipt: signer.receipt(device: "other-mac")), requireActivation: true).allowsSetup == false)
        #expect(state(signer, StoredLicense(token: token, receipt: signer.receipt(id: "lic_2", device: "device-A")), requireActivation: true).allowsSetup == false)
        #expect(state(signer, StoredLicense(token: token, receipt: signer.receipt(device: "device-A")), requireActivation: true).allowsSetup)
    }

    @Test func buildsWithoutActivationAcceptAnOfflineKey() {
        let signer = Signer()
        #expect(state(signer, StoredLicense(token: signer.license()), requireActivation: false).allowsSetup)
    }
}

// MARK: - Service

@Suite struct LicenseServiceTests {
    @Test func anUnconfiguredBuildIsFreeAndNeverTouchesTheNetwork() async {
        let transport = FakeTransport()
        let free = LicenseService(config: nil, store: MemoryStore(), transport: transport, deviceID: "d", deviceName: "n")
        #expect(await free.state() == .notRequired)
        #expect(await free.state().allowsSetup)
        await free.refreshRevocations(force: true)
        #expect(transport.requested.isEmpty)
    }

    @Test func aKeyIsAcceptedOfflineWhenNoActivationIsRequired() async {
        let signer = Signer(), transport = FakeTransport()
        let result = await service(signer, requireActivation: false, transport: transport).enter(key: "  \(signer.license())\n")
        guard case .accepted(let state) = result else { Issue.record("expected acceptance, got \(result)"); return }
        #expect(state.allowsSetup)
        #expect(transport.requested.isEmpty)
    }

    @Test func nonsenseIsRejectedWithAnExplanation() async {
        let signer = Signer()
        let result = await service(signer, requireActivation: false).enter(key: "hello")
        #expect(result == .failed("That is not a valid Draftbridge license key. Paste the whole key from your receipt."))
    }

    @Test func anAlreadyRevokedKeyIsRefusedBeforeItIsStored() async {
        let signer = Signer(), store = MemoryStore()
        store.save(StoredLicense(token: "old", revocations: signer.revocations(ids: ["lic_1"])))
        let result = await service(signer, requireActivation: false, store: store).enter(key: signer.license())
        #expect(result == .failed("This license was refunded or withdrawn."))
        #expect(store.load()?.token == "old")
    }

    @Test func activationStoresTheReceiptSoTheAppWorksOffline() async {
        let signer = Signer(), transport = FakeTransport(), store = MemoryStore()
        let receipt = signer.receipt(device: "device-A")
        transport.respond = { _ in (Data(#"{"receipt":"\#(receipt)"}"#.utf8), 200) }
        let svc = service(signer, requireActivation: true, store: store, transport: transport)
        let result = await svc.enter(key: signer.license())
        guard case .accepted(let state) = result else { Issue.record("expected acceptance, got \(result)"); return }
        #expect(state.allowsSetup)
        #expect(store.load()?.receipt == receipt)
        transport.respond = { _ in throw URLError(.notConnectedToInternet) }
        #expect(await svc.state().allowsSetup)
    }

    @Test func aReceiptForAnotherMacFromTheServerIsNotTrusted() async {
        let signer = Signer(), transport = FakeTransport(), store = MemoryStore()
        let receipt = signer.receipt(device: "someone-elses-mac")
        transport.respond = { _ in (Data(#"{"receipt":"\#(receipt)"}"#.utf8), 200) }
        let result = await service(signer, requireActivation: true, store: store, transport: transport).enter(key: signer.license())
        guard case .failed = result else { Issue.record("expected failure, got \(result)"); return }
        #expect(store.load()?.receipt == nil)
    }

    @Test func theSeatLimitIsExplained() async {
        let signer = Signer(), transport = FakeTransport()
        transport.respond = { _ in (Data(#"{"error":"seat_limit","seats":2}"#.utf8), 409) }
        let result = await service(signer, requireActivation: true, transport: transport).enter(key: signer.license())
        #expect(result == .failed("This license is already active on 2 Macs. Deactivate one in Draftbridge Settings, or contact support."))
    }

    @Test func goingOfflineDuringActivationKeepsTheKeyForARetry() async {
        let signer = Signer(), store = MemoryStore()
        let svc = service(signer, requireActivation: true, store: store)
        let result = await svc.enter(key: signer.license())
        #expect(result == .failed("Could not reach the license server. Check your connection and try again."))
        guard case .needsActivation = await svc.state() else { Issue.record("expected needsActivation"); return }
    }

    @Test func revocationChecksAreThrottledToOncePerInterval() async {
        let signer = Signer(), transport = FakeTransport(), clock = Clock(epoch)
        let list = signer.revocations(ids: [])
        transport.respond = { _ in (Data(list.utf8), 200) }
        let svc = service(signer, requireActivation: false, transport: transport, clock: clock)
        _ = await svc.enter(key: signer.license())
        await svc.refreshRevocations()
        await svc.refreshRevocations()
        #expect(transport.requested.count == 1)
        clock.advance(LicenseService.revocationInterval - 1)
        await svc.refreshRevocations()
        #expect(transport.requested.count == 1)
        clock.advance(2)
        await svc.refreshRevocations()
        #expect(transport.requested.count == 2)
    }

    @Test func aFreshRevocationListLocksTheLicense() async {
        let signer = Signer(), transport = FakeTransport()
        let svc = service(signer, requireActivation: false, transport: transport)
        _ = await svc.enter(key: signer.license())
        transport.respond = { _ in (Data(signer.revocations(ids: ["lic_1"]).utf8), 200) }
        await svc.refreshRevocations(force: true)
        #expect(await svc.state() == .revoked)
    }

    @Test func aReplayedOlderListCannotUndoANewerOne() async {
        let signer = Signer(), transport = FakeTransport()
        let svc = service(signer, requireActivation: false, transport: transport)
        _ = await svc.enter(key: signer.license())
        transport.respond = { _ in (Data(signer.revocations(ids: ["lic_1"], iat: 2000).utf8), 200) }
        await svc.refreshRevocations(force: true)
        transport.respond = { _ in (Data(signer.revocations(ids: [], iat: 1000).utf8), 200) }
        await svc.refreshRevocations(force: true)
        #expect(await svc.state() == .revoked)
    }

    @Test func anOfflineMacKeepsItsLicense() async {
        let signer = Signer()
        let svc = service(signer, requireActivation: false)
        _ = await svc.enter(key: signer.license())
        await svc.refreshRevocations(force: true)
        #expect(await svc.state().allowsSetup)
    }

    @Test func deactivatingReleasesTheSeatAndForgetsTheKey() async {
        let signer = Signer(), transport = FakeTransport(), store = MemoryStore()
        let receipt = signer.receipt(device: "device-A")
        transport.respond = { _ in (Data(#"{"receipt":"\#(receipt)"}"#.utf8), 200) }
        let svc = service(signer, requireActivation: true, store: store, transport: transport)
        _ = await svc.enter(key: signer.license())
        transport.respond = { _ in (Data("{}".utf8), 200) }
        #expect(await svc.deactivate())
        #expect(store.load() == nil)
        #expect(await svc.state() == .unlicensed)
    }

    @Test func deactivatingOfflineKeepsTheKeySoTheSeatIsNotLost() async {
        let signer = Signer(), transport = FakeTransport(), store = MemoryStore()
        let receipt = signer.receipt(device: "device-A")
        transport.respond = { _ in (Data(#"{"receipt":"\#(receipt)"}"#.utf8), 200) }
        let svc = service(signer, requireActivation: true, store: store, transport: transport)
        _ = await svc.enter(key: signer.license())
        transport.respond = { _ in throw URLError(.notConnectedToInternet) }
        #expect(await svc.deactivate() == false)
        #expect(store.load()?.token != nil)
    }
}

// MARK: - Config

@Suite struct LicenseConfigTests {
    private let key = Curve25519.Signing.PrivateKey().publicKey.rawRepresentation.base64EncodedString()

    private func info(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var base: [String: Any] = [
            "DBLicensePublicKeys": ["k1": key], "DBLicenseBaseURL": "https://l.example.com",
            "DBLicenseCheckoutURL": "https://buy.example.com", "DBLicensePrice": "$14.99",
        ]
        for (name, value) in overrides { base[name] = value }
        return base
    }

    @Test func noKeysMeansLicensingIsOff() throws {
        #expect(try LicenseConfig.load(info: [:]) == nil)
    }

    @Test func requiresActivationByDefault() throws {
        #expect(try LicenseConfig.load(info: info())?.requireActivation == true)
    }

    @Test func aPartlyConfiguredBuildFailsClosed() {
        #expect(throws: LicenseConfig.ConfigError.self) { try LicenseConfig.load(info: info(["DBLicenseBaseURL": "http://insecure.example.com"])) }
        #expect(throws: LicenseConfig.ConfigError.self) { try LicenseConfig.load(info: info(["DBLicensePrice": ""])) }
        #expect(throws: LicenseConfig.ConfigError.self) { try LicenseConfig.load(info: info(["DBLicensePublicKeys": ["k1": "not-a-key"]])) }
        #expect(throws: LicenseConfig.ConfigError.self) { try LicenseConfig.load(info: info(["DBLicenseCheckoutURL": "ftp://x"])) }
    }
}

// MARK: - Tokens made by the Node issuer

/// The license service must produce tokens the app accepts. These come from license/make-vectors.mjs.
@Suite struct IssuerCompatibilityTests {
    private struct Vectors: Decodable {
        let kid: String
        let publicKey: String
        let device: String
        let license: String
        let receipt: String
        let revocations: String
        let revocationsWithLicense: String
    }

    private func load() throws -> (Vectors, LicenseVerifier, LicenseVerifier) {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("license/test-vectors.json")
        let vectors = try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
        let key = try Curve25519.Signing.PublicKey(rawRepresentation: #require(Data(base64Encoded: vectors.publicKey)))
        let mine = LicenseVerifier(keys: [vectors.kid: key], requireActivation: true, deviceID: vectors.device)
        let other = LicenseVerifier(keys: [vectors.kid: key], requireActivation: true, deviceID: "another-mac")
        return (vectors, mine, other)
    }

    private let after = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func acceptsALicenseAndReceiptIssuedByTheNodeTool() throws {
        let (v, mine, _) = try load()
        let license = try mine.license(from: v.license, now: after)
        #expect(license.email == "reader@example.com")
        #expect(mine.hasReceipt(v.receipt, for: license))
        #expect(mine.state(for: StoredLicense(token: v.license, receipt: v.receipt), now: after).allowsSetup)
    }

    @Test func theReceiptOnlyWorksOnTheMacItWasIssuedFor() throws {
        let (v, _, other) = try load()
        #expect(!other.state(for: StoredLicense(token: v.license, receipt: v.receipt), now: after).allowsSetup)
    }

    @Test func readsRevocationListsIssuedByTheNodeTool() throws {
        let (v, mine, _) = try load()
        #expect(mine.revokedIDs(from: v.revocations) == ["lic_other"])
        #expect(mine.state(for: StoredLicense(token: v.license, receipt: v.receipt, revocations: v.revocationsWithLicense), now: after) == .revoked)
    }
}
