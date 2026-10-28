import XCTest
@testable import ExitAtlasCore

/// The bundled EPA vehicle file, read the same way as the web version.
final class VehicleCatalogTests: XCTestCase {
    static let catalog = try! VehicleCatalog(contentsOf: Fixtures.dataDirectory.appendingPathComponent("vehicles.json"))

    func testCamryMatchesTheEPAAndHasAVerifiedTank() {
        let c = Self.catalog
        XCTAssertEqual(c.modelYears.first, 2027)
        XCTAssertEqual(c.modelYears.last, 2000)
        XCTAssertTrue(c.makes(year: 2015).contains("Toyota"))
        let camry = c.versions(year: 2015, make: "Toyota", model: "Camry")
        let four = camry.first { $0.label.hasPrefix("4 cyl 2.5 L") && !$0.label.contains("Hybrid") }!
        // fueleconomy.gov: 25 city, 34 highway, 28 combined.
        XCTAssertEqual([four.city, four.highway, four.combined], [25, 34, 28])
        XCTAssertEqual(four.tank?.gallons, [17.0])
        XCTAssertEqual(four.fuel, .regular)
        var v = DriverVehicle(year: 2015, make: "Toyota", model: "Camry", version: four)
        XCTAssertEqual(v.tankGallons, 17)
        XCTAssertTrue(v.tankIsVerified)
        XCTAssertEqual(v.fullRangeMeters! / Geodesy.metersPerMile, 17 * 34, accuracy: 1e-9)
        v.basis = .combined
        XCTAssertEqual(v.fullRangeMeters! / Geodesy.metersPerMile, 17 * 28, accuracy: 1e-9)
        v.basis = .custom
        v.customMilesPerGallon = 31
        XCTAssertEqual(v.fullRangeMeters! / Geodesy.metersPerMile, 17 * 31, accuracy: 1e-9)
    }

    func testElectricRangeAndTwoTankModels() {
        let c = Self.catalog
        let y = c.versions(year: 2024, make: "Tesla", model: "Model Y").first { $0.label.hasPrefix("Model Y Long Range AWD") }!
        XCTAssertTrue(y.isElectric)
        XCTAssertEqual(y.evRangeMiles, 310)
        XCTAssertEqual(y.evRangeHighwayMiles, 296)
        let ev = DriverVehicle(year: 2024, make: "Tesla", model: "Model Y", version: y)
        XCTAssertEqual(ev.fullRangeMeters! / Geodesy.metersPerMile, 296, accuracy: 1e-9)
        // The base 718 Cayman came with a 14.3 or 16.9 gallon tank: nothing is assumed until the driver picks.
        let cayman = c.versions(year: 2021, make: "Porsche", model: "718").first { $0.label.hasPrefix("718 Cayman ·") }!
        XCTAssertEqual(cayman.tank?.gallons, [14.3, 16.9])
        XCTAssertNil(DriverVehicle(year: 2021, make: "Porsche", model: "718", version: cayman).fullRangeMeters)
        let picked = DriverVehicle(year: 2021, make: "Porsche", model: "718", version: cayman, tankGallons: 16.9)
        XCTAssertTrue(picked.tankIsVerified)
        let entered = DriverVehicle(year: 2021, make: "Porsche", model: "718", version: cayman, tankGallons: 15)
        XCTAssertFalse(entered.tankIsVerified)
    }

    func testEveryVersionDecodesAndTankCountsMatchTheFile() {
        let c = Self.catalog
        var versions = 0, withTank = 0
        for year in c.modelYears {
            for make in c.makes(year: year) {
                for model in c.models(year: year, make: make) {
                    for v in c.versions(year: year, make: make, model: model) {
                        versions += 1
                        if v.tank != nil { withTank += 1 }
                    }
                }
            }
        }
        XCTAssertEqual(versions, 31821)
        XCTAssertEqual(withTank, c.versionsWithTank)
    }
}
