import Foundation

/// Rest areas, welcome centers, service plazas and parking areas on the interstate mainline
/// (restareas.json from tools/data-pipeline/build_rest_areas.py). Port of web/js/engine/restareas.js.
public enum RestAreaKind: String, Sendable, Codable, Hashable, CaseIterable {
    case rest, welcome, plaza, parking

    public var title: String {
        switch self {
        case .rest: return "Rest Area"
        case .welcome: return "Welcome Center"
        case .plaza: return "Service Plaza"
        case .parking: return "Parking Area"
        }
    }

    /// Sign lettering, two lines.
    public var signWords: (String, String) {
        switch self {
        case .rest: return ("REST", "AREA")
        case .welcome: return ("WELCOME", "CENTER")
        case .plaza: return ("SERVICE", "PLAZA")
        case .parking: return ("PARKING", "AREA")
        }
    }
}

/// Amenities OpenStreetMap can tag on a rest area, in display order.
public enum RestAreaAmenity: String, Sendable, Codable, Hashable, CaseIterable {
    case toilets, accessible, water, vending, picnic, pets, wifi, info, shower, dump, trucks

    public var label: String {
        switch self {
        case .toilets: return "Restrooms"
        case .accessible: return "Accessible"
        case .water: return "Water"
        case .vending: return "Vending"
        case .picnic: return "Picnic"
        case .pets: return "Pet area"
        case .wifi: return "Wi-Fi"
        case .info: return "Visitor info"
        case .shower: return "Showers"
        case .dump: return "RV dump"
        case .trucks: return "Trucks"
        }
    }

    /// A "no" worth showing: no restrooms, no water, or closed to trucks.
    public var showsWhenAbsent: Bool { self == .toilets || self == .water || self == .trucks }
}

public struct RestAreaDataset: Sendable {
    public struct FHWA: Sendable, Hashable, Decodable {
        public let id: Int
        public let truckSpaces: Int?
    }

    public struct Item: Sendable, Hashable, Decodable {
        public let id: String
        public let lat: Double
        public let lon: Double
        public let kind: RestAreaKind
        public let name: String
        public let nameSource: String?
        public let road: String
        /// Travel bearing of the carriageway served; nil in the median or on an undivided road.
        public let bearing: Double?
        public let amenities: [String: Bool]?
        public let hours: String?
        public let truckSpaces: Int?
        public let checked: String?
        public let fhwa: FHWA?
        public let gas: [String]?
        public let food: [String]?
        public let ev: [String]?

        public var coordinate: GeoCoordinate { GeoCoordinate(latitude: lat, longitude: lon) }
    }

    public struct Metadata: Sendable, Decodable {
        public let kind: String
        public let source: String
        public let tagsFetched: String?
        public let license: String
        public let attribution: String
        public let count: Int
        public let generatedAt: String?

        enum CodingKeys: String, CodingKey {
            case kind, source, license, attribution, count
            case tagsFetched = "tags_fetched"
            case generatedAt = "generated_at"
        }
    }

    private struct File: Decodable {
        let meta: Metadata
        let items: [Item]
    }

    public let metadata: Metadata
    public let items: [Item]

    public init(data: Data) throws {
        let file = try JSONDecoder().decode(File.self, from: data)
        guard file.meta.kind == "restareas" else { throw DatasetError.badMagic(expected: "restareas", found: file.meta.kind) }
        metadata = file.meta
        items = file.items
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url))
    }
}

/// A rest area the route passes on the driver's side, with duplicate OSM records merged.
public struct RouteRestArea: Sendable, Hashable, Identifiable {
    public enum Side: String, Sendable, Hashable {
        /// On the driver's side of a divided highway.
        case yours
        /// In the median or on an undivided road: serves both directions.
        case both
    }

    public let id: String
    public let ordinal: Int
    public let kind: RestAreaKind
    public let name: String
    public let nameFromFHWA: Bool
    public let road: String
    public let coordinate: GeoCoordinate
    public let distanceAlongRoute: Double
    public let offsetFromRoute: Double
    public let side: Side
    /// Only amenities OpenStreetMap tags. Missing keys are unknown, never "no".
    public let amenities: [RestAreaAmenity: Bool]
    public let hours: String?
    public let truckSpaces: Int?
    public let fhwaTruckSpaces: Int?
    public let checked: String?
    public let gas: [String]
    public let food: [String]
    public let ev: [String]
    /// OSM ids ("way/123") of the merged records, for links to the source.
    public let osmIDs: [String]

    public var title: String { name.isEmpty ? kind.title : name }

    /// Verified amenities in display order: every "yes", and the "no" values worth showing.
    public var badges: [(amenity: RestAreaAmenity, value: Bool)] {
        RestAreaAmenity.allCases.compactMap { a in
            guard let v = amenities[a], v || a.showsWhenAbsent else { return nil }
            return (a, v)
        }
    }

    public var hoursText: String? {
        guard let hours, !hours.isEmpty else { return nil }
        return hours == "24/7" ? "Open 24 hours" : hours
    }

    public static func == (a: RouteRestArea, b: RouteRestArea) -> Bool { a.id == b.id && a.distanceAlongRoute == b.distanceAlongRoute }
    public func hash(into h: inout Hasher) { h.combine(id); h.combine(distanceAlongRoute) }
}

/// Places rest areas on a route by geometry: within 450 m, on the driver's side (bearing within 50
/// degrees of the route and not more than 40 m to its left), and only where the route is on an
/// interstate or a named turnpike when the route says which road it is on.
public struct RestAreaMatcher: Sendable {
    public var maxOffset = 450.0
    public var maxBearingDifference = 50.0
    public var maxLeftOffset = 40.0
    public var mergeWithin = 600.0

    public init() {}

    public func match(route: RoutePolyline, dataset: RestAreaDataset,
                      highwayAt: ((Double) -> [HighwayRef])? = nil) -> [RouteRestArea] {
        let box = route.boundingBox.expanded(byMeters: maxOffset)
        var found: [(item: RestAreaDataset.Item, along: Double, offset: Double, side: RouteRestArea.Side)] = []
        for item in dataset.items where box.contains(item.coordinate) {
            for p in route.projections(of: item.coordinate, within: maxOffset) {
                var side = RouteRestArea.Side.both
                if let b = item.bearing {
                    if Geodesy.angleDifference(b, route.bearing(at: p.distanceAlong)) > maxBearingDifference { continue }
                    if p.signedOffset < -maxLeftOffset { continue }
                    side = .yours
                }
                if let refs = highwayAt?(p.distanceAlong), !refs.isEmpty,
                   !refs.contains(where: { $0.kind == .interstate || $0.kind == .named }) { continue }
                found.append((item, p.distanceAlong, p.offset, side))
            }
        }
        found.sort { $0.along < $1.along }
        var groups: [[(item: RestAreaDataset.Item, along: Double, offset: Double, side: RouteRestArea.Side)]] = []
        for f in found {
            if let first = groups.last?.first, f.along - (groups.last!.last!.along) <= mergeWithin,
               Self.group(first.item.kind) == Self.group(f.item.kind) {
                groups[groups.count - 1].append(f)
            } else {
                groups.append([f])
            }
        }
        return groups.enumerated().map { ordinal, g in
            let records = g.map(\.item)
            let named = records.first { !$0.name.isEmpty && $0.nameSource != "fhwa" } ?? records.first { !$0.name.isEmpty }
            var amenities: [RestAreaAmenity: Bool] = [:]
            for r in records {
                for (k, v) in r.amenities ?? [:] {
                    guard let a = RestAreaAmenity(rawValue: k) else { continue }
                    if amenities[a] == nil || v { amenities[a] = v }
                }
            }
            func list(_ key: KeyPath<RestAreaDataset.Item, [String]?>) -> [String] {
                var out: [String] = []
                for r in records { for n in r[keyPath: key] ?? [] where !out.contains(n) { out.append(n) } }
                return out
            }
            let kind: RestAreaKind = records.contains { $0.kind == .welcome } ? .welcome : Self.group(records[0].kind)
            return RouteRestArea(
                id: "rest-\(records[0].id)", ordinal: ordinal, kind: kind, name: named?.name ?? "",
                nameFromFHWA: named?.nameSource == "fhwa", road: records[0].road, coordinate: records[0].coordinate,
                distanceAlongRoute: g[0].along, offsetFromRoute: g[0].offset, side: g[0].side, amenities: amenities,
                hours: records.lazy.compactMap(\.hours).first, truckSpaces: records.lazy.compactMap(\.truckSpaces).first,
                fhwaTruckSpaces: records.lazy.compactMap { $0.fhwa?.truckSpaces }.first,
                checked: records.compactMap(\.checked).max(), gas: list(\.gas), food: list(\.food), ev: list(\.ev),
                osmIDs: records.map(\.id))
        }
    }

    private static func group(_ kind: RestAreaKind) -> RestAreaKind {
        kind == .welcome ? .rest : kind
    }
}

/// Stretches without gas, from gas exits and service plazas with gas.
public enum GasGaps {
    public struct Stop: Sendable, Hashable {
        public let distance: Double
        public let exit: RouteExit?
        public let restArea: RouteRestArea?

        public init(distance: Double, exit: RouteExit? = nil, restArea: RouteRestArea? = nil) {
            self.distance = distance
            self.exit = exit
            self.restArea = restArea
        }

        public var key: String { exit?.id ?? restArea?.id ?? "\(distance)" }
        public var title: String { exit?.displayTitle ?? restArea?.title ?? "Gas" }
    }

    public struct Gap: Sendable, Hashable {
        public let from: Double
        public let to: Double
        /// The stop where the gap starts; nil when it starts at the driver.
        public let before: Stop?
        public let after: Stop?
        /// The gap runs past the end of the window, so it is at least `length` long.
        public let open: Bool
        public var length: Double { to - from }
    }

    /// Gas stops on a plan: exits with a gas station listed, and service plazas listing gas.
    /// `services` returns an exit's services (the app passes its cache).
    public static func stops(plan: TripPlan, services: (RouteExit) -> [ExitService]) -> [Stop] {
        var stops: [Stop] = []
        for e in plan.exits where services(e).contains(where: { $0.place.category == .gas }) {
            stops.append(Stop(distance: e.distanceAlongRoute, exit: e))
        }
        for r in plan.restAreas where !r.gas.isEmpty {
            stops.append(Stop(distance: r.distanceAlongRoute, restArea: r))
        }
        return stops.sorted { $0.distance < $1.distance }
    }

    /// Gaps of at least `minimum` meters between `start` and `end`.
    public static func find(stops: [Stop], from start: Double, to end: Double, minimum: Double,
                            routeLength: Double = .infinity) -> [Gap] {
        var gaps: [Gap] = []
        var last = start
        var before: Stop? = nil
        for s in stops where s.distance > start {
            if s.distance > end { break }
            if s.distance - last >= minimum {
                gaps.append(Gap(from: last, to: s.distance, before: before, after: s, open: false))
            }
            last = s.distance
            before = s
        }
        if end - last >= minimum {
            gaps.append(Gap(from: last, to: end, before: before, after: nil, open: end < routeLength))
        }
        return gaps
    }
}
