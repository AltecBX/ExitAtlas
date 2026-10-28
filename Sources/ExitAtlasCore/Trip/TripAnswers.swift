import Foundation

/// Spoken answers for Siri and Shortcuts ("How far to Georgia in ExitAtlas"). Full sentences, because
/// in CarPlay and on a locked phone the answer is only heard.
public enum TripAnswers {
    public static let noTrip = "No trip is active in ExitAtlas. Start a trip or discovery mode in the app first."

    /// How far to a state, by code ("GA") or name ("Georgia").
    public static func distanceToState(_ query: String, snapshot s: TripSnapshot) -> String {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        func matches(_ f: SegmentForecast) -> Bool {
            f.segment.code?.lowercased() == q || f.segment.displayName.lowercased() == q
        }
        if let current = s.current, matches(current) {
            let name = current.segment.displayName
            if s.next == nil { return "You are in \(name), the last state on your route. \(miles(current.remainingMeters)) to go." }
            return "You are in \(name). \(miles(current.remainingMeters)) of your route are left in \(name)."
        }
        if let ahead = s.itinerary.first(where: { $0.status == .upcoming && matches($0) }) {
            let distance = ahead.segment.startDistance - s.progress
            var text = "\(ahead.segment.displayName) is \(miles(distance)) ahead"
            if let entry = ahead.entryTime {
                text += ", about \(duration(entry.timeIntervalSince(s.timestamp))). You cross at \(clock(entry, ahead.entryTimeZoneID))."
            } else {
                text += "."
            }
            return text
        }
        if let done = s.itinerary.first(where: { $0.status == .completed && matches($0) }) {
            return "You already drove through \(done.segment.displayName) on this trip."
        }
        return "\(query.trimmingCharacters(in: .whitespaces)) is not on your route."
    }

    /// The next state line.
    public static func nextStateLine(snapshot s: TripSnapshot) -> String {
        guard let current = s.current, let next = s.next else {
            return s.current.map { "No more state lines. You stay in \($0.segment.displayName) to the end of the route." } ?? noTrip
        }
        let exits = current.exitsRemaining
        var text = "\(next.segment.displayName) is \(miles(current.remainingMeters)) ahead"
        if let crossing = current.exitTime {
            text += ", about \(duration(crossing.timeIntervalSince(s.timestamp)))"
        }
        return text + ". \(exits) \(exits == 1 ? "exit remains" : "exits remain") in \(current.segment.displayName)."
    }

    public static func nextExit(snapshot s: TripSnapshot, services: [ExitService]) -> String {
        guard let next = s.nextExit else { return "No exits are listed ahead on this route." }
        var text = "\(next.exit.displayTitle) is \(miles(next.distance)) ahead"
        if !next.exit.name.isEmpty { text += ", \(next.exit.name)" }
        let order: [(PlaceCategory, String)] = [(.gas, "gas"), (.food, "food"), (.lodging, "lodging"), (.evCharging, "EV charging")]
        let present = order.filter { c in services.contains { $0.place.category == c.0 } }.map(\.1)
        text += present.isEmpty ? ". No services are listed." : ". It has \(list(present))."
        return text
    }

    public static func nextRestArea(snapshot s: TripSnapshot) -> String {
        guard let next = s.nextRestArea else { return "No rest areas are listed ahead on this route." }
        let r = next.restArea
        var text = "The next \(r.kind.title.lowercased()) is \(r.title == r.kind.title ? "" : r.title + ", ")\(miles(next.distance)) ahead, about \(duration(next.eta.timeIntervalSince(s.timestamp)))."
        if r.side == .both { text += " It serves both directions." }
        let yes = r.badges.filter { $0.value }.map { $0.amenity.label.lowercased() }
        let no = r.badges.filter { !$0.value }.map { "no " + $0.amenity.label.lowercased() }
        if !yes.isEmpty || !no.isEmpty {
            text += " OpenStreetMap lists \(list(yes + no))."
        } else if r.kind != .plaza || (r.gas.isEmpty && r.food.isEmpty) {
            text += " Its amenities are not listed."
        }
        if r.kind == .plaza, !r.gas.isEmpty { text += " Gas: \(list(Array(r.gas.prefix(2))))." }
        return text
    }

    /// Next gas: an exit with a gas station listed or a service plaza with gas.
    public static func nextGas(snapshot s: TripSnapshot, stops: [GasGaps.Stop]) -> String {
        guard let next = stops.first(where: { $0.distance > s.progress }) else { return "No gas is listed ahead on this route." }
        var text = "The next gas is \(next.title), \(miles(next.distance - s.progress)) ahead."
        if let after = stops.first(where: { $0.distance > next.distance }) {
            let gap = after.distance - next.distance
            if gap >= 40 * Geodesy.metersPerMile { text += " After that, none for \(miles(gap))." }
        }
        return text
    }

    public static func arrival(snapshot s: TripSnapshot, destination: String?, timeZoneID: String?) -> String {
        let place = destination.map { " at \($0)" } ?? ""
        return "You arrive\(place) at about \(clock(s.eta, timeZoneID)), in \(duration(s.timeRemaining)). \(miles(s.remaining)) to go."
    }

    // MARK: Words

    static func miles(_ meters: Double) -> String {
        let mi = meters / Geodesy.metersPerMile
        if mi < 0.95 { return mi < 0.35 ? "a quarter mile" : mi < 0.75 ? "half a mile" : "about a mile" }
        if mi < 10 { return String(format: "%.0f miles", mi.rounded()) }
        return "\(Int(mi.rounded())) miles"
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(1, Int((seconds / 60).rounded()))
        let h = total / 60, m = total % 60
        if h == 0 { return "\(m) \(m == 1 ? "minute" : "minutes")" }
        let hours = "\(h) \(h == 1 ? "hour" : "hours")"
        return m == 0 ? hours : "\(hours) \(m) \(m == 1 ? "minute" : "minutes")"
    }

    /// "1:59 PM Eastern Time" in the place's time zone.
    static func clock(_ date: Date, _ zoneID: String?) -> String {
        let zone = zoneID.flatMap(TimeZone.init(identifier:)) ?? .current
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "h:mm a"
        var text = f.string(from: date)
        if let id = zoneID { text += " " + VoiceAnnouncements.zoneName(id, at: date) }
        return text
    }

    static func list(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        case 2: return "\(items[0]) and \(items[1])"
        default: return items.dropLast().joined(separator: ", ") + " and " + items.last!
        }
    }
}
