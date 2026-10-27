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

    /// Seconds off route before a reroute is requested.
    public var rerouteDelay: TimeInterval = 8

    public init(plan: TripPlan, states: RegionIndex, startedAt: Date = Date()) {
        self.plan = plan
        self.states = states
        tracker = RouteProgressTracker(route: plan.route.polyline, startedAt: startedAt)
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
            if dt > 0, moved / dt > 2 {
                pace.observe(expected: plan.route.timeProfile.seconds(from: previous.distanceAlongRoute,
                                                                     to: current.distanceAlongRoute),
                             actual: dt)
            }
        } else if hasStartedDriving, current.status != .onRoute, let last = lastSample,
                  sample.horizontalAccuracy >= 0, sample.horizontalAccuracy <= 100,
                  sample.timestamp.timeIntervalSince(last.timestamp) < 120 {
            let meters = Geodesy.distance(last.coordinate, sample.coordinate)
            ledger.recordOffRoute(meters: meters, region: states.region(containing: sample.coordinate), at: sample.timestamp)
        }
        if current.status == .onRoute { hasStartedDriving = true }
        if current.status == .offRoute {
            if offRouteSince == nil { offRouteSince = sample.timestamp }
        } else {
            offRouteSince = nil
        }
        if sample.horizontalAccuracy >= 0 { lastSample = sample }
        return plan.snapshot(match: current, ledger: ledger, pace: pace, now: sample.timestamp)
    }

    /// Snapshot without a new fix (for timers while GPS is quiet). Uses dead reckoning.
    public func snapshot(at date: Date) -> TripSnapshot {
        plan.snapshot(match: tracker.estimate(at: date), ledger: ledger, pace: pace, now: date)
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
    }

    /// Feeds a provider ETA for the rest of the route (for example from MKDirections.calculateETA).
    public mutating func calibrate(providerRemainingSeconds: Double) {
        let d = tracker.match.distanceAlongRoute
        pace.calibrate(providerRemainingSeconds: providerRemainingSeconds,
                       profileRemainingSeconds: plan.route.timeProfile.seconds(from: d, to: plan.route.length))
    }
}
