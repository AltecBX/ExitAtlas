import XCTest
@testable import ExitAtlasCore

/// Discover ahead and travel statistics (the same cases as web/tests/discover.test.js).
final class DiscoverTravelTests: XCTestCase {
    let mile = Geodesy.metersPerMile

    func testDiscoverOnMiamiToManhattan() {
        XCTAssertEqual(Fixtures.discover.metadata.license, "CC0-1.0")
        XCTAssertGreaterThan(Fixtures.discover.items.count, 300)
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"),
                            datasets: TripDatasets(states: Fixtures.states, timeZones: nil, interstates: Fixtures.interstates,
                                                   discover: Fixtures.discover))
        let list = plan.discover
        XCTAssertGreaterThanOrEqual(list.count, 10)
        XCTAssertEqual(list.map(\.distanceAlongRoute), list.map(\.distanceAlongRoute).sorted())
        for x in list { XCTAssertLessThanOrEqual(x.offMeters, x.item.cat.nearMeters + 1, x.item.name) }
        XCTAssertTrue(list.contains { $0.exit != nil })
        // Same places as the JavaScript engine on this route.
        XCTAssertEqual(list.count, 173, list.map(\.item.name).joined(separator: ", "))
    }

    /// Travel statistics: miles and trips per state from real trips, no achievements.
    func testTravelStats() {
        let mile = Geodesy.metersPerMile
        let trips = [
            TravelStats.Trip(startedAt: Date(timeIntervalSince1970: 100), totalMeters: 620 * mile,
                             states: [("FL", "Florida", 374 * mile), ("GA", "Georgia", 112 * mile), ("SC", "South Carolina", 134 * mile)]),
            TravelStats.Trip(startedAt: Date(timeIntervalSince1970: 200), totalMeters: 60 * mile,
                             states: [("GA", "Georgia", 60 * mile), (nil, "Outside", 1)]),
        ]
        let t = TravelStats(trips: trips)
        XCTAssertEqual(t.states.map(\.code), ["FL", "GA", "SC"], "most miles first")
        let ga = t.states.first { $0.code == "GA" }!
        XCTAssertEqual(ga.trips, 2)
        XCTAssertEqual(ga.firstAt, Date(timeIntervalSince1970: 100))
        XCTAssertEqual(ga.lastAt, Date(timeIntervalSince1970: 200))
        XCTAssertEqual(ga.meters, 172 * mile, accuracy: 1)
        XCTAssertEqual(t.tripCount, 2)
        XCTAssertEqual(t.totalMeters, 680 * mile, accuracy: 1)
        XCTAssertTrue(TravelStats(trips: []).states.isEmpty)
    }
}
