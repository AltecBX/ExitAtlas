import ExitAtlasCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Environment(TripLibrary.self) private var library

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section("Voice") {
                    Toggle("Spoken announcements", isOn: $settings.voiceEnabled)
                    Toggle("State lines (5 mi warning and arrival)", isOn: $settings.announceStateLines).disabled(!settings.voiceEnabled)
                    Toggle("Fuel and charging stops", isOn: $settings.announceFuel).disabled(!settings.voiceEnabled)
                    Toggle("Each exit (1 mi before)", isOn: $settings.announceExits).disabled(!settings.voiceEnabled)
                    Toggle("Rest areas and service plazas (2 mi before)", isOn: $settings.announceRestAreas).disabled(!settings.voiceEnabled)
                    Toggle("Last gas before a long stretch", isOn: $settings.announceGasGaps).disabled(!settings.voiceEnabled)
                    Toggle("Time zone changes", isOn: $settings.announceTimeZones).disabled(!settings.voiceEnabled)
                }
                Section {
                    Toggle("Live Activity", isOn: $settings.liveActivityEnabled)
                        .onChange(of: settings.liveActivityEnabled) { trip.liveActivitySettingChanged() }
                    NavigationLink("Live Activity preview") { LiveActivityPreview() }
                    if let error = trip.liveActivity.lastError {
                        Text(error).font(.caption).foregroundStyle(Theme.amber)
                    }
                } header: {
                    Text("Lock Screen and CarPlay")
                } footer: {
                    Text("Shows the next exit, the next state line and your arrival time on the Lock Screen, in the Dynamic Island, on the CarPlay Dashboard and on Apple Watch. It starts when a trip starts, and iOS ends it after 8 hours; open ExitAtlas to start a new one.")
                }
                Section {
                    NavigationLink {
                        VehiclePickerView()
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(settings.vehicle?.title ?? "Choose your vehicle")
                            Text(vehicleSummary).font(.caption).foregroundStyle(Theme.secondaryText)
                        }
                    }
                    Picker("Fuel stop buffer", selection: $settings.bufferMiles) {
                        ForEach([25.0, 50.0, 75.0, 100.0], id: \.self) { Text("\(Int($0)) mi").tag($0) }
                    }
                    NavigationLink("Favorite gas brands (\(settings.favoriteBrands.count))") { FavoriteBrandsView() }
                    Picker("Flag stretches without gas over", selection: $settings.gasGapMiles) {
                        ForEach([25.0, 40.0, 60.0, 80.0], id: \.self) { Text("\(Int($0)) mi").tag($0) }
                    }
                } header: {
                    Text("Vehicle and fuel")
                } footer: {
                    Text("Fuel stops pick the last exit you reach with the buffer left, preferring your favorite brands anywhere in range. Stretches without gas count exits with a gas station listed and service plazas with gas.")
                }
                Section {
                    SecureField("Google Maps Platform key", text: $settings.googleKey)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    LabeledContent("Lookups this month", value: "\(PriceCallCounter.thisMonth)")
                } header: {
                    Text("Gas prices")
                } footer: {
                    Text("Optional. Prices per station near an exit from Google Maps (Places API New), billed to your own key after Google's monthly free allowance. One lookup per exit at most every 15 minutes. The key stays on this iPhone; prices are never stored.")
                }
                Section {
                    Toggle("Tesla Superchargers only", isOn: $settings.teslaOnlyChargers)
                    SecureField("NREL key (optional)", text: $settings.nrelKey)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } header: {
                    Text("Electric vehicles")
                } footer: {
                    Text("Charging stops from the U.S. Department of Energy. The built in demo key allows about 10 lookups an hour; a free key from developer.nlr.gov removes that limit.")
                }
                Section {
                    Stepper("Red when over by \(Int(settings.speedAlertOver)) mph", value: $settings.speedAlertOver, in: 0...20)
                } header: {
                    Text("Speedometer")
                } footer: {
                    Text("Posted limits come from OpenStreetMap and can be missing or out of date. Always follow the signs.")
                }
                Section("Places") {
                    LabeledContent("Home", value: library.home?.name ?? "Not set")
                    if library.home != nil { Button("Clear Home", role: .destructive) { library.setHome(nil) } }
                    Button("Clear recent places", role: .destructive) { library.clearRecentPlaces() }
                        .disabled(library.recentPlaces.isEmpty)
                }
                Section("Routing") {
                    Toggle("Avoid tolls", isOn: $settings.avoidTolls)
                }
                Section("Your trips") {
                    LabeledContent("Lifetime miles", value: Format.miles(library.lifetimeMeters))
                    NavigationLink { PassportView() } label: {
                        LabeledContent("Road Trip Passport", value: "\(library.lifetimeStates.count) states")
                    }
                    .accessibilityIdentifier("passportLink")
                    NavigationLink("Trip history") { HistoryView() }
                }
                Section("About the data") {
                    NavigationLink("Data sources and licenses") { DataSourcesView() }
                }
            }
            .navigationTitle("Settings")
        }
    }

    private var vehicleSummary: String {
        guard let v = settings.vehicle else { return "EPA fuel economy, tank size and EV range" }
        if v.isElectric { return "Electric · \(v.evRangeMiles) mi EPA range" }
        let tank = v.tankGallons.map { String(format: "%.1f gal tank", $0) } ?? "tank size not set"
        return "\(Int(v.milesPerGallon)) mpg · \(tank)"
    }
}

/// Favorite gas brands: common brands to tap, plus any brand typed in.
private struct FavoriteBrandsView: View {
    @Environment(UserSettings.self) private var settings
    @State private var custom = ""

    static let common = ["Shell", "Chevron", "BP", "Exxon", "Mobil", "Sunoco", "Speedway", "Valero", "Marathon", "Love's",
                         "Circle K", "Citgo", "QuikTrip", "Pilot", "Flying J", "76", "Phillips 66", "Arco", "7-Eleven", "Conoco",
                         "Sinclair", "Sheetz", "Wawa", "RaceTrac", "Buc-ee's", "Costco", "Sam's Club", "Murphy USA", "Casey's",
                         "Kwik Trip", "Texaco", "Gulf", "Maverik", "Kroger", "Holiday", "TA", "Royal Farms", "GetGo", "Thorntons", "Cenex"]

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Add a brand", text: $custom).autocorrectionDisabled()
                    Button("Add") {
                        let name = custom.trimmingCharacters(in: .whitespaces)
                        if !name.isEmpty, !settings.favoriteBrands.contains(name) { settings.favoriteBrands.append(name) }
                        custom = ""
                    }
                    .disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            Section("Common brands") {
                ForEach(Array(Set(Self.common + settings.favoriteBrands)).sorted(), id: \.self) { brand in
                    Button {
                        if let i = settings.favoriteBrands.firstIndex(of: brand) {
                            settings.favoriteBrands.remove(at: i)
                        } else {
                            settings.favoriteBrands.append(brand)
                        }
                    } label: {
                        HStack {
                            Text(brand).foregroundStyle(.primary)
                            Spacer()
                            if settings.favoriteBrands.contains(brand) { Image(systemName: "star.fill").foregroundStyle(Theme.amber) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Favorite Gas")
    }
}

private struct HistoryView: View {
    @Environment(TripLibrary.self) private var library

    var body: some View {
        List {
            if library.history.isEmpty {
                Text("Finished trips appear here with the miles you drove in each state.").foregroundStyle(Theme.secondaryText)
            }
            ForEach(library.history) { record in
                VStack(alignment: .leading, spacing: 4) {
                    Text(record.title).font(.subheadline.weight(.semibold))
                    Text("\(record.startedAt.formatted(date: .abbreviated, time: .omitted)) · \(Format.miles(record.totalMeters))")
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                    Text(record.states.map { "\($0.code ?? "—") \(Format.miles($0.meters))" }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
        }
        .navigationTitle("Trip History")
    }
}

/// Provenance, licenses and limits of every data source in the app.
struct DataSourcesView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        List {
            if let data = app.data {
                ForEach(data.sourceSummaries, id: \.title) { item in
                    Section(item.title) {
                        if let source = item.metadata.source { Text(source).font(.subheadline) }
                        if let license = item.metadata.license { LabeledContent("License", value: license) }
                        if let attribution = item.metadata.attribution { Text(attribution).font(.caption) }
                        if let built = item.metadata.generatedAt { LabeledContent("Built", value: built) }
                    }
                }
            }
            if let summary = app.data?.restAreaSummary {
                Section("Rest areas and service plazas") { Text(summary).font(.subheadline) }
            }
            if let summary = app.data?.discoverSummary {
                Section("Discover ahead") { Text(summary).font(.subheadline) }
            }
            Section("Maps and routes") {
                Text("Maps, routes and travel times: Apple Maps (MapKit). Route geometry is kept only for the active trip.")
                    .font(.subheadline)
            }
            Section("Live sources") {
                Text("Gas prices: Google Maps, only with your own key, shown with their update time and never stored. EV chargers: U.S. DOE Alternative Fuels Data Center. Posted speed limits: OpenStreetMap through the public Valhalla server.")
                    .font(.subheadline)
            }
            Section("Not live in this version") {
                Text("Hotel rates and availability, restaurant hours and ratings, traffic incidents and weather alerts need licensed or live sources and are not shown. ExitAtlas never displays estimated prices as real ones.")
                    .font(.subheadline)
            }
            Section("Open Database License") {
                Text("Exit and place data are derived from OpenStreetMap through OpenInterstate and are available under the Open Database License 1.0. The derived database in this app and the scripts that build it are published in the ExitAtlas repository (tools/data-pipeline).")
                    .font(.caption)
                Link("openstreetmap.org/copyright", destination: URL(string: "https://www.openstreetmap.org/copyright")!)
                Link("openinterstate.org", destination: URL(string: "https://openinterstate.org/")!)
            }
        }
        .navigationTitle("Data Sources")
    }
}

/// The Live Activity layouts with the current trip, as they appear on the Lock Screen and on the
/// CarPlay Dashboard or Apple Watch.
struct LiveActivityPreview: View {
    @Environment(TripController.self) private var trip

    var body: some View {
        List {
            if let snapshot = trip.snapshot {
                let content = trip.activityContent(for: snapshot, gasGap: trip.gasGapsAhead().first { ($0.before?.distance ?? 0) > snapshot.progress })
                Section("Lock Screen") {
                    DriveActivityLockScreenView(content: content, title: snapshot.highway.map { $0.ref.description } ?? "Trip")
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8))
                }
                Section("CarPlay Dashboard and Apple Watch") {
                    DriveActivitySmallView(content: content)
                        .frame(width: 170, alignment: .leading)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                Section {
                    Text("Same views as the Live Activity, drawn here with your current trip. The Live Activity itself updates when the next exit, state or rest area changes, and at most every 15 seconds for distances.")
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
            } else {
                Text("Start a trip or discovery mode to see the Live Activity with your drive.").foregroundStyle(Theme.secondaryText)
            }
        }
        .navigationTitle("Live Activity")
        .navigationBarTitleDisplayMode(.inline)
    }
}
