import XCTest
@testable import ExitAtlasCore

/// The adaptive Drive screen (acceptance test Q): the same fixtures as web/tests/dashboard.test.js.
final class DashboardFocusTests: XCTestCase {
    /// Fixture signals (miles) as engine signals (meters).
    private func signals(_ x: JSONValue) -> DashboardFocus.Signals {
        let mile = Geodesy.metersPerMile
        let m = { (v: JSONValue?) in v?.number.map { $0 * mile } }
        let fuel = x["fuel"].map { f in
            DashboardFocus.Signals.Fuel(range: m(f["range"])!, reserve: m(f["reserve"])!, stopAhead: m(f["stopAhead"]), low: f["low"]?.bool ?? false)
        }
        let gap = x["gap"].map { (startsIn: m($0["startsIn"])!, length: m($0["length"])!) }
        return DashboardFocus.Signals(nextExit: m(x["nextExit"]), restArea: m(x["restArea"]), gap: gap,
                                      plannedStop: m(x["plannedStop"]), fuel: fuel, overnight: x["overnight"]?.bool ?? false,
                                      lastOpen: m(x["lastOpen"]),
                                      alert: x["alert"].map { (distance: m($0["distance"])!, serious: $0["serious"]!.bool!) },
                                      alertID: x["alert"]?["id"]?.string, border: m(x["border"]))
    }

    func testOneFocusCardAndAtMostTwoStripItems() throws {
        let file = Fixtures.fixtureDirectory.appendingPathComponent("dashboard/focus.json")
        for c in try JSONValue(data: Data(contentsOf: file))["cases"]!.array! {
            let name = c["name"]!.string!
            let r = DashboardFocus.choose(signals(c["signals"]!))
            XCTAssertEqual(r.focus.rawValue, c["expect"]!["focus"]!.string!, "\(name): focus")
            XCTAssertEqual(r.strip.map(\.rawValue), c["expect"]!["strip"]!.array!.compactMap(\.string), "\(name): strip")
            XCTAssertTrue(r.strip.count <= 2 && !r.strip.contains(r.focus), "\(name): no clutter, no repeats")
        }
    }

    func testTheCardHoldsSteadyBetweenReadings() throws {
        let file = Fixtures.fixtureDirectory.appendingPathComponent("dashboard/stability.json")
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        for c in try JSONValue(data: Data(contentsOf: file))["cases"]!.array! {
            let name = c["name"]!.string!
            let stabilizer = DashboardFocus.Stabilizer()
            for (i, step) in c["steps"]!.array!.enumerated() {
                let r = stabilizer.choose(signals(step["signals"]!), at: start.addingTimeInterval(step["t"]!.number!))
                XCTAssertEqual(r.focus.rawValue, step["expect"]!.string!, "\(name), step \(i + 1): focus")
                XCTAssertEqual(r.held, step["held"]!.bool!, "\(name), step \(i + 1): held")
                XCTAssertFalse(r.strip.contains(r.focus), "\(name), step \(i + 1): the strip never repeats the card")
            }
        }
    }
}
