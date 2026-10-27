import ExitAtlasCore
import Foundation

/// Plays simulated GPS fixes along the selected route so the app can be tried without driving.
/// Fixes carry a simulated clock; every screen shows a SIMULATION label while it runs.
@MainActor
final class DriveSimulator {
    private var timer: Timer?
    private var samples: [LocationSample] = []
    private var index = 0
    private(set) var speedup: Double = 30
    var onSample: ((LocationSample) -> Void)?

    var isRunning: Bool { timer != nil }

    /// - Parameter speedup: simulated seconds per real second.
    func start(route: PlannedRoute, from distance: Double = 0, speedup: Double = 30) {
        stop()
        self.speedup = speedup
        var options = GPSSimulator.Options()
        options.interval = 1
        options.noise = 5
        options.seed = UInt64(Date().timeIntervalSince1970)
        samples = GPSSimulator(route: route, options: options).trace(from: distance, startTime: Date())
        index = 0
        // Deliver several one second fixes per tick so the tracker sees realistic spacing.
        let perTick = max(1, Int(speedup / 4))
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick(count: perTick) }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick(count: Int) {
        for _ in 0..<count {
            guard index < samples.count else {
                stop()
                return
            }
            onSample?(samples[index])
            index += 1
        }
    }
}
