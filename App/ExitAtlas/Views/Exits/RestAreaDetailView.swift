import ExitAtlasCore
import SwiftUI

/// One rest area or service plaza: listed amenities only, hours, gas and food at plazas, truck
/// parking, and the OpenStreetMap records behind it.
struct RestAreaDetailView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let restArea: RouteRestArea
    /// Shown as a sheet (from Drive) rather than pushed (from Exits).
    var showsDone = false

    var body: some View {
        let r = restArea
        List {
            Section {
                HStack(spacing: 12) {
                    RestAreaSign(kind: r.kind)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.title).font(.title3.weight(.bold))
                        Text(r.side == .both ? "In the median or on an undivided road: serves both directions" : "On your side of the highway")
                            .font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                if let snapshot = trip.snapshot, r.distanceAlongRoute > snapshot.progress, let plan = trip.plan {
                    let eta = plan.eta(to: r.distanceAlongRoute, from: snapshot)
                    LabeledContent("Ahead", value: "\(Format.miles(r.distanceAlongRoute - snapshot.progress)) · \(Format.duration(eta.timeIntervalSince(snapshot.timestamp)))")
                }
                LabeledContent("Road", value: r.road)
                HStack {
                    Button("Apple Maps") { open(apple: true) }
                    Spacer()
                    Button("Google Maps") { open(apple: false) }
                    Spacer()
                    Button("Waze") { WazeHandoff.open(to: restArea.coordinate) }
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.signGreen)
            }
            Section {
                let badges = r.badges
                if badges.isEmpty {
                    Text("No amenities are tagged for this place in OpenStreetMap. That does not mean it has none.")
                        .font(.footnote).foregroundStyle(Theme.secondaryText)
                }
                ForEach(Array(badges.enumerated()), id: \.offset) { _, b in
                    Label(b.value ? b.amenity.label : "No \(b.amenity.label.lowercased())", systemImage: AmenityChips.symbol(b.amenity))
                        .foregroundStyle(b.value ? Color.primary : Theme.amber)
                }
            } header: {
                Text("Amenities listed")
            }
            if let hours = r.hoursText {
                Section("Hours") { Label(hours, systemImage: "clock") }
            }
            if !r.gas.isEmpty { Section("Gas") { Text(r.gas.joined(separator: ", ")) } }
            if !r.food.isEmpty { Section("Food") { Text(r.food.joined(separator: ", ")) } }
            if !r.ev.isEmpty { Section("EV charging") { Text(r.ev.joined(separator: ", ")) } }
            if let spaces = r.truckSpaces ?? r.fhwaTruckSpaces {
                Section("Truck parking") {
                    Text(r.truckSpaces != nil ? "\(spaces) truck spaces (OpenStreetMap)" : "\(spaces) truck spaces (FHWA survey, 2019)")
                }
            }
            Section {
                ForEach(r.osmIDs, id: \.self) { id in
                    if let url = URL(string: "https://www.openstreetmap.org/\(id)") { Link("OpenStreetMap \(id)", destination: url) }
                }
            } header: {
                Text("Source")
            } footer: {
                Text((r.checked.map { "Last checked by a mapper \($0). " } ?? "")
                     + (r.nameFromFHWA ? "Name from the FHWA truck parking survey. " : "")
                     + "ExitAtlas cannot see closures; check state DOT notices for long trips.")
            }
        }
        .navigationTitle(r.kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsDone { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func open(apple: Bool) {
        let c = restArea.coordinate
        let name = restArea.title.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let link = apple ? "https://maps.apple.com/?ll=\(c.latitude),\(c.longitude)&q=\(name)"
            : "https://www.google.com/maps/search/?api=1&query=\(c.latitude),\(c.longitude)"
        if let url = URL(string: link) { openURL(url) }
    }
}
