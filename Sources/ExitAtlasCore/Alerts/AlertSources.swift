import Foundation

/// Converters from provider formats to the Road Intelligence schema. Pure functions, tested on real captured
/// responses; fetching, caching and retries live in the app. Port of web/js/engine/alertsources.js.
public enum AlertSources {
    /// National Weather Service events that matter on the road, and the kind each becomes. Marine, beach,
    /// air quality, frost and heat products are left out; watches are left out (favorable, not occurring).
    public static let nwsEvents: [String: RoadIntel.Kind] = [
        "Tornado Warning": .weather, "Severe Thunderstorm Warning": .weather, "Snow Squall Warning": .weather,
        "Blizzard Warning": .weather, "Ice Storm Warning": .weather, "Winter Storm Warning": .weather,
        "Winter Weather Advisory": .weather, "Dense Fog Advisory": .weather, "Freezing Fog Advisory": .weather,
        "High Wind Warning": .weather, "Wind Advisory": .weather, "Dust Storm Warning": .weather,
        "Blowing Dust Warning": .weather, "Hurricane Warning": .weather, "Tropical Storm Warning": .weather,
        "Extreme Wind Warning": .weather,
        "Flash Flood Warning": .flooding, "Flood Warning": .flooding, "Coastal Flood Warning": .flooding,
    ]

    static let nwsSeverity: [String: RoadIntel.Severity] = ["Extreme": .severe, "Severe": .major, "Moderate": .moderate, "Minor": .minor]
    public static let nwsSource = RoadIntel.Source(id: "nws", name: "National Weather Service")

    static func date(_ v: JSONValue?) -> Date? {
        guard let s = v?.string else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }

    /// NWS alerts returned by point queries along the route, as incidents. An alert returned at several
    /// points is one incident. An alert with a polygon keeps it; a zone or county alert (no polygon) is placed
    /// at the points where NWS returned it.
    public static func nwsIncidents(_ responses: [(point: GeoCoordinate, features: [JSONValue])]) -> [RoadIntel.Incident] {
        var order: [String] = []
        var byID: [String: RoadIntel.Incident] = [:]
        for (point, features) in responses {
            for f in features {
                guard let p = f["properties"], let event = p["event"]?.string, let kind = nwsEvents[event],
                      p["status"]?.string == "Actual" else { continue }
                let id = "nws:\(p["id"]?.string ?? f["id"]?.string ?? event)"
                if var known = byID[id] {
                    if case .points(var cs) = known.geometry {
                        cs.append(point)
                        known.geometry = .points(cs)
                        byID[id] = known
                    }
                    continue
                }
                var incident = RoadIntel.Incident(
                    id: id, kind: kind, description: event, source: nwsSource, verification: .official,
                    reportedAt: date(p["sent"]), updatedAt: date(p["sent"]), startsAt: date(p["onset"]) ?? date(p["effective"]),
                    endsAt: date(p["ends"]) ?? date(p["expires"]), expiresAt: date(p["expires"]),
                    geometry: nwsGeometry(f["geometry"]) ?? .points([point]), road: nil, direction: "both",
                    severity: nwsSeverity[p["severity"]?.string ?? ""] ?? .unknown)
                incident.detail = p["headline"]?.string
                incident.area = p["areaDesc"]?.string
                order.append(id)
                byID[id] = incident
            }
        }
        return order.compactMap { byID[$0] }
    }

    static func nwsGeometry(_ g: JSONValue?) -> RoadIntel.Geometry? {
        func ring(_ v: JSONValue) -> [GeoCoordinate] {
            (v.array ?? []).compactMap { pt in
                guard let a = pt.array, a.count >= 2, let lon = a[0].number, let lat = a[1].number else { return nil }
                return GeoCoordinate(latitude: lat, longitude: lon)
            }
        }
        switch g?["type"]?.string {
        case "Polygon":
            guard let outer = g?["coordinates"]?.array?.first else { return nil }
            return .polygon([ring(outer)])
        case "MultiPolygon":
            return .polygon((g?["coordinates"]?.array ?? []).compactMap { $0.array?.first.map(ring) })
        default:
            return nil
        }
    }
}
