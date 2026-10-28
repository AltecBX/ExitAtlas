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

/// The trip in progress, saved so it can be resumed if iOS terminates the app.
/// Holds only the user's waypoints and driving history, never route geometry.
struct ActiveTripRecord: Codable {
    var origin: Waypoint
    var remainingWaypoints: [Waypoint]
    var ledger: TripLedger
    var pace: PaceModel
    var startedAt: Date
    var savedAt: Date

    var destination: Waypoint? { remainingWaypoints.last }
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
    /// Moving pace on earlier device trips against MapKit travel times (prior for new trips).
    private(set) var paceHistory = PaceHistory()

    private var folder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Trips", isDirectory: true)
    }

    init() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        saved = load("saved.json") ?? []
        history = load("history.json") ?? []
        paceHistory = load("pace_history.json") ?? PaceHistory()
        if let places: Places = load("places.json") {
            home = places.home
            recentPlaces = places.recent
        }
    }

    /// Home and the last 10 places used, offered first when choosing a start, stop or destination.
    private(set) var home: Waypoint?
    private(set) var recentPlaces: [Waypoint] = []

    private struct Places: Codable {
        var home: Waypoint?
        var recent: [Waypoint]
    }

    func setHome(_ place: Waypoint?) {
        home = place
        writePlaces()
    }

    func recordPlace(_ place: Waypoint) {
        guard place.name != "Current location" else { return }
        recentPlaces.removeAll { $0 == place || ($0.name == place.name && Geodesy.distance($0.coordinate, place.coordinate) < 100) }
        recentPlaces.insert(place, at: 0)
        if recentPlaces.count > 10 { recentPlaces.removeLast(recentPlaces.count - 10) }
        writePlaces()
    }

    func clearRecentPlaces() {
        recentPlaces = []
        writePlaces()
    }

    private func writePlaces() {
        write(Places(home: home, recent: recentPlaces), "places.json")
    }

    func recordPace(key: String, pace: PaceModel) {
        paceHistory.record(key: key, pace: pace)
        write(paceHistory, "pace_history.json")
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

    func saveActive(_ record: ActiveTripRecord) {
        write(record, "active.json")
    }

    /// A saved active trip younger than 18 hours, if any.
    func loadActive(now: Date = Date()) -> ActiveTripRecord? {
        guard let record: ActiveTripRecord = load("active.json"), now.timeIntervalSince(record.savedAt) < 18 * 3600,
              record.destination != nil else { return nil }
        return record
    }

    func clearActive() {
        try? FileManager.default.removeItem(at: folder.appendingPathComponent("active.json"))
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
