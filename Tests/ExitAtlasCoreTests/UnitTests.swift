import XCTest
@testable import ExitAtlasCore

final class GeodesyTests: XCTestCase {
    func testVincentyKnownDistance() {
        // Flinders Peak to Buninyong, the classic Vincenty test case: 54,972.271 m.
        let a = GeoCoordinate(latitude: -(37 + 57 / 60.0 + 3.72030 / 3600), longitude: 144 + 25 / 60.0 + 29.52440 / 3600)
        let b = GeoCoordinate(latitude: -(37 + 39 / 60.0 + 10.15610 / 3600), longitude: 143 + 55 / 60.0 + 35.38390 / 3600)
        XCTAssertEqual(Geodesy.distance(a, b), 54_972.271, accuracy: 0.01)
    }

    func testBearingsAndAngleDifference() {
        let a = GeoCoordinate(latitude: 35, longitude: -80)
        XCTAssertEqual(Geodesy.initialBearing(a, GeoCoordinate(latitude: 36, longitude: -80)), 0, accuracy: 0.01)
        XCTAssertEqual(Geodesy.initialBearing(a, GeoCoordinate(latitude: 35, longitude: -79)), 90, accuracy: 0.5)
        XCTAssertEqual(Geodesy.angleDifference(350, 10), 20, accuracy: 1e-9)
        XCTAssertEqual(Geodesy.angleDifference(90, 270), 180, accuracy: 1e-9)
    }

    func testEncodedPolylineRoundTrip() {
        let decoded = EncodedPolyline.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@")!
        XCTAssertEqual(decoded.count, 3)
        XCTAssertEqual(decoded[0].latitude, 38.5, accuracy: 1e-6)
        XCTAssertEqual(decoded[2].longitude, -126.453, accuracy: 1e-6)
        XCTAssertEqual(EncodedPolyline.encode(decoded), "_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    }
}

final class PolylineTests: XCTestCase {
    let origin = GeoCoordinate(latitude: 40, longitude: -75)

    func testCumulativeDistanceAndInterpolation() {
        let pts = (0...10).map { Geodesy.offset(origin, bearing: 45, meters: Double($0) * 100) }
        let line = RoutePolyline(points: pts)
        XCTAssertEqual(line.length, 1000, accuracy: 0.5)
        let mid = line.coordinate(at: 500)
        XCTAssertEqual(Geodesy.distance(mid, pts[5]), 0, accuracy: 0.5)
        XCTAssertEqual(line.bearing(at: 500), 45, accuracy: 0.5)
    }

    func testProjectionSideAndOffset() {
        let line = RoutePolyline(points: [origin, Geodesy.offset(origin, bearing: 0, meters: 1000)])
        let right = Geodesy.offset(Geodesy.offset(origin, bearing: 0, meters: 400), bearing: 90, meters: 12)
        let p = line.nearestProjection(of: right, within: 50)!
        XCTAssertEqual(p.distanceAlong, 400, accuracy: 0.5)
        XCTAssertEqual(p.offset, 12, accuracy: 0.2)
        XCTAssertGreaterThan(p.signedOffset, 0, "east of a northbound line is the right side")
    }

    /// A loop ramp: the route circles back within 30 m of an earlier point. Both passes must be
    /// reported even though every segment of the loop is within the search radius.
    func testLoopYieldsOneProjectionPerPass() {
        var pts = (0...4).map { Geodesy.offset(origin, bearing: 0, meters: Double($0) * 50) }
        let center = Geodesy.offset(pts.last!, bearing: 90, meters: 40)
        for k in 1...24 {
            let angle = 270 - Double(k) * 15  // counterclockwise loop back past the start of the loop
            pts.append(Geodesy.offset(center, bearing: angle, meters: 40))
        }
        pts.append(Geodesy.offset(pts.last!, bearing: 180, meters: 200))
        let line = RoutePolyline(points: pts)
        let probe = Geodesy.offset(origin, bearing: 0, meters: 200)
        let passes = line.projections(of: probe, within: 120)
        XCTAssertGreaterThanOrEqual(passes.count, 2)
        XCTAssertEqual(passes.first!.distanceAlong, 200, accuracy: 1)
        XCTAssertGreaterThan(passes.last!.distanceAlong, 300)
    }

    func testSliceKeepsGeometry() {
        let pts = (0...20).map { Geodesy.offset(origin, bearing: 10, meters: Double($0) * 250) }
        let line = RoutePolyline(points: pts)
        let slice = line.slice(from: 1_100, to: 3_900)
        XCTAssertEqual(slice.length, 2_800, accuracy: 1)
    }
}

final class RegionSegmenterSyntheticTests: XCTestCase {
    /// Three square "states" A | B | C side by side, plus D above B.
    func makeIndex() -> RegionIndex {
        func square(_ code: String, _ lat0: Double, _ lon0: Double, _ size: Double) -> Data {
            var d = Data()
            func u8(_ v: UInt8) { d.append(v) }
            func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
            func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
            func i32(_ v: Int32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
            func e7(_ x: Double) -> Int32 { Int32((x * 1e7).rounded()) }
            u8(UInt8(code.utf8.count)); d.append(contentsOf: Array(code.utf8))
            u16(UInt16(code.utf8.count)); d.append(contentsOf: Array(code.utf8))
            u8(0)
            i32(e7(lat0)); i32(e7(lon0)); i32(e7(lat0 + size)); i32(e7(lon0 + size))
            u32(1); u32(1); u32(5)
            for (la, lo) in [(lat0, lon0), (lat0, lon0 + size), (lat0 + size, lon0 + size), (lat0 + size, lon0), (lat0, lon0)] {
                i32(e7(la)); i32(e7(lo))
            }
            return d
        }
        var data = Data("EAB1".utf8)
        let meta = Data("{}".utf8)
        withUnsafeBytes(of: UInt32(1).littleEndian) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: UInt32(meta.count).littleEndian) { data.append(contentsOf: $0) }
        data.append(meta)
        withUnsafeBytes(of: UInt32(4).littleEndian) { data.append(contentsOf: $0) }
        data.append(square("A", 0, 0, 1))
        data.append(square("B", 0, 1, 1))
        data.append(square("C", 0, 2, 1))
        data.append(square("D", 1, 1, 1))
        return try! RegionIndex(data: data)
    }

    func testCrossingsReentryAndBriefSegment() {
        let index = makeIndex()
        // West to east through A, B, C; then north into D clipping C's corner area, and back south into B.
        let pts = [GeoCoordinate(latitude: 0.5, longitude: 0.5), GeoCoordinate(latitude: 0.5, longitude: 2.5),
                   GeoCoordinate(latitude: 0.5, longitude: 1.5), GeoCoordinate(latitude: 1.5, longitude: 1.5),
                   GeoCoordinate(latitude: 0.5, longitude: 1.5)]
        let profile = RegionSegmenter().segment(RoutePolyline(points: pts), regions: index)
        XCTAssertEqual(profile.segments.map(\.code), ["A", "B", "C", "B", "D", "B"])
        XCTAssertEqual(profile.segments.filter { $0.code == "B" }.map(\.visit), [1, 2, 3])
        // The A to B crossing is exactly at longitude 1.
        XCTAssertEqual(profile.segments[1].entryCoordinate.longitude, 1, accuracy: 1e-9)
    }

    func testNoiseSandwichIsMerged() {
        let index = makeIndex()
        // Runs along the A/B line and pokes 20 m into B: A, tiny B, A should merge into A.
        let lonPoke = 1 + 20 / Geodesy.metersPerDegreeLongitude(at: 0.5)
        let pts = [GeoCoordinate(latitude: 0.5, longitude: 0.9), GeoCoordinate(latitude: 0.5001, longitude: lonPoke),
                   GeoCoordinate(latitude: 0.5002, longitude: 0.9)]
        let profile = RegionSegmenter().segment(RoutePolyline(points: pts), regions: index)
        XCTAssertEqual(profile.segments.map(\.code), ["A"])
        let longer = RegionSegmenter(noiseThreshold: 10).segment(RoutePolyline(points: pts), regions: index)
        XCTAssertEqual(longer.segments.map(\.code), ["A", "B", "A"])
        XCTAssertTrue(longer.segments[1].isBrief)
    }

    func testOutsideAllRegions() {
        let index = makeIndex()
        let pts = [GeoCoordinate(latitude: 0.5, longitude: 2.5), GeoCoordinate(latitude: 0.5, longitude: 3.5)]
        let profile = RegionSegmenter().segment(RoutePolyline(points: pts), regions: index)
        XCTAssertEqual(profile.segments.map(\.code), ["C", nil])
        XCTAssertEqual(profile.segments[1].displayName, "Outside U.S. states")
    }
}

final class HighwayRefTests: XCTestCase {
    func testParsing() {
        XCTAssertEqual(HighwayRef.parse("I 95; US 17").map(\.description), ["I-95", "US-17"])
        XCTAssertEqual(HighwayRef.parse("Merge onto I-95 N toward New York").map(\.description), ["I-95"])
        XCTAssertEqual(HighwayRef.parse("I-35E").first?.number, "35E")
        XCTAssertEqual(HighwayRef.parse("NJTP").first?.description, "New Jersey Tpke")
        XCTAssertEqual(HighwayRef.parse("SR 70").first?.description, "SR-70")
        XCTAssertTrue(HighwayRef.parse("Brickell Avenue").isEmpty)
    }

    /// Named freeways by their full name, shown short, as web/tests/freeways.test.js checks the JavaScript twin.
    func testNamedFreeways() {
        func labels(_ text: String) -> [String] { HighwayRef.parse(text).map(\.description) }
        XCTAssertEqual(HighwayRef.parse("Taconic State Parkway new name straight").map(\.number), ["Taconic State Parkway"])
        XCTAssertEqual(labels("Taconic State Parkway new name straight"), ["Taconic State Pkwy"])
        XCTAssertEqual(labels("GSP Garden State Parkway merge slight left"), ["Garden State Pkwy"])
        XCTAssertEqual(labels("SO Southern State Parkway"), ["Southern State Pkwy"])
        XCTAssertEqual(HighwayRef.parse("NJTP New Jersey Turnpike").map(\.number), ["New Jersey Turnpike"])
        XCTAssertEqual(labels("NJTP"), ["New Jersey Tpke"])
        XCTAssertEqual(labels("Cross County Parkway (express lanes)"), ["Cross County Pkwy"])
        XCTAssertEqual(labels("I 495 Long Island Expressway"), ["I-495", "Long Island Expy"])
        XCTAssertEqual(labels("I 95;NJTP New Jersey Turnpike"), ["I-95", "New Jersey Tpke"])
        XCTAssertEqual(labels("I 87 New York State Thruway"), ["I-87", "New York State Thruway"])
        XCTAssertEqual(labels("CT 15 Merritt Parkway"), ["CT-15", "Merritt Pkwy"])
        XCTAssertEqual(labels("US 78;GA 410 Stone Mountain Freeway"), ["US-78", "GA-410", "Stone Mountain Freeway"])
        XCTAssertNotEqual(HighwayRef.parse("Sprain Brook Parkway"), HighwayRef.parse("Taconic State Parkway"))
    }
}
