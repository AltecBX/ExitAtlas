import XCTest
@testable import ExitAtlasCore

/// Links to official consumer price pages (same expectations as web/tests/pricecheck.test.js).
final class PriceCheckTests: XCTestCase {
    func testGoogleMapsSearchesTheBrandNearTheStation() {
        XCTAssertEqual(PriceCheck.googleMaps(name: "Shell", brand: "Shell", latitude: 40.931234, longitude: -73.898761),
                       "https://www.google.com/maps/search/?api=1&query=Shell%2040.93123%2C-73.89876")
        XCTAssertEqual(PriceCheck.googleMaps(name: "Mobil Mart", brand: "", latitude: 40.9, longitude: -73.9),
                       "https://www.google.com/maps/search/?api=1&query=Mobil%20Mart%2040.90000%2C-73.90000")
    }

    func testGasBuddyCityThenStateNeverAGuess() {
        XCTAssertEqual(PriceCheck.gasBuddy(city: "Yonkers", state: "New York"), "https://www.gasbuddy.com/gasprices/new-york/yonkers")
        XCTAssertEqual(PriceCheck.gasBuddy(city: "Yonkers", state: "NY"), "https://www.gasbuddy.com/gasprices/new-york/yonkers")
        XCTAssertEqual(PriceCheck.gasBuddy(city: "Coeur d'Alene", state: "ID"), "https://www.gasbuddy.com/gasprices/idaho/coeur-dalene")
        XCTAssertEqual(PriceCheck.gasBuddy(city: nil, state: "NJ"), "https://www.gasbuddy.com/gasprices/new-jersey")
        XCTAssertNil(PriceCheck.gasBuddy(city: "Yonkers", state: nil))
        XCTAssertNil(PriceCheck.gasBuddy(city: "Toronto", state: "Ontario"))
        XCTAssertEqual(PriceCheck.slug("St. Mary’s"), "st-marys")
    }
}
