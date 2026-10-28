import ExitAtlasCore
import Foundation

/// Posted speed limits for the current route: fetches the next missing chunk ahead of the driver from
/// the public Valhalla server (OpenStreetMap `maxspeed`), with backoff after failures.
@MainActor
final class SpeedLimitService {
    private(set) var table: SpeedLimitTable?
    private var routeID: UUID?
    private var polyline: RoutePolyline?
    private var inFlight = false
    private var retryAt = Date.distantPast
    private var failures = 0
    var onUpdate: (() -> Void)?

    func reset(for plan: TripPlan?) {
        guard plan?.route.id != routeID else { return }
        routeID = plan?.route.id
        table = plan.map { SpeedLimitTable(routeLength: $0.route.length) }
        polyline = plan?.route.polyline
        inFlight = false
        failures = 0
        retryAt = .distantPast
    }

    func ensureAhead(of progress: Double) {
        guard !inFlight, Date() >= retryAt, let table, let polyline, let id = routeID,
              let chunk = table.missingChunk(ahead: progress) else { return }
        inFlight = true
        var request = URLRequest(url: SpeedLimitTable.endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ExitAtlas iOS", forHTTPHeaderField: "X-Client-Id")
        request.httpBody = table.requestBody(for: chunk, polyline: polyline)
        request.timeoutInterval = 40
        Task { @MainActor in
            defer { self.inFlight = false }
            var result = SpeedLimitTable.ApplyResult.failed("offline")
            if let reply = try? await URLSession.shared.data(for: request), self.routeID == id {
                let status = (reply.1 as? HTTPURLResponse)?.statusCode ?? 0
                result = self.table?.apply(response: reply.0, httpStatus: status, for: chunk) ?? result
            }
            guard self.routeID == id else { return }
            if case .failed = result {
                self.failures += 1
                self.retryAt = Date().addingTimeInterval(min(300, 15 * pow(2, Double(self.failures - 1))))
            } else {
                self.failures = 0
                self.onUpdate?()
            }
        }
    }
}

/// DC fast chargers along the route (DOE AFDC), one request per route.
@MainActor
final class ChargerService {
    private(set) var projected: [ChargerOnRoute] = []
    private(set) var error: String?
    private(set) var isLoading = false
    private var key: String?
    private var retryAt = Date.distantPast
    var onUpdate: (() -> Void)?

    func ensure(for plan: TripPlan, teslaOnly: Bool, apiKey: String) {
        let key = "\(plan.route.id)|\(teslaOnly)"
        guard key != self.key || (error != nil && Date() >= retryAt), !isLoading else { return }
        if key != self.key { projected = [] }
        self.key = key
        isLoading = true
        error = nil
        var components = URLComponents(url: ChargerFeed.endpoint, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "api_key", value: apiKey.isEmpty ? ChargerFeed.demoKey : apiKey)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(ChargerFeed.requestBody(plan.route.polyline, teslaOnly: teslaOnly).utf8)
        request.timeoutInterval = 60
        let polyline = plan.route.polyline
        Task { @MainActor in
            defer { self.isLoading = false }
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 429 { throw FeedError("charger lookups are rate limited on the demo key; add a free NREL key in Settings") }
                guard (200..<300).contains(status) else { throw FeedError("HTTP \(status)") }
                let stations = try ChargerFeed.parse(data)
                guard self.key == key else { return }
                self.projected = RangePlanner.projectChargers(polyline, stations: stations)
            } catch {
                guard self.key == key else { return }
                self.error = (error as? FeedError)?.message ?? error.localizedDescription
                self.retryAt = Date().addingTimeInterval(120)
            }
            self.onUpdate?()
        }
    }
}

/// Gas prices near an exit from Google Places with the driver's own key. Kept in memory for 15
/// minutes only (Google's terms do not allow storing them).
@MainActor
final class GasPriceService {
    struct Entry {
        let loadedAt: Date
        let stations: [GasPriceFeed.Station]
        let error: String?
    }

    private var cache: [String: Entry] = [:]
    private var loading = Set<String>()
    var onUpdate: (() -> Void)?
    /// Called once per request to Google, for the monthly counter in Settings.
    var onCall: (() -> Void)?

    func entry(for exitID: String) -> Entry? { cache[exitID] }

    func load(exit: RouteExit, apiKey: String) {
        guard !apiKey.isEmpty, !loading.contains(exit.id) else { return }
        if let e = cache[exit.id], Date().timeIntervalSince(e.loadedAt) < 15 * 60 { return }
        loading.insert(exit.id)
        onCall?()
        var request = URLRequest(url: GasPriceFeed.endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "X-Goog-Api-Key")
        request.setValue(GasPriceFeed.fieldMask, forHTTPHeaderField: "X-Goog-FieldMask")
        if let bundle = Bundle.main.bundleIdentifier { request.setValue(bundle, forHTTPHeaderField: "X-Ios-Bundle-Identifier") }
        request.httpBody = GasPriceFeed.requestBody(near: exit.coordinate)
        request.timeoutInterval = 30
        Task { @MainActor in
            defer { self.loading.remove(exit.id) }
            var entry: Entry
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(status) else {
                    let message = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])
                        .flatMap { ($0["error"] as? [String: Any])?["message"] as? String }
                    throw FeedError(message ?? "HTTP \(status)")
                }
                entry = Entry(loadedAt: Date(), stations: try GasPriceFeed.parse(data), error: nil)
            } catch {
                entry = Entry(loadedAt: Date(), stations: [], error: (error as? FeedError)?.message ?? error.localizedDescription)
            }
            self.cache[exit.id] = entry
            self.onUpdate?()
        }
    }
}

struct FeedError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

/// Google Places lookups this month (shown in Settings so the driver can watch the free allowance).
enum PriceCallCounter {
    private static var monthKey: String {
        let c = Calendar(identifier: .gregorian).dateComponents([.year, .month], from: Date())
        return "priceCalls.\(c.year ?? 0)-\(c.month ?? 0)"
    }

    static var thisMonth: Int { UserDefaults.standard.integer(forKey: monthKey) }

    static func count() {
        UserDefaults.standard.set(thisMonth + 1, forKey: monthKey)
    }
}
