import ExitAtlasCore
import SwiftUI

/// Upcoming exits in route order with services, state lines, rest areas and stretches without gas
/// inline, and a lookahead window.
struct ExitsView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @State private var category: PlaceCategory?
    @State private var showSearch = false
    @State private var showFuel = false

    static let windows: [Double] = [5, 10, 25, 50, 100]

    enum Row: Identifiable {
        case exit(UpcomingExit)
        case border(SegmentForecast, distance: Double)
        case rest(UpcomingRestArea)
        case gap(GasGaps.Gap)

        var id: String {
            switch self {
            case let .exit(e): return e.id
            case let .border(f, _): return "border-\(f.segment.index)"
            case let .rest(r): return r.id
            case let .gap(g): return "gap-\(g.from)"
            }
        }
    }

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Group {
                if let snapshot = trip.snapshot {
                    List {
                        Section {
                            Picker("Show the next", selection: $settings.exitLookaheadMiles) {
                                ForEach(Self.windows, id: \.self) { Text("\(Int($0)) mi").tag($0) }
                            }
                            .pickerStyle(.segmented)
                            CategoryFilter(selection: $category)
                        }
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))

                        let items = rows(for: snapshot)
                        if items.isEmpty {
                            ContentUnavailableView("Nothing in the next \(Int(settings.exitLookaheadMiles)) miles",
                                                   systemImage: "road.lanes",
                                                   description: Text(category == nil ? "Try a longer window." : "No exits or rest areas with \(category!.displayName) in this window."))
                        }
                        ForEach(items) { row in
                            switch row {
                            case let .exit(upcoming):
                                NavigationLink(value: upcoming.exit) {
                                    ExitRow(upcoming: upcoming, services: trip.services(for: upcoming.exit), now: snapshot.timestamp)
                                }
                                .accessibilityIdentifier("exitRow")
                            case let .border(forecast, distance):
                                BorderRow(forecast: forecast, distance: distance, now: snapshot.timestamp)
                            case let .rest(upcoming):
                                NavigationLink(value: upcoming.restArea) {
                                    RestAreaRow(upcoming: upcoming, now: snapshot.timestamp)
                                }
                                .accessibilityIdentifier("restAreaRow")
                            case let .gap(gap):
                                GasGapRow(gap: gap, progress: snapshot.progress)
                            }
                        }
                        Section {
                            DataAttribution()
                        }
                        .listRowBackground(Color.clear)
                    }
                    .listStyle(.insetGrouped)
                    .simulationBanner(trip.isSimulating)
                } else {
                    ContentUnavailableView("No active trip", systemImage: "road.lanes",
                                           description: Text("Plan a trip or start discovery mode to see the exits ahead."))
                }
            }
            .navigationTitle("Exits Ahead")
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
            }
            .sheet(isPresented: $showSearch) { AlongRouteSearchView() }
            .sheet(isPresented: $showFuel) { FuelView() }
        }
    }

    /// Rows in route order. At the same mile a state line comes first and a gas gap after the exit it starts at.
    private func rows(for snapshot: TripSnapshot) -> [Row] {
        let window = settings.exitLookaheadMiles * Geodesy.metersPerMile
        var events: [(distance: Double, order: Int, row: Row)] = []
        for f in snapshot.itinerary where f.status == .upcoming && f.segment.startDistance - snapshot.progress <= window {
            events.append((f.segment.startDistance, 0, .border(f, distance: f.segment.startDistance - snapshot.progress)))
        }
        for upcoming in snapshot.upcomingExits where upcoming.distance <= window {
            if let category, !trip.services(for: upcoming.exit).contains(where: { $0.place.category == category }) { continue }
            events.append((upcoming.exit.distanceAlongRoute, 1, .exit(upcoming)))
        }
        for upcoming in snapshot.upcomingRestAreas where upcoming.distance <= window && shows(upcoming.restArea) {
            events.append((upcoming.restArea.distanceAlongRoute, 1, .rest(upcoming)))
        }
        if category == nil || category == .gas {
            for gap in trip.gasGapsAhead(window: window) { events.append((gap.from, 2, .gap(gap))) }
        }
        return events.sorted { ($0.distance, $0.order) < ($1.distance, $1.order) }.map { $0.row }
    }

    /// Rest areas show with no filter or the Rest Area filter; plazas also under the gas, food and EV filters they sell.
    private func shows(_ r: RouteRestArea) -> Bool {
        switch category {
        case nil, .restArea?: return true
        case .gas?: return !r.gas.isEmpty
        case .food?: return !r.food.isEmpty
        case .evCharging?: return !r.ev.isEmpty
        default: return false
        }
    }
}

struct CategoryFilter: View {
    @Binding var selection: PlaceCategory?
    let options: [PlaceCategory] = [.gas, .food, .lodging, .restArea, .evCharging, .dogPark]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip(title: "All", symbol: "square.grid.2x2", selected: selection == nil) { selection = nil }
                ForEach(options, id: \.self) { c in
                    chip(title: c.displayName, symbol: c.symbolName, selected: selection == c) {
                        selection = selection == c ? nil : c
                    }
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private func chip(title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12).padding(.vertical, 8)
                .foregroundStyle(selected ? .white : .primary)
                .background(selected ? AnyShapeStyle(Theme.signGreen) : AnyShapeStyle(Theme.card), in: Capsule())
                .overlay(Capsule().stroke(Theme.cardStroke, lineWidth: selected ? 0 : 1))
        }
        .buttonStyle(.plain)
    }
}

struct ExitRow: View {
    let upcoming: UpcomingExit
    let services: [ExitService]
    let now: Date

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                ExitSign(label: upcoming.exit.label, compact: true)
                VStack(alignment: .leading, spacing: 3) {
                    if !upcoming.exit.name.isEmpty {
                        Text(upcoming.exit.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                    } else if services.isEmpty {
                        Text("No services listed").font(.subheadline).foregroundStyle(Theme.secondaryText)
                    }
                    if upcoming.exit.confidence == .medium {
                        Text("Direction not verified in source data").font(.caption).foregroundStyle(Theme.amber)
                    }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Format.miles(upcoming.distance)).font(.subheadline.monospacedDigit().weight(.bold))
                    Text(Format.duration(upcoming.eta.timeIntervalSince(now))).font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            if !services.isEmpty { ServicePlaques(services: services, compact: true) }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

struct BorderRow: View {
    let forecast: SegmentForecast
    let distance: Double
    let now: Date

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "flag.checkered").foregroundStyle(Theme.amber)
            VStack(alignment: .leading, spacing: 2) {
                Text("Entering \(forecast.segment.displayName)").font(.subheadline.weight(.bold))
                Text("\(Format.miles(forecast.totalMeters)) on route · \(forecast.exitCount) exits"
                    + (forecast.segment.isBrief ? " · brief crossing" : ""))
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.miles(distance)).font(.subheadline.monospacedDigit().weight(.bold))
                if let t = forecast.entryTime {
                    Text(Format.time(t, timeZoneID: forecast.entryTimeZoneID, relativeTo: now))
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
        }
        .listRowBackground(Theme.amber.opacity(0.12))
    }
}

/// Required credit for OpenStreetMap derived exit and place data (ODbL).
struct DataAttribution: View {
    var body: some View {
        Text("Exit, place and rest area data © OpenStreetMap contributors, via OpenInterstate, available under the Open Database License (ODbL). Rest area truck parking: FHWA. Boundaries: U.S. Census Bureau TIGER/Line 2026.")
            .font(.caption2).foregroundStyle(Theme.secondaryText)
    }
}

struct RestAreaRow: View {
    let upcoming: UpcomingRestArea
    let now: Date

    var body: some View {
        let r = upcoming.restArea
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                RestAreaSign(kind: r.kind, compact: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(r.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                    Text([r.side == .both ? "Serves both directions" : nil, r.road].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Format.miles(upcoming.distance)).font(.subheadline.monospacedDigit().weight(.bold))
                    Text(Format.duration(upcoming.eta.timeIntervalSince(now))).font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            AmenityChips(restArea: r, maxCount: 4)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A stretch without gas longer than the driver's setting.
struct GasGapRow: View {
    let gap: GasGaps.Gap
    let progress: Double

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "fuelpump.slash.fill").foregroundStyle(Theme.amber).frame(width: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text("No gas for \(Format.miles(gap.length))\(gap.open ? "+" : "")").font(.subheadline.weight(.bold))
                Text((gap.before.map { "After \($0.title)" } ?? "From here")
                     + (gap.after.map { ", next gas at \($0.title)" } ?? (gap.open ? ", and none listed beyond" : ", and none before your destination")))
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            Text(Format.miles(max(0, gap.from - progress))).font(.subheadline.monospacedDigit().weight(.bold))
        }
        .listRowBackground(Theme.amber.opacity(0.12))
        .accessibilityElement(children: .combine)
    }
}
