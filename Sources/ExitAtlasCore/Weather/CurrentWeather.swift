import Foundation

/// Current weather where you are, from the National Weather Service (public domain, no key): the latest
/// observation from the nearest station that reported in the last 90 minutes, else the hourly forecast for
/// this hour, labeled as a forecast. An old reading is never shown as current. Pure functions on NWS
/// responses; fetching lives in the app (WeatherService). Port of web/js/engine/weather.js, tested on
/// Tests/ExitAtlasCoreTests/Fixtures/weather (real responses).
public enum CurrentWeather {
    public struct Rules: Sendable {
        /// An observation older than this is not "now" (stations report hourly, some only every few hours).
        public var maxObservationAge: TimeInterval = 90 * 60
        /// A station farther than this does not stand for where you are.
        public var maxStationDistance: Double = 50_000
        /// Stations tried, nearest first.
        public var stations = 3
        /// Hours listed after this one.
        public var nextHours = 4

        public init() {}
    }

    /// Kinds of weather (WEATHER_KINDS in the web engine).
    public enum Kind: String, CaseIterable, Sendable {
        case clear, mostlyClear, partlyCloudy, mostlyCloudy, cloudy, showers, rain, thunder, sleet, snow, fog, haze,
             smoke, dust, wind, hot, cold, severe

        /// A short label for day and night.
        public func label(isDay: Bool?) -> String {
            let night = isDay == false
            switch self {
            case .clear: return night ? "Clear" : "Sunny"
            case .mostlyClear: return night ? "Mostly clear" : "Mostly sunny"
            case .partlyCloudy: return "Partly cloudy"
            case .mostlyCloudy: return "Mostly cloudy"
            case .cloudy: return "Cloudy"
            case .showers: return "Showers"
            case .rain: return "Rain"
            case .thunder: return "Storms"
            case .sleet: return "Wintry mix"
            case .snow: return "Snow"
            case .fog: return "Fog"
            case .haze: return "Haze"
            case .smoke: return "Smoke"
            case .dust: return "Dust"
            case .wind: return "Windy"
            case .hot: return "Hot"
            case .cold: return "Cold"
            case .severe: return "Severe weather"
            }
        }
    }

    public struct Station: Sendable, Hashable {
        public let id: String
        public let name: String
        /// Meters from where it was looked up.
        public var distance: Double
        public let coordinate: GeoCoordinate
    }

    public struct Hour: Sendable, Hashable {
        public let at: Date
        public let temperatureF: Int?
        public let kind: Kind?
        public let isDay: Bool?
        public let condition: String?
        public let rainChance: Int?
    }

    public enum Source: String, Sendable { case observed, forecast }

    public struct Now: Sendable, Hashable {
        public let source: Source
        public let at: Date
        public let place: String?
        public var station: Station?
        public let temperatureF: Int?
        public let feelsLikeF: Int?
        public let kind: Kind?
        public let isDay: Bool?
        public let condition: String?
        public let windMph: Int?
        public let windFrom: String?
        public let gustMph: Int?
        public let humidity: Int?
        public let next: [Hour]

        /// The kind's label, else the words NWS used.
        public var label: String? { kind?.label(isDay: isDay) ?? condition }

        /// "NE 11 mph, gusts 25", "Calm", or nil.
        public var windText: String? {
            guard let mph = windMph else { return nil }
            if mph == 0 { return "Calm" }
            return "\(windFrom.map { "\($0) " } ?? "")\(mph) mph\(gustMph.map { $0 > 0 ? ", gusts \($0)" : "" } ?? "")"
        }
    }

    /// NWS icon codes (https://api.weather.gov/icons) as kinds.
    static let iconCodes: [String: Kind] = [
        "skc": .clear, "few": .mostlyClear, "sct": .partlyCloudy, "bkn": .mostlyCloudy, "ovc": .cloudy,
        "wind_skc": .wind, "wind_few": .wind, "wind_sct": .wind, "wind_bkn": .wind, "wind_ovc": .wind,
        "snow": .snow, "blizzard": .snow,
        "rain_snow": .sleet, "rain_sleet": .sleet, "snow_sleet": .sleet, "sleet": .sleet, "fzra": .sleet, "rain_fzra": .sleet, "snow_fzra": .sleet,
        "rain": .rain, "rain_showers": .showers, "rain_showers_hi": .showers,
        "tsra": .thunder, "tsra_sct": .thunder, "tsra_hi": .thunder,
        "tornado": .severe, "hurricane": .severe, "tropical_storm": .severe,
        "dust": .dust, "smoke": .smoke, "haze": .haze, "hot": .hot, "cold": .cold, "fog": .fog,
    ]

    /// Words in a description, most specific first, when there is no icon.
    static let textKinds: [(String, Kind)] = [
        ("tornado|hurricane|tropical storm", .severe), ("thunder", .thunder), ("freezing|sleet|ice pellets|wintry", .sleet),
        ("snow|blizzard", .snow), ("shower", .showers), ("rain|drizzle", .rain), ("fog|mist", .fog), ("smoke", .smoke),
        ("haze", .haze), ("dust|sand", .dust), ("wind|breezy", .wind), ("mostly cloudy", .mostlyCloudy),
        ("partly (cloudy|sunny)", .partlyCloudy), ("mostly (clear|sunny)|fair", .mostlyClear), ("overcast|cloudy", .cloudy),
        ("clear|sunny", .clear),
    ]

    /// The kind of weather and day or night from an NWS icon URL (".../icons/land/night/bkn?size=small";
    /// ".../land/day/rain_showers,30/tsra_hi,40"), else from the description. isDay is nil when not given.
    public static func kind(icon: String?, text: String?) -> (kind: Kind?, isDay: Bool?) {
        var isDay: Bool?
        if let icon, let r = icon.range(of: #"/icons/land/(day|night)/[^/?]+"#, options: .regularExpression) {
            let parts = icon[r].split(separator: "/")
            isDay = parts[2] == "day"
            let code = parts[3].split(separator: ",").first.map(String.init) ?? ""
            if let k = iconCodes[code] { return (k, isDay) }
        }
        let t = (text ?? "").lowercased()
        let hit = textKinds.first { t.range(of: $0.0, options: .regularExpression) != nil }
        return (hit?.1, isDay)
    }

    /// The nearest stations within reach, nearest first, from an NWS stations list.
    public static func nearestStations(_ body: JSONValue?, position: GeoCoordinate, rules: Rules = Rules()) -> [Station] {
        var out: [Station] = []
        for f in body?["features"]?.array ?? [] {
            guard let id = f["properties"]?["stationIdentifier"]?.string, let c = f["geometry"]?["coordinates"]?.array,
                  c.count >= 2, let lon = c[0].number, let lat = c[1].number else { continue }
            let coordinate = GeoCoordinate(latitude: lat, longitude: lon)
            let d = Geodesy.distance(position, coordinate)
            if d <= rules.maxStationDistance {
                out.append(Station(id: id, name: f["properties"]?["name"]?.string ?? id, distance: d, coordinate: coordinate))
            }
        }
        return Array(out.sorted { $0.distance < $1.distance }.prefix(rules.stations))
    }

    static func date(_ v: JSONValue?) -> Date? {
        guard let s = v?.string else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }

    static func value(_ q: JSONValue?) -> Double? { q?["value"]?.number.flatMap { $0.isFinite ? $0 : nil } }
    /// Halves round up, as Math.round does in the web engine (-0.5 is 0, not -1).
    static func roundHalfUp(_ x: Double) -> Int { Int((x + 0.5).rounded(.down)) }
    static func fahrenheit(_ c: Double?) -> Int? { c.map { roundHalfUp($0 * 9 / 5 + 32) } }
    static func mph(_ kmh: Double?) -> Int? { kmh.map { roundHalfUp($0 / 1.609344) } }
    static let compassPoints = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
    static func compass(_ deg: Double?) -> String? {
        guard let deg else { return nil }
        let d = (deg.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360)
        return compassPoints[roundHalfUp(d / 45) % 8]
    }

    struct Period {
        let start: Date, end: Date
        let json: JSONValue
        var temperatureF: Int? {
            guard let t = json["temperature"]?.number, t.isFinite else { return nil }
            return json["temperatureUnit"]?.string == "C" ? fahrenheit(t) : roundHalfUp(t)
        }
    }

    /// The weather to show now.
    ///   observations: (station, latest observation) per station, nearest first
    ///   hourly: the NWS hourly forecast, or nil; place: "Jacksonville, FL" or nil
    /// Returns nil when nothing current is known.
    public static func now(observations: [(station: Station, body: JSONValue)], hourly: JSONValue?, now: Date,
                           place: String? = nil, rules: Rules = Rules()) -> Now? {
        let periods = (hourly?["properties"]?["periods"]?.array ?? []).compactMap { p -> Period? in
            guard let s = date(p["startTime"]), let e = date(p["endTime"]) else { return nil }
            return Period(start: s, end: e, json: p)
        }
        let thisHour = periods.first { $0.start <= now && now < $0.end }
        let next = periods.filter { $0.start >= (thisHour?.end ?? now) }.prefix(rules.nextHours).map { p -> Hour in
            let k = kind(icon: p.json["icon"]?.string, text: p.json["shortForecast"]?.string)
            return Hour(at: p.start, temperatureF: p.temperatureF, kind: k.kind, isDay: k.isDay ?? p.json["isDaytime"]?.bool,
                        condition: p.json["shortForecast"]?.string, rainChance: value(p.json["probabilityOfPrecipitation"]).map(roundHalfUp))
        }

        for (station, body) in observations {
            let p = body["properties"]
            guard let at = date(p?["timestamp"]), let tempC = value(p?["temperature"]),
                  now.timeIntervalSince(at) <= rules.maxObservationAge, at.timeIntervalSince(now) <= 600 else { continue }
            let k = kind(icon: p?["icon"]?.string, text: p?["textDescription"]?.string)
            let hourKind = thisHour.flatMap { kind(icon: $0.json["icon"]?.string, text: $0.json["shortForecast"]?.string).kind }
            let isDay = k.isDay ?? thisHour?.json["isDaytime"]?.bool
            let text = p?["textDescription"]?.string.flatMap { $0.isEmpty ? nil : $0 }
            return Now(source: .observed, at: at, place: place, station: station,
                       temperatureF: fahrenheit(tempC), feelsLikeF: fahrenheit(value(p?["heatIndex"]) ?? value(p?["windChill"])),
                       kind: k.kind ?? hourKind, isDay: isDay, condition: text ?? (k.kind ?? hourKind)?.label(isDay: isDay),
                       windMph: mph(value(p?["windSpeed"])), windFrom: compass(value(p?["windDirection"])),
                       gustMph: mph(value(p?["windGust"])), humidity: value(p?["relativeHumidity"]).map(roundHalfUp),
                       next: Array(next))
        }
        guard let h = thisHour else { return nil }
        let k = kind(icon: h.json["icon"]?.string, text: h.json["shortForecast"]?.string)
        let isDay = k.isDay ?? h.json["isDaytime"]?.bool
        let winds = (h.json["windSpeed"]?.string ?? "").split { !$0.isNumber }.compactMap { Int($0) }
        let text = h.json["shortForecast"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        return Now(source: .forecast, at: h.start, place: place, station: nil, temperatureF: h.temperatureF, feelsLikeF: nil,
                   kind: k.kind, isDay: isDay, condition: text ?? k.kind?.label(isDay: isDay),
                   windMph: winds.max(), windFrom: h.json["windDirection"]?.string.flatMap { $0.isEmpty ? nil : $0 }, gustMph: nil,
                   humidity: value(h.json["relativeHumidity"]).map(roundHalfUp), next: Array(next))
    }
}
