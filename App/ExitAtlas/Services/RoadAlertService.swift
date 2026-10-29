import ExitAtlasCore
import Foundation

/// Road alert sources for the active trip, fetched politely: only while a trip runs, every few minutes or
/// after a long move, with backoff after errors. Each source keeps its own state, so a failure shows as
/// "data unavailable", never as "no alerts". The engine (RoadIntel) does the matching. Same plan as
/// web/js/app/roadalerts.js, except that every work zone feed is read directly (no browser CORS limits here).
@MainActor
final class RoadAlertService {
    /// National Weather Service: points every 25 miles over the next 150, every 10 minutes or after 20 miles.
    private(set) var nws = RoadIntel.Provider(id: "nws", name: "National Weather Service",
                                              kinds: Set(AlertSources.nwsEvents.values), state: .pending, fetchedAt: nil, maxAge: 1800)
    /// Extra incidents for demos and screenshots (-demoAlert); never set otherwise.
    var demoIncidents: [RoadIntel.Incident] = []
    private var nextAt = Date.distantPast
    private var failures = 0
    private var fetchedAtProgress: Double?
    private var inFlight = false
    private var routeID: UUID?
    var onUpdate: (() -> Void)?

    /// Work zones: one source per state feed, created when the state comes within 150 miles.
    private struct Feed {
        var provider: RoadIntel.Provider
        var refresh: TimeInterval
        var nextAt = Date.distantPast
        var failures = 0
        var inFlight = false
    }
    private var wzdx: [String: Feed] = [:]
    /// States within 150 miles ahead: with a feed (covered) and without.
    private var coverage: (covered: [String], uncovered: [String], at: Date)?

    static let nwsURL = URL(string: "https://api.weather.gov/alerts/active")!
    static let refresh: TimeInterval = 600
    static let wzdxAhead = 150 * Geodesy.metersPerMile
    /// A feed whose publisher has not updated it for this long is treated as unavailable, not as current.
    static let wzdxStale: TimeInterval = 86400
    static let userAgent = "ExitAtlas iOS (github.com/AltecBX/ExitAtlas)"

    var providers: [RoadIntel.Provider] {
        var list = [nws]
        for st in coverage?.covered ?? [] { if let f = wzdx[st] { list.append(f.provider) } }
        // Which states ahead have no work zone feed: "unsupported" when none does, a coverage note otherwise.
        let state: RoadIntel.ProviderState = coverage == nil ? .pending : coverage!.covered.isEmpty ? .unsupported : .ok
        list.append(RoadIntel.Provider(id: "wzdx", name: "State work zone feeds", kinds: AlertSources.wzdxKinds, state: state,
                                       fetchedAt: coverage?.at, maxAge: 86400, uncovered: coverage?.uncovered ?? []))
        if !demoIncidents.isEmpty {
            list.append(RoadIntel.Provider(id: "demo", name: "Simulated test alert", kinds: Set(RoadIntel.Kind.allCases), state: .ok,
                                           fetchedAt: Date(), incidents: demoIncidents))
        }
        return list
    }

    func reset(for plan: TripPlan?) {
        guard plan?.route.id != routeID else { return }
        routeID = plan?.route.id
        nws.state = .pending
        nws.fetchedAt = nil
        nws.incidents = []
        nextAt = .distantPast
        failures = 0
        fetchedAtProgress = nil
        wzdx = [:]
        coverage = nil
    }

    /// Called with each new position while a trip runs; fetches what is due. Groups switched off in Settings
    /// are not fetched.
    func refresh(plan: TripPlan, progress: Double, enabled: [RoadIntel.Group: Bool] = [:]) {
        guard plan.route.id == routeID else { return }
        if enabled[.weather] != false { refreshWeather(plan: plan, progress: progress) }
        if updateCoverage(plan: plan, progress: progress) { onUpdate?() }
        guard enabled[.closures] != false else { return }
        for st in coverage?.covered ?? [] where !(wzdx[st]?.inFlight ?? true) && Date() >= wzdx[st]!.nextAt {
            fetchWorkZones(st)
        }
    }

    private func refreshWeather(plan: TripPlan, progress: Double) {
        let moved = fetchedAtProgress.map { abs(progress - $0) > 20 * Geodesy.metersPerMile } ?? false
        guard !inFlight, Date() >= nextAt || moved else { return }
        inFlight = true
        let points = Self.samplePoints(plan: plan, progress: progress)
        let id = routeID
        Task { @MainActor in
            defer { self.inFlight = false }
            do {
                var responses: [(point: GeoCoordinate, features: [JSONValue])] = []
                for p in points {
                    var c = URLComponents(url: Self.nwsURL, resolvingAgainstBaseURL: false)!
                    c.queryItems = [URLQueryItem(name: "point", value: String(format: "%.4f,%.4f", p.latitude, p.longitude))]
                    var request = URLRequest(url: c.url!)
                    // NWS asks every client to identify itself.
                    request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
                    request.setValue("application/geo+json", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = 20
                    let (data, response) = try await URLSession.shared.data(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                    responses.append((p, try JSONValue(data: data)["features"]?.array ?? []))
                }
                guard self.routeID == id else { return }
                self.nws.incidents = AlertSources.nwsIncidents(responses)
                self.nws.state = .ok
                self.nws.fetchedAt = Date()
                self.fetchedAtProgress = progress
                self.failures = 0
                self.nextAt = Date().addingTimeInterval(Self.refresh)
            } catch {
                guard self.routeID == id else { return }
                // The last good result stays until it is older than maxAge; the engine then says unavailable.
                self.failures += 1
                if self.nws.fetchedAt == nil { self.nws.state = .error }
                self.nextAt = Date().addingTimeInterval(min(1800, 60 * pow(2, Double(min(self.failures, 5)))))
            }
            self.onUpdate?()
        }
    }

    /// The states within 150 miles ahead, split into those with a feed and those without. True when it changed.
    private func updateCoverage(plan: TripPlan, progress: Double) -> Bool {
        var states: [String] = []
        for seg in plan.states.segments {
            guard let code = seg.code, seg.endDistance > progress, seg.startDistance < progress + Self.wzdxAhead,
                  !states.contains(code) else { continue }
            states.append(code)
        }
        let covered = states.filter { AlertSources.wzdxFeeds[$0] != nil }
        let uncovered = states.filter { AlertSources.wzdxFeeds[$0] == nil }
        for st in covered where wzdx[st] == nil {
            let large = AlertSources.wzdxFeeds[st]?.large ?? false
            let source = AlertSources.wzdxSource(st)
            wzdx[st] = Feed(provider: RoadIntel.Provider(id: source.id, name: source.name, kinds: AlertSources.wzdxKinds, state: .pending,
                                                         fetchedAt: nil, maxAge: large ? 3600 : 1800),
                            refresh: large ? 1800 : 600)
        }
        if let c = coverage, c.covered == covered, c.uncovered == uncovered { return false }
        coverage = (covered, uncovered, Date())
        return true
    }

    private func fetchWorkZones(_ state: String) {
        guard let feed = AlertSources.wzdxFeeds[state] else { return }
        wzdx[state]?.inFlight = true
        let id = routeID
        Task { @MainActor in
            defer { self.wzdx[state]?.inFlight = false }
            do {
                var request = URLRequest(url: feed.url)
                request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
                request.setValue("application/geo+json, application/json", forHTTPHeaderField: "Accept")
                request.timeoutInterval = 30
                let (data, response) = try await URLSession.shared.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                let body = try AlertSources.parseWZDx(data)
                if let updated = AlertSources.wzdxUpdatedAt(body), Date().timeIntervalSince(updated) > Self.wzdxStale {
                    throw URLError(.resourceUnavailable)
                }
                let incidents = AlertSources.wzdxIncidents(body, state: state)
                guard self.routeID == id, var f = self.wzdx[state] else { return }
                f.provider.incidents = incidents
                f.provider.state = .ok
                f.provider.fetchedAt = Date()
                f.failures = 0
                f.nextAt = Date().addingTimeInterval(f.refresh)
                self.wzdx[state] = f
            } catch {
                guard self.routeID == id, var f = self.wzdx[state] else { return }
                // The last good result stays until it is older than maxAge; the engine then says unavailable.
                f.failures += 1
                if f.provider.fetchedAt == nil { f.provider.state = .error }
                f.nextAt = Date().addingTimeInterval(min(1800, 60 * pow(2, Double(min(f.failures, 5)))))
                self.wzdx[state] = f
            }
            self.onUpdate?()
        }
    }

    /// Here, then every 25 miles up to 150 (or the destination).
    static func samplePoints(plan: TripPlan, progress: Double) -> [GeoCoordinate] {
        let end = min(plan.route.polyline.length, progress + 150 * Geodesy.metersPerMile)
        return stride(from: progress, through: end, by: 25 * Geodesy.metersPerMile).map { plan.route.polyline.coordinate(at: $0) }
    }
}
