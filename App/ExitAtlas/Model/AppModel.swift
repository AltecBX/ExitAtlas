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
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    /// Builds plans for route alternatives off the main thread.
    func plans(for routes: [PlannedRoute]) async -> [TripPlan] {
        guard let datasets = data?.datasets else { return [] }
        return await Task.detached(priority: .userInitiated) {
            routes.map { TripPlan(route: $0, datasets: datasets) }
        }.value
    }
}
