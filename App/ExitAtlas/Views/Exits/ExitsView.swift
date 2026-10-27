import ExitAtlasCore
import SwiftUI

/// Upcoming exits in route order with services, state lines inline, and a lookahead window.
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

        var id: String {
            switch self {
            case let .exit(e): return e.id
            case let .border(f, _): return "border-\(f.segment.index)"
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
                            ContentUnavailableView("No exits in the next \(Int(settings.exitLookaheadMiles)) miles",
                                                   systemImage: "road.lanes",
                                                   description: Text(category == nil ? "Try a longer window." : "No exits with \(category!.displayName) in this window."))
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
                            }
                        }
                        Section {
                            DataAttribution()
                        }
                        .listRowBackground(Color.clear)
                    }
                    .listStyle(.insetGrouped)
                } else {
                    ContentUnavailableView("No active trip", systemImage: "road.lanes",
                                           description: Text("Plan a trip or start discovery mode to see the exits ahead."))
                }
            }
            .navigationTitle("Exits Ahead")
            .navigationDestination(for: RouteExit.self) { ExitDetailView(exit: $0) }
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

    private func rows(for snapshot: TripSnapshot) -> [Row] {
        let window = settings.exitLookaheadMiles * Geodesy.metersPerMile
        var rows: [Row] = []
        let borders = snapshot.itinerary.filter {
            $0.status == .upcoming && $0.segment.startDistance - snapshot.progress <= window
        }
        var borderIndex = 0
        for upcoming in snapshot.upcomingExits where upcoming.distance <= window {
            while borderIndex < borders.count,
                  borders[borderIndex].segment.startDistance <= upcoming.exit.distanceAlongRoute {
                rows.append(.border(borders[borderIndex], distance: borders[borderIndex].segment.startDistance - snapshot.progress))
                borderIndex += 1
            }
            if let category, !trip.services(for: upcoming.exit).contains(where: { $0.place.category == category }) {
                continue
            }
            rows.append(.exit(upcoming))
        }
        while borderIndex < borders.count {
            rows.append(.border(borders[borderIndex], distance: borders[borderIndex].segment.startDistance - snapshot.progress))
            borderIndex += 1
        }
        return rows
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
        HStack(spacing: 12) {
            ExitSign(label: upcoming.exit.label, compact: true)
            VStack(alignment: .leading, spacing: 3) {
                Text(upcoming.exit.name.isEmpty ? upcoming.exit.displayTitle : upcoming.exit.name)
                    .font(.subheadline.weight(.semibold)).lineLimit(2)
                ServiceSummary(services: services)
                if upcoming.exit.confidence == .medium {
                    Text("Direction not verified in source data").font(.caption2).foregroundStyle(Theme.amber)
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.miles(upcoming.distance)).font(.subheadline.monospacedDigit().weight(.bold))
                Text(Format.duration(upcoming.eta.timeIntervalSince(now))).font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .padding(.vertical, 2)
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
        Text("Exit and place data © OpenStreetMap contributors, via OpenInterstate, available under the Open Database License (ODbL). Boundaries: U.S. Census Bureau TIGER/Line 2026.")
            .font(.caption2).foregroundStyle(Theme.secondaryText)
    }
}
