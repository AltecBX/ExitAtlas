import ExitAtlasCore
import MapKit
import SwiftUI

/// One exit: where it is, what is there, and what each stop costs in detour.
struct ExitDetailView: View {
    @Environment(TripController.self) private var trip
    let exit: RouteExit

    var body: some View {
        let services = trip.services(for: exit)
        let upcoming = trip.snapshot?.upcomingExits.first { $0.exit.id == exit.id }
        List {
            Section {
                HStack(spacing: 14) {
                    ExitSign(label: exit.label)
                    VStack(alignment: .leading, spacing: 4) {
                        if !exit.name.isEmpty { Text(exit.name).font(.headline) }
                        if let upcoming, let snapshot = trip.snapshot {
                            Text("\(Format.miles(upcoming.distance)) ahead · \(Format.duration(upcoming.eta.timeIntervalSince(snapshot.timestamp)))")
                                .font(.subheadline).foregroundStyle(Theme.secondaryText)
                        }
                        if !exit.highways.isEmpty {
                            Text(exit.highways.joined(separator: " · ")).font(.caption).foregroundStyle(Theme.secondaryText)
                        }
                    }
                }
                ExitMap(exit: exit, services: services)
                    .frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
            }
            if services.isEmpty {
                Section {
                    Text("No services are linked to this exit in the offline data.").foregroundStyle(Theme.secondaryText)
                }
            }
            ForEach(PlaceCategory.allCases, id: \.self) { category in
                let items = services.filter { $0.place.category == category }
                if !items.isEmpty {
                    Section(category.displayName) {
                        ForEach(items) { service in ServiceRow(service: service) }
                    }
                }
            }
            Section {
                Text("Detours are round trip estimates from the exit. Routed values come from OpenStreetMap drive times (OpenInterstate reachability); others are straight line estimates and are labeled. Hours, ratings, prices and amenities are not in the offline data.")
                    .font(.caption).foregroundStyle(Theme.secondaryText)
                DataAttribution()
            }
        }
        .navigationTitle(exit.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct ServiceRow: View {
    let service: ExitService

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: service.place.category.symbolName)
                .frame(width: 30, height: 30)
                .background(Theme.cardStroke, in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(service.place.displayName).font(.subheadline.weight(.semibold))
                Text(detourText).font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            Button {
                openInMaps()
            } label: {
                Image(systemName: "arrow.triangle.turn.up.right.circle.fill").font(.title2)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Directions to \(service.place.displayName)")
        }
    }

    private var detourText: String {
        switch service.detourBasis {
        case .routedOneWayDoubled:
            let time = service.detourSeconds.map { " · about \(Format.duration($0))" } ?? ""
            return "Detour \(Format.miles(service.detourMeters)) round trip\(time)"
        case .straightLineEstimate:
            return "Roughly \(Format.miles(service.detourMeters)) round trip (straight line estimate)"
        }
    }

    private func openInMaps() {
        let item = MKMapItem(placemark: MKPlacemark(coordinate: service.place.coordinate.clCoordinate))
        item.name = service.place.displayName
        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
    }
}

/// Apple map with the exit and its linked places (OpenStreetMap data drawn as our own overlay).
private struct ExitMap: View {
    let exit: RouteExit
    let services: [ExitService]

    var body: some View {
        Map(initialPosition: .region(region)) {
            Annotation(exit.displayTitle, coordinate: exit.coordinate.clCoordinate) {
                ExitSign(label: exit.label, compact: true)
            }
            ForEach(services) { s in
                Marker(s.place.displayName, systemImage: s.place.category.symbolName,
                       coordinate: s.place.coordinate.clCoordinate)
                    .tint(tint(s.place.category))
            }
        }
        .mapStyle(.standard(pointsOfInterest: .excludingAll))
        .overlay(alignment: .bottomLeading) {
            Text("© OpenStreetMap").font(.caption2).padding(4).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 4)).padding(6)
        }
    }

    private var region: MKCoordinateRegion {
        var lats = [exit.coordinate.latitude], lons = [exit.coordinate.longitude]
        for s in services {
            lats.append(s.place.coordinate.latitude)
            lons.append(s.place.coordinate.longitude)
        }
        let center = CLLocationCoordinate2D(latitude: (lats.min()! + lats.max()!) / 2, longitude: (lons.min()! + lons.max()!) / 2)
        let span = MKCoordinateSpan(latitudeDelta: max(0.01, (lats.max()! - lats.min()!) * 1.4),
                                    longitudeDelta: max(0.01, (lons.max()! - lons.min()!) * 1.4))
        return MKCoordinateRegion(center: center, span: span)
    }

    private func tint(_ c: PlaceCategory) -> Color {
        switch c {
        case .gas: return .orange
        case .food: return .red
        case .lodging: return .indigo
        case .restArea: return .teal
        case .evCharging: return .green
        default: return .gray
        }
    }
}
