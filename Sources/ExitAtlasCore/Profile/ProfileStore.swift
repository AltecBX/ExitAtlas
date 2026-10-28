import Foundation

/// Keeps the driver's profile in a folder (Application Support/Profile on iOS):
///
///   profile.json            the profile, written atomically on every change
///   profile.previous.json   the copy before the last change, used if profile.json is ever unreadable
///   profile.corrupt-<time>.json   an unreadable or partly invalid copy, kept as it was
///
/// Same rules as web/js/app/profilestore.js. Trip files, datasets and API keys live elsewhere.
public struct ProfileStore: Sendable {
    public enum Source: String, Sendable { case stored, recovered, migrated, new }

    public struct Loaded: Sendable {
        public let profile: JSONValue
        /// Fields that could not be read and now hold their defaults ("profile" when nothing could).
        public let problems: [String]
        public let source: Source
        /// Set when a write during loading failed.
        public let writeError: String?
    }

    public let directory: URL
    public init(directory: URL) { self.directory = directory }

    var file: URL { directory.appendingPathComponent("profile.json") }
    var previous: URL { directory.appendingPathComponent("profile.previous.json") }

    /// Loads the profile. `migrate` builds one from older storage when there is no profile yet (return nil
    /// when there is nothing to migrate). A good profile is never rewritten at launch.
    public func load(now: Date = Date(), migrate: () -> JSONValue?) -> Loaded {
        let fm = FileManager.default
        if let data = fm.contents(atPath: file.path) {
            if let raw = try? JSONValue(data: data), raw.object != nil {
                let (profile, problems) = ProfileRules.normalize(raw)
                guard !problems.isEmpty else { return Loaded(profile: profile, problems: [], source: .stored, writeError: nil) }
                keepCorrupt(data, now: now)
                return Loaded(profile: profile, problems: problems, source: .stored, writeError: write(profile, keepPrevious: false, now: now))
            }
            keepCorrupt(data, now: now)
            if let prev = fm.contents(atPath: previous.path), let raw = try? JSONValue(data: prev), raw.object != nil {
                let (profile, problems) = ProfileRules.normalize(raw)
                return Loaded(profile: profile, problems: ["profile"] + problems, source: .recovered,
                              writeError: write(profile, keepPrevious: false, now: now))
            }
        }
        let damaged = fm.fileExists(atPath: file.path)
        if let migrated = migrate() {
            let profile = ProfileRules.normalize(migrated).profile
            return Loaded(profile: profile, problems: damaged ? ["profile"] : [], source: .migrated,
                          writeError: write(profile, keepPrevious: false, now: now))
        }
        return Loaded(profile: ProfileRules.defaults(), problems: damaged ? ["profile"] : [], source: .new, writeError: nil)
    }

    /// Writes the profile (and keeps the current file as the previous copy). Returns an error message, or
    /// nil when the file was written and reads back the same.
    @discardableResult
    public func write(_ profile: JSONValue, keepPrevious: Bool = true, now: Date = Date()) -> String? {
        var p = profile.object ?? [:]
        p["updatedAt"] = .string(ISO8601DateFormatter().string(from: now))
        do {
            let fm = FileManager.default
            try fm.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONValue.object(p).data(pretty: true)
            if keepPrevious, let current = fm.contents(atPath: file.path) {
                try current.write(to: previous, options: .atomic)
            }
            try data.write(to: file, options: .atomic)
            guard fm.contents(atPath: file.path) == data else { return "the file did not read back the same" }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func keepCorrupt(_ data: Data, now: Date) {
        let stamp = ISO8601DateFormatter().string(from: now).replacingOccurrences(of: ":", with: "-")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: directory.appendingPathComponent("profile.corrupt-\(stamp).json"), options: .atomic)
    }

    /// The profile file, as an export (the same format as the website's export; no API keys).
    public static func export(_ profile: JSONValue, now: Date = Date()) throws -> Data {
        var p = profile.object ?? [:]
        p["exportedAt"] = .string(ISO8601DateFormatter().string(from: now))
        return try JSONValue.object(p).data(pretty: true)
    }

    public enum ImportError: LocalizedError {
        case notJSON, notAProfile
        public var errorDescription: String? {
            switch self {
            case .notJSON: return "This file is not a profile (not JSON)."
            case .notAProfile: return "This file is not an ExitAtlas profile."
            }
        }
    }

    /// Reads an exported profile (from this app or the website).
    public static func importProfile(_ data: Data) throws -> (profile: JSONValue, problems: [String]) {
        guard let raw = try? JSONValue(data: data) else { throw ImportError.notJSON }
        guard var o = raw.object, o["kind"]?.string == "exitatlas-profile" else { throw ImportError.notAProfile }
        o["exportedAt"] = nil
        return ProfileRules.normalize(.object(o))
    }
}

/// Reads a JSON list record by record: entries that no longer decode are skipped and counted instead of
/// losing the whole list (trip history, saved trips).
public enum TolerantList {
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) -> (items: [T], dropped: Int)? {
        guard let raw = try? JSONValue(data: data), let list = raw.array else { return nil }
        var items: [T] = []
        var dropped = 0
        for entry in list {
            if let d = try? entry.data(), let item = try? JSONDecoder().decode(T.self, from: d) {
                items.append(item)
            } else {
                dropped += 1
            }
        }
        return (items, dropped)
    }
}
