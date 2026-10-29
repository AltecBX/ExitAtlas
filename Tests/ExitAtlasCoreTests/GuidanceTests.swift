import XCTest
@testable import ExitAtlasCore

/// The next maneuver for the guidance banner (the same fixtures as web/tests/guidance.test.js).
final class GuidanceTests: XCTestCase {
    private let mile = Geodesy.metersPerMile

    private func fixture() throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("guidance/next_maneuver.json")))
    }

    func testNextManeuverOnMiamiToManhattan() throws {
        let f = try fixture()
        let route = Fixtures.route(f["route"]!.string!)
        let plan = TripPlan(route: route, datasets: TripDatasets(states: Fixtures.states, timeZones: nil, interstates: Fixtures.interstates))
        for c in f["cases"]!.array! {
            let at = c["atMiles"]!.number!
            let within = c["withinMiles"]?.number.map { $0 * mile } ?? .infinity
            let x = Guidance.next(on: route, progress: at * mile, within: within, destinationName: f["destination"]!.string!, exits: plan.exits)
            guard let e = c["expect"], e != .null else { XCTAssertNil(x, "mile \(at): nothing within"); continue }
            guard let x else { XCTFail("mile \(at): a maneuver"); continue }
            XCTAssertEqual(x.distance / mile, e["miles"]!.number!, accuracy: 0.06, "mile \(at): distance")
            XCTAssertEqual(x.kind.rawValue, e["kind"]!.string!, "mile \(at): kind")
            XCTAssertEqual(x.side.rawValue, e["side"]!.string!, "mile \(at): side")
            XCTAssertEqual(x.road, e["road"]?.string, "mile \(at): road")
            XCTAssertEqual(x.exitLabel, e["exitLabel"]?.string, "mile \(at): exit")
            XCTAssertEqual(x.text, e["text"]!.string!, "mile \(at): text")
        }
    }

    func testMapKitSentencesAreShownAsGiven() throws {
        let s = try fixture()["sentences"]!
        let base = Fixtures.route(try fixture()["route"]!.string!)
        let steps = s["steps"]!.array!.map { a in
            let v = a.array!
            return RouteStep(startDistance: v[0].number!, length: v[1].number!, instruction: v[2].string!, roadName: v[3].string!)
        }
        let route = PlannedRoute(source: .appleMapKit, polyline: base.polyline, steps: steps, timeProfile: base.timeProfile,
                                 origin: base.origin, destination: base.destination)
        for c in s["cases"]!.array! {
            let x = Guidance.next(on: route, progress: c["atMeters"]!.number!)
            XCTAssertEqual(x?.kind.rawValue, c["expect"]!["kind"]!.string!)
            XCTAssertEqual(x?.side.rawValue, c["expect"]!["side"]!.string!)
            XCTAssertEqual(x?.text, c["expect"]!["text"]!.string!)
        }
        XCTAssertEqual(Guidance.parse("off ramp slight right")?.type, "off ramp")
        XCTAssertNil(Guidance.parse("Take exit 51"))
    }
}
