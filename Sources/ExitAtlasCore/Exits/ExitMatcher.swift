import Foundation

/// An exit the selected route actually passes, in route order.
public struct RouteExit: Sendable, Hashable, Identifiable {
    public enum Confidence: String, Sendable, Codable {
        /// Exit node is on the route and its carriageway bearing matches the route direction.
        case high
        /// Exit node is very close to the route but the source has no bearing for it.
        case medium
    }

    /// Stable identifier ("osm-node-123456").
    public let id: String
    /// 0 based position among the route's exits.
    public let ordinal: Int
    public let label: String
    public let name: String
    public let highways: [String]
    public let coordinate: GeoCoordinate
    /// Meters from the start of the route to the exit diverge point.
    public let distanceAlongRoute: Double
    /// Meters between the exit node and the route geometry.
    public let offsetFromRoute: Double
    public let confidence: Confidence
    /// Dataset exit records merged into this exit (same node seen twice, or split ramps with one label).
    public let records: [ExitRecord]

    /// "Exit 23A", "Exit 4A-B", or "Exit" for unnumbered exits.
    public var displayTitle: String { label.isEmpty ? "Exit" : "Exit \(label)" }
}

public struct ExitMatchingOptions: Sendable {
    /// Maximum distance from the route for an exit node with a known bearing.
    public var maxOffset: Double
    /// Maximum distance for exits without bearing data (tighter, since direction cannot be checked).
    public var maxOffsetWithoutBearing: Double
    /// Maximum difference between the route bearing and the exit carriageway bearing.
    public var maxBearingDifference: Double = 40
    /// Consecutive exits with the same label within this distance are one signed exit.
    public var mergeSameLabelWithin: Double = 800

    public init(maxOffset: Double, maxOffsetWithoutBearing: Double) {
        self.maxOffset = maxOffset
        self.maxOffsetWithoutBearing = maxOffsetWithoutBearing
    }

    /// Route geometry built from OpenStreetMap (OSRM, Valhalla, discovery corridors). Exit nodes are
    /// vertices of the same carriageways, so they sit within a few meters of the route. Tight limits
    /// keep collector-distributor roads, express lanes and ramps 8 m or more away from matching.
    public static let osmGeometry = ExitMatchingOptions(maxOffset: 5, maxOffsetWithoutBearing: 3)

    /// Route geometry from another map vendor (Apple MapKit, Google). Centerlines differ from OSM by
    /// several meters, so limits are looser. Known risk: a parallel roadway within 15 m of the route
    /// (collector-distributor lanes, express lanes) can contribute an exit the driver cannot take.
    public static let thirdPartyGeometry = ExitMatchingOptions(maxOffset: 15, maxOffsetWithoutBearing: 6)

    public static func forSource(_ source: RouteSource) -> ExitMatchingOptions {
        switch source {
        case .osrm, .corridor, .testFixture: return .osmGeometry
        case .appleMapKit, .googleRoutes: return .thirdPartyGeometry
        }
    }
}

/// Finds the exits a route passes, using geometry only.
///
/// For every dataset exit near the route, each place the route passes within `maxOffset`
/// meters is a candidate encounter. A candidate is accepted only when the exit's
/// carriageway bearing agrees with the route bearing there, which rejects exits on the
/// opposite carriageway of a divided highway and on parallel roads. Exit numbers are never
/// subtracted or compared to infer order or count; order comes from distance along the route.
public struct ExitMatcher: Sendable {
    public var options: ExitMatchingOptions

    public init(options: ExitMatchingOptions) {
        self.options = options
    }

    public init(source: RouteSource) {
        self.init(options: .forSource(source))
    }

    public struct Encounter: Sendable, Hashable {
        public let record: ExitRecord
        public let distanceAlongRoute: Double
        public let offset: Double
        public let confidence: RouteExit.Confidence
    }

    /// Raw encounters (one per physical exit node pass), ordered along the route.
    public func encounters(on route: RoutePolyline, dataset: InterstateDataset) -> [Encounter] {
        var candidateIDs = Set<Int32>()
        for i in 0..<route.segmentCount {
            for id in dataset.exitIndices(alongSegment: route.points[i], route.points[i + 1], radius: options.maxOffset) {
                candidateIDs.insert(id)
            }
        }
        var found: [Encounter] = []
        for id in candidateIDs {
            let record = dataset.exits[Int(id)]
            let radius = record.bearings.isEmpty ? options.maxOffsetWithoutBearing : options.maxOffset
            for p in route.projections(of: record.coordinate, within: radius) {
                if record.bearings.isEmpty {
                    found.append(Encounter(record: record, distanceAlongRoute: p.distanceAlong,
                                           offset: p.offset, confidence: .medium))
                    continue
                }
                let routeBearing = route.bearing(at: p.distanceAlong)
                let matches = record.bearings.contains {
                    Geodesy.angleDifference($0, routeBearing) <= options.maxBearingDifference
                }
                if matches {
                    found.append(Encounter(record: record, distanceAlongRoute: p.distanceAlong,
                                           offset: p.offset, confidence: .high))
                }
            }
        }
        found.sort {
            $0.distanceAlongRoute != $1.distanceAlongRoute
                ? $0.distanceAlongRoute < $1.distanceAlongRoute
                : $0.record.osmNodeID < $1.record.osmNodeID
        }
        return found
    }

    /// Exits along the route after merging duplicates into signed exits.
    public func match(route: RoutePolyline, dataset: InterstateDataset) -> [RouteExit] {
        merge(encounters(on: route, dataset: dataset))
    }

    func merge(_ encounters: [Encounter]) -> [RouteExit] {
        var groups: [[Encounter]] = []
        for e in encounters {
            if let last = groups.last?.last {
                let gap = e.distanceAlongRoute - last.distanceAlongRoute
                let sameNode = e.record.osmNodeID == last.record.osmNodeID && gap < 200
                let label = Self.normalizedLabel(e.record.label)
                let sameLabel = !label.isEmpty && label == Self.normalizedLabel(last.record.label)
                    && gap <= options.mergeSameLabelWithin
                if sameNode || sameLabel {
                    groups[groups.count - 1].append(e)
                    continue
                }
            }
            groups.append([e])
        }
        return groups.enumerated().map { ordinal, group in
            let first = group[0]
            var records: [ExitRecord] = []
            for e in group where !records.contains(where: { $0.osmNodeID == e.record.osmNodeID }) {
                records.append(e.record)
            }
            let name = records.lazy.map(\.name).first { !$0.isEmpty } ?? ""
            var highways: [String] = []
            for r in records { for h in r.highways where !highways.contains(h) { highways.append(h) } }
            return RouteExit(
                id: "osm-node-\(first.record.osmNodeID)", ordinal: ordinal, label: first.record.label,
                name: name.replacingOccurrences(of: ";", with: " / "), highways: highways,
                coordinate: first.record.coordinate, distanceAlongRoute: first.distanceAlongRoute,
                offsetFromRoute: first.offset,
                confidence: group.contains { $0.confidence == .high } ? .high : .medium,
                records: records)
        }
    }

    static func normalizedLabel(_ label: String) -> String {
        label.uppercased().filter { !$0.isWhitespace }
    }
}
