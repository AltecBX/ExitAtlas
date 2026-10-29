import XCTest
@testable import ExitAtlasCore

/// Siri answers built on SmartStop: the next station of a brand, the best stop ahead, and an open gas
/// station with a restroom, on the real Miami to Manhattan route.
final class SmartStopAnswerTests: XCTestCase {
    let mile = Geodesy.metersPerMile
    let now = Date(timeIntervalSince1970: 1_793_000_000)

    func context(atMiles miles: Double) throws -> SmartStop.TripContext {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: TimeZoneResolver(zones: Fixtures.timeZones),
                                    interstates: Fixtures.interstates, restAreas: Fixtures.restAreas)
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)
        let s = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: miles * mile, offset: 0, isEstimated: false,
                                                timestamp: now, speed: 30), ledger: TripLedger(), pace: PaceModel(), now: now)
        let stations = try StationFacts(contentsOf: Fixtures.dataDirectory.appendingPathComponent("stations.json"))
        return SmartStop.TripContext(plan: plan, snapshot: s, dataset: Fixtures.interstates, stations: stations)
    }

    func testNextBrandNamesTheNearestListedStationOfThatBrand() throws {
        let ctx = try context(atMiles: 100)
        let candidates = SmartStop.aheadCandidates(ctx, miles: 150, rangeLeft: nil)
        let text = TripAnswers.nextBrand("Shell", candidates: candidates, preferences: .init(), now: now, window: 150 * mile)
        let truth = candidates.filter { ($0.ahead ?? 0) > 0 && $0.gone == nil && SmartStop.brandIndex($0, favorites: ["Shell"]) != nil }
            .min { $0.along < $1.along }!
        XCTAssertTrue(text.hasPrefix("The next Shell: Shell at exit \(truth.exitLabel!), "), text)
        XCTAssertTrue(text.contains("Hours unavailable.") || text.contains("Reported") || text.contains("Verified"), text)
        let none = TripAnswers.nextBrand("Nonexistent Fuel Co", candidates: candidates, preferences: .init(), now: now, window: 150 * mile)
        XCTAssertEqual(none, "No Nonexistent Fuel Co is listed in the next 150 miles on your route.")
    }

    /// Google Maps facts (business hours, the restroom field) are never spoken: Google's terms forbid text to
    /// speech of its content. The answer points to the app instead. Simulated candidate.
    func testSpokenAnswersLeaveOutGoogleFacts() {
        let google = SmartStop.Candidate(id: "g", name: "Shell", brand: "Shell", exitID: "x", exitLabel: "93", along: 5 * mile, ahead: 5 * mile,
                                         arrival: now, timeZone: TimeZone(identifier: "America/New_York")!,
                                         livePeriods: [GooglePeriod(open: .init(day: 0))], liveRestroom: true)
        let text = TripAnswers.nextBrand("Shell", candidates: [google], preferences: .init(), now: now, window: 150 * mile)
        XCTAssertTrue(text.contains("Hours from Google Maps are shown in the app."), text)
        XCTAssertFalse(text.contains("Verified"), text)
        let r = SmartStop.choose([google], preferences: .init(), context: .ahead)
        let answer = TripAnswers.smartStop(r, now: now, window: 50 * mile, restroom: true)
        XCTAssertTrue(answer.contains("Restroom details from Google Maps are shown in the app."), answer)
        XCTAssertFalse(answer.contains("Verified") || answer.contains("confirmed available"), answer)
    }

    func testBestStopAndRestroomAnswersStateWhatIsNotConfirmed() throws {
        let ctx = try context(atMiles: 300)
        let best = SmartStop.choose(SmartStop.aheadCandidates(ctx, miles: 50, rangeLeft: nil), preferences: .init(), context: .ahead)
        let text = TripAnswers.smartStop(best, now: now, window: 50 * mile, restroom: false)
        XCTAssertTrue(text.hasPrefix("SmartStop picks "), text)
        XCTAssertFalse(text.contains("accessible at estimated arrival") && best.primary?.candidate.kind == .station, text)

        var prefs = SmartStop.Preferences()
        prefs.require24Hours = "always"
        prefs.requireRestroom = "always"
        let gas = SmartStop.choose(SmartStop.aheadCandidates(ctx, miles: 60, rangeLeft: nil), preferences: prefs, context: .ahead)
        let answer = TripAnswers.smartStop(gas, now: now, window: 60 * mile, restroom: true)
        XCTAssertTrue(answer.hasPrefix("The best match: "), answer)
        // Never says a station restroom is open at arrival; says what is unknown.
        XCTAssertFalse(answer.contains("Restroom confirmed accessible") && gas.primary?.candidate.kind == .station, answer)
        if gas.primary?.evaluation.restroom != .accessible { XCTAssertNotNil(gas.notice, answer) }
        // Restroom availability is spoken once, not in both the stop and the notice.
        if let p = gas.primary, gas.notice != nil { XCTAssertFalse(answer.contains(p.evaluation.restroom.label + "."), answer) }
        XCTAssertEqual(TripAnswers.smartStop(nil, now: now, window: 50 * mile, restroom: false), "No stop is listed in the next 50 miles on your route.")
        if ProcessInfo.processInfo.environment["PRINT_ANSWERS"] != nil {
            print("ANS1", TripAnswers.nextBrand("Shell", candidates: SmartStop.aheadCandidates(ctx, miles: 150, rangeLeft: nil), preferences: .init(), now: now, window: 150 * mile))
            print("ANS2", text)
            print("ANS3", answer)
        }
    }
}
