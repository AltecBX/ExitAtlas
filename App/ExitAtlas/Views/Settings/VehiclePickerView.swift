import ExitAtlasCore
import SwiftUI

/// Picks the driver's car from the EPA list (every gasoline, diesel, hybrid and electric version since
/// 2000). Tank sizes come from the verified table; any other car asks for its tank size once.
struct VehiclePickerView: View {
    @Environment(UserSettings.self) private var settings
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var catalog: VehicleCatalog?
    @State private var loadError: String?
    @State private var year = 0
    @State private var make = ""
    @State private var model = ""
    @State private var versionIndex = -1
    @State private var tankText = ""
    @State private var pickedTank: Double?
    @State private var basis: DriverVehicle.Basis = .highway
    @State private var customText = ""
    @State private var restoring = false

    private var versions: [VehicleCatalog.Version] {
        guard let catalog, year > 0, !make.isEmpty, !model.isEmpty else { return [] }
        return catalog.versions(year: year, make: make, model: model)
    }

    private var version: VehicleCatalog.Version? {
        versions.indices.contains(versionIndex) ? versions[versionIndex] : nil
    }

    var body: some View {
        Form {
            if let loadError {
                Text(loadError).foregroundStyle(Theme.danger)
            } else if let catalog {
                Section {
                    Picker("Year", selection: $year) {
                        Text("Choose").tag(0)
                        ForEach(catalog.modelYears, id: \.self) { Text(String($0)).tag($0) }
                    }
                    Picker("Make", selection: $make) {
                        Text("Choose").tag("")
                        ForEach(year > 0 ? catalog.makes(year: year) : [], id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(year == 0)
                    Picker("Model", selection: $model) {
                        Text("Choose").tag("")
                        ForEach(make.isEmpty ? [] : catalog.models(year: year, make: make), id: \.self) { Text($0).tag($0) }
                    }
                    .disabled(make.isEmpty)
                    Picker("Version", selection: $versionIndex) {
                        Text("Choose").tag(-1)
                        ForEach(Array(versions.enumerated()), id: \.offset) { i, v in Text(v.label).tag(i) }
                    }
                    .pickerStyle(.navigationLink)
                    .disabled(model.isEmpty)
                } footer: {
                    Text("Fuel economy and EV range from the U.S. EPA (fueleconomy.gov).")
                }
                if let version {
                    details(version)
                }
            } else {
                ProgressView("Loading the EPA vehicle list")
            }
        }
        .navigationTitle("Your Vehicle")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") { save() }.disabled(version == nil)
            }
        }
        .task { await load() }
        .onChange(of: year) { if !restoring { make = ""; model = ""; versionIndex = -1 } }
        .onChange(of: make) { if !restoring { model = ""; versionIndex = -1 } }
        .onChange(of: model) { if !restoring { versionIndex = versions.count == 1 ? 0 : -1 } }
        .onChange(of: versionIndex) { if !restoring { pickedTank = nil; tankText = "" } }
    }

    @ViewBuilder
    private func details(_ v: VehicleCatalog.Version) -> some View {
        Section("EPA rating") {
            if v.isElectric {
                LabeledContent("Range", value: "\(v.evRangeMiles) mi combined" + (v.evRangeHighwayMiles > 0 ? ", \(v.evRangeHighwayMiles) mi highway" : ""))
                LabeledContent("Efficiency", value: "\(v.combined) MPGe combined")
            } else {
                LabeledContent("City · Highway · Combined", value: "\(v.city) · \(v.highway) · \(v.combined) mpg")
            }
        }
        if !v.isElectric {
            Section {
                if let tank = v.tank, tank.gallons.count == 1 {
                    LabeledContent("Tank", value: String(format: "%.1f gal", tank.gallons[0]))
                    sourceLinks(tank)
                } else if let tank = v.tank {
                    Picker("Tank", selection: $pickedTank) {
                        Text("Choose").tag(Double?.none)
                        ForEach(tank.gallons, id: \.self) { Text(String(format: "%.1f gal", $0)).tag(Double?.some($0)) }
                    }
                    .pickerStyle(.segmented)
                    sourceLinks(tank)
                } else {
                    TextField("Tank size in gallons", text: $tankText).keyboardType(.decimalPad)
                }
            } header: {
                Text("Fuel tank")
            } footer: {
                if v.tank == nil {
                    Text("Not in the verified list yet. Check the owner's manual. The planner works from the range on your dashboard either way.")
                } else if (v.tank?.gallons.count ?? 0) > 1 {
                    Text("This model came with different tanks. Pick yours.")
                }
            }
        }
        Section {
            Picker("Range from", selection: $basis) {
                Text(v.isElectric ? "Highway range" : "Highway MPG").tag(DriverVehicle.Basis.highway)
                Text(v.isElectric ? "Combined range" : "Combined MPG").tag(DriverVehicle.Basis.combined)
                Text("My own figure").tag(DriverVehicle.Basis.custom)
            }
            if basis == .custom {
                TextField(v.isElectric ? "Range in miles on a full charge" : "Your MPG", text: $customText).keyboardType(.decimalPad)
            }
        } footer: {
            Text("Used for the full tank or full charge range. Fuel stops use the range you enter from your dashboard.")
        }
    }

    private func sourceLinks(_ tank: VehicleCatalog.Tank) -> some View {
        HStack {
            Text(tank.basis == "manufacturer" ? "Verified: manufacturer" : "Verified: two sources").font(.caption).foregroundStyle(Theme.secondaryText)
            Spacer()
            ForEach(Array(tank.sources.prefix(2).enumerated()), id: \.offset) { i, s in
                if let url = URL(string: s) { Link("Source \(i + 1)", destination: url).font(.caption) }
            }
        }
    }

    private func load() async {
        guard catalog == nil else { return }
        do {
            // From the data set in use (a downloaded update may carry newer EPA data), else the app's own.
            let directory = app.dataInfo?.directory
            let loaded = try await Task.detached(priority: .userInitiated) { () throws -> VehicleCatalog in
                let candidates = [directory, DataLocation.bundled].compactMap { $0?.appendingPathComponent("vehicles.json") }
                guard let url = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
                    throw FeedError("The vehicle list is missing from the app.")
                }
                return try VehicleCatalog(contentsOf: url)
            }.value
            catalog = loaded
            if let v = settings.vehicle {
                // Restore the saved selection without the cascading resets below clearing it.
                restoring = true
                year = v.year
                make = v.make
                model = v.model
                let list = loaded.versions(year: v.year, make: v.make, model: v.model)
                versionIndex = list.firstIndex { $0.label == v.versionLabel } ?? -1
                basis = v.basis
                if v.tankIsVerified, versionIndex >= 0, (list[versionIndex].tank?.gallons.count ?? 0) > 1 {
                    pickedTank = v.tankGallons
                } else if !v.tankIsVerified, let t = v.tankGallons {
                    tankText = String(format: "%.1f", t)
                }
                customText = (v.isElectric ? v.customRangeMiles : v.customMilesPerGallon).map { String(format: "%.0f", $0) } ?? ""
                try? await Task.sleep(nanoseconds: 300_000_000)
                restoring = false
            }
        } catch {
            loadError = (error as? FeedError)?.message ?? error.localizedDescription
        }
    }

    private func save() {
        guard let version else { return }
        let entered = Double(tankText.replacingOccurrences(of: ",", with: "."))
        var v = DriverVehicle(year: year, make: make, model: model, version: version,
                              tankGallons: pickedTank ?? (version.tank == nil ? entered : nil))
        v.basis = basis
        let custom = Double(customText.replacingOccurrences(of: ",", with: "."))
        if version.isElectric { v.customRangeMiles = custom } else { v.customMilesPerGallon = custom }
        settings.vehicle = v
        dismiss()
    }
}
