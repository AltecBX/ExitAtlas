import Foundation

/// manifest.json from tools/data-pipeline/build_manifest.py: the version, size, SHA-256 and provenance
/// of each data file. Same rules as web/js/engine/datamanifest.js.
public struct DataManifest: Codable, Sendable, Equatable {
    public struct File: Codable, Sendable, Equatable {
        public let bytes: Int
        public let sha256: String
        public let required: Bool
        public let role: String?
        public let source: String?
        public let license: String?
        public let generatedAt: String?

        enum CodingKeys: String, CodingKey {
            case bytes, sha256, required, role, source, license
            case generatedAt = "generated_at"
        }
    }

    /// Manifest formats this code can read. A higher schema describes files this version of the app
    /// may not understand, so it is ignored and the data in use stays.
    public static let supportedSchema = 1

    public let kind: String
    public let schema: Int
    /// UTC build time as YYYYMMDDHHMM; never goes down.
    public let version: Int64
    /// SHA-256 over the sorted "name sha256" lines: equal content means the same set of files.
    public let content: String
    public let generatedAt: String
    public let files: [String: File]

    enum CodingKeys: String, CodingKey {
        case kind, schema, version, content, files
        case generatedAt = "generated_at"
    }

    public init(data: Data) throws {
        self = try JSONDecoder().decode(DataManifest.self, from: data)
        try validate()
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url))
    }

    public func validate() throws {
        guard kind == "manifest" else { throw DataManifestError.notAManifest }
        guard schema <= Self.supportedSchema else { throw DataManifestError.schemaTooNew(schema) }
        for (name, f) in files {
            let hex = f.sha256.allSatisfy { $0.isHexDigit && !$0.isUppercase }
            guard f.bytes > 0, f.sha256.count == 64, hex else { throw DataManifestError.incomplete(name) }
        }
    }

    public var requiredFiles: [String] { files.filter { $0.value.required }.map(\.key).sorted() }
}

public enum DataManifestError: Error, Equatable, CustomStringConvertible {
    case notAManifest
    case schemaTooNew(Int)
    case incomplete(String)

    public var description: String {
        switch self {
        case .notAManifest: return "not a data manifest"
        case let .schemaTooNew(s): return "data schema \(s) is newer than this app reads"
        case let .incomplete(name): return "manifest entry for \(name) is incomplete"
        }
    }
}

/// Rules for moving to newer data and for falling back when a set does not load.
public enum DataUpdate {
    public enum Decision: Equatable, Sendable {
        case upToDate
        /// The server's manifest is not usable here; the reason is shown in Settings.
        case ignore(String)
        /// Files that differ from the set in use, by name.
        case download([String])
    }

    /// What to do with the manifest the server publishes, given the set in use.
    public static func decide(current: DataManifest, remote: DataManifest) -> Decision {
        do { try remote.validate() } catch { return .ignore("\(error)") }
        // A stale copy (a cache, a server rollback) never replaces newer data.
        guard remote.version >= current.version else { return .ignore("the server has older data (\(remote.version))") }
        if let missing = current.requiredFiles.first(where: { remote.files[$0] == nil }) {
            return .ignore("the server's data has no \(missing)")
        }
        if remote.content == current.content { return .upToDate }
        let changed = remote.files.filter { current.files[$0.key]?.sha256 != $0.value.sha256 }.map(\.key).sorted()
        return changed.isEmpty ? .upToDate : .download(changed)
    }

    /// True when a downloaded file is the one the manifest describes.
    public static func matches(_ entry: DataManifest.File, bytes: Int, sha256: String) -> Bool {
        entry.bytes == bytes && entry.sha256 == sha256.lowercased()
    }

    /// Data sets to try at launch, in order, ending with the data bundled in the app. A downloaded set
    /// is skipped unless it is newer than the bundled one: an app update ships newer data than an
    /// earlier download.
    public static func launchOrder(bundled: DataManifest, installed: [(id: String, manifest: DataManifest?)]) -> [String] {
        var order: [String] = []
        for set in installed {
            guard let m = set.manifest, (try? m.validate()) != nil, m.version > bundled.version else { continue }
            order.append(set.id)
        }
        return order + ["bundled"]
    }
}
