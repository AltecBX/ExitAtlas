import Foundation
import ExitAtlasCore

/// Shared gas price reports from other ExitAtlas drivers, through the owner's free server (infra/worker,
/// docs/17), the same reports the website reads. Off unless a server is set in Settings and it offers them,
/// and the driver turned them on. A failed lookup is "unavailable", never "no prices".
@MainActor
final class SharedPriceService {
    static let source = GasPrices.Source(id: "community", name: "ExitAtlas drivers", kind: .community)
    /// Asked again after this long per station, and after a failure not before this.
    private static let ttl: TimeInterval = 90
    private static let retry: TimeInterval = 120

    enum State: Equatable { case off, ok, unavailable(String) }

    private(set) var base: URL?
    /// The server answered and offers shared reports.
    private(set) var offered = false
    private(set) var lastError: (at: Date, message: String)?
    private var configuredFor: String?
    private var cache: [String: (at: Date, records: [GasPrices.Record])] = [:]
    private var pending = Set<String>()
    var onUpdate: (() -> Void)?

    /// The server's base URL from what was typed: HTTPS only (localhost allowed for testing).
    static func base(_ text: String) -> URL? {
        guard var c = URLComponents(string: text.trimmingCharacters(in: .whitespaces)), let host = c.host, !host.isEmpty else { return nil }
        let local = host == "localhost" || host == "127.0.0.1"
        guard c.scheme == "https" || (local && c.scheme == "http") else { return nil }
        if !c.path.hasSuffix("/") { c.path += "/" }
        c.query = nil
        c.fragment = nil
        return c.url
    }

    func state(enabled: Bool) -> State {
        guard enabled, offered, base != nil else { return .off }
        if let e = lastError, Date().timeIntervalSince(e.at) < Self.ttl { return .unavailable(e.message) }
        return .ok
    }

    /// Reads the server's switches (/v1/config) when its URL changes.
    func configure(_ text: String) {
        guard text != configuredFor else { return }
        configuredFor = text
        base = Self.base(text)
        offered = false
        cache = [:]
        lastError = nil
        onUpdate?()
        guard let base else { return }
        Task { @MainActor in
            guard let (data, status) = try? await self.send(URLRequest(url: base.appendingPathComponent("v1/config"))), status == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            guard self.base == base else { return }
            self.offered = json["community"] as? Bool == true
            self.onUpdate?()
        }
    }

    /// Shared reports at a station (empty until loaded).
    func records(_ stationID: String) -> [GasPrices.Record] { cache[stationID]?.records ?? [] }

    /// Every shared report loaded, by station id.
    var all: [String: [GasPrices.Record]] { cache.mapValues(\.records) }

    /// Asks the server for the stations not asked within the last 90 seconds (at most 50 per request).
    func load(_ stationIDs: [String], enabled: Bool) {
        guard enabled, offered, let base else { return }
        let now = Date()
        if let e = lastError, now.timeIntervalSince(e.at) < Self.retry { return }
        var seen = Set<String>()
        let due = stationIDs.filter { id in
            seen.insert(id).inserted && !pending.contains(id) && !(cache[id].map { now.timeIntervalSince($0.at) < Self.ttl } ?? false)
        }
        guard !due.isEmpty else { return }
        for start in stride(from: 0, to: due.count, by: 50) {
            let ids = Array(due[start..<min(start + 50, due.count)])
            ids.forEach { pending.insert($0) }
            var c = URLComponents(url: base.appendingPathComponent("v1/price-reports"), resolvingAgainstBaseURL: false)!
            c.queryItems = [URLQueryItem(name: "stations", value: ids.joined(separator: ","))]
            let request = URLRequest(url: c.url!)
            Task { @MainActor in
                defer { ids.forEach { self.pending.remove($0) } }
                do {
                    let (data, status) = try await self.send(request)
                    guard status == 200, let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let reports = json["reports"] as? [[String: Any]] else { throw FeedError(Self.message(data, status)) }
                    var by = Dictionary(uniqueKeysWithValues: ids.map { ($0, [GasPrices.Record]()) })
                    let now = Date()
                    for r in reports {
                        guard let id = r["id"] as? String, let station = r["stationId"] as? String, by[station] != nil,
                              let grade = r["grade"] as? String, let price = r["price"] as? Double, let at = r["reportedAt"] as? Double else { continue }
                        let record = GasPrices.Record(id: id, stationId: station, grade: grade, price: price,
                                                      payment: (r["payment"] as? String).flatMap(GasPrices.Payment.init(rawValue:)),
                                                      member: r["member"] as? Bool ?? false, reportedAt: Date(timeIntervalSince1970: at),
                                                      reporter: r["reporter"] as? String, source: Self.source)
                        if let ok = GasPrices.validate(record, now: now).record { by[station]?.append(ok) }
                    }
                    for (id, records) in by { self.cache[id] = (now, records) }
                    self.lastError = nil
                } catch {
                    self.lastError = (Date(), (error as? FeedError)?.message ?? error.localizedDescription)
                }
                self.onUpdate?()
            }
        }
    }

    /// Sends one report (the location check passed on the phone; the position is never sent).
    /// Returns the server's id for it, or why it was not sent.
    func share(_ r: GasPrices.Record, install: String) async -> Result<String, FeedError> {
        guard let base else { return .failure(FeedError("no server set")) }
        var request = URLRequest(url: base.appendingPathComponent("v1/price-reports"))
        request.httpMethod = "POST"
        var body: [String: Any] = ["stationId": r.stationId, "grade": r.grade, "price": r.price, "member": r.member, "install": install, "near": true]
        body["payment"] = r.payment?.rawValue ?? NSNull()
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, status) = try await send(request)
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            guard status == 200, json?["ok"] as? Bool == true else { return .failure(FeedError(Self.message(data, status))) }
            cache[r.stationId] = nil
            onUpdate?()
            return .success(json?["id"] as? String ?? "")
        } catch {
            return .failure(FeedError(error.localizedDescription))
        }
    }

    private func send(_ request: URLRequest) async throws -> (Data, Int) {
        var request = request
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The app is not a web page: it names itself instead of sending an Origin (infra/worker).
        request.setValue("ios/1", forHTTPHeaderField: "X-ExitAtlas-Client")
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    private static func message(_ data: Data, _ status: Int) -> String {
        ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? "the server answered \(status)"
    }
}
