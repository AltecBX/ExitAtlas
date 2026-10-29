import ExitAtlasCore
import MapKit
import SwiftUI

/// The Navigation View map (docs/15): Apple's map, muted and without points of interest, showing only the
/// route ahead, the part already driven, the vehicle, and the few places the screen points at (the next exit,
/// the alert in the card, the recommended stop, a planned stop, the next state line). The camera follows the
/// vehicle with the road ahead in view; dragging the map stops following until Recenter.
struct NavigationMapView: View {
    @Environment(TripController.self) private var trip
    let snapshot: TripSnapshot
    let alert: RoadIntel.Alert?
    @Binding var following: Bool
    @State private var position: MapCameraPosition = .automatic
    /// The map's current heading, so the vehicle arrow keeps pointing along the road when the driver pans.
    @State private var cameraHeading: Double = 0

    var body: some View {
        let plan = trip.plan
        let poly = plan?.route.polyline
        let progress = snapshot.progress
        Map(position: $position, interactionModes: [.pan, .zoom]) {
            if let poly {
                MapPolyline(coordinates: coordinates(poly.slice(from: max(0, progress - 40_000), to: progress)))
                    .stroke(Theme.routePassed, style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
                let ahead = coordinates(poly.slice(from: progress, to: min(poly.length, progress + 160_000)))
                MapPolyline(coordinates: ahead)
                    .stroke(Theme.routeCasing, style: StrokeStyle(lineWidth: 13, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: ahead)
                    .stroke(Theme.route, style: StrokeStyle(lineWidth: 7, lineCap: .round, lineJoin: .round))
            }
            if let line = snapshot.next?.segment, let code = line.code {
                Annotation("State line, \(line.displayName)", coordinate: line.entryCoordinate.clCoordinate) {
                    StateBadge(code: code, compact: true)
                }
                .annotationTitles(.hidden)
            }
            if let exit = snapshot.nextExit?.exit {
                Annotation(exit.displayTitle, coordinate: exit.coordinate.clCoordinate, anchor: .bottom) {
                    ExitSign(label: exit.label, compact: true).scaleEffect(0.85, anchor: .bottom)
                }
                .annotationTitles(.hidden)
            }
            if let stop = snapshot.nextStop {
                Annotation("Planned stop, \(stop.stop.waypoint.name)", coordinate: stop.stop.waypoint.coordinate.clCoordinate, anchor: .bottom) {
                    MapPin(text: "📍 " + stop.stop.waypoint.name, fill: Theme.raised, ink: .primary)
                }
                .annotationTitles(.hidden)
            }
            if let pick = trip.smartStop?.primary, let c = stopCoordinate(pick.candidate) {
                Annotation("Recommended stop, \(pick.candidate.name)", coordinate: c.clCoordinate, anchor: .bottom) {
                    MapPin(text: "⛽ " + pick.candidate.name, fill: Theme.signBlue, ink: .white)
                }
                .annotationTitles(.hidden)
            }
            if let alert, let poly, alert.start - progress <= 50 * Geodesy.metersPerMile {
                Annotation(alert.incident.headline, coordinate: poly.coordinate(at: max(alert.start, progress)).clCoordinate) {
                    AlertMarker(alert: alert)
                }
                .annotationTitles(.hidden)
            }
            if let poly {
                Annotation("Your position", coordinate: poly.coordinate(at: progress).clCoordinate) {
                    VehiclePuck()
                        .rotationEffect(.degrees(poly.bearing(at: progress, window: 800) - cameraHeading))
                        .accessibilityLabel("Your position")
                }
                .annotationTitles(.hidden)
            }
        }
        // Flat terrain: the route and the markers draw at once, before (or without) map tiles on a weak signal.
        .mapStyle(.standard(elevation: .flat, emphasis: .muted, pointsOfInterest: .excludingAll, showsTraffic: false))
        .mapControls { MapCompass().mapControlVisibility(.hidden) }
        .onMapCameraChange(frequency: .continuous) { context in cameraHeading = context.camera.heading }
        .simultaneousGesture(DragGesture(minimumDistance: 12).onChanged { _ in following = false })
        .onAppear { follow(animated: false) }
        .onChange(of: snapshot.progress) { _, _ in follow(animated: true) }
        .onChange(of: following) { _, on in if on { follow(animated: true) } }
        .accessibilityIdentifier("navigationMap")
    }

    private func coordinates(_ p: RoutePolyline) -> [CLLocationCoordinate2D] {
        p.points.map(\.clCoordinate)
    }

    private func stopCoordinate(_ c: SmartStop.Candidate) -> GeoCoordinate? {
        if let id = c.exitID, let exit = trip.plan?.exits.first(where: { $0.id == id }) { return exit.coordinate }
        return trip.plan?.restAreas.first { $0.id == c.id }?.coordinate
    }

    /// Centers the camera on the vehicle, tilted along the road: the vehicle sits in the open middle of the
    /// screen, between the instruments and the bottom card, with the road ahead above it.
    private func follow(animated: Bool) {
        guard following, let poly = trip.plan?.route.polyline else { return }
        let p = snapshot.progress
        let center = poly.coordinate(at: min(poly.length, p + 275))
        let camera = MapCamera(centerCoordinate: center.clCoordinate, distance: 4600,
                               heading: poly.bearing(at: p, window: 800), pitch: 52)
        if animated {
            withAnimation(.linear(duration: 0.8)) { position = .camera(camera) }
        } else {
            position = .camera(camera)
        }
    }
}

/// The vehicle: an arrow in the route color with a white outline, pointing along the road.
struct VehiclePuck: View {
    var body: some View {
        Image(systemName: "location.north.fill")
            .font(.system(size: 26, weight: .bold))
            .foregroundStyle(Theme.route)
            .padding(6)
            .background(Circle().fill(.white).shadow(color: .black.opacity(0.35), radius: 5, y: 2))
    }
}

/// A road alert on the map, colored by how urgent it is.
struct AlertMarker: View {
    let alert: RoadIntel.Alert

    var body: some View {
        let tier = alert.incident.tier
        Text(AlertText.icon(alert.incident.kind))
            .font(.system(size: 17))
            .frame(width: 34, height: 34)
            .background(Circle().fill(tier == .urgent ? Theme.dangerFill : tier == .info ? Theme.infoFill : Theme.amberFill))
            .overlay(Circle().stroke(tier == .urgent ? Theme.danger : tier == .info ? Theme.info : Theme.amber, lineWidth: 2))
            .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
            .accessibilityLabel(alert.incident.headline)
    }
}

/// A small labeled pin (the recommended stop, a planned stop).
struct MapPin: View {
    let text: String
    let fill: Color
    let ink: Color

    var body: some View {
        Text(text)
            .font(.caption.weight(.bold)).lineLimit(1)
            .foregroundStyle(ink)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
    }
}
