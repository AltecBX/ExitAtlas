#if GOOGLE_NAVIGATION
import Foundation
import GoogleNavigation

/// The experimental Google navigation mode's own settings (docs/14): the API key (Keychain, this device only),
/// whether the driver agreed to ExitAtlas's explanation, and the destinations requested this month (each one is
/// a "Navigation Request" billed to the key's Google account after the first 1,000). Kept outside the saved
/// profile, so nothing here can change a saved preference, and the regular build has none of it.
@MainActor
@Observable
final class GoogleNavigationAccount {
    static let shared = GoogleNavigationAccount()
    /// Destinations Google does not bill each month; then $25 per 1,000 (Navigation Request SKU, 2026-10).
    static let freeDestinationsPerMonth = 1000

    var key: String { didSet { KeychainStore.shared.set(key.trimmingCharacters(in: .whitespacesAndNewlines), for: "googleNavigationKey") } }
    var consented: Bool { didSet { UserDefaults.standard.set(consented, forKey: "googleNavigation.consented") } }
    private(set) var destinationsThisMonth: Int
    /// The key Google was given this launch: Google reads it once, so a changed key needs a restart.
    @ObservationIgnored private var providedKey: String?

    private init() {
        key = KeychainStore.shared.get("googleNavigationKey") ?? ""
        consented = UserDefaults.standard.bool(forKey: "googleNavigation.consented")
        destinationsThisMonth = UserDefaults.standard.integer(forKey: Self.monthKey)
    }

    var isConfigured: Bool { !trimmedKey.isEmpty }
    private var trimmedKey: String { key.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// True when Google has this key (given now, or earlier this launch); false for no key or a key changed
    /// after Google already read one.
    func provideKeyToGoogle() -> Bool {
        guard isConfigured else { return false }
        if let providedKey { return providedKey == trimmedKey }
        guard GMSServices.provideAPIKey(trimmedKey) else { return false }
        providedKey = trimmedKey
        return true
    }

    var needsRestartForKey: Bool { providedKey.map { $0 != trimmedKey } ?? false }

    /// Counted before each request, since Google bills the request whether or not a route is found.
    func count(destinations n: Int) {
        destinationsThisMonth = UserDefaults.standard.integer(forKey: Self.monthKey) + n
        UserDefaults.standard.set(destinationsThisMonth, forKey: Self.monthKey)
    }

    private static var monthKey: String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: Date())
        return "googleNavigation.destinations.\(c.year ?? 0)-\(c.month ?? 0)"
    }
}
#endif
