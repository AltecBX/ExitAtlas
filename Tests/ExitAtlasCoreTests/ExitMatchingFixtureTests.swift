import XCTest
@testable import ExitAtlasCore

/// Checks geometric exit matching against ground truth from OSM node membership:
/// an exit is on the route exactly when the route passes through the exit's OSM node.
/// The matcher never sees node ids, so this is an independent check of direction handling.
final class ExitMatchingFixtureTests: XCTestCase {
    func encounters(_ route: PlannedRoute) -> [ExitMatcher.Encounter] {
        ExitMatcher(source: route.source).encounters(on: route.polyline, dataset: Fixtures.interstates)
    }

    func check(_ name: String, file: StaticString = #filePath, line: UInt = #line) {
        let route = Fixtures.route(name)
        let truth = Fixtures.load(name).expected.exits_on_route
        let found = encounters(route)
        var seen = Set<Int64>()
        let matchedNodes = found.map(\.record.osmNodeID).filter { seen.insert($0).inserted }
        let truthSet = Set(truth), foundSet = Set(matchedNodes)
        let missing = truthSet.subtracting(foundSet), extra = foundSet.subtracting(truthSet)
        // A miss is excused only when the node itself moved between the two OSM snapshots
        // (the fixture route's copy of the node versus the dataset's copy).
        let fixture = Fixtures.load(name).fixture
        for node in missing.sorted() {
            let index = fixture.osm_nodes.firstIndex(of: node)!
            let routeCopy = GeoCoordinate(latitude: fixture.coordinates[index][0], longitude: fixture.coordinates[index][1])
            let datasetCopy = Fixtures.interstates.exits.first { $0.osmNodeID == node }!.coordinate
            let moved = Geodesy.distance(routeCopy, datasetCopy)
            XCTAssertGreaterThan(moved, 5, "missed exit node \(node); same position in both snapshots", file: file, line: line)
        }
        // The OSRM demo server and the OpenInterstate release use different OSM snapshots, so a few
        // exit nodes lie exactly on the route geometry but are not in the route's node list (re-split
        // ways, new nodes). Those are real encounters. Anything else is a false positive.
        for e in found where extra.contains(e.record.osmNodeID) {
            XCTAssertLessThan(e.offset, 1.0, "exit \(e.record.osmNodeID) \(e.record.label) matched \(e.offset) m off the route", file: file, line: line)
        }
        // Order must match the order the route passes the nodes.
        XCTAssertEqual(matchedNodes.filter(truthSet.contains), truth.filter(foundSet.contains), "order", file: file, line: line)
    }

    func testMiamiToManhattan() { check("miami_to_manhattan") }
    func testAtlantaToNashville() { check("atlanta_to_nashville") }
    func testRichmondToNYCTurnpike() { check("richmond_to_nyc_turnpike") }
    func testRichmondToNYCViaPennsylvania() { check("richmond_to_nyc_via_pa") }

    /// Driving the same pavement in reverse must not pick up exits for the other direction.
    func testReversedRouteRejectsOppositeDirectionExits() {
        let route = Fixtures.route("miami_to_manhattan")
        let forward = Set(Fixtures.load("miami_to_manhattan").expected.exits_on_route)
        let reversed = RoutePolyline(points: route.polyline.points.reversed())
        let found = ExitMatcher(options: .thirdPartyGeometry).encounters(on: reversed, dataset: Fixtures.interstates)
        let wrong = found.filter { forward.contains($0.record.osmNodeID) && $0.confidence == .high }
        XCTAssertTrue(wrong.isEmpty, "\(wrong.count) forward exits matched on the reversed route")
    }

    func testMergedExitsAreOrderedAndLabelsNormalized() {
        let route = Fixtures.route("miami_to_manhattan")
        let exits = ExitMatcher(source: route.source).match(route: route.polyline, dataset: Fixtures.interstates)
        XCTAssertGreaterThan(exits.count, 250)
        for (a, b) in zip(exits, exits.dropFirst()) {
            XCTAssertLessThanOrEqual(a.distanceAlongRoute, b.distanceAlongRoute)
            XCTAssertEqual(b.ordinal, a.ordinal + 1)
        }
        // No Cyrillic or Greek look-alike letters survive normalization.
        for e in exits {
            XCTAssertTrue(e.label.unicodeScalars.allSatisfy { $0.isASCII }, "non ASCII label \(e.label)")
        }
    }
}
