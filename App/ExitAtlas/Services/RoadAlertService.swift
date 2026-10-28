import ExitAtlasCore
import Foundation

/// Road alert sources for the active trip, fetched politely: only while a trip runs, every few minutes or
/// after a long move, with backoff after errors. Each source keeps its own state, so a failure shows as
/// "data unavailable", never as "no alerts". The engine (RoadIntel) does the matching. Same plan as
/// web/js/app/roadalerts.js.
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

    static let nwsURL = URL(string: "https://api.weather.gov/alerts/active")!
    static let refresh: TimeInterval = 600

    var providers: [RoadIntel.Provider] {
        guard !demoIncidents.isEmpty else { return [nws] }
        return [nws, RoadIntel.Provider(id: "demo", name: "Simulated test alert", kinds: Set(RoadIntel.Kind.allCases), state: .ok,
                                        fetchedAt: Date(), incidents: demoIncidents)]
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
    }

    /// Called with each new position while a trip runs; fetches what is due.
    func refresh(plan: TripPlan, progress: Double) {
        let moved = fetchedAtProgress.map { abs(progress - $0) > 20 * Geodesy.metersPerMile } ?? false
        guard !inFlight, Date() >= nextAt || moved, plan.route.id == routeID else { return }
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
                    request.setValue("ExitAtlas iOS (github.com/AltecBX/ExitAtlas)", forHTTPHeaderField: "User-Agent")
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

    /// Here, then every 25 miles up to 150 (or the destination).
    static func samplePoints(plan: TripPlan, progress: Double) -> [GeoCoordinate] {
        let end = min(plan.route.polyline.length, progress + 150 * Geodesy.metersPerMile)
        return stride(from: progress, through: end, by: 25 * Geodesy.metersPerMile).map { plan.route.polyline.coordinate(at: $0) }
    }
}
