import CryptoKit
import Foundation

/// What a purchase entitles, as signed by the license server.
public struct LicensePayload: Codable, Equatable, Sendable {
    public let v: Int
    public let kid: String
    public let id: String
    public let email: String
    public let iat: Int
    public let seats: Int?
    public let product: String
}

/// Proof that this Mac holds one of the license's seats.
public struct ReceiptPayload: Codable, Equatable, Sendable {
    public let v: Int
    public let kid: String
    public let id: String
    public let dev: String
    public let iat: Int
}

/// Licenses withdrawn since they were sold: refunds, chargebacks, and leaked keys.
public struct RevocationPayload: Codable, Equatable, Sendable {
    public let v: Int
    public let kid: String
    public let iat: Int
    public let ids: [String]
}

public struct LicenseInfo: Equatable, Sendable {
    public let id: String
    public let email: String
    public let seats: Int?

    public init(id: String, email: String, seats: Int?) {
        self.id = id
        self.email = email
        self.seats = seats
    }
}

public enum LicenseState: Equatable, Sendable {
    /// This build has no licensing configured, as in development builds and community builds.
    case notRequired
    case unlicensed
    case licensed(LicenseInfo)
    /// A valid key, but this Mac has not been activated yet.
    case needsActivation(LicenseInfo)
    case revoked
    /// A stored key that no longer verifies.
    case invalid

    /// Whether connecting, repairing and fixing are allowed. Looking around and testing never are gated.
    public var allowsSetup: Bool {
        switch self {
        case .notRequired, .licensed: true
        case .unlicensed, .needsActivation, .revoked, .invalid: false
        }
    }
}

/// What is kept between launches.
public struct StoredLicense: Codable, Equatable, Sendable {
    public var token: String?
    public var receipt: String?
    /// The most recent verified revocation list, kept so it still applies offline.
    public var revocations: String?
    public var lastRevocationCheck: Date?

    public init(token: String? = nil, receipt: String? = nil, revocations: String? = nil, lastRevocationCheck: Date? = nil) {
        self.token = token
        self.receipt = receipt
        self.revocations = revocations
        self.lastRevocationCheck = lastRevocationCheck
    }
}

public struct LicenseVerifier: Sendable {
    public static let product = "draftbridge"
    public static let licensePrefix = "DB1"
    public static let licenseDomain = "draftbridge-license-v1"
    public static let receiptPrefix = "DBR1"
    public static let receiptDomain = "draftbridge-receipt-v1"
    public static let revocationPrefix = "DBX1"
    public static let revocationDomain = "draftbridge-revocations-v1"

    /// Tokens dated further ahead than this are rejected, so a bad clock cannot make one valid early.
    static let allowedClockSkew: TimeInterval = 86_400

    private let keys: [String: Curve25519.Signing.PublicKey]
    private let requireActivation: Bool
    private let deviceID: String

    public init(keys: [String: Curve25519.Signing.PublicKey], requireActivation: Bool, deviceID: String) {
        self.keys = keys
        self.requireActivation = requireActivation
        self.deviceID = deviceID
    }

    public func license(from token: String, now: Date) throws -> LicensePayload {
        let data = try SignedBlob.open(token, prefix: Self.licensePrefix, domain: Self.licenseDomain, keys: keys)
        guard let payload = try? JSONDecoder().decode(LicensePayload.self, from: data),
              payload.v == 1, payload.product == Self.product,
              TimeInterval(payload.iat) <= now.timeIntervalSince1970 + Self.allowedClockSkew
        else { throw LicenseError.malformed }
        return payload
    }

    public func revocationList(from list: String) -> RevocationPayload? {
        guard let data = try? SignedBlob.open(list, prefix: Self.revocationPrefix, domain: Self.revocationDomain, keys: keys),
              let payload = try? JSONDecoder().decode(RevocationPayload.self, from: data), payload.v == 1
        else { return nil }
        return payload
    }

    public func revokedIDs(from list: String) -> Set<String> {
        Set(revocationList(from: list)?.ids ?? [])
    }

    public func revocationIssuedAt(_ list: String) -> Int? {
        revocationList(from: list)?.iat
    }

    public func hasReceipt(_ receipt: String?, for license: LicensePayload) -> Bool {
        guard let receipt,
              let data = try? SignedBlob.open(receipt, prefix: Self.receiptPrefix, domain: Self.receiptDomain, keys: keys),
              let payload = try? JSONDecoder().decode(ReceiptPayload.self, from: data)
        else { return false }
        return payload.v == 1 && payload.id == license.id && payload.dev == deviceID
    }

    public func state(for stored: StoredLicense, now: Date) -> LicenseState {
        guard let token = stored.token else { return .unlicensed }
        guard let license = try? license(from: token, now: now) else { return .invalid }
        let info = LicenseInfo(id: license.id, email: license.email, seats: license.seats)
        if let list = stored.revocations, revokedIDs(from: list).contains(license.id) { return .revoked }
        if requireActivation, !hasReceipt(stored.receipt, for: license) { return .needsActivation(info) }
        return .licensed(info)
    }
}
