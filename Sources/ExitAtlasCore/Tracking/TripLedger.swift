import Foundation

/// Distance actually driven in one state during one continuous visit.
public struct DrivenStint: Sendable, Codable, Hashable {
    public var regionCode: String?
    public var regionName: String
    public var meters: Double
    public var enteredAt: Date?
    public var exitedAt: Date?
}

/// What has actually been driven, by state, across route changes.
///
/// The planned route can be replaced (reroute, stop added) at any time, so completed state
/// mileage is never read back from the current route. It accumulates here from tracked
/// progress, and from GPS distance while off route.
public struct TripLedger: Sendable, Codable, Hashable {
    public private(set) var stints: [DrivenStint] = []
    public private(set) var startedAt: Date?

    public init() {}

    public var totalMeters: Double { stints.reduce(0) { $0 + $1.meters } }

    /// Meters driven in each state across all visits, in order of first entry.
    public var totalsByRegion: [(code: String?, name: String, meters: Double)] {
        var order: [String] = []
        var meters: [String: Double] = [:], names: [String: String] = [:], codes: [String: String?] = [:]
        for s in stints {
            let key = s.regionCode ?? "-"
            if meters[key] == nil { order.append(key) }
            meters[key, default: 0] += s.meters
            names[key] = s.regionName
            codes[key] = s.regionCode
        }
        return order.map { (codes[$0] ?? nil, names[$0] ?? $0, meters[$0] ?? 0) }
    }

    /// Records on-route progress from d0 to d1, split across the route's state segments.
    /// Times at state crossings are interpolated linearly between the two fixes.
    public mutating func recordRouteProgress(from d0: Double, to d1: Double, states: RegionProfile,
                                             startTime: Date, endTime: Date) {
        guard d1 > d0 else { return }
        if startedAt == nil { startedAt = startTime }
        let span = d1 - d0
        let duration = endTime.timeIntervalSince(startTime)
        var cursor = d0
        while cursor < d1 {
            guard let index = states.segmentIndex(at: cursor) else { return }
            let segment = states.segments[index]
            let pieceEnd = min(d1, segment.endDistance > cursor ? segment.endDistance : d1)
            let fractionStart = (cursor - d0) / span
            let timeAtStart = startTime.addingTimeInterval(duration * fractionStart)
            add(meters: pieceEnd - cursor, code: segment.code, name: segment.displayName, at: timeAtStart)
            if pieceEnd <= cursor { break }
            cursor = pieceEnd
        }
    }

    /// Records distance driven off the planned route (measured from GPS), in the state at the fix.
    public mutating func recordOffRoute(meters: Double, region: Region?, at time: Date) {
        guard meters > 0 else { return }
        if startedAt == nil { startedAt = time }
        add(meters: meters, code: region?.code, name: region?.name ?? "Outside U.S. states", at: time)
    }

    private mutating func add(meters: Double, code: String?, name: String, at time: Date) {
        guard meters > 0 else { return }
        if var last = stints.last, last.regionCode == code {
            last.meters += meters
            stints[stints.count - 1] = last
        } else {
            if !stints.isEmpty { stints[stints.count - 1].exitedAt = time }
            stints.append(DrivenStint(regionCode: code, regionName: name, meters: meters, enteredAt: time, exitedAt: nil))
        }
    }
}

/// Learns the driver's moving pace against the travel time model (the same model as the web version).
///
/// Both estimates are ratios of actual to modeled seconds over moving time only, so stops never
/// count as slow driving:
///   * recent pace: about the last 5 minutes of moving time;
///   * trip pace: everything driven this trip, with a 15 minute prior centered on the driver's
///     pace from earlier trips (or the model when there is no history).
/// Predicted time to a target is the integral of the pace over the modeled road ahead: the next
/// 30 modeled minutes at the recent pace, then shifting to trip pace with a 1 hour time constant.
/// The prediction always increases with distance, so ETAs along the route stay in order.
public struct PaceModel: Sendable, Codable, Hashable {
    /// Seconds of moving time over which recent pace fades (exponential time constant).
    public static let recentTau: Double = 300
    /// Modeled seconds ahead that are predicted entirely at the recent pace.
    public static let recentHorizon: Double = 1800
    /// Beyond the horizon, the prediction moves from recent to trip pace with this time constant.
    public static let blendTau: Double = 3600

    public private(set) var observedSeconds: Double = 0
    public private(set) var expectedSeconds: Double = 0
    public var priorSeconds: Double = 900
    /// The driver's usual pace from earlier trips (1 means the model).
    public private(set) var priorFactor: Double = 1
    public private(set) var recentObserved: Double = 0
    public private(set) var recentExpected: Double = 0
    public private(set) var recentMeters: Double = 0

    public init(priorFactor: Double = 1) {
        self.priorFactor = Self.clamp(priorFactor)
    }

    static func clamp(_ f: Double) -> Double { min(max(f, 0.4), 2.5) }

    /// Trip ratio of actual to modeled time. Below 1 means faster than the model.
    public var factor: Double {
        Self.clamp((observedSeconds + priorSeconds * priorFactor) / (expectedSeconds + priorSeconds))
    }

    /// Ratio over about the last 5 minutes of moving time, or nil with under 2 minutes of data.
    public var recentFactor: Double? {
        guard recentObserved >= 120, recentExpected > 0 else { return nil }
        return Self.clamp(recentObserved / recentExpected)
    }

    /// Average moving speed over the recent window (m/s), or nil.
    public var recentSpeed: Double? {
        recentObserved >= 120 ? recentMeters / recentObserved : nil
    }

    /// Predicted driving seconds for a stretch the model says takes `modelSeconds`.
    public func seconds(forModelSeconds modelSeconds: Double) -> Double {
        let s = max(0, modelSeconds)
        let trip = factor
        guard let recent = recentFactor else { return trip * s }
        // Integral of the weight of recent pace: 1 up to the horizon, then exponential decay.
        let h = Self.recentHorizon, tau = Self.blendTau
        let w = s <= h ? s : h + tau * (1 - exp(-(s - h) / tau))
        return trip * s + (recent - trip) * w
    }

    /// Average factor over a stretch of `modelSeconds` (predicted seconds / modeled seconds).
    public func factor(forModelSeconds modelSeconds: Double) -> Double {
        guard modelSeconds > 0 else { return recentFactor ?? factor }
        return seconds(forModelSeconds: modelSeconds) / modelSeconds
    }

    /// Modeled seconds that take `seconds` of predicted driving (inverse of `seconds(forModelSeconds:)`).
    public func modelSeconds(forSeconds seconds: Double) -> Double {
        var lo = 0.0, hi = max(1, seconds / 0.4)
        for _ in 0..<60 {
            let mid = (lo + hi) / 2
            if self.seconds(forModelSeconds: mid) < seconds { lo = mid } else { hi = mid }
        }
        return (lo + hi) / 2
    }

    public mutating func observe(expected: Double, actual: Double, meters: Double = 0) {
        guard expected > 0, actual > 0, actual < 600 else { return }
        expectedSeconds += expected
        observedSeconds += actual
        let decay = exp(-actual / Self.recentTau)
        recentObserved = recentObserved * decay + actual
        recentExpected = recentExpected * decay + expected
        recentMeters = recentMeters * decay + meters
    }

    // Records saved by earlier versions have only the first three fields.
    enum CodingKeys: String, CodingKey {
        case observedSeconds, expectedSeconds, priorSeconds, priorFactor, recentObserved, recentExpected, recentMeters
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        observedSeconds = try c.decodeIfPresent(Double.self, forKey: .observedSeconds) ?? 0
        expectedSeconds = try c.decodeIfPresent(Double.self, forKey: .expectedSeconds) ?? 0
        priorSeconds = try c.decodeIfPresent(Double.self, forKey: .priorSeconds) ?? 900
        priorFactor = Self.clamp(try c.decodeIfPresent(Double.self, forKey: .priorFactor) ?? 1)
        recentObserved = try c.decodeIfPresent(Double.self, forKey: .recentObserved) ?? 0
        recentExpected = try c.decodeIfPresent(Double.self, forKey: .recentExpected) ?? 0
        recentMeters = try c.decodeIfPresent(Double.self, forKey: .recentMeters) ?? 0
    }
}
