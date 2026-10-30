import XCTest
@testable import ExitAtlasCore

/// Long drive regressions found by simulating a Yonkers to Orlando trip (I-95, 1,091 miles) with drift, stops,
/// parked phones and GPS gaps. Same checks as web/tests/longdrive.test.js.
/// Deterministic GPS wander, the same sequence as the web test's.
struct Wander {
    var s: Int
    init(seed: Int) { s = seed }
    mutating func uniform() -> Double {
        s = (s * 1_103_515_245 + 12_345) % 2_147_483_648
        return Double(s) / 2_147_483_648
    }
    mutating func gaussian() -> Double {
        let u = uniform(), v = uniform()
        return (-2 * log(max(u, 1e-9))).squareRoot() * cos(2 * .pi * v)
    }
}

final class LongDriveTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_793_000_000)
    let datasets = TripDatasets(states: Fixtures.states, timeZones: nil, interstates: nil)

    /// A fix at a distance along the route, moved `side` meters to the right of travel.
    func fix(_ route: PlannedRoute, _ d: Double, _ t: Date, side: Double = 0, accuracy: Double = 8,
             speed: Double? = 28, course: Double? = nil, routeCourse: Bool = true) -> LocationSample {
        let bearing = route.polyline.bearing(at: d)
        let c = route.polyline.coordinate(at: d)
        return LocationSample(coordinate: side != 0 ? Geodesy.offset(c, bearing: bearing + 90, meters: side) : c,
                              horizontalAccuracy: accuracy, course: course ?? (routeCourse ? bearing : nil),
                              speed: speed, timestamp: t)
    }

    // MARK: Off route detection under GPS drift

    func testDriftBesideTheRouteIsNotLeavingIt() {
        let route = Fixtures.route("atlanta_to_nashville")
        var options = GPSSimulator.Options()
        options.noise = 5
        options.reportedAccuracy = 8
        let trace = GPSSimulator(route: route, options: options).traceWithTruth(from: 45_000, to: 62_000, startTime: start)
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        var estimated = 0
        var lastInDrift: (RouteMatch, Double)?
        for (sample, truth) in trace {
            // 80 m to the side for about 47 s at 23.6 m/s, with an optimistic accuracy.
            let drifting = truth >= 50_000 && truth <= 51_100
            var s = sample
            if drifting {
                s.coordinate = Geodesy.offset(sample.coordinate, bearing: route.polyline.bearing(at: truth) + 90, meters: 80)
                s.horizontalAccuracy = 10
            }
            let m = tracker.ingest(s)
            XCTAssertNotEqual(m.status, .offRoute, "false off route at \(truth)")
            if drifting {
                if m.isEstimated { estimated += 1 }
                lastInDrift = (m, truth)
            } else if truth > 51_300 {
                XCTAssertEqual(m.distanceAlongRoute, truth, accuracy: 40)
            }
        }
        XCTAssertGreaterThan(estimated, 30)
        XCTAssertEqual(lastInDrift!.0.distanceAlongRoute, lastInDrift!.1, accuracy: 60)
    }

    func testStopAndGoWithWanderingDriftNeverFlipsOffRoute() {
        let route = Fixtures.route("atlanta_to_nashville")
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        for s in GPSSimulator(route: route).trace(from: 78_000, to: 80_000, startTime: start) { tracker.ingest(s) }
        var rng = Wander(seed: 7)
        var n = 0.0, e = 0.0, d = 80_000.0
        var t = start.addingTimeInterval(100)
        var statuses = Set<RouteMatch.Status>()
        for _ in 0..<600 {
            d += 1.2
            n += rng.gaussian() * 4
            e += rng.gaussian() * 4
            let m = (n * n + e * e).squareRoot()
            if m > 75 { n *= 75 / m; e *= 75 / m }
            let c = Geodesy.offset(Geodesy.offset(route.polyline.coordinate(at: d), bearing: 0, meters: n), bearing: 90, meters: e)
            statuses.insert(tracker.ingest(LocationSample(coordinate: c, horizontalAccuracy: 25, course: nil, speed: 1.2,
                                                          timestamp: t)).status)
            t = t.addingTimeInterval(1)
        }
        XCTAssertEqual(statuses, [.onRoute])
    }

    func testLeavingOnARoadBesideTheRouteIsStillFlagged() {
        let route = Fixtures.route("atlanta_to_nashville")
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        var t = start, d = 45_000.0
        while d < 50_000 { tracker.ingest(fix(route, d, t)); d += 28; t = t.addingTimeInterval(1) }
        let left = t
        var offAt: Date?
        for k in 0..<120 where offAt == nil {
            let m = tracker.ingest(fix(route, d, t, side: min(110, 11 * Double(k + 1))))
            if m.status == .offRoute { offAt = t }
            d += 28
            t = t.addingTimeInterval(1)
        }
        XCTAssertNotNil(offAt)
        XCTAssertLessThanOrEqual(offAt!.timeIntervalSince(left), RouteProgressTracker.Configuration().driftTolerance + 10)
    }
}
