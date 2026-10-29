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
    /// Also suggest rest areas and service plazas on the highway (no detour).
    public var includeRestAreas: Bool
    /// Favorite brands rank higher.
    public var favorites: [String]

    public init(requirements: [ServiceRequirement], window: Window, includeRestAreas: Bool = false, favorites: [String] = []) {
        self.requirements = requirements
        self.window = window
        self.includeRestAreas = includeRestAreas
        self.favorites = favorites
    }
}

/// One stop suggestion: an exit with the requested services, or a rest area on the highway, with the
/// reasons behind its rank.
public struct StopSuggestion: Sendable, Identifiable {
    public let match: AlongRouteMatch?
    public let restArea: RouteRestArea?
    public let distanceAhead: Double
    public let eta: Date
    /// Seconds between this stop's ETA and the requested time (time queries only).
    public let timeFromTarget: TimeInterval?
    public let detourMeters: Double
    public let detourSeconds: TimeInterval
    public let favorite: Bool
    /// Restrooms as OpenStreetMap tags them (rest areas only); nil when unknown.
    public let restrooms: Bool?
    /// Lower ranks first: seconds from the target time, plus twice the detour time, minus five
    /// minutes for a favorite brand and five for listed restrooms.
    public let score: Double
    public let reasons: [String]
    public var id: String { match?.id ?? restArea?.id ?? "" }
    public var distanceAlongRoute: Double { match?.exit.distanceAlongRoute ?? restArea?.distanceAlongRoute ?? 0 }
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
            let lo = profile.distance(after: pace.modelSeconds(forSeconds: max(0, seconds - tolerance)), from: d)
            let hi = profile.distance(after: pace.modelSeconds(forSeconds: seconds + tolerance), from: d)
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
        func eta(_ along: Double) -> Date {
            now.addingTimeInterval(plan.eta(from: d, to: along, pace: pace, now: snapshot.timestamp, traffic: snapshot.traffic).timeIntervalSince(snapshot.timestamp))
        }
        func isFavorite(_ name: String) -> Bool { !name.isEmpty && RangePlanner.matchesFavorite(name, favorites: query.favorites) }
        func make(match: AlongRouteMatch?, restArea: RouteRestArea?, along: Double, detour: Double, detourSeconds: Double,
                  favorite: Bool, restrooms: Bool?) -> StopSuggestion {
            let when = eta(along)
            let fromTarget = target.map { when.timeIntervalSince($0) }
            let score = abs(fromTarget ?? 0) + 2 * detourSeconds - (favorite ? 300 : 0) - (restrooms == true ? 300 : 0)
            var reasons: [String] = []
            if let fromTarget {
                let minutes = Int((fromTarget / 60).rounded())
                reasons.append(abs(minutes) < 5 ? "Right on time" : minutes < 0 ? "\(-minutes) min early" : "\(minutes) min late")
            }
            if let restArea {
                reasons.append(restArea.side == .both ? "On the highway, both directions" : "On the highway, no detour")
            } else {
                reasons.append(String(format: "About %.1f mi detour (estimate)", detour / Geodesy.metersPerMile))
            }
            if favorite { reasons.append("Favorite brand") }
            if restrooms == true { reasons.append("Restrooms listed") }
            if restrooms == false { reasons.append("No restrooms") }
            return StopSuggestion(match: match, restArea: restArea, distanceAhead: along - d, eta: when, timeFromTarget: fromTarget,
                                  detourMeters: detour, detourSeconds: detourSeconds, favorite: favorite, restrooms: restrooms,
                                  score: score, reasons: reasons)
        }
        var suggestions = matches.map { m -> StopSuggestion in
            let best = m.matchesPerRequirement.compactMap(\.first)
            let seconds = best.reduce(0) { $0 + ($1.detourSeconds ?? $1.detourMeters / 13.4) }
            let favorite = m.matchesPerRequirement.contains { hits in
                hits.contains { isFavorite($0.place.brand.isEmpty ? $0.place.name : $0.place.brand) }
            }
            return make(match: m, restArea: nil, along: m.exit.distanceAlongRoute, detour: m.combinedDetourMeters,
                        detourSeconds: seconds, favorite: favorite, restrooms: nil)
        }
        if query.includeRestAreas {
            let nameQuery = query.requirements.compactMap { $0.nameOrBrand?.trimmingCharacters(in: .whitespaces).lowercased() }
                .first { !$0.isEmpty }
            for r in plan.restAreas(after: range.lowerBound, upTo: range.upperBound) {
                if let nameQuery, !([r.name] + r.gas + r.food).contains(where: { $0.lowercased().contains(nameQuery) }) { continue }
                suggestions.append(make(match: nil, restArea: r, along: r.distanceAlongRoute, detour: 0, detourSeconds: 0,
                                        favorite: (r.gas + r.food).contains(where: isFavorite), restrooms: r.amenities[.toilets]))
            }
        }
        if target != nil { return suggestions.sorted { $0.score < $1.score } }
        return suggestions.sorted { $0.distanceAhead < $1.distanceAhead }
    }
}
