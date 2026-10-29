import XCTest
@testable import ExitAtlasCore

/// Traffic engine on the shared SIMULATED fixtures (the same expectations as web/tests/traffic.test.js): arrival
/// times from route matched provider times without double counting, the stabilizer, slowdowns as Road
/// Intelligence alerts, and when a faster route is worth offering. No real traffic data is used here.
final class TrafficTests: XCTestCase {
    func fixture() throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("traffic/cases.json")))
    }

    func t(_ v: JSONValue?) -> Date { Date(timeIntervalSince1970: v!.number!) }

    func reading(_ x: JSONValue?) -> Traffic.Reading? {
        guard let x, !x.isNull else { return nil }
        return Traffic.Reading(routeId: x["routeId"]!.string!, measuredAt: t(x["measuredAt"]), fromAlong: x["fromAlong"]!.number!,
                               checkpoints: x["checkpoints"]!.array!.map { .init(along: $0["along"]!.number!, seconds: $0["seconds"]!.number!) },
                               source: .init(id: "sim", name: "Simulated traffic"))
    }

    /// The fixture's modeled road speeds, and the pace model as one factor.
    func timing(_ f: JSONValue, pace: Double) -> Traffic.Timing {
        let model = f["model"]!.array!.map { ($0["to"]!.number!, $0["mps"]!.number!) }
        return Traffic.Timing(modelSeconds: { a, b in
            var total = 0.0, start = 0.0
            for (to, mps) in model {
                let lo = max(a, start), hi = min(b, to)
                if hi > lo { total += (hi - lo) / mps }
                start = to
            }
            return total
        }, paceSeconds: { pace * $0 })
    }

    func testArrivalSecondsWithoutDoubleCounting() throws {
        let f = try fixture()
        for c in f["seconds"]!.array! {
            let s = Traffic.seconds(reading(c["reading"])!, from: c["progress"]!.number!, to: c["target"]!.number!,
                                    timing: timing(f, pace: c["pace"]!.number!))
            XCTAssertEqual(s, c["expect"]!.number!, accuracy: 0.01, c["name"]!.string!)
        }
    }

    func testReadingUsedOnlyOnItsRouteWhileFreshAndAhead() throws {
        for c in try fixture()["problems"]!.array! {
            let p = Traffic.problem(reading(c["reading"]), routeId: c["routeId"]!.string!, progress: c["progress"]!.number!, now: t(c["now"]))
            XCTAssertEqual(p?.rawValue, c["expect"]?.string, c["name"]!.string!)
        }
    }

    func testEveryArrivalNamesItsBasis() throws {
        for c in try fixture()["basis"]!.array! {
            let r = Traffic.Reading(routeId: "r1", measuredAt: Date(), fromAlong: 0, checkpoints: [.init(along: c["lastAlong"]!.number!, seconds: 1)],
                                    source: .init(id: "sim", name: "Simulated traffic"))
            let b = Traffic.basis(r, usable: c["usable"]!.bool!, target: c["target"]!.number!, paceKnown: c["paceKnown"]!.bool!)
            XCTAssertEqual(b.rawValue, c["expect"]!.string!)
        }
    }

    func testStabilizerTakesSmallMovesAndConfirmsBigJumps() throws {
        let f = try fixture()
        let tm = timing(f, pace: 1)
        var st = Traffic.Stabilizer()
        for (i, s) in f["stability"]!["steps"]!.array!.enumerated() {
            let p = s["progress"]!.number!
            let out = st.offer(reading(s["reading"]), routeId: f["stability"]!["routeId"]!.string!, progress: p, now: t(s["now"]), timing: tm)
            XCTAssertEqual(out.changed, s["changed"]!.bool!, "step \(i) changed")
            XCTAssertEqual(Traffic.seconds(out.reading!, from: p, to: 70000, timing: tm), s["expectSeconds"]!.number!, accuracy: 0.01, "step \(i) seconds")
        }
    }

    func testSlowdownsBecomeRoadIntelligenceAlertsOnTheRoute() throws {
        let s = try fixture()["slowdowns"]!
        let sections = s["sections"]!.array!.map {
            Traffic.Section(from: $0["from"]!.number!, to: $0["to"]!.number!, level: Traffic.Level(rawValue: $0["level"]!.string!),
                            delaySeconds: $0["delaySeconds"]?.number, speedMph: $0["speedMph"]?.number)
        }
        let progress = s["progress"]!.number!
        let source = RoadIntel.Source(id: s["source"]!["id"]!.string!, name: s["source"]!["name"]!.string!)
        let out = Traffic.slowdownIncidents(sections, routeId: s["routeId"]!.string!, progress: progress, measuredAt: t(s["measuredAt"]), source: source)
        let expect = s["expect"]!.array!
        XCTAssertEqual(out.map(\.id), expect.map { $0["id"]!.string! })
        for (i, x) in zip(out, expect) {
            XCTAssertEqual(i.severity.rawValue, x["severity"]!.string!)
            XCTAssertEqual(i.description, x["description"]!.string!)
            XCTAssertEqual(i.delaySeconds, x["delaySeconds"]?.number)
            XCTAssertEqual(i.verification, .measured)
            XCTAssertEqual(i.expiresAt, t(s["measuredAt"]).addingTimeInterval(900))
            XCTAssertEqual(i.headline, x["headline"]!.string!)
            XCTAssertEqual(i.tier.rawValue, x["tier"]!.string!)
            XCTAssertEqual(i.kind.group, .traffic)
        }
        // On the route measured, from where the driver is to the section's end; never on another route.
        let route = Fixtures.route("miami_to_manhattan")
        let mine = Traffic.slowdownIncidents(sections, routeId: route.id.uuidString, progress: progress, measuredAt: t(s["measuredAt"]), source: source)
        for (i, x) in zip(mine, expect) {
            XCTAssertEqual(RoadIntel.place(i, on: route, progress: progress),
                           .ahead(start: max(x["from"]!.number!, progress), end: x["to"]!.number!, directionKnown: true))
        }
        XCTAssertEqual(RoadIntel.place(out[0], on: route, progress: progress), .rejected("other route"))
    }

    func testSnapshotUsesTrafficWhereMeasuredThenPaceAndNamesItsBasis() {
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: TripSnapshotTests.datasets)
        let now = Date(timeIntervalSince1970: 1_793_000_000)
        let mile = Geodesy.metersPerMile
        let d = 450 * mile, cp = d + 50 * mile, end = plan.route.length
        let match = RouteMatch(status: .onRoute, distanceAlongRoute: d, offset: 0, isEstimated: false, timestamp: now, speed: 30)
        var pace = PaceModel()
        for _ in 0..<60 { pace.observe(expected: 60, actual: 66, meters: 1500) }
        let reading = Traffic.Reading(routeId: plan.route.id.uuidString, measuredAt: now.addingTimeInterval(-60), fromAlong: d - 100,
                                      checkpoints: [.init(along: cp, seconds: 4000)], source: .init(id: "sim", name: "Simulated traffic"))
        let s = plan.snapshot(match: match, ledger: TripLedger(), pace: pace, now: now, traffic: reading)
        let tm = Traffic.Timing(modelSeconds: { plan.route.timeProfile.seconds(from: $0, to: $1) }, paceSeconds: { pace.seconds(forModelSeconds: $0) })
        XCTAssertEqual(plan.eta(to: cp, from: s).timeIntervalSince(now), Traffic.seconds(reading, from: d, to: cp, timing: tm), accuracy: 1e-6)
        XCTAssertEqual(s.basis(to: cp), .traffic)
        XCTAssertEqual(s.arrivalBasis, .trafficThenPace)
        // Beyond the reading: the driver's pace from where it ends, not from here (nothing counted twice).
        let beyond = pace.seconds(forModelSeconds: tm.modelSeconds(d, end)) - pace.seconds(forModelSeconds: tm.modelSeconds(d, cp))
        XCTAssertEqual(s.eta.timeIntervalSince(plan.eta(to: cp, from: s)), beyond, accuracy: 1e-6)
        // Stale, or measured on another route: the pace based time, labeled as such.
        let paced = plan.snapshot(match: match, ledger: TripLedger(), pace: pace, now: now)
        var stale = reading, other = reading
        stale.measuredAt = now.addingTimeInterval(-901)
        other.routeId = "other"
        for r in [stale, other] {
            let x = plan.snapshot(match: match, ledger: TripLedger(), pace: pace, now: now, traffic: r)
            XCTAssertNil(x.traffic)
            XCTAssertEqual(x.eta, paced.eta)
            XCTAssertEqual(x.arrivalBasis, .pace)
        }
        XCTAssertEqual(plan.snapshot(match: match, ledger: TripLedger(), pace: PaceModel(), now: now).arrivalBasis, .model)
    }

    func measurement(_ x: JSONValue, along: Double = 0) -> Traffic.Measurement {
        Traffic.Measurement(along: x["along"]?.number ?? along, routeMeters: x["routeMeters"]!.number!,
                            providerMeters: x["providerMeters"]!.number!, seconds: x["seconds"]!.number!)
    }

    func testProviderTimesOnlyForTheRoadDrivenInOrder() throws {
        let m = try fixture()["measurements"]!
        let r = Traffic.reading(routeId: "r1", measuredAt: Date(), fromAlong: m["fromAlong"]!.number!,
                                measurements: m["measurements"]!.array!.map { measurement($0) }, source: .init(id: "sim", name: "Simulated traffic"))
        XCTAssertEqual(r?.checkpoints, m["expect"]!.array!.map { Traffic.Checkpoint(along: $0["along"]!.number!, seconds: $0["seconds"]!.number!) })
        XCTAssertNil(Traffic.reading(routeId: "r1", measuredAt: Date(), fromAlong: 0, measurements: [], source: .init(id: "sim", name: "Simulated traffic")))
    }

    func testExtraTimeBothMatchedAndAtLeastThreeMinutes() throws {
        for c in try fixture()["extra"]!.array! {
            XCTAssertEqual(Traffic.extraSeconds(traffic: measurement(c["traffic"]!), ideal: measurement(c["ideal"]!)), c["expect"]?.number, c["name"]!.string!)
        }
    }

    func testRefreshWhileMovingNeverParkedOrInBackgroundBackingOff() throws {
        let policy = Traffic.RefreshPolicy()
        for c in try fixture()["refresh"]!.array! {
            let due = policy.isDue(lastAttempt: c["lastAttempt"]?.number.map { Date(timeIntervalSince1970: $0) }, failures: Int(c["failures"]!.number!),
                                   routeChanged: c["routeChanged"]!.bool!, stillFor: c["stillFor"]!.number!, foreground: c["foreground"]!.bool!,
                                   now: t(c["now"]))
            XCTAssertEqual(due, c["expect"]!.bool!, c["name"]!.string!)
        }
    }

    func testFasterRoutesOnlyForARealRepeatedSavingThatKeepsThePlan() throws {
        for c in try fixture()["alternatives"]!.array! {
            var advisor = Traffic.Advisor()
            let minSaving = c["prefs"]?["minSavingSeconds"]?.number ?? 600
            let avoidTolls = c["prefs"]?["avoidTolls"]?.bool ?? false
            for (i, s) in c["steps"]!.array!.enumerated() {
                let cur = s["current"]!, alt = s["alternative"]!
                let out = advisor.advise(
                    current: .init(seconds: cur["seconds"]!.number!, meters: cur["meters"]!.number!, closureAhead: cur["closureAhead"]!.bool!),
                    alternative: .init(id: alt["id"]!.string!, seconds: alt["seconds"]!.number!, meters: alt["meters"]!.number!,
                                       tolls: alt["tolls"]?.bool, keepsStops: alt["keepsStops"]!.bool!,
                                       closureAhead: alt["closureAhead"]!.bool!, missesStop: alt["missesStop"]?.string),
                    minSavingSeconds: minSaving, avoidTolls: avoidTolls, now: t(s["now"]))
                let label = "\(c["name"]!.string!), step \(i)"
                let x = s["expect"]!
                if x["offer"]!.bool! {
                    XCTAssertEqual(out.offer?.savedSeconds, x["savedSeconds"]!.number!, label)
                    XCTAssertEqual(out.offer?.extraMeters, x["extraMeters"]!.number!, label)
                    XCTAssertEqual(out.offer?.notes, x["notes"]!.array!.map { $0.string! }, label)
                } else {
                    XCTAssertNil(out.offer, label)
                    XCTAssertEqual(out.hold?.rawValue, x["reason"]!.string!, label)
                }
                if s["then"]?.string == "snooze", let o = out.offer { advisor.snooze(o, now: t(s["now"])) }
            }
        }
    }
}
