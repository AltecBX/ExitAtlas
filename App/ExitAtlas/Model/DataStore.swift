import ExitAtlasCore
import Foundation

/// Loads the bundled offline datasets (state and time zone boundaries, exits and services,
/// interstate corridors). Everything here works without a network connection.
struct BundledData: Sendable {
    let datasets: TripDatasets
    let corridors: CorridorDataset
    let interstates: InterstateDataset

    enum LoadError: LocalizedError {
        case missing(String)

        var errorDescription: String? {
            switch self {
            case let .missing(name): return "Bundled dataset \(name) is missing from the app."
            }
        }
    }

    static func load(from bundle: Bundle = .main) throws -> BundledData {
        func url(_ name: String, _ ext: String) throws -> URL {
            if let u = bundle.url(forResource: name, withExtension: ext, subdirectory: "Data") { return u }
            if let u = bundle.url(forResource: name, withExtension: ext) { return u }
            throw LoadError.missing("\(name).\(ext)")
        }
        let states = try RegionIndex(contentsOf: try url("states", "eab"))
        let zones = try RegionIndex(contentsOf: try url("timezones", "eab"))
        let interstates = try InterstateDataset(contentsOf: try url("interstates", "eax"))
        let corridors = try CorridorDataset(contentsOf: try url("corridors", "eac"))
        return BundledData(
            datasets: TripDatasets(states: states, timeZones: TimeZoneResolver(zones: zones), interstates: interstates),
            corridors: corridors, interstates: interstates)
    }

    /// Provenance lines for the Data Sources screen, read from each file's header.
    var sourceSummaries: [(title: String, metadata: DatasetMetadata)] {
        [("State boundaries", datasets.states.metadata),
         ("Time zones", datasets.timeZones?.zones.metadata ?? DatasetMetadata(values: [:])),
         ("Exits and services", interstates.metadata),
         ("Interstate corridors", corridors.metadata)]
    }
}
