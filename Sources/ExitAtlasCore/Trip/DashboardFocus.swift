import Foundation

/// The adaptive Drive screen: a fixed set of cards (instruments, state progress, one focus card, a one
/// line "Then" strip, destination) where the most relevant item takes the focus card and the next two
/// sit in the strip. Nothing is ever added as an extra card. Port of web/js/engine/dashboard.js, tested
/// on the same fixtures (Tests/ExitAtlasCoreTests/Fixtures/dashboard/focus.json).
public enum DashboardFocus {
    public enum Kind: String, Sendable {
        case fuel, stop, gap, lastOpen, overnight, restArea, exit, none
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

        public init(nextExit: Double? = nil, restArea: Double? = nil, gap: (startsIn: Double, length: Double)? = nil,
                    plannedStop: Double? = nil, fuel: Fuel? = nil, overnight: Bool = false, lastOpen: Double? = nil) {
            self.nextExit = nextExit
            self.restArea = restArea
            self.gap = gap
            self.plannedStop = plannedStop
            self.fuel = fuel
            self.overnight = overnight
            self.lastOpen = lastOpen
        }
    }

    public struct Rules: Sendable {
        public var stopWithin = 15 * Geodesy.metersPerMile
        public var gapWithin = 25 * Geodesy.metersPerMile
        public var fuelWithin = 30 * Geodesy.metersPerMile
        public var restAreaWithin = 10 * Geodesy.metersPerMile
        public var stripWithin = 150 * Geodesy.metersPerMile
        public var stripSize = 2

        public init() {}
    }

    public struct Result: Sendable, Equatable {
        public let focus: Kind
        public let strip: [Kind]
        public let why: String
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

        let focus: Kind, why: String
        if fuelLow { (focus, why) = (.fuel, "Fuel is below your reserve") }
        else if let p = s.plannedStop, p <= rules.stopWithin { (focus, why) = (.stop, "Approaching your planned stop") }
        else if gapRisk { (focus, why) = (.gap, "A stretch without gas is coming up") }
        else if fuelSoon { (focus, why) = (.fuel, "Your fuel stop is coming up") }
        else if let l = s.lastOpen, l <= rules.gapWithin { (focus, why) = (.lastOpen, "Last stop listed open before a long stretch") }
        else if s.overnight && (s.fuel != nil || s.restArea != nil) { (focus, why) = (.overnight, "Overnight: open stops and restrooms") }
        else if restFirst { (focus, why) = (.restArea, "Rest area before the next exit") }
        else if s.nextExit != nil { (focus, why) = (.exit, "Next exit") }
        else if s.restArea != nil { (focus, why) = (.restArea, "Next rest area") }
        else { (focus, why) = (.none, "Nothing ahead on this road") }

        // The strip: the next most useful items, never the focus again.
        func near(_ d: Double?) -> Bool { d.map { $0 <= rules.stripWithin } ?? false }
        var candidates: [Kind] = []
        if let f = s.fuel, near(f.stopAhead) { candidates.append(.fuel) }
        if s.fuel == nil { candidates.append(.fuelEntry) }
        if near(s.gap?.startsIn) { candidates.append(.gap) }
        if near(s.plannedStop) { candidates.append(.stop) }
        if near(s.restArea) { candidates.append(.restArea) }
        if s.nextExit != nil { candidates.append(.exit) }
        let covered: Set<Kind> = focus == .overnight ? [focus, .fuel] : [focus]
        return Result(focus: focus, strip: Array(candidates.filter { !covered.contains($0) }.prefix(rules.stripSize)), why: why)
    }
}
