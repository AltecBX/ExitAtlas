import XCTest
@testable import ExitAtlasCore

/// The iOS profile store: the same scenarios as web/tests/profile.test.js, on real files.
final class ProfileStoreTests: XCTestCase {
    var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("ProfileStoreTests-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func fixture(_ name: String) throws -> JSONValue {
        try JSONValue(data: Data(contentsOf: Fixtures.fixtureDirectory.appendingPathComponent("profiles/\(name).json")))
    }

    func testSettingsRoundTripWithoutLoss() throws {
        let full = try fixture("full")
        let settings = ProfileSettings(profile: full)
        XCTAssertEqual(settings.vehicle?.model, "Camry")
        XCTAssertEqual(settings.vehicle?.basis, .custom)
        XCTAssertEqual(settings.vehicle?.customMilesPerGallon, 33.5)
        XCTAssertEqual(settings.favoriteBrands, ["Shell", "Wawa", "Sheetz"])
        XCTAssertEqual(settings.applied(to: full), full)
    }

    func testVehicleAndPreferencesComeBackAfterForceQuit() throws {
        // K: the app is killed and launched again; a new store reads the same folder.
        let store = ProfileStore(directory: dir)
        let first = store.load { nil }
        XCTAssertEqual(first.source, .new)
        var s = ProfileSettings(profile: first.profile)
        XCTAssertEqual(s.favoriteBrands, ["Shell"], "Shell is the starting favorite")
        s.vehicles = ProfileSettings(profile: try fixture("full")).vehicles
        s.defaultVehicleID = "camry"
        s.favoriteBrands = ["Shell", "Wawa"]
        s.home = Waypoint(name: "Home", coordinate: GeoCoordinate(latitude: 40.7, longitude: -74))
        s.savedPlaces = [Waypoint(name: "Mom", coordinate: GeoCoordinate(latitude: 33.7, longitude: -84.4))]
        XCTAssertNil(store.write(s.applied(to: first.profile)))

        let reopened = ProfileStore(directory: dir).load { XCTFail("no migration when a profile exists"); return nil }
        XCTAssertEqual(reopened.source, .stored)
        XCTAssertNil(reopened.writeError)
        let back = ProfileSettings(profile: reopened.profile)
        XCTAssertEqual(back.vehicle?.title, "2015 Toyota Camry")
        XCTAssertEqual(back.favoriteBrands, ["Shell", "Wawa"])
        XCTAssertEqual(back.home?.name, "Home")
        XCTAssertEqual(back.savedPlaces.map(\.name), ["Mom"])

        // The driver empties the list: it stays empty, no reset to Shell.
        var cleared = back
        cleared.favoriteBrands = []
        store.write(cleared.applied(to: reopened.profile))
        XCTAssertEqual(ProfileSettings(profile: store.load { nil }.profile).favoriteBrands, [])
    }

    func testDamagedFileRecoversAndKeepsACopy() throws {
        let store = ProfileStore(directory: dir)
        var s = ProfileSettings()
        s.favoriteBrands = ["Shell", "Sheetz"]
        store.write(s.applied(to: ProfileRules.defaults()))
        s.speedAlertOver = 9
        store.write(s.applied(to: ProfileRules.defaults()))
        try Data("{\"kind\": \"exitatlas-profile\", \"fuel\": {\"brands\": [\"Sh".utf8).write(to: dir.appendingPathComponent("profile.json"))

        let r = store.load { nil }
        XCTAssertEqual(r.source, .recovered)
        XCTAssertEqual(ProfileSettings(profile: r.profile).favoriteBrands, ["Shell", "Sheetz"])
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertTrue(files.contains { $0.hasPrefix("profile.corrupt-") }, "the unreadable copy is kept")

        // One invalid field: only that field resets.
        var raw = r.profile.object!
        var driving = raw["driving"]!.object!
        driving["theme"] = "neon"
        driving["speedAlertOver"] = 9
        raw["driving"] = .object(driving)
        try JSONValue.object(raw).data().write(to: dir.appendingPathComponent("profile.json"))
        let r2 = store.load { nil }
        XCTAssertEqual(r2.problems, ["driving.theme"])
        let back = ProfileSettings(profile: r2.profile)
        XCTAssertEqual(back.theme, "auto")
        XCTAssertEqual(back.speedAlertOver, 9)
        XCTAssertEqual(back.favoriteBrands, ["Shell", "Sheetz"])
    }

    func testMigrationRunsOnceFromTheOldStorage() throws {
        let v1 = try fixture("ios_v1")
        let store = ProfileStore(directory: dir)
        var calls = 0
        let first = store.load {
            calls += 1
            return ProfileRules.migrateIOSV1(defaults: v1["defaults"]!.object!, places: v1["places"])
        }
        XCTAssertEqual(first.source, .migrated)
        XCTAssertEqual(ProfileSettings(profile: first.profile).favoriteBrands, ["Sheetz", "Shell"])
        _ = store.load { calls += 1; return nil }
        XCTAssertEqual(calls, 1)
    }

    func testDataUpdateAndRollbackLeaveTheProfileAlone() throws {
        // N: data sets live in a sibling folder; installing and removing one never touches the profile.
        let store = ProfileStore(directory: dir.appendingPathComponent("Profile"))
        var s = ProfileSettings()
        s.favoriteBrands = ["Shell"]
        store.write(s.applied(to: ProfileRules.defaults()))
        let before = try Data(contentsOf: store.file)
        let data = dir.appendingPathComponent("Data/current")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: data.appendingPathComponent("manifest.json"))
        try FileManager.default.removeItem(at: dir.appendingPathComponent("Data"))
        XCTAssertEqual(try Data(contentsOf: store.file), before)
        XCTAssertEqual(store.load { nil }.source, .stored)
    }

    func testExportAndImportCarryTheProfileWithoutKeys() throws {
        let full = try fixture("full")
        let data = try ProfileStore.export(full)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("googleKey"))
        XCTAssertEqual(try ProfileStore.importProfile(data).profile, full)
        XCTAssertThrowsError(try ProfileStore.importProfile(Data("{\"kind\": \"x\"}".utf8)))
        // A file exported by the website reads the same.
        XCTAssertEqual(try ProfileStore.importProfile(try full.data()).problems, [])
    }

    func testTolerantListSkipsOnlyTheBadRecord() {
        struct Trip: Codable, Equatable { var title: String; var miles: Double }
        let json = Data(#"[{"title": "A", "miles": 10}, {"title": 5}, {"title": "C", "miles": 30}]"#.utf8)
        let r = TolerantList.decode(Trip.self, from: json)
        XCTAssertEqual(r?.items, [Trip(title: "A", miles: 10), Trip(title: "C", miles: 30)])
        XCTAssertEqual(r?.dropped, 1)
        XCTAssertNil(TolerantList.decode(Trip.self, from: Data("garbage".utf8)))
    }
}
