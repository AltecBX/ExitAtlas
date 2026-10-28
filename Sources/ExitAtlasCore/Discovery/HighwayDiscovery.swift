import Foundation

/// Discovery mode: works out which interstate and direction the driver is on without a destination.
///
/// Fixes are matched against the bundled directional corridors using position and course.
/// A corridor is locked after several consecutive consistent matches with forward progress,
/// and released after several consecutive misses (the driver left the interstate).
public struct HighwayDiscovery: Sendable {
    public enum State: Sendable {
        case searching
        case locked(CorridorMatch)
    }

    public let corridors: CorridorDataset
    public var requiredConfirmations = 3
    public var releaseAfterMisses = 5
    public var minimumSpeed = 6.0  // m/s, about 13 mph
    public private(set) var state: State = .searching
    private var candidateKey: (corridor: Int, part: Int)?
    private var candidateDistance = 0.0
    private var confirmations = 0
    private var misses = 0

    public init(corridors: CorridorDataset) {
        self.corridors = corridors
    }

    @discardableResult
    public mutating func ingest(_ sample: LocationSample) -> State {
        guard let course = sample.course, let speed = sample.speed, speed >= minimumSpeed,
              sample.horizontalAccuracy >= 0, sample.horizontalAccuracy <= 65 else {
            return state
        }
        let radius = max(35, sample.horizontalAccuracy + 20)
        let matches = corridors.matches(near: sample.coordinate, course: course, radius: radius)

        if case let .locked(current) = state {
            if let same = matches.first(where: { $0.corridor.id == current.corridor.id && $0.partIndex == current.partIndex }) {
                misses = 0
                state = .locked(same)
            } else {
                misses += 1
                if misses >= releaseAfterMisses {
                    state = .searching
                    candidateKey = nil
                    confirmations = 0
                    misses = 0
                }
            }
            return state
        }

        guard let best = matches.first else {
            candidateKey = nil
            confirmations = 0
            return state
        }
        if let key = candidateKey, key.corridor == best.corridor.id, key.part == best.partIndex,
           best.projection.distanceAlong >= candidateDistance - 30 {
            confirmations += 1
        } else {
            candidateKey = (best.corridor.id, best.partIndex)
            confirmations = 1
        }
        candidateDistance = best.projection.distanceAlong
        if confirmations >= requiredConfirmations {
            state = .locked(best)
            misses = 0
        }
        return state
    }

    /// A route for the corridor ahead of the match, so the normal trip engine can compute exits,
    /// state lines and ETAs in discovery mode. Distances in the result start at the driver.
    public static func routeAhead(of match: CorridorMatch, lookahead: Double = 400 * Geodesy.metersPerMile,
                                  now: Date = Date()) -> PlannedRoute {
        let part = match.part
        let start = match.projection.distanceAlong
        let polyline = part.slice(from: start, to: min(part.length, start + lookahead))
        let profile = TravelTimeProfile.uniform(length: polyline.length, totalSeconds: polyline.length / match.corridor.averageSpeed)
        let ref = HighwayRef.parse(match.corridor.highway).first
        let steps = [RouteStep(startDistance: 0, length: polyline.length, instruction: match.corridor.displayName,
                               roadName: match.corridor.highway, highways: ref.map { [$0] } ?? [])]
        return PlannedRoute(
            source: .corridor, polyline: polyline, steps: steps, timeProfile: profile,
            origin: Waypoint(name: "Current location", coordinate: polyline.points.first!),
            destination: Waypoint(name: "End of \(match.corridor.displayName)", coordinate: polyline.points.last!),
            createdAt: now, title: match.corridor.displayName)
    }
}
