import Foundation

/// Fuel and charging stop planning from the car's own range reading (the same planner as the web
/// version, web/js/engine/fuel.js; the tests use the same cases).
///
/// The driver enters the range the dashboard shows (or a fill up or charge resets it). Range left
/// counts down with miles actually driven (the trip ledger, which includes off route driving). The
/// planner picks the last stop reached with about the chosen buffer still left, preferring the
/// driver's favorite gas brands anywhere in range.

/// The range the driver entered and the driven total at that moment.
public struct FuelReading: Sendable, Codable, Hashable {
    public var rangeMeters: Double
    public var drivenAtEntry: Double

    public init(rangeMeters: Double, drivenAtEntry: Double) {
        self.rangeMeters = rangeMeters
        self.drivenAtEntry = drivenAtEntry
    }

    /// Range left after driving to `drivenTotal` (never negative).
    public func rangeLeft(drivenTotal: Double) -> Double {
        max(0, rangeMeters - max(0, drivenTotal - drivenAtEntry))
    }
}

/// A DC fast charger from the DOE Alternative Fuels Data Center.
public struct ChargerStation: Sendable, Codable, Hashable, Identifiable {
    public var id: Int
    public var name: String
    public var coordinate: GeoCoordinate
    public var network: String
    public var stalls: Int
    public var connectors: [String]
    /// A Tesla site that lets other cars charge (NACS partner access).
    public var openToOthers: Bool
    public var hours: String
    public var pricing: String
    public var address: String

    public init(id: Int, name: String, coordinate: GeoCoordinate, network: String = "", stalls: Int = 0,
                connectors: [String] = [], openToOthers: Bool = false, hours: String = "", pricing: String = "",
                address: String = "") {
        self.id = id
        self.name = name
        self.coordinate = coordinate
        self.network = network
        self.stalls = stalls
        self.connectors = connectors
        self.openToOthers = openToOthers
        self.hours = hours
        self.pricing = pricing
        self.address = address
    }
}

/// A charger placed on the route.
public struct ChargerOnRoute: Sendable, Hashable {
    public let station: ChargerStation
    /// Meters along the route.
    public let along: Double
    /// Straight line distance from the route.
    public let offset: Double
}

/// A place to refuel or charge, before range is applied.
public struct StopCandidate: Sendable {
    public enum Kind: Sendable {
        case gas(exit: RouteExit, stations: [ExitService])
        case charge(ChargerOnRoute)
    }

    public let kind: Kind
    public let key: String
    public let along: Double
    /// Round trip detour off the route.
    public let detourMeters: Double
    public let favorite: Bool

    public var exit: RouteExit? { if case let .gas(exit, _) = kind { return exit } else { return nil } }
    public var charger: ChargerOnRoute? { if case let .charge(c) = kind { return c } else { return nil } }
    public var gasStations: [ExitService] { if case let .gas(_, s) = kind { return s } else { return [] } }
}

/// A candidate with what range is left on arrival.
public struct PlannedStop: Sendable {
    public let candidate: StopCandidate
    public let ahead: Double
    public let rangeOnArrival: Double
    public let eta: Date

    public var key: String { candidate.key }
    public var favorite: Bool { candidate.favorite }
}

public struct RangePlan: Sendable {
    public enum Status: String, Sendable {
        /// Enough to arrive with the buffer.
        case destination
        case planned
        /// No stop keeps the buffer.
        case low
        /// Nothing listed before empty.
        case none
    }

    public var status: Status
    public var range: Double
    public var buffer: Double
    public var recommended: PlannedStop?
    /// Up to two stops before the recommended one, nearest to it first.
    public var earlier: [PlannedStop]
    /// The last stop before empty, when it would arrive under the buffer.
    public var lastChance: PlannedStop?
    /// Every reachable candidate in route order.
    public var stations: [PlannedStop]
    public var destinationSpare: Double?
    /// A favorite brand is set but none keeps the buffer.
    public var favoriteMissing: Bool
    /// The first favorite ahead, even beyond the buffer, when `favoriteMissing`.
    public var nextFavorite: PlannedStop?
    /// The latest stop that keeps the buffer, when a favorite was picked before it.
    public var closestToTarget: PlannedStop?
}

public enum RangePlanner {
    /// Full tank range in meters, or nil when the tank size is unknown.
    public static func fullTankRange(tankGallons: Double?, milesPerGallon: Double) -> Double? {
        guard let tankGallons, tankGallons > 0, milesPerGallon > 0 else { return nil }
        return tankGallons * milesPerGallon * Geodesy.metersPerMile
    }

    /// True when a station name or brand matches one of the favorites ("Shell", "Costco", "Casey's").
    public static func matchesFavorite(_ nameOrBrand: String, favorites: [String]) -> Bool {
        let n = ServiceRequirement.simplified(nameOrBrand)
        guard !n.isEmpty else { return false }
        return favorites.contains { f in
            let s = ServiceRequirement.simplified(f)
            return !s.isEmpty && (n.contains(s) || s.contains(n))
        }
    }

    /// Gas candidates: route exits with gas stations, from the offline exit services.
    public static func gasCandidates(plan: TripPlan, from d: Double, range: Double, dataset: InterstateDataset,
                                     favorites: [String] = []) -> [StopCandidate] {
        var out: [StopCandidate] = []
        for exit in plan.exits(after: d, upTo: d + range) {
            let gas = dataset.services(for: exit).filter { $0.place.category == .gas }
            guard let detour = gas.map(\.detourMeters).min() else { continue }
            let favorite = !favorites.isEmpty && gas.contains {
                matchesFavorite($0.place.brand.isEmpty ? $0.place.name : $0.place.brand, favorites: favorites)
            }
            out.append(StopCandidate(kind: .gas(exit: exit, stations: gas), key: exit.id,
                                     along: exit.distanceAlongRoute, detourMeters: detour, favorite: favorite))
        }
        return out
    }

    /// Places chargers on the route: distance along it and straight line offset. Chargers farther than
    /// `maxOffset` from the route are dropped.
    public static func projectChargers(_ polyline: RoutePolyline, stations: [ChargerStation],
                                       maxOffset: Double = 4500) -> [ChargerOnRoute] {
        stations.compactMap { st in
            polyline.nearestProjection(of: st.coordinate, within: maxOffset)
                .map { ChargerOnRoute(station: st, along: $0.distanceAlong, offset: $0.offset) }
        }
        .sorted { $0.along < $1.along }
    }

    /// Charging candidates ahead. The detour is estimated from the straight line offset (times 1.3, both ways).
    public static func chargerCandidates(_ projected: [ChargerOnRoute], from d: Double, range: Double) -> [StopCandidate] {
        projected.filter { $0.along > d && $0.along <= d + range }.map {
            StopCandidate(kind: .charge($0), key: "charger-\($0.station.id)", along: $0.along,
                          detourMeters: 2 * 1.3 * $0.offset, favorite: false)
        }
    }

    /// Plans where to stop. `candidates` come from `gasCandidates` or `chargerCandidates`, in route order.
    public static func plan(plan: TripPlan, snapshot: TripSnapshot, range: Double, candidates: [StopCandidate],
                            bufferMeters: Double = 50 * Geodesy.metersPerMile, hasDestination: Bool = true,
                            favorites: [String] = []) -> RangePlan {
        let d = snapshot.progress
        let remaining = plan.route.length - d
        var stations: [PlannedStop] = []
        for c in candidates {
            let ahead = c.along - d
            guard ahead > 0 else { continue }
            let rangeOnArrival = range - ahead - c.detourMeters / 2
            guard rangeOnArrival >= 0 else { continue }
            stations.append(PlannedStop(candidate: c, ahead: ahead, rangeOnArrival: rangeOnArrival,
                                        eta: plan.eta(from: d, to: c.along, pace: snapshot.pace, now: snapshot.timestamp)))
        }
        var result = RangePlan(status: .none, range: range, buffer: bufferMeters, recommended: nil, earlier: [],
                               lastChance: nil, stations: stations, destinationSpare: nil, favoriteMissing: false,
                               nextFavorite: nil, closestToTarget: nil)
        if hasDestination, range - remaining >= bufferMeters {
            result.status = .destination
            result.destinationSpare = range - remaining
            return result
        }
        let keeps = stations.filter { $0.rangeOnArrival >= bufferMeters }
        if let latest = keeps.last {
            var pick = latest
            if !favorites.isEmpty {
                if let fav = keeps.last(where: \.favorite) {
                    pick = fav
                    if pick.key != latest.key { result.closestToTarget = latest }
                } else {
                    result.favoriteMissing = true
                    result.nextFavorite = stations.first(where: \.favorite)
                }
            }
            result.status = .planned
            result.recommended = pick
            if let i = stations.firstIndex(where: { $0.key == pick.key }) {
                result.earlier = Array(stations[max(0, i - 2)..<i].reversed())
            }
            if let last = stations.last, last.key != pick.key, last.rangeOnArrival < bufferMeters {
                result.lastChance = last
            }
        } else if let first = stations.first {
            result.status = .low
            result.recommended = (favorites.isEmpty ? nil : stations.first(where: \.favorite)) ?? first
            result.lastChance = stations.count > 1 ? stations.last : nil
        }
        return result
    }
}
