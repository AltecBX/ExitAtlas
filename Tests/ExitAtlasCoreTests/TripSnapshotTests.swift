import XCTest
@testable import ExitAtlasCore

/// Dashboard values on the real Florida to New York route, checked against independent data.
final class TripSnapshotTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_793_000_000)
    static let datasets = TripDatasets(states: Fixtures.states, timeZones: TimeZoneResolver(zones: Fixtures.timeZones),
                                       interstates: Fixtures.interstates)
    static let miami = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)

    func match(_ d: Double) -> RouteMatch {
        RouteMatch(status: .onRoute, distanceAlongRoute: d, offset: 0, isEstimated: false, timestamp: now, speed: 30)
    }

    func testStateOrderAndUpcomingStatesFromFlorida() {
        let plan = Self.miami
        let s = plan.snapshot(match: match(100 * Geodesy.metersPerMile), ledger: TripLedger(), pace: PaceModel(), now: now)
        XCTAssertEqual(s.current?.segment.code, "FL")
        XCTAssertEqual(s.next?.segment.code, "GA")
        XCTAssertEqual(s.statesAhead, ["GA", "SC", "NC", "VA", "DC", "MD", "DE", "NJ", "NY"])
        XCTAssertEqual(s.borderCrossingsRemaining, 9)
        let expected = Fixtures.load("miami_to_manhattan").expected.states
        XCTAssertEqual(s.current!.remainingMeters, expected[0].end_m - 100 * Geodesy.metersPerMile, accuracy: 80)
        XCTAssertEqual(s.next!.totalMeters, expected[1].length_m, accuracy: 80)
        XCTAssertEqual(s.distanceToNextBorder!, s.current!.remainingMeters, accuracy: 0.001)
        XCTAssertEqual(s.remaining, plan.route.length - 100 * Geodesy.metersPerMile, accuracy: 0.001)
    }

    /// Exits before the Georgia line, counted independently: OSM node membership along the
    /// fixture route (distances from the fixture geometry), merged with the same signage rule.
    func testExitsRemainingBeforeBorderMatchesNodeMembership() {
        let plan = Self.miami
        let (fixture, expected) = Fixtures.load("miami_to_manhattan")
        let byNode = Dictionary(uniqueKeysWithValues: Fixtures.interstates.exits.map { ($0.osmNodeID, $0) })
        let nodeIndex = Dictionary(fixture.osm_nodes.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        let truth: [(distance: Double, label: String)] = expected.exits_on_route.compactMap { node in
            guard let i = nodeIndex[node], let rec = byNode[node] else { return nil }
            return (plan.route.polyline.cumulativeDistances[i], rec.label)
        }
        let border = expected.states[0].end_m
        for miles in [10.0, 120, 250, 370] {
            let d = miles * Geodesy.metersPerMile
            var count = 0
            var last: (distance: Double, label: String)?
            for t in truth where t.distance > d && t.distance < border {
                if let l = last, !t.label.isEmpty, l.label == t.label, t.distance - l.distance <= 800 {
                    last = t
                    continue
                }
                count += 1
                last = t
            }
            let s = plan.snapshot(match: match(d), ledger: TripLedger(), pace: PaceModel(), now: now)
            // Snapshot-version skew can add exits that lie exactly on the route (see ExitMatchingFixtureTests).
            XCTAssertGreaterThanOrEqual(s.current!.exitsRemaining, count, "at mile \(miles)")
            XCTAssertLessThanOrEqual(s.current!.exitsRemaining, count + 3, "at mile \(miles)")
        }
    }

    func testEtasFollowTheTravelTimeModel() {
        let plan = Self.miami
        let d = 50 * Geodesy.metersPerMile
        let s = plan.snapshot(match: match(d), ledger: TripLedger(), pace: PaceModel(), now: now)
        let border = s.current!.segment.endDistance
        XCTAssertEqual(s.current!.exitTime!.timeIntervalSince(now),
                       plan.route.timeProfile.seconds(from: d, to: border), accuracy: 1)
        XCTAssertEqual(s.eta.timeIntervalSince(now), plan.route.timeProfile.seconds(from: d, to: plan.route.length), accuracy: 1)
        // Upcoming segments are ordered and their entry times increase.
        let upcoming = s.itinerary.filter { $0.status == .upcoming }
        for (a, b) in zip(upcoming, upcoming.dropFirst()) {
            XCTAssertLessThanOrEqual(a.entryTime!, b.entryTime!)
            XCTAssertEqual(a.exitTime!, b.entryTime!)
        }
        // A slower observed pace pushes the ETA out proportionally.
        var pace = PaceModel()
        for _ in 0..<60 { pace.observe(expected: 60, actual: 72) }
        let slower = plan.snapshot(match: match(d), ledger: TripLedger(), pace: pace, now: now)
        XCTAssertGreaterThan(slower.eta, s.eta)
        let model = plan.route.timeProfile.seconds(from: d, to: plan.route.length)
        XCTAssertEqual(slower.timeRemaining, pace.seconds(forModelSeconds: model), accuracy: 1)
    }

    func testHighwayAndDirection() {
        let plan = Self.miami
        // Mile 450 is on I-95 in Georgia, northbound.
        let s = plan.snapshot(match: match(450 * Geodesy.metersPerMile), ledger: TripLedger(), pace: PaceModel(), now: now)
        XCTAssertEqual(s.current?.segment.code, "GA")
        XCTAssertEqual(s.highway?.shortLabel, "I-95 N")
    }

    func testTimeZonesOnAtlantaToNashville() {
        let plan = TripPlan(route: Fixtures.route("atlanta_to_nashville"), datasets: Self.datasets)
        let s = plan.snapshot(match: match(0), ledger: TripLedger(), pace: PaceModel(), now: now)
        XCTAssertEqual(s.itinerary.first?.entryTimeZoneID, "America/New_York")
        XCTAssertEqual(s.itinerary.last?.exitTimeZoneID, "America/Chicago")
        XCTAssertEqual(plan.timeZoneID(at: plan.route.length - 1000), "America/Chicago")
        // The Eastern to Central change happens inside the final Tennessee stretch, not at a state line.
        let zones = RegionSegmenter().segment(plan.route.polyline, regions: Fixtures.timeZones)
        XCTAssertEqual(zones.segments.map(\.code), ["Eastern", "Central"])
        let tzCrossing = zones.segments[1].startDistance
        let lastTennessee = plan.states.segments.last!
        XCTAssertEqual(lastTennessee.code, "TN")
        XCTAssertGreaterThan(tzCrossing, lastTennessee.startDistance)
    }

    func testCompletedStatesSeparateFromUpcoming() {
        let plan = Self.miami
        let d = 700 * Geodesy.metersPerMile
        let s = plan.snapshot(match: match(d), ledger: TripLedger(), pace: PaceModel(), now: now)
        let completed = s.itinerary.filter { $0.status == .completed }.map(\.segment.code)
        let upcoming = s.itinerary.filter { $0.status == .upcoming }.map(\.segment.code)
        XCTAssertEqual(completed + [s.current!.segment.code] + upcoming, plan.states.segments.map(\.code))
        XCTAssertFalse(completed.isEmpty)
        XCTAssertFalse(upcoming.isEmpty)
    }
}
