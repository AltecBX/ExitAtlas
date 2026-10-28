import Foundation

/// Deterministic random numbers for reproducible simulations (SplitMix64).
public struct SeededRandom: RandomNumberGenerator, Sendable {
    private var state: UInt64

    public init(seed: UInt64) {
        state = seed
    }

    public mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// Standard normal sample (Box-Muller).
    public mutating func gaussian() -> Double {
        let u1 = max(Double.random(in: 0..<1, using: &self), 1e-12)
        let u2 = Double.random(in: 0..<1, using: &self)
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
}

/// Generates GPS fixes along a route for tests and the in-app simulated drive.
/// Output is clearly simulated data; the app labels it as such.
public struct GPSSimulator: Sendable {
    public struct Options: Sendable {
        public var interval: TimeInterval = 1
        /// Standard deviation of horizontal noise in meters.
        public var noise: Double = 4
        public var reportedAccuracy: Double = 6
        /// Multiplier on the route's expected speed.
        public var speedFactor: Double = 1
        public var seed: UInt64 = 42
        /// Distance ranges along the route with no fixes (tunnels, dead zones).
        public var dropouts: [ClosedRange<Double>] = []
        /// Leaves the route at this distance and drives away perpendicular to it (to the right).
        public var departure: (atDistance: Double, lateralSpeed: Double)?

        public init() {}
    }

    public let route: PlannedRoute
    public let options: Options

    public init(route: PlannedRoute, options: Options = Options()) {
        self.route = route
        self.options = options
    }

    /// Fixes from `start` to `end` meters along the route, beginning at `startTime`.
    public func trace(from start: Double = 0, to end: Double? = nil, startTime: Date) -> [LocationSample] {
        traceWithTruth(from: start, to: end, startTime: startTime).map(\.sample)
    }

    /// Fixes plus the true distance along the route at each fix (for accuracy tests).
    public func traceWithTruth(from start: Double = 0, to end: Double? = nil,
                               startTime: Date) -> [(sample: LocationSample, truth: Double)] {
        var rng = SeededRandom(seed: options.seed)
        let stop = min(end ?? route.length, route.length)
        var d = max(0, start)
        var t = startTime
        var out: [(sample: LocationSample, truth: Double)] = []
        var lateral = 0.0
        while d < stop {
            let base = route.timeProfile.speed(at: d)
            let speed = max(base, 3) * options.speedFactor
            var coordinate = route.polyline.coordinate(at: d)
            let bearing = route.polyline.bearing(at: d)
            var course = bearing
            if let dep = options.departure, d >= dep.atDistance {
                lateral += dep.lateralSpeed * options.interval
                coordinate = Geodesy.offset(coordinate, bearing: bearing + 90, meters: lateral)
                course = bearing + 45
            }
            let inDropout = options.dropouts.contains { $0.contains(d) }
            if !inDropout {
                let north = rng.gaussian() * options.noise, east = rng.gaussian() * options.noise
                let noisy = Geodesy.offset(Geodesy.offset(coordinate, bearing: 0, meters: north), bearing: 90, meters: east)
                out.append((LocationSample(coordinate: noisy, horizontalAccuracy: options.reportedAccuracy,
                                           course: Geodesy.normalizedDegrees(course + rng.gaussian() * 3),
                                           speed: speed, timestamp: t), d))
            }
            d += speed * options.interval
            t = t.addingTimeInterval(options.interval)
        }
        return out
    }
}
