import ExitAtlasCore
import Foundation
import MapKit
import Observation

/// Address and place autocomplete for choosing a destination or stop (Apple MapKit).
@MainActor
@Observable
final class PlaceSearch: NSObject, MKLocalSearchCompleterDelegate {
    var query = "" {
        didSet { completer.queryFragment = query }
    }

    private(set) var suggestions: [MKLocalSearchCompletion] = []
    private(set) var error: String?
    @ObservationIgnored private let completer = MKLocalSearchCompleter()

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = [.address, .pointOfInterest]
        completer.region = MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 39.5, longitude: -98.35),
            span: MKCoordinateSpan(latitudeDelta: 30, longitudeDelta: 60))
    }

    /// Resolves a suggestion to a coordinate.
    func resolve(_ completion: MKLocalSearchCompletion) async throws -> Waypoint {
        let response = try await MKLocalSearch(request: MKLocalSearch.Request(completion: completion)).start()
        guard let item = response.mapItems.first else { throw CancellationError() }
        let c = item.placemark.coordinate
        let title = completion.title.isEmpty ? (item.name ?? "Destination") : completion.title
        return Waypoint(name: title, coordinate: GeoCoordinate(c))
    }

    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        let results = completer.results
        Task { @MainActor in
            self.suggestions = Array(results.prefix(8))
            self.error = nil
        }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        let message = error.localizedDescription
        Task { @MainActor in self.error = message }
    }
}
