import XCTest
@testable import ExitAtlasCore

/// The driver's profile: the same fixtures and expected results as web/tests/profile.test.js.
final class ProfileTests: XCTestCase {
    func fixture(_ name: String) throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("profiles/\(name).json")))
    }

    func testOldDefaultOvernightWindowMovesToFiveAMOnce() throws {
        func overnight(_ schema: Int?, _ start: String, _ end: String) -> JSONValue? {
            var raw: [String: JSONValue] = ["kind": "exitatlas-profile", "overnight": .object(["mode": "auto", "start": .string(start), "end": .string(end)])]
            if let schema { raw["schema"] = .number(Double(schema)) }
            return ProfileRules.normalize(.object(raw)).profile["overnight"]
        }
        XCTAssertEqual(overnight(2, "00:00", "04:00"), .object(["mode": "auto", "start": "00:00", "end": "05:00"]))
        XCTAssertEqual(overnight(nil, "00:00", "04:00")?["end"], "05:00")
        XCTAssertEqual(overnight(2, "23:00", "04:00")?["end"], "04:00")
        XCTAssertEqual(overnight(2, "00:00", "03:00")?["end"], "03:00")
        XCTAssertEqual(overnight(3, "00:00", "04:00")?["end"], "04:00")
        // Only the window's end changes in a full profile.
        guard var saved = try fixture("full").object else { return XCTFail("full profile") }
        saved["schema"] = 2
        saved["overnight"] = .object(["mode": "auto", "start": "00:00", "end": "04:00"])
        var expected = saved
        expected["schema"] = 3
        expected["overnight"] = .object(["mode": "auto", "start": "00:00", "end": "05:00"])
        let (profile, problems) = ProfileRules.normalize(.object(saved))
        XCTAssertEqual(problems, [])
        XCTAssertEqual(profile, .object(expected))
    }

    func testValidProfileIsKeptExactly() throws {
        let full = try fixture("full")
        let (profile, problems) = ProfileRules.normalize(full)
        XCTAssertEqual(profile, full)
        XCTAssertEqual(problems, [])
    }

    func testDamagedFieldsFallBackOneByOne() throws {
        let (profile, problems) = ProfileRules.normalize(try fixture("damaged"))
        let expected = try fixture("damaged.expected")
        XCTAssertEqual(profile, expected["profile"])
        XCTAssertEqual(problems, expected["problems"]?.array?.compactMap(\.string))
        // Unknown keys from a newer version survive.
        XCTAssertEqual(profile["futureSetting"], ["keep": "me"])
    }

    func testUnreadableProfileGivesDefaultsWithShell() {
        let (profile, problems) = ProfileRules.normalize("not an object")
        XCTAssertEqual(problems, ["profile"])
        XCTAssertEqual(profile["fuel"]?["brands"], ["Shell"])
        XCTAssertEqual(profile["vehicles"], [])
    }

    func testDriverChoicesAreNotResetToDefaults() {
        // A driver who removed every favorite brand keeps the empty list; Shell is only the starting point.
        var raw = ProfileRules.defaults().object!
        raw["fuel"] = ["brands": []]
        XCTAssertEqual(ProfileRules.normalize(.object(raw)).profile["fuel"]?["brands"], [])
    }

    func testIOSVersionOneMigration() throws {
        let v1 = try fixture("ios_v1")
        let migrated = ProfileRules.migrateIOSV1(defaults: v1["defaults"]!.object!, places: v1["places"])
        XCTAssertEqual(migrated, try fixture("ios_v1.expected"))
        // API keys never enter the profile.
        XCTAssertFalse(String(data: try migrated.data(), encoding: .utf8)!.contains("AIza"))
    }

    /// Saved trips travel in the profile file as plans (the iOS app keeps them in saved.json).
    func testTripPlansRoundTrip() throws {
        let full = try fixture("full")
        let plans = SavedPlan.plans(in: full)
        XCTAssertEqual(plans.map(\.name), ["Florida run", "To Mom"])
        XCTAssertNil(plans[0].from, "nil starts at the current location")
        XCTAssertEqual(plans[0].stops.map(\.name), ["Savannah, GA"])
        XCTAssertEqual(plans[1].from?.name, "Home")
        let rewritten = SavedPlan.profile(full, withPlans: plans)
        XCTAssertEqual(SavedPlan.plans(in: rewritten), plans)
        XCTAssertEqual(rewritten["fuel"], full["fuel"], "only the plans change")
        XCTAssertEqual(SavedPlan.plans(in: SavedPlan.profile(full, withPlans: [])), [])
    }

    func testVehicleIdMatchesJavaScript() {
        XCTAssertEqual(ProfileRules.vehicleId(year: 2015, make: "Toyota", model: "Camry", version: "4 cyl 2.5 L, Automatic (S6)"),
                       "2015|toyota|camry|4-cyl-2.5-l-automatic-s6-")
    }
}
