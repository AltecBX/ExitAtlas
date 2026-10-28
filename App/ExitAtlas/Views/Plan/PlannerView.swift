import ExitAtlasCore
import MapKit
import SwiftUI

/// Plan a trip: origin, stops, destination, then compare route options by state.
struct PlannerView: View {
    @Environment(AppModel.self) private var app
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Environment(TripLibrary.self) private var library

    @State private var origin: Waypoint?
    @State private var stops: [Waypoint] = []
    @State private var destination: Waypoint?
    @State private var picking: PickTarget?
    @State private var options: [TripPlan] = []
    @State private var isRouting = false
    @State private var error: String?

    enum PickTarget: Identifiable {
        case origin, destination, stop
        var id: String { "\(self)" }
    }

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            List {
                Section("Trip") {
                    PlaceButton(title: "From", value: origin?.name ?? "Current location", symbol: "location.circle") { picking = .origin }
                    ForEach(stops, id: \.self) { stop in
                        Label(stop.name, systemImage: "mappin.circle").lineLimit(1)
                    }
                    .onDelete { stops.remove(atOffsets: $0) }
                    .onMove { stops.move(fromOffsets: $0, toOffset: $1) }
                    Button { picking = .stop } label: { Label("Add stop", systemImage: "plus.circle") }
                        .disabled(destination == nil)
                    PlaceButton(title: "To", value: destination?.name ?? "Choose destination", symbol: "flag.checkered.circle") { picking = .destination }
                }
                Section {
                    Toggle("Avoid tolls", isOn: $settings.avoidTolls)
                    Button {
                        Task { await findRoutes() }
                    } label: {
                        HStack {
                            Label("Find routes", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                            if isRouting { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(destination == nil || isRouting || app.data == nil)
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.shieldRed) }
                }
                if !options.isEmpty {
                    Section(options.count == 1 ? "Route" : "\(options.count) routes") {
                        ForEach(Array(options.enumerated()), id: \.offset) { index, plan in
                            RouteOptionRow(plan: plan, index: index,
                                           onStart: { start(plan, simulate: false) },
                                           onSimulate: { start(plan, simulate: true) })
                        }
                    }
                }
                Section {
                    Button {
                        app.startDemo()
                    } label: {
                        Label("Simulated demo: Miami to Manhattan", systemImage: "play.circle")
                    }
                    .disabled(app.data == nil)
                } footer: {
                    Text("Plays simulated GPS along a bundled sample route. No location access or network needed.")
                }
                if !library.saved.isEmpty {
                    Section("Saved trips") {
                        ForEach(library.saved) { saved in
                            Button {
                                origin = saved.origin
                                stops = saved.stops
                                destination = saved.destination
                                options = []
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(saved.name).font(.subheadline.weight(.semibold))
                                    Text(([saved.origin?.name ?? "Current location"] + saved.stops.map(\.name) + [saved.destination.name])
                                        .joined(separator: " → ")).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(2)
                                }
                            }
                            .swipeActions { Button("Delete", role: .destructive) { library.delete(saved) } }
                        }
                    }
                }
            }
            .navigationTitle("Plan a Trip")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { EditButton() }
                ToolbarItem(placement: .topBarTrailing) { SettingsButton() }
                ToolbarItem(placement: .topBarLeading) {
                    Button("Save") {
                        if let destination {
                            library.save(SavedTrip(name: destination.name, origin: origin, stops: stops, destination: destination))
                        }
                    }
                    .disabled(destination == nil)
                }
            }
            .sheet(item: $picking) { target in
                PlaceSearchSheet { waypoint in
                    switch target {
                    case .origin: origin = waypoint
                    case .destination: destination = waypoint
                    case .stop: stops.append(waypoint)
                    }
                    options = []
                }
            }
        }
    }

    private func findRoutes() async {
        guard let destination else { return }
        isRouting = true
        error = nil
        defer { isRouting = false }
        do {
            let start: Waypoint
            if let origin {
                start = origin
            } else {
                start = Waypoint(name: "Current location", coordinate: try await CurrentLocation.fetch())
            }
            let routes = try await MapKitRouteService().routes(
                from: start, via: stops, to: destination,
                options: .init(avoidTolls: settings.avoidTolls, avoidHighways: false))
            options = await app.plans(for: routes)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func start(_ plan: TripPlan, simulate: Bool) {
        trip.startTrip(route: plan.route, simulate: simulate)
    }
}

private struct PlaceButton: View {
    let title: String
    let value: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: symbol).foregroundStyle(.primary)
                Spacer()
                Text(value).foregroundStyle(Theme.secondaryText).lineLimit(1)
            }
        }
    }
}

/// One route alternative with the state by state breakdown that sets ExitAtlas apart.
private struct RouteOptionRow: View {
    let plan: TripPlan
    let index: Int
    let onStart: () -> Void
    let onSimulate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(Format.duration(plan.route.timeProfile.totalSeconds)).font(Theme.number(24))
                Text(Format.miles(plan.route.length)).font(.subheadline).foregroundStyle(Theme.secondaryText)
                Spacer()
                if plan.route.hasTolls == true {
                    Label("Tolls", systemImage: "dollarsign.circle").font(.caption.weight(.semibold)).foregroundStyle(Theme.amber)
                }
            }
            if let title = plan.route.title, !title.isEmpty {
                Text("Via \(title)").font(.caption).foregroundStyle(Theme.secondaryText)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(plan.states.segments) { seg in
                        VStack(spacing: 2) {
                            StateBadge(code: seg.code)
                            Text(Format.milesValue(seg.length)).font(.caption2.monospacedDigit()).foregroundStyle(Theme.secondaryText)
                        }
                    }
                }
            }
            Text("\(plan.states.totals.count) states · \(plan.states.crossings.count) state lines · \(plan.exits.count) exits on route")
                .font(.caption).foregroundStyle(Theme.secondaryText)
            HStack {
                Button(action: onStart) { Label("Start", systemImage: "play.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(Theme.signGreen)
                Button(action: onSimulate) { Label("Simulate", systemImage: "play.circle").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 6)
    }
}

/// Destination and stop search (Apple MapKit autocomplete), with Home and recent places first.
struct PlaceSearchSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(TripLibrary.self) private var library
    @Environment(UserSettings.self) private var settings
    @State private var search = PlaceSearch()
    @State private var resolving = false
    let onPick: (Waypoint) -> Void

    private func pick(_ w: Waypoint) {
        library.recordPlace(w)
        onPick(w)
        dismiss()
    }

    var body: some View {
        @Bindable var search = search
        NavigationStack {
            List {
                if search.query.isEmpty {
                    if let home = library.home {
                        Section("Home") {
                            Button { pick(home) } label: { Label(home.name, systemImage: "house.fill") }
                                .swipeActions { Button("Clear", role: .destructive) { library.setHome(nil) } }
                        }
                    }
                    if !settings.savedPlaces.isEmpty {
                        Section("Saved") {
                            ForEach(settings.savedPlaces, id: \.self) { place in
                                Button { pick(place) } label: { Label(place.name, systemImage: "star.fill").lineLimit(1) }
                            }
                        }
                    }
                    if !library.recentPlaces.isEmpty {
                        Section {
                            ForEach(library.recentPlaces, id: \.self) { place in
                                Button { pick(place) } label: { Label(place.name, systemImage: "clock.arrow.circlepath").lineLimit(1) }
                                    .swipeActions {
                                        Button { library.setHome(place) } label: { Label("Set as Home", systemImage: "house") }.tint(Theme.signGreen)
                                        Button { settings.savePlace(place) } label: { Label("Save", systemImage: "star") }.tint(Theme.signBlue)
                                    }
                            }
                        } header: {
                            Text("Recent")
                        } footer: {
                            Text("Swipe a place to set it as Home or save it.")
                        }
                    }
                }
                ForEach(search.suggestions, id: \.self) { s in
                    Button {
                        Task {
                            resolving = true
                            if let w = try? await search.resolve(s) { pick(w) }
                            resolving = false
                        }
                    } label: {
                        VStack(alignment: .leading) {
                            Text(s.title).foregroundStyle(.primary)
                            if !s.subtitle.isEmpty { Text(s.subtitle).font(.caption).foregroundStyle(Theme.secondaryText) }
                        }
                    }
                }
                if let error = search.error { Text(error).font(.footnote).foregroundStyle(Theme.secondaryText) }
            }
            .overlay { if resolving { ProgressView() } }
            .searchable(text: $search.query, placement: .navigationBarDrawer(displayMode: .always), prompt: "City, address or place")
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

/// One accurate fix for "current location" as the trip origin.
enum CurrentLocation {
    struct Unavailable: LocalizedError {
        var errorDescription: String? { "Current location is unavailable. Allow location access or choose a starting point." }
    }

    /// Kept alive so the permission prompt can show before the first fix is requested.
    @MainActor private static let manager = CLLocationManager()

    static func fetch(timeout: TimeInterval = 15) async throws -> GeoCoordinate {
        await MainActor.run {
            if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        }
        return try await withThrowingTaskGroup(of: GeoCoordinate.self) { group in
            group.addTask {
                for try await update in CLLocationUpdate.liveUpdates() {
                    if let loc = update.location, loc.horizontalAccuracy >= 0, loc.horizontalAccuracy < 200 {
                        return GeoCoordinate(loc.coordinate)
                    }
                }
                throw Unavailable()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                throw Unavailable()
            }
            let first = try await group.next()!
            group.cancelAll()
            return first
        }
    }
}
