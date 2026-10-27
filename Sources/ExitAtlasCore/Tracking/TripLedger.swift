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

/// Learns how the driver's actual moving pace compares with the provider's travel time model.
///
/// Only intervals with real movement count, so a rest stop delays the ETA by its own length
/// instead of making the remaining drive look slower. A 30 minute prior keeps early estimates
/// close to the provider's numbers.
public struct PaceModel: Sendable, Codable, Hashable {
    public private(set) var observedSeconds: Double = 0
    public private(set) var expectedSeconds: Double = 0
    public var priorSeconds: Double = 1800

    public init() {}

    /// Ratio of actual to expected time. Above 1 means slower than the provider predicted.
    public var factor: Double {
        let f = (observedSeconds + priorSeconds) / (expectedSeconds + priorSeconds)
        return min(max(f, 0.6), 2.0)
    }

    public mutating func observe(expected: Double, actual: Double) {
        guard expected > 0, actual > 0, actual < 600 else { return }
        expectedSeconds += expected
        observedSeconds += actual
    }

    /// Re-anchors the model to a fresh provider estimate of the remaining drive (for example
    /// MKDirections.calculateETA with live traffic). The provider number replaces local history.
    public mutating func calibrate(providerRemainingSeconds: Double, profileRemainingSeconds: Double) {
        guard providerRemainingSeconds > 0, profileRemainingSeconds > 0 else { return }
        let ratio = min(max(providerRemainingSeconds / profileRemainingSeconds, 0.6), 2.0)
        expectedSeconds = priorSeconds * 4
        observedSeconds = expectedSeconds * ratio + (ratio - 1) * priorSeconds
    }
}
