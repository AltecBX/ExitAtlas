import ExitAtlasCore
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(TripController.self) private var trip
    @Environment(\.scenePhase) private var scenePhase

    /// Three areas; settings and the profile open from the person button (SettingsButton) on each.
    enum Tab: Hashable {
        case drive, ahead, trip
    }

    @State private var tab: Tab = .drive

    var body: some View {
        switch app.loadState {
        case .loading:
            ProgressView("Loading offline highway data")
        case let .failed(message):
            ContentUnavailableView("Data failed to load", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            @Bindable var app = app
            TabView(selection: $tab) {
                DriveView(selectedTab: $tab)
                    .tabItem { Label("Drive", systemImage: "gauge.with.dots.needle.67percent") }
                    .tag(Tab.drive)
                ExitsView()
                    .tabItem { Label("Ahead", systemImage: "road.lanes") }
                    .tag(Tab.ahead)
                Group {
                    if trip.mode == .idle { PlannerView() } else { TripOverviewView() }
                }
                .tabItem { Label("Trip", systemImage: "map") }
                .tag(Tab.trip)
            }
            .sheet(isPresented: $app.showSettings) { SettingsView() }
            .tint(Theme.tint)
            .preferredColorScheme(app.forceDark ? .dark : app.settings.theme == "dark" ? .dark : app.settings.theme == "light" ? .light : nil)
            .onChange(of: trip.mode) { _, mode in
                if mode != .idle { tab = .drive } else { Task { await app.applyDownloadedDataIfIdle() } }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    trip.appBecameActive()
                    Task { await app.refreshDataIfDue() }
                }
            }
        }
    }
}

/// The person button on each tab: settings, vehicles, places and the profile.
struct SettingsButton: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        Button { app.showSettings = true } label: { Label("Settings", systemImage: "person.crop.circle") }
            .accessibilityIdentifier("settingsButton")
    }
}
