import XCTest
@testable import ExitAtlasCore

/// The pace model shared with the web version (web/tests/engine.test.js has the same cases).
final class PaceTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_793_000_000)

    func testRecentPaceDrivesNearTargetsTripPaceFarOnes() {
        var pace = PaceModel()
        XCTAssertNil(pace.recentFactor)
        XCTAssertEqual(pace.factor(forModelSeconds: 600), 1)
        // 30 minutes at the model pace, then 10 minutes 50% faster than the model (84 vs 56 mph).
        for _ in 0..<1800 { pace.observe(expected: 1, actual: 1, meters: 25) }
        for _ in 0..<600 { pace.observe(expected: 1.5, actual: 1, meters: 37.5) }
        XCTAssertLessThan(pace.recentFactor!, 0.75)
        XCTAssertEqual(pace.recentSpeed!, 37.5 * 0.865 + 25 * 0.135, accuracy: 1.5)
        XCTAssertGreaterThan(pace.factor, 0.8)
        // The inverse used by the stop planner round trips.
        XCTAssertEqual(pace.seconds(forModelSeconds: pace.modelSeconds(forSeconds: 5400)), 5400, accuracy: 0.01)
        // A prior from earlier trips starts the trip pace at the driver's usual pace.
        XCTAssertEqual(PaceModel(priorFactor: 0.7).factor, 0.7, accuracy: 1e-9)
        XCTAssertLessThan(pace.factor(forModelSeconds: 600), pace.factor(forModelSeconds: 8 * 3600))
        XCTAssertEqual(pace.factor(forModelSeconds: 0), pace.recentFactor!, accuracy: 1e-9)
        // Stops do not count: a 10 minute stop is never observed, so nothing changes.
        let before = pace.factor(forModelSeconds: 1800)
        pace.observe(expected: 0, actual: 600)
        XCTAssertEqual(pace.factor(forModelSeconds: 1800), before, accuracy: 1e-12)
    }

    func testDrivingFiftyPercentFasterNextStateLineWithinThreePercent() {
        // Atlanta to Nashville: 20 minutes at 1.5 times the modeled speed, then predict the Tennessee line.
        let route = Fixtures.route("atlanta_to_nashville")
        let plan = TripPlan(route: route, datasets: TripDatasets(states: Fixtures.states, timeZones: nil, interstates: nil))
        var session = TripSession(plan: plan, states: Fixtures.states, startedAt: start)
        var options = GPSSimulator.Options()
        options.speedFactor = 1.5
        options.noise = 5
        let trace = GPSSimulator(route: route, options: options).traceWithTruth(from: 20_000, startTime: start)
        var snapshot: TripSnapshot?
        var k = 0
        while k < trace.count, trace[k].sample.timestamp < start.addingTimeInterval(1200) {
            snapshot = session.ingest(trace[k].sample)
            k += 1
        }
        guard let s = snapshot, let current = s.current, let predicted = current.exitTime else { return XCTFail("no snapshot") }
        let border = current.segment.endDistance
        guard let actual = trace.first(where: { $0.truth >= border })?.sample.timestamp else { return XCTFail("never crossed") }
        let ahead = actual.timeIntervalSince(s.timestamp)
        XCTAssertGreaterThan(ahead, 1200)
        let modelOnly = plan.route.timeProfile.seconds(from: s.progress, to: border)
        XCTAssertGreaterThan(modelOnly / ahead, 1.4, "the model alone would be about 50% late")
        let error = abs(predicted.timeIntervalSince(actual)) / ahead
        XCTAssertLessThan(error, 0.03, "ETA error \(error * 100)%")
    }

    func testHistoryGivesTheUsualPaceAfterHalfAnHour() {
        var history = PaceHistory()
        var fast = PaceModel()
        for _ in 0..<20 { fast.observe(expected: 60, actual: 48) }   // 20 modeled minutes at 0.8
        history.record(key: "a", pace: fast)
        XCTAssertEqual(history.priorFactor(), 1, "under 30 modeled minutes of history")
        history.record(key: "b", pace: fast)
        XCTAssertEqual(history.priorFactor(), 0.8, accuracy: 1e-9)
        XCTAssertEqual(history.priorFactor(excluding: "b"), 1, "the trip in progress is excluded")
        history.record(key: "b", pace: fast)
        XCTAssertEqual(history.trips.count, 2, "recording a trip again replaces it")
        for i in 0..<30 { history.record(key: "t\(i)", pace: fast) }
        XCTAssertEqual(history.trips.count, PaceHistory.maxTrips)
    }

    func testOldSavedRecordsStillDecode() throws {
        let old = #"{"observedSeconds": 3600, "expectedSeconds": 3000, "priorSeconds": 1800}"#
        let pace = try JSONDecoder().decode(PaceModel.self, from: Data(old.utf8))
        XCTAssertEqual(pace.observedSeconds, 3600)
        XCTAssertEqual(pace.priorFactor, 1)
        XCTAssertNil(pace.recentFactor)
        let round = try JSONDecoder().decode(PaceModel.self, from: JSONEncoder().encode(pace))
        XCTAssertEqual(round, pace)
    }
}
