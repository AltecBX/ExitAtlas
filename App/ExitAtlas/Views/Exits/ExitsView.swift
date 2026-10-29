import ExitAtlasCore
import SwiftUI

/// Road Ahead (docs/15): a timeline in route order with exits, rest areas, state lines, road alerts, gas gaps
/// and planned stops, the best stop ahead on top, and filters that never hide an urgent alert without saying
/// so. Same rules as the website (web/js/app/views.js, exitsView).
struct ExitsView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @State private var filter: AheadFilter = .all
    @State private var showSearch = false
    @State private var showFuel = false
    @State private var showRestroom = false
    @State private var shownAlert: AlertRef?

    static let windows: [Double] = [5, 10, 25, 50, 100]

    enum Row: Identifiable {
        case exit(UpcomingExit)
        case state(SegmentForecast, distance: Double, current: Bool)
        case rest(UpcomingRestArea)
        case gap(GasGaps.Gap)
        case stop(RouteStop, distance: Double)
        case alert(RoadIntel.Alert)

        var id: String {
            switch self {
            case let .exit(e): return e.id
            case let .state(f, _, current): return "state-\(f.segment.index)-\(current)"
            case let .rest(r): return r.id
            case let .gap(g): return "gap-\(g.from)"
            case let .stop(st, _): return "stop-\(st.id)"
            case let .alert(a): return "alert-\(a.incident.id)"
            }
        }
    }

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Group {
                if let snapshot = trip.snapshot {
                    let window = settings.exitLookaheadMiles * Geodesy.metersPerMile
                    let alerts = (trip.roadIntel?.alerts ?? []).filter { $0.start - snapshot.progress <= window }
                    let best = bestStop()
                    let items = rows(for: snapshot, alerts: alerts, pick: best?.result.primary)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            VStack(alignment: .leading, spacing: 10) {
                                if filter != .states {
                                    Picker("Show the next", selection: $settings.exitLookaheadMiles) {
                                        ForEach(Self.windows, id: \.self) { Text("\(Int($0)) mi").tag($0) }
                                    }
                                    .pickerStyle(.segmented)
                                }
                                AheadFilterBar(selection: $filter, alertCount: alerts.count, urgent: alerts.contains { $0.incident.tier == .urgent })
                                filterNote(alerts)
                                if let intel = trip.roadIntel {
                                    AlertStatusView(intel: intel, expanded: filter == .alerts).id(filter == .alerts)
                                }
                                if filter == .states {
                                    Text("Every state ahead on this route, whatever the distance window.").font(.caption).foregroundStyle(Theme.secondaryText)
                                }
                                if let best { BestStopCard(result: best.result, title: best.title) }
                            }
                            .padding(.bottom, 12)
                            if items.isEmpty {
                                empty(alerts: alerts).padding(.bottom, 12)
                            }
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, row in
                                timelineRow(row, snapshot: snapshot, pick: best?.result.primary, pickTitle: best?.tag ?? "",
                                            first: index == 0, last: index == items.count - 1)
                            }
                            VStack(alignment: .leading, spacing: 12) {
                                tools
                                DataAttribution()
                            }
                            .padding(.top, 8)
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 24)
                    }
                    .background(Theme.background.ignoresSafeArea())
                    .simulationBanner(trip.isSimulating)
                } else {
                    ContentUnavailableView("No active trip", systemImage: "road.lanes",
                                           description: Text("Plan a trip or start discovery mode to see the road ahead."))
                }
            }
            .navigationTitle("Road Ahead")
            .navigationDestination(for: RouteExit.self) { ExitDetailView(exit: $0) }
            .navigationDestination(for: RouteRestArea.self) { RestAreaDetailView(restArea: $0) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSearch = true } label: { Label("Find along route", systemImage: "magnifyingglass") }
                        .disabled(trip.snapshot == nil)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showFuel = true } label: { Label("Fuel", systemImage: "fuelpump") }
                        .disabled(trip.snapshot == nil)
                }
                ToolbarItem(placement: .topBarTrailing) { SettingsButton() }
            }
            .sheet(isPresented: $showSearch) { AlongRouteSearchView() }
            .sheet(isPresented: $showFuel) { FuelView() }
            .sheet(isPresented: $showRestroom) { RestroomSheet() }
            .sheet(item: $shownAlert) { AlertDetailView(alertID: $0.id) }
        }
    }

    @ViewBuilder
    private func timelineRow(_ row: Row, snapshot s: TripSnapshot, pick: SmartStop.Pick?, pickTitle: String, first: Bool, last: Bool) -> some View {
        switch row {
        case let .exit(u):
            let isPick = pick?.candidate.exitID == u.exit.id
            TimelineRow(dot: Theme.signGreen, filled: isPick, first: first, last: last) {
                TimelineExitCard(upcoming: u, services: trip.services(for: u.exit), now: s.timestamp, pick: isPick ? pick : nil, pickTitle: pickTitle)
            }
        case let .rest(u):
            let isPick = pick?.candidate.exitID == nil && pick?.candidate.id == u.restArea.id
            TimelineRow(dot: Theme.signBlue, filled: isPick, first: first, last: last) {
                TimelineRestCard(upcoming: u, now: s.timestamp, pick: isPick ? pick : nil, pickTitle: pickTitle)
            }
        case let .state(f, distance, current):
            TimelineRow(dot: Theme.accent, filled: true, first: first, last: last) {
                TimelineStateCard(forecast: f, distance: distance, current: current, isFinal: current && s.next == nil, now: s.timestamp)
            }
        case let .gap(g):
            TimelineRow(dot: Theme.amber, first: first, last: last) { TimelineGapCard(gap: g, progress: s.progress) }
        case let .stop(st, distance):
            TimelineRow(dot: Color.primary, first: first, last: last) {
                TimelineStopCard(stop: st, distance: distance, eta: trip.plan?.eta(from: s.progress, to: st.distanceAlongRoute, pace: s.pace, now: s.timestamp), now: s.timestamp)
            }
        case let .alert(a):
            let tier = a.incident.tier
            TimelineRow(dot: tier.color, filled: true, halo: tier == .urgent, first: first, last: last) {
                TimelineAlertCard(alert: a, progress: s.progress, now: s.timestamp,
                                  eta: a.start > s.progress ? trip.plan?.eta(from: s.progress, to: a.start, pace: s.pace, now: s.timestamp) : nil) {
                    shownAlert = AlertRef(id: a.incident.id)
                }
            }
        }
    }

    /// Under a filter that hides some alerts: how many urgent ones stay, how many others are hidden.
    @ViewBuilder
    private func filterNote(_ alerts: [RoadIntel.Alert]) -> some View {
        if filter != .all, filter != .alerts {
            let kept = alerts.filter { $0.incident.tier == .urgent }.count
            let hidden = alerts.count - kept
            if kept + hidden > 0 {
                let parts = [kept > 0 ? "\(kept) urgent \(kept == 1 ? "alert stays" : "alerts stay") in view" : nil,
                             hidden > 0 ? "\(hidden) other \(hidden == 1 ? "alert" : "alerts") hidden by the \(filter.title) filter" : nil].compactMap { $0 }
                Button { withAnimation(.easeInOut(duration: 0.15)) { filter = .alerts } } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("⚠️")
                        (Text(parts.joined(separator: ". ") + ". ") + Text("Show alerts").underline().foregroundColor(Theme.accent))
                            .font(.caption.weight(.semibold))
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(kept > 0 ? Theme.dangerFill : Theme.amberFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("filterNote")
            }
        }
    }

    /// Nothing to show: never "all clear" under Alerts when a source failed or none answered.
    @ViewBuilder
    private func empty(alerts: [RoadIntel.Alert]) -> some View {
        let miles = Int(settings.exitLookaheadMiles)
        if filter == .alerts {
            let failing = trip.roadIntel.map { intel in intel.status.values.contains { $0.state == .unavailable } } ?? false
            let title = trip.roadIntel == nil ? "Road alerts are off" : failing ? "Some alert sources are unavailable" : "No reports from connected sources in the next \(miles) miles"
            let text = trip.roadIntel == nil ? "Turn road alerts on in Settings."
                : failing ? "This does not mean the road is clear. The sources that answered have nothing on your route here."
                : "Only the sources listed above are checked. Not hearing of an event does not mean there is none."
            ContentUnavailableView(title, systemImage: "exclamationmark.triangle", description: Text(text))
        } else {
            ContentUnavailableView("Nothing in the next \(miles) miles", systemImage: "road.lanes",
                                   description: Text(filter == .all ? "Try a longer window." : "Nothing matches \(filter.title) in this window. Try a longer one."))
        }
    }

    private var tools: some View {
        HStack(spacing: 8) {
            toolButton("Find", symbol: "magnifyingglass") { showSearch = true }
            toolButton("Fuel stop", symbol: "fuelpump.fill") { showFuel = true }
            toolButton("Restroom", symbol: "figure.dress.line.vertical.figure") { showRestroom = true }
        }
    }

    private func toolButton(_ title: String, symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol).font(.subheadline.weight(.semibold)).lineLimit(1)
                .frame(maxWidth: .infinity).padding(.vertical, 10)
                .background(Theme.card, in: Capsule())
                .overlay(Capsule().stroke(Theme.cardStroke, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    /// The best stop card for the filter: the fuel recommendation when a stop is needed, else the best stop
    /// ahead (SmartStop, Shell first by default); under Rest, the best restroom stop.
    private func bestStop() -> (result: SmartStop.Result, title: String, tag: String)? {
        let miles = max(60, settings.exitLookaheadMiles)
        switch filter {
        case .rest:
            guard let r = trip.bestStopAhead(miles: miles, restrooms: true), r.primary != nil else { return nil }
            return (r, "Best restroom stop ahead", "Best restroom stop")
        case .all, .fuel:
            if let fuel = trip.smartStop, fuel.primary != nil {
                return (fuel, fuel.lowRange ? "Fuel low: nearest stop" : "Recommended fuel stop", "Recommended fuel stop")
            }
            guard let r = trip.bestStopAhead(miles: miles), r.primary != nil else { return nil }
            return (r, "Best stop ahead", "Best stop ahead")
        default:
            return nil
        }
    }

    /// Rows in route order. At the same mile a state line or an alert comes first and a gas gap after the exit
    /// it starts at. Urgent alerts show under every filter.
    private func rows(for s: TripSnapshot, alerts: [RoadIntel.Alert], pick: SmartStop.Pick?) -> [Row] {
        let window = settings.exitLookaheadMiles * Geodesy.metersPerMile
        let shown = alerts.filter { filter == .all || filter == .alerts || $0.incident.tier == .urgent }
        var events: [(distance: Double, order: Int, row: Row)] = []
        if filter == .states {
            if let c = s.current { events.append((s.progress, 0, .state(c, distance: c.remainingMeters, current: true))) }
            for f in s.itinerary where f.status == .upcoming {
                events.append((f.segment.startDistance, 0, .state(f, distance: f.segment.startDistance - s.progress, current: false)))
            }
            for a in shown { events.append((max(a.start, s.progress) + 0.1, 1, .alert(a))) }
            return events.sorted { ($0.distance, $0.order) < ($1.distance, $1.order) }.map { $0.row }
        }
        let ev = settings.vehicle?.isElectric == true
        if filter == .all {
            for f in s.itinerary where f.status == .upcoming && f.segment.startDistance - s.progress <= window {
                events.append((f.segment.startDistance, 0, .state(f, distance: f.segment.startDistance - s.progress, current: false)))
            }
        }
        for u in s.upcomingExits where u.distance <= window {
            let services = trip.services(for: u.exit)
            func has(_ c: PlaceCategory) -> Bool { services.contains { $0.place.category == c } }
            let isPick = pick?.candidate.exitID == u.exit.id
            let show: Bool
            switch filter {
            case .all: show = true
            case .fuel: show = has(ev ? .evCharging : .gas) || has(.travelCenter) || isPick
            case .rest: show = has(.restArea) || isPick
            default: show = filter.service.map(has) ?? false
            }
            if show { events.append((u.exit.distanceAlongRoute, 1, .exit(u))) }
        }
        for u in s.upcomingRestAreas where u.distance <= window {
            let r = u.restArea
            let show: Bool
            switch filter {
            case .all, .rest: show = true
            case .fuel: show = ev ? !r.ev.isEmpty : !r.gas.isEmpty
            case .food: show = !r.food.isEmpty
            case .ev: show = !r.ev.isEmpty
            default: show = false
            }
            if show { events.append((r.distanceAlongRoute, 1, .rest(u))) }
        }
        if filter == .all, let stops = trip.plan?.route.stops {
            for stop in stops {
                let d = stop.distanceAlongRoute - s.progress
                if d > 0, d <= window { events.append((stop.distanceAlongRoute, 1, .stop(stop, distance: d))) }
            }
        }
        if filter == .all || filter == .fuel {
            for gap in trip.gasGapsAhead(window: window) { events.append((gap.from, 2, .gap(gap))) }
        }
        for a in shown { events.append((max(a.start, s.progress), 0, .alert(a))) }
        return events.sorted { ($0.distance, $0.order) < ($1.distance, $1.order) }.map { $0.row }
    }
}

/// Required credit for OpenStreetMap derived exit and place data (ODbL).
struct DataAttribution: View {
    var body: some View {
        Text("Exit, place and rest area data © OpenStreetMap contributors, via OpenInterstate, available under the Open Database License (ODbL). Rest area truck parking: FHWA. Boundaries: U.S. Census Bureau TIGER/Line 2026.")
            .font(.caption2).foregroundStyle(Theme.secondaryText)
    }
}
