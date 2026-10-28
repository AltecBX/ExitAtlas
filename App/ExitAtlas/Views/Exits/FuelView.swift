import ExitAtlasCore
import SwiftUI

/// Fuel or charging stop from the range on the dashboard: the last stop reached with the buffer left,
/// favorites anywhere in range, the last chance before empty, and live prices with the driver's key.
struct FuelView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    @State private var rangeText = ""
    @FocusState private var rangeFocused: Bool

    private var electric: Bool { settings.vehicle?.isElectric == true }

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            List {
                Section {
                    if let left = trip.rangeLeft {
                        HStack(alignment: .firstTextBaseline) {
                            Text(Format.milesValue(left)).font(Theme.number(40, weight: .heavy))
                            Text("mi of range left").font(.subheadline).foregroundStyle(Theme.secondaryText)
                        }
                    }
                    HStack {
                        TextField(electric ? "Range on your dash, miles" : "Miles to empty on your dash", text: $rangeText)
                            .keyboardType(.numberPad).focused($rangeFocused)
                        Button("Set") {
                            if let miles = Double(rangeText) { trip.setRange(miles: miles) }
                            rangeText = ""
                            rangeFocused = false
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.signGreen).disabled(Double(rangeText) == nil)
                    }
                    if settings.vehicle?.fullRangeMeters != nil {
                        Button(electric ? "Charged to full" : "Filled up") { trip.filledUp() }
                    }
                    Picker("Keep a buffer of", selection: $settings.bufferMiles) {
                        ForEach([25.0, 50.0, 75.0, 100.0], id: \.self) { Text("\(Int($0)) mi").tag($0) }
                    }
                } header: {
                    Text("Range")
                } footer: {
                    Text("Range counts down with the miles you drive. ExitAtlas cannot read your fuel gauge; enter the number your car shows.")
                }
                if let plan = trip.rangePlan {
                    recommendation(plan)
                    if !plan.earlier.isEmpty {
                        Section("Earlier options") { ForEach(plan.earlier, id: \.key) { StopRow(stop: $0) } }
                    }
                    if let last = plan.lastChance {
                        Section("Last chance before empty") { StopRow(stop: last) }
                    }
                    if !plan.stations.isEmpty {
                        Section("All \(electric ? "chargers" : "gas exits") within range (\(plan.stations.count))") {
                            ForEach(plan.stations.prefix(40), id: \.key) { StopRow(stop: $0) }
                        }
                    }
                } else if trip.rangeLeft == nil {
                    Section {
                        Text("Enter the range from your dashboard to plan a \(electric ? "charging" : "fuel") stop.")
                            .foregroundStyle(Theme.secondaryText)
                    }
                }
                if electric {
                    Section {
                        if trip.chargers.isLoading { Label("Loading chargers along the route", systemImage: "bolt.horizontal") }
                        if let error = trip.chargers.error { Text("Chargers unavailable: \(error)").font(.footnote).foregroundStyle(Theme.amber) }
                    } footer: {
                        Text("DC fast chargers within 2.5 miles of the route from the U.S. Department of Energy Alternative Fuels Data Center.")
                    }
                }
            }
            .navigationTitle(electric ? "Charging Stop" : "Fuel Stop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    @ViewBuilder
    private func recommendation(_ plan: RangePlan) -> some View {
        Section {
            switch plan.status {
            case .destination:
                Label("You reach your destination with about \(Format.miles(plan.destinationSpare ?? 0)) left. No stop needed.",
                      systemImage: "checkmark.circle").foregroundStyle(Theme.success)
            case .none:
                Label("Nothing is listed before empty on this route.", systemImage: "exclamationmark.triangle").foregroundStyle(Theme.danger)
            case .planned, .low:
                if let rec = plan.recommended {
                    if plan.status == .low {
                        Label("Under your \(Int(settings.bufferMiles)) mi buffer. Nearest first:", systemImage: "exclamationmark.triangle")
                            .foregroundStyle(Theme.amber)
                    }
                    StopRow(stop: rec, highlighted: true)
                    if let exit = rec.candidate.exit { PriceLine(exit: exit) }
                    if plan.favoriteMissing {
                        Text(plan.nextFavorite.map { "No favorite brand before your buffer. The next one is \(StopRow.title($0)), \(Format.miles($0.ahead)) ahead." }
                             ?? "No favorite brand is listed ahead.")
                            .font(.footnote).foregroundStyle(Theme.amber)
                    }
                    if let closest = plan.closestToTarget {
                        Text("Picked your favorite brand. The last stop with the buffer is \(StopRow.title(closest)), \(Format.miles(closest.ahead)) ahead.")
                            .font(.footnote).foregroundStyle(Theme.secondaryText)
                    }
                }
            }
        } header: {
            Text(plan.status == .low ? "Stop soon" : "Recommended stop")
        }
    }
}

/// One fuel or charging stop with distance, time and range on arrival.
private struct StopRow: View {
    let stop: PlannedStop
    var highlighted = false

    static func title(_ s: PlannedStop) -> String {
        if let c = s.candidate.charger { return c.station.name }
        return s.candidate.exit.map { $0.name.isEmpty ? $0.displayTitle : "\($0.displayTitle), \($0.name)" } ?? "Stop"
    }

    var body: some View {
        HStack(spacing: 12) {
            if let exit = stop.candidate.exit {
                ExitSign(label: exit.label, compact: true)
            } else {
                Image(systemName: "bolt.car.fill").font(.title2).foregroundStyle(Theme.signBlue).frame(width: 64)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text((stop.favorite ? "★ " : "") + Self.title(stop)).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text(detail).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(2)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.miles(stop.ahead)).font(.subheadline.monospacedDigit().weight(.bold))
                Text("\(Int((stop.rangeOnArrival / Geodesy.metersPerMile).rounded())) mi left").font(.caption.monospacedDigit())
                    .foregroundStyle(highlighted ? Theme.success : Theme.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        if let c = stop.candidate.charger {
            return "\(c.station.stalls) fast stalls · \(Format.miles(c.offset)) off route" + (c.station.openToOthers ? " · open to other EVs" : "")
        }
        let names = ServicePlaques.uniqueNames(stop.candidate.gasStations, .gas)
        return (names.isEmpty ? "Gas" : names.prefix(3).joined(separator: ", ")) + " · detour \(Format.miles(stop.candidate.detourMeters))"
    }
}

/// Gas prices near an exit from Google Maps with the driver's key (never stored).
private struct PriceLine: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    let exit: RouteExit

    var body: some View {
        if settings.googleKey.isEmpty {
            Text("Live gas prices: add a Google Maps key in Settings.").font(.footnote).foregroundStyle(Theme.secondaryText)
        } else if let entry = trip.gasPrices(at: exit) {
            if let error = entry.error {
                Text("Prices unavailable: \(error)").font(.footnote).foregroundStyle(Theme.amber)
            } else {
                let grade = settings.gasGrade
                let priced = GasPriceFeed.priced(entry.stations, grade: grade)
                VStack(alignment: .leading, spacing: 4) {
                    if let favorite = priced.first(where: { RangePlanner.matchesFavorite($0.name, favorites: settings.favoriteBrands) }) {
                        priceRow("★ " + favorite.name, favorite.prices[grade]!)
                    }
                    if let cheapest = priced.first { priceRow("Cheapest: " + cheapest.name, cheapest.prices[grade]!) }
                    if priced.isEmpty { Text("No \(grade.name.lowercased()) prices reported near this exit.").font(.footnote) }
                    Text("Prices: Google Maps, within 1 mile of the exit.").font(.caption2).foregroundStyle(Theme.secondaryText)
                }
            }
        } else {
            Label("Loading prices", systemImage: "fuelpump").font(.footnote).foregroundStyle(Theme.secondaryText)
        }
    }

    private func priceRow(_ name: String, _ price: GasPriceFeed.Price) -> some View {
        HStack {
            Text(name).font(.subheadline)
            Spacer()
            Text(String(format: "$%.2f", price.dollars)).font(.subheadline.monospacedDigit().weight(.bold))
            if let updated = price.updated {
                Text(updated, style: .relative).font(.caption2).foregroundStyle(Theme.secondaryText)
            }
        }
    }
}
