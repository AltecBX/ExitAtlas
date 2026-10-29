import ExitAtlasCore
import Foundation
import MapKit

/// Traffic from Apple Maps (docs/16). Apple's ETA ("taking expected traffic into account") to checkpoints on the
/// current leg, at most 100 miles ahead: the next state line, a point 40 miles ahead, and the next stop or the
/// destination (or the point 100 miles ahead when they are farther; beyond that, the driver's pace). A time is used only when Apple timed the same road: its distance must match the route's own
/// distance to that point (Traffic.matchesRoute). The extra time is Apple's traffic time to the farthest matched
/// checkpoint minus its own ideal conditions route time there, both matched. Apple gives no slowdown locations,
/// speeds or incidents, so none are shown. Apple Map Data stays in the app next to Apple's own map.
@MainActor
final class AppleTrafficService {
    struct Checkpoint: Sendable {
        /// Meters along the route.
        let along: Double
        let coordinate: GeoCoordinate
        /// Where the extra time applies, as words: "before Savannah", "before the GA line", "over the next 100 mi".
        let place: String
    }

    struct Result {
        let reading: Traffic.Reading?
        /// The extra time traffic adds to the farthest matched checkpoint, when at least 3 minutes.
        let extra: (seconds: Double, to: String)?
    }

    static let source = RoadIntel.Source(id: "apple", name: "Apple Maps")

    /// Asks Apple for traffic aware times from `origin` (the route at `progress`) to each checkpoint. Throws when
    /// none could be used and Apple answered with an error (offline, throttled), so the caller backs off.
    func measure(routeId: String, origin: GeoCoordinate, progress: Double, checkpoints: [Checkpoint], avoidTolls: Bool,
                 now: Date) async throws -> Result {
        var measurements: [Traffic.Measurement] = []
        var failure: Error?
        for cp in checkpoints {
            do {
                let eta = try await MKDirections(request: Self.request(from: origin, to: cp.coordinate, avoidTolls: avoidTolls)).calculateETA()
                measurements.append(Traffic.Measurement(along: cp.along, routeMeters: cp.along - progress,
                                                        providerMeters: eta.distance, seconds: eta.expectedTravelTime))
            } catch {
                failure = error
            }
        }
        let reading = Traffic.reading(routeId: routeId, measuredAt: now, fromAlong: progress, measurements: measurements, source: Self.source)
        if reading == nil, let failure { throw failure }
        var extra: (seconds: Double, to: String)?
        if let last = reading?.checkpoints.last, let cp = checkpoints.first(where: { $0.along == last.along }),
           let traffic = measurements.first(where: { $0.along == last.along }),
           let route = try? await MKDirections(request: Self.request(from: origin, to: cp.coordinate, avoidTolls: avoidTolls)).calculate().routes.first {
            // MKRoute.expectedTravelTime is "the time it takes to traverse the route under ideal conditions".
            let ideal = Traffic.Measurement(along: cp.along, routeMeters: traffic.routeMeters, providerMeters: route.distance,
                                            seconds: route.expectedTravelTime)
            extra = Traffic.extraSeconds(traffic: traffic, ideal: ideal).map { (seconds: $0, to: cp.place) }
        }
        return Result(reading: reading, extra: extra)
    }

    /// The checkpoints for the leg being driven, at most 100 miles ahead (farther out, Apple's estimate is a
    /// forecast more than today's traffic): every point is on the route polyline (the road and direction driven),
    /// so Apple times the same carriageway. At most three requests.
    nonisolated static func checkpoints(plan: TripPlan, snapshot s: TripSnapshot) -> [Checkpoint] {
        let mile = Geodesy.metersPerMile
        let poly = plan.route.polyline
        let p = s.progress
        let legEnd = s.nextStop.map { ($0.stop.distanceAlongRoute, $0.stop.waypoint.name) } ?? (plan.route.length, plan.route.destination.name)
        let far = min(legEnd.0, p + 100 * mile)
        guard far - p > 2 * mile else { return [] }
        var out = [Checkpoint(along: far, coordinate: poly.coordinate(at: far),
                              place: far == legEnd.0 ? "before \(legEnd.1)" : "over the next 100 mi")]
        if let current = s.current, let next = s.next {
            // Just past the line, so the point is in the next state on the highway.
            let along = p + current.remainingMeters + 300
            if along > p + 2 * mile, along < far - 2 * mile {
                out.append(Checkpoint(along: along, coordinate: poly.coordinate(at: along),
                                      place: "before the \(next.segment.code ?? next.segment.displayName) line"))
            }
        }
        // A point 40 miles ahead when no checkpoint is between 20 and 60 miles, for the stops in between.
        let along = p + 40 * mile
        if along < far - 2 * mile, !out.contains(where: { $0.along - p >= 20 * mile && $0.along - p <= 60 * mile }) {
            out.append(Checkpoint(along: along, coordinate: poly.coordinate(at: along), place: "over the next 40 mi"))
        }
        return out.sorted { $0.along < $1.along }
    }

    private static func request(from a: GeoCoordinate, to b: GeoCoordinate, avoidTolls: Bool) -> MKDirections.Request {
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: a.clCoordinate))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: b.clCoordinate))
        request.transportType = .automobile
        request.departureDate = Date()
        request.requestsAlternateRoutes = false
        request.tollPreference = avoidTolls ? .avoid : .any
        return request
    }
}
