import ExitAtlasCore
import Foundation
import Observation

/// Root object: loads the bundled data, owns settings, library and the trip controller.
@MainActor
@Observable
final class AppModel {
    enum LoadState: Equatable {
        case loading
        case ready
        case failed(String)
    }

    private(set) var loadState: LoadState = .loading
    private(set) var data: BundledData?
    let settings = UserSettings()
    let library = TripLibrary()
    let trip = TripController()
    /// Launch arguments for demos and UI screenshots: -demoTrip <miles> starts the bundled sample
    /// trip frozen at that mile; -forceDark forces dark mode.
    let forceDark = ProcessInfo.processInfo.arguments.contains("-forceDark")

    init() {
        trip.settings = settings
        trip.library = library
    }

    func start() async {
        guard data == nil else { return }
        do {
            let loaded = try await Task.detached(priority: .userInitiated) { try BundledData.load() }.value
            data = loaded
            trip.attach(data: loaded)
            loadState = .ready
            startDemoFromLaunchArguments()
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    func startDemo(atMiles miles: Double = 0, frozen: Bool = false) {
        do {
            trip.startTrip(route: try DemoTrip.load(), simulate: true, startMiles: miles, fixLimit: frozen ? 40 : nil)
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    private func startDemoFromLaunchArguments() {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-demoTrip") else { return }
        let miles = i + 1 < args.count ? Double(args[i + 1]) ?? 0 : 0
        startDemo(atMiles: miles, frozen: true)
    }

    /// Builds plans for route alternatives off the main thread.
    func plans(for routes: [PlannedRoute]) async -> [TripPlan] {
        guard let datasets = data?.datasets else { return [] }
        return await Task.detached(priority: .userInitiated) {
            routes.map { TripPlan(route: $0, datasets: datasets) }
        }.value
    }
}
