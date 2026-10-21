import Foundation
import Security

/// Keeps the license in the login Keychain. The Keychain, unlike a preferences file, is not something
/// a forum post can tell people to edit, and it survives deleting and reinstalling the app.
public struct KeychainLicenseStore: LicenseStore {
    private let service: String
    private let account = "license"

    public init(service: String = "com.writerslogic.draftbridge.license") {
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() -> StoredLicense? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(StoredLicense.self, from: data)
    }

    public func save(_ license: StoredLicense) {
        guard let data = try? JSONEncoder().encode(license) else { return }
        let update = [kSecValueData as String: data]
        if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            var add = query
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    public func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
