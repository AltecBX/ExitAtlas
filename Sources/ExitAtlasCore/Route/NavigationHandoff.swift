import Foundation

/// Links that hand a destination to another navigation app. Waze: the official deep link
/// (https://developers.google.com/waze/deeplinks), which opens the Waze app when it is installed and the
/// Waze website otherwise. Port of web/js/engine/handoff.js.
public enum NavigationHandoff {
    /// Waze's App Store page, for when the app is not installed.
    public static let wazeAppStore = URL(string: "https://apps.apple.com/us/app/id323229106")!

    /// "https://waze.com/ul?ll=40.758895,-73.985131&navigate=yes&utm_source=…": drive to the coordinate.
    /// Nil for a coordinate that is not on Earth.
    public static func waze(to c: GeoCoordinate, source: String) -> URL? {
        guard c.isValid else { return nil }
        var u = URLComponents()
        u.scheme = "https"
        u.host = "waze.com"
        u.path = "/ul"
        u.queryItems = [URLQueryItem(name: "ll", value: String(format: "%.6f,%.6f", c.latitude, c.longitude)),
                        URLQueryItem(name: "navigate", value: "yes"), URLQueryItem(name: "utm_source", value: source)]
        return u.url
    }
}
