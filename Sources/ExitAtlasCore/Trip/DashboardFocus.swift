import Foundation

/// The adaptive Drive screen: one adaptive card (the most relevant item) and a "Then" strip with the next
/// two, over the fixed instruments, state line and next exit. Nothing is ever added as an extra card. Port of web/js/engine/dashboard.js, tested
/// on the same fixtures (Tests/ExitAtlasCoreTests/Fixtures/dashboard/focus.json).
public enum DashboardFocus {
    public enum Kind: String, Sendable {
        case fuel, alert, stop, gap, border, lastOpen, overnight, restArea, exit, none
        /// No range entered yet (strip only).
        case fuelEntry
    }

    public struct Signals: Sendable {
        public struct Fuel: Sendable {
            public var range: Double
            public var reserve: Double
            /// Meters to the recommended stop, nil when there is none.
            public var stopAhead: Double?
            public var low: Bool

            public init(range: Double, reserve: Double, stopAhead: Double?, low: Bool = false) {
                self.range = range
                self.reserve = reserve
                self.stopAhead = stopAhead
                self.low = low
            }
        }

        /// Meters to each item, nil when there is none.
        public var nextExit: Double?
        public var restArea: Double?
        /// Meters to the start of the next stretch without gas (0 inside it) and its length.
        public var gap: (startsIn: Double, length: Double)?
        public var plannedStop: Double?
        /// nil when no range has been entered.
        public var fuel: Fuel?
        public var overnight: Bool
        /// Meters to the last stop listed open before a long overnight stretch (`SmartStop.lastOpenBeforeGap`).
        public var lastOpen: Double?
        /// The nearest road alert ahead (`RoadIntel`).
        public var alert: (distance: Double, serious: Bool)?
        /// That alert's incident id, so the stabilizer can keep an alert that disappeared from bouncing back.
        public var alertID: String?
        /// Meters to the next state line, nil in the last state.
        public var border: Double?

        public init(nextExit: Double? = nil, restArea: Double? = nil, gap: (startsIn: Double, length: Double)? = nil,
                    plannedStop: Double? = nil, fuel: Fuel? = nil, overnight: Bool = false, lastOpen: Double? = nil,
                    alert: (distance: Double, serious: Bool)? = nil, alertID: String? = nil, border: Double? = nil) {
            self.nextExit = nextExit
            self.restArea = restArea
            self.gap = gap
            self.plannedStop = plannedStop
            self.fuel = fuel
            self.overnight = overnight
            self.lastOpen = lastOpen
            self.alert = alert
            self.alertID = alertID
            self.border = border
        }
    }

    public struct Rules: Sendable {
        public var stopWithin = 15 * Geodesy.metersPerMile
        public var gapWithin = 25 * Geodesy.metersPerMile
        public var fuelWithin = 30 * Geodesy.metersPerMile
        public var restAreaWithin = 10 * Geodesy.metersPerMile
        public var seriousAlertWithin = 50 * Geodesy.metersPerMile
        public var alertWithin = 10 * Geodesy.metersPerMile
        /// A serious alert this close comes before everything, fuel below the reserve included.
        public var seriousAlertNow = 10 * Geodesy.metersPerMile
        /// The next state line this close takes the focus (miles to the line, exits left, the next state).
        public var borderWithin = 5 * Geodesy.metersPerMile
        public var stripWithin = 150 * Geodesy.metersPerMile
        public var stripSize = 2

        public init() {}
    }

    public struct Result: Sendable, Equatable {
        public let focus: Kind
        public let strip: [Kind]
        public let why: String
        /// The rule that chose the focus: 0 is the most urgent.
        public let rank: Int
        /// Every rule that holds, in order (each kind once, at its most urgent rule).
        public let qualifying: [Qualifying]
        /// The kinds that have something to show.
        public let available: Set<Kind>
        /// True when the stabilizer kept the card shown over this reading's pick.
        public var held = false

        public struct Qualifying: Sendable, Equatable {
            public let kind: Kind
            public let rank: Int
            public let why: String
        }
    }

    public static func choose(_ s: Signals, rules: Rules = Rules()) -> Result {
        let fuelLow = s.fuel.map { $0.low || $0.range < $0.reserve } ?? false
        // A gap matters when the range is unknown or would not carry past it with the reserve.
        let gapRisk: Bool = {
            guard let gap = s.gap, gap.startsIn <= rules.gapWithin else { return false }
            guard let f = s.fuel else { return true }
            return f.range - f.reserve < gap.startsIn + gap.length
        }()
        let fuelSoon = s.fuel?.stopAhead.map { $0 <= rules.fuelWithin } ?? false
        let restFirst = s.restArea.map { r in r <= rules.restAreaWithin && (s.nextExit.map { r < $0 } ?? true) } ?? false
        let alertNear = s.alert.map { $0.distance <= ($0.serious ? rules.seriousAlertWithin : rules.alertWithin) } ?? false
        let serious = s.alert?.serious ?? false

        // Every rule in order; the first that holds takes the focus. A routine pick never hides a serious alert
        // just ahead, and fuel below the reserve comes before a serious alert farther away.
        let order: [(Kind, Bool, String)] = [
            (.alert, alertNear && serious && s.alert!.distance <= rules.seriousAlertNow, "A serious road alert just ahead"),
            (.fuel, fuelLow, "Fuel is below your reserve"),
            (.alert, alertNear && serious, "A serious road alert ahead"),
            (.stop, s.plannedStop.map { $0 <= rules.stopWithin } ?? false, "Approaching your planned stop"),
            (.gap, gapRisk, "A stretch without gas is coming up"),
            (.alert, alertNear, "A road alert just ahead"),
            (.border, s.border.map { $0 <= rules.borderWithin } ?? false, "Approaching the state line"),
            (.fuel, fuelSoon, "Your fuel stop is coming up"),
            (.lastOpen, s.lastOpen.map { $0 <= rules.gapWithin } ?? false, "Last stop listed open before a long stretch"),
            (.overnight, s.overnight && (s.fuel != nil || s.restArea != nil), "Overnight: open stops and restrooms"),
            (.restArea, restFirst, "Rest area before the next exit"),
            (.exit, s.nextExit != nil, "Next exit"),
            (.restArea, s.restArea != nil, "Next rest area"),
        ]
        var qualifying: [Result.Qualifying] = []
        for (rank, (kind, holds, why)) in order.enumerated() where holds && !qualifying.contains(where: { $0.kind == kind }) {
            qualifying.append(.init(kind: kind, rank: rank, why: why))
        }
        let first = qualifying.first ?? .init(kind: .none, rank: order.count, why: "Nothing ahead on this road")

        var available: Set<Kind> = [.none]
        if s.alert != nil { available.insert(.alert) }
        if s.fuel != nil { available.insert(.fuel) }
        if s.plannedStop != nil { available.insert(.stop) }
        if s.gap != nil { available.insert(.gap) }
        if s.border != nil { available.insert(.border) }
        if s.lastOpen != nil { available.insert(.lastOpen) }
        if s.overnight && (s.fuel != nil || s.restArea != nil) { available.insert(.overnight) }
        if s.restArea != nil { available.insert(.restArea) }
        if s.nextExit != nil { available.insert(.exit) }

        return Result(focus: first.kind, strip: strip(s, focus: first.kind, rules: rules), why: first.why, rank: first.rank,
                      qualifying: qualifying, available: available)
    }

    /// The strip under a focus card: the next most useful items, never the focus again.
    public static func strip(_ s: Signals, focus: Kind, rules: Rules = Rules()) -> [Kind] {
        func near(_ d: Double?) -> Bool { d.map { $0 <= rules.stripWithin } ?? false }
        var candidates: [Kind] = []
        if let f = s.fuel, near(f.stopAhead) { candidates.append(.fuel) }
        if s.fuel == nil { candidates.append(.fuelEntry) }
        if near(s.gap?.startsIn) { candidates.append(.gap) }
        if near(s.alert?.distance) { candidates.append(.alert) }
        if near(s.plannedStop) { candidates.append(.stop) }
        if near(s.restArea) { candidates.append(.restArea) }
        if s.nextExit != nil { candidates.append(.exit) }
        let covered: Set<Kind> = focus == .overnight ? [focus, .fuel] : [focus]
        return Array(candidates.filter { !covered.contains($0) }.prefix(rules.stripSize))
    }

    public struct Stability: Sendable {
        /// A card stays at least this long unless something more urgent qualifies.
        public var holdSeconds: TimeInterval = 30
        /// A new card must win this many readings in a row before it replaces the one shown.
        public var confirmReadings = 2
        /// Rules at or above this rank (a serious alert just ahead, fuel below the reserve) replace the card at once.
        public var immediateRank = 1
        /// An alert that left the route (expired, withdrawn, a feed hiccup) does not come back for this long.
        public var alertCooldown: TimeInterval = 600

        public init() {}
    }

    /// Keeps the focus card steady between readings: no flicker at a threshold, no card replaced by a less
    /// urgent one within `holdSeconds`, and alerts that disappear do not bounce back. Call `choose` once per
    /// position reading (the same time twice returns the same answer). Port of FocusStabilizer in
    /// web/js/engine/dashboard.js, tested on Fixtures/dashboard/stability.json.
    public final class Stabilizer {
        public let rules: Rules
        public let stability: Stability
        private var shown: Kind?
        private var shownRank = Int.max
        private var shownWhy = ""
        private var shownAt: Date = .distantPast
        private var pending: Kind?
        private var pendingCount = 0
        private var lastAlertID: String?
        private var goneAt: [String: Date] = [:]
        private var last: (at: Date, result: Result)?

        public init(rules: Rules = Rules(), stability: Stability = Stability()) {
            self.rules = rules
            self.stability = stability
        }

        public func reset() {
            shown = nil; shownRank = .max; shownWhy = ""; shownAt = .distantPast
            pending = nil; pendingCount = 0; lastAlertID = nil; goneAt = [:]; last = nil
        }

        public func choose(_ signals: Signals, at t: Date) -> Result {
            if let last, last.at == t { return last.result }
            var s = signals
            let id = s.alertID
            if let lastAlertID, lastAlertID != id { goneAt[lastAlertID] = t }
            if let id, let gone = goneAt[id] {
                if t.timeIntervalSince(gone) < stability.alertCooldown { s.alert = nil; s.alertID = nil } else { goneAt[id] = nil }
            }
            lastAlertID = s.alert != nil ? id : nil
            let result = decide(DashboardFocus.choose(s, rules: rules), s, t)
            last = (t, result)
            return result
        }

        private func decide(_ raw: Result, _ s: Signals, _ t: Date) -> Result {
            func show() -> Result {
                shown = raw.focus; shownRank = raw.rank; shownWhy = raw.why; shownAt = t
                pending = nil; pendingCount = 0
                return raw
            }
            guard let current = shown else { return show() }
            if raw.focus == current {
                shownRank = raw.rank; shownWhy = raw.why; pending = nil; pendingCount = 0
                return raw
            }
            // The card shown has nothing left to show (passed, gone): replace it now.
            if !raw.available.contains(current) { return show() }
            // Something more urgent than the card shown: at once for the top rules, else after it wins twice in a row.
            if raw.rank <= stability.immediateRank && raw.rank < shownRank { return show() }
            if pending == raw.focus { pendingCount += 1 } else { pending = raw.focus; pendingCount = 1 }
            if pendingCount >= stability.confirmReadings {
                if raw.rank < shownRank { return show() }
                // Less urgent: only once the card has been up for holdSeconds.
                if t.timeIntervalSince(shownAt) >= stability.holdSeconds { return show() }
            }
            var held = Result(focus: current, strip: DashboardFocus.strip(s, focus: current, rules: rules), why: shownWhy,
                              rank: raw.rank, qualifying: raw.qualifying, available: raw.available)
            held.held = true
            return held
        }
    }
}
