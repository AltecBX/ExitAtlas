import Foundation

/// Decides what to say for state lines, time zones, the last gas before a long stretch, rest areas and
/// exits, at most one message per snapshot. The app speaks it. Same rules as web/js/app/announcer.js.
///
/// Announcements are keyed by things that survive a reroute: the state code and the odometer
/// (driven total) where the state line is expected. Segment indexes restart at 0 on every new plan,
/// so keying by index silently dropped "Welcome to" and state line messages after a reroute.
public struct VoiceAnnouncements: Sendable {
    public struct Settings: Sendable {
        public var enabled: Bool
        public var stateLines: Bool
        public var exits: Bool
        public var restAreas: Bool
        public var gasGaps: Bool
        public var timeZones: Bool
        public var alerts: Bool

        public init(enabled: Bool, stateLines: Bool, exits: Bool, restAreas: Bool = true, gasGaps: Bool = true,
                    timeZones: Bool = true, alerts: Bool = true) {
            self.enabled = enabled
            self.stateLines = stateLines
            self.exits = exits
            self.restAreas = restAreas
            self.gasGaps = gasGaps
            self.timeZones = timeZones
            self.alerts = alerts
        }
    }

    static let borderWarning = 5 * Geodesy.metersPerMile
    static let borderMinimum = 0.5 * Geodesy.metersPerMile
    /// A state line warning counts as already given when one was given for the same state with an
    /// expected crossing within this many meters on the odometer (route changes move it a little).
    static let sameBorder = 3 * Geodesy.metersPerMile
    static let restWarning = 2.5 * Geodesy.metersPerMile
    static let restMinimum = 0.4 * Geodesy.metersPerMile
    static let gapWarning = 6 * Geodesy.metersPerMile
    /// Road alerts: serious ones from 10 miles, others from 2; never within 0.3, where it is too late.
    static let seriousAlertWarning = 10 * Geodesy.metersPerMile
    static let alertWarning = 2 * Geodesy.metersPerMile
    static let alertMinimum = 0.3 * Geodesy.metersPerMile

    private var announcedExitIDs = Set<String>()
    private var announcedBorders: [(state: String, odometer: Double)] = []
    private var lastState: String?
    private var lastZone: String?
    private var announcedRest = Set<String>()
    private var announcedGaps = Set<String>()
    private var announcedOpen = Set<String>()
    private var announcedAlerts = Set<String>()

    public init() {}

    public mutating func reset() { self = VoiceAnnouncements() }

    /// zoneID: the time zone at the driver (`TripPlan.timeZoneID(at:)`). gasGap: the next stretch
    /// without gas that starts ahead (`GasGaps.find`), or nil. lastOpen: overnight, the last stop listed
    /// open before a long stretch (`SmartStop.lastOpenBeforeGap`), or nil. alerts: road alerts ahead (`RoadIntel`).
    public mutating func message(for s: TripSnapshot, settings: Settings, zoneID: String? = nil,
                                 gasGap: GasGaps.Gap? = nil, lastOpen: SmartStop.LastOpen? = nil,
                                 alerts: [RoadIntel.Alert] = []) -> String? {
        let state = Self.key(s.current?.segment)
        guard settings.enabled, s.match.status == .onRoute else {
            if let state { lastState = state }
            if let zoneID { lastZone = zoneID }
            return nil
        }
        // Road alerts first: once each. A state line message waits for the next position, it is not lost.
        if settings.alerts {
            for a in alerts where a.notable && !announcedAlerts.contains(a.incident.id) {
                let ahead = a.start - s.progress
                guard ahead > Self.alertMinimum, ahead <= (a.serious ? Self.seriousAlertWarning : Self.alertWarning) else { continue }
                announcedAlerts.insert(a.incident.id)
                return Self.alertWords(a, ahead: ahead)
            }
        }
        if settings.stateLines, let current = s.current {
            if let last = lastState, let state, state != last {
                lastState = state
                var text = "Welcome to \(current.segment.displayName)."
                if s.next != nil {
                    text += " \(Self.spokenMiles(current.remainingMeters)) of your route are in \(current.segment.displayName)."
                }
                return text
            }
            if let state { lastState = state }
            if let next = s.next, let toBorder = s.distanceToNextBorder,
               toBorder <= Self.borderWarning, toBorder > Self.borderMinimum,
               let nextState = Self.key(next.segment) {
                let odometer = s.drivenTotal + toBorder
                let given = announcedBorders.contains { $0.state == nextState && abs($0.odometer - odometer) <= Self.sameBorder }
                if !given {
                    announcedBorders.append((nextState, odometer))
                    let exits = current.exitsRemaining
                    return "\(next.segment.displayName) state line in \(Self.spokenMiles(toBorder)). "
                        + "\(exits) \(exits == 1 ? "exit remains" : "exits remain") in \(current.segment.displayName)."
                }
            }
        }
        // After the state line messages, so a state line that also changes the clock says both, in order.
        if let zoneID, let last = lastZone, zoneID != last, settings.timeZones {
            lastZone = zoneID
            if let change = Self.clockChange(from: last, to: zoneID, at: s.timestamp) {
                return "Now on \(Self.zoneName(zoneID, at: s.timestamp)). \(change)"
            }
        }
        if let zoneID { lastZone = zoneID }
        if settings.gasGaps, let gap = gasGap, let before = gap.before {
            let ahead = before.distance - s.progress
            if ahead > 0, ahead <= Self.gapWarning, !announcedGaps.contains(before.key) {
                announcedGaps.insert(before.key)
                return "Last gas for \(Self.spokenMiles(gap.length)) is \(before.title), in \(Self.spokenMiles(ahead))."
            }
        }
        // Overnight: the last stop listed open before a long stretch, once per stop. Not when it is the same
        // exit as the last gas just announced.
        // Not when "listed open" rests on Google Maps hours: its terms forbid text to speech of its content.
        if settings.gasGaps, let lo = lastOpen, !lo.evaluation.hoursFromGoogle, let ahead = lo.stop.ahead, ahead > 0, ahead <= Self.gapWarning,
           !announcedOpen.contains(lo.stop.id), lo.stop.exitID == nil || gasGap?.before?.exit?.id != lo.stop.exitID {
            announcedOpen.insert(lo.stop.id)
            let place = lo.stop.exitLabel.map { "\(lo.stop.name) at Exit \($0)" } ?? lo.stop.name
            return "Overnight, \(place) in \(Self.spokenMiles(ahead)) is the last stop listed open for "
                + "\(lo.openEnded ? "at least " : "")\(Self.spokenMiles(lo.length))."
        }
        if settings.restAreas, let next = s.nextRestArea, next.distance <= Self.restWarning, next.distance > Self.restMinimum,
           !announcedRest.contains(next.restArea.id) {
            announcedRest.insert(next.restArea.id)
            let r = next.restArea
            var text = "\(r.kind.title) in \(Self.spokenMiles(next.distance))"
            if r.side == .both { text += ", serving both directions" }
            let extra = Self.spokenAmenities(r)
            if !extra.isEmpty { text += ". " + extra.prefix(1).uppercased() + extra.dropFirst() }
            return text + "."
        }
        if settings.exits, let next = s.nextExit, next.distance <= Geodesy.metersPerMile,
           !announcedExitIDs.contains(next.exit.id) {
            announcedExitIDs.insert(next.exit.id)
            var text = "\(next.exit.displayTitle) in \(Self.spokenMiles(next.distance))"
            if !next.exit.name.isEmpty { text += ", \(next.exit.name)" }
            return text + "."
        }
        return nil
    }

    /// "Crash ahead, in 8 miles. 2 right lanes blocked." Weather says the warning's name; driver reports say so.
    public static func alertWords(_ a: RoadIntel.Alert, ahead: Double) -> String {
        let i = a.incident
        let label = i.kind == .weather || i.kind == .flooding ? "\(i.description) on your route" : "\(i.kind.label) ahead"
        var text = "\(label), in \(spokenMiles(ahead))."
        if let lanes = i.lanes, !lanes.isEmpty { text += " \(lanes)." }
        if i.verification == .community { text += " Reported by drivers, not confirmed." }
        return text
    }

    static func key(_ segment: RegionSegment?) -> String? {
        guard let segment else { return nil }
        return segment.code ?? segment.displayName
    }

    /// Verified amenities in words: what a plaza sells, or a rest area's restrooms, pet area and vending.
    static func spokenAmenities(_ r: RouteRestArea) -> String {
        if r.kind == .plaza {
            let has = [r.gas.isEmpty ? nil : "gas", r.food.isEmpty ? nil : "food", r.ev.isEmpty ? nil : "charging"].compactMap { $0 }
            if !has.isEmpty { return has.count == 2 ? has.joined(separator: " and ") : has.joined(separator: ", ") }
        }
        if r.amenities[.toilets] == false { return "no restrooms" }
        return [r.amenities[.toilets] == true ? "restrooms" : nil, r.amenities[.pets] == true ? "pet area" : nil,
                r.amenities[.vending] == true ? "vending" : nil].compactMap { $0 }.joined(separator: ", ")
    }

    /// "Central Time" for a zone ID.
    public static func zoneName(_ id: String, at date: Date) -> String {
        guard let zone = TimeZone(identifier: id) else { return id }
        if let name = zone.localizedName(for: .generic, locale: Locale(identifier: "en_US")), name.hasSuffix("Time"),
           !name.contains("GMT") {
            return name
        }
        let names = ["E": "Eastern Time", "C": "Central Time", "M": "Mountain Time", "P": "Pacific Time",
                     "AK": "Alaska Time", "H": "Hawaii-Aleutian Time", "A": "Atlantic Time"]
        let abbreviation = zone.abbreviation(for: date) ?? ""
        for key in ["AK", "E", "C", "M", "P", "H", "A"] where abbreviation.hasPrefix(key) {
            return names[key]!
        }
        return id
    }

    /// "Clocks go back one hour." between two zones at a moment, or nil when the offset is the same.
    public static func clockChange(from a: String, to b: String, at date: Date) -> String? {
        guard let za = TimeZone(identifier: a), let zb = TimeZone(identifier: b) else { return nil }
        let delta = zb.secondsFromGMT(for: date) - za.secondsFromGMT(for: date)
        guard delta != 0 else { return nil }
        let hours = Double(abs(delta)) / 3600
        let amount = hours == 1 ? "one hour" : hours == 2 ? "two hours" : "\(hours.formatted()) hours"
        return "Clocks go \(delta > 0 ? "forward" : "back") \(amount)."
    }

    public static func spokenMiles(_ meters: Double) -> String {
        let mi = meters / Geodesy.metersPerMile
        if mi < 0.35 { return "a quarter mile" }
        if mi < 0.75 { return "half a mile" }
        let whole = Int(mi.rounded())
        return whole == 1 ? "1 mile" : "\(whole) miles"
    }
}

/// Spoken fuel and charging stop messages (the same rules as the web version): the recommended stop
/// at about 10 miles and again at 2 miles, and once when range drops under the buffer.
public struct FuelAnnouncements: Sendable {
    private var said = Set<String>()

    public init() {}

    /// Call after the driver enters a new range so the messages can be given again.
    public mutating func reset() { said.removeAll() }

    /// `smart`: SmartStop's pick for gas vehicles, so the voice names the same station as the screen.
    public mutating func message(for plan: RangePlan, electric: Bool, onRoute: Bool, enabled: Bool, smart: SmartStop.Pick? = nil) -> String? {
        guard enabled, onRoute else { return nil }
        struct Stop { let key: String; let name: String; let ahead: Double; let rangeOnArrival: Double }
        let rec: Stop? = smart.flatMap { p -> Stop? in
            guard let ahead = p.candidate.ahead, let left = p.candidate.rangeOnArrival else { return nil }
            return Stop(key: p.candidate.id, name: p.candidate.name + (p.candidate.exitLabel.map { ", exit \($0)" } ?? ""), ahead: ahead, rangeOnArrival: left)
        } ?? plan.recommended.map { s in
            let name = s.candidate.charger.map { $0.station.name.replacingOccurrences(of: " - Tesla Supercharger", with: " Supercharger") }
                ?? s.candidate.exit?.displayTitle ?? "the next stop"
            return Stop(key: s.key, name: name, ahead: s.ahead, rangeOnArrival: s.rangeOnArrival)
        }
        let mile = Geodesy.metersPerMile
        if let rec, plan.status == .planned {
            for (miles, tag) in [(2.0, "near"), (10.0, "far")] {
                let key = "\(rec.key)|\(tag)"
                if rec.ahead <= miles * mile, rec.ahead > 0.3 * mile, !said.contains(key) {
                    said.insert(key)
                    said.insert("\(rec.key)|far")
                    return "\(electric ? "Charging stop" : "Fuel stop"), \(rec.name), in \(VoiceAnnouncements.spokenMiles(rec.ahead)). "
                        + "About \(Int((rec.rangeOnArrival / mile).rounded())) miles of range left when you get there."
                }
            }
        }
        if plan.status != .destination, plan.range < plan.buffer, !said.contains("low") {
            said.insert("low")
            if let rec {
                return "\(electric ? "Charge" : "Fuel") is low. Nearest \(electric ? "charger" : "gas") is \(rec.name), in \(VoiceAnnouncements.spokenMiles(rec.ahead))."
            }
            return "\(electric ? "Charge" : "Fuel") is low, and nothing is listed ahead."
        }
        return nil
    }
}
