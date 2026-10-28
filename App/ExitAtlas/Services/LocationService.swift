import CoreLocation
import ExitAtlasCore
import Foundation

/// Streams GPS fixes for driving.
///
/// Uses CLLocationUpdate.liveUpdates with the automotive navigation configuration (iOS 17).
/// A CLBackgroundActivitySession keeps updates flowing with When In Use authorization while
/// the app is in the background; on iOS 18 a CLServiceSession declares that need explicitly.
@MainActor
final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var task: Task<Void, Never>?
    private var backgroundSession: CLBackgroundActivitySession?
    private var serviceSession: AnyObject?
    private(set) var authorization: CLAuthorizationStatus = .notDetermined
    var onSample: ((LocationSample) -> Void)?
    var onAuthorizationChange: ((CLAuthorizationStatus) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        authorization = manager.authorizationStatus
    }

    var isRunning: Bool { task != nil }

    func requestAuthorization() {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
    }

    func start() {
        guard task == nil else { return }
        requestAuthorization()
        if #available(iOS 18.0, *) {
            serviceSession = CLServiceSession(authorization: .whenInUse)
        }
        backgroundSession = CLBackgroundActivitySession()
        task = Task { [weak self] in
            do {
                for try await update in CLLocationUpdate.liveUpdates(.automotiveNavigation) {
                    guard let location = update.location else { continue }
                    self?.onSample?(LocationSample(location))
                }
            } catch {
                // The stream ends when location services are unavailable; the UI shows the status.
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
        backgroundSession?.invalidate()
        backgroundSession = nil
        if #available(iOS 18.0, *) {
            (serviceSession as? CLServiceSession)?.invalidate()
        }
        serviceSession = nil
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            self.authorization = status
            self.onAuthorizationChange?(status)
        }
    }
}

extension LocationSample {
    init(_ location: CLLocation) {
        self.init(
            coordinate: GeoCoordinate(latitude: location.coordinate.latitude, longitude: location.coordinate.longitude),
            horizontalAccuracy: location.horizontalAccuracy,
            course: location.course >= 0 ? location.course : nil,
            speed: location.speed >= 0 ? location.speed : nil,
            timestamp: location.timestamp)
    }
}

extension GeoCoordinate {
    init(_ c: CLLocationCoordinate2D) {
        self.init(latitude: c.latitude, longitude: c.longitude)
    }

    var clCoordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}
