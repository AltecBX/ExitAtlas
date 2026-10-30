import XCTest
@testable import ExitAtlasCore

/// Road Intelligence on the shared fixtures (the same expectations as web/tests/roadintel.test.js): direction
/// and road aware matching on the real I-95 route, deduplication, expiry and source status. Events are simulated.
final class RoadIntelTests: XCTestCase {
    let mile = Geodesy.metersPerMile

    func fixture() throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("roadintel/cases.json")))
    }

    func date(_ v: JSONValue?) -> Date? { v?.number.map { Date(timeIntervalSince1970: $0) } }
    func coord(_ v: JSONValue) -> GeoCoordinate { GeoCoordinate(latitude: v["lat"]!.number!, longitude: v["lon"]!.number!) }

    func incident(_ x: JSONValue) -> RoadIntel.Incident {
        let g = x["geometry"]
        var geometry: RoadIntel.Geometry?
        switch g?["type"]?.string {
        case "point": geometry = .point(coord(g!["coordinate"]!))
        case "line": geometry = .line(g!["coordinates"]!.array!.map(coord))
        case "points": geometry = .points(g!["coordinates"]!.array!.map(coord))
        case "polygon":
            geometry = .polygon(g!["rings"]!.array!.map { ring in
                ring.array!.map { GeoCoordinate(latitude: $0.array![1].number!, longitude: $0.array![0].number!) }
            })
        default: geometry = nil
        }
        return RoadIntel.Incident(
            id: x["id"]!.string!, kind: RoadIntel.Kind(rawValue: x["category"]!.string!) ?? .other, description: x["description"]?.string ?? "",
            source: RoadIntel.Source(id: x["source"]!["id"]!.string!, name: x["source"]!["name"]!.string!),
            verification: RoadIntel.Verification(rawValue: x["verification"]!.string!)!,
            reportedAt: date(x["reportedAt"]), updatedAt: date(x["updatedAt"]), startsAt: date(x["startsAt"]), endsAt: date(x["endsAt"]),
            expiresAt: date(x["expiresAt"]), geometry: geometry, road: x["road"]?.string, direction: x["direction"]?.string,
            lanes: x["lanes"]?.string, severity: RoadIntel.Severity(rawValue: x["severity"]?.string ?? "unknown") ?? .unknown)
    }

    func testMatchingSameRoadAndDirectionOnly() throws {
        let f = try fixture()
        let route = Fixtures.route(f["route"]!.string!)
        let progress = f["progressMiles"]!.number! * mile
        for (key, x) in f["matches"]!.object! {
            let placement = RoadIntel.place(incident(f["incidents"]![key]!), on: route, progress: progress)
            if let why = x["why"]?.string {
                XCTAssertEqual(placement, .rejected(why), key)
            } else {
                guard case let .ahead(start, end, _, _) = placement else { XCTFail("\(key): \(placement)"); continue }
                XCTAssertEqual((start - progress) / mile, x["aheadMiles"]!.number!, accuracy: 0.3, key)
                if let e = x["endMiles"]?.number { XCTAssertEqual((end - progress) / mile, e, accuracy: 0.3, key) }
            }
        }
    }

    func testScenariosDedupeExpiryAndStatus() throws {
        let f = try fixture()
        let route = Fixtures.route(f["route"]!.string!)
        let progress = f["progressMiles"]!.number! * mile
        let now = Date(timeIntervalSince1970: f["now"]!.number!)
        let speed = f["speedMetersPerSecond"]!.number!
        for s in f["scenarios"]!.array! {
            let name = s["name"]!.string!
            let providers = s["providers"]!.array!.map { p in
                RoadIntel.Provider(id: p["id"]!.string!, name: p["name"]!.string!,
                                   kinds: Set(p["kinds"]!.array!.compactMap { $0.string.flatMap(RoadIntel.Kind.init(rawValue:)) }),
                                   state: RoadIntel.ProviderState(rawValue: p["state"]!.string!)!, fetchedAt: date(p["fetchedAt"]),
                                   maxAge: p["maxAgeSeconds"]?.number ?? 900,
                                   incidents: p["incidents"]!.array!.map { incident(f["incidents"]![$0.string!]!) })
            }
            var enabled: [RoadIntel.Group: Bool] = [:]
            for (k, v) in s["enabled"]?.object ?? [:] { enabled[RoadIntel.Group(rawValue: k)!] = v.bool! }
            let out = RoadIntel.evaluate(route: route, progress: progress, providers: providers, now: now, enabled: enabled,
                                         etaAt: { now.addingTimeInterval(($0 - progress) / speed) })
            let expected = s["expect"]!["alerts"]!.array!
            XCTAssertEqual(out.alerts.count, expected.count, "\(name): \(out.alerts.map(\.incident.id))")
            for (i, e) in expected.enumerated() where i < out.alerts.count {
                let a = out.alerts[i], key = e.array![0].string!
                XCTAssertEqual(a.incident.id, f["incidents"]![key]!["id"]!.string!, "\(name): alert \(i)")
                XCTAssertEqual(a.ahead / mile, e.array![1].number!, accuracy: 0.3, "\(name): \(key) ahead")
                XCTAssertEqual(a.sources.map(\.id), e.array![2].array!.compactMap(\.string), "\(name): \(key) sources")
            }
            for (group, state) in s["expect"]!["status"]!.object! {
                XCTAssertEqual(out.status[RoadIntel.Group(rawValue: group)!]?.state.rawValue, state.string!, "\(name): \(group)")
            }
        }
    }

    func testNormalizingProviderText() {
        XCTAssertEqual(RoadIntel.roadRef("Interstate 95"), RoadIntel.roadRef("I-95"))
        XCTAssertEqual(RoadIntel.roadRef("I 95 N"), RoadIntel.roadRef("I-95"))
        XCTAssertNil(RoadIntel.roadRef("Main Street"))
        for (text, code) in [("Northbound", "N"), ("SB", "S"), ("east", "E"), ("Westbound", "W"), ("Both directions", "both"), ("", nil), ("unknown", nil)] {
            XCTAssertEqual(RoadIntel.directionCode(text), code, text)
        }
    }

    func testNWSAdapterOnARealCapturedResponse() throws {
        let sample = try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("roadintel/nws_sample.json")))
        let features = sample["features"]!.array!
        let a = GeoCoordinate(latitude: 61.1, longitude: -149.7), b = GeoCoordinate(latitude: 61.2, longitude: -149.6)
        let out = AlertSources.nwsIncidents([(a, features), (b, [features[1]])])
        // The Small Craft Advisory (marine) is left out.
        XCTAssertEqual(out.map(\.description), ["Severe Thunderstorm Warning", "Wind Advisory"])
        guard out.count == 2 else { return }
        if case .polygon = out[0].geometry {} else { XCTFail("storm keeps its polygon") }
        XCTAssertEqual(out[0].severity, .major)
        XCTAssertEqual(out[0].kind, .weather)
        XCTAssertEqual(out[0].endsAt, ISO8601DateFormatter().date(from: features[0]["properties"]!["ends"]!.string!))
        guard case let .points(cs) = out[1].geometry else { return XCTFail("zone alert placed at the query points") }
        XCTAssertEqual(cs, [a, b])
        XCTAssertEqual(out[1].direction, "both")
    }

    /// Same cases as web/tests/announcer.test.js: serious from 10 miles, others from 2, once each, never within
    /// 0.3 mile, and not at all when alert voice is off. Simulated test alerts.
    func testSpokenRoadAlerts() {
        let plan = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: RangePlannerTests.datasets)
        let start = Date(timeIntervalSince1970: 1_793_000_000)
        func at(_ miles: Double) -> TripSnapshot {
            plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: miles * mile, offset: 0, isEstimated: false,
                                            timestamp: start, speed: 30), ledger: TripLedger(), pace: PaceModel(), now: start)
        }
        func alert(_ id: String, _ kind: RoadIntel.Kind, _ startMiles: Double, _ serious: Bool, lanes: String? = nil,
                   community: Bool = false) -> RoadIntel.Alert {
            let i = RoadIntel.Incident(id: id, kind: kind, description: "Severe Thunderstorm Warning", source: .init(id: "t", name: "t"),
                                       verification: community ? .community : .official, geometry: nil, lanes: lanes)
            return RoadIntel.Alert(incident: i, start: startMiles * mile, end: startMiles * mile, ahead: 0, directionKnown: true,
                                   approximate: false, serious: serious, sources: [])
        }
        let on = VoiceAnnouncements.Settings(enabled: true, stateLines: false, exits: false, restAreas: false, gasGaps: false, timeZones: false)
        var v = VoiceAnnouncements()
        var said: [String] = []
        let crash = alert("c1", .crash, 109, true, lanes: "Right lane blocked")
        for m in [97.0, 99.1, 99.5] { if let t = v.message(for: at(m), settings: on, alerts: [crash]) { said.append(t) } }
        XCTAssertEqual(said, ["Crash ahead, in 10 miles. Right lane blocked."])
        let police = alert("p1", .police, 102, false, community: true)
        for m in [99.5, 100.2] { if let t = v.message(for: at(m), settings: on, alerts: [police]) { said.append(t) } }
        XCTAssertEqual(said.last, "Police reported ahead, in 2 miles. Reported by drivers, not confirmed.")
        XCTAssertNil(v.message(for: at(101.8), settings: on, alerts: [alert("p2", .police, 102, false)]))
        var off = on
        off.alerts = false
        XCTAssertNil(v.message(for: at(100), settings: off, alerts: [alert("w1", .weather, 101, true)]))
        XCTAssertEqual(v.message(for: at(100), settings: on, alerts: [alert("w1", .weather, 101, true)]),
                       "Severe Thunderstorm Warning on your route, in 1 mile.")
    }

    func testFreshnessAndSeriousness() throws {
        let f = try fixture()
        let now = Date(timeIntervalSince1970: f["now"]!.number!)
        func make(_ reported: Double?, _ updated: Double?) -> RoadIntel.Incident {
            RoadIntel.Incident(id: "t", kind: .police, description: "", source: .init(id: "t", name: "t"), verification: .community,
                               reportedAt: reported.map { now.addingTimeInterval(-$0) }, updatedAt: updated.map { now.addingTimeInterval(-$0) }, geometry: nil)
        }
        XCTAssertEqual(RoadIntel.freshnessText(make(360, 360), now: now), "Reported 6 minutes ago")
        XCTAssertEqual(RoadIntel.freshnessText(make(7200, 120), now: now), "Updated 2 minutes ago")
        XCTAssertEqual(RoadIntel.freshnessText(make(nil, nil), now: now), "Time not reported")
        XCTAssertTrue(incident(f["incidents"]!["crashA"]!).isSerious)
        XCTAssertFalse(incident(f["incidents"]!["workZone"]!).isSerious)
    }

    func testWZDxRealFeedsConvertedAndMatchedByRoadAndDirection() throws {
        let dir = Fixtures.fixtureDirectory.appendingPathComponent("roadintel")
        let x = try JSONValue(data: Data(contentsOf: dir.appendingPathComponent("wzdx_expect.json")))
        let route = Fixtures.route(x["route"]!.string!)
        let from = x["progressMiles"]!.number! * mile
        let matches = x["matches"]!.object!
        var all: [String: RoadIntel.Incident] = [:]
        for (state, want) in x["states"]!.object! {
            let list = try AlertSources.wzdxIncidents(Data(contentsOf: dir.appendingPathComponent("wzdx_\(state.lowercased()).json")), state: state)
            XCTAssertEqual(list.count, Int(want["count"]!.number!), state)
            var tally: [String: Double] = [:]
            for i in list { tally["\(i.kind.rawValue)/\(i.severity.rawValue)", default: 0] += 1 }
            XCTAssertEqual(tally, want["tally"]!.object!.mapValues { $0.number! }, state)
            var rejected: [String: Double] = [:]
            for i in list {
                all[i.id] = i
                XCTAssertEqual(i.verification, .official)
                XCTAssertEqual(i.source.id, "wzdx-\(state)")
                switch RoadIntel.place(i, on: route, progress: from) {
                case .rejected(let why): rejected[why, default: 0] += 1
                case .ahead(let start, _, _, _): XCTAssertNotNil(matches[i.id], "\(i.id) matched at \((start - from) / mile)")
                }
            }
            XCTAssertEqual(rejected, x["rejected"]![state]!.object!.mapValues { $0.number! }, state)
        }
        for (id, want) in x["incidents"]!.object! {
            let i = try XCTUnwrap(all[id], id)
            XCTAssertEqual(i.road, want["road"]?.string, "\(id) road")
            XCTAssertEqual(i.direction, want["direction"]?.string, "\(id) direction")
            XCTAssertEqual(i.kind.rawValue, want["category"]?.string, "\(id) category")
            XCTAssertEqual(i.severity.rawValue, want["severity"]?.string, "\(id) severity")
            XCTAssertEqual(i.lanes, want["lanes"]?.string, "\(id) lanes")
            for (key, value) in [("startsAt", i.startsAt), ("endsAt", i.endsAt), ("updatedAt", i.updatedAt)] {
                if let w = want[key]?.number { XCTAssertEqual(value?.timeIntervalSince1970, w, "\(id) \(key)") }
            }
            let kind: String
            switch i.geometry {
            case .point: kind = "point"
            case .line: kind = "line"
            default: kind = "other"
            }
            XCTAssertEqual(kind, want["geometry"]?.string, "\(id) geometry")
        }
        for (id, ahead) in matches {
            guard case let .ahead(start, _, _, _) = RoadIntel.place(all[id]!, on: route, progress: from) else { return XCTFail(id) }
            XCTAssertEqual((start - from) / mile, ahead.number!, accuracy: 0.15, id)
        }
        for (id, why) in x["rejectedByID"]!.object! {
            guard case let .rejected(got) = RoadIntel.place(all[id]!, on: route, progress: from) else { return XCTFail(id) }
            XCTAssertEqual(got, why.string, id)
        }
        // Local time to UTC across the end of daylight saving time (November 1, 2026 in New York).
        XCTAssertEqual(AlertSources.zonedDate(year: 2026, month: 9, day: 31, hour: 20, minute: 0, zone: "America/New_York")?.timeIntervalSince1970, 1_793_491_200)
        XCTAssertEqual(AlertSources.zonedDate(year: 2026, month: 10, day: 2, hour: 20, minute: 0, zone: "America/New_York")?.timeIntervalSince1970, 1_793_667_600)
    }

    func testStreetBesideTheHighwayIsNeverTheHighway() throws {
        let f = try fixture()
        let route = Fixtures.route(f["route"]!.string!)
        let progress = f["progressMiles"]!.number! * mile
        let point = RoadIntel.Geometry.point(route.polyline.coordinate(at: progress + 5 * mile))
        func place(_ road: String?) -> RoadIntel.Placement {
            RoadIntel.place(RoadIntel.Incident(id: "t", kind: .construction, description: "", source: .init(id: "t", name: "t"),
                                               verification: .official, geometry: point, road: road, direction: "N", severity: .moderate),
                            on: route, progress: progress)
        }
        guard case .ahead = place("I 95 / Some Memorial Hwy") else { return XCTFail("I-95 by any name") }
        guard case .rejected("other road") = place("Showalter Rd") else { return XCTFail("street") }
        guard case .rejected("other road") = place("MD 3BU") else { return XCTFail("business route") }
        guard case .ahead = place(nil) else { return XCTFail("no name") }
    }

    /// Same case as web/tests/roadalerts.test.js: a zone alert NWS returned where the driver was stays "here"
    /// as the driver moves on, until half the sample spacing past the point; a later sample point is not "ahead".
    func testZoneAlertWhereTheDriverIsStaysHere() throws {
        let route = Fixtures.route("richmond_to_nyc_via_pa")
        let at = 40 * mile
        func place(_ points: [Double], progress: Double) -> RoadIntel.Placement {
            RoadIntel.place(RoadIntel.Incident(id: "fog", kind: .weather, description: "Dense Fog Advisory", source: .init(id: "nws", name: "NWS"),
                                               verification: .official, geometry: .points(points.map { route.polyline.coordinate(at: $0) }),
                                               road: nil, direction: "both", severity: .minor),
                            on: route, progress: progress)
        }
        for moved in [0.5, 5.0] {
            guard case let .ahead(start, _, _, approximate) = place([at], progress: at + moved * mile) else { return XCTFail("\(moved) mi on: gone") }
            XCTAssertEqual(start, at + moved * mile, accuracy: 1, "\(moved) mi on: here")
            XCTAssertTrue(approximate)
        }
        guard case let .ahead(start, _, _, _) = place([at, at + 25 * mile], progress: at + 3 * mile) else { return XCTFail("wide alert") }
        XCTAssertEqual(start, at + 3 * mile, accuracy: 1, "here, not 22 miles ahead")
        guard case .rejected("behind") = place([at], progress: at + 20 * mile) else { return XCTFail("far past the point") }
    }

    func testAlertTiersAndHeadlines() throws {
        let file = Fixtures.fixtureDirectory.appendingPathComponent("roadintel/tiers.json")
        for c in try JSONValue(data: Data(contentsOf: file))["cases"]!.array! {
            let kind = RoadIntel.Kind(rawValue: c["category"]!.string!)!
            let severity = RoadIntel.Severity(rawValue: c["severity"]!.string!)!
            let i = RoadIntel.Incident(id: "t", kind: kind, description: "", source: .init(id: "t", name: "t"), verification: .official,
                                       reportedAt: nil, updatedAt: nil, geometry: nil, severity: severity)
            XCTAssertEqual(i.tier.rawValue, c["tier"]!.string!, "\(kind) \(severity): tier")
            XCTAssertEqual(i.headline, c["headline"]!.string!, "\(kind) \(severity): headline")
        }
    }
}
