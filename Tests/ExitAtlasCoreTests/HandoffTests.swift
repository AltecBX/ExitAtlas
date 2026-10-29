import XCTest
@testable import ExitAtlasCore

/// Waze deep links on the shared cases (the same expectations as web/tests/handoff.test.js).
final class HandoffTests: XCTestCase {
    func testWazeDrivesToTheCoordinateWithTheAppNamed() throws {
        let f = try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("handoff/waze.json")))
        for c in f["cases"]!.array! {
            let url = NavigationHandoff.waze(to: GeoCoordinate(latitude: c["lat"]!.number!, longitude: c["lon"]!.number!),
                                             source: c["source"]!.string!)
            XCTAssertEqual(url?.absoluteString, c["url"]?.string, "\(c["lat"]!.number!),\(c["lon"]!.number!)")
        }
    }
}
