import CoreLocation
import ExitAtlasCore
import Foundation
import Observation
import UIKit

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

    enum TrafficState: Equatable {
        /// Traffic in arrival times is off in Settings.
        case off
        /// A simulated drive: Apple's traffic is for real positions at the real time, so it is not asked.
        case notChecked
        case checking
        /// Times that match the route, measured at this time.
        case ok(Date)
        /// Apple could not be reached, or none of its times matched the route.
        case unavailable(String)
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
    /// Apple Maps traffic in arrival times (docs/16): what was last heard, for the Trip tab and Settings.
    private(set) var trafficState: TrafficState = .off
    /// The extra time Apple estimates traffic adds before a checkpoint (both times matched to the route, at
    /// least 3 minutes), with when it was measured.
    private(set) var trafficExtra: (seconds: Double, to: String, at: Date)?

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
    /// The driver's own price reports on this iPhone, and SIMULATED demo prices (docs/17).
    @ObservationIgnored let priceReports = PriceReportStore()
    /// -demoPrices: SIMULATED prices at the first stations ahead, for screenshots.
    @ObservationIgnored var demoPrices = false
    /// Shared reports from other ExitAtlas drivers through the owner's server (docs/17).
    @ObservationIgnored let sharedPrices = SharedPriceService()
    @ObservationIgnored private var sharedAskedAt: Date?
    /// Road alert sources for the active trip (NWS weather; others when connected).
    @ObservationIgnored let roadAlerts = RoadAlertService()
    /// Current weather where you are, while a trip runs (NWS).
    @ObservationIgnored let weather = WeatherService()
    @ObservationIgnored private var intelMemo: (key: String, result: RoadIntel.Result?)?
    @ObservationIgnored private var fuelVoice = FuelAnnouncements()
    @ObservationIgnored private var rangePlanMemo: (key: String, plan: RangePlan?)?
    @ObservationIgnored weak var settings: UserSettings?
    @ObservationIgnored let traffic = AppleTrafficService()
    @ObservationIgnored private var trafficStabilizer = Traffic.Stabilizer()
    @ObservationIgnored private let trafficPolicy = Traffic.RefreshPolicy()
    @ObservationIgnored private var trafficLastAttempt: Date?
    @ObservationIgnored private var trafficFailures = 0
    @ObservationIgnored private var trafficRouteID: UUID?
    @ObservationIgnored private var trafficInFlight = false
    @ObservationIgnored private var lastMovingAt: Date?
    /// A SIMULATED traffic reading for screenshots (-demoTraffic): Apple is not asked.
    @ObservationIgnored private var trafficDemo = false
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
        roadAlerts.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        weather.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        chargers.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        prices.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        prices.onCall = { PriceCallCounter.count() }
        priceReports.onUpdate = { [weak self] in self?.feedsVersion += 1 }
        sharedPrices.onUpdate = { [weak self] in self?.feedsVersion += 1 }
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
        weather.reset()
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
        resetTraffic()
        remainingWaypoints = route.stops.map(\.waypoint) + [route.destination]
        mode = .trip
        snapshot = session?.snapshot(at: now)
        announcer.reset()
        weather.reset()
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
        weather.reset()
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
        if mode == .trip { considerTraffic(snap) }
        if demoPrices { seedDemoPrices() }
        refreshSharedPrices()
        if let settings {
            let gap = gasGapsAhead().first { ($0.before?.distance ?? 0) > snap.progress }
            announcer.consider(snap, settings: settings, zoneID: plan?.timeZoneID(at: snap.progress), gasGap: gap, lastOpen: lastOpenAhead,
                               alerts: roadIntel?.alerts ?? [])
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
        // Road alert sources: only while a trip runs, when due.
        roadAlerts.reset(for: plan)
        if let plan {
            var enabled: [RoadIntel.Group: Bool] = [:]
            for (k, v) in settings?.alertGroups ?? [:] { if let g = RoadIntel.Group(rawValue: k) { enabled[g] = v } }
            roadAlerts.refresh(plan: plan, progress: snap.progress, enabled: enabled)
        }
        // Current weather where you are: also only while a trip runs, when due.
        if let here = lastSample?.coordinate { weather.refresh(at: here) }
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

    /// SmartStop's view of the trip: exits, rest areas, station facts, reported prices, and Google data the
    /// driver looked up.
    func stopContext() -> SmartStop.TripContext? {
        guard let plan, let snapshot, let interstates, let settings else { return nil }
        return SmartStop.TripContext(plan: plan, snapshot: snapshot, dataset: interstates, stations: data?.stations,
                                     live: prices.loadedStations, grade: settings.gasGrade,
                                     priceRecords: priceRecords(settings), priceOptions: priceOptions)
    }

    /// The driver's own reports (when used), SIMULATED demo prices, and shared reports (when on) without
    /// the shared copies of the driver's own.
    private func priceRecords(_ settings: UserSettings) -> [String: [GasPrices.Record]] {
        var records = priceReports.records(includeOwn: settings.ownPriceReports)
        guard sharedOn else { return records }
        let mine = priceReports.sharedIDs
        for (id, list) in sharedPrices.all {
            let others = list.filter { !mine.contains($0.id) }
            if !others.isEmpty { records[id, default: []].append(contentsOf: others) }
        }
        return records
    }

    /// Shared driver reports are on: the driver turned them on and the server offers them.
    var sharedOn: Bool {
        _ = feedsVersion
        return settings?.communityPrices == true && sharedPrices.offered
    }

    /// The location check before a shared report: the phone's own GPS (not a simulated drive), a recent fix
    /// accurate to 150 m, within 250 m of the station. The position is never sent.
    func nearCheck(_ c: SmartStop.Candidate) -> (near: Bool, note: String) {
        guard gpsSource == .device else { return (false, "Simulated GPS: sharing needs your real location at the station") }
        guard let fix = lastSample, Date().timeIntervalSince(fix.timestamp) < 120, fix.horizontalAccuracy >= 0 else {
            return (false, "Location not available: saved on this iPhone only")
        }
        guard fix.horizontalAccuracy <= 150 else { return (false, "Your location is too rough to check: saved on this iPhone only") }
        guard let at = c.coordinate else { return (false, "This station's position is not known: saved on this iPhone only") }
        let d = Geodesy.distance(fix.coordinate, at)
        return d <= 250 ? (true, "You are at this station (location checked)") : (false, "About \(Format.miles(d)) from this station: saved on this iPhone only")
    }

    /// Sends one of the driver's own reports to other drivers. Returns what to tell the driver.
    func share(_ record: GasPrices.Record) async -> String {
        switch await sharedPrices.share(record, install: priceReports.installID) {
        case let .success(id):
            if !id.isEmpty { priceReports.markShared(record.id, as: id) }
            return "Shared with other ExitAtlas drivers."
        case let .failure(e):
            return "Not shared: \(e.message)."
        }
    }

    /// Asks the server for shared reports at the stations ahead, at most every 30 seconds while driving.
    private func refreshSharedPrices() {
        guard let settings else { return }
        sharedPrices.configure(settings.proxyURL)
        guard sharedOn else { return }
        if let at = sharedAskedAt, Date().timeIntervalSince(at) < 30 { return }
        sharedAskedAt = Date()
        var ids = priceStations(miles: 100).stations.map(\.id)
        if let p = smartStop?.primary?.candidate.id { ids.insert(p, at: 0) }
        sharedPrices.load(ids, enabled: settings.communityPrices)
    }

    /// What prices are compared on: the driver's grade and payment, reports up to their age limit. Nil when
    /// comparing prices is off or the vehicle is electric.
    var priceOptions: SmartStop.PriceOptions? {
        guard let settings, settings.comparePrices, settings.vehicle?.isElectric != true else { return nil }
        return SmartStop.PriceOptions(grade: settings.gasGrade, payment: GasPrices.Payment(rawValue: settings.pricePayment) ?? .credit,
                                      maxAgeHours: settings.priceMaxAgeHours, now: Date())
    }

    /// Tank and mpg for the cost of a fill (gas vehicles with both known).
    var fillVehicle: (tankGallons: Double, mpg: Double)? {
        guard let v = settings?.vehicle, !v.isElectric, let tank = v.tankGallons, tank > 0, v.milesPerGallon > 0 else { return nil }
        return (tank, v.milesPerGallon)
    }

    /// Changes with the reports, the price settings and the minute (report ages).
    private var priceKey: String {
        guard let s = settings else { return "" }
        return "\(priceReports.version)|\(s.comparePrices)\(s.pricePayment)\(s.priceMaxAgeHours)\(s.tellCheaper)\(s.minSavingsDollars)\(s.ownPriceReports)|"
            + "\(s.gasGrade.rawValue)|\(Int(Date().timeIntervalSince1970 / 60))"
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
            + "\(settings.priceOverBrand)|\(settings.overnightMode)\(settings.overnightStart)\(settings.overnightEnd)|\(settings.bufferMiles)|\(priceKey)"
        if let memo = smartMemo, memo.key == key { return memo.result }
        let result = SmartStop.choose(SmartStop.fuelCandidates(ctx, rangeLeft: range), preferences: SmartStop.Preferences(settings.values),
                                      context: .fuel, reserveMeters: settings.bufferMiles * Geodesy.metersPerMile, rejected: rejected,
                                      vehicle: fillVehicle)
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

    /// The weather where you are now, only while a trip runs; nil when nothing current is known.
    var weatherNow: CurrentWeather.Now? {
        _ = feedsVersion
        _ = snapshot
        guard mode != .idle, let here = lastSample?.coordinate else { return nil }
        return weather.current(at: here)
    }

    /// Road alerts on the route ahead and a status per Settings group. Expiry and freshness use the clock;
    /// arrival times come from the trip. Recomputed every 0.2 mile, every minute, or when a source changes.
    var roadIntel: RoadIntel.Result? {
        _ = feedsVersion
        guard let plan, let snapshot, let settings else { return nil }
        let now = Date()
        let providers = roadAlerts.providers
        let groups = settings.alertGroups.keys.sorted().map { "\($0)=\(settings.alertGroups[$0] ?? true)" }.joined(separator: ",")
        let sources = providers.map { p -> String in "\(p.id):\(p.state.rawValue):\(p.fetchedAt?.timeIntervalSince1970 ?? 0)" }.joined(separator: ",")
        let place = "\(plan.route.id)|\(Int(snapshot.progress / 320))|\(Int(now.timeIntervalSince1970 / 60))|\(feedsVersion)"
        let key = place + "|" + groups + "|" + sources
        if let memo = intelMemo, memo.key == key { return memo.result }
        var enabled: [RoadIntel.Group: Bool] = [:]
        for (k, v) in settings.alertGroups { if let g = RoadIntel.Group(rawValue: k) { enabled[g] = v } }
        let result = RoadIntel.evaluate(route: plan.route, progress: snapshot.progress, providers: providers, now: now, enabled: enabled,
                                        etaAt: { d in now.addingTimeInterval(plan.eta(to: d, from: snapshot).timeIntervalSince(snapshot.timestamp)) })
        intelMemo = (key, result)
        return result
    }

    /// The best stop in the next `miles` (restroom stops add rest areas and rank the restroom first).
    /// Recomputed every quarter mile or minute (Road Ahead and the restroom sheet ask on every update).
    func bestStopAhead(miles: Double, restrooms: Bool = false) -> SmartStop.Result? {
        bestStopEntry(miles: miles, restrooms: restrooms)?.result
    }

    /// The result and the stations and fuel plazas it looked at, cached together.
    private func bestStopEntry(miles: Double, restrooms: Bool) -> (result: SmartStop.Result?, stations: [SmartStop.Candidate])? {
        guard let settings, let ctx = stopContext() else { return nil }
        let range = settings.vehicle?.isElectric == true ? nil : rangeLeft
        let rejected = rejectedNow
        let key = [ctx.plan.route.id.uuidString, "\(miles)", "\(restrooms)", "\(Int(ctx.snapshot.progress / 400))",
                   "\(Int(ctx.snapshot.timestamp.timeIntervalSince1970 / 60))", "\(range.map { Int($0 / 400) } ?? -1)", "\(feedsVersion)",
                   "\(rejected.sorted())", "\(settings.favoriteBrands)", "\(settings.maxDetourMinutes)", "\(settings.require24Hours)",
                   "\(settings.requireRestroom)", "\(settings.priceOverBrand)", settings.overnightMode, settings.overnightStart, settings.overnightEnd,
                   "\(settings.bufferMiles)", "\(settings.gasGrade)", priceKey].joined(separator: "|")
        if let hit = bestStopMemo[key] { return hit }
        var prefs = SmartStop.Preferences(settings.values)
        if restrooms { prefs.requireRestroom = "always" }
        let candidates = SmartStop.aheadCandidates(ctx, miles: miles, rangeLeft: range, restrooms: restrooms)
        let result = SmartStop.choose(candidates, preferences: prefs,
                                      context: .ahead, purpose: restrooms ? .restroom : .fuel,
                                      reserveMeters: settings.bufferMiles * Geodesy.metersPerMile, rejected: rejected,
                                      vehicle: restrooms ? nil : fillVehicle)
        if bestStopMemo.count > 8 { bestStopMemo.removeAll() }
        let entry = (result: Optional(result), stations: restrooms ? [] : candidates.filter { $0.kind != .rest })
        bestStopMemo[key] = entry
        return entry
    }

    @ObservationIgnored private var bestStopMemo: [String: (result: SmartStop.Result?, stations: [SmartStop.Candidate])] = [:]

    /// Every station and fuel plaza in the next `miles`, with its price, and SmartStop's order for them
    /// (Compare Prices in Road Ahead).
    func priceStations(miles: Double) -> (stations: [SmartStop.Candidate], order: [String]) {
        let entry = bestStopEntry(miles: max(60, miles), restrooms: false)
        let window = miles * Geodesy.metersPerMile
        let stations = (entry?.stations ?? []).filter { ($0.ahead ?? 0) > 0 && ($0.ahead ?? 0) <= window }
        return (stations, entry?.result?.order ?? [])
    }

    /// A station or fuel plaza on the route by id (its price sheet): from the stops ahead, else any exit on the route.
    func findStation(id: String) -> SmartStop.Candidate? {
        if let c = priceStations(miles: 100).stations.first(where: { $0.id == id }) { return c }
        guard let ctx = stopContext() else { return nil }
        return SmartStop.stationCandidates(ctx, window: ctx.plan.route.length, rangeLeft: nil).first { $0.id == id }
    }

    /// Meters per second at the last GPS fix (the report sheet asks before saving while moving).
    var currentSpeed: Double? { lastSample?.speed }

    /// A station's price for one grade (its sheet shows every grade), even with comparing off: reports, and
    /// Google's when the driver checked prices at its exit.
    func stationPrice(_ c: SmartStop.Candidate, grade: GasPriceFeed.Grade) -> GasPrices.StationPrice? {
        guard var ctx = stopContext(), let settings else { return nil }
        ctx.priceOptions = priceOptions ?? SmartStop.PriceOptions(grade: grade, payment: GasPrices.Payment(rawValue: settings.pricePayment) ?? .credit,
                                                                  maxAgeHours: settings.priceMaxAgeHours, now: Date())
        return SmartStop.stopPrice(ctx, stationId: c.id, live: googleStation(for: c), grade: grade)
    }

    /// Google's record for a station, when the driver checked Google prices at its exit.
    func googleStation(for c: SmartStop.Candidate) -> GasPriceFeed.Station? {
        guard let exitID = c.exitID, let stations = prices.loadedStations[exitID], let exit = plan?.exits.first(where: { $0.id == exitID }),
              let place = services(for: exit).first(where: { $0.place.id == c.id })?.place else { return nil }
        return SmartStop.live(stations, place: place, brand: c.brand)
    }

    /// Google Maps prices for the next three exits in the price comparison not looked up in the last hour: the
    /// driver taps for more than the automatic lookups cover (docs/17).
    func checkGooglePricesAhead(miles: Double) {
        guard let settings, settings.googlePrices, !settings.googleKey.isEmpty, let plan else { return }
        var seen = Set<String>(), exits: [RouteExit] = []
        for c in priceStations(miles: miles).stations.sorted(by: { ($0.ahead ?? 0) < ($1.ahead ?? 0) }) {
            guard let id = c.exitID, seen.insert(id).inserted else { continue }
            if prices.entry(for: id) != nil { continue }
            if let exit = plan.exits.first(where: { $0.id == id }) { exits.append(exit) }
            if exits.count == 3 { break }
        }
        for exit in exits { prices.load(exit: exit, apiKey: settings.googleKey) }
    }

    /// What a price screen shows, for the automatic Google lookups.
    enum PriceScreen {
        case roadAhead(miles: Double)
        case fuelStop
        case station(String)
    }

    /// Google Maps prices without a tap (docs/17), once the driver turned them on: the exits on screen, most
    /// relevant first: a station sheet's own exit, SmartStop's pick and alternatives, then Road Ahead's
    /// stations in SmartStop's order (favorite brand first). Price screens call it when they appear and every
    /// half mile while shown. Google does not allow pre-fetching, so exits that are not shown are never
    /// looked up. A few at a time, within the daily budget (GasPrices.AutoLookupRules).
    func autoGooglePrices(_ screen: PriceScreen) {
        guard let settings, (settings.googlePrices && !settings.googleKey.isEmpty) || prices.fixture != nil,
              settings.vehicle?.isElectric != true, let plan, let snapshot else { return }
        var exits: [(id: String, ahead: Double)] = []
        func add(_ id: String?) {
            guard let id, let e = plan.exits.first(where: { $0.id == id }) else { return }
            exits.append((id, e.distanceAlongRoute - snapshot.progress))
        }
        switch screen {
        case .station(let id): add(findStation(id: id)?.exitID)
        case .fuelStop, .roadAhead:
            if let sm = smartStop { for p in [sm.primary].compactMap({ $0 }) + sm.alternatives { add(p.candidate.exitID) } }
        }
        if case .roadAhead(let miles) = screen {
            let ps = priceStations(miles: miles)
            let byID = Dictionary(ps.stations.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            for id in ps.order { add(byID[id]?.exitID) }
            for c in ps.stations.sorted(by: { ($0.ahead ?? 0) < ($1.ahead ?? 0) }) { add(c.exitID) }
        }
        let ids = GasPrices.autoLookups(exits, now: Date(), usedToday: PriceCallCounter.today, lastLookup: { self.prices.lastLookup($0) })
        for id in ids { if let exit = plan.exits.first(where: { $0.id == id }) { prices.load(exit: exit, apiKey: settings.googleKey) } }
    }

    /// -googleFixture (UI tests only): Google's answers are made up from the gas stations mapped at each exit, at
    /// their own spots, with TEST prices ($3.411, $3.421, ...), so the automatic lookups can be shown without a
    /// key. Nothing is sent to Google. Compare Prices labels them simulated.
    func useGoogleFixture() {
        prices.fixture = { [weak self] exit in
            let gas = (self?.services(for: exit) ?? []).filter { $0.place.category == .gas }
            let updated = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-40 * 60))
            var places: [[String: Any]] = []
            for (i, s) in gas.enumerated() {
                let money: [String: Any] = ["currencyCode": "USD", "units": "3", "nanos": (411 + 10 * i) * 1_000_000]
                let price: [String: Any] = ["type": "REGULAR_UNLEADED", "updateTime": updated, "price": money]
                let name = s.place.brand.isEmpty ? s.place.displayName : s.place.brand
                places.append(["id": "test-\(s.place.id)", "displayName": ["text": name],
                               "location": ["latitude": s.place.coordinate.latitude, "longitude": s.place.coordinate.longitude],
                               "fuelOptions": ["fuelPrices": [price]] as [String: Any]])
            }
            return (try? JSONSerialization.data(withJSONObject: ["places": places])) ?? Data()
        }
    }

    /// Google Maps prices for an exit: paid, so only when the driver turned them on (docs/17).
    func checkGooglePrices(exitID: String) {
        guard let settings, settings.googlePrices, !settings.googleKey.isEmpty, let exit = plan?.exits.first(where: { $0.id == exitID }) else { return }
        prices.load(exit: exit, apiKey: settings.googleKey)
    }

    /// SIMULATED prices for the demo: a current one, one three drivers agree on, an old one, and the fuel stop
    /// pick, so every state shows. Never saved. Re-seeded when the first stations ahead change.
    func seedDemoPrices() {
        guard demoPrices, let settings else { return }
        let ahead = priceStations(miles: 60).stations
            .filter { $0.kind == .station }.sorted { ($0.ahead ?? 0) < ($1.ahead ?? 0) }
        var picks = Array(ahead.prefix(3))
        if let p = smartStop?.primary?.candidate, !picks.contains(where: { $0.id == p.id }) { picks.append(p) }
        let have = Set(priceReports.simulated.map(\.stationId))
        guard !picks.isEmpty, !picks.allSatisfy({ have.contains($0.id) }) else { return }
        let seeds: [(price: Double, age: Double, count: Int)] = [(3.099, 20 * 60, 1), (2.899, 2 * 3600, 3), (3.189, 30 * 3600, 1), (3.299, 40 * 60, 1)]
        let now = Date()
        var out: [GasPrices.Record] = []
        for (i, c) in picks.enumerated() where i < seeds.count {
            let (price, age, n) = seeds[i]
            for k in 0..<n {
                out.append(GasPrices.Record(id: "sim:\(c.id):\(k)", stationId: c.id, grade: settings.gasGrade.code, price: price, payment: .credit,
                                            reportedAt: now.addingTimeInterval(-age - Double(k) * 600), reporter: "sim\(k)",
                                            source: PriceReportStore.simulatedSource))
            }
        }
        priceReports.simulated = out
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

    /// Google Maps prices near an exit looked up in the last hour (never looked up here).
    func gasPrices(at exit: RouteExit) -> GasPriceService.Entry? {
        _ = feedsVersion
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

    // MARK: Traffic (docs/16)

    private func resetTraffic() {
        trafficStabilizer = Traffic.Stabilizer()
        trafficLastAttempt = nil
        trafficFailures = 0
        trafficRouteID = nil
        trafficExtra = nil
        trafficDemo = false
        lastMovingAt = nil
        trafficState = settings?.trafficInETA == false ? .off : .checking
    }

    /// Asks Apple Maps for traffic aware times when due: about every 5 minutes while moving with the app in
    /// front, at once after a reroute, never while parked, in the background or during a simulated drive, and
    /// less often after failures. The answer goes through the stabilizer into the session's arrival times.
    private func considerTraffic(_ snap: TripSnapshot) {
        guard let plan, let settings, !trafficDemo else { return }
        guard settings.trafficInETA else {
            if trafficState != .off || session?.traffic != nil {
                trafficState = .off
                trafficExtra = nil
                session?.traffic = nil
                trafficStabilizer = Traffic.Stabilizer()
            }
            return
        }
        if isSimulating {
            if trafficState != .notChecked { trafficState = .notChecked }
            return
        }
        let now = snap.timestamp
        if snap.match.speed > 2 || lastMovingAt == nil { lastMovingAt = now }
        let stillFor = lastMovingAt.map { now.timeIntervalSince($0) } ?? 0
        let routeChanged = trafficRouteID != plan.route.id
        guard !trafficInFlight,
              trafficPolicy.isDue(lastAttempt: trafficLastAttempt, failures: trafficFailures, routeChanged: routeChanged,
                                  stillFor: stillFor, foreground: UIApplication.shared.applicationState == .active, now: now) else { return }
        let checkpoints = AppleTrafficService.checkpoints(plan: plan, snapshot: snap)
        guard !checkpoints.isEmpty else { return }
        trafficInFlight = true
        trafficLastAttempt = now
        trafficRouteID = plan.route.id
        if session?.traffic == nil { trafficState = .checking }
        let id = tripID, routeID = plan.route.id, progress = snap.progress
        let origin = plan.route.polyline.coordinate(at: progress)
        Task { @MainActor in
            defer { self.trafficInFlight = false }
            do {
                let result = try await self.traffic.measure(routeId: routeID.uuidString, origin: origin, progress: progress,
                                                            checkpoints: checkpoints, avoidTolls: settings.avoidTolls, now: Date())
                guard self.tripID == id, self.plan?.route.id == routeID, settings.trafficInETA else { return }
                self.trafficFailures = 0
                self.applyTraffic(result.reading, extra: result.extra, failure: "None of Apple's times matched your route")
            } catch {
                guard self.tripID == id else { return }
                self.trafficFailures += 1
                self.applyTraffic(nil, extra: nil, failure: "Apple Maps could not be reached")
            }
        }
    }

    /// Offers a reading to the stabilizer (nil keeps the one shown while it is usable) and updates the times.
    private func applyTraffic(_ reading: Traffic.Reading?, extra: (seconds: Double, to: String)?, failure: String) {
        guard var session, let plan else { return }
        let now = Date()
        let progress = session.snapshot(at: now).progress
        let pace = session.pace
        let timing = Traffic.Timing(modelSeconds: { plan.route.timeProfile.seconds(from: $0, to: $1) },
                                    paceSeconds: { pace.seconds(forModelSeconds: $0) })
        let out = trafficStabilizer.offer(reading, routeId: plan.route.id.uuidString, progress: progress, now: now, timing: timing)
        session.traffic = out.reading
        self.session = session
        if out.changed { trafficExtra = extra.map { ($0.seconds, $0.to, now) } }
        if let shown = out.reading {
            trafficState = .ok(shown.measuredAt)
        } else {
            trafficState = .unavailable(failure)
            trafficExtra = nil
        }
        snapshot = session.snapshot(at: now)
    }

    /// -demoTraffic: a SIMULATED reading for screenshots, 20% slower than the route's own times to each
    /// checkpoint, labeled "Simulated traffic". Apple is not asked.
    func injectDemoTraffic() {
        guard let plan, var session, let snap = snapshot else { return }
        trafficDemo = true
        let checkpoints = AppleTrafficService.checkpoints(plan: plan, snapshot: snap)
        let measurements = checkpoints.map { cp -> Traffic.Measurement in
            let meters = cp.along - snap.progress
            return Traffic.Measurement(along: cp.along, routeMeters: meters, providerMeters: meters,
                                       seconds: 1.2 * plan.route.timeProfile.seconds(from: snap.progress, to: cp.along))
        }
        let now = Date()
        session.traffic = Traffic.reading(routeId: plan.route.id.uuidString, measuredAt: now, fromAlong: snap.progress,
                                          measurements: measurements, source: .init(id: "demo", name: "Simulated traffic"))
        self.session = session
        if let last = session.traffic?.checkpoints.last, let cp = checkpoints.first(where: { $0.along == last.along }) {
            trafficExtra = (last.seconds - last.seconds / 1.2, cp.place, now)
        }
        trafficState = session.traffic.map { .ok($0.measuredAt) } ?? .unavailable("No simulated checkpoints")
        // At the last fix's time: the frozen demo does not move on.
        snapshot = session.snapshot(at: snap.timestamp)
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

    /// The next stop or the destination still ahead on a planned trip, for handing off to Waze.
    var nextWaypoint: Waypoint? { mode == .trip ? dropPassedStops().first : nil }

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
        let arrival = plan.eta(to: stop.distance, from: snapshot)
        if let r = stop.restArea {
            let c = SmartStop.Candidate(id: r.id, name: r.title, kind: .plaza, along: stop.distance, arrival: arrival, timeZone: zone, plazaHours: r.hours)
            return SmartStop.evaluate(c, preferences: prefs).hours.status != .closed
        }
        guard let exit = stop.exit else { return true }
        return services(for: exit).contains { g in
            guard g.place.category == .gas else { return false }
            let fact = data?.stations?[g.place.id]
            if fact?.gone != nil { return false }
            guard fact?.h != nil || fact?.ah != nil else { return true }
            let c = SmartStop.Candidate(id: g.place.id, name: g.place.displayName, along: stop.distance,
                                        arrival: arrival.addingTimeInterval((g.detourSeconds ?? 0) / 2), timeZone: zone,
                                        osmHours: fact?.h, osmChecked: fact?.hc, brandHours: fact?.ah, listedBy: fact?.ab,
                                        brandCollected: data?.stations?.metadata.brand_collected)
            return SmartStop.evaluate(c, preferences: prefs).hours.status != .closed
        }
    }

    func stopSuggestions(_ query: StopQuery) -> [StopSuggestion] {
        guard let plan, let snapshot, let interstates else { return [] }
        return StopPlanner(dataset: interstates).suggestions(query, plan: plan, snapshot: snapshot, pace: pace, now: snapshot.timestamp)
    }
}
