import Foundation

/// What a Live Activity shows on the Lock Screen, in the Dynamic Island, on the CarPlay Dashboard and
/// in the Apple Watch Smart Stack. Small and Codable: ActivityKit caps a Live Activity's data at 4 KB.
public struct DriveActivityContent: Codable, Hashable, Sendable {
    /// Exit number ("373", "4A-B"), nil when there is no exit ahead.
    public var exitLabel: String?
    /// The exit's name, or its services in sign words ("GAS · FOOD · LODGING").
    public var exitWords: String?
    public var exitMeters: Double?
    public var stateCode: String?
    public var nextStateCode: String?
    public var nextStateName: String?
    public var stateLineMeters: Double?
    /// Exits left before the state line (or in the last state).
    public var exitsLeftInState: Int?
    /// Raw value of `RestAreaKind`.
    public var restKind: String?
    public var restTitle: String?
    public var restMeters: Double?
    /// "Last gas for 62 mi: Exit 12", when a long stretch without gas starts within 25 miles.
    public var gasWarning: String?
    public var eta: Date?
    public var updatedAt: Date
    public var simulated: Bool
    public var offRoute: Bool

    public init(exitLabel: String? = nil, exitWords: String? = nil, exitMeters: Double? = nil, stateCode: String? = nil,
                nextStateCode: String? = nil, nextStateName: String? = nil, stateLineMeters: Double? = nil,
                exitsLeftInState: Int? = nil, restKind: String? = nil, restTitle: String? = nil, restMeters: Double? = nil,
                gasWarning: String? = nil, eta: Date? = nil, updatedAt: Date, simulated: Bool = false, offRoute: Bool = false) {
        self.exitLabel = exitLabel
        self.exitWords = exitWords
        self.exitMeters = exitMeters
        self.stateCode = stateCode
        self.nextStateCode = nextStateCode
        self.nextStateName = nextStateName
        self.stateLineMeters = stateLineMeters
        self.exitsLeftInState = exitsLeftInState
        self.restKind = restKind
        self.restTitle = restTitle
        self.restMeters = restMeters
        self.gasWarning = gasWarning
        self.eta = eta
        self.updatedAt = updatedAt
        self.simulated = simulated
        self.offRoute = offRoute
    }

    /// Builds the content from a snapshot. `services` returns an exit's services; `gasGap` is the next
    /// stretch without gas (the app's setting decides how long counts).
    /// `hasDestination` is false in discovery mode, where there is no arrival time.
    public init(snapshot s: TripSnapshot, services: (RouteExit) -> [ExitService], gasGap: GasGaps.Gap? = nil,
                hasDestination: Bool = true, simulated: Bool = false) {
        self.init(updatedAt: s.timestamp, simulated: simulated, offRoute: s.match.status == .offRoute)
        if let next = s.nextExit {
            exitLabel = next.exit.label.isEmpty ? nil : next.exit.label
            exitMeters = next.distance
            exitWords = Self.short(next.exit.name.isEmpty ? Self.words(services(next.exit)) : next.exit.name)
        }
        stateCode = s.current?.segment.code
        if let current = s.current {
            exitsLeftInState = current.exitsRemaining
            if let next = s.next {
                nextStateCode = next.segment.code
                nextStateName = next.segment.displayName
                stateLineMeters = current.remainingMeters
            }
        }
        if let rest = s.nextRestArea, rest.distance <= 150 * Geodesy.metersPerMile {
            restKind = rest.restArea.kind.rawValue
            restTitle = Self.short(rest.restArea.title)
            restMeters = rest.distance
        }
        if let gap = gasGap, let before = gap.before, before.distance - s.progress <= 25 * Geodesy.metersPerMile,
           before.distance > s.progress {
            let miles = Int((gap.length / Geodesy.metersPerMile).rounded())
            gasWarning = "Last gas for \(miles)\(gap.open ? "+" : "") mi: \(Self.short(before.title, max: 24))"
        }
        eta = hasDestination ? s.eta : nil
    }

    /// Sign words for an exit's services, in sign order.
    static func words(_ services: [ExitService]) -> String {
        let order: [(PlaceCategory, String)] = [(.gas, "GAS"), (.food, "FOOD"), (.lodging, "LODGING"), (.evCharging, "EV")]
        let present = order.filter { c in services.contains { $0.place.category == c.0 } }.map(\.1)
        return present.isEmpty ? "" : present.joined(separator: " · ")
    }

    static func short(_ text: String, max: Int = 40) -> String {
        text.count <= max ? text : String(text.prefix(max - 1)) + "…"
    }

    /// Encoded size in bytes, for the 4 KB check.
    public var encodedSize: Int { (try? JSONEncoder().encode(self).count) ?? .max }
}

/// Decides when to push new content to the Live Activity. Apple publishes no rate limit for local
/// updates but asks for updates only when content changes: a different exit, state, rest area or
/// warning updates at once; distances update when they cross a display step, at most every 15 s; and
/// the content refreshes at least every 2 minutes so the stale date keeps moving.
public struct DriveActivityThrottle: Sendable {
    public var minimumInterval: TimeInterval = 15
    public var maximumInterval: TimeInterval = 120

    public init() {}

    public func shouldUpdate(from old: DriveActivityContent?, to new: DriveActivityContent,
                             lastUpdate: Date?, now: Date) -> Bool {
        guard let old, let lastUpdate else { return true }
        if old.exitLabel != new.exitLabel || old.stateCode != new.stateCode || old.nextStateCode != new.nextStateCode
            || old.restTitle != new.restTitle || old.gasWarning != new.gasWarning || old.offRoute != new.offRoute
            || old.simulated != new.simulated {
            return true
        }
        let elapsed = now.timeIntervalSince(lastUpdate)
        if elapsed < minimumInterval { return false }
        if Self.step(old.exitMeters) != Self.step(new.exitMeters) || Self.step(old.stateLineMeters) != Self.step(new.stateLineMeters)
            || Self.step(old.restMeters) != Self.step(new.restMeters) {
            return true
        }
        return elapsed >= maximumInterval
    }

    /// The displayed value's step: tenths of a mile under 10 miles, whole miles above.
    static func step(_ meters: Double?) -> Int? {
        guard let meters else { return nil }
        let mi = max(0, meters / Geodesy.metersPerMile)
        return mi < 10 ? Int((mi * 10).rounded()) : 1000 + Int(mi.rounded())
    }
}
