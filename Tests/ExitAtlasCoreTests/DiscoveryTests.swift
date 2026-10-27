import XCTest
@testable import ExitAtlasCore

/// Discovery mode on real geometry: drive I-95 north in Georgia with no destination.
final class DiscoveryTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_793_000_000)

    func testLocksOntoI95NorthboundAndForecastsNextState() {
        let route = Fixtures.route("miami_to_manhattan")
        let trace = GPSSimulator(route: route).trace(from: 430 * Geodesy.metersPerMile,
                                                     to: 431 * Geodesy.metersPerMile, startTime: start)
        var discovery = HighwayDiscovery(corridors: Fixtures.corridors)
        var locked: CorridorMatch?
        for sample in trace {
            if case let .locked(m) = discovery.ingest(sample) { locked = m }
        }
        XCTAssertEqual(locked?.corridor.highway, "I-95")
        XCTAssertEqual(locked?.corridor.directionCode, "NB")

        let ahead = HighwayDiscovery.routeAhead(of: locked!, now: start)
        let plan = TripPlan(route: ahead, datasets: TripDatasets(states: Fixtures.states, timeZones: nil,
                                                                 interstates: Fixtures.interstates))
        XCTAssertEqual(plan.states.segments.first?.code, "GA")
        XCTAssertEqual(plan.states.segments.dropFirst().first?.code, "SC")
        XCTAssertGreaterThan(plan.exits.count, 10)
        let s = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: 0, offset: 0, isEstimated: false,
                                                timestamp: start, speed: 30),
                              ledger: TripLedger(), pace: PaceModel(), now: start)
        XCTAssertEqual(s.highway?.shortLabel, "I-95 N")
    }

    func testDoesNotLockWhenStationary() {
        let route = Fixtures.route("miami_to_manhattan")
        var sample = GPSSimulator(route: route).trace(from: 430 * Geodesy.metersPerMile, to: 430.1 * Geodesy.metersPerMile,
                                                      startTime: start)[0]
        sample.speed = 0
        var discovery = HighwayDiscovery(corridors: Fixtures.corridors)
        for i in 0..<10 {
            sample.timestamp = start.addingTimeInterval(Double(i))
            if case .locked = discovery.ingest(sample) { XCTFail("locked while stationary") }
        }
    }
}
