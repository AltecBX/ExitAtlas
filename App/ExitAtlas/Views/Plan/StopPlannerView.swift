import ExitAtlasCore
import SwiftUI

/// "Drive about 3 more hours, then a hotel": suggestions near a drive time ahead. Pet policies are not
/// in the data yet, so the view says so instead of filtering on them.
struct StopPlannerView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss

    enum Kind: String, CaseIterable, Identifiable {
        case hotel = "Hotel", food = "Food", gas = "Gas", rest = "Rest area", ev = "EV charging"
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
                            Text("No matching exits in that window yet.").foregroundStyle(Theme.secondaryText)
                        }
                        ForEach(results) { r in
                            NavigationLink(value: r.match.exit) {
                                HStack {
                                    ExitSign(label: r.match.exit.label, compact: true)
                                    VStack(alignment: .leading) {
                                        Text(r.match.matchesPerRequirement.first?.first?.place.displayName ?? r.match.exit.displayTitle)
                                            .font(.subheadline.weight(.semibold))
                                        Text("\(Format.miles(r.distanceAhead)) ahead · \(Format.time(r.eta, relativeTo: snapshot.timestamp))")
                                            .font(.caption).foregroundStyle(Theme.secondaryText)
                                    }
                                }
                            }
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
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { run() }
        }
    }

    private func run() {
        var requirements = [ServiceRequirement(category: kind.category)]
        let b = brand.trimmingCharacters(in: .whitespaces)
        if !b.isEmpty { requirements = [ServiceRequirement(category: kind.category, nameOrBrand: b)] }
        results = trip.stopSuggestions(StopQuery(requirements: requirements, window: .timeAhead(hours * 3600, tolerance: 30 * 60)))
    }
}
