import Foundation

/// A GPS fix, independent of Core Location so the engine can be tested anywhere.
public struct LocationSample: Sendable, Codable, Hashable {
    public var coordinate: GeoCoordinate
    /// Horizontal accuracy in meters. Negative means invalid.
    public var horizontalAccuracy: Double
    /// Course over ground in degrees, nil when unknown.
    public var course: Double?
    /// Speed in m/s, nil when unknown.
    public var speed: Double?
    public var timestamp: Date

    public init(coordinate: GeoCoordinate, horizontalAccuracy: Double, course: Double?, speed: Double?, timestamp: Date) {
        self.coordinate = coordinate
        self.horizontalAccuracy = horizontalAccuracy
        self.course = course
        self.speed = speed
        self.timestamp = timestamp
    }
}

/// Where the driver is on the selected route.
public struct RouteMatch: Sendable, Equatable, Codable {
    public enum Status: String, Sendable, Codable {
        /// No usable fix matched yet.
        case acquiring
        case onRoute
        /// Consistently away from the route: the app should reroute.
        case offRoute
        /// No fixes for longer than the dead reckoning limit. Distance is frozen.
        case signalLost
    }

    public var status: Status
    /// Best estimate of meters along the route.
    public var distanceAlongRoute: Double
    /// Meters from the route at the last accepted fix.
    public var offset: Double?
    /// True when the distance was extrapolated without a fresh fix (tunnels, dead zones).
    public var isEstimated: Bool
    public var timestamp: Date
    /// Smoothed speed in m/s.
    public var speed: Double

    public static func acquiring(at date: Date) -> RouteMatch {
        RouteMatch(status: .acquiring, distanceAlongRoute: 0, offset: nil, isEstimated: false, timestamp: date, speed: 0)
    }
}

/// Map matches GPS fixes onto a route polyline.
///
/// Each fix is compared with every place the route passes nearby (a route can pass the same
/// spot twice). Candidates are scored on distance from the route relative to GPS accuracy,
/// agreement between course and route bearing, and continuity with the previous position and
/// speed. Off route is declared only after several consecutive misses over a minimum duration,
/// so a single bad fix never triggers a reroute. Between fixes the position is dead reckoned
/// along the route for a limited time.
public struct RouteProgressTracker: Sendable {
    public struct Configuration: Sendable {
        /// Fixes with worse accuracy are ignored.
        public var maxAcceptableAccuracy: Double = 150
        /// Minimum distance from the route that counts as off route.
        public var offRouteDistance: Double = 60
        public var offRouteConfirmations: Int = 3
        public var offRouteMinimumDuration: TimeInterval = 6
        /// A miss that only puts the fix a little to the side (the route within twice the off route distance
        /// and the course along it, or no course) is what GPS drift looks like: off route only after this long.
        public var driftTolerance: TimeInterval = 60
        /// A route never joined (a new route the driver does not take, a trip started away from its route) is off
        /// route after this many seconds of driving (3 m/s or more) without reaching it, so it gets rerouted.
        public var acquireTimeout: TimeInterval = 60
        /// Moving with a course this many degrees from the route's bearing is a departure (a ramp curving away).
        public var departureHeading: Double = 30
        /// No fix for this long: start dead reckoning.
        public var deadReckoningAfter: TimeInterval = 4
        /// Dead reckon at most this long, then report signal lost.
        public var deadReckoningLimit: TimeInterval = 180
        /// Backward moves smaller than this are treated as GPS noise.
        public var backwardTolerance: Double = 40

        public init() {}
    }

    public let route: RoutePolyline
    public let configuration: Configuration
    public private(set) var match: RouteMatch
    private var lastAccepted: LocationSample?
    private var offRouteCount = 0
    private var firstOffRouteTime: Date?
    private var departing = false
    private var movingMiss: TimeInterval = 0
    private var lastMissTime: Date?

    public init(route: RoutePolyline, configuration: Configuration = Configuration(), startedAt: Date = Date()) {
        self.route = route
        self.configuration = configuration
        match = .acquiring(at: startedAt)
    }

    /// Feeds one GPS fix and returns the updated match.
    @discardableResult
    public mutating func ingest(_ sample: LocationSample) -> RouteMatch {
        let accuracy = sample.horizontalAccuracy
        guard accuracy >= 0, accuracy <= configuration.maxAcceptableAccuracy, sample.coordinate.isValid else {
            return estimate(at: sample.timestamp)
        }
        let threshold = max(configuration.offRouteDistance, accuracy * 1.5)
        let searchRadius = threshold * 2
        let candidates = route.projections(of: sample.coordinate, within: searchRadius)
        let moving = (sample.speed ?? 0) >= 3 && sample.course != nil
        let best = candidates.min { cost($0, sample, moving: moving) < cost($1, sample, moving: moving) }

        var headingDiff = 0.0
        if let best, moving, let course = sample.course {
            headingDiff = Geodesy.angleDifference(course, route.bearing(at: best.distanceAlong))
        }

        guard let best, best.offset <= threshold, headingDiff <= 100 else {
            // Nothing within twice the off route distance, or a course away from the route: a departure.
            let departing = best == nil || headingDiff > configuration.departureHeading
            registerMiss(sample, departing: departing)
            // Beside the route and going its way: keep moving along it, marked as an estimate.
            if !departing, let best, match.status == .onRoute, best.distanceAlong > match.distanceAlongRoute {
                match.distanceAlongRoute = min(best.distanceAlong, route.length)
                match.offset = best.offset
                match.isEstimated = true
                lastAccepted = sample
            }
            return match
        }

        offRouteCount = 0
        firstOffRouteTime = nil
        departing = false
        movingMiss = 0
        lastMissTime = nil
        var distance = best.distanceAlong
        if match.status == .onRoute, distance < match.distanceAlongRoute,
           match.distanceAlongRoute - distance <= configuration.backwardTolerance {
            distance = match.distanceAlongRoute  // GPS jitter: never step backwards
        }
        let speed = smoothedSpeed(sample, newDistance: distance)
        match = RouteMatch(status: .onRoute, distanceAlongRoute: min(distance, route.length), offset: best.offset,
                           isEstimated: false, timestamp: sample.timestamp, speed: speed)
        lastAccepted = sample
        return match
    }

    /// Position at a time without a new fix (dead reckoning along the route).
    public func estimate(at date: Date) -> RouteMatch {
        guard match.status == .onRoute || match.status == .signalLost, let last = lastAccepted else { return match }
        let elapsed = date.timeIntervalSince(last.timestamp)
        guard elapsed > configuration.deadReckoningAfter else { return match }
        let usable = min(elapsed, configuration.deadReckoningLimit)
        var m = match
        m.distanceAlongRoute = min(route.length, match.distanceAlongRoute + match.speed * usable)
        m.isEstimated = true
        m.timestamp = date
        if elapsed > configuration.deadReckoningLimit { m.status = .signalLost }
        return m
    }

    /// Starts tracking from a known distance. Not used by the app today: `TripSession.replacePlan`
    /// starts a fresh tracker that acquires the new route from the next fixes.
    public mutating func reset(to distance: Double, at date: Date, speed: Double = 0) {
        match = RouteMatch(status: .onRoute, distanceAlongRoute: distance, offset: nil, isEstimated: false,
                           timestamp: date, speed: speed)
        offRouteCount = 0
        firstOffRouteTime = nil
        departing = false
        movingMiss = 0
        lastMissTime = nil
    }

    // MARK: Private

    private func cost(_ p: PolylineProjection, _ sample: LocationSample, moving: Bool) -> Double {
        var c = p.offset / max(sample.horizontalAccuracy, 5)
        if moving, let course = sample.course {
            let diff = Geodesy.angleDifference(course, route.bearing(at: p.distanceAlong))
            c += diff / 30
            if diff > 100 { c += 10 }
        }
        switch match.status {
        case .onRoute, .offRoute, .signalLost:
            let dt = max(0, sample.timestamp.timeIntervalSince(match.timestamp))
            let expected = match.distanceAlongRoute + match.speed * dt
            let tolerance = 50 + 0.5 * match.speed * dt + sample.horizontalAccuracy
            let delta = (p.distanceAlong - expected) / tolerance
            c += min(delta * delta, 50)
            if p.distanceAlong < match.distanceAlongRoute - configuration.backwardTolerance { c += 5 }
        case .acquiring:
            c += 0.5 * p.distanceAlong / max(route.length, 1)  // tie break toward the trip start
        }
        return c
    }

    /// A fix that did not match. `departing`: it shows the driver leaving (far from the route or heading away),
    /// not just drifting beside it; a run of misses counts as departing once any of them does.
    private mutating func registerMiss(_ sample: LocationSample, departing: Bool) {
        offRouteCount += 1
        if firstOffRouteTime == nil { firstOffRouteTime = sample.timestamp }
        if departing { self.departing = true }
        let elapsed = sample.timestamp.timeIntervalSince(firstOffRouteTime ?? sample.timestamp)
        if (sample.speed ?? 0) >= 3, let last = lastMissTime {
            movingMiss += min(max(sample.timestamp.timeIntervalSince(last), 0), 5)
        }
        lastMissTime = sample.timestamp
        let required = self.departing ? configuration.offRouteMinimumDuration : configuration.driftTolerance
        if offRouteCount >= configuration.offRouteConfirmations,
           match.status == .acquiring ? movingMiss >= configuration.acquireTimeout : elapsed >= required {
            match.status = .offRoute
            match.isEstimated = false
        }
        match.timestamp = sample.timestamp
        if let s = sample.speed, s >= 0 { match.speed = s }
    }

    private func smoothedSpeed(_ sample: LocationSample, newDistance: Double) -> Double {
        if let s = sample.speed, s >= 0 {
            return match.status == .onRoute ? 0.6 * s + 0.4 * match.speed : s
        }
        if let last = lastAccepted {
            let dt = sample.timestamp.timeIntervalSince(last.timestamp)
            if dt > 0 { return max(0, (newDistance - match.distanceAlongRoute) / dt) }
        }
        return match.speed
    }
}
