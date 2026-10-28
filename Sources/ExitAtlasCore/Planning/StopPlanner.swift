import Foundation

/// "Find a hotel about 3 hours ahead", "next rest area with bathrooms", "Starbucks within 30 miles".
public struct StopQuery: Sendable {
    public enum Window: Sendable {
        /// Between two distances ahead of the driver, in meters.
        case distanceAhead(ClosedRange<Double>)
        /// Around a driving time ahead, plus or minus a tolerance, in seconds.
        case timeAhead(TimeInterval, tolerance: TimeInterval)
    }

    public var requirements: [ServiceRequirement]
    public var window: Window

    public init(requirements: [ServiceRequirement], window: Window) {
        self.requirements = requirements
        self.window = window
    }
}

public struct StopSuggestion: Sendable, Identifiable {
    public let match: AlongRouteMatch
    public let distanceAhead: Double
    public let eta: Date
    /// Seconds between this exit's ETA and the requested time (time queries only).
    public let timeFromTarget: TimeInterval?
    public var id: String { match.id }
}

public struct StopPlanner: Sendable {
    public let dataset: InterstateDataset

    public init(dataset: InterstateDataset) {
        self.dataset = dataset
    }

    /// Distance window ahead of the driver for a query, using the pace-adjusted travel time model.
    public func distanceWindow(for window: StopQuery.Window, plan: TripPlan, from d: Double,
                               pace: PaceModel) -> ClosedRange<Double> {
        switch window {
        case let .distanceAhead(range):
            return (d + range.lowerBound)...(d + range.upperBound)
        case let .timeAhead(seconds, tolerance):
            let profile = plan.route.timeProfile
            let lo = profile.distance(after: max(0, seconds - tolerance) / pace.factor, from: d)
            let hi = profile.distance(after: (seconds + tolerance) / pace.factor, from: d)
            return lo...max(lo, hi)
        }
    }

    public func suggestions(_ query: StopQuery, plan: TripPlan, snapshot: TripSnapshot, pace: PaceModel,
                            now: Date) -> [StopSuggestion] {
        let d = snapshot.progress
        let range = distanceWindow(for: query.window, plan: plan, from: d, pace: pace)
        let search = AlongRouteSearch(dataset: dataset)
        let matches = search.search(AlongRouteQuery(requirements: query.requirements,
                                                    fromDistance: range.lowerBound, toDistance: range.upperBound),
                                    exits: plan.exits)
        var target: Date?
        if case let .timeAhead(seconds, _) = query.window { target = now.addingTimeInterval(seconds) }
        let suggestions = matches.map { m -> StopSuggestion in
            let seconds = plan.route.timeProfile.seconds(from: d, to: m.exit.distanceAlongRoute) * pace.factor
            let eta = now.addingTimeInterval(seconds)
            return StopSuggestion(match: m, distanceAhead: m.exit.distanceAlongRoute - d, eta: eta,
                                  timeFromTarget: target.map { eta.timeIntervalSince($0) })
        }
        if target != nil {
            return suggestions.sorted { abs($0.timeFromTarget!) < abs($1.timeFromTarget!) }
        }
        return suggestions
    }
}
