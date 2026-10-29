import ExitAtlasCore
import UIKit

/// Hands a destination to Waze with its official deep link (NavigationHandoff), as Waze documents for iOS:
/// the link when Waze is installed, its App Store page when it is not.
@MainActor
enum WazeHandoff {
    static func open(to c: GeoCoordinate) {
        let installed = URL(string: "waze://").map { UIApplication.shared.canOpenURL($0) } ?? false
        let source = Bundle.main.bundleIdentifier ?? "com.cobyconstruction.exitatlas"
        guard let url = installed ? NavigationHandoff.waze(to: c, source: source) : NavigationHandoff.wazeAppStore else { return }
        UIApplication.shared.open(url)
    }
}
