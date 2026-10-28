import ExitAtlasCore
import MapKit
import SwiftUI

/// Whole trip: map colored by state and the state by state itinerary.
struct TripOverviewView: View {
    @Environment(TripController.self) private var trip
    @State private var showStopPlanner = false
    @State private var showPlates = false
    @State private var showCard = false

    var body: some View {
        NavigationStack {
            if let plan = trip.plan, let snapshot = trip.snapshot {
                List {
                    Section {
                        RouteMap(plan: plan, lines: trip.stateLines(for: plan), snapshot: snapshot)
                            .frame(height: 300)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                        TripSummary(snapshot: snapshot, discovery: trip.mode == .discovery)
                    }
                    ItinerarySections(snapshot: snapshot)
                    DiscoverSection(plan: plan, snapshot: snapshot)
                    Section {
                        if trip.mode == .trip {
                            Button { showStopPlanner = true } label: { Label("Plan a stop ahead", systemImage: "bed.double") }
                        }
                        Button { showPlates = true } label: { Label("License plate game", systemImage: "car.rear") }
                        ShareLink(item: itineraryText(snapshot)) { Label("Share itinerary", systemImage: "square.and.arrow.up") }
                        Button { showCard = true } label: { Label("Share trip card", systemImage: "photo") }
                            .disabled(drivenByState(snapshot).reduce(0) { $0 + $1.meters } < 0.1 * Geodesy.metersPerMile)
                        Button(role: .destructive) { trip.endTrip() } label: { Label("End trip", systemImage: "stop.circle") }
                    }
                    Section { DataAttribution() }.listRowBackground(Color.clear)
                }
                .simulationBanner(trip.isSimulating)
                .navigationTitle(trip.mode == .discovery ? (plan.route.title ?? "Discovery") : "Trip")
                .navigationDestination(for: RouteExit.self) { ExitDetailView(exit: $0) }
                .navigationDestination(for: RouteDiscovery.self) { DiscoverDetailView(place: $0) }
                .sheet(isPresented: $showStopPlanner) { StopPlannerView() }
                .sheet(isPresented: $showPlates) { LicensePlatesView() }
                .sheet(isPresented: $showCard) {
                    ShareCardSheet(title: "Trip card", card: TripCardView(
                        title: trip.mode == .discovery ? (plan.route.title ?? "Discovery drive") : "\(plan.route.origin.name) to \(plan.route.destination.name)",
                        date: Date(), totalMeters: drivenByState(snapshot).reduce(0) { $0 + $1.meters }, states: drivenByState(snapshot),
                        simulated: trip.isSimulating))
                }
            } else {
                ContentUnavailableView("No trip yet", systemImage: "map", description: Text("Plan a trip to see your route by state."))
            }
        }
    }

    /// Miles driven in each state so far, in order of first entry (same as the web trip card). The card's
    /// total is their sum, so it matches the states shown (the demo starts partway, which is not driving).
    private func drivenByState(_ s: TripSnapshot) -> [(code: String, meters: Double)] {
        var out: [(code: String, meters: Double)] = []
        for st in s.drivenStints where st.meters > 0 {
            let code = st.regionCode ?? String(st.regionName.prefix(2)).uppercased()
            if let i = out.firstIndex(where: { $0.code == code }) { out[i].meters += st.meters } else { out.append((code, st.meters)) }
        }
        return out
    }

    private func itineraryText(_ s: TripSnapshot) -> String {
        var lines = ["ExitAtlas trip: \(trip.plan?.route.origin.name ?? "") to \(trip.plan?.route.destination.name ?? "")",
                     "\(Format.miles(s.remaining)) to go, arriving \(Format.time(s.eta, relativeTo: s.timestamp))"]
        for f in s.itinerary where f.status != .completed {
            var line = "\(f.segment.displayName): \(Format.miles(f.status == .current ? f.remainingMeters : f.totalMeters))"
            if let t = f.status == .current ? f.exitTime : f.entryTime {
                line += f.status == .current ? ", leaving \(Format.time(t, timeZoneID: f.exitTimeZoneID, relativeTo: s.timestamp))"
                    : ", entering \(Format.time(t, timeZoneID: f.entryTimeZoneID, relativeTo: s.timestamp))"
            }
            lines.append(line)
        }
        return lines.joined(separator: "\n")
    }
}

private struct TripSummary: View {
    let snapshot: TripSnapshot
    let discovery: Bool

    var body: some View {
        HStack(spacing: 10) {
            MetricTile(title: "Driven", value: Format.milesValue(snapshot.drivenTotal), unit: "mi", valueSize: 22)
            MetricTile(title: discovery ? "Ahead" : "Remaining", value: Format.milesValue(snapshot.remaining), unit: "mi", valueSize: 22)
            if !discovery {
                MetricTile(title: "Arrive", value: Format.time(snapshot.eta, relativeTo: snapshot.timestamp), valueSize: 16)
            }
        }
        .padding(.vertical, 4)
    }
}

private struct ItinerarySections: View {
    let snapshot: TripSnapshot

    var body: some View {
        let completedStints = snapshot.drivenStints.dropLast()
        if !completedStints.isEmpty {
            Section("Completed") {
                ForEach(Array(completedStints.enumerated()), id: \.offset) { _, stint in
                    HStack {
                        StateBadge(code: stint.regionCode)
                        Text(stint.regionName)
                        Spacer()
                        Text(Format.miles(stint.meters)).monospacedDigit().foregroundStyle(Theme.secondaryText)
                    }
                }
            }
        }
        if let current = snapshot.current {
            Section("Now") {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        StateBadge(code: current.segment.code, highlighted: true)
                        Text(current.segment.displayName).font(.headline)
                        Spacer()
                        Text("\(Format.miles(current.remainingMeters)) left").monospacedDigit().font(.subheadline.weight(.semibold))
                    }
                    StateProgressBar(fraction: current.fractionComplete, height: 10)
                    HStack {
                        Text("\(Format.miles(current.drivenMeters)) of \(Format.miles(current.totalMeters))")
                        Spacer()
                        Text("\(current.exitsRemaining) of \(current.exitCount) exits left")
                    }
                    .font(.caption).foregroundStyle(Theme.secondaryText)
                    if let exit = current.exitTime, snapshot.next != nil {
                        Text("Leave \(current.segment.code ?? "state") at \(Format.time(exit, timeZoneID: current.exitTimeZoneID, relativeTo: snapshot.timestamp))")
                            .font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                .padding(.vertical, 4)
            }
        }
        let upcoming = snapshot.itinerary.filter { $0.status == .upcoming }
        if !upcoming.isEmpty {
            Section("Ahead") {
                ForEach(upcoming) { f in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            StateBadge(code: f.segment.code)
                            Text(f.segment.displayName + (f.segment.visit > 1 ? " (again)" : "")).font(.subheadline.weight(.semibold))
                            Spacer()
                            Text(Format.miles(f.totalMeters)).monospacedDigit().font(.subheadline.weight(.bold))
                        }
                        HStack {
                            if let enter = f.entryTime {
                                Text("Enter \(Format.time(enter, timeZoneID: f.entryTimeZoneID, relativeTo: snapshot.timestamp))")
                            }
                            if let d = f.plannedDuration { Text("· \(Format.duration(d))") }
                            Spacer()
                            Text("\(f.exitCount) exits")
                        }
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                        if f.segment.isBrief {
                            Text("Brief crossing").font(.caption2.weight(.semibold)).foregroundStyle(Theme.amber)
                        }
                    }
                }
            }
        }
    }
}

/// Route drawn by state segment, with state line markers.
struct RouteMap: View {
    let plan: TripPlan
    let lines: [StateLine]
    let snapshot: TripSnapshot
    @State private var position: MapCameraPosition = .automatic

    var body: some View {
        Map(position: $position) {
            ForEach(lines) { line in
                MapPolyline(coordinates: line.coordinates)
                    .stroke(Theme.segmentColors[line.id % Theme.segmentColors.count],
                            style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            ForEach(plan.states.segments.dropFirst()) { seg in
                Annotation("", coordinate: seg.entryCoordinate.clCoordinate) {
                    StateBadge(code: seg.code, compact: true)
                }
            }
            Annotation("You", coordinate: plan.route.polyline.coordinate(at: snapshot.progress).clCoordinate) {
                Circle().fill(Theme.shieldBlue).frame(width: 16, height: 16)
                    .overlay(Circle().stroke(.white, lineWidth: 3))
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .mapControls { MapCompass() }
    }
}
