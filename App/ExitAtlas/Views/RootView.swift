import ExitAtlasCore
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(TripController.self) private var trip

    enum Tab: Hashable {
        case drive, exits, trip, settings
    }

    @State private var tab: Tab = .drive

    var body: some View {
        switch app.loadState {
        case .loading:
            ProgressView("Loading offline highway data")
        case let .failed(message):
            ContentUnavailableView("Data failed to load", systemImage: "exclamationmark.triangle", description: Text(message))
        case .ready:
            TabView(selection: $tab) {
                DriveView(selectedTab: $tab)
                    .tabItem { Label("Drive", systemImage: "gauge.with.dots.needle.67percent") }
                    .tag(Tab.drive)
                ExitsView()
                    .tabItem { Label("Exits", systemImage: "arrow.up.right.square") }
                    .tag(Tab.exits)
                Group {
                    if trip.mode == .idle { PlannerView() } else { TripOverviewView() }
                }
                .tabItem { Label("Trip", systemImage: "map") }
                .tag(Tab.trip)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(Tab.settings)
            }
            .tint(Theme.signGreen)
            .preferredColorScheme(app.forceDark ? .dark : nil)
            .onChange(of: trip.mode) { _, mode in
                if mode != .idle { tab = .drive }
            }
            .overlay(alignment: .top) {
                if trip.isSimulating {
                    Text("SIMULATED GPS · not your real location")
                        .font(.caption2.weight(.bold)).padding(.horizontal, 10).padding(.vertical, 3)
                        .background(.purple, in: Capsule()).foregroundStyle(.white)
                        .allowsHitTesting(false)
                }
            }
        }
    }
}
