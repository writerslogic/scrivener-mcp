import CryptoKit
import Foundation

public enum LicenseError: Error, Equatable, Sendable {
    case malformed
    case unknownKey
    case badSignature
}

/// `PREFIX.<base64url payload>.<base64url Ed25519 signature>`.
///
/// The signature covers `domain + "\n" + <base64url payload>` exactly as written in the token, so
/// there is no canonical-JSON step to get wrong, and a signature made for one kind of token
/// (a license) cannot be replayed as another (a revocation list).
public enum SignedBlob {
    public static func open(
        _ text: String,
        prefix: String,
        domain: String,
        keys: [String: Curve25519.Signing.PublicKey]
    ) throws -> Data {
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == prefix else { throw LicenseError.malformed }
        let payloadText = String(parts[1])
        guard let payload = base64URLDecode(payloadText), let signature = base64URLDecode(String(parts[2])) else {
            throw LicenseError.malformed
        }
        guard let kid = (try? JSONDecoder().decode(KeyID.self, from: payload))?.kid else { throw LicenseError.malformed }
        guard let key = keys[kid] else { throw LicenseError.unknownKey }
        guard key.isValidSignature(signature, for: Data((domain + "\n" + payloadText).utf8)) else {
            throw LicenseError.badSignature
        }
        return payload
    }

    private struct KeyID: Decodable { let kid: String }

    public static func base64URLDecode(_ text: String) -> Data? {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    public static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
