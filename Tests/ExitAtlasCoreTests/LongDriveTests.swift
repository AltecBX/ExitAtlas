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

    // MARK: Pace across GPS gaps

    func testStopHiddenInAGPSGapIsNotLearnedAsSlowDriving() {
        let route = Fixtures.route("atlanta_to_nashville")
        var session = TripSession(plan: TripPlan(route: route, datasets: datasets), states: Fixtures.states, startedAt: start)
        let trace = GPSSimulator(route: route).trace(from: 0, to: 60_000, startTime: start)
        var before: TripSnapshot?
        for s in trace { before = session.ingest(s) }
        let last = trace.last!.timestamp
        // Six minutes parked beside the road with no fixes, then a minute of driving.
        let after = session.ingest(fix(route, 61_800, last.addingTimeInterval(420), speed: 30))
        XCTAssertEqual(after.match.status, .onRoute)
        XCTAssertLessThan(session.pace.recentFactor ?? 0, 1.2)
        XCTAssertLessThan(after.timeRemaining, before!.timeRemaining)

        // A gap that is plain driving (two minutes in a tunnel at the usual speed) still counts.
        let observed = session.pace.observedSeconds
        let speed = route.timeProfile.speed(at: 70_000)
        session.ingest(fix(route, 62_000, last.addingTimeInterval(440), speed: 30))
        session.ingest(fix(route, 62_000 + speed * 120, last.addingTimeInterval(560), speed: speed))
        XCTAssertGreaterThanOrEqual(session.pace.observedSeconds - observed, 120)
    }

    // MARK: Driven miles off the route

    /// Exit at 30 km: 20 s on a ramp to 250 m off the route, then parked with GPS wander.
    func departAndPark(_ route: PlannedRoute, _ session: inout TripSession, from: Date, minutes: Int,
                       speedReported: Double?) -> Date {
        var t = from
        let rampCourse = Geodesy.normalizedDegrees(route.polyline.bearing(at: 30_000) + 60)
        for k in 1...20 {
            session.ingest(fix(route, 30_000 + 8 * Double(k), t, side: 12.5 * Double(k), speed: 13, course: rampCourse))
            t = t.addingTimeInterval(1)
        }
        var rng = Wander(seed: 3)
        let spot = Geodesy.offset(route.polyline.coordinate(at: 30_160), bearing: route.polyline.bearing(at: 30_160) + 90,
                                  meters: 250)
        for _ in 0..<(minutes * 60) {
            let c = Geodesy.offset(Geodesy.offset(spot, bearing: 0, meters: rng.gaussian() * 6), bearing: 90,
                                   meters: rng.gaussian() * 6)
            session.ingest(LocationSample(coordinate: c, horizontalAccuracy: 8, course: nil, speed: speedReported, timestamp: t))
            t = t.addingTimeInterval(1)
        }
        return t
    }

    func drive(_ route: PlannedRoute, to end: Double) -> (TripSession, Date) {
        var session = TripSession(plan: TripPlan(route: route, datasets: datasets), states: Fixtures.states, startedAt: start)
        let trace = GPSSimulator(route: route).trace(from: 0, to: end, startTime: start)
        for s in trace { session.ingest(s) }
        return (session, trace.last!.timestamp.addingTimeInterval(1))
    }

    func testPhoneParkedOffTheRouteAddsNoMiles() {
        let route = Fixtures.route("atlanta_to_nashville")
        for speedReported in [0.0, nil] as [Double?] {
            let (first, t) = drive(route, to: 30_000)
            var session = first
            let driven = session.ledger.totalMeters
            _ = departAndPark(route, &session, from: t, minutes: 40, speedReported: speedReported)
            XCTAssertEqual(session.tracker.match.status, .offRoute)
            // The ramp is about 300 m; GPS wander used to add about 25 km here.
            let extra = session.ledger.totalMeters - driven
            XCTAssertGreaterThan(extra, 150, "speed \(String(describing: speedReported))")
            XCTAssertLessThan(extra, 600, "speed \(String(describing: speedReported))")
        }
    }

    func testMilesDrivenWhileTheScreenWasLockedCountOnceBackOnTheRoute() {
        let route = Fixtures.route("atlanta_to_nashville")
        let (first, t0) = drive(route, to: 30_000)
        var session = first
        let t = departAndPark(route, &session, from: t0, minutes: 1, speedReported: 0)
        // 15 minutes without fixes: the rest of the stop, then back on the highway; first fix 20 km on.
        var snap: TripSnapshot?
        for k in 0..<5 { snap = session.ingest(fix(route, 50_000 + 28 * Double(k), t.addingTimeInterval(900 + Double(k)))) }
        XCTAssertEqual(snap?.match.status, .onRoute)
        XCTAssertEqual(session.ledger.totalMeters, 50_112, accuracy: 800)
    }

    func testSameAfterARerouteFromTheExitAndNeverForAResumedTrip() {
        let route = Fixtures.route("atlanta_to_nashville")
        let (first, t0) = drive(route, to: 30_000)
        var session = first
        let t = departAndPark(route, &session, from: t0, minutes: 1, speedReported: 0)
        // The reroute's route starts at the parked car and joins the original route 400 m on.
        let spot = session.lastSample!.coordinate
        let rest = route.polyline.slice(from: 30_400, to: route.polyline.length)
        let polyline = RoutePolyline(points: [spot] + rest.points)
        let rerouted = PlannedRoute(source: .osrm, polyline: polyline,
                                    timeProfile: .uniform(length: polyline.length, totalSeconds: polyline.length / 28),
                                    origin: Waypoint(name: "Here", coordinate: spot), destination: route.destination)
        session.replacePlan(TripPlan(route: rerouted, datasets: datasets), at: t)
        let shift = 30_400 - (polyline.length - rest.length)
        for k in 0..<5 { session.ingest(fix(route, 50_000 + 28 * Double(k), t.addingTimeInterval(900 + Double(k)))) }
        XCTAssertEqual(session.tracker.match.status, .onRoute)
        XCTAssertEqual(session.tracker.match.distanceAlongRoute, 50_112 - shift, accuracy: 60)
        XCTAssertEqual(session.ledger.totalMeters, 50_112, accuracy: 800)

        // A trip resumed after a relaunch starts a fresh session on the saved route: its first fix far along
        // the route must not be credited from the start of the route.
        var resumed = TripSession(plan: TripPlan(route: route, datasets: datasets), states: Fixtures.states, startedAt: start,
                                  ledger: session.ledger, pace: session.pace)
        let total = resumed.ledger.totalMeters
        for k in 0..<5 { resumed.ingest(fix(route, 120_000 + 28 * Double(k), t.addingTimeInterval(5_000 + Double(k)))) }
        XCTAssertLessThan(resumed.ledger.totalMeters - total, 200)
    }
}
