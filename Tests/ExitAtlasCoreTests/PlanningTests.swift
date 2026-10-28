import XCTest
@testable import ExitAtlasCore

final class PlanningTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_793_000_000)
    var plan: TripPlan { TripSnapshotTests.miami }

    func snapshot(at miles: Double) -> TripSnapshot {
        plan.snapshot(match: RouteMatch(status: .onRoute, distanceAlongRoute: miles * Geodesy.metersPerMile, offset: 0,
                                        isEstimated: false, timestamp: now, speed: 30),
                      ledger: TripLedger(), pace: PaceModel(), now: now)
    }

    func testMultiCriteriaSearchFindsSingleExitSatisfyingAll() {
        let search = AlongRouteSearch(dataset: Fixtures.interstates)
        let query = AlongRouteQuery(requirements: [ServiceRequirement(category: .gas),
                                                   ServiceRequirement(category: .food, nameOrBrand: "starbucks")],
                                    fromDistance: 0, toDistance: plan.route.length)
        let results = search.search(query, exits: plan.exits)
        XCTAssertFalse(results.isEmpty)
        for r in results {
            XCTAssertTrue(r.matchesPerRequirement[0].allSatisfy { $0.place.category == .gas })
            XCTAssertTrue(r.matchesPerRequirement[1].allSatisfy {
                ($0.place.brand + " " + $0.place.name).lowercased().contains("starbucks")
            })
        }
        for (a, b) in zip(results, results.dropFirst()) {
            XCTAssertLessThan(a.exit.distanceAlongRoute, b.exit.distanceAlongRoute)
        }
    }

    func testBrandMatchingIgnoresPunctuation() {
        let place = Place(datasetIndex: 0, id: "node/1", coordinate: GeoCoordinate(latitude: 0, longitude: 0),
                          name: "Dunkin'", brand: "Dunkin'", category: .food)
        let service = ExitService(place: place, exitID: "x", straightLineMeters: 100, detourMeters: 400,
                                  detourSeconds: 60, detourBasis: .routedOneWayDoubled, reachable: true, rank: 1)
        XCTAssertTrue(ServiceRequirement(nameOrBrand: "dunkin").matches(service))
        XCTAssertTrue(ServiceRequirement(nameOrBrand: "DUNKIN'").matches(service))
        XCTAssertFalse(ServiceRequirement(nameOrBrand: "starbucks").matches(service))
        XCTAssertFalse(ServiceRequirement(maxDetourMeters: 300).matches(service))
    }

    func testHotelAboutThreeHoursAheadIsNearTheTargetTime() {
        let planner = StopPlanner(dataset: Fixtures.interstates)
        let s = snapshot(at: 100)
        let query = StopQuery(requirements: [ServiceRequirement(category: .lodging)],
                              window: .timeAhead(3 * 3600, tolerance: 20 * 60))
        let results = planner.suggestions(query, plan: plan, snapshot: s, pace: PaceModel(), now: now)
        XCTAssertFalse(results.isEmpty)
        for r in results {
            XCTAssertLessThanOrEqual(abs(r.timeFromTarget!), 20 * 60 + 60)
        }
        for (a, b) in zip(results, results.dropFirst()) {
            XCTAssertLessThanOrEqual(abs(a.timeFromTarget!), abs(b.timeFromTarget!))
        }
    }

    func testServicesUseRoutedDetourWhenAvailable() {
        let withServices = plan.exits.first { !Fixtures.interstates.services(for: $0).isEmpty }!
        for service in Fixtures.interstates.services(for: withServices) {
            if service.detourBasis == .routedOneWayDoubled {
                XCTAssertNotNil(service.detourSeconds)
            }
            XCTAssertGreaterThan(service.detourMeters, 0)
        }
    }

    /// Fuel planning math with hand-made price observations. These numbers exist only in this test.
    func testFuelPlannerRangeDetourAndStalePrices() {
        let s = snapshot(at: 200)
        let vehicle = VehicleProfile(milesPerGallon: 25, tankGallons: 15, reserveGallons: 2)
        let dataset = Fixtures.interstates
        let gasExits = plan.exits(after: s.progress, upTo: s.progress + 120 * Geodesy.metersPerMile)
            .flatMap { exit in dataset.services(for: exit).filter { $0.place.category == .gas }.map { (exit, $0) } }
        XCTAssertGreaterThan(gasExits.count, 4)
        var prices: [String: [FuelPriceObservation]] = [:]
        for (i, (_, service)) in gasExits.enumerated() {
            let price = 3.50 - Double(i) * 0.01
            let age: TimeInterval = i == gasExits.count - 1 ? 72 * 3600 : 3600  // last one is stale
            prices[service.place.id] = [FuelPriceObservation(placeID: service.place.id, grade: .regular,
                                                             pricePerGallon: price, observedAt: now.addingTimeInterval(-age),
                                                             source: "test")]
        }
        // 4 gallons: (4 - 2 reserve) * 25 = 50 miles of usable range.
        let result = FuelPlanner().plan(snapshot: s, plan: plan, dataset: dataset, vehicle: vehicle, fuelGallons: 4,
                                        prices: prices, now: now)
        for o in result.options where o.reachable {
            XCTAssertLessThanOrEqual(o.exit.distance + o.service.detourMeters / 2, 50 * Geodesy.metersPerMile + 1)
        }
        if let cheapest = result.cheapestPrice {
            XCTAssertTrue(cheapest.reachable)
            XCTAssertLessThan(now.timeIntervalSince(cheapest.price!.observedAt), 48 * 3600)
            let reachablePriced = result.options.filter { $0.reachable && $0.price != nil }
            XCTAssertEqual(cheapest.price!.pricePerGallon, reachablePriced.map { $0.price!.pricePerGallon }.min()!)
        }
        if let best = result.bestValue, let e = best.effectivePricePerGallon {
            XCTAssertGreaterThanOrEqual(e, best.price!.pricePerGallon)
        }
        // Stale observation is never used.
        let staleID = gasExits.last!.1.place.id
        XCTAssertNil(result.options.first { $0.service.place.id == staleID }?.price)
    }

    func testLowFuelStillListsTheNearestStations() {
        let s = snapshot(at: 200)
        let vehicle = VehicleProfile(milesPerGallon: 25, tankGallons: 15, reserveGallons: 2)
        // At the reserve: no usable range, but the stations in the next 50 miles are still listed.
        let result = FuelPlanner().plan(snapshot: s, plan: plan, dataset: Fixtures.interstates, vehicle: vehicle,
                                        fuelGallons: 2, prices: [:], now: now)
        XCTAssertFalse(result.options.isEmpty)
        XCTAssertTrue(result.options.allSatisfy { !$0.reachable })
        XCTAssertTrue(result.options.allSatisfy { $0.exit.distance <= 50 * Geodesy.metersPerMile + 1 })
    }
}
