import ExitAtlasCore
import SwiftUI

/// The Drive screen: the Navigation View (map first) or the Focus View (the compact dashboard), the driver's
/// choice saved in the profile; before a trip, the start cards.
struct DriveView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Binding var selectedTab: RootView.Tab
    @State private var showWeather = false

    var body: some View {
        let mapMode = trip.snapshot != nil && settings.drivePresentation != "focus"
        NavigationStack {
            Group {
                if let snapshot = trip.snapshot {
                    DriveDashboard(selectedTab: $selectedTab, snapshot: snapshot)
                } else {
                    ScrollView {
                        VStack(spacing: 14) {
                            if trip.mode == .discovery {
                                DiscoveryWaitingCard(status: trip.discoveryStatus)
                            } else {
                                StartCard(selectedTab: $selectedTab)
                            }
                            if let error = trip.lastError {
                                Label(error, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.amber)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 24)
                    }
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .simulationBanner(trip.isSimulating)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TrackingStatusPill(match: trip.snapshot?.match, simulated: trip.isSimulating, rerouting: trip.isRerouting)
                }
                // Current weather where you are, in the middle of the top bar while a trip runs.
                if let weather = trip.weatherNow, let temperature = weather.temperatureF {
                    ToolbarItem(placement: .principal) {
                        WeatherPill(weather: weather, temperature: temperature) { showWeather = true }
                    }
                }
                if trip.mode != .idle {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("End", role: .destructive) { trip.endTrip() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) { SettingsButton() }
            }
            .navigationBarTitleDisplayMode(.inline)
            // Over the map the bar's own background goes, so the road shows under the controls.
            .toolbarBackground(mapMode ? .hidden : .automatic, for: .navigationBar)
            .sheet(isPresented: $showWeather) { WeatherSheet() }
        }
    }
}

/// The trip's Drive screen: one adaptive card chosen by DashboardFocus (alert, planned stop, gas gap, state
/// line, fuel, last open stop, overnight stop, rest area or next exit) and held steady by its Stabilizer, in
/// the driver's presentation. Relevant items replace less urgent ones; nothing is added.
private struct DriveDashboard: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @State private var showFuel = false
    @State private var showRestroom = false
    @State private var shownRestArea: RouteRestArea?
    @State private var shownExit: RouteExit?
    @State private var shownAlert: AlertRef?
    @State private var stabilizer = DashboardFocus.Stabilizer()
    @Binding var selectedTab: RootView.Tab
    let snapshot: TripSnapshot

    var body: some View {
        let focus = stabilizer.choose(signals, at: snapshot.timestamp)
        let mapMode = settings.drivePresentation != "focus"
        Group {
            if mapMode {
                NavigationDriveView(snapshot: snapshot, focus: focus, alert: focusAlert, card: card(focus, exitShown: true),
                                    openExit: { shownExit = $0 }, openFuel: { showFuel = true },
                                    openRestroom: { showRestroom = true }, openTrip: { selectedTab = .trip })
            } else {
                ScrollView {
                    FocusDriveView(snapshot: snapshot, focus: focus, card: card(focus, exitShown: true),
                                   openExit: { shownExit = $0 }, openFuel: { showFuel = true },
                                   openRestroom: { showRestroom = true }, openTrip: { selectedTab = .trip })
                        .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 16)
                }
            }
        }
        .sheet(isPresented: $showFuel) { FuelView() }
        .sheet(isPresented: $showRestroom) { RestroomSheet() }
        .sheet(item: $shownRestArea) { r in
            NavigationStack { RestAreaDetailView(restArea: r, showsDone: true) }
        }
        .sheet(item: $shownAlert) { AlertDetailView(alertID: $0.id) }
        .sheet(item: $shownExit) { e in
            NavigationStack {
                ExitDetailView(exit: e)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { shownExit = nil } } }
            }
        }
    }

    /// What the focus rule needs from the trip.
    private var signals: DashboardFocus.Signals {
        let progress = snapshot.progress
        let gap = trip.gasGapsAhead().first { $0.to > progress }
        var fuel: DashboardFocus.Signals.Fuel?
        if let plan = trip.rangePlan {
            let needed = plan.status != .destination
            let smart = needed ? trip.smartStop : nil
            fuel = .init(range: plan.range, reserve: settings.bufferMiles * Geodesy.metersPerMile,
                         stopAhead: needed ? (smart?.primary?.candidate.ahead ?? plan.recommended?.ahead) : nil,
                         low: needed && ((smart?.lowRange ?? false) || plan.status == .low))
        }
        let zone = trip.plan?.timeZoneID(at: progress).flatMap(TimeZone.init(identifier:)) ?? .current
        let minute = OpeningHours.localTime(snapshot.timestamp, in: zone).minute
        return DashboardFocus.Signals(
            nextExit: snapshot.nextExit?.distance, restArea: snapshot.nextRestArea?.distance,
            gap: gap.map { (startsIn: max(0, $0.from - progress), length: $0.to - max($0.from, progress)) },
            plannedStop: snapshot.nextStop?.distance, fuel: fuel,
            overnight: SmartStop.Preferences(settings.values).overnight(atMinute: minute),
            lastOpen: trip.lastOpenAhead?.stop.ahead,
            alert: focusAlert.map { (distance: max(0, $0.start - progress), serious: $0.serious) },
            alertID: focusAlert?.incident.id,
            border: snapshot.next != nil ? snapshot.current?.remainingMeters : nil)
    }

    /// The alert the focus rule considers (RoadIntel.Result.focusAlert).
    private var focusAlert: RoadIntel.Alert? { trip.roadIntel?.focusAlert(progress: snapshot.progress) }

    /// One adaptive card: the focus, or, when the focus already has its own place on screen (the next exit in
    /// the guidance or exit row, the state line in the journey panel), the first strip item worth a card.
    private func card(_ focus: DashboardFocus.Result, exitShown: Bool) -> AnyView? {
        var kind: DashboardFocus.Kind? = focus.focus
        if focus.focus == .border, settings.drivePresentation != "focus" { return AnyView(BorderApproachCard(snapshot: snapshot)) }
        if [.border, .none].contains(focus.focus) || (exitShown && focus.focus == .exit) {
            kind = focus.strip.first { [.alert, .fuel, .stop, .gap, .restArea].contains($0) }
        }
        guard let kind else {
            return trip.lastError.map { AnyView(Label($0, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.amber).padding(10).floating()) }
        }
        return AnyView(focusCard(kind))
    }

    @ViewBuilder
    private func focusCard(_ kind: DashboardFocus.Kind) -> some View {
        switch kind {
        case .alert:
            if let a = focusAlert { AlertCard(alert: a, progress: snapshot.progress, now: snapshot.timestamp) { shownAlert = AlertRef(id: a.incident.id) } }
        case .fuel:
            FuelCard { showFuel = true }
        case .stop:
            if let next = snapshot.nextStop { PlannedStopCard(stop: next.stop, distance: next.distance, eta: next.eta, now: snapshot.timestamp) }
        case .gap:
            if let gap = trip.gasGapsAhead().first(where: { $0.to > snapshot.progress }) { GasGapCard(gap: gap, progress: snapshot.progress) }
        case .lastOpen:
            if let lo = trip.lastOpenAhead { LastOpenCard(lastOpen: lo, now: snapshot.timestamp) }
        case .overnight:
            if trip.rangeLeft != nil {
                FuelCard { showFuel = true }
            } else {
                OvernightRestroomCard(now: snapshot.timestamp) { shownRestArea = $0 }
            }
        case .restArea:
            if let rest = snapshot.nextRestArea {
                Button { shownRestArea = rest.restArea } label: {
                    RestAreaCard(upcoming: rest, then: snapshot.upcomingRestAreas.first { $0.id != rest.id }, now: snapshot.timestamp)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("restAreaCard")
            }
        case .exit, .border:
            if let next = snapshot.nextExit {
                NextExitCard(upcoming: next, services: trip.services(for: next.exit), now: snapshot.timestamp)
            }
        case .none, .fuelEntry:
            EmptyView()
        }
    }
}

/// Approaching a planned stop: the stop, its arrival time and the exit to leave at.
private struct PlannedStopCard: View {
    @Environment(TripController.self) private var trip
    let stop: RouteStop
    let distance: Double
    let eta: Date
    let now: Date

    var body: some View {
        let at = stop.distanceAlongRoute
        let exit = trip.plan?.exits.filter { $0.distanceAlongRoute > (trip.snapshot?.progress ?? 0) }
            .min { abs($0.distanceAlongRoute - at) < abs($1.distanceAlongRoute - at) }
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "Planned stop")
            HStack(spacing: 12) {
                if let exit { ExitSign(label: exit.label, compact: true) }
                VStack(alignment: .leading, spacing: 2) {
                    Text(stop.waypoint.name).font(.headline).lineLimit(2)
                    Text(Format.time(eta, timeZoneID: trip.plan?.timeZoneID(at: at), relativeTo: now) + (exit.map { " · leave at \($0.displayTitle)" } ?? ""))
                        .font(.subheadline).foregroundStyle(Theme.secondaryText)
                }
                Spacer(minLength: 4)
                Text(Format.milesValue(distance)).font(Theme.number(28, weight: .heavy)) + Text(" mi").font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("plannedStopCard")
    }
}

/// A road alert ahead: what, where, how sure, from whom. Driver reports say they are unconfirmed.
private struct AlertCard: View {
    @Environment(TripController.self) private var trip
    let alert: RoadIntel.Alert
    let progress: Double
    let now: Date
    let open: () -> Void

    var body: some View {
        let i = alert.incident
        let tier = i.tier
        Button(action: open) {
            HStack(alignment: .top, spacing: 12) {
                AlertIcon(kind: i.kind, tier: tier)
                VStack(alignment: .leading, spacing: 3) {
                    Text(i.headline.uppercased()).font(.caption.weight(.heavy)).tracking(0.8).foregroundStyle(tier.color)
                    if let road = AlertText.road(alert, plan: trip.plan) { Text(road).font(.headline) }
                    if let sub = AlertText.subtitle(i) { Text(sub).font(.subheadline) }
                    if i.verification == .community { Text("Reported by drivers, not confirmed").font(.subheadline).foregroundStyle(Theme.amber) }
                    if !alert.directionKnown { Text("Direction not reported").font(.caption).foregroundStyle(Theme.secondaryText) }
                    Text(AlertText.meta(alert, now: Date(), timeZoneID: trip.plan?.timeZoneID(at: alert.start), reference: now))
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
                Spacer(minLength: 4)
                TimelineDistance(meters: alert.start - progress)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
            .overlay(alignment: .leading) {
                UnevenRoundedRectangle(topLeadingRadius: 20, bottomLeadingRadius: 20, style: .continuous).fill(tier.color).frame(width: 4)
            }
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(tier == .urgent ? Theme.danger : .clear, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("alertCard")
    }
}

/// Overnight, before a long stretch where no stop is listed open at its arrival time: the last one that is.
private struct LastOpenCard: View {
    let lastOpen: SmartStop.LastOpen
    let now: Date

    var body: some View {
        let c = lastOpen.stop
        let one = lastOpen.unlisted == 1
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(text: "🌙 Last stop listed open for \(Format.miles(lastOpen.length))\(lastOpen.openEnded ? "+" : "")")
            HStack(alignment: .top, spacing: 12) {
                SmartStopSign(candidate: c)
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.name).font(.headline).lineLimit(2)
                    ConfidenceLine(status: lastOpen.evaluation.hours.status.rawValue, label: lastOpen.evaluation.hours.label)
                    Text(SmartStopText.whereLine(c) + " · " + SmartStopText.arrival(c, now: now))
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            Text("\(one ? "The next stop" : "The next \(lastOpen.unlisted) stops"), \(lastOpen.openEnded ? "in the next" : "over") "
                 + "\(Format.miles(lastOpen.length)), \(one ? "has" : "have") no hours listed open at your arrival time.")
                .font(.caption).foregroundStyle(Theme.secondaryText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .card()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("lastOpenCard")
    }
}

/// Overnight without a range reading: the best restroom stop in the next 60 miles, with its confidence.
private struct OvernightRestroomCard: View {
    @Environment(TripController.self) private var trip
    let now: Date
    let openRestArea: (RouteRestArea) -> Void

    var body: some View {
        if let r = trip.bestStopAhead(miles: 60, restrooms: true), let p = r.primary {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Overnight · restroom stop")
                HStack(alignment: .top, spacing: 12) {
                    SmartStopSign(candidate: p.candidate)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(p.candidate.name).font(.headline).lineLimit(2)
                        SmartStopConfidence(pick: p, overnight: true)
                        Text(SmartStopText.whereLine(p.candidate) + " · " + SmartStopText.arrival(p.candidate, now: now))
                            .font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                if let notice = r.notice { Text(notice).font(.caption).foregroundStyle(Theme.secondaryText) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
            .onTapGesture {
                if let id = p.candidate.id.hasPrefix("rest-") ? p.candidate.id : nil,
                   let rest = trip.plan?.restAreas.first(where: { $0.id == id }) { openRestArea(rest) }
            }
            .accessibilityIdentifier("overnightCard")
        }
    }
}



/// Range left and the recommended fuel or charging stop; opens the fuel sheet.
private struct FuelCard: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    let open: () -> Void

    var body: some View {
        let electric = settings.vehicle?.isElectric == true
        Button(action: open) {
            HStack(spacing: 12) {
                Image(systemName: electric ? "bolt.car.fill" : "fuelpump.fill").font(.title2)
                    .foregroundStyle(color).frame(width: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Eyebrow(text: (electric ? "Charging" : "Fuel") + (smart?.overnight == true ? " · Overnight" : ""), color: color)
                    Text(headline).font(.headline).lineLimit(2)
                    if let pick = smart?.primary { SmartStopConfidence(pick: pick, overnight: smart?.overnight == true) }
                    Text(detail).font(.subheadline).foregroundStyle(Theme.secondaryText).lineLimit(2)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").foregroundStyle(Theme.secondaryText)
            }
        }
        .buttonStyle(.plain)
        .card()
        .accessibilityIdentifier("fuelCard")
    }

    private var plan: RangePlan? { trip.rangePlan }
    /// SmartStop's pick for gas vehicles (nil for electric vehicles or when no stop is needed).
    private var smart: SmartStop.Result? { trip.smartStop }

    private var color: Color {
        guard let plan else { return Theme.secondaryText }
        if let smart, smart.primary != nil, plan.status != .destination { return smart.lowRange ? Theme.amber : Theme.signGreen }
        switch plan.status {
        case .destination, .planned: return Theme.signGreen
        case .low: return Theme.amber
        case .none: return Theme.danger
        }
    }

    private var headline: String {
        guard let left = trip.rangeLeft else { return "Enter miles to empty" }
        guard let plan else { return "\(Format.miles(left)) of range" }
        if plan.status != .destination, let p = smart?.primary {
            let c = p.candidate
            return (p.brandRank != nil ? "★ " : "") + c.name + (c.exitLabel.map { ", Exit \($0)" } ?? "") + " in \(Format.miles(c.ahead ?? 0))"
        }
        switch plan.status {
        case .destination: return "No stop needed"
        case .none: return "Nothing listed before empty"
        case .planned, .low:
            guard let rec = plan.recommended else { return "\(Format.miles(left)) of range" }
            let name = rec.candidate.exit?.displayTitle ?? rec.candidate.charger?.station.name ?? "Stop"
            return (rec.favorite ? "★ " : "") + "\(name) in \(Format.miles(rec.ahead))"
        }
    }

    private var detail: String {
        guard let left = trip.rangeLeft else {
            return "From your dashboard. ExitAtlas finds the exit where you will have about \(Int(settings.bufferMiles)) mi left."
        }
        if plan?.status != .destination, let c = smart?.primary?.candidate, let there = c.rangeOnArrival {
            return "\(Format.miles(left)) of range now, about \(Format.miles(there)) left there"
        }
        guard let plan, let rec = plan.recommended, plan.status == .planned || plan.status == .low else {
            if let spare = plan?.destinationSpare { return "\(Format.miles(left)) of range, about \(Format.miles(spare)) left at arrival" }
            return "\(Format.miles(left)) of range"
        }
        return "\(Format.miles(left)) of range now, about \(Format.miles(rec.rangeOnArrival)) left there"
    }
}


/// The next rest area or service plaza with its verified amenities.
private struct RestAreaCard: View {
    let upcoming: UpcomingRestArea
    let then: UpcomingRestArea?
    let now: Date

    var body: some View {
        let r = upcoming.restArea
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "Next \(r.kind.title.lowercased())")
            HStack(spacing: 12) {
                RestAreaSign(kind: r.kind)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.title).font(.title3.weight(.bold)).lineLimit(2).minimumScaleFactor(0.8)
                    Text((r.side == .both ? "Serves both directions · " : "") + r.road).font(.caption).foregroundStyle(Theme.secondaryText)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(Format.milesValue(upcoming.distance)).font(Theme.number(28, weight: .heavy))
                        Text("mi").font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                    Text(Format.duration(upcoming.eta.timeIntervalSince(now))).font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            AmenityChips(restArea: r)
            if let then {
                Text("Then \(then.restArea.title), \(Format.miles(then.distance))").font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .card()
    }
}

/// Amber card when the next stretch without gas starts within 25 miles, or the driver is in one.
private struct GasGapCard: View {
    let gap: GasGaps.Gap
    let progress: Double

    var body: some View {
        let inside = (gap.before?.distance ?? progress) <= progress
        let plus = gap.open ? "+" : ""
        HStack(spacing: 12) {
            Image(systemName: "fuelpump.slash.fill").font(.title2)
            VStack(alignment: .leading, spacing: 2) {
                if inside {
                    Text("No gas for the next \(Format.miles(gap.to - progress))\(plus)").font(.headline)
                    Text(gap.after.map { "Next gas at \($0.title)" } ?? "None listed ahead on this route").font(.subheadline)
                } else if let before = gap.before {
                    Text("Last gas for \(Format.miles(gap.length))\(plus): \(before.title)").font(.headline)
                    Text("In \(Format.miles(before.distance - progress))" + (gap.after.map { ", then next gas at \($0.title)" } ?? ""))
                        .font(.subheadline)
                }
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.amber)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.amber.opacity(0.14), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

private struct NextExitCard: View {
    let upcoming: UpcomingExit
    let services: [ExitService]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "Next exit")
            GuideSign(exit: upcoming.exit, distance: upcoming.distance, seconds: upcoming.eta.timeIntervalSince(now), services: services)
            ServicePlaques(services: services)
        }
        .card()
    }
}


private struct DiscoveryWaitingCard: View {
    let status: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: "Discovery mode")
            Text(status).font(.title2.weight(.bold))
            Text("ExitAtlas matches your GPS position and heading to interstate corridors. Once it locks on, exits, state lines and mileage appear here. No destination needed.")
                .font(.subheadline).foregroundStyle(Theme.secondaryText)
            ProgressView().padding(.top, 4)
        }
        .card(padding: 18)
        .padding(.top, 12)
    }
}

private struct StartCard: View {
    @Environment(TripController.self) private var trip
    @Binding var selectedTab: RootView.Tab

    var body: some View {
        VStack(spacing: 14) {
            if let record = trip.resumable, let destination = record.destination {
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: "Trip in progress", color: Theme.amber)
                    Text("Resume your trip to \(destination.name)").font(.headline)
                    Text("\(Format.miles(record.ledger.totalMeters)) driven so far. The route is recalculated from your current location; miles per state are kept.")
                        .font(.subheadline).foregroundStyle(Theme.secondaryText)
                    HStack {
                        Button {
                            Task { await trip.resume(record) }
                        } label: {
                            Label("Resume", systemImage: "arrow.clockwise").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.signGreen)
                        Button("Discard", role: .destructive) { trip.discardResumable() }
                            .buttonStyle(.bordered)
                    }
                }
                .card(padding: 18)
            }
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Plan a trip")
                Text("Where are you headed?").font(.title2.weight(.bold))
                Text("Get every state on your route, miles in each state, exits before each state line, and services at every exit.")
                    .font(.subheadline).foregroundStyle(Theme.secondaryText)
                Button {
                    selectedTab = .trip
                } label: {
                    Label("Plan a route", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent).tint(Theme.signGreen).controlSize(.large)
            }
            .card(padding: 18)
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: "Just driving")
                Text("Follow the interstate you are on").font(.headline)
                Text("Discovery mode finds your highway and direction automatically and shows what is ahead.")
                    .font(.subheadline).foregroundStyle(Theme.secondaryText)
                Button {
                    trip.startDiscovery()
                } label: {
                    Label("Start discovery mode", systemImage: "location.north.line").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered).controlSize(.large)
            }
            .card(padding: 18)
        }
        .padding(.top, 12)
    }
}
