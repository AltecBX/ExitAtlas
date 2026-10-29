import Foundation

/// Traffic in the trip engine (docs/16): traffic aware arrival times from provider travel times measured on the
/// driver's own route, a stabilizer so one odd answer does not move every time on screen, slowdowns on the route
/// ahead as Road Intelligence incidents, and when a faster route is worth offering. Provider agnostic: each
/// provider converts its answers to these shapes. Port of web/js/engine/traffic.js, tested on the same fixtures
/// (Fixtures/traffic/cases.json).
///
/// Checkpoints are only ever times the provider computed along this route (the next state line, the next stop,
/// the destination); nothing is spread from a whole route total.
public enum Traffic {
    public struct Rules: Sendable {
        /// A reading older than this is stale: arrival times fall back to the driver's pace and say so.
        public var maxAge: TimeInterval = 900
        /// The driver may be this far behind where a reading was measured (GPS jitter) and still use it.
        public var behindTolerance = 300.0
        /// A new reading that moves the arrival by no more than this is taken at once.
        public var driftSeconds: TimeInterval = 120
        /// A larger move must be seen again, in the same direction, within this time before it is shown.
        public var confirmWithin: TimeInterval = 900
        /// Slowdowns adding less than this (when the provider gives a delay) are not shown.
        public var minDelaySeconds: TimeInterval = 60
        public init() {}
    }

    public struct Checkpoint: Sendable, Equatable {
        /// Meters along the route.
        public var along: Double
        /// Provider driving seconds from the reading's start.
        public var seconds: Double
        public init(along: Double, seconds: Double) { self.along = along; self.seconds = seconds }
    }

    /// Provider travel times measured on one route from one position, in increasing order of distance.
    public struct Reading: Sendable, Equatable {
        public var routeId: String
        public var measuredAt: Date
        /// Meters along the route where it was measured.
        public var fromAlong: Double
        public var checkpoints: [Checkpoint]
        public var source: RoadIntel.Source
        public init(routeId: String, measuredAt: Date, fromAlong: Double, checkpoints: [Checkpoint], source: RoadIntel.Source) {
            self.routeId = routeId
            self.measuredAt = measuredAt
            self.fromAlong = fromAlong
            self.checkpoints = checkpoints
            self.source = source
        }

        public var lastAlong: Double? { checkpoints.last?.along }
    }

    public enum Problem: String, Sendable { case empty, otherRoute = "other route", stale, behind, passed }

    /// What an arrival time is based on.
    public enum Basis: String, Sendable {
        /// A usable reading covers the target.
        case traffic
        /// A reading covers part of the way, the driver's pace the rest.
        case trafficThenPace
        /// The driver's pace, no traffic data.
        case pace
        /// Routing road speeds only: no traffic data and no pace yet.
        case model

        public var label: String {
            switch self {
            case .traffic: return "With traffic"
            case .trafficThenPace: return "With traffic, then your pace"
            case .pace: return "Your pace, no traffic data"
            case .model: return "Road speeds, no traffic data"
            }
        }
    }

    /// How the route's own time model and the driver's pace turn distance into seconds.
    public struct Timing {
        /// The route's modeled seconds between two distances.
        public var modelSeconds: (Double, Double) -> Double
        /// The pace model's predicted seconds for that much modeled time from here.
        public var paceSeconds: (Double) -> Double
        public init(modelSeconds: @escaping (Double, Double) -> Double, paceSeconds: @escaping (Double) -> Double) {
            self.modelSeconds = modelSeconds
            self.paceSeconds = paceSeconds
        }
    }

    /// Provider seconds from the reading's start to `x`, interpolating between checkpoints by the route's
    /// modeled time, or nil beyond the last checkpoint.
    static func readingSeconds(_ r: Reading, _ x: Double, _ modelSeconds: (Double, Double) -> Double) -> Double? {
        let pts = [Checkpoint(along: r.fromAlong, seconds: 0)] + r.checkpoints
        if x <= pts[0].along { return 0 }
        for i in 1..<pts.count where x <= pts[i].along {
            let a = pts[i - 1], b = pts[i]
            let span = modelSeconds(a.along, b.along)
            let share = span > 0 ? modelSeconds(a.along, x) / span : (x - a.along) / max(1, b.along - a.along)
            return a.seconds + (b.seconds - a.seconds) * min(1, max(0, share))
        }
        return nil
    }

    /// Why a reading cannot be used now, or nil when it can.
    public static func problem(_ r: Reading?, routeId: String, progress: Double, now: Date, rules: Rules = Rules()) -> Problem? {
        guard let r, let last = r.lastAlong else { return .empty }
        if r.routeId != routeId { return .otherRoute }
        if now.timeIntervalSince(r.measuredAt) > rules.maxAge { return .stale }
        if progress < r.fromAlong - rules.behindTolerance { return .behind }
        if progress >= last { return .passed }
        return nil
    }

    /// Driving seconds from `progress` to `target`: the provider's times where the reading covers the road, then
    /// the driver's pace for the rest. The pace part starts where the reading ends, so the near term (where the
    /// recent pace already reflects today's traffic) is never counted twice.
    public static func seconds(_ r: Reading, from progress: Double, to target: Double, timing: Timing) -> Double {
        guard let last = r.checkpoints.last else { return timing.paceSeconds(timing.modelSeconds(progress, target)) }
        let from = max(progress, r.fromAlong)
        let here = readingSeconds(r, from, timing.modelSeconds) ?? 0
        if target <= last.along { return max(0, (readingSeconds(r, target, timing.modelSeconds) ?? last.seconds) - here) }
        let covered = last.seconds - here
        return covered + timing.paceSeconds(timing.modelSeconds(progress, target)) - timing.paceSeconds(timing.modelSeconds(progress, last.along))
    }

    public static func basis(_ r: Reading?, usable: Bool, target: Double, paceKnown: Bool) -> Basis {
        if usable, let last = r?.lastAlong { return target <= last ? .traffic : .trafficThenPace }
        return paceKnown ? .pace : .model
    }

    /// The reading shown on screen, and a larger move waiting for a second reading to confirm it.
    public struct Stabilizer: Sendable {
        public private(set) var shown: Reading?
        var pending: (delta: Double, at: Date)?
        public init() {}

        /// Offers a new reading (or none). A reading that moves the arrival at its farthest checkpoint the shown
        /// one also covers by more than `driftSeconds` replaces the shown one only when a second reading confirms
        /// the move (same direction, within `confirmWithin`); until then the shown reading stays while usable.
        /// With nothing usable shown, a new reading is taken at once. Returns the reading to use and whether it changed.
        public mutating func offer(_ incoming: Reading?, routeId: String, progress: Double, now: Date, timing: Timing,
                                   rules: Rules = Rules()) -> (reading: Reading?, changed: Bool) {
            func usable(_ r: Reading?) -> Bool { r != nil && problem(r, routeId: routeId, progress: progress, now: now, rules: rules) == nil }
            if !usable(shown) { shown = nil }
            guard let incoming, usable(incoming) else { return (shown, false) }
            guard let current = shown, let a = incoming.lastAlong, let b = current.lastAlong else {
                shown = incoming
                pending = nil
                return (incoming, true)
            }
            let target = min(a, b)
            let delta = seconds(incoming, from: progress, to: target, timing: timing) - seconds(current, from: progress, to: target, timing: timing)
            let confirmed = pending.map { ($0.delta < 0) == (delta < 0) && now.timeIntervalSince($0.at) <= rules.confirmWithin } ?? false
            if abs(delta) <= rules.driftSeconds || confirmed {
                shown = incoming
                pending = nil
                return (incoming, true)
            }
            pending = (delta, now)
            return (current, false)
        }
    }

    public enum Level: String, Sendable { case slow, heavy, stopped }

    /// A slowdown a provider measured on the route.
    public struct Section: Sendable {
        public var from: Double
        public var to: Double
        public var level: Level?
        public var delaySeconds: Double?
        public var speedMph: Double?
        public init(from: Double, to: Double, level: Level?, delaySeconds: Double?, speedMph: Double?) {
            self.from = from
            self.to = to
            self.level = level
            self.delaySeconds = delaySeconds
            self.speedMph = speedMph
        }
    }

    /// Slowdown sections a provider measured on this route, as Road Intelligence incidents. Sections behind
    /// `progress`, with no known level, or adding under a minute are dropped. The geometry is the route itself:
    /// the provider measured these on the driver's route and direction, so they need no position matching.
    public static func slowdownIncidents(_ sections: [Section], routeId: String, progress: Double, measuredAt: Date,
                                         source: RoadIntel.Source, rules: Rules = Rules()) -> [RoadIntel.Incident] {
        sections.compactMap { s in
            guard let level = s.level, s.to > progress, s.to > s.from else { return nil }
            if let d = s.delaySeconds, d < rules.minDelaySeconds { return nil }
            let severity: RoadIntel.Severity = level == .slow ? .moderate : level == .heavy ? .major : .severe
            let description = level == .slow ? "Slow traffic" : level == .heavy ? "Heavy traffic" : "Stopped traffic"
            var i = RoadIntel.Incident(id: "traffic:\(source.id):\(routeId):\(Int(s.from.rounded()))", kind: .congestion,
                                       description: description, source: source, verification: .measured,
                                       reportedAt: measuredAt, updatedAt: measuredAt, expiresAt: measuredAt.addingTimeInterval(rules.maxAge),
                                       geometry: .route(routeId: routeId, from: s.from, to: s.to), severity: severity)
            i.delaySeconds = s.delaySeconds
            i.speedMph = s.speedMph
            return i
        }
    }

    // MARK: Faster routes

    public struct AlternativeRules: Sendable {
        /// The smallest saving worth an offer (the driver can raise it in Settings).
        public var minSavingSeconds: TimeInterval = 600
        /// ...and at least this share of the time left, so a long trip needs a real gain.
        public var minSavingShare = 0.05
        /// An alternative more than this share longer in distance is not offered.
        public var maxExtraDistanceShare = 0.25
        /// The saving must hold this many checks in a row...
        public var confirmations = 2
        /// ...with no more than this between them.
        public var confirmWithin: TimeInterval = 900
        /// After "Not now", the same alternative is not offered again for this long unless it saves this much more.
        public var snoozeSeconds: TimeInterval = 1800
        public var snoozeExtraSeconds: TimeInterval = 600
        public init() {}
    }

    public struct CurrentRoute: Sendable {
        public var seconds: Double
        public var meters: Double
        public var closureAhead: Bool
        public init(seconds: Double, meters: Double, closureAhead: Bool) {
            self.seconds = seconds
            self.meters = meters
            self.closureAhead = closureAhead
        }
    }

    public struct Alternative: Sendable {
        public var id: String
        public var seconds: Double
        public var meters: Double
        /// true, false, or nil when the provider does not say.
        public var tolls: Bool?
        /// Every planned stop is still on it.
        public var keepsStops: Bool
        public var closureAhead: Bool
        /// The recommended stop (by name) that is not on it, if any.
        public var missesStop: String?
        public init(id: String, seconds: Double, meters: Double, tolls: Bool?, keepsStops: Bool, closureAhead: Bool, missesStop: String?) {
            self.id = id
            self.seconds = seconds
            self.meters = meters
            self.tolls = tolls
            self.keepsStops = keepsStops
            self.closureAhead = closureAhead
            self.missesStop = missesStop
        }
    }

    public struct Offer: Sendable, Equatable {
        public let id: String
        public let savedSeconds: Double
        public let extraMeters: Double
        public let notes: [String]
    }

    public enum Hold: String, Sendable {
        case dropsStop = "drops a planned stop", closure = "a closure on the alternative", tolls
        case belowThreshold = "saving below the threshold", tooFar = "too much farther", snoozed
        case waiting = "waiting for a second check"
    }

    /// Whether to offer a faster route. Both times must come from the same provider measurement with traffic, to
    /// the same point (the next stop or the destination); nothing is compared across sources.
    public struct Advisor: Sendable {
        var candidate: (id: String, seen: Int, at: Date)?
        var snoozed: (id: String, until: Date, saving: Double)?
        public init() {}

        public mutating func advise(current: CurrentRoute, alternative: Alternative, minSavingSeconds: TimeInterval, avoidTolls: Bool,
                                    now: Date, rules: AlternativeRules = AlternativeRules()) -> (offer: Offer?, hold: Hold?) {
            func none(_ h: Hold) -> (Offer?, Hold?) { candidate = nil; return (nil, h) }
            if !alternative.keepsStops { return none(.dropsStop) }
            if alternative.closureAhead { return none(.closure) }
            if avoidTolls && alternative.tolls == true { return none(.tolls) }
            let saved = current.seconds - alternative.seconds
            if saved < max(minSavingSeconds, rules.minSavingShare * current.seconds) { return none(.belowThreshold) }
            let extra = alternative.meters - current.meters
            if extra > rules.maxExtraDistanceShare * current.meters { return none(.tooFar) }
            if let s = snoozed, s.id == alternative.id, now < s.until, saved < s.saving + rules.snoozeExtraSeconds { return (nil, .snoozed) }
            let seen = candidate.map { $0.id == alternative.id && now.timeIntervalSince($0.at) <= rules.confirmWithin ? $0.seen + 1 : 1 } ?? 1
            candidate = (alternative.id, seen, now)
            if seen < rules.confirmations { return (nil, .waiting) }
            var notes: [String] = []
            let mi = Int((abs(extra) / Geodesy.metersPerMile).rounded())
            if mi >= 1 { notes.append("\(mi) mi \(extra > 0 ? "longer" : "shorter")") }
            if alternative.tolls == true { notes.append("Tolls listed") } else if alternative.tolls == false { notes.append("No tolls listed") }
            if current.closureAhead { notes.append("Avoids the closure ahead") }
            if let stop = alternative.missesStop { notes.append("Your \(stop) is not on this route") }
            return (Offer(id: alternative.id, savedSeconds: saved, extraMeters: extra, notes: notes), nil)
        }

        /// "Not now": the same alternative is held back for a while.
        public mutating func snooze(_ offer: Offer, now: Date, rules: AlternativeRules = AlternativeRules()) {
            candidate = nil
            snoozed = (offer.id, now.addingTimeInterval(rules.snoozeSeconds), offer.savedSeconds)
        }
    }
}
