import Foundation

/// A service reachable from a route exit, with the detour it costs.
public struct ExitService: Sendable, Hashable, Identifiable {
    public enum DetourBasis: String, Sendable, Codable {
        /// Twice the routed one way drive distance from the exit to the place (OSRM, pre-computed).
        case routedOneWayDoubled
        /// No routed distance in the data: straight line distance times 1.4, doubled. Rough.
        case straightLineEstimate
    }

    public let place: Place
    public let exitID: String
    public let straightLineMeters: Double
    /// Estimated extra driving to leave the highway, reach the place and return.
    public let detourMeters: Double
    public let detourSeconds: Double?
    public let detourBasis: DetourBasis
    public let reachable: Bool?
    public let rank: Int

    public var id: String { "\(exitID)|\(place.id)" }
}

public extension InterstateDataset {
    /// All services linked to a route exit, deduplicated across merged exit records.
    func services(for exit: RouteExit) -> [ExitService] {
        var byPlace: [String: ExitService] = [:]
        for record in exit.records {
            for link in links(for: record) {
                if link.reachable == false { continue }
                let service: ExitService
                if let drive = link.driveMeters {
                    service = ExitService(
                        place: link.place, exitID: exit.id, straightLineMeters: link.straightLineMeters,
                        detourMeters: 2 * drive, detourSeconds: link.driveSeconds.map { 2 * $0 },
                        detourBasis: .routedOneWayDoubled, reachable: link.reachable, rank: link.rank)
                } else {
                    service = ExitService(
                        place: link.place, exitID: exit.id, straightLineMeters: link.straightLineMeters,
                        detourMeters: 2 * 1.4 * link.straightLineMeters, detourSeconds: nil,
                        detourBasis: .straightLineEstimate, reachable: link.reachable, rank: link.rank)
                }
                if let existing = byPlace[link.place.id], existing.detourMeters <= service.detourMeters { continue }
                byPlace[link.place.id] = service
            }
        }
        return byPlace.values.sorted {
            $0.place.category.rawValue != $1.place.category.rawValue
                ? $0.place.category.rawValue < $1.place.category.rawValue
                : $0.detourMeters < $1.detourMeters
        }
    }
}

/// One condition an exit must satisfy, for example "a Starbucks" or "an EV charger".
public struct ServiceRequirement: Sendable, Hashable {
    public var category: PlaceCategory?
    /// Case and accent insensitive match against the brand or name ("starbucks", "cracker barrel").
    public var nameOrBrand: String?
    /// Upper bound on the estimated round trip detour for this service.
    public var maxDetourMeters: Double?

    public init(category: PlaceCategory? = nil, nameOrBrand: String? = nil, maxDetourMeters: Double? = nil) {
        self.category = category
        self.nameOrBrand = nameOrBrand
        self.maxDetourMeters = maxDetourMeters
    }

    public func matches(_ service: ExitService) -> Bool {
        if let category, service.place.category != category { return false }
        if let maxDetourMeters, service.detourMeters > maxDetourMeters { return false }
        if let query = nameOrBrand?.trimmingCharacters(in: .whitespaces), !query.isEmpty {
            let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
            let normalizedQuery = Self.simplified(query)
            let fields = [service.place.brand, service.place.name].map(Self.simplified)
            if !fields.contains(where: { $0.range(of: normalizedQuery, options: options) != nil }) { return false }
        }
        return true
    }

    /// Lowercases and removes punctuation so "Dunkin'" matches "dunkin" and "McDonald's" matches "mcdonalds".
    static func simplified(_ s: String) -> String {
        String(s.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) || $0 == " " })
    }
}

/// A request like "an exit with a Starbucks and an EV charger in the next 30 miles".
public struct AlongRouteQuery: Sendable {
    public var requirements: [ServiceRequirement]
    /// Window along the route, in meters from the start of the route.
    public var fromDistance: Double
    public var toDistance: Double

    public init(requirements: [ServiceRequirement], fromDistance: Double, toDistance: Double) {
        self.requirements = requirements
        self.fromDistance = fromDistance
        self.toDistance = toDistance
    }
}

public struct AlongRouteMatch: Sendable, Identifiable {
    public let exit: RouteExit
    /// For each requirement, in order, the services at this exit that satisfy it (best first).
    public let matchesPerRequirement: [[ExitService]]
    /// Sum of the best detour for each requirement. Assumes separate trips per place, so it is
    /// an upper bound when places share a parking lot.
    public let combinedDetourMeters: Double
    public var id: String { exit.id }
}

public struct AlongRouteSearch: Sendable {
    public let dataset: InterstateDataset

    public init(dataset: InterstateDataset) {
        self.dataset = dataset
    }

    /// Exits in the window where every requirement is satisfied, in route order.
    public func search(_ query: AlongRouteQuery, exits: [RouteExit]) -> [AlongRouteMatch] {
        var out: [AlongRouteMatch] = []
        for exit in exits where exit.distanceAlongRoute >= query.fromDistance && exit.distanceAlongRoute <= query.toDistance {
            let services = dataset.services(for: exit)
            var perRequirement: [[ExitService]] = []
            var ok = true
            for req in query.requirements {
                let hits = services.filter(req.matches).sorted { $0.detourMeters < $1.detourMeters }
                if hits.isEmpty { ok = false; break }
                perRequirement.append(hits)
            }
            if ok {
                let combined = perRequirement.reduce(0) { $0 + ($1.first?.detourMeters ?? 0) }
                out.append(AlongRouteMatch(exit: exit, matchesPerRequirement: perRequirement,
                                           combinedDetourMeters: combined))
            }
        }
        return out
    }
}
