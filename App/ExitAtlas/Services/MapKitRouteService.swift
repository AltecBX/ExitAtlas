import ExitAtlasCore
import Foundation
import MapKit

/// Routes from Apple MapKit (MKDirections), converted to the engine's PlannedRoute.
///
/// MKDirections takes one origin and one destination, so trips with stops are computed leg by
/// leg and joined. MKRoute reports only a total travel time per leg (no per step durations), so
/// time is spread over each leg by distance and corrected live by the pace model (no provider calibration).
/// Route geometry is held in memory for the active trip only (Apple Developer Program License
/// Agreement, Attachment 6, section 2.5: temporary caching).
struct MapKitRouteService {
    struct Options {
        var avoidTolls = false
        var avoidHighways = false
    }

    enum RouteError: LocalizedError {
        case noRoute(String)

        var errorDescription: String? {
            switch self {
            case let .noRoute(leg): return "Apple Maps found no driving route for \(leg)."
            }
        }
    }

    /// Alternatives for a trip without stops; a single joined route when there are stops.
    func routes(from origin: Waypoint, via stops: [Waypoint], to destination: Waypoint,
                options: Options) async throws -> [PlannedRoute] {
        if stops.isEmpty {
            let response = try await directions(from: origin, to: destination, options: options, alternatives: true)
            return response.map { joined([$0], waypoints: [origin, destination]) }
        }
        let points = [origin] + stops + [destination]
        var legs: [MKRoute] = []
        for i in 0..<(points.count - 1) {
            guard let leg = try await directions(from: points[i], to: points[i + 1], options: options,
                                                 alternatives: false).first else {
                throw RouteError.noRoute("\(points[i].name) to \(points[i + 1].name)")
            }
            legs.append(leg)
        }
        return [joined(legs, waypoints: points)]
    }


    private func directions(from a: Waypoint, to b: Waypoint, options: Options,
                            alternatives: Bool) async throws -> [MKRoute] {
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: a.coordinate.clCoordinate))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: b.coordinate.clCoordinate))
        request.transportType = .automobile
        request.requestsAlternateRoutes = alternatives
        request.departureDate = Date()
        request.tollPreference = options.avoidTolls ? .avoid : .any
        request.highwayPreference = options.avoidHighways ? .avoid : .any
        let response = try await MKDirections(request: request).calculate()
        if response.routes.isEmpty { throw RouteError.noRoute("\(a.name) to \(b.name)") }
        return response.routes
    }

    private func joined(_ legs: [MKRoute], waypoints: [Waypoint]) -> PlannedRoute {
        var coordinates: [GeoCoordinate] = []
        var stepsRaw: [(distance: Double, instruction: String)] = []
        var legInfo: [(distance: Double, seconds: Double)] = []
        for leg in legs {
            let coords = leg.polyline.geoCoordinates
            coordinates.append(contentsOf: coordinates.last == coords.first ? Array(coords.dropFirst()) : coords)
            for step in leg.steps { stepsRaw.append((step.distance, step.instructions)) }
            legInfo.append((leg.distance, leg.expectedTravelTime))
        }
        let polyline = RoutePolyline(points: coordinates)
        // Scale provider distances to the engine's ellipsoidal length so steps and legs line up.
        let providerTotal = max(legInfo.reduce(0) { $0 + $1.distance }, 1)
        let scale = polyline.length / providerTotal
        var steps: [RouteStep] = []
        var cursor = 0.0
        for s in stepsRaw {
            let length = s.distance * scale
            steps.append(RouteStep(startDistance: cursor, length: length, instruction: s.instruction, roadName: ""))
            cursor += length
        }
        var legSpans: [(startDistance: Double, length: Double, seconds: Double)] = []
        var stops: [RouteStop] = []
        cursor = 0
        for (i, leg) in legInfo.enumerated() {
            let length = leg.distance * scale
            legSpans.append((cursor, length, leg.seconds))
            cursor += length
            if i < legInfo.count - 1 {
                stops.append(RouteStop(waypoint: waypoints[i + 1], distanceAlongRoute: min(cursor, polyline.length)))
            }
        }
        let name = legs.count == 1 ? legs[0].name : "\(legs.count) legs"
        return PlannedRoute(
            source: .appleMapKit, polyline: polyline, steps: steps,
            timeProfile: .steps(legSpans, length: polyline.length),
            origin: waypoints.first!, destination: waypoints.last!, stops: stops,
            hasTolls: legs.contains { $0.hasTolls }, createdAt: Date(), title: name)
    }
}

extension MKPolyline {
    var geoCoordinates: [GeoCoordinate] {
        var coords = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid, count: pointCount)
        getCoordinates(&coords, range: NSRange(location: 0, length: pointCount))
        return coords.map(GeoCoordinate.init)
    }
}
