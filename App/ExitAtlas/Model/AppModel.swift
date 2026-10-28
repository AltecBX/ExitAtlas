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
    /// Which data set is loaded (bundled or downloaded) and its manifest.
    private(set) var dataInfo: DataSetInfo?
    let dataUpdater = DataUpdater()
    let settings = UserSettings()
    let library = TripLibrary()
    let trip = TripController()
    /// Launch arguments for demos and UI screenshots: -demoTrip <miles> starts the bundled sample
    /// trip frozen at that mile; -forceDark forces dark mode.
    let forceDark = ProcessInfo.processInfo.arguments.contains("-forceDark")

    /// The running app's model, for Siri and Shortcuts intents (they run in this process).
    static weak var shared: AppModel?

    init() {
        trip.settings = settings
        trip.library = library
        AppModel.shared = self
    }

    func start() async {
        guard data == nil else { return }
        do {
            let loaded = try await Task.detached(priority: .userInitiated) { try BundledData.loadBest() }.value
            data = loaded.data
            dataInfo = loaded.info
            trip.attach(data: loaded.data)
            loadState = .ready
            startDemoFromLaunchArguments()
            await refreshDataIfDue()
        } catch {
            loadState = .failed(error.localizedDescription)
        }
    }

    /// Switches to newly downloaded data when no trip or discovery drive is running (a running trip
    /// keeps the data it started with). Called after a download and when the app becomes active.
    func applyDownloadedDataIfIdle() async {
        guard case .installed = dataUpdater.status, trip.mode == .idle else { return }
        guard let loaded = try? await Task.detached(priority: .utility, operation: { try BundledData.loadBest() }).value else { return }
        data = loaded.data
        dataInfo = loaded.info
        trip.attach(data: loaded.data)
    }

    /// Daily data check (Wi-Fi only), then switch to new data if no trip is running. Demos and UI
    /// screenshots keep the data they were built with.
    func refreshDataIfDue() async {
        guard let info = dataInfo, !ProcessInfo.processInfo.arguments.contains("-demoTrip") else { return }
        await dataUpdater.checkIfDue(using: info)
        await applyDownloadedDataIfIdle()
    }

    /// Settings: check for newer data now, on any network.
    func checkForDataUpdate() async {
        guard let info = dataInfo else { return }
        await dataUpdater.check(using: info)
        await applyDownloadedDataIfIdle()
    }

    /// Settings: go back to the data bundled with the app.
    func useBundledData() async {
        guard trip.mode == .idle else { return }
        dataUpdater.removeDownloads()
        guard let loaded = try? await Task.detached(priority: .userInitiated, operation: { try BundledData.loadBest() }).value else { return }
        data = loaded.data
        dataInfo = loaded.info
        trip.attach(data: loaded.data)
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
        // -demoVehicle: a 2015 Camry 2.5 L (EPA 34 mpg highway, verified 17 gal tank) for screenshots.
        if args.contains("-demoVehicle"), let url = Bundle.main.url(forResource: "vehicles", withExtension: "json", subdirectory: "Data"),
           let catalog = try? VehicleCatalog(contentsOf: url),
           let camry = catalog.versions(year: 2015, make: "Toyota", model: "Camry").first(where: { $0.label.hasPrefix("4 cyl 2.5 L") }) {
            settings.vehicle = DriverVehicle(year: 2015, make: "Toyota", model: "Camry", version: camry)
            settings.favoriteBrands = ["Shell"]
        }
        startDemo(atMiles: miles, frozen: true)
        // -demoRange <miles>: range entered from the dashboard at the demo's starting point.
        // The simulator jumps to the start mile, which the trip counts as driven, so count down from there.
        if let r = args.firstIndex(of: "-demoRange"), r + 1 < args.count, let range = Double(args[r + 1]) {
            trip.setRange(miles: range, drivenAtEntry: miles * Geodesy.metersPerMile)
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
