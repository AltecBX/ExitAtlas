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

extension SavedTrip {
    /// The trip as a plan in a profile file (places only).
    var plan: SavedPlan { SavedPlan(name: name, from: origin, stops: stops, to: destination) }

    init(plan: SavedPlan) {
        self.init(name: plan.name, origin: plan.from, stops: plan.stops, destination: plan.to)
    }
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
    /// Records in history.json or saved.json that no longer read (kept in a .corrupt copy, not deleted).
    private(set) var unreadableRecords = 0
    /// Home and recent places live in the driver's profile (UserSettings); set by AppModel.
    @ObservationIgnored weak var settings: UserSettings?

    private let folder: URL

    init(demo: Bool = ProcessInfo.processInfo.arguments.contains("-demoTrip")) {
        let fm = FileManager.default
        // Demos and UI tests never read or write the driver's trips.
        folder = demo ? fm.temporaryDirectory.appendingPathComponent("DemoTrips-\(UUID().uuidString)")
            : fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Trips", isDirectory: true)
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        saved = loadList("saved.json")
        history = loadList("history.json")
        paceHistory = load("pace_history.json") ?? PaceHistory()
    }

    /// Home and the last 10 places used, offered first when choosing a start, stop or destination.
    var home: Waypoint? { settings?.home }
    var recentPlaces: [Waypoint] { settings?.recentPlaces ?? [] }

    func setHome(_ place: Waypoint?) { settings?.home = place }
    func recordPlace(_ place: Waypoint) { settings?.recordPlace(place) }
    func clearRecentPlaces() { settings?.recentPlaces = [] }

    func recordPace(key: String, pace: PaceModel) {
        paceHistory.record(key: key, pace: pace)
        write(paceHistory, "pace_history.json")
    }

    func save(_ trip: SavedTrip) {
        saved.removeAll { $0.id == trip.id }
        saved.insert(trip, at: 0)
        write(saved, "saved.json")
    }

    /// Adds plans from an imported profile file, skipping ones already saved.
    func importPlans(_ plans: [SavedPlan]) {
        let new = plans.filter { p in !saved.contains { $0.plan == p } }.map(SavedTrip.init(plan:))
        guard !new.isEmpty else { return }
        saved = new + saved
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

    /// A list file read record by record. A record that no longer reads is skipped, and the file as it
    /// was is copied aside first, so the next save cannot erase anything for good.
    private func loadList<T: Decodable>(_ name: String) -> [T] {
        let url = folder.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { return [] }
        let result = TolerantList.decode(T.self, from: data)
        if result == nil || result!.dropped > 0 {
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            try? data.write(to: folder.appendingPathComponent("\(name).corrupt-\(stamp)"), options: .atomic)
            unreadableRecords += result?.dropped ?? 1
        }
        return result?.items ?? []
    }

    private func write<T: Encodable>(_ value: T, _ name: String) {
        // Readable while the phone is locked, so background trip tracking can save history.
        let url = folder.appendingPathComponent(name)
        if let data = try? JSONEncoder().encode(value) {
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }
}
