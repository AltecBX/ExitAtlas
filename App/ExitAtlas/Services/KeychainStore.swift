import Foundation
import Security

/// API keys in the Keychain (this device only, readable after the first unlock so background trips can
/// look up prices). Demos and UI tests use the in-memory store so they never touch real keys.
final class KeychainStore: @unchecked Sendable {
    static let shared = KeychainStore(service: "com.cobyconstruction.exitatlas.keys", inMemory: false)
    static func memory() -> KeychainStore { KeychainStore(service: "memory", inMemory: true) }

    private let service: String
    private let inMemory: Bool
    private var memory: [String: String] = [:]
    private let lock = NSLock()

    private init(service: String, inMemory: Bool) {
        self.service = service
        self.inMemory = inMemory
    }

    func get(_ account: String) -> String? {
        if inMemory { return lock.withLock { memory[account] } }
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Stores a value (an empty value deletes it). Returns false when the Keychain refused.
    @discardableResult
    func set(_ value: String, for account: String) -> Bool {
        if inMemory {
            lock.withLock { memory[account] = value.isEmpty ? nil : value }
            return true
        }
        SecItemDelete(base(account) as CFDictionary)
        guard !value.isEmpty else { return true }
        var item = base(account)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}
