import ExitAtlasCore
import Foundation

/// The offline datasets (state and time zone boundaries, exits and services, rest areas, Discover
/// places, interstate corridors), from the app bundle or a newer downloaded set (DataUpdater).
/// Everything here works without a network connection.
struct BundledData: Sendable {
    let datasets: TripDatasets
    let corridors: CorridorDataset
    let interstates: InterstateDataset

    enum LoadError: LocalizedError {
        case missing(String)

        var errorDescription: String? {
            switch self {
            case let .missing(name): return "Dataset \(name) is missing."
            }
        }
    }

    /// Loads one complete data set from a folder: the app's own Data folder or a downloaded set.
    static func load(directory: URL) throws -> BundledData {
        func url(_ name: String, _ ext: String) throws -> URL {
            let u = directory.appendingPathComponent("\(name).\(ext)")
            guard FileManager.default.fileExists(atPath: u.path) else { throw LoadError.missing("\(name).\(ext)") }
            return u
        }
        let states = try RegionIndex(contentsOf: try url("states", "eab"))
        let zones = try RegionIndex(contentsOf: try url("timezones", "eab"))
        let interstates = try InterstateDataset(contentsOf: try url("interstates", "eax"))
        let corridors = try CorridorDataset(contentsOf: try url("corridors", "eac"))
        // Optional: without it the timeline has no rest area rows.
        let restAreas = (try? url("restareas", "json")).flatMap { try? RestAreaDataset(contentsOf: $0) }
        let discover = (try? url("discover", "json")).flatMap { try? DiscoverDataset(contentsOf: $0) }
        return BundledData(
            datasets: TripDatasets(states: states, timeZones: TimeZoneResolver(zones: zones), interstates: interstates,
                                   restAreas: restAreas, discover: discover),
            corridors: corridors, interstates: interstates)
    }

    /// Provenance lines for the Data Sources screen, read from each file's header.
    var sourceSummaries: [(title: String, metadata: DatasetMetadata)] {
        [("State boundaries", datasets.states.metadata),
         ("Time zones", datasets.timeZones?.zones.metadata ?? DatasetMetadata(values: [:])),
         ("Exits and services", interstates.metadata),
         ("Interstate corridors", corridors.metadata)]
    }

    /// The rest area file is JSON, so its provenance is shown separately.
    var restAreaSummary: String? {
        guard let m = datasets.restAreas?.metadata else { return nil }
        return "\(m.count) rest areas, welcome centers and service plazas from OpenStreetMap (tags checked \(m.tagsFetched ?? "unknown")). "
            + "Truck parking counts from the FHWA Truck Stop Parking survey (2019, public domain). \(m.license). Amenities show only what mappers have tagged."
    }

    var discoverSummary: String? {
        guard let m = datasets.discover?.metadata else { return nil }
        return "\(m.count) notable places from Wikidata (\(m.license), fetched \(m.fetched ?? "unknown")): parks, museums, monuments and more "
            + "within 5 to 10 miles of an interstate. Hours, fees and closures are not included."
    }
}

/// Where data sets live: the app's own Data folder, and up to two downloaded sets ("current" and
/// "previous") in Application Support.
enum DataLocation {
    static var root: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Data", isDirectory: true)
    }
    static func installed(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
    static var bundled: URL? { Bundle.main.url(forResource: "Data", withExtension: nil) }
    static func directory(for id: String) -> URL? { id == "bundled" ? bundled : installed(id) }
}

/// The data set in use: where it came from, its manifest, and any newer set that failed to load.
struct DataSetInfo: Sendable {
    let id: String
    let directory: URL
    let manifest: DataManifest?
    let failures: [String]

    var isDownloaded: Bool { id != "bundled" }
}

extension BundledData {
    /// Loads the newest data set that works: a downloaded set newer than the app's own data first, then
    /// the one before it, then the data bundled with the app. A downloaded set that fails is deleted.
    static func loadBest() throws -> (data: BundledData, info: DataSetInfo) {
        guard let bundledDir = DataLocation.bundled else { throw LoadError.missing("Data folder") }
        let manifest = { (dir: URL) in try? DataManifest(contentsOf: dir.appendingPathComponent("manifest.json")) }
        let bundledManifest = manifest(bundledDir)
        let installed = ["current", "previous"].map { (id: $0, manifest: manifest(DataLocation.installed($0))) }
        let order = bundledManifest.map { DataUpdate.launchOrder(bundled: $0, installed: installed) } ?? ["bundled"]
        var failures: [String] = []
        for id in order {
            guard let dir = DataLocation.directory(for: id) else { continue }
            do {
                let data = try load(directory: dir)
                return (data, DataSetInfo(id: id, directory: dir, manifest: manifest(dir), failures: failures))
            } catch {
                if id == "bundled" { throw error }
                failures.append("Downloaded data \(manifest(dir).map { String($0.version) } ?? id) did not load: \(error.localizedDescription)")
                try? FileManager.default.removeItem(at: dir)
            }
        }
        throw LoadError.missing("Data folder")
    }
}
