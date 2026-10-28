import XCTest
@testable import ExitAtlasCore

/// Data updates and rollback (the same rules as web/tests/datamanifest.test.js).
final class DataManifestTests: XCTestCase {
    let bundled = try! DataManifest(contentsOf: Fixtures.dataDirectory.appendingPathComponent("manifest.json"))

    /// A manifest like the bundled one, with a later version and some files changed.
    func update(version: Int64? = nil, schema: Int = 1, changing names: [String] = [], dropping dropped: [String] = []) throws -> DataManifest {
        var json = try JSONSerialization.jsonObject(with: Data(contentsOf: Fixtures.dataDirectory.appendingPathComponent("manifest.json"))) as! [String: Any]
        var files = json["files"] as! [String: [String: Any]]
        for name in names { files[name]!["sha256"] = String(repeating: "a", count: 64) }
        for name in dropped { files[name] = nil }
        json["files"] = files
        json["schema"] = schema
        json["version"] = version ?? bundled.version + 1
        if !names.isEmpty || !dropped.isEmpty { json["content"] = String(repeating: "b", count: 64) }
        let m = try JSONDecoder().decode(DataManifest.self, from: JSONSerialization.data(withJSONObject: json))
        return m
    }

    func testBundledManifestListsEveryFile() throws {
        XCTAssertEqual(bundled.schema, DataManifest.supportedSchema)
        XCTAssertEqual(bundled.requiredFiles, ["corridors.eac", "interstates.eax", "states.eab", "timezones.eab"])
        for (name, entry) in bundled.files {
            let size = try FileManager.default.attributesOfItem(atPath: Fixtures.dataDirectory.appendingPathComponent(name).path)[.size] as? Int
            XCTAssertEqual(size, entry.bytes, "\(name): rerun build_manifest.py after changing data")
            XCTAssertNotNil(entry.source, name)
        }
    }

    func testDecisions() throws {
        XCTAssertEqual(DataUpdate.decide(current: bundled, remote: bundled), .upToDate)
        XCTAssertEqual(DataUpdate.decide(current: bundled, remote: try update(changing: ["restareas.json", "discover.json"])),
                       .download(["discover.json", "restareas.json"]))
        // Older data on the server (a stale cache or a rollback there) never replaces what works here.
        guard case .ignore = DataUpdate.decide(current: bundled, remote: try update(version: bundled.version - 1, changing: ["discover.json"])) else {
            return XCTFail("older data must be ignored")
        }
        // A format this app cannot read, or a set without a required file.
        guard case .ignore = DataUpdate.decide(current: bundled, remote: try update(schema: 2, changing: ["states.eab"])),
              case .ignore = DataUpdate.decide(current: bundled, remote: try update(dropping: ["interstates.eax"])) else {
            return XCTFail("unusable data must be ignored")
        }
        // Optional files may come and go.
        XCTAssertEqual(DataUpdate.decide(current: bundled, remote: try update(dropping: ["discover.json"])), .upToDate)
    }

    func testDownloadsAreCheckedAgainstTheManifest() {
        let entry = bundled.files["states.eab"]!
        XCTAssertTrue(DataUpdate.matches(entry, bytes: entry.bytes, sha256: entry.sha256.uppercased()))
        XCTAssertFalse(DataUpdate.matches(entry, bytes: entry.bytes - 1, sha256: entry.sha256))
        XCTAssertFalse(DataUpdate.matches(entry, bytes: entry.bytes, sha256: String(repeating: "0", count: 64)))
    }

    func testLaunchOrderFallsBackToPreviousThenBundled() throws {
        let newer = try update(changing: ["discover.json"]), newest = try update(version: bundled.version + 2, changing: ["restareas.json"])
        XCTAssertEqual(DataUpdate.launchOrder(bundled: bundled, installed: [("current", newest), ("previous", newer)]),
                       ["current", "previous", "bundled"])
        // After an app update the bundled data is newer than both downloads: use it.
        let appUpdate = try update(version: bundled.version + 5, changing: ["states.eab"])
        XCTAssertEqual(DataUpdate.launchOrder(bundled: appUpdate, installed: [("current", newest), ("previous", newer)]), ["bundled"])
        // A missing or unreadable manifest takes that set out.
        XCTAssertEqual(DataUpdate.launchOrder(bundled: bundled, installed: [("current", nil), ("previous", newer)]), ["previous", "bundled"])
        XCTAssertEqual(DataUpdate.launchOrder(bundled: bundled, installed: [("current", try update(schema: 9))]), ["bundled"])
    }
}
