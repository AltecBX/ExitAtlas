import XCTest
@testable import ExitAtlasCore

/// Current weather on real National Weather Service answers (the same expectations as web/tests/weather.test.js):
/// the nearest station that reported in the last 90 minutes, else this hour's forecast, never an old reading.
final class WeatherTests: XCTestCase {
    func load(_ name: String) throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("weather/\(name)")))
    }

    func iso(_ v: JSONValue?) -> Date { ISO8601DateFormatter().date(from: v!.string!)! }

    func check(_ w: CurrentWeather.Now?, _ e: JSONValue, _ x: JSONValue, file: StaticString = #filePath, line: UInt = #line) {
        guard let w else { return XCTFail("no weather", file: file, line: line) }
        XCTAssertEqual(w.source.rawValue, e["source"]?.string, "source", file: file, line: line)
        XCTAssertEqual(w.station?.id, e["station"]?.string, "station", file: file, line: line)
        XCTAssertEqual(w.at, iso(e["at"]), "at", file: file, line: line)
        XCTAssertEqual(w.temperatureF, e["temperatureF"]?.number.map { Int($0) }, "temperature", file: file, line: line)
        XCTAssertEqual(w.feelsLikeF, e["feelsLikeF"]?.number.map { Int($0) }, "feels like", file: file, line: line)
        XCTAssertEqual(w.kind?.rawValue, e["kind"]?.string, "kind", file: file, line: line)
        XCTAssertEqual(w.isDay, e["isDay"]?.bool, "isDay", file: file, line: line)
        XCTAssertEqual(w.condition, e["condition"]?.string, "condition", file: file, line: line)
        XCTAssertEqual(w.windMph, e["windMph"]?.number.map { Int($0) }, "wind", file: file, line: line)
        XCTAssertEqual(w.windFrom, e["windFrom"]?.string, "wind from", file: file, line: line)
        XCTAssertEqual(w.gustMph, e["gustMph"]?.number.map { Int($0) }, "gusts", file: file, line: line)
        XCTAssertEqual(w.humidity, e["humidity"]?.number.map { Int($0) }, "humidity", file: file, line: line)
        let next = x["next"]!.array!
        XCTAssertEqual(w.next.count, next.count, "next hours", file: file, line: line)
        for (h, n) in zip(w.next, next) {
            XCTAssertEqual(h.at, iso(n["at"]), file: file, line: line)
            XCTAssertEqual(h.temperatureF, n["temperatureF"]?.number.map { Int($0) }, file: file, line: line)
            XCTAssertEqual(h.kind?.rawValue, n["kind"]?.string, file: file, line: line)
            XCTAssertEqual(h.isDay, n["isDay"]?.bool, file: file, line: line)
            XCTAssertEqual(h.rainChance, n["rainChance"]?.number.map { Int($0) }, file: file, line: line)
        }
    }

    func setup() throws -> (x: JSONValue, position: GeoCoordinate, now: Date, stations: [CurrentWeather.Station]) {
        let x = try load("expect.json")
        let position = GeoCoordinate(latitude: x["position"]!["lat"]!.number!, longitude: x["position"]!["lon"]!.number!)
        return (x, position, iso(x["now"]), CurrentWeather.nearestStations(try load("stations.json"), position: position))
    }

    func testStationsWithinReachNearestFirst() throws {
        let (x, position, _, stations) = try setup()
        _ = position
        let expected = x["stations"]!.array!.map { ($0.array![0].string!, $0.array![1].number!) }
        XCTAssertEqual(stations.map(\.id), expected.map(\.0))
        for (s, e) in zip(stations, expected) { XCTAssertEqual((s.distance / 10).rounded() / 100, e.1, accuracy: 0.001, s.id) }
        XCTAssertEqual(CurrentWeather.nearestStations(try load("stations.json"), position: GeoCoordinate(latitude: 33.75, longitude: -84.39)).count, 0)
    }

    func testObservedSkipsAStaleStation() throws {
        let (x, _, now, st) = try setup()
        let w = CurrentWeather.now(observations: [(st[0], try load("obs_KNIP.json")), (st[1], try load("obs_KCRG.json"))],
                                   hourly: try load("hourly.json"), now: now, place: "Jacksonville, FL")
        check(w, x["observed"]!, x)
        XCTAssertEqual(w?.place, "Jacksonville, FL")
        XCTAssertEqual(w?.windText, "NE 11 mph")
        XCTAssertEqual(w?.label, "Cloudy")
    }

    func testForecastWhenNoRecentObservation() throws {
        let (x, _, now, st) = try setup()
        check(CurrentWeather.now(observations: [(st[0], try load("obs_KNIP.json"))], hourly: try load("hourly.json"), now: now), x["forecastOnly"]!, x)
        check(CurrentWeather.now(observations: [], hourly: try load("hourly.json"), now: now), x["forecastOnly"]!, x)
    }

    func testNeverAnOldReadingOrPastForecastAsNow() throws {
        let (_, _, now, st) = try setup()
        let kcrg = try load("obs_KCRG.json")
        let at = iso(kcrg["properties"]?["timestamp"])
        func one(_ t: Date) -> CurrentWeather.Now? { CurrentWeather.now(observations: [(st[1], kcrg)], hourly: nil, now: t) }
        XCTAssertEqual(one(at.addingTimeInterval(90 * 60))?.source, .observed, "exactly 90 minutes old")
        XCTAssertNil(one(at.addingTimeInterval(90 * 60 + 1)), "older, and no forecast")
        XCTAssertNil(one(at.addingTimeInterval(-11 * 60)), "from the future")
        XCTAssertNil(CurrentWeather.now(observations: [], hourly: try load("hourly.json"), now: now.addingTimeInterval(30 * 86400)), "forecast ran out")
        XCTAssertNil(CurrentWeather.now(observations: [], hourly: nil, now: now))
        guard case var .object(body) = kcrg, case var .object(props) = body["properties"]! else { return XCTFail("shape") }
        props["temperature"] = ["value": nil]
        body["properties"] = .object(props)
        XCTAssertEqual(CurrentWeather.now(observations: [(st[1], .object(body))], hourly: try load("hourly.json"), now: now)?.source, .forecast, "no temperature")
    }

    func testKindsFromIconsElseWords() throws {
        for k in try load("expect.json")["kinds"]!.array! {
            let a = k.array!
            let r = CurrentWeather.kind(icon: a[0].string, text: a[1].string)
            XCTAssertEqual(r.kind?.rawValue, a[2].string, "\(a[0]) \(a[1])")
            XCTAssertEqual(r.isDay, a[3].bool, "\(a[0]) \(a[1])")
        }
        XCTAssertEqual(CurrentWeather.Kind.clear.label(isDay: true), "Sunny")
        XCTAssertEqual(CurrentWeather.Kind.clear.label(isDay: false), "Clear")
        XCTAssertEqual(CurrentWeather.roundHalfUp(-0.5), 0, "as Math.round")
        XCTAssertEqual(CurrentWeather.roundHalfUp(2.5), 3)
    }
}
