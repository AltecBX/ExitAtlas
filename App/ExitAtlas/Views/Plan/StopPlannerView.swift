import ExitAtlasCore
import SwiftUI

/// "Drive about 3 more hours, then a hotel": ranked suggestions near a drive time ahead, each with the
/// reasons for its place. Rest stops include rest areas and plazas on the highway. Pet policies are not
/// in the data yet, so the view says so instead of filtering on them.
struct StopPlannerView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss

    enum Kind: String, CaseIterable, Identifiable {
        case hotel = "Hotel", food = "Food", gas = "Gas", rest = "Rest stop", ev = "EV charging"
        var id: String { rawValue }

        var category: PlaceCategory {
            switch self {
            case .hotel: return .lodging
            case .food: return .food
            case .gas: return .gas
            case .rest: return .restArea
            case .ev: return .evCharging
            }
        }
    }

    @Environment(UserSettings.self) private var settings
    @State private var kind: Kind = .hotel
    @State private var hours: Double = 3
    @State private var brand = ""
    @State private var results: [StopSuggestion] = []

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Stop for", selection: $kind) { ForEach(Kind.allCases) { Text($0.rawValue).tag($0) } }
                    Stepper(String(format: "After about %.1f more hours", hours), value: $hours, in: 0.5...12, step: 0.5)
                    TextField("Brand (optional)", text: $brand).autocorrectionDisabled()
                    Button("Show options") { run() }
                }
                if let snapshot = trip.snapshot {
                    Section("Around \(Format.time(snapshot.timestamp.addingTimeInterval(hours * 3600), relativeTo: snapshot.timestamp)), ±30 min") {
                        if results.isEmpty {
                            Text("Nothing matches in that window yet.").foregroundStyle(Theme.secondaryText)
                        }
                        ForEach(Array(results.prefix(12).enumerated()), id: \.element.id) { index, r in
                            if let restArea = r.restArea {
                                NavigationLink(value: restArea) {
                                    StopResultRow(suggestion: r, best: index == 0, now: snapshot.timestamp)
                                }
                            } else if let match = r.match {
                                VStack(alignment: .leading, spacing: 6) {
                                    NavigationLink(value: match.exit) {
                                        StopResultRow(suggestion: r, best: index == 0, now: snapshot.timestamp)
                                    }
                                    if trip.canAddStop, let place = match.matchesPerRequirement.first?.first?.place {
                                        Button("Add to trip") {
                                            trip.addStop(place, at: match.exit)
                                            dismiss()
                                        }
                                        .buttonStyle(.bordered)
                                        .padding(.leading, 76)
                                    }
                                }
                            }
                        }
                    }
                    if !trip.canAddStop, !results.isEmpty {
                        Section {
                            Text("Adding a stop reroutes the trip, which needs live GPS (not the demo).")
                                .font(.caption).foregroundStyle(Theme.secondaryText)
                        }
                    }
                }
                Section {
                    Text("Pet policies, ratings, rates and availability are not in the offline data yet. Confirm with the business before you go.")
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            .navigationTitle("Plan a Stop")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: RouteExit.self) { ExitDetailView(exit: $0) }
            .navigationDestination(for: RouteRestArea.self) { RestAreaDetailView(restArea: $0) }
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { run() }
        }
    }

    /// Rest stops search rest areas on the highway plus rest areas and travel centers at exits.
    private func run() {
        let b = brand.trimmingCharacters(in: .whitespaces)
        let categories: [PlaceCategory] = kind == .rest ? [.restArea, .travelCenter] : [kind.category]
        let window = StopQuery.Window.timeAhead(hours * 3600, tolerance: 30 * 60)
        var seen = Set<String>()
        results = categories.enumerated().flatMap { i, category in
            trip.stopSuggestions(StopQuery(requirements: [ServiceRequirement(category: category, nameOrBrand: b.isEmpty ? nil : b)],
                                           window: window, includeRestAreas: kind == .rest && i == 0,
                                           favorites: settings.favoriteBrands))
        }
        .sorted { $0.score < $1.score }
        .filter { seen.insert($0.id).inserted }
    }
}

/// A ranked stop: the exit tab or rest area sign, the places, arrival time and the reasons.
private struct StopResultRow: View {
    let suggestion: StopSuggestion
    let best: Bool
    let now: Date

    var body: some View {
        let r = suggestion
        HStack(alignment: .top, spacing: 12) {
            if let rest = r.restArea {
                RestAreaSign(kind: rest.kind, compact: true)
            } else if let match = r.match {
                ExitSign(label: match.exit.label, compact: true)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text("\(Format.miles(r.distanceAhead)) ahead · arrive \(Format.time(r.eta, relativeTo: now))")
                    .font(.caption).foregroundStyle(Theme.secondaryText)
                // Plain wrapping text: chips in a flow layout were clipped inside list rows.
                if best {
                    Text("Best fit").font(.caption2.weight(.bold)).foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Theme.signGreen, in: Capsule())
                }
                Text(r.reasons.joined(separator: " · ")).font(.caption.weight(.semibold)).foregroundStyle(Theme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var title: String {
        if let rest = suggestion.restArea { return rest.title }
        let places = suggestion.match?.matchesPerRequirement.first?.prefix(3).map(\.place.displayName) ?? []
        return places.isEmpty ? (suggestion.match?.exit.displayTitle ?? "Stop") : places.joined(separator: ", ")
    }
}
