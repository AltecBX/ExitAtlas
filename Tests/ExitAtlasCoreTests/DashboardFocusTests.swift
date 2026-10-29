import XCTest
@testable import ExitAtlasCore

/// The adaptive Drive screen (acceptance test Q): the same fixtures as web/tests/dashboard.test.js.
final class DashboardFocusTests: XCTestCase {
    func testOneFocusCardAndAtMostTwoStripItems() throws {
        let file = Fixtures.fixtureDirectory.appendingPathComponent("dashboard/focus.json")
        let mile = Geodesy.metersPerMile
        for c in try JSONValue(data: Data(contentsOf: file))["cases"]!.array! {
            let name = c["name"]!.string!
            let x = c["signals"]!
            let m = { (v: JSONValue?) in v?.number.map { $0 * mile } }
            let fuel = x["fuel"].map { f in
                DashboardFocus.Signals.Fuel(range: m(f["range"])!, reserve: m(f["reserve"])!, stopAhead: m(f["stopAhead"]), low: f["low"]?.bool ?? false)
            }
            let gap = x["gap"].map { (startsIn: m($0["startsIn"])!, length: m($0["length"])!) }
            let s = DashboardFocus.Signals(nextExit: m(x["nextExit"]), restArea: m(x["restArea"]), gap: gap,
                                           plannedStop: m(x["plannedStop"]), fuel: fuel, overnight: x["overnight"]?.bool ?? false,
                                           lastOpen: m(x["lastOpen"]),
                                           alert: x["alert"].map { (distance: m($0["distance"])!, serious: $0["serious"]!.bool!) })
            let r = DashboardFocus.choose(s)
            XCTAssertEqual(r.focus.rawValue, c["expect"]!["focus"]!.string!, "\(name): focus")
            XCTAssertEqual(r.strip.map(\.rawValue), c["expect"]!["strip"]!.array!.compactMap(\.string), "\(name): strip")
            XCTAssertTrue(r.strip.count <= 2 && !r.strip.contains(r.focus), "\(name): no clutter, no repeats")
        }
    }
}
