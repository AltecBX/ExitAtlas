import Foundation

/// The live state of a trip: the current plan, GPS tracking, driven history and pace.
///
/// Feed every location fix to `ingest`. When `needsReroute` turns true, compute a new route
/// from the current position and call `replacePlan`; driven history and pace carry over, so
/// completed state mileage stays correct across reroutes.
public struct TripSession: Sendable {
    public private(set) var plan: TripPlan
    public private(set) var tracker: RouteProgressTracker
    public private(set) var ledger = TripLedger()
    public private(set) var pace = PaceModel()
    public private(set) var lastSample: LocationSample?
    private let states: RegionIndex
    private var hasStartedDriving = false
    private var offRouteSince: Date?
    private var recordedUpTo = 0.0
    /// The last fix counted as driven while off the route (nil on the route).
    private var offRouteAnchor: LocationSample?
    /// True from a reroute (whose route starts where the driver was) until the first fix on it.
    private var startsAtDriver = false

    /// Fixes further apart than this (screen locked, tunnel) teach the pace model only when the time fits driving
    /// all the way, no slower than the slowest pace it predicts: a stop hidden in the gap is not slow driving.
    static let paceGapSeconds: TimeInterval = 30
    static let slowestPace = 2.5
    /// Off the route, a parked phone's fixes wander several meters every second. Movement counts only beyond
    /// this (or twice the reported accuracy), and not while the reported speed says stopped.
    static let offRouteWander = 40.0
    static let stoppedSpeed = 1.0
    /// Back on the route after a long gap: the route between counts as driven when it fits this speed (m/s).
    static let gapMaxSpeed = 45.0

    /// Seconds off route before a reroute is requested.
    public var rerouteDelay: TimeInterval = 8
    /// The traffic reading shown (after Traffic.Stabilizer), used in every arrival time while it is usable.
    public var traffic: Traffic.Reading?

    /// - Parameter priorPaceFactor: the driver's usual pace from earlier trips (1 means the model).
    public init(plan: TripPlan, states: RegionIndex, startedAt: Date = Date(), priorPaceFactor: Double = 1) {
        self.plan = plan
        self.states = states
        tracker = RouteProgressTracker(route: plan.route.polyline, startedAt: startedAt)
        pace = PaceModel(priorFactor: priorPaceFactor)
    }

    /// Resumes a trip after the app was terminated: driven history and pace are restored and
    /// tracking starts on a new route from the current position.
    public init(plan: TripPlan, states: RegionIndex, startedAt: Date, ledger: TripLedger, pace: PaceModel) {
        self.init(plan: plan, states: states, startedAt: startedAt)
        self.ledger = ledger
        self.pace = pace
        hasStartedDriving = ledger.totalMeters > 0
    }

    @discardableResult
    public mutating func ingest(_ sample: LocationSample) -> TripSnapshot {
        let previous = tracker.match
        let current = tracker.ingest(sample)
        if previous.status == .onRoute, current.status == .onRoute,
           current.distanceAlongRoute > max(previous.distanceAlongRoute, recordedUpTo) {
            // Only distance beyond the furthest point already credited counts, so a tracker that
            // steps back and forward again never credits the same stretch twice.
            let from = max(previous.distanceAlongRoute, recordedUpTo)
            ledger.recordRouteProgress(from: from, to: current.distanceAlongRoute,
                                       states: plan.states, startTime: previous.timestamp, endTime: current.timestamp)
            recordedUpTo = current.distanceAlongRoute
            let dt = current.timestamp.timeIntervalSince(previous.timestamp)
            let moved = current.distanceAlongRoute - previous.distanceAlongRoute
            let modeled = plan.route.timeProfile.seconds(from: previous.distanceAlongRoute, to: current.distanceAlongRoute)
            if dt > 0, moved / dt > 2, dt <= Self.paceGapSeconds || dt <= Self.slowestPace * modeled {
                pace.observe(expected: modeled, actual: dt, meters: moved)
            }
        } else if previous.status == .offRoute || (previous.status == .acquiring && startsAtDriver),
                  current.status == .onRoute, let last = lastSample,
                  sample.timestamp.timeIntervalSince(last.timestamp) >= 120, current.distanceAlongRoute > recordedUpTo,
                  (current.distanceAlongRoute - recordedUpTo) / sample.timestamp.timeIntervalSince(last.timestamp)
                    <= Self.gapMaxSpeed {
            // Back on the route after a gap that hid the way back (screen locked at a stop): the route between counts.
            ledger.recordRouteProgress(from: recordedUpTo, to: current.distanceAlongRoute,
                                       states: plan.states, startTime: last.timestamp, endTime: current.timestamp)
            recordedUpTo = current.distanceAlongRoute
        } else if hasStartedDriving, current.status != .onRoute, let last = lastSample,
                  sample.horizontalAccuracy >= 0, sample.horizontalAccuracy <= 100 {
            if sample.timestamp.timeIntervalSince(last.timestamp) >= 120 {
                offRouteAnchor = sample  // the way between is unknown
            } else if !(sample.speed.map { $0 < Self.stoppedSpeed } ?? false) {
                let anchor = offRouteAnchor ?? last
                offRouteAnchor = anchor
                let meters = Geodesy.distance(anchor.coordinate, sample.coordinate)
                if meters > max(Self.offRouteWander, 2 * sample.horizontalAccuracy) {
                    ledger.recordOffRoute(meters: meters, region: states.region(containing: sample.coordinate),
                                          at: sample.timestamp)
                    offRouteAnchor = sample
                }
            }
        }
        if current.status == .onRoute {
            hasStartedDriving = true
            startsAtDriver = false
            offRouteAnchor = nil
        }
        if current.status == .offRoute {
            if offRouteSince == nil { offRouteSince = sample.timestamp }
        } else {
            offRouteSince = nil
        }
        if sample.horizontalAccuracy >= 0 { lastSample = sample }
        return plan.snapshot(match: current, ledger: ledger, pace: pace, now: sample.timestamp, traffic: traffic)
    }

    /// Snapshot without a new fix (for timers while GPS is quiet). Uses dead reckoning.
    public func snapshot(at date: Date) -> TripSnapshot {
        plan.snapshot(match: tracker.estimate(at: date), ledger: ledger, pace: pace, now: date, traffic: traffic)
    }

    public func needsReroute(at date: Date) -> Bool {
        guard let since = offRouteSince else { return false }
        return date.timeIntervalSince(since) >= rerouteDelay
    }

    /// Switches to a new route (reroute, edited stops, alternative). History and pace are kept.
    public mutating func replacePlan(_ newPlan: TripPlan, at date: Date) {
        plan = newPlan
        tracker = RouteProgressTracker(route: newPlan.route.polyline, startedAt: date)
        offRouteSince = nil
        recordedUpTo = 0
        offRouteAnchor = nil
        startsAtDriver = true
    }
}
