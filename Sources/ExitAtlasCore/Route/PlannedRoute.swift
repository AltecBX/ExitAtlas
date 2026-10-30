import Foundation

public enum RouteSource: String, Codable, Sendable {
    case appleMapKit
    case googleRoutes
    case osrm
    /// Discovery mode: the remaining length of an interstate corridor in the direction of travel.
    case corridor
    case testFixture
}

public struct Waypoint: Sendable, Codable, Hashable {
    public var name: String
    public var coordinate: GeoCoordinate

    public init(name: String, coordinate: GeoCoordinate) {
        self.name = name
        self.coordinate = coordinate
    }
}

/// A maneuver step from the routing provider, positioned along the route.
public struct RouteStep: Sendable, Codable, Hashable {
    public let startDistance: Double
    public let length: Double
    public let instruction: String
    public let roadName: String
    public let highways: [HighwayRef]

    public init(startDistance: Double, length: Double, instruction: String, roadName: String,
                highways: [HighwayRef]? = nil) {
        self.startDistance = startDistance
        self.length = length
        self.instruction = instruction
        self.roadName = roadName
        self.highways = highways ?? HighwayRef.parse(roadName + " " + instruction)
    }

    public var endDistance: Double { startDistance + length }
}

/// A planned stop on the route (a waypoint between origin and destination).
public struct RouteStop: Sendable, Codable, Hashable, Identifiable {
    public let id: UUID
    public let waypoint: Waypoint
    /// Distance along the full route where the leg to this stop ends.
    public let distanceAlongRoute: Double
    /// Planned time spent at the stop, added to every ETA beyond it.
    public let plannedDwell: TimeInterval

    public init(id: UUID = UUID(), waypoint: Waypoint, distanceAlongRoute: Double, plannedDwell: TimeInterval = 0) {
        self.id = id
        self.waypoint = waypoint
        self.distanceAlongRoute = distanceAlongRoute
        self.plannedDwell = plannedDwell
    }
}

/// The selected route: geometry, maneuvers and the travel time model from the provider.
public struct PlannedRoute: Sendable, Identifiable {
    public let id: UUID
    public let source: RouteSource
    public let polyline: RoutePolyline
    public let steps: [RouteStep]
    public let timeProfile: TravelTimeProfile
    public let origin: Waypoint
    public let destination: Waypoint
    public let stops: [RouteStop]
    public let hasTolls: Bool?
    public let createdAt: Date
    /// Display name for discovery mode corridors ("I-95 Northbound").
    public let title: String?

    public init(id: UUID = UUID(), source: RouteSource, polyline: RoutePolyline, steps: [RouteStep] = [],
                timeProfile: TravelTimeProfile, origin: Waypoint, destination: Waypoint,
                stops: [RouteStop] = [], hasTolls: Bool? = nil, createdAt: Date = Date(), title: String? = nil) {
        self.id = id
        self.source = source
        self.polyline = polyline
        self.steps = steps
        self.timeProfile = timeProfile
        self.origin = origin
        self.destination = destination
        self.stops = stops
        self.hasTolls = hasTolls
        self.createdAt = createdAt
        self.title = title
    }

    public var length: Double { polyline.length }

    /// The provider step containing a distance along the route.
    public func step(at distance: Double) -> RouteStep? {
        guard !steps.isEmpty else { return nil }
        var lo = 0, hi = steps.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if steps[mid].startDistance <= distance { lo = mid } else { hi = mid - 1 }
        }
        return steps[lo]
    }

    /// The highway being driven at a distance, from provider steps, with signed direction.
    public func highway(at distance: Double) -> SignedHighway? {
        guard let step = step(at: distance), let ref = step.highways.first else { return nil }
        return SignedHighway(ref: ref, direction: direction(of: ref, at: distance))
    }

    /// Signed direction of a road at a distance. Interstates: their parity, signed over the next 25 km of
    /// route. Other roads: the main axis of the route while on that road, so the road turned onto next (US 9
    /// south in Yonkers, then west across the George Washington Bridge) does not change it.
    public func direction(of ref: HighwayRef, at distance: Double) -> CardinalDirection {
        guard ref.kind != .interstate, !steps.isEmpty else {
            return CardinalDirection.signed(for: ref, along: polyline, at: distance)
        }
        return CardinalDirection.signed(for: ref, along: polyline, at: distance, within: stretch(of: ref, at: distance))
    }

    /// The stretch around `distance` on steps naming `ref`, joined across steps that name no road (ramps,
    /// lane changes) up to `bridge` meters.
    public func stretch(of ref: HighwayRef, at distance: Double, bridge: Double = 2_000) -> ClosedRange<Double> {
        var lo = 0, hi = steps.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if steps[mid].startDistance <= distance { lo = mid } else { hi = mid - 1 }
        }
        var first = lo, last = lo
        var gap = 0.0
        for k in (lo + 1)..<max(lo + 1, steps.count) {
            if steps[k].highways.contains(ref) { last = k; gap = 0; continue }
            gap += steps[k].length
            if steps[k].highways.isEmpty, gap <= bridge { continue }
            break
        }
        gap = 0
        for k in stride(from: lo - 1, through: 0, by: -1) {
            if steps[k].highways.contains(ref) { first = k; gap = 0; continue }
            gap += steps[k].length
            if steps[k].highways.isEmpty, gap <= bridge { continue }
            break
        }
        let start = steps[first].startDistance, end = steps[last].startDistance + steps[last].length
        return start...max(start, end)
    }
}

/// Piecewise linear model of expected elapsed time along the route.
public struct TravelTimeProfile: Sendable, Codable, Hashable {
    /// Distances along the route (meters), increasing.
    public let distances: [Double]
    /// Expected seconds from route start to each distance.
    public let seconds: [Double]

    public init(distances: [Double], seconds: [Double]) {
        precondition(distances.count == seconds.count && !distances.isEmpty)
        self.distances = distances
        self.seconds = seconds
    }

    /// Time spread in proportion to distance (used when the provider reports only a total,
    /// as MKRoute does). Live pace calibration corrects it while driving.
    public static func uniform(length: Double, totalSeconds: Double) -> TravelTimeProfile {
        TravelTimeProfile(distances: [0, max(length, 0)], seconds: [0, max(totalSeconds, 0)])
    }

    /// Per polyline segment durations (OSRM annotations, Google step durations mapped to segments).
    public init(polyline: RoutePolyline, segmentDurations: [Double]) {
        precondition(segmentDurations.count == polyline.segmentCount)
        var secs = [0.0]
        secs.reserveCapacity(polyline.points.count)
        for d in segmentDurations { secs.append(secs.last! + max(d, 0)) }
        self.init(distances: polyline.cumulativeDistances, seconds: secs)
    }

    /// Step level durations: each step's duration spread uniformly over its length.
    public static func steps(_ steps: [(startDistance: Double, length: Double, seconds: Double)], length: Double) -> TravelTimeProfile {
        var d = [0.0], s = [0.0]
        for step in steps.sorted(by: { $0.startDistance < $1.startDistance }) where step.length > 0 {
            let end = min(step.startDistance + step.length, length)
            guard end > d.last! else { continue }
            d.append(end)
            s.append(s.last! + max(step.seconds, 0))
        }
        if d.last! < length {
            d.append(length)
            s.append(s.last!)
        }
        return TravelTimeProfile(distances: d, seconds: s)
    }

    public var totalSeconds: Double { seconds.last ?? 0 }

    public func seconds(at distance: Double) -> Double {
        if distance <= distances[0] { return seconds[0] }
        if distance >= distances[distances.count - 1] { return seconds[seconds.count - 1] }
        var lo = 0, hi = distances.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if distances[mid] <= distance { lo = mid } else { hi = mid }
        }
        let span = distances[hi] - distances[lo]
        let t = span > 0 ? (distance - distances[lo]) / span : 0
        return seconds[lo] + (seconds[hi] - seconds[lo]) * t
    }

    public func seconds(from start: Double, to end: Double) -> Double {
        max(0, seconds(at: end) - seconds(at: start))
    }

    /// Distance reached after driving `elapsed` seconds from `start` (inverse lookup).
    public func distance(after elapsed: Double, from start: Double) -> Double {
        let target = seconds(at: start) + elapsed
        if target <= seconds[0] { return distances[0] }
        if target >= totalSeconds { return distances[distances.count - 1] }
        var lo = 0, hi = seconds.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if seconds[mid] <= target { lo = mid } else { hi = mid }
        }
        let span = seconds[hi] - seconds[lo]
        let t = span > 0 ? (target - seconds[lo]) / span : 0
        return distances[lo] + (distances[hi] - distances[lo]) * t
    }

    /// Expected speed (m/s) at a distance, used by GPS simulation and dead reckoning.
    public func speed(at distance: Double, window: Double = 200) -> Double {
        let a = max(distances[0], distance - window), b = min(distances[distances.count - 1], distance + window)
        let dt = seconds(from: a, to: b)
        return dt > 0 ? (b - a) / dt : 0
    }
}
