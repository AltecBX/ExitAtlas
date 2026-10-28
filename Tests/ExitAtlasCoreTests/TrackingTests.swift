import XCTest
@testable import ExitAtlasCore

/// Simulated GPS playback along real routes: noise, tunnels, departures and acquisition.
final class TrackingTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_793_000_000)

    func testNoisyDriveStaysOnRouteAndTracksDistance() {
        let route = Fixtures.route("atlanta_to_nashville")
        var options = GPSSimulator.Options()
        options.noise = 6
        options.reportedAccuracy = 8
        let trace = GPSSimulator(route: route, options: options).traceWithTruth(startTime: start)
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        var errors: [Double] = []
        for (sample, truth) in trace {
            let m = tracker.ingest(sample)
            XCTAssertNotEqual(m.status, .offRoute, "false off route at \(truth)")
            if m.status == .onRoute { errors.append(abs(m.distanceAlongRoute - truth)) }
        }
        errors.sort()
        XCTAssertGreaterThan(errors.count, trace.count - 5)
        let p99 = errors[Int(Double(errors.count) * 0.99)]
        XCTAssertLessThan(p99, 30, "99th percentile along-route error")
        XCTAssertLessThan(errors.last!, 60, "worst along-route error")
    }

    func testTunnelDropoutIsDeadReckonedAndReacquired() {
        let route = Fixtures.route("miami_to_manhattan")
        // A 2.4 km gap with no fixes, similar to the Fort McHenry tunnel.
        let gapStart = 1_750_000.0, gapEnd = 1_752_400.0
        var options = GPSSimulator.Options()
        options.dropouts = [gapStart...gapEnd]
        let trace = GPSSimulator(route: route, options: options)
            .traceWithTruth(from: gapStart - 5_000, to: gapEnd + 5_000, startTime: start)
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        var lastBefore: (LocationSample, Double)?
        for (sample, truth) in trace where truth < gapStart {
            tracker.ingest(sample)
            lastBefore = (sample, truth)
        }
        // 60 seconds into the gap the estimate keeps moving forward and is flagged as estimated.
        let probeTime = lastBefore!.0.timestamp.addingTimeInterval(60)
        let estimate = tracker.estimate(at: probeTime)
        XCTAssertTrue(estimate.isEstimated)
        XCTAssertEqual(estimate.status, .onRoute)
        let expected = lastBefore!.1 + 60 * (lastBefore!.0.speed ?? 0)
        XCTAssertEqual(estimate.distanceAlongRoute, expected, accuracy: 150)
        for (sample, truth) in trace where truth > gapEnd {
            let m = tracker.ingest(sample)
            XCTAssertEqual(m.status, .onRoute)
            XCTAssertEqual(m.distanceAlongRoute, truth, accuracy: 40)
        }
        // Past the dead reckoning limit the status becomes signal lost and the distance freezes.
        let late = tracker.estimate(at: trace.last!.sample.timestamp.addingTimeInterval(600))
        XCTAssertEqual(late.status, .signalLost)
    }

    func testLeavingTheRouteTriggersOffRouteAfterConfirmation() {
        let route = Fixtures.route("atlanta_to_nashville")
        var options = GPSSimulator.Options()
        options.departure = (atDistance: 50_000, lateralSpeed: 12)
        let trace = GPSSimulator(route: route, options: options).traceWithTruth(from: 45_000, to: 52_000, startTime: start)
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        var offAt: Date?
        var lastOnRouteDistance = 0.0
        for (sample, _) in trace {
            let m = tracker.ingest(sample)
            if m.status == .onRoute { lastOnRouteDistance = m.distanceAlongRoute }
            if m.status == .offRoute, offAt == nil { offAt = sample.timestamp }
        }
        XCTAssertNotNil(offAt)
        // The departure started at 50 km. Progress must not run ahead while off route.
        XCTAssertLessThan(lastOnRouteDistance, 50_400)
        let departureTime = trace.first { $0.truth >= 50_000 }!.sample.timestamp
        XCTAssertLessThan(offAt!.timeIntervalSince(departureTime), 20)
    }

    func testAcquiresMidRoute() {
        let route = Fixtures.route("miami_to_manhattan")
        let trace = GPSSimulator(route: route).traceWithTruth(from: 900_000, to: 902_000, startTime: start)
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        let m = tracker.ingest(trace[0].sample)
        XCTAssertEqual(m.status, .onRoute)
        XCTAssertEqual(m.distanceAlongRoute, trace[0].truth, accuracy: 30)
    }

    /// Out and back on a two way road: both passes are 15 m apart. Course and continuity
    /// must keep the tracker on the correct pass.
    func testOutAndBackRouteKeepsCorrectPass() {
        let origin = GeoCoordinate(latitude: 35.0, longitude: -80.0)
        var pts: [GeoCoordinate] = []
        for i in 0...40 { pts.append(Geodesy.offset(origin, bearing: 0, meters: Double(i) * 50)) }
        let top = pts.last!
        let east = Geodesy.offset(top, bearing: 90, meters: 15)
        for i in 0...40 { pts.append(Geodesy.offset(east, bearing: 180, meters: Double(i) * 50)) }
        let polyline = RoutePolyline(points: pts)
        let route = PlannedRoute(source: .testFixture, polyline: polyline,
                                 timeProfile: .uniform(length: polyline.length, totalSeconds: polyline.length / 15),
                                 origin: Waypoint(name: "A", coordinate: pts.first!),
                                 destination: Waypoint(name: "B", coordinate: pts.last!))
        var options = GPSSimulator.Options()
        options.noise = 5
        let trace = GPSSimulator(route: route, options: options).traceWithTruth(startTime: start)
        var tracker = RouteProgressTracker(route: polyline, startedAt: start)
        for (sample, truth) in trace {
            let m = tracker.ingest(sample)
            XCTAssertEqual(m.distanceAlongRoute, truth, accuracy: 60, "jumped to the other pass")
        }
    }

    func testBadAccuracyFixesAreIgnored() {
        let route = Fixtures.route("atlanta_to_nashville")
        var tracker = RouteProgressTracker(route: route.polyline, startedAt: start)
        let good = GPSSimulator(route: route).trace(from: 10_000, to: 10_200, startTime: start)
        good.forEach { tracker.ingest($0) }
        let before = tracker.match
        var bad = good.last!
        bad.coordinate = Geodesy.offset(bad.coordinate, bearing: 90, meters: 5_000)
        bad.horizontalAccuracy = 500
        bad.timestamp = bad.timestamp.addingTimeInterval(1)
        let after = tracker.ingest(bad)
        XCTAssertEqual(after.status, .onRoute)
        XCTAssertEqual(after.distanceAlongRoute, before.distanceAlongRoute, accuracy: 30)
    }
}
