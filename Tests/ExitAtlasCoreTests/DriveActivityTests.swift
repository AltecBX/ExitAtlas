import XCTest
@testable import ExitAtlasCore

/// Live Activity content and the spoken answers for Siri, on the Miami to Manhattan fixture.
final class DriveActivityTests: XCTestCase {
    let mile = Geodesy.metersPerMile
    let start = Date(timeIntervalSince1970: 1_793_000_000)

    lazy var plan = TripPlan(route: Fixtures.route("miami_to_manhattan"),
                             datasets: TripDatasets(states: Fixtures.states, timeZones: TimeZoneResolver(zones: Fixtures.timeZones),
                                                    interstates: Fixtures.interstates, restAreas: Fixtures.restAreas))

    func snapshot(_ miles: Double, at date: Date? = nil) -> TripSnapshot {
        plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: miles * mile, offset: 0, isEstimated: false,
                                        timestamp: date ?? start, speed: 30),
                      ledger: TripLedger(), pace: PaceModel(), now: date ?? start)
    }

    func services(_ e: RouteExit) -> [ExitService] { Fixtures.interstates.services(for: e) }

    func testContentNearTheGeorgiaLine() {
        let s = snapshot(358)
        let c = DriveActivityContent(snapshot: s, services: services)
        XCTAssertEqual(c.stateCode, "FL")
        XCTAssertEqual(c.nextStateCode, "GA")
        XCTAssertEqual(c.nextStateName, "Georgia")
        XCTAssertEqual(c.stateLineMeters!, s.current!.remainingMeters, accuracy: 1)
        XCTAssertEqual(c.exitLabel, s.nextExit?.exit.label)
        XCTAssertEqual(c.restTitle, "Georgia Visitor Information Center")
        XCTAssertEqual(c.restKind, "welcome")
        XCTAssertEqual(c.eta, s.eta)
        XCTAssertNil(c.gasWarning)
        XCTAssertLessThan(c.encodedSize, 1024, "well under the 4 KB ActivityKit limit")
        let decoded = try! JSONDecoder().decode(DriveActivityContent.self, from: JSONEncoder().encode(c))
        XCTAssertEqual(decoded, c)
        XCTAssertNil(DriveActivityContent(snapshot: s, services: services, hasDestination: false).eta)
    }

    func testGasWarningOnlyWhenTheGapStartsSoon() {
        let s = snapshot(100)
        let exit = plan.exits.first { $0.distanceAlongRoute > 110 * mile }!
        let gap = GasGaps.Gap(from: exit.distanceAlongRoute, to: exit.distanceAlongRoute + 62 * mile,
                              before: GasGaps.Stop(distance: exit.distanceAlongRoute, exit: exit), after: nil, open: false)
        XCTAssertEqual(DriveActivityContent(snapshot: s, services: services, gasGap: gap).gasWarning,
                       "Last gas for 62 mi: \(exit.displayTitle)")
        let far = snapshot(exit.distanceAlongRoute / mile - 40)
        XCTAssertNil(DriveActivityContent(snapshot: far, services: services, gasGap: gap).gasWarning)
    }

    func testThrottle() {
        let t = DriveActivityThrottle()
        let a = DriveActivityContent(exitLabel: "373", exitMeters: 5.0 * mile, stateCode: "FL", nextStateCode: "GA",
                                     stateLineMeters: 15 * mile, updatedAt: start)
        XCTAssertTrue(t.shouldUpdate(from: nil, to: a, lastUpdate: nil, now: start))
        var b = a
        b.exitMeters = 4.9 * mile
        XCTAssertFalse(t.shouldUpdate(from: a, to: b, lastUpdate: start, now: start.addingTimeInterval(5)), "too soon")
        XCTAssertTrue(t.shouldUpdate(from: a, to: b, lastUpdate: start, now: start.addingTimeInterval(16)), "new tenth of a mile")
        var same = a
        same.exitMeters = 5.01 * mile
        XCTAssertFalse(t.shouldUpdate(from: a, to: same, lastUpdate: start, now: start.addingTimeInterval(30)), "same display")
        XCTAssertTrue(t.shouldUpdate(from: a, to: same, lastUpdate: start, now: start.addingTimeInterval(121)), "refresh")
        var next = a
        next.exitLabel = "380"
        XCTAssertTrue(t.shouldUpdate(from: a, to: next, lastUpdate: start, now: start.addingTimeInterval(1)), "new exit at once")
        var far = a
        far.stateLineMeters = 15.3 * mile
        XCTAssertFalse(t.shouldUpdate(from: a, to: far, lastUpdate: start, now: start.addingTimeInterval(20)), "whole miles above 10")
    }

    func testSpokenAnswers() {
        let s = snapshot(358)
        let georgia = TripAnswers.distanceToState("Georgia", snapshot: s)
        XCTAssertTrue(georgia.hasPrefix("Georgia is 16 miles ahead, about"), georgia)
        XCTAssertTrue(georgia.contains("Eastern Time"), georgia)
        XCTAssertEqual(TripAnswers.distanceToState("ga", snapshot: s), georgia)
        XCTAssertTrue(TripAnswers.distanceToState("Florida", snapshot: s).hasPrefix("You are in Florida."))
        XCTAssertEqual(TripAnswers.distanceToState("Texas", snapshot: s), "Texas is not on your route.")
        XCTAssertTrue(TripAnswers.distanceToState("Florida", snapshot: snapshot(400)).hasPrefix("You already drove through Florida"))
        let line = TripAnswers.nextStateLine(snapshot: s)
        XCTAssertTrue(line.hasPrefix("Georgia is 16 miles ahead"), line)
        XCTAssertTrue(line.hasSuffix("remain in Florida.") || line.hasSuffix("remains in Florida."), line)
        let rest = TripAnswers.nextRestArea(snapshot: s)
        XCTAssertTrue(rest.hasPrefix("The next welcome center is Georgia Visitor Information Center, 17 miles ahead"), rest)
        XCTAssertTrue(rest.hasSuffix("Its amenities are not listed."), rest)
        let exit = TripAnswers.nextExit(snapshot: s, services: services(s.nextExit!.exit))
        XCTAssertTrue(exit.hasPrefix("\(s.nextExit!.exit.displayTitle) is "), exit)
        let stops = GasGaps.stops(plan: plan, services: services)
        XCTAssertTrue(TripAnswers.nextGas(snapshot: s, stops: stops).hasPrefix("The next gas is Exit"))
        XCTAssertTrue(TripAnswers.arrival(snapshot: s, destination: "Manhattan", timeZoneID: "America/New_York")
            .hasPrefix("You arrive at Manhattan at about"))
    }
}
