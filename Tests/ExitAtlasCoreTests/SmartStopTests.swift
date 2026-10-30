import XCTest
@testable import ExitAtlasCore

/// SmartStop and opening hours: the same fixtures and expectations as web/tests/smartstop.test.js.
final class SmartStopTests: XCTestCase {
    static let days = ["Mo": 0, "Tu": 1, "We": 2, "Th": 3, "Fr": 4, "Sa": 5, "Su": 6]
    let mile = Geodesy.metersPerMile

    func fixture(_ name: String) throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("smartstop/\(name).json")))
    }

    func minute(_ s: String) -> Int { Int(s.prefix(2))! * 60 + Int(s.suffix(2))! }

    func date(_ s: String) -> Date { ISO8601DateFormatter().date(from: s)! }

    func periods(_ v: JSONValue?) throws -> [GooglePeriod]? {
        guard let v, v.array != nil else { return nil }
        return try JSONDecoder().decode([GooglePeriod].self, from: v.data())
    }

    func checkOpen(_ hours: OpeningHours, _ checks: [JSONValue], _ what: String) {
        for c in checks {
            let a = c.array!
            let r = hours.open(weekday: Self.days[a[0].string!]!, minute: minute(a[1].string!))
            XCTAssertEqual(r.open, a[2].bool!, "\(what) at \(a[0]) \(a[1])")
            XCTAssertEqual(r.closesIn, a[3].number.map { Int($0) }, "\(what) at \(a[0]) \(a[1])")
        }
    }

    func testOpeningHoursOnTheSharedFixtures() throws {
        let f = try fixture("opening_hours")
        for c in f["osm"]!.array! {
            let text = c["hours"]!.string!
            let h = OpeningHours(osm: text)
            XCTAssertEqual(h != nil, c["parses"]!.bool!, "parses: \(text)")
            guard let h else { continue }
            XCTAssertEqual(h.holidays, c["holidays"]?.bool ?? false, "holidays: \(text)")
            checkOpen(h, c["checks"]!.array!, text)
        }
        for c in f["google"]!.array! {
            let h = try XCTUnwrap(OpeningHours(googlePeriods: try XCTUnwrap(periods(c["periods"]))))
            checkOpen(h, c["checks"]!.array!, "periods")
        }
        for c in f["localTime"]!.array! {
            let t = OpeningHours.localTime(date(c["at"]!.string!), in: TimeZone(identifier: c["zone"]!.string!)!)
            XCTAssertEqual(t.weekday, Self.days[c["day"]!.string!]!, "\(c["at"]!) in \(c["zone"]!)")
            XCTAssertEqual(t.minute, minute(c["time"]!.string!), "\(c["at"]!) in \(c["zone"]!)")
        }
    }

    func preferences(_ f: JSONValue, _ overrides: JSONValue?) -> (SmartStop.Preferences, Double) {
        var p = ProfileRules.defaults().object!
        for src in [f["profile"], overrides] {
            for (k, v) in src?.object ?? [:] {
                var s = p[k]?.object ?? [:]
                for (kk, vv) in v.object ?? [:] { s[kk] = vv }
                p[k] = .object(s)
            }
        }
        let s = ProfileSettings(profile: .object(p))
        return (SmartStop.Preferences(s), s.reserveMiles * mile)
    }

    func candidate(_ f: JSONValue, _ c: JSONValue) throws -> SmartStop.Candidate {
        var x = f["defaults"]!.object!
        for (k, v) in c.object! { x[k] = v }
        let osm = x["osm"]?.object ?? [:]
        let live = x["live"]?.object
        let plaza = x["plaza"]?.object
        let ahead = x["aheadMiles"]?.number
        return SmartStop.Candidate(
            id: x["id"]!.string!, name: x["name"]?.string ?? x["id"]!.string!, brand: x["brand"]?.string ?? "",
            kind: SmartStop.Candidate.Kind(rawValue: x["kind"]!.string!)!, exitID: x["exitId"]?.string,
            along: (x["alongMiles"]?.number ?? ahead ?? 0) * mile, ahead: ahead.map { $0 * mile },
            arrival: date(x["arrival"]!.string!), timeZone: TimeZone(identifier: x["timeZone"]!.string!)!,
            detourMinutes: x["detourMinutes"]?.number, rangeOnArrival: x["rangeOnArrivalMiles"]?.number.map { $0 * mile },
            price: x["price"]?.number, pricePayment: x["pricePayment"]?.string, priceText: x["priceText"]?.string,
            priceSource: x["priceSource"]?.string,
            osmHours: osm["hours"]?.string, osmChecked: osm["checked"]?.string, osmToilets: osm["toilets"]?.bool, gone: osm["gone"]?.string,
            livePeriods: try periods(live?["periods"]), liveRestroom: live?["restroom"]?.bool,
            plazaHours: plaza?["hours"]?.string, plazaToilets: plaza?["toilets"]?.bool, truckSpaces: plaza?["truckSpaces"]?.number.map { Int($0) },
            brandHours: osm["brandHours"]?.string, brandToilets: osm["brandToilets"]?.bool, listedBy: osm["listedBy"]?.string,
            brandCollected: osm["collected"]?.string)
    }

    /// D, E, O: stop confidence at the arrival time, in the station's own time zone.
    func testStopConfidenceOnTheSharedFixtures() throws {
        let f = try fixture("cases")
        let (prefs, _) = preferences(f, nil)
        for c in f["evaluations"]!.array! {
            let name = c["name"]!.string!
            let cand = try candidate(f, c["candidate"]!)
            let e = SmartStop.evaluate(cand, preferences: prefs)
            let x = c["expect"]!
            if let d = x["day"]?.string {
                XCTAssertEqual(e.weekday, Self.days[d]!, name)
                XCTAssertEqual(e.minute, minute(x["time"]!.string!), name)
            }
            if let o = x["overnight"]?.bool { XCTAssertEqual(e.overnight, o, name) }
            if let h = x["hours"]?.string { XCTAssertEqual(e.hours.status.rawValue, h, name) }
            if let l = x["hoursLabel"]?.string { XCTAssertEqual(e.hours.label, l, name) }
            if let ci = x["closesIn"] { XCTAssertEqual(e.hours.closesIn, ci.number.map { Int($0) }, name) }
            if let ch = x["checked"]?.string { XCTAssertEqual(e.hours.checked, ch, name) }
            if let r = x["restroom"]?.string { XCTAssertEqual(e.restroom.rawValue, r, name) }
            if let l = x["restroomLabel"]?.string { XCTAssertEqual(e.restroom.label, l, name) }
            if let s = x["store"]?.string { XCTAssertEqual(e.facilities.first { $0.name == "Store" }?.status, s, name) }
            if let s = x["pumps"]?.string { XCTAssertEqual(e.facilities.first { $0.name == "Pumps" }?.status, s, name) }
            if let s = x["hoursSource"]?.string { XCTAssertEqual(e.hours.source, s, name) }
            if let s = x["stale"]?.bool { XCTAssertEqual(e.hours.stale, s, name) }
            if let s = x["note"]?.string { XCTAssertEqual(e.hours.note, s, name) }
            if let s = x["pumpsSource"]?.string { XCTAssertEqual(e.facilities.first { $0.name == "Pumps" }?.source, s, name) }
            if let s = x["restroomSource"]?.string { XCTAssertEqual(e.facilities.first { $0.name == "Restroom" }?.source, s, name) }
            // O: an unknown business is never shown as open, and no station restroom is shown open at arrival.
            if cand.osmHours == nil && cand.brandHours == nil && cand.livePeriods == nil && cand.plazaHours == nil {
                XCTAssertEqual(e.hours.status, .unknown, name)
            }
            if cand.kind == .station { XCTAssertNotEqual(e.restroom, .accessible, name) }
        }
    }

    /// A rebranded station shows its current brand and never ranks as its old one (Shell first), as in the web engine.
    func testRebrandedStationNames() throws {
        let f = try fixture("cases")
        for c in f["stationNames"]!.array! {
            let what = "\(c["name"]!.string!) (\(c["brand"]!.string!)) now \(c["current"]?.string ?? "the same")"
            let place = Place(datasetIndex: 0, id: "node/1", coordinate: GeoCoordinate(latitude: 0, longitude: 0),
                              name: c["name"]!.string!, brand: c["brand"]!.string!, category: .gas)
            let brand = c["current"]?.string ?? c["brand"]!.string!
            let name = SmartStop.stationName(place, brand: brand)
            XCTAssertEqual(name, c["expect"]!.string!, what)
            let cand = try candidate(f, .object(["id": .string("x"), "name": .string(name), "brand": .string(brand)]))
            XCTAssertEqual(SmartStop.brandIndex(cand, favorites: ["Shell"]), c["shell"]!.bool! ? 0 : nil, "\(what): Shell")
        }
    }

    /// Overnight: the last stop listed open before a long stretch, on the same cases as the JavaScript engine.
    func testLastOpenStopBeforeALongStretch() throws {
        let f = try fixture("cases")
        let (prefs, _) = preferences(f, nil)
        for c in f["lastOpen"]!.array! {
            let name = c["name"]!.string!
            let o = c["options"]!
            let r = SmartStop.lastOpenBeforeGap(try c["candidates"]!.array!.map { try candidate(f, $0) }, preferences: prefs,
                                                minLength: o["minLengthMiles"]!.number! * mile, windowEnd: o["windowEndMiles"]!.number! * mile,
                                                rejected: Set(o["rejected"]?.array?.compactMap(\.string) ?? []))
            guard let x = c["expect"], x != .null else { XCTAssertNil(r, name); continue }
            let got = try XCTUnwrap(r, name)
            XCTAssertEqual(got.stop.id, x["stop"]!.string!, name)
            XCTAssertEqual(Int((got.length / mile).rounded()), Int(x["lengthMiles"]!.number!), name)
            XCTAssertEqual(got.unlisted, Int(x["unlisted"]!.number!), name)
            XCTAssertEqual(got.openEnded, x["openEnded"]!.bool!, name)
            XCTAssertTrue([.verified, .reported].contains(got.evaluation.hours.status), "\(name): only a stop listed open is named")
        }
    }

    /// F, G, H, P: the same rankings as the JavaScript engine.
    func testSmartStopRankingsOnTheSharedFixtures() throws {
        let f = try fixture("cases")
        for c in f["rankings"]!.array! {
            let name = c["name"]!.string!
            let (prefs, reserve) = preferences(f, c["profile"])
            let options = c["options"]!
            let context = SmartStop.Context(rawValue: options["context"]!.string!)!
            let purpose = SmartStop.Purpose(rawValue: options["purpose"]?.string ?? "fuel")!
            let r = SmartStop.choose(try c["candidates"]!.array!.map { try candidate(f, $0) }, preferences: prefs, context: context,
                                     purpose: purpose, reserveMeters: reserve, rejected: Set(options["rejected"]?.array?.compactMap(\.string) ?? []),
                                     vehicle: options["vehicle"].map { (tankGallons: $0["tankGallons"]!.number!, mpg: $0["mpg"]!.number!) })
            let x = c["expect"]!
            XCTAssertEqual(r.primary?.candidate.id, x["primary"]?.string, "\(name): primary")
            if let alts = x["alternatives"]?.array {
                XCTAssertEqual(r.alternatives.map(\.candidate.id), alts.compactMap(\.string), "\(name): alternatives")
            }
            if let passed = x["passed"]?.object {
                XCTAssertEqual(r.passed, passed.mapValues { Int($0.number!) }, "\(name): passed")
            }
            if let relaxed = x["relaxed"]?.array { XCTAssertEqual(r.relaxed, relaxed.compactMap(\.string), "\(name): relaxed") }
            if let low = x["lowRange"]?.bool { XCTAssertEqual(r.lowRange, low, "\(name): low range") }
            if let fav = x["favorite"] {
                XCTAssertEqual(r.favorite?.id, fav["id"]?.string, "\(name): favorite")
                XCTAssertEqual(r.favorite?.reason, fav["reason"]?.string, "\(name): favorite reason")
            }
            if let notice = x["notice"] { XCTAssertEqual(r.notice, notice.string, "\(name): notice") }
            if let cheaper = x["cheaper"] {
                if cheaper.isNull { XCTAssertNil(r.cheaper, "\(name): cheaper") } else {
                    XCTAssertEqual(r.cheaper?.candidate.id, cheaper["id"]?.string, "\(name): cheaper")
                    XCTAssertEqual(r.cheaper?.savings ?? 0, cheaper["savings"]!.number!, accuracy: 0.001, "\(name): savings")
                    XCTAssertEqual(r.cheaper?.estimate, cheaper["estimate"]?.bool, "\(name): estimate")
                }
            }
            if let h = x["primaryHours"]?.string { XCTAssertEqual(r.primary?.evaluation.hours.status.rawValue, h, "\(name): hours") }
            if let rr = x["primaryRestroom"]?.string { XCTAssertEqual(r.primary?.evaluation.restroom.rawValue, rr, "\(name): restroom") }
            for reason in x["reasonsInclude"]?.array?.compactMap(\.string) ?? [] {
                XCTAssertTrue(r.primary?.reasons.contains(reason) == true, "\(name): reason \"\(reason)\" in \(r.primary?.reasons ?? [])")
            }
            // H: a stop is offered as keeping the reserve only when it does.
            if !r.lowRange, context == .fuel, let left = r.primary?.candidate.rangeOnArrival {
                XCTAssertGreaterThanOrEqual(left, reserve, "\(name): reserve kept")
            }
        }
    }

    /// P on real data: the Miami to Manhattan route with the bundled exits, rest areas and stations.json gives
    /// the picks the JavaScript engine recorded in route_expectations.json.
    func testSmartStopOnTheRealRouteMatchesTheWebEngine() throws {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: TimeZoneResolver(zones: Fixtures.timeZones),
                                    interstates: Fixtures.interstates, restAreas: Fixtures.restAreas)
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)
        let stations = try StationFacts(contentsOf: Fixtures.dataDirectory.appendingPathComponent("stations.json"))
        let now = Date(timeIntervalSince1970: 1_793_000_000)
        for c in try fixture("route_expectations")["cases"]!.array! {
            let name = c["name"]!.string!
            let s = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: c["atMiles"]!.number! * mile, offset: 0,
                                                    isEstimated: false, timestamp: now, speed: 30),
                                  ledger: TripLedger(), pace: PaceModel(), now: now)
            let ctx = SmartStop.TripContext(plan: plan, snapshot: s, dataset: Fixtures.interstates, stations: stations)
            var prefs = SmartStop.Preferences(brands: c["brands"]!.array!.compactMap(\.string), overnightMode: c["overnight"]!.string!)
            let r: SmartStop.Result
            if c["context"]!.string! == "fuel" {
                let range = c["rangeMiles"]!.number! * mile
                r = SmartStop.choose(SmartStop.fuelCandidates(ctx, rangeLeft: range), preferences: prefs, context: .fuel,
                                     reserveMeters: 50 * mile)
            } else {
                let restrooms = c["restrooms"]!.bool!
                if restrooms { prefs.requireRestroom = "always" }
                r = SmartStop.choose(SmartStop.aheadCandidates(ctx, miles: c["miles"]!.number!, rangeLeft: nil, restrooms: restrooms),
                                     preferences: prefs, context: .ahead, purpose: restrooms ? .restroom : .fuel)
            }
            let x = c["result"]!
            func check(_ pick: SmartStop.Pick?, _ e: JSONValue?, _ what: String) {
                XCTAssertEqual(pick?.candidate.id, e?["id"]?.string, "\(name): \(what)")
                XCTAssertEqual(pick?.evaluation.hours.status.rawValue, e?["hours"]?.string, "\(name): \(what) hours")
                XCTAssertEqual(pick?.evaluation.restroom.rawValue, e?["restroom"]?.string, "\(name): \(what) restroom")
            }
            check(r.primary, x["primary"], "primary")
            let alts = x["alternatives"]!.array!
            XCTAssertEqual(r.alternatives.count, alts.count, "\(name): alternatives")
            for (pick, e) in zip(r.alternatives, alts) { check(pick, e, "alternative") }
            XCTAssertEqual(r.considered, Int(x["considered"]!.number!), "\(name): considered")
            XCTAssertEqual(r.passed, x["passed"]!.object!.mapValues { Int($0.number!) }, "\(name): passed")
            XCTAssertEqual(r.lowRange, x["lowRange"]!.bool!, "\(name): low range")
            XCTAssertEqual(r.notice, x["notice"]?.string, "\(name): notice")
        }
    }

    /// Overnight on the real route: the last stop listed open before a long stretch, through each time window in
    /// route_expectations.json, as in the web engine. ScreenshotTests.testOvernightLastOpenStop launches the demo
    /// at the mile for the current New York time.
    func testLastOpenStopOnTheRealRouteThroughEachTimeWindow() throws {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: TimeZoneResolver(zones: Fixtures.timeZones),
                                    interstates: Fixtures.interstates, restAreas: Fixtures.restAreas)
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)
        let stations = try StationFacts(contentsOf: Fixtures.dataDirectory.appendingPathComponent("stations.json"))
        let x = try fixture("route_expectations")["lastOpen"]!
        let midnight = try XCTUnwrap(ISO8601DateFormatter().date(from: x["midnight"]!.string!))
        let prefs = SmartStop.Preferences(overnightMode: "on")
        func minutes(_ hm: String) -> Int { Int(hm.prefix(2))! * 60 + Int(hm.suffix(2))! }
        for w in x["windows"]!.array! {
            let from = minutes(w["from"]!.string!)
            let to = minutes(w["to"]!.string!) < from ? minutes(w["to"]!.string!) + 1440 : minutes(w["to"]!.string!)
            for m in Array(stride(from: from, to: to, by: 15)) + [to] {
                let now = midnight.addingTimeInterval(Double(m) * 60)
                let at = "mile \(Int(w["atMiles"]!.number!)) at \(m / 60 % 24):\(String(format: "%02d", m % 60))"
                let s = plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: w["atMiles"]!.number! * mile, offset: 0,
                                                        isEstimated: false, timestamp: now, speed: 30),
                                      ledger: TripLedger(), pace: PaceModel(), now: now)
                let ctx = SmartStop.TripContext(plan: plan, snapshot: s, dataset: Fixtures.interstates, stations: stations)
                let r = try XCTUnwrap(SmartStop.lastOpenBeforeGap(SmartStop.aheadCandidates(ctx, miles: 150, rangeLeft: nil), preferences: prefs,
                                                                  minLength: x["gasGapMiles"]!.number! * mile,
                                                                  windowEnd: min(s.progress + 150 * mile, plan.route.length)), "\(at): none")
                XCTAssertEqual(r.stop.id, w["stop"]!.string!, at)
                XCTAssertEqual(Int(((r.stop.ahead ?? 0) / mile).rounded()), Int(w["aheadMiles"]!.number!), at)
                XCTAssertEqual(Int((r.length / mile).rounded()), Int(w["lengthMiles"]!.number!), at)
                XCTAssertEqual(r.unlisted, Int(w["unlisted"]!.number!), at)
            }
        }
    }
}
