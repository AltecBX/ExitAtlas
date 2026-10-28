import ExitAtlasCore
import Foundation

/// Formatting for distances, durations and local times.
enum Format {
    static func miles(_ meters: Double) -> String {
        let mi = meters / Geodesy.metersPerMile
        if mi < 0.1 { return "0 mi" }
        if mi < 10 { return String(format: "%.1f mi", mi) }
        return String(format: "%.0f mi", mi.rounded())
    }

    /// Number only, for big dashboard digits.
    static func milesValue(_ meters: Double) -> String {
        let mi = meters / Geodesy.metersPerMile
        return mi < 10 ? String(format: "%.1f", max(mi, 0)) : String(format: "%.0f", mi.rounded())
    }

    static func spokenMiles(_ meters: Double) -> String {
        let mi = meters / Geodesy.metersPerMile
        if mi < 0.35 { return "a quarter mile" }
        if mi < 0.75 { return "half a mile" }
        let whole = Int(mi.rounded())
        return whole == 1 ? "1 mile" : "\(whole) miles"
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int((seconds / 60).rounded()))
        let h = total / 60, m = total % 60
        if h == 0 { return "\(m) min" }
        return m == 0 ? "\(h) h" : "\(h) h \(m) min"
    }

    private static var formatters: [String: (time: DateFormatter, weekday: DateFormatter)] = [:]

    /// Clock time in the time zone of a place on the route, with its abbreviation ("4:32 PM EDT").
    /// Adds the weekday when the time is not today in that zone.
    static func time(_ date: Date, timeZoneID: String? = nil, relativeTo now: Date = Date()) -> String {
        let zone = timeZoneID.flatMap(TimeZone.init(identifier:)) ?? .current
        let pair: (time: DateFormatter, weekday: DateFormatter)
        if let cached = formatters[zone.identifier] {
            pair = cached
        } else {
            let t = DateFormatter()
            t.timeZone = zone
            t.dateStyle = .none
            t.timeStyle = .short
            let w = DateFormatter()
            w.timeZone = zone
            w.setLocalizedDateFormatFromTemplate("EEE")
            pair = (t, w)
            formatters[zone.identifier] = pair
        }
        var calendar = Calendar.current
        calendar.timeZone = zone
        var text = pair.time.string(from: date)
        if !calendar.isDate(date, inSameDayAs: now) {
            text = pair.weekday.string(from: date) + " " + text
        }
        if timeZoneID != nil, let abbreviation = zone.abbreviation(for: date) {
            text += " " + abbreviation
        }
        return text
    }
}
