import ExitAtlasCore
import SwiftUI

/// Minimal dashboard for active driving: state line, next exit, destination.
struct DriveView: View {
    @Environment(TripController.self) private var trip
    @Binding var selectedTab: RootView.Tab

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let snapshot = trip.snapshot {
                        DriveDashboard(snapshot: snapshot)
                    } else if trip.mode == .discovery {
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
            .background(Theme.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    TrackingStatusPill(match: trip.snapshot?.match, simulated: trip.isSimulating, rerouting: trip.isRerouting)
                }
                if trip.mode != .idle {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("End", role: .destructive) { trip.endTrip() }
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private struct DriveDashboard: View {
    @Environment(TripController.self) private var trip
    let snapshot: TripSnapshot

    var body: some View {
        VStack(spacing: 14) {
            HeaderRow(snapshot: snapshot, discovery: trip.mode == .discovery)
            if let current = snapshot.current {
                BorderCard(snapshot: snapshot, current: current)
            }
            if let next = snapshot.nextExit {
                NextExitCard(upcoming: next, services: trip.services(for: next.exit), now: snapshot.timestamp)
            }
            DestinationRow(snapshot: snapshot, discovery: trip.mode == .discovery)
        }
    }
}

private struct HeaderRow: View {
    let snapshot: TripSnapshot
    let discovery: Bool

    var body: some View {
        HStack(spacing: 12) {
            HighwayShield(ref: snapshot.highway?.ref, size: 50)
            VStack(alignment: .leading, spacing: 2) {
                Text(snapshot.highway.map { "\($0.ref.description) \($0.direction.word)" } ?? "Local roads")
                    .font(.system(.title3, design: .rounded).weight(.bold))
                Text(discovery ? "Discovery mode · no destination" : "Driving in \(snapshot.current?.segment.displayName ?? "—")")
                    .font(.subheadline).foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            StateBadge(code: snapshot.current?.segment.code, highlighted: true)
        }
        .padding(.top, 8)
    }
}

/// The signature card: how far to the next state, how many exits until then, and progress.
private struct BorderCard: View {
    let snapshot: TripSnapshot
    let current: SegmentForecast

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let next = snapshot.next {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 2) {
                        Eyebrow(text: "Next state")
                        Text(next.segment.displayName)
                            .font(.system(size: 34, weight: .heavy, design: .rounded))
                            .minimumScaleFactor(0.6).lineLimit(1)
                    }
                    Spacer()
                    if next.segment.isBrief {
                        Text("Brief crossing").font(.caption.weight(.semibold)).foregroundStyle(Theme.amber)
                    }
                }
                HStack(alignment: .top, spacing: 12) {
                    MetricTile(title: "To state line", value: Format.milesValue(current.remainingMeters), unit: "mi", valueSize: 40)
                    MetricTile(title: "Exits left", value: "\(current.exitsRemaining)",
                               caption: "in \(current.segment.code ?? "this state")", valueSize: 40)
                    MetricTile(title: "Crossing", value: current.exitTime.map { Format.time($0, timeZoneID: current.exitTimeZoneID, relativeTo: snapshot.timestamp) } ?? "—",
                               caption: current.exitTime.map { "in " + Format.duration($0.timeIntervalSince(snapshot.timestamp)) },
                               valueSize: 20)
                }
                if current.remainingMeters < 5 * Geodesy.metersPerMile {
                    Label("Entering \(next.segment.displayName) in \(Format.miles(current.remainingMeters))", systemImage: "flag.checkered")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.amber)
                }
                Text("You will drive \(Format.miles(next.totalMeters)) in \(next.segment.displayName)"
                    + (next.plannedDuration.map { ", about " + Format.duration($0) } ?? "") + ".")
                    .font(.subheadline).foregroundStyle(Theme.secondaryText)
            } else {
                Eyebrow(text: "Final state")
                Text(current.segment.displayName).font(.system(size: 30, weight: .heavy, design: .rounded))
                MetricTile(title: "Left in \(current.segment.code ?? "state")", value: Format.milesValue(current.remainingMeters), unit: "mi")
            }
            VStack(alignment: .leading, spacing: 6) {
                StateProgressBar(fraction: current.fractionComplete)
                HStack {
                    Text("\(Format.miles(current.drivenMeters)) of \(Format.miles(current.totalMeters)) in \(current.segment.displayName)")
                    Spacer()
                    Text("\(current.exitCount) exits total")
                }
                .font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .card(padding: 18)
    }
}

private struct NextExitCard: View {
    let upcoming: UpcomingExit
    let services: [ExitService]
    let now: Date

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            ExitSign(label: upcoming.exit.label)
            VStack(alignment: .leading, spacing: 4) {
                Eyebrow(text: "Next exit")
                Text(upcoming.exit.name.isEmpty ? upcoming.exit.displayTitle : upcoming.exit.name)
                    .font(.headline).lineLimit(2)
                ServiceSummary(services: services)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.milesValue(upcoming.distance)).font(Theme.number(30))
                Text("mi · " + Format.duration(upcoming.eta.timeIntervalSince(now))).font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .card()
    }
}

private struct DestinationRow: View {
    let snapshot: TripSnapshot
    let discovery: Bool

    var body: some View {
        HStack(spacing: 12) {
            if discovery {
                MetricTile(title: "Corridor ahead", value: Format.milesValue(snapshot.remaining), unit: "mi", valueSize: 24)
                MetricTile(title: "State lines", value: "\(snapshot.borderCrossingsRemaining)", caption: "within lookahead", valueSize: 24)
            } else {
                MetricTile(title: "To destination", value: Format.milesValue(snapshot.remaining), unit: "mi", valueSize: 24)
                MetricTile(title: "Arrival", value: Format.time(snapshot.eta, relativeTo: snapshot.timestamp),
                           caption: Format.duration(snapshot.timeRemaining), valueSize: 20)
                MetricTile(title: "States left", value: "\(snapshot.statesAhead.count)",
                           caption: snapshot.statesAhead.prefix(4).joined(separator: " · "), valueSize: 24)
            }
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
