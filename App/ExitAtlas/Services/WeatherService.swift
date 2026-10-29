import ExitAtlasCore
import Foundation

/// Current weather where you are, during a trip, from the National Weather Service: the point record (which
/// forecast grid and which stations), the latest observations of the nearest stations, and the hourly
/// forecast. Every 10 minutes or after 10 miles (not more than every 2 minutes); the point record again after
/// 5 miles. A failed refresh keeps the last answers, and the engine (CurrentWeather) still drops an
/// observation once it is 90 minutes old; answers fetched more than 25 miles back are not shown at all.
/// Same plan as web/js/app/weather.js.
@MainActor
final class WeatherService {
    private struct Point {
        let position: GeoCoordinate
        let hourlyURL: URL?
        let stations: [CurrentWeather.Station]
        let place: String?
        let timeZone: TimeZone?
    }

    private struct Answers {
        let position: GeoCoordinate
        let observations: [(station: CurrentWeather.Station, body: JSONValue)]
        let hourly: JSONValue?
        let id = UUID()
    }

    private var point: Point?
    private var answers: Answers?
    private var nextAt = Date.distantPast
    private var ranAt = Date.distantPast
    private var failures = 0
    private var inFlight = false
    private var generation = 0
    private var memo: (minute: Int, answers: UUID, value: CurrentWeather.Now?)?
    var onUpdate: (() -> Void)?

    static let api = "https://api.weather.gov"
    static let mile = Geodesy.metersPerMile

    /// The time zone of the place the answers are for, for the hour labels.
    var timeZone: TimeZone? { point?.timeZone }

    func reset() {
        generation += 1
        point = nil
        answers = nil
        nextAt = .distantPast
        ranAt = .distantPast
        failures = 0
        inFlight = false
        memo = nil
    }

    /// The weather to show at `position` now, or nil (nothing current, or the answers are for elsewhere).
    func current(at position: GeoCoordinate) -> CurrentWeather.Now? {
        guard let a = answers, Geodesy.distance(a.position, position) <= 25 * Self.mile else { return nil }
        let now = Date()
        let minute = Int(now.timeIntervalSince1970 / 60)
        if memo?.minute != minute || memo?.answers != a.id {
            memo = (minute, a.id, CurrentWeather.now(observations: a.observations, hourly: a.hourly, now: now, place: point?.place))
        }
        // How far the station is from where you are now, not from where it was looked up.
        guard var value = memo?.value else { return nil }
        if let s = value.station { value.station?.distance = Geodesy.distance(position, s.coordinate) }
        return value
    }

    /// Called with each new position while a trip runs; fetches when due.
    func refresh(at position: GeoCoordinate) {
        let now = Date()
        // Moving on: again after 10 miles, but not more than every 2 minutes (a simulated drive runs at 30 times
        // speed), and not while backing off after failures.
        let moved = (answers.map { failures == 0 && Geodesy.distance($0.position, position) > 10 * Self.mile } ?? false)
            && now.timeIntervalSince(ranAt) >= 120
        guard !inFlight, now >= nextAt || moved else { return }
        inFlight = true
        ranAt = now
        let gen = generation
        Task { @MainActor in
            defer { if self.generation == gen { self.inFlight = false } }
            do {
                var point: Point
                if let known = self.point, Geodesy.distance(known.position, position) <= 5 * Self.mile {
                    point = known
                } else {
                    point = try await Self.loadPoint(position)
                    guard self.generation == gen else { return }
                    self.point = point
                }
                var observations: [(station: CurrentWeather.Station, body: JSONValue)] = []
                for station in point.stations {
                    guard let body = try? await Self.get("\(Self.api)/stations/\(station.id)/observations/latest") else { continue }
                    observations.append((station, body))
                    // The nearest station that reported recently is enough.
                    let p = body["properties"]
                    if let t = p?["timestamp"]?.string.flatMap({ ISO8601DateFormatter().date(from: $0) }),
                       p?["temperature"]?["value"]?.number != nil, now.timeIntervalSince(t) <= 90 * 60 { break }
                }
                var hourly: JSONValue?
                if let url = point.hourlyURL { hourly = try? await Self.get(url.absoluteString) }
                guard self.generation == gen else { return }
                if observations.isEmpty && hourly == nil { throw URLError(.badServerResponse) }
                self.answers = Answers(position: position, observations: observations, hourly: hourly)
                self.failures = 0
                self.nextAt = Date().addingTimeInterval(600)
            } catch {
                guard self.generation == gen else { return }
                self.failures += 1
                self.nextAt = Date().addingTimeInterval(min(1800, 60 * pow(2, Double(min(self.failures, 5)))))
            }
            self.onUpdate?()
        }
    }

    private static func loadPoint(_ position: GeoCoordinate) async throws -> Point {
        // Rounded to about 1 km: enough for the forecast grid, and no more of your position than needed.
        let p = try await get(String(format: "%@/points/%.2f,%.2f", api, position.latitude, position.longitude))["properties"]
        var stations: [CurrentWeather.Station] = []
        if let url = p?["observationStations"]?.string {
            stations = CurrentWeather.nearestStations(try await get("\(url)?limit=10"), position: position)
        }
        let rel = p?["relativeLocation"]?["properties"]
        let place = rel?["city"]?.string.map { "\($0), \(rel?["state"]?.string ?? "")" }
        return Point(position: position, hourlyURL: p?["forecastHourly"]?.string.flatMap(URL.init(string:)), stations: stations,
                     place: place, timeZone: p?["timeZone"]?.string.flatMap(TimeZone.init(identifier:)))
    }

    private static func get(_ url: String) async throws -> JSONValue {
        guard let u = URL(string: url) else { throw URLError(.badURL) }
        var request = URLRequest(url: u)
        // NWS asks every client to identify itself.
        request.setValue(RoadAlertService.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/geo+json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONValue(data: data)
    }
}
