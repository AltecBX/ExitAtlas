import XCTest
@testable import ExitAtlasCore

/// Speed limit table with fake Valhalla responses (the web version has the same cases).
final class SpeedLimitTests: XCTestCase {
    let mile = Geodesy.metersPerMile

    /// A trace_attributes response: edge 0 is 70 mph, edge 1 is 55 mph, edge 2 has no limit.
    func response(points: Int, limit: (Int) -> Int?) -> Data {
        let edges: [[String: Any]] = [["speed_limit": 70], ["speed_limit": 55], ["speed_limit": 0]]
        let matched: [[String: Any]] = (0..<points).map { k in
            switch limit(k) {
            case nil: return ["type": "unmatched", "edge_index": 4294967295]
            case 70?: return ["type": "matched", "edge_index": 0]
            case 55?: return ["type": "matched", "edge_index": 1]
            default: return ["type": "matched", "edge_index": 2]
            }
        }
        return try! JSONSerialization.data(withJSONObject: ["edges": edges, "matched_points": matched])
    }

    func testChunksMapBackToTheRouteAndFindTheNextChange() throws {
        let route = Fixtures.route("atlanta_to_nashville")
        var table = SpeedLimitTable(routeLength: route.length)
        XCTAssertEqual(table.state(at: 0), .loading)
        let chunk = try XCTUnwrap(table.missingChunk(ahead: 0))
        XCTAssertEqual(chunk.last - chunk.first + 1, 801)
        let body = try JSONSerialization.jsonObject(with: table.requestBody(for: chunk, polyline: route.polyline)) as! [String: Any]
        XCTAssertEqual(body["units"] as? String, "miles")
        XCTAssertEqual((body["shape"] as! [Any]).count, 801)
        // First 300 points (30 km) at 70, then 55, with one unmatched point.
        let result = table.apply(response: response(points: 801) { k in k == 10 ? nil : k < 300 ? 70 : 55 }, httpStatus: 200, for: chunk)
        XCTAssertEqual(result, .applied)
        XCTAssertEqual(table.limit(at: 5 * SpeedLimitTable.step), 70)
        XCTAssertNil(table.limit(at: 10 * SpeedLimitTable.step))
        XCTAssertEqual(table.state(at: 10 * SpeedLimitTable.step), .unknown)
        XCTAssertEqual(table.limit(at: 400 * SpeedLimitTable.step), 55)
        let change = try XCTUnwrap(table.nextChange(after: 29_000, within: 2 * mile))
        XCTAssertEqual(change.mph, 55)
        XCTAssertEqual(change.distance, 30_000 - 29_000, accuracy: 1e-9)
        // The next chunk is the one after; nothing is fetched twice.
        let second = try XCTUnwrap(table.missingChunk(ahead: 0))
        XCTAssertEqual(second.first, chunk.last + 1)
        _ = table.apply(response: response(points: 801) { _ in 70 }, httpStatus: 200, for: second)
        XCTAssertNil(table.missingChunk(ahead: 0), "the prefetch window is loaded")
        XCTAssertNotNil(table.missingChunk(ahead: 100_000))
    }

    func testUnmatchableShapesAreMarkedUnknownAndOtherErrorsRetry() throws {
        let route = Fixtures.route("atlanta_to_nashville")
        var table = SpeedLimitTable(routeLength: route.length)
        let chunk = try XCTUnwrap(table.missingChunk(ahead: 0))
        let failed = table.apply(response: Data(#"{"error":"busy"}"#.utf8), httpStatus: 503, for: chunk)
        XCTAssertEqual(failed, .failed("busy"))
        XCTAssertEqual(table.state(at: 0), .loading)
        XCTAssertEqual(table.missingChunk(ahead: 0), chunk, "asked again later")
        let unmatched = table.apply(response: Data(#"{"error_code":444,"error":"Map Match algorithm failed"}"#.utf8),
                                    httpStatus: 400, for: chunk)
        XCTAssertEqual(unmatched, .unmatchable)
        XCTAssertEqual(table.state(at: 0), .unknown)
        XCTAssertNil(table.limit(at: 0))
        XCTAssertNotEqual(table.missingChunk(ahead: 0), chunk, "moves on to the next chunk")
    }
}
