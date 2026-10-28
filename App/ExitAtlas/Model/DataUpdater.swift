import CryptoKit
import ExitAtlasCore
import Foundation
import Observation

/// Downloads newer offline data from the project's GitHub Pages site (the same files the web version
/// uses). Only files that changed are downloaded; each must match the manifest's size and SHA-256, and
/// the whole set must load before it replaces anything. The set it replaces is kept as "previous", and
/// the data bundled with the app is always there to fall back to (see BundledData.loadBest).
@MainActor
@Observable
final class DataUpdater {
    enum Status: Equatable {
        case idle
        case checking
        case downloading(done: Int, total: Int)
        case upToDate(Date)
        /// Downloaded and checked; in use from the next time the app starts or no trip is active.
        case installed(version: Int64)
        /// The server's data is not for this version of the app, or is older.
        case ignored(String)
        case failed(String)
    }

    enum UpdateError: LocalizedError {
        case http(Int)
        case checksum(String)

        var errorDescription: String? {
            switch self {
            case let .http(code): return "The data server answered \(code)."
            case let .checksum(name): return "\(name) did not match its checksum, so nothing was changed."
            }
        }
    }

    static let remoteBase = URL(string: "https://altecbx.github.io/ExitAtlas/App/ExitAtlas/Resources/Data/")!
    private static let lastCheckKey = "dataLastCheck"

    private(set) var status: Status = .idle
    var lastCheck: Date? { UserDefaults.standard.object(forKey: Self.lastCheckKey) as? Date }

    private var busy: Bool {
        switch status {
        case .checking, .downloading: return true
        default: return false
        }
    }

    /// Automatic check: at most once a day, and not on cellular or in Low Data Mode.
    func checkIfDue(using info: DataSetInfo) async {
        if let last = lastCheck, Date().timeIntervalSince(last) < 86_400 { return }
        await check(using: info, automatic: true)
    }

    func check(using info: DataSetInfo, automatic: Bool = false) async {
        guard !busy else { return }
        status = .checking
        let config = URLSessionConfiguration.default
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.allowsExpensiveNetworkAccess = !automatic
        config.allowsConstrainedNetworkAccess = !automatic
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        do {
            let (data, response) = try await session.data(from: Self.remoteBase.appendingPathComponent("manifest.json"))
            try Self.checkHTTP(response)
            UserDefaults.standard.set(Date(), forKey: Self.lastCheckKey)
            let remote = try DataManifest(data: data)
            guard let current = info.manifest else {
                status = .ignored("the data in use has no manifest")
                return
            }
            switch DataUpdate.decide(current: current, remote: remote) {
            case .upToDate:
                status = .upToDate(Date())
            case let .ignore(reason):
                status = .ignored(reason)
            case let .download(names):
                let version = try await install(remote, manifestData: data, changed: names, from: info, session: session)
                status = .installed(version: version)
            }
        } catch let error as DataManifestError {
            status = .ignored(error.description)
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    /// Builds the new set in a staging folder, checks it, then makes it "current" and keeps the old one.
    private func install(_ remote: DataManifest, manifestData: Data, changed: [String], from info: DataSetInfo,
                         session: URLSession) async throws -> Int64 {
        let fm = FileManager.default
        let staging = DataLocation.installed("staging")
        try? fm.removeItem(at: staging)
        try fm.createDirectory(at: staging, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: staging) }

        // Unchanged files come from the set in use (APFS clones them, so they take no extra space).
        var download = Set(changed)
        for name in remote.files.keys where !download.contains(name) {
            let source = info.directory.appendingPathComponent(name)
            if fm.fileExists(atPath: source.path) {
                try fm.copyItem(at: source, to: staging.appendingPathComponent(name))
            } else {
                download.insert(name)
            }
        }

        let names = download.sorted()
        let total = names.reduce(0) { $0 + (remote.files[$1]?.bytes ?? 0) }
        var done = 0
        status = .downloading(done: 0, total: total)
        for name in names {
            guard let entry = remote.files[name] else { continue }
            var parts = URLComponents(url: Self.remoteBase.appendingPathComponent(name), resolvingAgainstBaseURL: false)!
            parts.queryItems = [URLQueryItem(name: "v", value: String(entry.sha256.prefix(16)))]
            let (temp, response) = try await session.download(from: parts.url!)
            try Self.checkHTTP(response)
            let file = staging.appendingPathComponent(name)
            try fm.moveItem(at: temp, to: file)
            let (bytes, hash) = try await Task.detached(priority: .utility) { try Self.measure(file) }.value
            guard DataUpdate.matches(entry, bytes: bytes, sha256: hash) else { throw UpdateError.checksum(name) }
            done += entry.bytes
            status = .downloading(done: done, total: total)
        }
        try manifestData.write(to: staging.appendingPathComponent("manifest.json"))

        // The whole set must load before it replaces anything.
        _ = try await Task.detached(priority: .utility) { try BundledData.load(directory: staging) }.value

        let current = DataLocation.installed("current"), previous = DataLocation.installed("previous")
        try? fm.removeItem(at: previous)
        if fm.fileExists(atPath: current.path) { try fm.moveItem(at: current, to: previous) }
        try fm.moveItem(at: staging, to: current)
        return remote.version
    }

    /// Size and SHA-256 of a file, read in 1 MB blocks.
    nonisolated private static func measure(_ url: URL) throws -> (Int, String) {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        var bytes = 0
        while let block = try handle.read(upToCount: 1 << 20), !block.isEmpty {
            hasher.update(data: block)
            bytes += block.count
        }
        return (bytes, hasher.finalize().map { String(format: "%02x", $0) }.joined())
    }

    nonisolated private static func checkHTTP(_ response: URLResponse) throws {
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) { throw UpdateError.http(http.statusCode) }
    }

    /// Goes back to the data bundled with the app: removes every downloaded set.
    func removeDownloads() {
        try? FileManager.default.removeItem(at: DataLocation.root)
        UserDefaults.standard.removeObject(forKey: Self.lastCheckKey)
        status = .idle
    }
}
