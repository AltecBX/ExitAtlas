import XCTest
@testable import ExitAtlasCore

/// Compares the engine's state segmentation on real routes against an independent oracle:
/// shapely + pyproj on the full resolution TIGER/Line polygons (tools/data-pipeline/make_route_fixture.py).
/// The engine uses the simplified bundled boundaries and its own geodesy, so agreement checks both.
final class StateSegmentationFixtureTests: XCTestCase {
    /// 0.05 miles. Boundary simplification moves crossings by a few meters at most.
    let tolerance = 0.05 * Geodesy.metersPerMile

    func check(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let route = Fixtures.route(name)
        let expected = Fixtures.load(name).expected
        let profile = RegionSegmenter().segment(route.polyline, regions: Fixtures.states)

        XCTAssertEqual(profile.segments.map(\.code), expected.states.map(\.code), "state order", file: file, line: line)
        XCTAssertEqual(route.polyline.length, expected.geodesic_length_m, accuracy: 1.0, "route length", file: file, line: line)
        for (got, want) in zip(profile.segments, expected.states) {
            XCTAssertEqual(got.length, want.length_m, accuracy: tolerance, "\(got.code ?? "-") length", file: file, line: line)
            XCTAssertEqual(got.startDistance, want.start_m, accuracy: tolerance, "\(got.code ?? "-") start", file: file, line: line)
        }
        let sum = profile.segments.reduce(0) { $0 + $1.length }
        XCTAssertEqual(sum, route.polyline.length, accuracy: 0.01, "segments cover the route exactly", file: file, line: line)
        for (a, b) in zip(profile.segments, profile.segments.dropFirst()) {
            XCTAssertEqual(a.endDistance, b.startDistance, accuracy: 1e-6, "segments are contiguous", file: file, line: line)
        }
    }

    func testMiamiToManhattan() { check("miami_to_manhattan") }
    func testAtlantaToNashvilleReentersGeorgia() {
        check("atlanta_to_nashville")
        let profile = RegionSegmenter().segment(Fixtures.route("atlanta_to_nashville").polyline, regions: Fixtures.states)
        let georgia = profile.segments.filter { $0.code == "GA" }
        XCTAssertEqual(georgia.map(\.visit), [1, 2])
        let totals = profile.totals
        XCTAssertEqual(totals.map(\.code), ["GA", "TN"])
        XCTAssertEqual(totals.first?.visits, 2)
    }
    func testRichmondToNYCTurnpike() { check("richmond_to_nyc_turnpike") }
    func testRichmondToNYCViaPennsylvania() { check("richmond_to_nyc_via_pa") }
    func testYonkersToOrlando() { check("yonkers_to_orlando") }
    func testYonkersToMorristown() { check("yonkers_to_morristown") }

    /// External reference: the Miami route follows I-95 for the full width of Georgia, South Carolina
    /// and North Carolina. Published I-95 lengths (Wikipedia "Interstate 95" route table, checked
    /// 2026-10-27): GA 111.80 mi, SC 198.76 mi, NC 181.36 mi.
    func testMatchesPublishedI95StateLengths() {
        for name in ["miami_to_manhattan", "yonkers_to_orlando"] {
            let profile = RegionSegmenter().segment(Fixtures.route(name).polyline, regions: Fixtures.states)
            let published: [String: Double] = ["GA": 111.80, "SC": 198.76, "NC": 181.36]
            for (code, miles) in published {
                let segment = profile.segments.first { $0.code == code }!
                XCTAssertEqual(segment.length / Geodesy.metersPerMile, miles, accuracy: 0.25, "\(name) \(code)")
            }
        }
    }

    func testDistrictOfColumbiaIsItsOwnSegment() {
        let profile = RegionSegmenter().segment(Fixtures.route("miami_to_manhattan").polyline, regions: Fixtures.states)
        let dc = profile.segments.first { $0.code == "DC" }
        XCTAssertNotNil(dc)
        XCTAssertGreaterThan(dc!.length, 5 * Geodesy.metersPerMile)
    }
}
