import XCTest
@testable import ExitAtlasCore

/// Gas price engine on the shared SIMULATED fixtures (the same expectations as web/tests/gasprices.test.js).
/// No real prices are used here.
final class GasPricesTests: XCTestCase {
    let mile = Geodesy.metersPerMile

    func fixture() throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("prices/cases.json")))
    }

    func date(_ v: JSONValue?) -> Date { Date(timeIntervalSince1970: v!.number!) }

    func record(_ x: JSONValue) -> GasPrices.Record {
        let s = x["source"]!
        return GasPrices.Record(id: x["id"]!.string!, stationId: x["stationId"]!.string!, grade: x["grade"]!.string!, price: x["price"]!.number!,
                                payment: x["payment"]?.string.flatMap(GasPrices.Payment.init(rawValue:)), member: x["member"]?.bool ?? false,
                                reportedAt: date(x["reportedAt"]), reporter: x["reporter"]?.string,
                                source: .init(id: s["id"]!.string!, name: s["name"]!.string!, kind: GasPrices.Source.Kind(rawValue: s["kind"]!.string!)!))
    }

    func testReportsAreChecked() throws {
        let f = try fixture()
        let now = date(f["now"])
        for c in f["validate"]!.array! {
            let x = c["input"]!
            // An unknown payment kind cannot be represented in Swift (Payment is an enum); the website checks it.
            if let p = x["payment"]?.string, GasPrices.Payment(rawValue: p) == nil { continue }
            let r = GasPrices.Record(id: "t", stationId: x["stationId"]!.string!, grade: x["grade"]!.string!, price: x["price"]!.number!,
                                     payment: x["payment"]?.string.flatMap(GasPrices.Payment.init(rawValue:)), member: x["member"]?.bool ?? false,
                                     reportedAt: x["reportedAt"]?.number.map { Date(timeIntervalSince1970: $0) } ?? now, reporter: nil,
                                     source: .init(id: "own", name: "You", kind: .own))
            let out = GasPrices.validate(r, now: now, benchmark: c["benchmark"]?.number)
            let name = c["name"]!.string!
            XCTAssertEqual(out.record != nil, c["ok"]!.bool!, name)
            if c["ok"]!.bool! { XCTAssertEqual(out.record!.price, c["price"]!.number!, accuracy: 1e-9, name) }
            else { XCTAssertEqual(out.problems, c["problems"]!.array!.map { $0.string! }, name) }
        }
    }

    func testFreshness() throws {
        let f = try fixture()
        let now = date(f["now"])
        for c in f["freshness"]!.array! {
            let out = GasPrices.freshness(reportedAt: now.addingTimeInterval(-c["age"]!.number!), now: now, maxAgeHours: c["maxAgeHours"]!.number!)
            XCTAssertEqual(out.state.rawValue, c["state"]!.string!)
            XCTAssertEqual(out.text, c["text"]!.string!)
        }
    }

    func testRepeatsCorrectionsAndConfirmations() throws {
        let f = try fixture()
        let now = date(f["now"])
        let byId = Dictionary(uniqueKeysWithValues: f["records"]!.array!.map { ($0["id"]!.string!, record($0)) })
        for c in f["addReport"]!.array! {
            var add = c["add"]!.object!
            add["source"] = ["id": "own", "name": "You", "kind": "own"]
            let out = GasPrices.add(record(.object(add)), to: c["start"]!.array!.map { byId[$0.string!]! }, now: now)
            XCTAssertEqual(out.map(\.id), c["expect"]!.array!.map { $0.string! }, c["name"]!.string!)
        }
    }

    func testOnePricePerStationAndGrade() throws {
        let f = try fixture()
        let now = date(f["now"])
        let records = f["records"]!.array!.map(record)
        for c in f["stationPrice"]!.array! {
            let name = c["name"]!.string!
            let out = GasPrices.stationPrice(records, stationId: c["station"]!.string!, grade: c["grade"]!.string!, now: now,
                                             payment: GasPrices.Payment(rawValue: c["payment"]!.string!)!, member: c["member"]?.bool ?? false)
            guard let x = c["expect"], !x.isNull else { XCTAssertNil(out, name); continue }
            XCTAssertEqual(out?.record.id, x["id"]!.string!, name)
            XCTAssertEqual(out?.state.rawValue, x["state"]!.string!, name)
            XCTAssertEqual(out?.paymentMatch.rawValue, x["paymentMatch"]!.string!, name)
            XCTAssertEqual(out?.confirmations, Int(x["confirmations"]!.number!), name)
            XCTAssertEqual(out?.conflict, x["conflict"]!.bool!, name)
        }
    }

    func testFillCost() throws {
        for c in try fixture()["fill"]!.array! {
            let out = GasPrices.fillCost(price: c["price"]!.number!, rangeOnArrival: c["rangeOnArrivalMiles"]!.number! * mile,
                                         tankGallons: c["tankGallons"]?.number, mpg: c["mpg"]?.number, detourMeters: c["detourMiles"]!.number! * mile)
            guard let x = c["expect"], !x.isNull else { XCTAssertNil(out); continue }
            XCTAssertEqual(out!.gallons, x["gallons"]!.number!, accuracy: 0.001)
            XCTAssertEqual(out!.detourGallons, x["detourGallons"]!.number!, accuracy: 0.001)
            XCTAssertEqual(out!.total, x["total"]!.number!, accuracy: 0.001)
        }
    }

    func testSavingsAgainstThePreferredStop() throws {
        func side(_ s: JSONValue) -> GasPrices.Side {
            let r = GasPrices.Record(id: "x", stationId: "x", grade: "R", price: s["price"]!.number!,
                                     payment: GasPrices.Payment(rawValue: s["payment"]!.string!), reportedAt: Date(), reporter: nil,
                                     source: .init(id: "own", name: "You", kind: .own))
            let price = GasPrices.StationPrice(record: r, state: GasPrices.State(rawValue: s["state"]!.string!)!, text: "",
                                               paymentMatch: .exact, confirmations: 0, conflict: false)
            let gallons = s["gallons"]!.number!, detour = s["detourGallons"]!.number!
            return GasPrices.Side(price: price, cost: .init(gallons: gallons, detourGallons: detour, total: s["price"]!.number! * (gallons + detour)),
                                  detourMeasured: s["detourMeasured"]!.bool!)
        }
        for c in try fixture()["compare"]!.array! {
            let out = GasPrices.compare(side(c["a"]!), side(c["b"]!))
            let name = c["name"]!.string!
            guard let x = c["expect"], !x.isNull else { XCTAssertNil(out, name); continue }
            XCTAssertEqual(out!.savings, x["savings"]!.number!, accuracy: 0.001, name)
            XCTAssertEqual(out!.perGallon, x["perGallon"]!.number!, accuracy: 0.0001, name)
            XCTAssertEqual(out!.estimate, x["estimate"]!.bool!, name)
            XCTAssertEqual(out!.meaningful, x["meaningful"]!.bool!, name)
        }
    }

    func testSortingNeverPutsUnknownPricesFirst() throws {
        let f = try fixture()
        let now = date(f["now"])
        let records = f["records"]!.array!.map(record)
        let rows = f["sort"]!["rows"]!.array!.map { r in
            GasPrices.Row(id: r["id"]!.string!, ahead: r["aheadMiles"]!.number! * mile, detourMinutes: r["detourMinutes"]?.number,
                          brandRank: r["brandRank"]?.number.map { Int($0) }, recommendedRank: r["recommendedRank"]?.number.map { Int($0) },
                          price: r["price"]?.string.flatMap { GasPrices.stationPrice(records, stationId: $0, grade: "R", now: now) })
        }
        for (sort, ids) in f["sort"]!["expect"]!.object! {
            XCTAssertEqual(GasPrices.sort(rows, by: GasPrices.Sort(rawValue: sort)!).map(\.id), ids.array!.map { $0.string! }, sort)
        }
    }

    func testRegionalAverageAreas() throws {
        for (state, padd) in try fixture()["padd"]!.object! {
            XCTAssertEqual(GasPrices.paddFor(state), padd.string, state)
        }
    }
}
