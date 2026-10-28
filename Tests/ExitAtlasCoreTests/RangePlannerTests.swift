import XCTest
@testable import ExitAtlasCore

/// Fuel and charging stop planner on the real Miami to Manhattan route, checked by brute force over
/// the same data. The same cases run on the web version (web/tests/fuel.test.js).
final class RangePlannerTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_793_000_000)
    let mile = Geodesy.metersPerMile
    static let datasets = TripDatasets(states: Fixtures.states, timeZones: nil, interstates: Fixtures.interstates)
    static let miami = TripPlan(route: Fixtures.route("miami_to_manhattan"), datasets: datasets)

    func snap(_ plan: TripPlan, _ miles: Double) -> TripSnapshot {
        plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: miles * mile, offset: 0, isEstimated: false,
                                        timestamp: now, speed: 30),
                      ledger: TripLedger(), pace: PaceModel(), now: now)
    }

    func gas(_ plan: TripPlan, _ s: TripSnapshot, _ range: Double, favorites: [String] = []) -> [StopCandidate] {
        RangePlanner.gasCandidates(plan: plan, from: s.progress, range: range, dataset: Fixtures.interstates, favorites: favorites)
    }

    /// Every exit with a gas station and the range left on arrival, computed without the planner.
    func gasExits(_ plan: TripPlan, from d: Double, range: Double) -> [(id: String, ahead: Double, arrive: Double)] {
        plan.exits.compactMap { e in
            let ahead = e.distanceAlongRoute - d
            guard ahead > 0 else { return nil }
            let detours = Fixtures.interstates.services(for: e).filter { $0.place.category == .gas }.map(\.detourMeters)
            guard let detour = detours.min() else { return nil }
            let arrive = range - ahead - detour / 2
            return arrive >= 0 ? (e.id, ahead, arrive) : nil
        }
    }

    func testRangeCountsDownWithMilesDriven() {
        let fuel = FuelReading(rangeMeters: 300 * mile, drivenAtEntry: 10 * mile)
        XCTAssertEqual(fuel.rangeLeft(drivenTotal: 10 * mile), 300 * mile, accuracy: 1e-6)
        XCTAssertEqual(fuel.rangeLeft(drivenTotal: 60 * mile), 250 * mile, accuracy: 1e-6)
        XCTAssertEqual(fuel.rangeLeft(drivenTotal: 400 * mile), 0)
        XCTAssertEqual(RangePlanner.fullTankRange(tankGallons: 17, milesPerGallon: 34)!, 578 * mile, accuracy: 1e-6)
        XCTAssertNil(RangePlanner.fullTankRange(tankGallons: nil, milesPerGallon: 34))
    }

    func testRecommendsTheLastGasExitReachedWithTheBuffer() {
        let plan = Self.miami
        let s = snap(plan, 100)
        let range = 300 * mile
        let r = RangePlanner.plan(plan: plan, snapshot: s, range: range, candidates: gas(plan, s, range))
        XCTAssertEqual(r.status, .planned)
        let truth = gasExits(plan, from: s.progress, range: range)
        let keeps = truth.filter { $0.arrive >= 50 * mile }
        XCTAssertGreaterThan(keeps.count, 5)
        let expected = keeps.last!
        XCTAssertEqual(r.recommended?.key, expected.id)
        XCTAssertEqual(r.recommended!.rangeOnArrival, expected.arrive, accuracy: 1e-6)
        if let after = truth.first(where: { $0.ahead > expected.ahead }) { XCTAssertLessThan(after.arrive, 50 * mile) }
        XCTAssertEqual(r.earlier.count, 2)
        XCTAssertTrue(r.earlier[0].ahead < r.recommended!.ahead && r.earlier[1].ahead < r.earlier[0].ahead)
        XCTAssertTrue(r.recommended!.ahead > 200 * mile && r.recommended!.ahead <= 250 * mile)
        XCTAssertGreaterThan(r.recommended!.eta, now)
    }

    func testReachesTheDestinationWithTheBuffer() {
        let plan = TripPlan(route: Fixtures.route("atlanta_to_nashville"), datasets: Self.datasets)
        let s = snap(plan, 0)
        let r = RangePlanner.plan(plan: plan, snapshot: s, range: 400 * mile, candidates: gas(plan, s, 400 * mile))
        XCTAssertEqual(r.status, .destination)
        XCTAssertEqual(r.destinationSpare! / mile, 400 - plan.route.length / mile, accuracy: 0.01)
        let d = RangePlanner.plan(plan: plan, snapshot: s, range: 400 * mile, candidates: gas(plan, s, 400 * mile), hasDestination: false)
        XCTAssertNotEqual(d.status, .destination)
    }

    func testBelowTheBufferNearestGasFirstAndNoRangeNone() {
        let plan = Self.miami
        let s = snap(plan, 450)  // I-95 in Georgia (mile 100 is Florida's Turnpike, which has no exit data)
        let low = RangePlanner.plan(plan: plan, snapshot: s, range: 30 * mile, candidates: gas(plan, s, 30 * mile))
        XCTAssertEqual(low.status, .low)
        XCTAssertEqual(low.recommended?.key, gasExits(plan, from: s.progress, range: 30 * mile).first?.id)
        XCTAssertEqual(RangePlanner.plan(plan: plan, snapshot: s, range: 0, candidates: gas(plan, s, 0)).status, .none)
    }

    func testFavoriteBrandWinsAnywhereInRangeKeepingTheBuffer() {
        let plan = Self.miami
        let s = snap(plan, 100)
        let range = 300 * mile
        let base = RangePlanner.plan(plan: plan, snapshot: s, range: range, candidates: gas(plan, s, range))
        func name(_ g: ExitService) -> String { (g.place.brand.isEmpty ? g.place.name : g.place.brand).lowercased() }
        let latestNames = Set(base.recommended!.candidate.gasStations.map(name))
        let keeps = base.stations.filter { $0.rangeOnArrival >= 50 * mile && $0.key != base.recommended!.key }
        guard let brand = keeps.flatMap({ $0.candidate.gasStations.map(name) }).first(where: { !$0.isEmpty && !latestNames.contains($0) }) else {
            return XCTFail("a brand only at earlier exits")
        }
        let r = RangePlanner.plan(plan: plan, snapshot: s, range: range, candidates: gas(plan, s, range, favorites: [brand]),
                                  favorites: [brand])
        XCTAssertTrue(r.recommended!.favorite)
        XCTAssertGreaterThanOrEqual(r.recommended!.rangeOnArrival, 50 * mile)
        let withBrand = keeps.filter { $0.candidate.gasStations.contains { name($0) == brand } }
        XCTAssertEqual(r.recommended?.key, withBrand.last?.key)
        XCTAssertEqual(r.closestToTarget?.key, base.recommended?.key)
        let none = RangePlanner.plan(plan: plan, snapshot: s, range: range,
                                     candidates: gas(plan, s, range, favorites: ["No Such Brand"]), favorites: ["No Such Brand"])
        XCTAssertTrue(none.favoriteMissing)
        XCTAssertEqual(none.recommended?.key, base.recommended?.key)
    }

    func testFavoriteMatchingIgnoresCaseAndPunctuation() {
        XCTAssertTrue(RangePlanner.matchesFavorite("Casey's General Store", favorites: ["caseys"]))
        XCTAssertTrue(RangePlanner.matchesFavorite("Costco Gasoline", favorites: ["Costco"]))
        XCTAssertTrue(RangePlanner.matchesFavorite("Shell", favorites: ["shell"]))
        XCTAssertFalse(RangePlanner.matchesFavorite("Shell", favorites: ["Exxon"]))
        XCTAssertFalse(RangePlanner.matchesFavorite("", favorites: ["Shell"]))
    }

    func testChargingStopsArePlacedOnTheRouteAndPlannedLikeGas() {
        let plan = Self.miami
        let poly = plan.route.polyline
        func at(_ mi: Double, _ east: Double) -> GeoCoordinate { Geodesy.offset(poly.coordinate(at: mi * mile), bearing: 90, meters: east) }
        let stations = [
            ChargerStation(id: 1, name: "A", coordinate: at(150, 400)), ChargerStation(id: 2, name: "B", coordinate: at(260, 900)),
            ChargerStation(id: 3, name: "C", coordinate: at(330, 300)), ChargerStation(id: 4, name: "Far", coordinate: at(200, 9000)),
        ]
        let projected = RangePlanner.projectChargers(poly, stations: stations)
        XCTAssertEqual(projected.map(\.station.name), ["A", "B", "C"])
        XCTAssertEqual(projected[1].along / mile, 260, accuracy: 0.6)
        XCTAssertEqual(projected[1].offset, 900, accuracy: 60)
        let s = snap(plan, 100)
        func run(_ range: Double) -> RangePlan {
            RangePlanner.plan(plan: plan, snapshot: s, range: range * mile,
                              candidates: RangePlanner.chargerCandidates(projected, from: s.progress, range: range * mile),
                              bufferMeters: 30 * mile)
        }
        // With 265 mi of range, C (mile 330) arrives with about 34.8 mi, above the 30 mi buffer.
        let r = run(265)
        XCTAssertEqual(r.status, .planned)
        XCTAssertEqual(r.recommended?.candidate.charger?.station.name, "C")
        XCTAssertEqual(r.recommended!.rangeOnArrival / mile, 265 - 230 - 1.3 * 300 / mile, accuracy: 0.7)
        // With 260 mi, C would arrive with 29.8 mi, so B is the stop and C the last chance.
        let b = run(260)
        XCTAssertEqual(b.recommended?.candidate.charger?.station.name, "B")
        XCTAssertEqual(b.lastChance?.candidate.charger?.station.name, "C")
        XCTAssertEqual(run(200).recommended?.candidate.charger?.station.name, "B")
    }
}
