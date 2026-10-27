import Foundation
@testable import ExitAtlasCore

/// Loads real route fixtures (OSRM routes on OpenStreetMap data) and the bundled datasets.
enum Fixtures {
    static let repoRoot: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }  // Support, ExitAtlasCoreTests, Tests, root
        return url
    }()

    static var dataDirectory: URL { repoRoot.appendingPathComponent("App/ExitAtlas/Resources/Data") }
    static var fixtureDirectory: URL { repoRoot.appendingPathComponent("Tests/ExitAtlasCoreTests/Fixtures") }

    static let states: RegionIndex = try! RegionIndex(contentsOf: dataDirectory.appendingPathComponent("states.eab"))
    static let timeZones: RegionIndex = try! RegionIndex(contentsOf: dataDirectory.appendingPathComponent("timezones.eab"))
    static let interstates: InterstateDataset = try! InterstateDataset(contentsOf: dataDirectory.appendingPathComponent("interstates.eax"))
    static let corridors: CorridorDataset = try! CorridorDataset(contentsOf: dataDirectory.appendingPathComponent("corridors.eac"))

    struct RouteFixture: Decodable {
        struct Step: Decodable {
            let name: String
            let ref: String
            let distance_m: Double
            let duration_s: Double
            let maneuver: String
            let modifier: String
        }

        let name: String
        let distance_m: Double
        let duration_s: Double
        let coordinates: [[Double]]
        let osm_nodes: [Int64]
        let segment_durations_s: [Double]
        let steps: [Step]
    }

    struct Expected: Decodable {
        struct State: Decodable {
            let code: String?
            let start_m: Double
            let end_m: Double
            let length_m: Double
        }

        let geodesic_length_m: Double
        let states: [State]
        let exits_on_route: [Int64]
    }

    static func load(_ name: String) -> (fixture: RouteFixture, expected: Expected) {
        let decoder = JSONDecoder()
        let f = try! decoder.decode(RouteFixture.self, from: Data(contentsOf: fixtureDirectory.appendingPathComponent("\(name).route.json")))
        let e = try! decoder.decode(Expected.self, from: Data(contentsOf: fixtureDirectory.appendingPathComponent("\(name).expected.json")))
        return (f, e)
    }

    /// Builds a PlannedRoute from a fixture, using OSRM per segment durations and steps.
    static func route(_ name: String) -> PlannedRoute {
        let f = load(name).fixture
        let points = f.coordinates.map { GeoCoordinate(latitude: $0[0], longitude: $0[1]) }
        let polyline = RoutePolyline(points: points)
        precondition(polyline.points.count == points.count, "fixture has duplicate consecutive points")
        var steps: [RouteStep] = []
        var start = 0.0
        for s in f.steps {
            let road = s.ref.isEmpty ? s.name : "\(s.ref) \(s.name)"
            steps.append(RouteStep(startDistance: start, length: s.distance_m,
                                   instruction: "\(s.maneuver) \(s.modifier)", roadName: road))
            start += s.distance_m
        }
        return PlannedRoute(
            source: .testFixture, polyline: polyline, steps: steps,
            timeProfile: TravelTimeProfile(polyline: polyline, segmentDurations: f.segment_durations_s),
            origin: Waypoint(name: "Origin", coordinate: points.first!),
            destination: Waypoint(name: "Destination", coordinate: points.last!),
            createdAt: Date(timeIntervalSince1970: 1_793_000_000))
    }
}
