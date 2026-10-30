import Foundation
import ExitAtlasCore

/// The driver's own gas price reports, kept on this iPhone (docs/17): they work without any server or
/// account, and hold only the station, grade, price, payment kind and time, never a position. SIMULATED
/// demo prices (-demoPrices) are kept in memory only and labeled wherever they show.
@MainActor
final class PriceReportStore {
    static let ownSource = GasPrices.Source(id: "own", name: "You", kind: .own)
    static let simulatedSource = GasPrices.Source(id: "simulated", name: "Simulated test data", kind: .simulated)

    private let file: URL
    private let sentFile: URL
    private var saved: [GasPrices.Record] = []
    /// Own report id to the id the shared server gave it, so the shared copy is not counted twice.
    private var sent: [String: String] = [:]
    /// SIMULATED records for the demo (never written to the file).
    var simulated: [GasPrices.Record] = [] { didSet { changed() } }
    /// Changes whenever the reports change (cache keys in TripController).
    private(set) var version = 0
    var onUpdate: (() -> Void)?

    init(demo: Bool = ProcessInfo.processInfo.arguments.contains("-demoTrip")) {
        let fm = FileManager.default
        let base = demo ? fm.temporaryDirectory.appendingPathComponent("DemoPrices-\(UUID().uuidString)")
                        : fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PriceReports", isDirectory: true)
        file = base.appendingPathComponent("reports.json")
        sentFile = base.appendingPathComponent("shared.json")
        if let data = try? Data(contentsOf: file), let list = try? JSONDecoder().decode([GasPrices.Record].self, from: data) { saved = list }
        if let data = try? Data(contentsOf: sentFile), let map = try? JSONDecoder().decode([String: String].self, from: data) { sent = map }
    }

    /// The driver's own reports, expired or damaged ones dropped.
    func own(now: Date = Date()) -> [GasPrices.Record] {
        saved.filter { GasPrices.validate($0, now: now).record != nil }
    }

    /// Reports by station id: the driver's own (when used) and the simulated demo ones.
    func records(includeOwn: Bool, now: Date = Date()) -> [String: [GasPrices.Record]] {
        Dictionary(grouping: (includeOwn ? own(now: now) : []) + simulated, by: \.stationId)
    }

    struct Outcome {
        var saved: Bool
        var duplicate = false
        var problems: [String] = []
        var record: GasPrices.Record?
    }

    /// Ids the shared server gave this device's own reports.
    var sharedIDs: Set<String> { Set(sent.values) }

    func markShared(_ ownID: String, as serverID: String) {
        sent[ownID] = serverID
        try? JSONEncoder().encode(sent).write(to: sentFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        changed()
    }

    /// A random id for this install, made the first time a report is shared. The server keeps only a hash.
    var installID: String {
        let key = "priceInstallID"
        if let id = UserDefaults.standard.string(forKey: key), id.count >= 16 { return id }
        let id = (0..<12).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    /// Saves a report: checked like every report (grade, a price from $1.50 to $9.99, the regional average
    /// when known), a repeat within 30 minutes is the same report, a new price within 30 minutes corrects it.
    func report(stationId: String, grade: String, price: Double, payment: GasPrices.Payment?, member: Bool,
                now: Date = Date(), benchmark: Double? = nil) -> Outcome {
        let id = "own-\(Int(now.timeIntervalSince1970))-\(UUID().uuidString.prefix(6))"
        let r = GasPrices.Record(id: id, stationId: stationId, grade: grade, price: price, payment: payment, member: member,
                                 reportedAt: now, reporter: "me", source: Self.ownSource)
        let check = GasPrices.validate(r, now: now, benchmark: benchmark)
        guard let record = check.record else { return Outcome(saved: false, problems: check.problems) }
        let list = GasPrices.add(record, to: own(now: now), now: now)
        guard list.contains(where: { $0.id == record.id }) else { return Outcome(saved: false, duplicate: true) }
        guard write(list) else { return Outcome(saved: false, problems: ["storage"]) }
        return Outcome(saved: true, record: record)
    }

    func remove(id: String) {
        _ = write(own().filter { $0.id != id })
    }

    private func write(_ list: [GasPrices.Record]) -> Bool {
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(list).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            saved = list
            changed()
            return true
        } catch {
            return false
        }
    }

    private func changed() {
        version += 1
        onUpdate?()
    }
}
