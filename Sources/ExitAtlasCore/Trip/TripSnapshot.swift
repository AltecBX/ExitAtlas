import Foundation

/// One state segment of the itinerary, with progress and timing.
public struct SegmentForecast: Sendable, Hashable, Identifiable {
    public enum Status: String, Sendable, Codable {
        case completed, current, upcoming
    }

    public let segment: RegionSegment
    public let status: Status
    /// Meters already driven in this visit (from the trip ledger when available).
    public let drivenMeters: Double
    /// Meters left on the planned route in this visit.
    public let remainingMeters: Double
    /// Exits on the route inside this segment (all of them for upcoming segments).
    public let exitCount: Int
    /// Exits still ahead inside this segment.
    public let exitsRemaining: Int
    /// Estimated entry time for upcoming segments; nil for the current and completed ones (actual
    /// crossing times are not recorded yet).
    public let entryTime: Date?
    public let exitTime: Date?
    public let entryTimeZoneID: String?
    public let exitTimeZoneID: String?

    public var id: Int { segment.index }
    /// Total route meters for this visit: driven plus remaining.
    public var totalMeters: Double { drivenMeters + remainingMeters }
    public var fractionComplete: Double { totalMeters > 0 ? min(1, drivenMeters / totalMeters) : 0 }
    public var plannedDuration: TimeInterval? {
        guard let entryTime, let exitTime else { return nil }
        return exitTime.timeIntervalSince(entryTime)
    }
}

/// An exit ahead of the driver.
public struct UpcomingExit: Sendable, Hashable, Identifiable {
    public let exit: RouteExit
    /// Meters from the driver's position, along the route.
    public let distance: Double
    public let eta: Date
    public let stateCode: String?
    public var id: String { exit.id }
}

/// Everything the dashboard shows at one moment. Pure data, recomputed on every location update.
public struct TripSnapshot: Sendable {
    public let timestamp: Date
    public let match: RouteMatch
    public let routeLength: Double
    /// Meters along the current route.
    public let progress: Double
    public let remaining: Double
    /// Meters actually driven since the trip began, across reroutes.
    public let drivenTotal: Double
    public let eta: Date
    public let timeRemaining: TimeInterval
    /// Trip pace (actual over modeled time); see `pace` for the recent pace.
    public let paceFactor: Double
    /// The pace model used for these ETAs (also for ETAs to other points: `TripPlan.eta`).
    public let pace: PaceModel
    public let highway: SignedHighway?
    public let current: SegmentForecast?
    public let next: SegmentForecast?
    public let itinerary: [SegmentForecast]
    public let nextExit: UpcomingExit?
    public let upcomingExits: [UpcomingExit]
    /// State line crossings left on the route.
    public let borderCrossingsRemaining: Int
    /// Distinct states ahead that are different from the current one.
    public let statesAhead: [String]
    public let nextStop: (stop: RouteStop, distance: Double, eta: Date)?
    /// Actual driving history by state (survives reroutes). The last stint is the current state.
    public let drivenStints: [DrivenStint]

    /// Meters until the next state line, or nil in the last state.
    public var distanceToNextBorder: Double? { current.flatMap { next == nil ? nil : $0.remainingMeters } }
}

public extension TripPlan {
    /// Predicted arrival at `target` (meters along the route) from `d`: the modeled travel time
    /// adjusted by the pace model, plus planned dwell at stops in between.
    func eta(from d: Double, to target: Double, pace: PaceModel, now: Date) -> Date {
        var seconds = pace.seconds(forModelSeconds: route.timeProfile.seconds(from: d, to: target))
        for stop in route.stops where stop.distanceAlongRoute > d && stop.distanceAlongRoute < target {
            seconds += stop.plannedDwell
        }
        return now.addingTimeInterval(seconds)
    }

    /// Builds the dashboard snapshot for the current match.
    func snapshot(match: RouteMatch, ledger: TripLedger, pace: PaceModel, now: Date,
                  exitLookahead: Double = 100 * Geodesy.metersPerMile, maxUpcomingExits: Int = 200) -> TripSnapshot {
        let d = min(max(match.distanceAlongRoute, 0), route.length)
        func eta(to target: Double) -> Date { self.eta(from: d, to: target, pace: pace, now: now) }

        let currentIndex = states.segmentIndex(at: d)
        let lastStint = ledger.stints.last
        var itinerary: [SegmentForecast] = []
        for seg in states.segments {
            let status: SegmentForecast.Status
            if let ci = currentIndex {
                status = seg.index < ci ? .completed : (seg.index == ci ? .current : .upcoming)
            } else {
                status = .upcoming
            }
            let entryTZ = timeZoneIDAtSegmentStart(seg.index)
            let exitTZ = seg.index + 1 < states.segments.count ? timeZoneIDAtSegmentStart(seg.index + 1) : timeZoneID(at: seg.endDistance)
            switch status {
            case .completed:
                itinerary.append(SegmentForecast(
                    segment: seg, status: .completed, drivenMeters: seg.length, remainingMeters: 0,
                    exitCount: exitCount(after: seg.startDistance, before: seg.endDistance), exitsRemaining: 0,
                    entryTime: nil, exitTime: nil, entryTimeZoneID: entryTZ, exitTimeZoneID: exitTZ))
            case .current:
                var driven = d - seg.startDistance
                var entered: Date? = nil
                if let lastStint, lastStint.regionCode == seg.code {
                    driven = max(driven, lastStint.meters)
                    entered = lastStint.enteredAt
                }
                itinerary.append(SegmentForecast(
                    segment: seg, status: .current, drivenMeters: driven, remainingMeters: seg.endDistance - d,
                    exitCount: exitCount(after: seg.startDistance, before: seg.endDistance),
                    exitsRemaining: exitCount(after: d, before: seg.endDistance),
                    entryTime: entered, exitTime: eta(to: seg.endDistance),
                    entryTimeZoneID: entryTZ, exitTimeZoneID: exitTZ))
            case .upcoming:
                itinerary.append(SegmentForecast(
                    segment: seg, status: .upcoming, drivenMeters: 0, remainingMeters: seg.length,
                    exitCount: exitCount(after: seg.startDistance, before: seg.endDistance),
                    exitsRemaining: exitCount(after: seg.startDistance, before: seg.endDistance),
                    entryTime: eta(to: seg.startDistance), exitTime: eta(to: seg.endDistance),
                    entryTimeZoneID: entryTZ, exitTimeZoneID: exitTZ))
            }
        }

        let current = currentIndex.map { itinerary[$0] }
        let next = currentIndex.flatMap { $0 + 1 < itinerary.count ? itinerary[$0 + 1] : nil }
        let upcomingSlice = exits(after: d, upTo: d + exitLookahead).prefix(maxUpcomingExits)
        let upcoming = upcomingSlice.map { e in
            UpcomingExit(exit: e, distance: e.distanceAlongRoute - d, eta: eta(to: e.distanceAlongRoute),
                         stateCode: states.segment(at: e.distanceAlongRoute)?.code)
        }
        let nextExitRecord = nextExit(after: d).map { e in
            UpcomingExit(exit: e, distance: e.distanceAlongRoute - d, eta: eta(to: e.distanceAlongRoute),
                         stateCode: states.segment(at: e.distanceAlongRoute)?.code)
        }
        let ahead = itinerary.filter { $0.status == .upcoming }
        var statesAhead: [String] = []
        for f in ahead {
            if let code = f.segment.code, code != current?.segment.code, !statesAhead.contains(code) {
                statesAhead.append(code)
            }
        }
        let nextStop = route.stops.first { $0.distanceAlongRoute > d }.map { stop in
            (stop, stop.distanceAlongRoute - d, eta(to: stop.distanceAlongRoute))
        }
        let arrival = eta(to: route.length)
        return TripSnapshot(
            timestamp: now, match: match, routeLength: route.length, progress: d, remaining: route.length - d,
            drivenTotal: max(ledger.totalMeters, d), eta: arrival, timeRemaining: arrival.timeIntervalSince(now),
            paceFactor: pace.factor, pace: pace, highway: route.highway(at: d), current: current, next: next, itinerary: itinerary,
            nextExit: nextExitRecord, upcomingExits: Array(upcoming),
            borderCrossingsRemaining: ahead.count, statesAhead: statesAhead, nextStop: nextStop,
            drivenStints: ledger.stints)
    }
}
