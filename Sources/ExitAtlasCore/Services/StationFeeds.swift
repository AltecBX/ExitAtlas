import Foundation

/// DC fast chargers along a route from the DOE Alternative Fuels Data Center `nearby-route` API (one
/// request per route; the same scheme as web/js/app/chargers.js). The app does the networking.
public enum ChargerFeed {
    public static let endpoint = URL(string: "https://developer.nlr.gov/api/alt-fuel-stations/v1/nearby-route.json")!
    public static let demoKey = "DEMO_KEY"

    /// The route as WKT, sampled every `step` meters (the search corridor is 2.5 miles wide).
    public static func routeWKT(_ polyline: RoutePolyline, step: Double = 2000) -> String {
        var points: [GeoCoordinate] = []
        var d = 0.0
        while d < polyline.length {
            points.append(polyline.coordinate(at: d))
            d += step
        }
        points.append(polyline.coordinate(at: polyline.length))
        let pairs = points.map { String(format: "%.5f %.5f", $0.longitude, $0.latitude) }
        return "LINESTRING(\(pairs.joined(separator: ", ")))"
    }

    /// Form body for the POST. `teslaOnly` limits the search to the Tesla network.
    public static func requestBody(_ polyline: RoutePolyline, teslaOnly: Bool) -> String {
        var items = [("route", routeWKT(polyline)), ("distance", "2.5"), ("fuel_type", "ELEC"),
                     ("ev_charging_level", "dc_fast"), ("status", "E"), ("limit", "all")]
        if teslaOnly { items.append(("ev_network", "Tesla")) }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return items.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }.joined(separator: "&")
    }

    /// Open DC fast chargers from a response.
    public static func parse(_ data: Data) throws -> [ChargerStation] {
        struct Response: Decodable {
            struct Station: Decodable {
                let id: Int
                let station_name: String?
                let latitude: Double
                let longitude: Double
                let ev_network: String?
                let ev_dc_fast_num: Int?
                let ev_connector_types: [String]?
                let access_days_time: String?
                let ev_pricing: String?
                let street_address: String?
                let city: String?
                let state: String?
                let status_code: String?
            }
            let fuel_stations: [Station]?
        }
        let response = try JSONDecoder().decode(Response.self, from: data)
        return (response.fuel_stations ?? []).compactMap { s in
            guard s.status_code == "E", (s.ev_dc_fast_num ?? 0) > 0 else { return nil }
            let access = s.access_days_time ?? ""
            let lowered = access.lowercased()
            return ChargerStation(
                id: s.id, name: s.station_name ?? "Charger", coordinate: GeoCoordinate(latitude: s.latitude, longitude: s.longitude),
                network: s.ev_network ?? "", stalls: s.ev_dc_fast_num ?? 0, connectors: s.ev_connector_types ?? [],
                openToOthers: lowered.contains("nacs partner") || lowered.contains("non-tesla") || lowered.contains("all ev"),
                hours: access, pricing: s.ev_pricing ?? "",
                address: [s.street_address, s.city, s.state].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
        }
    }
}

/// Gas prices, business hours and restrooms near an exit from Google Places API (New) Nearby Search,
/// using the driver's own key (the same request as web/js/app/prices.js). Google's terms: show Google
/// attribution, never on a non-Google map, and do not store prices. Hours and the restroom field ride on
/// the same request: Google bills a Nearby Search once, at the highest SKU among its fields, and
/// fuelOptions is already the highest (Enterprise + Atmosphere).
public enum GasPriceFeed {
    public static let endpoint = URL(string: "https://places.googleapis.com/v1/places:searchNearby")!
    public static let fieldMask = "places.id,places.displayName,places.location,places.fuelOptions,places.currentOpeningHours,places.restroom"

    public enum Grade: String, Sendable, CaseIterable, Codable {
        case regular = "REGULAR_UNLEADED", midgrade = "MIDGRADE", premium = "PREMIUM", diesel = "DIESEL"

        public var name: String {
            switch self {
            case .regular: return "Regular"
            case .midgrade: return "Midgrade"
            case .premium: return "Premium"
            case .diesel: return "Diesel"
            }
        }

        public init(_ fuel: VehicleCatalog.Fuel) {
            switch fuel {
            case .premium: self = .premium
            case .midgrade: self = .midgrade
            case .diesel: self = .diesel
            case .regular, .electric: self = .regular
            }
        }
    }

    public struct Price: Sendable, Hashable {
        public let dollars: Double
        public let currency: String
        public let updated: Date?
    }

    public struct Station: Sendable, Hashable, Identifiable {
        public let id: String
        public let name: String
        public let coordinate: GeoCoordinate?
        public let prices: [Grade: Price]
        /// Business hours for the coming week (Google's currentOpeningHours), nil when not listed.
        public let periods: [GooglePeriod]?
        /// Google's restroom field, nil when not listed.
        public let restroom: Bool?

        public init(id: String, name: String, coordinate: GeoCoordinate?, prices: [Grade: Price], periods: [GooglePeriod]? = nil,
                    restroom: Bool? = nil) {
            self.id = id
            self.name = name
            self.coordinate = coordinate
            self.prices = prices
            self.periods = periods
            self.restroom = restroom
        }
    }

    public static func requestBody(near c: GeoCoordinate, radius: Double = 1600) -> Data {
        let body: [String: Any] = [
            "includedTypes": ["gas_station"], "maxResultCount": 10, "rankPreference": "DISTANCE",
            "locationRestriction": ["circle": ["center": ["latitude": c.latitude, "longitude": c.longitude], "radius": radius]],
        ]
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
    }

    public static func parse(_ data: Data) throws -> [Station] {
        struct Response: Decodable {
            struct Place: Decodable {
                struct Name: Decodable { let text: String? }
                struct Location: Decodable { let latitude: Double; let longitude: Double }
                struct FuelOptions: Decodable { let fuelPrices: [FuelPrice]? }
                struct FuelPrice: Decodable {
                    struct Money: Decodable { let currencyCode: String?; let units: String?; let nanos: Int? }
                    let type: String
                    let price: Money?
                    let updateTime: String?
                }
                let id: String
                let displayName: Name?
                let location: Location?
                let fuelOptions: FuelOptions?
                struct Hours: Decodable { let periods: [GooglePeriod]? }
                let currentOpeningHours: Hours?
                let restroom: Bool?
            }
            let places: [Place]?
        }
        let iso = ISO8601DateFormatter()
        let isoFraction = ISO8601DateFormatter()
        isoFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try JSONDecoder().decode(Response.self, from: data).places?.map { p in
            var prices: [Grade: Price] = [:]
            for fp in p.fuelOptions?.fuelPrices ?? [] {
                guard let grade = Grade(rawValue: fp.type) else { continue }
                let value = Double(fp.price?.units ?? "0").map { $0 + Double(fp.price?.nanos ?? 0) / 1e9 } ?? 0
                guard value > 0 else { continue }
                let updated = fp.updateTime.flatMap { iso.date(from: $0) ?? isoFraction.date(from: $0) }
                prices[grade] = Price(dollars: value, currency: fp.price?.currencyCode ?? "USD", updated: updated)
            }
            return Station(id: p.id, name: p.displayName?.text ?? "Gas station",
                           coordinate: p.location.map { GeoCoordinate(latitude: $0.latitude, longitude: $0.longitude) },
                           prices: prices, periods: p.currentOpeningHours?.periods.flatMap { $0.isEmpty ? nil : $0 },
                           restroom: p.restroom)
        } ?? []
    }

    /// Stations with a price for the grade, cheapest first.
    public static func priced(_ stations: [Station], grade: Grade) -> [Station] {
        stations.filter { $0.prices[grade] != nil }.sorted { $0.prices[grade]!.dollars < $1.prices[grade]!.dollars }
    }
}
