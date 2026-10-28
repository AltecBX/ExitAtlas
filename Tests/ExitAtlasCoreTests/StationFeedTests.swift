import XCTest
@testable import ExitAtlasCore

/// Charger and gas price responses (the web version parses the same shapes).
final class StationFeedTests: XCTestCase {
    func testGooglePlacesPricesParseAndSortByGrade() throws {
        let json = #"""
        {"places":[
          {"id":"a","displayName":{"text":"Shell"},"location":{"latitude":31.2,"longitude":-81.5},
           "fuelOptions":{"fuelPrices":[
             {"type":"REGULAR_UNLEADED","price":{"currencyCode":"USD","units":"3","nanos":290000000},"updateTime":"2026-10-28T02:00:00Z"},
             {"type":"PREMIUM","price":{"currencyCode":"USD","units":"4","nanos":90000000},"updateTime":"2026-10-28T02:00:00.123Z"}]},
           "currentOpeningHours":{"openNow":true,"periods":[{"open":{"day":0,"hour":0,"minute":0}}]},"restroom":true},
          {"id":"b","displayName":{"text":"Wawa"},"location":{"latitude":31.21,"longitude":-81.5},
           "fuelOptions":{"fuelPrices":[{"type":"REGULAR_UNLEADED","price":{"currencyCode":"USD","units":"3","nanos":150000000},"updateTime":"2026-10-28T01:00:00Z"}]}},
          {"id":"c","displayName":{"text":"No prices"},"location":{"latitude":31.22,"longitude":-81.5}}]}
        """#
        let stations = try GasPriceFeed.parse(Data(json.utf8))
        XCTAssertEqual(stations.count, 3)
        XCTAssertEqual(stations[0].prices[.regular]!.dollars, 3.29, accuracy: 1e-9)
        XCTAssertNotNil(stations[0].prices[.premium]?.updated)
        XCTAssertEqual(stations[0].periods, [GooglePeriod(open: .init(day: 0))])
        XCTAssertEqual(stations[0].restroom, true)
        XCTAssertNil(stations[1].periods, "no hours listed: unknown, not closed")
        XCTAssertNil(stations[1].restroom)
        XCTAssertTrue(GasPriceFeed.fieldMask.hasSuffix("currentOpeningHours,places.restroom"))
        XCTAssertEqual(GasPriceFeed.priced(stations, grade: .regular).map(\.name), ["Wawa", "Shell"])
        XCTAssertEqual(GasPriceFeed.priced(stations, grade: .diesel).count, 0)
        let body = try JSONSerialization.jsonObject(with: GasPriceFeed.requestBody(near: GeoCoordinate(latitude: 31.2, longitude: -81.5))) as! [String: Any]
        XCTAssertEqual(body["includedTypes"] as? [String], ["gas_station"])
        XCTAssertEqual(GasPriceFeed.Grade(.diesel), .diesel)
        XCTAssertEqual(GasPriceFeed.Grade(.electric), .regular)
    }

    func testAFDCKeepsOpenFastChargersAndBuildsTheRouteQuery() throws {
        let json = #"""
        {"fuel_stations":[
          {"id":1,"station_name":"Hardeeville, SC - Tesla Supercharger","latitude":32.28,"longitude":-81.08,"ev_network":"Tesla",
           "ev_dc_fast_num":8,"ev_connector_types":["TESLA"],"access_days_time":"24 hours daily; NACS partner access","status_code":"E",
           "street_address":"1 Main St","city":"Hardeeville","state":"SC"},
          {"id":2,"station_name":"Planned","latitude":32.3,"longitude":-81.1,"ev_dc_fast_num":4,"status_code":"P"},
          {"id":3,"station_name":"Level 2 only","latitude":32.3,"longitude":-81.1,"ev_dc_fast_num":0,"status_code":"E"}]}
        """#
        let stations = try ChargerFeed.parse(Data(json.utf8))
        XCTAssertEqual(stations.map(\.id), [1])
        XCTAssertEqual(stations[0].stalls, 8)
        XCTAssertTrue(stations[0].openToOthers)
        XCTAssertEqual(stations[0].address, "1 Main St, Hardeeville, SC")
        let route = Fixtures.route("atlanta_to_nashville")
        let wkt = ChargerFeed.routeWKT(route.polyline)
        XCTAssertTrue(wkt.hasPrefix("LINESTRING("))
        // One point every 2 km plus the end point.
        XCTAssertEqual(wkt.components(separatedBy: ",").count, Int((route.polyline.length / 2000).rounded(.up)) + 1)
        let body = ChargerFeed.requestBody(route.polyline, teslaOnly: true)
        XCTAssertTrue(body.contains("ev_network=Tesla"))
        XCTAssertTrue(body.contains("ev_charging_level=dc_fast"))
    }
}
