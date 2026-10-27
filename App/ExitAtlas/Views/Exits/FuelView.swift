import ExitAtlasCore
import SwiftUI

/// Gas stations within range, with detour cost. Prices appear only from a licensed source.
struct FuelView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var fuelFraction: Double = 0.5

    /// No licensed station level price feed is connected in this version (see docs/02).
    private let prices: [String: [FuelPriceObservation]] = [:]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Fuel in tank")
                            Spacer()
                            Text("\(Int(fuelFraction * 100))% · \(String(format: "%.1f", fuelGallons)) gal").monospacedDigit()
                        }
                        Slider(value: $fuelFraction, in: 0...1)
                        Text("Usable range about \(Format.miles(rangeMeters)) at \(Int(settings.milesPerGallon)) mpg, keeping a 2 gallon reserve.")
                            .font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                Section {
                    Label("No verified fuel prices", systemImage: "info.circle")
                        .font(.subheadline.weight(.semibold))
                    Text("ExitAtlas shows prices only from a licensed provider and always with the time they were reported. No provider is connected yet, so stations are compared by distance and detour only.")
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
                if let plan = fuelPlan {
                    let options = plan.options.sorted { $0.exit.distance < $1.exit.distance }
                    Section("Reachable stations") {
                        ForEach(options.filter(\.reachable)) { o in FuelRow(option: o) }
                    }
                    let beyond = options.filter { !$0.reachable }
                    if !beyond.isEmpty {
                        Section("Beyond your range") {
                            ForEach(beyond.prefix(10)) { o in FuelRow(option: o).opacity(0.5) }
                        }
                    }
                }
            }
            .navigationTitle("Gas Ahead")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private var fuelGallons: Double { settings.tankGallons * fuelFraction }
    private var rangeMeters: Double { max(0, fuelGallons - 2) * settings.milesPerGallon * Geodesy.metersPerMile }

    private var fuelPlan: FuelPlan? {
        guard let snapshot = trip.snapshot, let plan = trip.plan, let dataset = trip.interstates else { return nil }
        return FuelPlanner().plan(snapshot: snapshot, plan: plan, dataset: dataset, vehicle: settings.vehicle,
                                  fuelGallons: fuelGallons, prices: prices, now: snapshot.timestamp)
    }
}

private struct FuelRow: View {
    let option: FuelOption

    var body: some View {
        HStack(spacing: 12) {
            ExitSign(label: option.exit.exit.label, compact: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(option.service.place.displayName).font(.subheadline.weight(.semibold))
                Text("Detour \(Format.miles(option.service.detourMeters))"
                    + (option.detourSeconds.map { " · \(Format.duration($0))" } ?? "")
                    + (option.matchesPreferredBrand ? "" : " · not a preferred brand"))
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.miles(option.exit.distance)).font(.subheadline.monospacedDigit().weight(.bold))
                if let price = option.price {
                    Text(String(format: "$%.2f", price.pricePerGallon)).font(.caption.monospacedDigit())
                    Text("\(price.source), \(price.observedAt.formatted(date: .abbreviated, time: .shortened))")
                        .font(.caption2).foregroundStyle(Theme.secondaryText)
                } else {
                    Text("No price").font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
        }
    }
}
