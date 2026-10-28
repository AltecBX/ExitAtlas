import XCTest
@testable import ExitAtlasCore

/// Rerouting mid-trip: Richmond to New York, first on the New Jersey Turnpike route, then
/// switched to the route through Pennsylvania while still in Maryland (before the routes split).
/// Driven state mileage must come out the same as if the second route had been driven throughout.
final class RerouteTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_793_000_000)

    func testLedgerSurvivesRerouteAndStateTotalsMatchDrivenRoute() {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: nil, interstates: Fixtures.interstates)
        let turnpike = Fixtures.route("richmond_to_nyc_turnpike")
        let viaPA = Fixtures.route("richmond_to_nyc_via_pa")
        var session = TripSession(plan: TripPlan(route: turnpike, datasets: datasets), states: Fixtures.states, startedAt: start)

        // Drive the shared prefix to a point in Maryland.
        let switchDistance = 250_000.0
        let first = GPSSimulator(route: turnpike).traceWithTruth(to: switchDistance, startTime: start)
        for (sample, _) in first { session.ingest(sample) }
        let lastSample = first.last!.sample
        XCTAssertEqual(session.plan.states.segment(at: switchDistance)?.code, "MD")

        // New route from the current position: the remainder of the Pennsylvania route.
        let projection = viaPA.polyline.nearestProjection(of: lastSample.coordinate, within: 50)!
        let remainder = viaPA.polyline.slice(from: projection.distanceAlong, to: viaPA.polyline.length)
        let profile = TravelTimeProfile.uniform(length: remainder.length,
                                                totalSeconds: viaPA.timeProfile.seconds(from: projection.distanceAlong, to: viaPA.length))
        let rerouted = PlannedRoute(source: .osrm, polyline: remainder, timeProfile: profile,
                                    origin: Waypoint(name: "Here", coordinate: remainder.points.first!),
                                    destination: viaPA.destination)
        session.replacePlan(TripPlan(route: rerouted, datasets: datasets), at: lastSample.timestamp)
        XCTAssertEqual(session.plan.states.segments.map(\.code), ["MD", "DE", "PA", "NJ", "NY"])

        let second = GPSSimulator(route: viaPA).traceWithTruth(from: projection.distanceAlong + 20,
                                                               startTime: lastSample.timestamp.addingTimeInterval(1))
        var snapshot: TripSnapshot?
        for (sample, _) in second { snapshot = session.ingest(sample) }

        // Per state driven miles equal the via-PA route's state lengths from the oracle.
        let expected = Fixtures.load("richmond_to_nyc_via_pa").expected.states
        let totals = session.ledger.totalsByRegion
        XCTAssertEqual(totals.map(\.code), expected.map(\.code))
        for (got, want) in zip(totals, expected) {
            // Tolerance covers the first fix of the trip and the last fix before the destination.
            XCTAssertEqual(got.meters, want.length_m, accuracy: 120, "\(want.code ?? "-")")
        }
        XCTAssertEqual(snapshot?.current?.segment.code, "NY")
        // Maryland miles are continuous across the reroute: one stint, not two.
        XCTAssertEqual(session.ledger.stints.filter { $0.regionCode == "MD" }.count, 1)
    }

    func testNeedsRerouteAfterLeavingRoute() {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: nil, interstates: nil)
        let route = Fixtures.route("atlanta_to_nashville")
        var session = TripSession(plan: TripPlan(route: route, datasets: datasets), states: Fixtures.states, startedAt: start)
        var options = GPSSimulator.Options()
        options.departure = (atDistance: 30_000, lateralSpeed: 10)
        let trace = GPSSimulator(route: route, options: options).trace(from: 25_000, to: 34_000, startTime: start)
        var requested = false
        for sample in trace {
            session.ingest(sample)
            if session.needsReroute(at: sample.timestamp) { requested = true }
        }
        XCTAssertTrue(requested)
        // Off route GPS distance is still credited to the state being driven.
        XCTAssertEqual(session.ledger.totalsByRegion.first?.code, "GA")
        XCTAssertGreaterThan(session.ledger.totalMeters, 8_000)
    }
}
