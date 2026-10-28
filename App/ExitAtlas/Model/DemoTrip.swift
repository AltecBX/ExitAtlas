import ExitAtlasCore
import Foundation

/// A bundled sample route (Miami to Manhattan, computed by OSRM on OpenStreetMap data) for trying
/// the app with simulated GPS, without location access or a network connection.
enum DemoTrip {
    private struct File: Decodable {
        struct Step: Decodable {
            let name: String
            let ref: String
            let distance_m: Double
            let maneuver: String
            let modifier: String
        }

        let name: String
        let coordinates: [[Double]]
        let segment_durations_s: [Double]
        let steps: [Step]
    }

    static func load(bundle: Bundle = .main) throws -> PlannedRoute {
        guard let url = bundle.url(forResource: "demo_miami_manhattan", withExtension: "json", subdirectory: "Data")
            ?? bundle.url(forResource: "demo_miami_manhattan", withExtension: "json") else {
            throw BundledData.LoadError.missing("demo_miami_manhattan.json")
        }
        let file = try JSONDecoder().decode(File.self, from: Data(contentsOf: url))
        let points = file.coordinates.map { GeoCoordinate(latitude: $0[0], longitude: $0[1]) }
        let polyline = RoutePolyline(points: points)
        let profile: TravelTimeProfile
        if file.segment_durations_s.count == polyline.segmentCount {
            profile = TravelTimeProfile(polyline: polyline, segmentDurations: file.segment_durations_s)
        } else {
            profile = .uniform(length: polyline.length, totalSeconds: file.segment_durations_s.reduce(0, +))
        }
        var steps: [RouteStep] = []
        var cursor = 0.0
        for s in file.steps {
            steps.append(RouteStep(startDistance: cursor, length: s.distance_m, instruction: "\(s.maneuver) \(s.modifier)",
                                   roadName: s.ref.isEmpty ? s.name : "\(s.ref) \(s.name)"))
            cursor += s.distance_m
        }
        return PlannedRoute(
            source: .osrm, polyline: polyline, steps: steps, timeProfile: profile,
            origin: Waypoint(name: "Miami, FL", coordinate: points.first!),
            destination: Waypoint(name: "Manhattan, NY", coordinate: points.last!),
            title: "Sample route (OSRM, OpenStreetMap)")
    }
}
