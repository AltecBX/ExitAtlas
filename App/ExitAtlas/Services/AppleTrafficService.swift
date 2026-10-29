import ExitAtlasCore
import Foundation
import MapKit

/// Traffic from Apple Maps (docs/16). Apple's ETA ("taking expected traffic into account") to checkpoints on the
/// current leg: the next state line, a point about 40 miles ahead when the leg is long, and the next stop or the
/// destination. A time is used only when Apple timed the same road: its distance must match the route's own
/// distance to that point (Traffic.matchesRoute). The extra time is Apple's traffic time to the farthest matched
/// checkpoint minus its own ideal conditions route time there, both matched. Apple gives no slowdown locations,
/// speeds or incidents, so none are shown. Apple Map Data stays in the app next to Apple's own map.
@MainActor
final class AppleTrafficService {
    struct Checkpoint: Sendable {
        /// Meters along the route.
        let along: Double
        let coordinate: GeoCoordinate
        /// "Savannah", "the GA line", "40 mi ahead".
        let name: String
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
            extra = Traffic.extraSeconds(traffic: traffic, ideal: ideal).map { (seconds: $0, to: cp.name) }
        }
        return Result(reading: reading, extra: extra)
    }

    /// The checkpoints for the leg being driven: every point is on the route polyline (the road and direction
    /// driven), so Apple times the same carriageway. At most three requests.
    nonisolated static func checkpoints(plan: TripPlan, snapshot s: TripSnapshot) -> [Checkpoint] {
        let mile = Geodesy.metersPerMile
        let poly = plan.route.polyline
        let p = s.progress
        let legEnd = s.nextStop.map { ($0.stop.distanceAlongRoute, $0.stop.waypoint.name) } ?? (plan.route.length, plan.route.destination.name)
        guard legEnd.0 - p > 2 * mile else { return [] }
        var out = [Checkpoint(along: legEnd.0, coordinate: poly.coordinate(at: legEnd.0), name: legEnd.1)]
        if let current = s.current, let next = s.next {
            // Just past the line, so the point is in the next state on the highway.
            let along = p + current.remainingMeters + 300
            if along > p + 2 * mile, along < legEnd.0 - 2 * mile {
                out.append(Checkpoint(along: along, coordinate: poly.coordinate(at: along), name: "the \(next.segment.code ?? next.segment.displayName) line"))
            }
        }
        let nearest = out.map(\.along).min() ?? legEnd.0
        if nearest - p > 60 * mile {
            let along = p + 40 * mile
            out.append(Checkpoint(along: along, coordinate: poly.coordinate(at: along), name: "40 mi ahead"))
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
