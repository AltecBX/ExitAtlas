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
    /// The range the driver entered from the dashboard, counting down with miles driven.
    private(set) var fuelReading: FuelReading? = TripController.loadFuelReading()
    /// Bumped when speed limits, chargers or prices arrive, so views that read them refresh.
    private(set) var feedsVersion = 0
    /// A trip saved before the app was terminated, offered for resuming.
    private(set) var resumable: ActiveTripRecord?

    @ObservationIgnored private var session: TripSession?
    @ObservationIgnored private var discovery: HighwayDiscovery?
    @ObservationIgnored private var data: BundledData?
    @ObservationIgnored private var tripStartedAt: Date?
    @ObservationIgnored private var lastRerouteAt: Date?
    /// Changes with every new trip, so a late reroute result is never applied to a different trip.
    @ObservationIgnored private var tripID = UUID()
    /// Miles per state from discovery locks that already ended (discovery drops its plan between locks).
    @ObservationIgnored private var discoveryCarry: [TripRecord.StateMiles] = []
    @ObservationIgnored private var lastPersistAt: Date?
    @ObservationIgnored private var refreshTimer: Timer?
    @ObservationIgnored private var serviceCache: [String: [ExitService]] = [:]
    @ObservationIgnored private var lineCache: (routeID: UUID, lines: [StateLine])?
    @ObservationIgnored let location = LocationService()
    @ObservationIgnored let simulator = DriveSimulator()
    @ObservationIgnored let announcer = Announcer()
    @ObservationIgnored let routing = MapKitRouteService()
    @ObservationIgnored let limits = SpeedLimitService()
    @ObservationIgnored let chargers = ChargerService()
    @ObservationIgnored let prices = GasPriceService()
    @ObservationIgnored private var fuelVoice = FuelAnnouncements()
    @ObservationIgnored private var rangePlanMemo: (key: String, plan: RangePlan?)?
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
        limits.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        chargers.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        prices.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        prices.onCall = { PriceCallCounter.count() }
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
        rebaseFuel()
        tripID = UUID()
        discoveryCarry = []
        tripStartedAt = Date()
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
        rebaseFuel()
        let plan = TripPlan(route: route, datasets: data.datasets)
        self.plan = plan
        tripID = UUID()
        lastRerouteAt = nil
        let now = Date()
        if let record {
            session = TripSession(plan: plan, states: data.datasets.states, startedAt: now,
                                  ledger: record.ledger, pace: record.pace)
            tripStartedAt = record.startedAt
        } else {
            // Device trips start from the driver's usual pace on MapKit routes; simulations from the model.
            let prior = simulate ? 1 : (library?.paceHistory.priorFactor() ?? 1)
            session = TripSession(plan: plan, states: data.datasets.states, startedAt: now, priorPaceFactor: prior)
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
            library?.recordPace(key: start.timeIntervalSince1970.description, pace: session.pace)
        } else if mode == .discovery, !isSimulating {
            absorbDiscoveryLedger()
            let total = discoveryCarry.reduce(0) { $0 + $1.meters }
            if total > 0, let start = tripStartedAt {
                library?.record(TripRecord(title: "Discovery drive", startedAt: start, endedAt: Date(),
                                           states: discoveryCarry, totalMeters: total))
            }
            discoveryCarry = []
        }
        rebaseFuel()
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
                                                       to: destination, options: options).first else {
                lastError = "Could not resume: no route to \(destination.name) was found."
                return
            }
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
                absorbDiscoveryLedger()
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

    /// Keeps the miles of a discovery lock that is ending, for the trip history.
    private func absorbDiscoveryLedger() {
        guard let session else { return }
        for t in session.ledger.totalsByRegion {
            if let i = discoveryCarry.firstIndex(where: { $0.code == t.code && $0.name == t.name }) {
                discoveryCarry[i].meters += t.meters
            } else {
                discoveryCarry.append(TripRecord.StateMiles(code: t.code, name: t.name, meters: t.meters))
            }
        }
    }

    private func publish(_ snap: TripSnapshot) {
        snapshot = snap
        if let settings { announcer.consider(snap, settings: settings) }
        limits.reset(for: plan)
        if snap.match.status == .onRoute { limits.ensureAhead(of: snap.progress) }
        if let plan, let settings, settings.vehicle?.isElectric == true {
            chargers.ensure(for: plan, teslaOnly: settings.teslaOnlyChargers, apiKey: settings.nrelKey)
        }
        if let settings, settings.voiceEnabled, settings.announceFuel, let rangePlan = self.rangePlan,
           let text = fuelVoice.message(for: rangePlan, electric: settings.vehicle?.isElectric == true,
                                         onRoute: snap.match.status == .onRoute, enabled: true) {
            announcer.speak(text)
        }
    }

    // MARK: Fuel and range

    /// Range left now, or nil until the driver enters one.
    var rangeLeft: Double? { fuelReading?.rangeLeft(drivenTotal: snapshot?.drivenTotal ?? 0) }

    /// Sets the range from the car's dashboard (miles to empty, or a charge estimate).
    func setRange(miles: Double) {
        fuelReading = FuelReading(rangeMeters: max(0, miles) * Geodesy.metersPerMile, drivenAtEntry: snapshot?.drivenTotal ?? 0)
        fuelVoice.reset()
        rangePlanMemo = nil
        saveFuelReading()
    }

    /// A fill up or full charge: the vehicle's full range, when known.
    func filledUp() {
        guard let full = settings?.vehicle?.fullRangeMeters else { return }
        setRange(miles: full / Geodesy.metersPerMile)
    }

    func clearRange() {
        fuelReading = nil
        rangePlanMemo = nil
        saveFuelReading()
    }

    /// Where to stop for fuel or a charge, for the current position and range.
    var rangePlan: RangePlan? {
        _ = feedsVersion
        guard let snapshot, let plan, let range = rangeLeft, let interstates, let settings else { return nil }
        let electric = settings.vehicle?.isElectric == true
        let key = "\(plan.route.id)|\(snapshot.timestamp.timeIntervalSince1970)|\(range)|\(feedsVersion)|\(settings.bufferMiles)|\(electric)|\(settings.favoriteBrands)|\(mode)"
        if let memo = rangePlanMemo, memo.key == key { return memo.plan }
        let favorites = electric ? [] : settings.favoriteBrands
        let candidates = electric
            ? RangePlanner.chargerCandidates(chargers.projected, from: snapshot.progress, range: range)
            : RangePlanner.gasCandidates(plan: plan, from: snapshot.progress, range: range, dataset: interstates, favorites: favorites)
        let result = RangePlanner.plan(plan: plan, snapshot: snapshot, range: range, candidates: candidates,
                                       bufferMeters: settings.bufferMiles * Geodesy.metersPerMile,
                                       hasDestination: mode == .trip, favorites: favorites)
        rangePlanMemo = (key, result)
        return result
    }

    /// Folds miles driven in the session that is ending into the saved range, so it carries over.
    private func rebaseFuel() {
        guard let reading = fuelReading else { return }
        fuelReading = FuelReading(rangeMeters: reading.rangeLeft(drivenTotal: snapshot?.drivenTotal ?? 0), drivenAtEntry: 0)
        rangePlanMemo = nil
        saveFuelReading()
    }

    private func saveFuelReading() {
        if let fuelReading, let data = try? JSONEncoder().encode(fuelReading) {
            UserDefaults.standard.set(data, forKey: "fuelReading")
        } else {
            UserDefaults.standard.removeObject(forKey: "fuelReading")
        }
    }

    private static func loadFuelReading() -> FuelReading? {
        UserDefaults.standard.data(forKey: "fuelReading").flatMap { try? JSONDecoder().decode(FuelReading.self, from: $0) }
    }

    // MARK: Speed, limits, prices

    /// Current speed in mph from the latest fix, or nil when there is no recent fix.
    var speedMPH: Int? {
        guard let snapshot, snapshot.match.status != .acquiring else { return nil }
        let speed = max(0, snapshot.match.speed)
        if !isSimulating, let last = lastFixAt, Date().timeIntervalSince(last) > 5 { return nil }
        return Int((speed * 2.23694).rounded())
    }

    /// Posted limit here (OpenStreetMap), and the next change within 2 miles.
    var speedLimit: (mph: Int?, state: SpeedLimitTable.State, next: (mph: Int, distance: Double)?) {
        _ = feedsVersion
        guard let snapshot, snapshot.match.status == .onRoute, let table = limits.table else { return (nil, .unknown, nil) }
        return (table.limit(at: snapshot.progress), table.state(at: snapshot.progress),
                table.nextChange(after: snapshot.progress, within: 2 * Geodesy.metersPerMile))
    }

    /// Cached gas prices near an exit, loading them when a key is set.
    func gasPrices(at exit: RouteExit) -> GasPriceService.Entry? {
        _ = feedsVersion
        if let key = settings?.googleKey, !key.isEmpty { prices.load(exit: exit, apiKey: key) }
        return prices.entry(for: exit.id)
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
        // Every stop, the destination included, can already be passed (near the end of a trip).
        let waypoints = dropPassedStops()
        guard let destination = waypoints.last else { return }
        lastRerouteAt = sample.timestamp
        isRerouting = true
        let here = Waypoint(name: "Current location", coordinate: sample.coordinate)
        let stops = Array(waypoints.dropLast())
        let options = MapKitRouteService.Options(avoidTolls: settings?.avoidTolls ?? false)
        let id = tripID
        Task { @MainActor in
            defer { self.isRerouting = false }
            do {
                guard let route = try await self.routing.routes(from: here, via: stops, to: destination,
                                                                options: options).first,
                      self.tripID == id, self.mode == .trip,
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
