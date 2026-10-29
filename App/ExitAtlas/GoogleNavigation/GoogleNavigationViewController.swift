#if GOOGLE_NAVIGATION
import CoreLocation
import ExitAtlasCore
import GoogleNavigation
import UIKit
import UserNotifications

/// Google's navigation screen (Navigation SDK 11.2) for the experimental mode (docs/14): Google's map, route
/// and voice, and its real time disruptions (police, speed cameras, crashes and more) with Google's own
/// callouts, approach alerts, cards and report button, all at Google's defaults. ExitAtlas reads nothing from
/// it: no route, road names, speed limits or reports.
final class GoogleNavigationViewController: UIViewController, GMSNavigatorListener {
    enum Phase: Equatable {
        case starting, navigating, arrived
        /// The driver declined Google's terms.
        case declined
        case failed(String)
    }

    var onPhase: ((Phase) -> Void)?
    private let destinations: [Waypoint]
    private var mapView: GMSMapView!
    private let locationManager = CLLocationManager()
    private var started = false
    private var idleTimerWasDisabled = false

    init(destinations: [Waypoint]) {
        self.destinations = destinations
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        mapView = GMSMapView()
        mapView.settings.compassButton = true
        view = mapView
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The SDK does not keep the screen on.
        idleTimerWasDisabled = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        // Google's own terms dialog, unmodified (required); nothing starts until it is accepted.
        let options = GMSNavigationTermsAndConditionsOptions(companyName: "ExitAtlas")
        GMSNavigationServices.showTermsAndConditionsDialogIfNeeded(with: options) { [weak self] accepted in
            guard let self else { return }
            if accepted { self.begin() } else { self.onPhase?(.declined) }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stop()
        UIApplication.shared.isIdleTimerDisabled = idleTimerWasDisabled
    }

    private func begin() {
        guard let navigator = mapView.navigator else { return fail("Google navigation is not available on this device.") }
        mapView.isNavigationEnabled = true
        // Disruptions off the route show only with the traffic layer.
        mapView.isTrafficEnabled = true
        mapView.travelMode = .driving
        // Callouts, approach alerts and cards (Google's defaults, set explicitly). The report button stays at
        // Google's default (on).
        navigator.shouldDisplayPrompts = true
        mapView.settings.showsIncidentCards = true
        navigator.voiceGuidance = .alertsAndGuidance
        navigator.sendsBackgroundNotifications = true
        navigator.add(self)
        locationManager.requestAlwaysAuthorization()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }

        let waypoints = destinations.prefix(25).compactMap {
            GMSNavigationWaypoint(location: CLLocationCoordinate2D(latitude: $0.coordinate.latitude, longitude: $0.coordinate.longitude), title: $0.name)
        }
        guard !waypoints.isEmpty else { return fail("This trip has no destination ahead.") }
        GoogleNavigationAccount.shared.count(destinations: waypoints.count)
        navigator.setDestinations(waypoints) { [weak self] status in
            guard let self else { return }
            guard status == .OK else { return self.fail(Self.text(for: status)) }
            navigator.isGuidanceActive = true
            self.mapView.cameraMode = .following
            self.onPhase?(.navigating)
        }
    }

    /// Parked tests, labeled as simulations by the screen: Google's simulated drive along the route, and
    /// Google's own test traffic prompt.
    func simulateDrive() { mapView.locationSimulator?.simulateLocationsAlongExistingRoute() }
    func showTestAlert() { mapView.locationSimulator?.simulateTrafficIncidentReport() }

    private func stop() {
        mapView.locationSimulator?.stopSimulation()
        if let navigator = mapView.navigator {
            navigator.isGuidanceActive = false
            navigator.clearDestinations()
            navigator.remove(self)
        }
        mapView.isNavigationEnabled = false
    }

    private func fail(_ message: String) {
        onPhase?(.failed(message))
    }

    /// Arrival at the last destination (Google stops guidance there by itself).
    nonisolated func navigator(_ navigator: GMSNavigator, didArriveAt waypoint: GMSNavigationWaypoint) {
        let title = waypoint.title
        Task { @MainActor in
            if title == self.destinations.last?.name { self.onPhase?(.arrived) }
        }
    }

    private static func text(for status: GMSRouteStatus) -> String {
        switch status {
        case .networkError: return "Google could not be reached. Check the connection; ExitAtlas keeps navigating your trip."
        case .noRouteFound: return "Google found no route to the destination."
        case .locationUnavailable: return "Your location is not available yet."
        case .apiKeyNotAuthorized: return "The key is not allowed to use the Navigation SDK for iOS. Check it in the Google Cloud console."
        case .quotaExceeded: return "The key's Google quota is used up for now."
        default: return "Google could not start navigation."
        }
    }
}
#endif
