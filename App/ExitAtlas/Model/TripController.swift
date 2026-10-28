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
    @ObservationIgnored private var gasStopCache: (routeID: UUID, stops: [GasGaps.Stop])?
    @ObservationIgnored private var lastSample: LocationSample?
    @ObservationIgnored private var lineCache: (routeID: UUID, lines: [StateLine])?
    @ObservationIgnored let location = LocationService()
    @ObservationIgnored let simulator = DriveSimulator()
    @ObservationIgnored let announcer = Announcer()
    @ObservationIgnored let liveActivity = LiveActivityController()
    /// Start the Live Activity with the next snapshot (set by a tap, so the app is in front).
    @ObservationIgnored private var activityPending = false
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
        activityPending = true
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
        activityPending = true
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
        liveActivity.end()
        activityPending = false
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
        lastSample = sample
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
        if let settings {
            let gap = gasGapsAhead().first { ($0.before?.distance ?? 0) > snap.progress }
            announcer.consider(snap, settings: settings, zoneID: plan?.timeZoneID(at: snap.progress), gasGap: gap, lastOpen: lastOpenAhead)
            if settings.liveActivityEnabled {
                let content = activityContent(for: snap, gasGap: gap)
                if activityPending {
                    activityPending = false
                    liveActivity.start(title: activityTitle, discovery: mode == .discovery, content: content)
                } else {
                    liveActivity.update(content)
                }
            }
        }
        limits.reset(for: plan)
        if snap.match.status == .onRoute { limits.ensureAhead(of: snap.progress) }
        if let plan, let settings, settings.vehicle?.isElectric == true {
            chargers.ensure(for: plan, teslaOnly: settings.teslaOnlyChargers, apiKey: settings.nrelKey)
        }
        if let settings, settings.voiceEnabled, settings.announceFuel, let rangePlan = self.rangePlan,
           let text = fuelVoice.message(for: rangePlan, electric: settings.vehicle?.isElectric == true,
                                         onRoute: snap.match.status == .onRoute, enabled: true, smart: smartStop?.primary) {
            announcer.speak(text)
        }
    }

    // MARK: Live Activity

    /// What the Live Activity shows for a snapshot.
    func activityContent(for snap: TripSnapshot, gasGap: GasGaps.Gap? = nil) -> DriveActivityContent {
        DriveActivityContent(snapshot: snap, services: { self.services(for: $0) }, gasGap: gasGap,
                             hasDestination: mode == .trip, simulated: isSimulating)
    }

    private var activityTitle: String {
        if mode == .discovery { return plan?.route.title ?? "Discovery" }
        return plan?.route.destination.name ?? "Trip"
    }

    /// The app came to the front: start a Live Activity that could not start in the background, and
    /// restart one close to the 8 hour limit.
    func appBecameActive() {
        guard mode != .idle, settings?.liveActivityEnabled == true else { return }
        if liveActivity.isRunning {
            liveActivity.restartIfOld()
        } else {
            activityPending = true
        }
    }

    /// Turning the setting off ends the activity; turning it on starts one with the next update.
    func liveActivitySettingChanged() {
        if settings?.liveActivityEnabled == true {
            if mode != .idle { activityPending = true }
        } else {
            liveActivity.end(immediately: true)
            activityPending = false
        }
    }

    // MARK: Fuel and range

    /// Range left now, or nil until the driver enters one.
    var rangeLeft: Double? { fuelReading?.rangeLeft(drivenTotal: snapshot?.drivenTotal ?? 0) }

    /// Sets the range from the car's dashboard (miles to empty, or a charge estimate).
    /// `drivenAtEntry` overrides the odometer it counts down from (the demo starts mid-route).
    func setRange(miles: Double, drivenAtEntry: Double? = nil) {
        fuelReading = FuelReading(rangeMeters: max(0, miles) * Geodesy.metersPerMile,
                                  drivenAtEntry: drivenAtEntry ?? snapshot?.drivenTotal ?? 0)
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

    // MARK: SmartStop

    /// Stations the driver turned down on this trip ("Not this one"): SmartStop does not offer them again.
    private(set) var rejectedStops: Set<String> = []
    @ObservationIgnored private var rejectedTripID: UUID?
    @ObservationIgnored private var smartMemo: (key: String, result: SmartStop.Result?)?

    func skipStop(_ id: String) {
        if rejectedTripID != tripID { rejectedStops = []; rejectedTripID = tripID }
        rejectedStops.insert(id)
    }

    func offerSkippedStopsAgain() { rejectedStops = [] }

    private var rejectedNow: Set<String> { rejectedTripID == tripID ? rejectedStops : [] }

    /// SmartStop's view of the trip: exits, rest areas, station facts, and Google data already loaded.
    func stopContext() -> SmartStop.TripContext? {
        guard let plan, let snapshot, let interstates, let settings else { return nil }
        return SmartStop.TripContext(plan: plan, snapshot: snapshot, dataset: interstates, stations: data?.stations,
                                     live: prices.loadedStations, grade: settings.gasGrade)
    }

    /// SmartStop for the fuel stop: gas vehicles with a range reading, when a stop is needed. One
    /// recommendation and up to two alternatives, each with its stop confidence.
    var smartStop: SmartStop.Result? {
        _ = feedsVersion
        guard let rangePlan, rangePlan.status != .destination, let settings, settings.vehicle?.isElectric != true,
              let range = rangeLeft, let ctx = stopContext() else { return nil }
        let rejected = rejectedNow
        let key = "\(ctx.plan.route.id)|\(ctx.snapshot.timestamp.timeIntervalSince1970)|\(range)|\(feedsVersion)|\(rejected.sorted())|"
            + "\(settings.favoriteBrands)|\(settings.maxDetourMinutes)|\(settings.require24Hours)|\(settings.requireRestroom)|"
            + "\(settings.priceOverBrand)|\(settings.overnightMode)\(settings.overnightStart)\(settings.overnightEnd)|\(settings.bufferMiles)"
        if let memo = smartMemo, memo.key == key { return memo.result }
        let result = SmartStop.choose(SmartStop.fuelCandidates(ctx, rangeLeft: range), preferences: SmartStop.Preferences(settings.values),
                                      context: .fuel, reserveMeters: settings.bufferMiles * Geodesy.metersPerMile, rejected: rejected)
        smartMemo = (key, result)
        return result
    }

    @ObservationIgnored private var lastOpenMemo: (key: String, result: SmartStop.LastOpen?)?

    /// Overnight: the last stop listed open before a long stretch where the stops ahead are not, within
    /// 150 miles (docs/12, 12.10). Recomputed every half mile or five minutes.
    var lastOpenAhead: SmartStop.LastOpen? {
        _ = feedsVersion
        guard let settings, let ctx = stopContext() else { return nil }
        let rejected = rejectedNow
        let key = "\(ctx.plan.route.id)|\(Int(ctx.snapshot.progress / 800))|\(Int(ctx.snapshot.timestamp.timeIntervalSince1970 / 300))|"
            + "\(feedsVersion)|\(rejected.sorted())|\(settings.overnightMode)\(settings.overnightStart)\(settings.overnightEnd)|\(settings.gasGapMiles)"
        if let memo = lastOpenMemo, memo.key == key { return memo.result }
        let end = min(ctx.snapshot.progress + 150 * Geodesy.metersPerMile, ctx.plan.route.length)
        let result = SmartStop.lastOpenBeforeGap(SmartStop.aheadCandidates(ctx, miles: 150, rangeLeft: nil),
                                                 preferences: SmartStop.Preferences(settings.values),
                                                 minLength: settings.gasGapMiles * Geodesy.metersPerMile, windowEnd: end, rejected: rejected)
        lastOpenMemo = (key, result)
        return result
    }

    /// The best stop in the next `miles` (restroom stops add rest areas and rank the restroom first).
    func bestStopAhead(miles: Double, restrooms: Bool = false) -> SmartStop.Result? {
        guard let settings, let ctx = stopContext() else { return nil }
        var prefs = SmartStop.Preferences(settings.values)
        if restrooms { prefs.requireRestroom = "always" }
        let range = settings.vehicle?.isElectric == true ? nil : rangeLeft
        return SmartStop.choose(SmartStop.aheadCandidates(ctx, miles: miles, rangeLeft: range, restrooms: restrooms), preferences: prefs,
                                context: .ahead, purpose: restrooms ? .restroom : .fuel,
                                reserveMeters: settings.bufferMiles * Geodesy.metersPerMile, rejected: rejectedNow)
    }

    /// Loads Google prices, hours and restrooms for the SmartStop picks' exits (with a key).
    func loadSmartStopDetails() {
        guard let key = settings?.googleKey, !key.isEmpty, let sm = smartStop, let plan else { return }
        for id in ([sm.primary] + sm.alternatives.map { Optional($0) }).compactMap({ $0?.candidate.exitID }) {
            if let exit = plan.exits.first(where: { $0.id == id }) { prices.load(exit: exit, apiKey: key) }
        }
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

    /// - Parameters:
    ///   - waypoints: the stops to route through, the destination last (default: the remaining ones).
    ///   - force: skip the 20 second limit between reroutes (a stop the driver just added).
    ///   - spoken: what to say once the new route is in use.
    private func reroute(from sample: LocationSample, waypoints override: [Waypoint]? = nil, force: Bool = false,
                         spoken: String? = nil) {
        guard mode == .trip, !isRerouting, !remainingWaypoints.isEmpty, !isSimulating else { return }
        if !force, let last = lastRerouteAt, sample.timestamp.timeIntervalSince(last) < 20 { return }
        // Every stop, the destination included, can already be passed (near the end of a trip).
        let waypoints = override ?? dropPassedStops()
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
                if let spoken, self.settings?.voiceEnabled == true { self.announcer.speak(spoken) }
            } catch {
                self.lastError = "Reroute failed: \(error.localizedDescription). Will retry."
            }
        }
    }

    /// Identifies the current trip (its start time), for things kept per trip like the plate game.
    var tripKey: String { tripStartedAt.map { String(Int($0.timeIntervalSince1970)) } ?? "" }

    /// A stop can be added mid-trip when a reroute is possible: a planned trip on device GPS.
    var canAddStop: Bool { mode == .trip && !isSimulating && lastSample != nil && !remainingWaypoints.isEmpty }

    /// Adds a place at an exit as the next stop and reroutes through it. Stops already on the trip keep
    /// their order; the new one goes before the first remaining stop that lies farther along the route.
    func addStop(_ place: Place, at exit: RouteExit) {
        addStop(Waypoint(name: place.displayName, coordinate: place.coordinate), alongRoute: exit.distanceAlongRoute)
    }

    /// Adds any place (a Discover place, for example) as a stop, ordered by where it is along the route.
    func addStop(_ waypoint: Waypoint, alongRoute: Double) {
        guard canAddStop, let sample = lastSample, let plan else { return }
        var list = dropPassedStops()
        func along(_ w: Waypoint) -> Double {
            plan.route.stops.first { $0.waypoint == w }?.distanceAlongRoute ?? .infinity
        }
        let index = list.firstIndex { along($0) > alongRoute } ?? max(0, list.count - 1)
        list.insert(waypoint, at: min(index, max(0, list.count - 1)))
        reroute(from: sample, waypoints: list, force: true, spoken: "Stop added: \(waypoint.name).")
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

    /// Gas along the route: exits with a gas station listed and service plazas listing gas.
    func gasStops() -> [GasGaps.Stop] {
        guard let plan else { return [] }
        if let cached = gasStopCache, cached.routeID == plan.route.id { return cached.stops }
        let stops = GasGaps.stops(plan: plan) { self.services(for: $0) }
        gasStopCache = (plan.route.id, stops)
        return stops
    }

    /// Stretches without gas in the next `window` meters, longer than the driver's setting. None for EVs.
    /// Stations no longer listed, and stops reported closed at the arrival time, do not count as gas.
    func gasGapsAhead(window: Double = 150 * Geodesy.metersPerMile) -> [GasGaps.Gap] {
        guard let plan, let snapshot, let settings, settings.vehicle?.isElectric != true else { return [] }
        let end = min(plan.route.length, snapshot.progress + window)
        let key = "\(plan.route.id)|\(snapshot.timestamp.timeIntervalSince1970)|\(snapshot.progress)|\(end)|\(settings.gasGapMiles)"
        if let memo = gapMemo, memo.key == key { return memo.gaps }
        let prefs = SmartStop.Preferences(settings.values)
        let stops = gasStops().filter { $0.distance <= snapshot.progress || $0.distance > end || gasStopUsable($0, plan: plan, snapshot: snapshot, prefs: prefs) }
        let gaps = GasGaps.find(stops: stops, from: snapshot.progress, to: end,
                                minimum: settings.gasGapMiles * Geodesy.metersPerMile, routeLength: plan.route.length)
        gapMemo = (key, gaps)
        return gaps
    }

    @ObservationIgnored private var gapMemo: (key: String, gaps: [GasGaps.Gap])?

    /// A gas stop counts unless every station there is no longer listed or reported closed when the driver gets there.
    private func gasStopUsable(_ stop: GasGaps.Stop, plan: TripPlan, snapshot: TripSnapshot, prefs: SmartStop.Preferences) -> Bool {
        let zone = plan.timeZoneID(at: stop.distance).flatMap(TimeZone.init(identifier:)) ?? TimeZone(identifier: "America/New_York")!
        let arrival = plan.eta(from: snapshot.progress, to: stop.distance, pace: snapshot.pace, now: snapshot.timestamp)
        if let r = stop.restArea {
            let c = SmartStop.Candidate(id: r.id, name: r.title, kind: .plaza, along: stop.distance, arrival: arrival, timeZone: zone, plazaHours: r.hours)
            return SmartStop.evaluate(c, preferences: prefs).hours.status != .closed
        }
        guard let exit = stop.exit else { return true }
        return services(for: exit).contains { g in
            guard g.place.category == .gas else { return false }
            let fact = data?.stations?[g.place.id]
            if fact?.gone != nil { return false }
            guard let hours = fact?.h else { return true }
            let c = SmartStop.Candidate(id: g.place.id, name: g.place.displayName, along: stop.distance,
                                        arrival: arrival.addingTimeInterval((g.detourSeconds ?? 0) / 2), timeZone: zone, osmHours: hours)
            return SmartStop.evaluate(c, preferences: prefs).hours.status != .closed
        }
    }

    func stopSuggestions(_ query: StopQuery) -> [StopSuggestion] {
        guard let plan, let snapshot, let interstates else { return [] }
        return StopPlanner(dataset: interstates).suggestions(query, plan: plan, snapshot: snapshot, pace: pace, now: snapshot.timestamp)
    }
}
