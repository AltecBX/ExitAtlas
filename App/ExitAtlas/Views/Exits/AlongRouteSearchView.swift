import ExitAtlasCore
import SwiftUI

/// "One exit with gas and a Starbucks in the next 30 miles", "a hotel about 2 hours ahead".
struct AlongRouteSearchView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss

    enum WindowKind: String, CaseIterable, Identifiable {
        case miles = "Distance", hours = "Drive time"
        var id: String { rawValue }
    }

    @State private var categories: Set<PlaceCategory> = []
    @State private var brand = ""
    @State private var windowKind: WindowKind = .miles
    @State private var miles: Double = 50
    @State private var hours: Double = 2
    @State private var results: [StopSuggestion] = []
    @State private var searched = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Every one of these at the same exit") {
                    ForEach([PlaceCategory.gas, .food, .lodging, .restArea, .evCharging, .dogPark], id: \.self) { c in
                        Toggle(isOn: binding(for: c)) { Label(c.displayName, systemImage: c.symbolName) }
                    }
                    TextField("Brand or name (Starbucks, Cracker Barrel)", text: $brand)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                }
                Section("Where") {
                    Picker("Search by", selection: $windowKind) {
                        ForEach(WindowKind.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    if windowKind == .miles {
                        Stepper("Next \(Int(miles)) miles", value: $miles, in: 5...300, step: 5)
                    } else {
                        Stepper(String(format: "About %.1f hours ahead (±20 min)", hours), value: $hours, in: 0.5...10, step: 0.5)
                    }
                }
                Section {
                    Button("Search") { run() }.disabled(categories.isEmpty && brand.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if searched {
                    Section(results.isEmpty ? "No exit matches every requirement" : "\(results.count) matching exits") {
                        ForEach(results) { r in
                            NavigationLink(value: r.match.exit) { ResultRow(result: r, now: trip.snapshot?.timestamp ?? Date()) }
                        }
                    }
                }
            }
            .navigationTitle("Find Along Route")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: RouteExit.self) { ExitDetailView(exit: $0) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func binding(for c: PlaceCategory) -> Binding<Bool> {
        Binding(get: { categories.contains(c) }, set: { on in if on { categories.insert(c) } else { categories.remove(c) } })
    }

    private func run() {
        var requirements = categories.sorted { $0.rawValue < $1.rawValue }.map { ServiceRequirement(category: $0) }
        let name = brand.trimmingCharacters(in: .whitespaces)
        if !name.isEmpty { requirements.append(ServiceRequirement(nameOrBrand: name)) }
        let window: StopQuery.Window = windowKind == .miles
            ? .distanceAhead(0...(miles * Geodesy.metersPerMile))
            : .timeAhead(hours * 3600, tolerance: 20 * 60)
        results = trip.stopSuggestions(StopQuery(requirements: requirements, window: window))
        searched = true
    }
}

private struct ResultRow: View {
    let result: StopSuggestion
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            ExitSign(label: result.match.exit.label, compact: true)
            VStack(alignment: .leading, spacing: 3) {
                Text(result.match.exit.name.isEmpty ? result.match.exit.displayTitle : result.match.exit.name)
                    .font(.subheadline.weight(.semibold))
                Text(result.match.matchesPerRequirement.compactMap { $0.first?.place.displayName }.joined(separator: " + "))
                    .font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(2)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.miles(result.distanceAhead)).font(.subheadline.monospacedDigit().weight(.bold))
                Text(Format.time(result.eta, relativeTo: now)).font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
    }
}
