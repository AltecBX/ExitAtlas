import ExitAtlasCore
import SwiftUI

/// The weather in the top bar of the Drive screen: symbol and temperature, with "Forecast" when no station
/// near you reported recently. Tap for the sheet, which names the condition. The web pill also shows the
/// condition when it fits; the iPhone top bar has no room for it next to the status pill.
struct WeatherPill: View {
    let weather: CurrentWeather.Now
    let temperature: Int
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: WeatherSymbol.name(weather.kind, isDay: weather.isDay))
                    .symbolRenderingMode(.multicolor)
                    .font(.system(size: 19))
                Text("\(temperature)°")
                    .font(.system(.headline, design: .rounded).weight(.bold))
                    .monospacedDigit()
                if weather.source == .forecast { ForecastTag() }
            }
            .fixedSize()
            .padding(.leading, 6)
            .padding(.trailing, 10)
            .padding(.vertical, 3)
            .background(Color.primary.opacity(0.06), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Weather: \(temperature) degrees, \(weather.label ?? "")\(weather.source == .forecast ? ", forecast" : "")")
        .accessibilityHint("Shows details")
        .accessibilityIdentifier("weatherPill")
    }
}

struct ForecastTag: View {
    var onSky = false

    var body: some View {
        Text("FORECAST")
            .font(.system(size: onSky ? 10 : 9, weight: .heavy))
            .tracking(0.4)
            .padding(.horizontal, onSky ? 6 : 4)
            .padding(.vertical, 2)
            .foregroundStyle(onSky ? Color.white : Theme.amber)
            .background(onSky ? Color.white.opacity(0.22) : Theme.amber.opacity(0.16), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

/// SF Symbols for the weather kinds, drawn in multicolor.
enum WeatherSymbol {
    static func name(_ kind: CurrentWeather.Kind?, isDay: Bool?) -> String {
        let night = isDay == false
        switch kind {
        case .clear: return night ? "moon.stars.fill" : "sun.max.fill"
        case .mostlyClear, .partlyCloudy, .mostlyCloudy: return night ? "cloud.moon.fill" : "cloud.sun.fill"
        case .cloudy, nil: return "cloud.fill"
        case .showers: return night ? "cloud.moon.rain.fill" : "cloud.sun.rain.fill"
        case .rain: return "cloud.rain.fill"
        case .thunder: return "cloud.bolt.rain.fill"
        case .sleet: return "cloud.sleet.fill"
        case .snow: return "cloud.snow.fill"
        case .fog: return "cloud.fog.fill"
        case .haze: return night ? "moon.haze.fill" : "sun.haze.fill"
        case .smoke: return "smoke.fill"
        case .dust: return night ? "moon.dust.fill" : "sun.dust.fill"
        case .wind: return "wind"
        case .hot: return "thermometer.sun.fill"
        case .cold: return "thermometer.snowflake"
        case .severe: return "exclamationmark.triangle.fill"
        }
    }

    /// Sky colors for the weather card, deep enough for white text (skyColors in web/js/app/weathericons.js).
    static func sky(_ kind: CurrentWeather.Kind?, isDay: Bool?) -> [Color] {
        let night = isDay == false
        let hex: (UInt32, UInt32)
        switch kind {
        case .clear, .mostlyClear: hex = night ? (0x0B1530, 0x26386A) : (0x1A5FBF, 0x3B8BD9)
        case .thunder: hex = (0x2A2340, 0x4A4170)
        case .severe: hex = (0x5A1E1E, 0x8E3A2A)
        case .rain, .showers: hex = night ? (0x121A26, 0x2A3749) : (0x344A61, 0x566E88)
        case .snow, .sleet, .cold: hex = night ? (0x1F2D42, 0x42557A) : (0x45698E, 0x6C8BAA)
        case .smoke, .dust, .hot: hex = night ? (0x2B1F19, 0x4A362A) : (0x6E4630, 0x97683F)
        default: hex = night ? (0x1A2331, 0x364357) : (0x46607D, 0x6C849F)
        }
        return [color(hex.0), color(hex.1)]
    }

    private static func color(_ v: UInt32) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }
}

/// The weather sheet: the sky card, the next hours and where the numbers come from.
struct WeatherSheet: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let w = trip.weatherNow, let t = w.temperatureF {
                        card(w, temperature: t)
                        Text(source(w)).font(.footnote).foregroundStyle(Theme.secondaryText)
                    } else {
                        Text("No current weather for where you are. ExitAtlas asks the National Weather Service while a trip runs, about every 10 minutes; nothing is shown when the answer is old or the service cannot be reached.")
                            .foregroundStyle(Theme.secondaryText)
                    }
                }
                .padding(16)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Weather")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func card(_ w: CurrentWeather.Now, temperature: Int) -> some View {
        var metrics: [(title: String, value: String)] = []
        if let f = w.feelsLikeF, f != temperature { metrics.append(("Feels like", "\(f)°")) }
        if let wind = w.windText { metrics.append(("Wind", wind)) }
        if let h = w.humidity { metrics.append(("Humidity", "\(h)%")) }
        let next = w.next.filter { $0.temperatureF != nil }
        return VStack(alignment: .leading, spacing: 12) {
            Text(w.place ?? "Where you are").font(.callout.weight(.semibold)).opacity(0.9)
            hero(w, temperature: temperature)
            if !metrics.isEmpty { metricsRow(metrics) }
            if !next.isEmpty { hoursRow(next) }
        }
        .padding(16)
        .foregroundStyle(.white)
        .background(
            LinearGradient(colors: WeatherSymbol.sky(w.kind, isDay: w.isDay), startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("weatherCard")
    }

    private func hero(_ w: CurrentWeather.Now, temperature: Int) -> some View {
        let label = w.label ?? ""
        let said = w.condition.flatMap { $0.lowercased() == label.lowercased() ? nil : $0 }
        return HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(temperature)°").font(.system(size: 76, weight: .light, design: .rounded)).monospacedDigit()
                HStack(spacing: 8) {
                    Text(label).font(.title3.weight(.semibold))
                    if w.source == .forecast { ForecastTag(onSky: true) }
                }
                if let said { Text(said).font(.caption).opacity(0.8) }
            }
            Spacer(minLength: 8)
            Image(systemName: WeatherSymbol.name(w.kind, isDay: w.isDay))
                .symbolRenderingMode(.multicolor)
                .font(.system(size: 72))
                .shadow(color: .black.opacity(0.25), radius: 10, y: 6)
                .accessibilityHidden(true)
        }
    }

    private func metricsRow(_ metrics: [(title: String, value: String)]) -> some View {
        HStack(spacing: 8) {
            ForEach(metrics.indices, id: \.self) { i in
                VStack(alignment: .leading, spacing: 2) {
                    Text(metrics[i].title.uppercased()).font(.system(size: 11, weight: .bold)).tracking(0.5).opacity(0.8)
                    Text(metrics[i].value).font(.subheadline.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
    }

    /// The next hours; the chance of rain under an hour when it is 20% or more (NWS says "slight chance" from 20%).
    private func hoursRow(_ next: [CurrentWeather.Hour]) -> some View {
        let rainy = next.contains { ($0.rainChance ?? 0) >= 20 }
        return HStack(spacing: 0) {
            ForEach(next, id: \.at) { h in
                VStack(spacing: 4) {
                    Text(hourText(h.at)).font(.footnote.weight(.semibold)).opacity(0.85)
                    Image(systemName: WeatherSymbol.name(h.kind, isDay: h.isDay))
                        .symbolRenderingMode(.multicolor)
                        .font(.title3)
                        .frame(height: 26)
                    Text("\(h.temperatureF ?? 0)°").font(.system(.headline, design: .rounded)).monospacedDigit()
                    if rainy { rainText(h.rainChance) }
                }
                .frame(maxWidth: .infinity)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.vertical, 10)
        .background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func rainText(_ chance: Int?) -> some View {
        let c = chance ?? 0
        return Text(c >= 20 ? "\(c)%" : " ")
            .font(.caption2.weight(.bold))
            .foregroundStyle(Color(red: 0.66, green: 0.86, blue: 1))
    }

    /// "11 PM" in the time zone of the place.
    private func hourText(_ d: Date) -> String {
        var f = Date.FormatStyle().hour(.defaultDigits(amPM: .abbreviated))
        f.timeZone = trip.weather.timeZone ?? .current
        return d.formatted(f)
    }

    private func source(_ w: CurrentWeather.Now) -> String {
        guard w.source == .observed, let s = w.station else {
            return "No weather station near you reported in the last 90 minutes, so this is the forecast for this hour. National Weather Service."
        }
        let minutes = max(0, Int(Date().timeIntervalSince(w.at) / 60))
        return "Observed \(minutes < 1 ? "just now" : "\(minutes) min ago") at \(s.name), \(Format.miles(s.distance)) away. Next hours from the hourly forecast. National Weather Service."
    }
}
