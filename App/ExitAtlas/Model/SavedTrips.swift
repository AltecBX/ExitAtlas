import ExitAtlasCore
import Foundation
import Observation

/// A saved trip keeps only the places the user chose. Route geometry is recomputed when the
/// trip starts: Apple's terms allow only temporary caching of MapKit route data.
struct SavedTrip: Codable, Identifiable, Hashable {
    var id = UUID()
    var name: String
    var origin: Waypoint?  // nil means current location
    var stops: [Waypoint]
    var destination: Waypoint
    var savedAt = Date()
}

/// A finished trip: actual miles per state from the trip ledger.
struct TripRecord: Codable, Identifiable, Hashable {
    struct StateMiles: Codable, Hashable {
        var code: String?
        var name: String
        var meters: Double
    }

    var id = UUID()
    var title: String
    var startedAt: Date
    var endedAt: Date
    var states: [StateMiles]
    var totalMeters: Double
}

@MainActor
@Observable
final class TripLibrary {
    private(set) var saved: [SavedTrip] = []
    private(set) var history: [TripRecord] = []

    private var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Trips", isDirectory: true)
    }

    init() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        saved = load("saved.json") ?? []
        history = load("history.json") ?? []
    }

    func save(_ trip: SavedTrip) {
        saved.removeAll { $0.id == trip.id }
        saved.insert(trip, at: 0)
        write(saved, "saved.json")
    }

    func delete(_ trip: SavedTrip) {
        saved.removeAll { $0.id == trip.id }
        write(saved, "saved.json")
    }

    func record(_ record: TripRecord) {
        history.insert(record, at: 0)
        write(history, "history.json")
    }

    var lifetimeMeters: Double { history.reduce(0) { $0 + $1.totalMeters } }

    var lifetimeStates: [String] {
        var seen: [String] = []
        for r in history { for s in r.states { if let c = s.code, !seen.contains(c) { seen.append(c) } } }
        return seen.sorted()
    }

    private func load<T: Decodable>(_ name: String) -> T? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(name)) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private func write<T: Encodable>(_ value: T, _ name: String) {
        // Readable while the phone is locked, so background trip tracking can save history.
        let url = folder.appendingPathComponent(name)
        if let data = try? JSONEncoder().encode(value) {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}
