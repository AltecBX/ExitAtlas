import XCTest
@testable import ExitAtlasCore

/// Rest areas and service plazas on real routes (the same cases as web/tests/restareas.test.js).
final class RestAreaTests: XCTestCase {
    let mile = Geodesy.metersPerMile
    let start = Date(timeIntervalSince1970: 1_793_000_000)

    var datasets: TripDatasets {
        TripDatasets(states: Fixtures.states, timeZones: TimeZoneResolver(zones: Fixtures.timeZones),
                     interstates: Fixtures.interstates, restAreas: Fixtures.restAreas)
    }

    func named(_ list: [RouteRestArea], _ text: String) -> [RouteRestArea] { list.filter { $0.name.contains(text) } }

    func testDatasetProvenance() {
        let d = Fixtures.restAreas
        XCTAssertEqual(d.metadata.license, "ODbL-1.0")
        XCTAssertTrue(d.metadata.attribution.contains("OpenStreetMap"))
        XCTAssertGreaterThan(d.items.count, 1000)
        XCTAssertEqual(Set(d.items.map(\.id)).count, d.items.count)
        for item in d.items { for key in (item.amenities ?? [:]).keys { XCTAssertNotNil(RestAreaAmenity(rawValue: key), key) } }
    }

    func testMiamiToManhattanDriverSide() {
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)
        let ras = plan.restAreas
        XCTAssertGreaterThanOrEqual(ras.count, 15)
        XCTAssertEqual(ras.map(\.distanceAlongRoute), ras.map(\.distanceAlongRoute).sorted())
        let ga = named(ras, "Georgia Visitor Information Center")
        XCTAssertEqual(ga.count, 1)
        XCTAssertEqual(ga.first?.kind, .welcome)
        XCTAssertEqual(ga.first?.side, .yours)
        XCTAssertEqual(named(ras, "Chesapeake House").first?.side, .both)
        XCTAssertEqual(named(ras, "Joyce Kilmer").count, 1)
        XCTAssertEqual(named(ras, "Thomas Edison").count, 0)

        let snap = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: 370 * mile, offset: 0, isEstimated: false, timestamp: start, speed: 30),
                                 ledger: TripLedger(), pace: PaceModel(), now: start)
        XCTAssertTrue(snap.nextRestArea?.restArea.name.contains("Georgia Visitor Information Center") ?? false)
        XCTAssertTrue(snap.upcomingRestAreas.allSatisfy { $0.distance > 0 && $0.distance <= 100 * mile })
    }

    func testOppositeDirectionAndNonInterstateRoads() {
        let points = Fixtures.route("richmond_to_nyc_via_pa").polyline.points
        let north = RestAreaMatcher().match(route: RoutePolyline(points: points), dataset: Fixtures.restAreas)
        let south = RestAreaMatcher().match(route: RoutePolyline(points: points.reversed()), dataset: Fixtures.restAreas)
        XCTAssertEqual(named(north, "Joyce Kilmer").count, 1)
        XCTAssertEqual(named(south, "Joyce Kilmer").count, 0)
        XCTAssertEqual(named(south, "Thomas Edison").count, 1)
        XCTAssertEqual(named(north, "Chesapeake House").count, 1)
        XCTAssertEqual(named(south, "Chesapeake House").count, 1)
        let usRoute = RestAreaMatcher().match(route: RoutePolyline(points: points), dataset: Fixtures.restAreas) { _ in
            [HighwayRef(kind: .usRoute, prefix: "US", number: "1")]
        }
        XCTAssertTrue(usRoute.isEmpty)
    }

    /// Southbound on the New Jersey Turnpike and I-95 to Maryland, every service plaza lists its fuel
    /// (tools/data-pipeline/plazas_supplement.json), as in web/tests/restareas.test.js.
    func testSouthboundTollRoadPlazasListFuel() {
        let points = Fixtures.route("miami_to_manhattan").polyline.points
        let south = RestAreaMatcher().match(route: RoutePolyline(points: points.reversed()), dataset: Fixtures.restAreas)
        let plazas = south.filter { !$0.gas.isEmpty && $0.distanceAlongRoute < 170 * mile }
        XCTAssertEqual(plazas.map(\.name), ["Alexander Hamilton Service Area", "Thomas Edison Service Area", "Molly Pitcher Service Area",
                                            "Richard Stockton Travel Plaza", "Walt Whitman Service Area", "Clara Barton Service Area",
                                            "I-95 Delaware Service Plaza", "Chesapeake House", "Maryland House Service Area"])
        for r in plazas { XCTAssertEqual(r.kind, .plaza, r.name); XCTAssertTrue(r.gas.contains("Sunoco"), r.name) }
        for (a, b) in zip(plazas, plazas.dropFirst()) { XCTAssertLessThan(b.distanceAlongRoute - a.distanceAlongRoute, 30 * mile, b.name) }
        for name in ["Joyce Kilmer", "Grover Cleveland", "Woodrow Wilson", "John Fenwick"] { XCTAssertEqual(named(south, name).count, 0, name) }
    }

    func testGasGaps() {
        let stops = [10.0, 20, 75, 80].map { GasGaps.Stop(distance: $0 * mile) }
        let gaps = GasGaps.find(stops: stops, from: 0, to: 150 * mile, minimum: 40 * mile, routeLength: 500 * mile)
        XCTAssertEqual(gaps.map { [$0.from / mile, $0.to / mile] }, [[20, 75], [80, 150]])
        XCTAssertEqual(gaps.map(\.open), [false, true])
        XCTAssertEqual(GasGaps.find(stops: stops, from: 0, to: 150 * mile, minimum: 40 * mile, routeLength: 150 * mile).last?.open, false)
        XCTAssertTrue(GasGaps.find(stops: stops, from: 70 * mile, to: 100 * mile, minimum: 40 * mile).isEmpty)
    }

    func testRestStopsRankOnTheHighway() {
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)
        let snap = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: 358 * mile, offset: 0, isEstimated: false, timestamp: start, speed: 30),
                                 ledger: TripLedger(), pace: PaceModel(), now: start)
        let query = StopQuery(requirements: [ServiceRequirement(category: .restArea)], window: .timeAhead(3 * 3600, tolerance: 1800),
                              includeRestAreas: true)
        let results = StopPlanner(dataset: Fixtures.interstates).suggestions(query, plan: plan, snapshot: snap, pace: PaceModel(), now: start)
        XCTAssertFalse(results.isEmpty)
        XCTAssertEqual(results.map(\.score), results.map(\.score).sorted())
        let rest = results.filter { $0.restArea != nil }
        XCTAssertFalse(rest.isEmpty)
        XCTAssertTrue(rest.allSatisfy { $0.detourMeters == 0 && $0.reasons.contains { $0.hasPrefix("On the highway") } })
    }

    func testVoiceForRestAreasAndTimeZones() {
        let route = Fixtures.route("atlanta_to_nashville")
        let plan = TripPlan(route: route, datasets: datasets)
        var session = TripSession(plan: plan, states: Fixtures.states, startedAt: start)
        var voice = VoiceAnnouncements()
        let settings = VoiceAnnouncements.Settings(enabled: true, stateLines: true, exits: false)
        var spoken: [String] = []
        for (sample, _) in GPSSimulator(route: route).traceWithTruth(from: 0, to: route.polyline.length - 100, startTime: start) {
            let s = session.ingest(sample)
            if let text = voice.message(for: s, settings: settings, zoneID: plan.timeZoneID(at: s.progress)) { spoken.append(text) }
        }
        let zone = spoken.filter { $0.hasPrefix("Now on Central") }
        XCTAssertEqual(zone.count, 1, spoken.joined(separator: " | "))
        XCTAssertTrue(zone.first?.hasSuffix("Clocks go back one hour.") ?? false, zone.joined())
        let rest = spoken.filter { ["Rest Area in", "Welcome Center in", "Service Plaza in", "Parking Area in"].contains(where: $0.hasPrefix) }
        XCTAssertEqual(rest.count, plan.restAreas.count, spoken.joined(separator: " | "))

        // The last gas before a long stretch, once, within about 6 miles.
        let exit = plan.exits.first { $0.distanceAlongRoute > 30 * mile }!
        let gap = GasGaps.Gap(from: exit.distanceAlongRoute, to: exit.distanceAlongRoute + 62 * mile,
                              before: GasGaps.Stop(distance: exit.distanceAlongRoute, exit: exit), after: nil, open: false)
        var v2 = VoiceAnnouncements()
        var said: [String] = []
        for back in [10.0, 5, 4] {
            let s = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: exit.distanceAlongRoute - back * mile, offset: 0,
                                                    isEstimated: false, timestamp: start, speed: 30), ledger: TripLedger(), pace: PaceModel(), now: start)
            if let text = v2.message(for: s, settings: VoiceAnnouncements.Settings(enabled: true, stateLines: false, exits: false, restAreas: false),
                                     gasGap: gap) { said.append(text) }
        }
        XCTAssertEqual(said, ["Last gas for 62 miles is \(exit.displayTitle), in 5 miles."])

        // Overnight: the last stop listed open before a long stretch, once per stop, and not again for the
        // exit whose last gas was just announced. Same cases as web/tests/announcer.test.js.
        func lastOpen(_ ahead: Double, id: String = "shell", exitID: String = "x9") -> SmartStop.LastOpen {
            let c = SmartStop.Candidate(id: id, name: "Shell", exitID: exitID, exitLabel: "94", along: 0, ahead: ahead * mile,
                                        arrival: start, timeZone: TimeZone(identifier: "America/New_York")!, osmHours: "24/7")
            return SmartStop.LastOpen(stop: c, evaluation: SmartStop.evaluate(c, preferences: SmartStop.Preferences()),
                                      length: 74 * mile, unlisted: 3, openEnded: false)
        }
        let at = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: 100 * mile, offset: 0, isEstimated: false,
                                                 timestamp: start, speed: 30), ledger: TripLedger(), pace: PaceModel(), now: start)
        let quiet = VoiceAnnouncements.Settings(enabled: true, stateLines: false, exits: false, restAreas: false, timeZones: false)
        var v3 = VoiceAnnouncements()
        var heard: [String] = []
        for ahead in [9.0, 5, 4] {
            if let text = v3.message(for: at, settings: quiet, lastOpen: lastOpen(ahead)) { heard.append(text) }
        }
        XCTAssertEqual(heard, ["Overnight, Shell at Exit 94 in 5 miles is the last stop listed open for 74 miles."])
        var off = quiet
        off.gasGaps = false
        XCTAssertNil(v3.message(for: at, settings: off, lastOpen: lastOpen(4, id: "other")))
        XCTAssertNil(v3.message(for: at, settings: quiet, gasGap: gap, lastOpen: lastOpen(4, id: "third", exitID: exit.id)))
        // Google Maps hours are never spoken (Google's terms forbid text to speech of its content).
        let google = SmartStop.Candidate(id: "google", name: "Shell", exitID: "x8", exitLabel: "93", along: 0, ahead: 4 * mile, arrival: start,
                                         timeZone: TimeZone(identifier: "America/New_York")!,
                                         livePeriods: [GooglePeriod(open: .init(day: 0, hour: 0, minute: 0), close: nil)])
        let ev = SmartStop.evaluate(google, preferences: SmartStop.Preferences())
        XCTAssertTrue(ev.hoursFromGoogle)
        XCTAssertNil(v3.message(for: at, settings: quiet, lastOpen: SmartStop.LastOpen(stop: google, evaluation: ev, length: 74 * mile, unlisted: 3, openEnded: false)))
    }
}
