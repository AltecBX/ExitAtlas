import Foundation

/// Decides what to say for state lines and exits, at most one message per snapshot. The app speaks it.
///
/// Announcements are keyed by things that survive a reroute: the state code and the odometer
/// (driven total) where the state line is expected. Segment indexes restart at 0 on every new plan,
/// so keying by index silently dropped "Welcome to" and state line messages after a reroute.
public struct VoiceAnnouncements: Sendable {
    public struct Settings: Sendable {
        public var enabled: Bool
        public var stateLines: Bool
        public var exits: Bool

        public init(enabled: Bool, stateLines: Bool, exits: Bool) {
            self.enabled = enabled
            self.stateLines = stateLines
            self.exits = exits
        }
    }

    static let borderWarning = 5 * Geodesy.metersPerMile
    static let borderMinimum = 0.5 * Geodesy.metersPerMile
    /// A state line warning counts as already given when one was given for the same state with an
    /// expected crossing within this many meters on the odometer (route changes move it a little).
    static let sameBorder = 3 * Geodesy.metersPerMile

    private var announcedExitIDs = Set<String>()
    private var announcedBorders: [(state: String, odometer: Double)] = []
    private var lastState: String?

    public init() {}

    public mutating func reset() { self = VoiceAnnouncements() }

    public mutating func message(for s: TripSnapshot, settings: Settings) -> String? {
        let state = Self.key(s.current?.segment)
        guard settings.enabled, s.match.status == .onRoute else {
            if let state { lastState = state }
            return nil
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
        if settings.exits, let next = s.nextExit, next.distance <= Geodesy.metersPerMile,
           !announcedExitIDs.contains(next.exit.id) {
            announcedExitIDs.insert(next.exit.id)
            var text = "\(next.exit.displayTitle) in \(Self.spokenMiles(next.distance))"
            if !next.exit.name.isEmpty { text += ", \(next.exit.name)" }
            return text + "."
        }
        return nil
    }

    static func key(_ segment: RegionSegment?) -> String? {
        guard let segment else { return nil }
        return segment.code ?? segment.displayName
    }

    public static func spokenMiles(_ meters: Double) -> String {
        let mi = meters / Geodesy.metersPerMile
        if mi < 0.35 { return "a quarter mile" }
        if mi < 0.75 { return "half a mile" }
        let whole = Int(mi.rounded())
        return whole == 1 ? "1 mile" : "\(whole) miles"
    }
}
