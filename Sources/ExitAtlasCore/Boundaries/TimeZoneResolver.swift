import Foundation

/// Resolves the IANA time zone at a location from the bundled USDOT/BTS time zone polygons.
///
/// The polygons give the standard zone (Eastern, Central, ...). Daylight saving observance is
/// derived from the state: Arizona and Hawaii do not observe it. Known limitation: the Navajo
/// Nation inside Arizona observes daylight saving time but resolves to America/Phoenix here.
public struct TimeZoneResolver: Sendable {
    public let zones: RegionIndex

    public init(zones: RegionIndex) {
        self.zones = zones
    }

    public func identifier(at coordinate: GeoCoordinate, stateCode: String?) -> String? {
        guard let zone = zones.region(containing: coordinate) else { return nil }
        return Self.ianaIdentifier(zone: zone.code, stateCode: stateCode)
    }

    public func timeZone(at coordinate: GeoCoordinate, stateCode: String?) -> TimeZone? {
        identifier(at: coordinate, stateCode: stateCode).flatMap(TimeZone.init(identifier:))
    }

    public static func ianaIdentifier(zone: String, stateCode: String?) -> String? {
        switch zone {
        case "Eastern": return "America/New_York"
        case "Central": return "America/Chicago"
        case "Mountain": return stateCode == "AZ" ? "America/Phoenix" : "America/Denver"
        case "Pacific": return "America/Los_Angeles"
        case "Alaska": return "America/Anchorage"
        case "Hawaii-Aleutian": return stateCode == "AK" ? "America/Adak" : "Pacific/Honolulu"
        case "Atlantic": return "America/Puerto_Rico"
        default: return nil
        }
    }
}
