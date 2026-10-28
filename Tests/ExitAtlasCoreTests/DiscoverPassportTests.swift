import XCTest
@testable import ExitAtlasCore

/// Discover ahead and the Road Trip Passport (the same cases as web/tests/discover.test.js).
final class DiscoverPassportTests: XCTestCase {
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

    func testPassport() {
        let trips = [
            Passport.Trip(startedAt: Date(timeIntervalSince1970: 100), totalMeters: 620 * mile,
                          states: [("FL", "Florida", 374 * mile), ("GA", "Georgia", 112 * mile), ("SC", "South Carolina", 134 * mile)]),
            Passport.Trip(startedAt: Date(timeIntervalSince1970: 200), totalMeters: 60 * mile,
                          states: [("GA", "Georgia", 60 * mile), (nil, "Outside", 1)]),
        ]
        let p = Passport(trips: trips)
        XCTAssertEqual(p.stamps.count, 3)
        XCTAssertEqual(p.stamps["GA"]?.trips, 2)
        XCTAssertEqual(p.stamps["GA"]?.firstAt, Date(timeIntervalSince1970: 100))
        XCTAssertEqual(p.stamps["GA"]?.lastAt, Date(timeIntervalSince1970: 200))
        XCTAssertEqual(p.stamps["GA"]!.meters, 172 * mile, accuracy: 1)
        let a = Dictionary(uniqueKeysWithValues: p.achievements.map { ($0.id, $0) })
        XCTAssertTrue(a["first-trip"]!.earned)
        XCTAssertTrue(a["long-haul"]!.earned)
        XCTAssertFalse(a["states-5"]!.earned)
        XCTAssertEqual(a["states-5"]!.progress, 0.6, accuracy: 1e-9)
        XCTAssertEqual(a["states-5"]!.detail, "3 of 5 states")
        XCTAssertEqual(a["coast-to-coast"]!.progress, 0.5)
        XCTAssertTrue(Passport(trips: []).achievements.allSatisfy { !$0.earned })
        XCTAssertEqual(Passport.stateCodes.count, 51)
    }
}
