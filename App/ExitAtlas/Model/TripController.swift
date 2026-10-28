import CoreLocation
import ExitAtlasCore
import Foundation
import Observation

/// One state's part of the route, ready for MapPolyline.
struct StateLine: Identifiable {
    let id: Int
    let coordinates: [CLLocationCoordinate2D]
}

/// Owns the live trip: feeds GPS (or simulated) fixes to the engine, publishes snapshots,
/// reroutes when the driver leaves the route, and runs discovery mode when there is no trip.
@MainActor
@Observable
final class TripController {
    enum Mode: Equatable {
        case idle
        /// No destination: following the interstate the driver is on.
        case discovery
        /// A planned trip to a destination.
        case trip
    }

    enum GPSSource: Equatable {
        case device
        case simulation(speedup: Double)
    }

    private(set) var mode: Mode = .idle
    private(set) var snapshot: TripSnapshot?
    private(set) var plan: TripPlan?
    private(set) var gpsSource: GPSSource = .device
    private(set) var discoveryStatus = "Waiting for highway speed"
    private(set) var isRerouting = false
    private(set) var lastError: String?
    private(set) var lastFixAt: Date?
    /// Remaining waypoints for rerouting: upcoming stops then the destination.
    private(set) var remainingWaypoints: [Waypoint] = []
    /// A trip saved before the app was terminated, offered for resuming.
    private(set) var resumable: ActiveTripRecord?

    @ObservationIgnored private var session: TripSession?
    @ObservationIgnored private var discovery: HighwayDiscovery?
    @ObservationIgnored private var data: BundledData?
    @ObservationIgnored private var tripStartedAt: Date?
    @ObservationIgnored private var lastRerouteAt: Date?
    @ObservationIgnored private var lastCalibrationAt: Date?
    @ObservationIgnored private var lastPersistAt: Date?
    @ObservationIgnored private var refreshTimer: Timer?
    @ObservationIgnored private var serviceCache: [String: [ExitService]] = [:]
    @ObservationIgnored private var lineCache: (routeID: UUID, lines: [StateLine])?
    @ObservationIgnored let location = LocationService()
    @ObservationIgnored let simulator = DriveSimulator()
    @ObservationIgnored let announcer = Announcer()
    @ObservationIgnored let routing = MapKitRouteService()
    @ObservationIgnored weak var settings: UserSettings?
    @ObservationIgnored weak var library: TripLibrary?

    init() {
        location.onSample = { [weak self] sample in
            guard let self, self.gpsSource == .device else { return }
            self.handle(sample)
        }
        simulator.onSample = { [weak self] sample in
            guard let self, case .simulation = self.gpsSource else { return }
            self.handle(sample)
        }
    }

    func attach(data: BundledData) {
        self.data = data
        discovery = HighwayDiscovery(corridors: data.corridors)
        resumable = library?.loadActive()
    }

    var datasets: TripDatasets? { data?.datasets }
    var interstates: InterstateDataset? { data?.interstates }
    var isSimulating: Bool { if case .simulation = gpsSource { return true } else { return false } }
    var ledger: TripLedger? { session?.ledger }
    var pace: PaceModel { session?.pace ?? PaceModel() }

    // MARK: Modes

    func startDiscovery() {
        stopSimulation()
        mode = .discovery
        plan = nil
        session = nil
        snapshot = nil
        discovery = data.map { HighwayDiscovery(corridors: $0.corridors) }
        discoveryStatus = "Waiting for highway speed"
        location.start()
        startRefreshTimer()
        announcer.reset()
    }

    /// - Parameters:
    ///   - startMiles: simulation only, where along the route the simulated drive begins.
    ///   - fixLimit: simulation only, stop after this many fixes (frozen demo).
    func startTrip(route: PlannedRoute, simulate: Bool, startMiles: Double = 0, fixLimit: Int? = nil,
                   restoring record: ActiveTripRecord? = nil) {
        guard let data else { return }
        let plan = TripPlan(route: route, datasets: data.datasets)
        self.plan = plan
        let now = Date()
        if let record {
            session = TripSession(plan: plan, states: data.datasets.states, startedAt: now,
                                  ledger: record.ledger, pace: record.pace)
            tripStartedAt = record.startedAt
        } else {
            session = TripSession(plan: plan, states: data.datasets.states, startedAt: now)
            tripStartedAt = now
        }
        resumable = nil
        lastPersistAt = nil
        remainingWaypoints = route.stops.map(\.waypoint) + [route.destination]
        mode = .trip
        snapshot = session?.snapshot(at: now)
        announcer.reset()
        startRefreshTimer()
        if simulate {
            gpsSource = .simulation(speedup: 30)
            simulator.start(route: route, from: startMiles * Geodesy.metersPerMile, speedup: 30, limit: fixLimit)
        } else {
            gpsSource = .device
            location.start()
        }
    }

    func endTrip() {
        if mode == .trip, let session, let start = tripStartedAt, session.ledger.totalMeters > 0, !isSimulating {
            let states = session.ledger.totalsByRegion.map { TripRecord.StateMiles(code: $0.code, name: $0.name, meters: $0.meters) }
            library?.record(TripRecord(title: "\(plan?.route.origin.name ?? "Trip") to \(plan?.route.destination.name ?? "")",
                                       startedAt: start, endedAt: Date(), states: states,
                                       totalMeters: session.ledger.totalMeters))
        }
        stopSimulation()
        location.stop()
        refreshTimer?.invalidate()
        refreshTimer = nil
        session = nil
        plan = nil
        snapshot = nil
        mode = .idle
        library?.clearActive()
    }

    /// Recomputes a route from here to the saved trip's remaining stops and continues it.
    func resume(_ record: ActiveTripRecord) async {
        guard let destination = record.destination else { return }
        isRerouting = true
        defer { isRerouting = false }
        do {
            let here = Waypoint(name: "Current location", coordinate: try await CurrentLocation.fetch())
            let options = MapKitRouteService.Options(avoidTolls: settings?.avoidTolls ?? false)
            guard let route = try await routing.routes(from: here, via: Array(record.remainingWaypoints.dropLast()),
                                                       to: destination, options: options).first else { return }
            let restored = PlannedRoute(source: route.source, polyline: route.polyline, steps: route.steps,
                                    timeProfile: route.timeProfile, origin: record.origin, destination: route.destination,
                                    stops: route.stops, hasTolls: route.hasTolls, createdAt: route.createdAt, title: route.title)
            startTrip(route: restored, simulate: false, restoring: record)
            lastError = nil
        } catch {
            lastError = "Could not resume: \(error.localizedDescription)"
        }
    }

    func discardResumable() {
        resumable = nil
        library?.clearActive()
    }

    /// Saves the trip in progress at most every 30 seconds (device GPS trips only).
    private func persistIfDue(at date: Date) {
        guard mode == .trip, !isSimulating, let session, let plan, let start = tripStartedAt else { return }
        if let last = lastPersistAt, date.timeIntervalSince(last) < 30 { return }
        lastPersistAt = date
        library?.saveActive(ActiveTripRecord(origin: plan.route.origin, remainingWaypoints: dropPassedStops(),
                                             ledger: session.ledger, pace: session.pace, startedAt: start, savedAt: date))
    }

    func stopSimulation() {
        simulator.stop()
        gpsSource = .device
    }

    // MARK: Fixes

    private func handle(_ sample: LocationSample) {
        lastFixAt = sample.timestamp
        switch mode {
        case .idle:
            return
        case .trip:
            guard var session else { return }
            let snap = session.ingest(sample)
            self.session = session
            publish(snap)
            if session.needsReroute(at: sample.timestamp) { reroute(from: sample) }
            calibrateIfDue(at: sample)
            persistIfDue(at: sample.timestamp)
        case .discovery:
            handleDiscovery(sample)
        }
    }

    private func handleDiscovery(_ sample: LocationSample) {
        guard var discovery, let data else { return }
        let state = discovery.ingest(sample)
        self.discovery = discovery
        switch state {
        case .searching:
            discoveryStatus = (sample.speed ?? 0) < discovery.minimumSpeed
                ? "Waiting for highway speed" : "Looking for an interstate"
            if plan?.route.source == .corridor {
                plan = nil
                session = nil
                snapshot = nil
            }
        case let .locked(match):
            discoveryStatus = match.corridor.displayName
            let needsPlan: Bool
            if let snap = snapshot, plan?.route.title == match.corridor.displayName {
                needsPlan = snap.remaining < 50 * Geodesy.metersPerMile || snap.match.status == .offRoute
            } else {
                needsPlan = true
            }
            if needsPlan {
                let route = HighwayDiscovery.routeAhead(of: match, now: sample.timestamp)
                let plan = TripPlan(route: route, datasets: data.datasets)
                self.plan = plan
                if var existing = session {
                    // Keep the driven history as the corridor plan rolls forward.
                    existing.replacePlan(plan, at: sample.timestamp)
                    session = existing
                } else {
                    session = TripSession(plan: plan, states: data.datasets.states, startedAt: sample.timestamp)
                }
            }
            if var session {
                let snap = session.ingest(sample)
                self.session = session
                publish(snap)
            }
        }
    }

    private func publish(_ snap: TripSnapshot) {
        snapshot = snap
        if let settings { announcer.consider(snap, settings: settings) }
    }

    private func startRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshWithoutFix() }
        }
    }

    /// Keeps the dashboard moving through tunnels and dead zones by dead reckoning.
    private func refreshWithoutFix() {
        guard let session, !isSimulating else { return }
        let now = Date()
        if let last = lastFixAt, now.timeIntervalSince(last) > 4 {
            snapshot = session.snapshot(at: now)
        }
    }

    // MARK: Reroute and ETA calibration

    private func reroute(from sample: LocationSample) {
        guard mode == .trip, !isRerouting, !remainingWaypoints.isEmpty, !isSimulating else { return }
        if let last = lastRerouteAt, sample.timestamp.timeIntervalSince(last) < 20 { return }
        lastRerouteAt = sample.timestamp
        isRerouting = true
        let here = Waypoint(name: "Current location", coordinate: sample.coordinate)
        let waypoints = dropPassedStops()
        let destination = waypoints.last!
        let stops = Array(waypoints.dropLast())
        let options = MapKitRouteService.Options(avoidTolls: settings?.avoidTolls ?? false)
        Task { @MainActor in
            defer { self.isRerouting = false }
            do {
                guard let route = try await self.routing.routes(from: here, via: stops, to: destination,
                                                                options: options).first,
                      let data = self.data, var session = self.session else { return }
                let plan = TripPlan(route: route, datasets: data.datasets)
                session.replacePlan(plan, at: Date())
                self.session = session
                self.plan = plan
                self.remainingWaypoints = waypoints
                self.lastError = nil
            } catch {
                self.lastError = "Reroute failed: \(error.localizedDescription). Will retry."
            }
        }
    }

    private func dropPassedStops() -> [Waypoint] {
        guard let plan, let snapshot else { return remainingWaypoints }
        let passed = plan.route.stops.filter { $0.distanceAlongRoute <= snapshot.progress }.map(\.waypoint)
        return remainingWaypoints.filter { !passed.contains($0) }
    }

    private func calibrateIfDue(at sample: LocationSample) {
        guard mode == .trip, !isSimulating, let destination = remainingWaypoints.last,
              session?.tracker.match.status == .onRoute else { return }
        if let last = lastCalibrationAt, sample.timestamp.timeIntervalSince(last) < 600 { return }
        lastCalibrationAt = sample.timestamp
        Task { @MainActor in
            guard let seconds = try? await self.routing.remainingTravelTime(from: sample.coordinate, to: destination),
                  var session = self.session else { return }
            session.calibrate(providerRemainingSeconds: seconds)
            self.session = session
        }
    }

    // MARK: Queries for views

    /// Services at an exit (decoded once per exit and cached; exit ids are stable OSM node ids).
    func services(for exit: RouteExit) -> [ExitService] {
        if let cached = serviceCache[exit.id] { return cached }
        let services = interstates?.services(for: exit) ?? []
        serviceCache[exit.id] = services
        return services
    }

    /// Each state segment's slice of the route, thinned for drawing. Computed once per route.
    func stateLines(for plan: TripPlan) -> [StateLine] {
        if let cached = lineCache, cached.routeID == plan.route.id { return cached.lines }
        let polyline = plan.route.polyline
        let lines = plan.states.segments.map { seg -> StateLine in
            let slice = polyline.slice(from: seg.startDistance, to: seg.endDistance)
            let step = max(1, slice.points.count / 600)
            var coords = stride(from: 0, to: slice.points.count, by: step).map { slice.points[$0].clCoordinate }
            if let last = slice.points.last { coords.append(last.clCoordinate) }
            return StateLine(id: seg.index, coordinates: coords)
        }
        lineCache = (plan.route.id, lines)
        return lines
    }

    func stopSuggestions(_ query: StopQuery) -> [StopSuggestion] {
        guard let plan, let snapshot, let interstates else { return [] }
        return StopPlanner(dataset: interstates).suggestions(query, plan: plan, snapshot: snapshot, pace: pace, now: snapshot.timestamp)
    }
}
