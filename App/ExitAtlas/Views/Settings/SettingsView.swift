import ExitAtlasCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(UserSettings.self) private var settings
    @Environment(TripLibrary.self) private var library

    var body: some View {
        @Bindable var settings = settings
        NavigationStack {
            Form {
                Section("Voice") {
                    Toggle("Spoken announcements", isOn: $settings.voiceEnabled)
                    Toggle("State lines (5 mi warning and arrival)", isOn: $settings.announceStateLines).disabled(!settings.voiceEnabled)
                    Toggle("Each exit (1 mi before)", isOn: $settings.announceExits).disabled(!settings.voiceEnabled)
                }
                Section("Vehicle") {
                    Stepper("\(Int(settings.milesPerGallon)) mpg", value: $settings.milesPerGallon, in: 5...120)
                    Stepper("\(Int(settings.tankGallons)) gallon tank", value: $settings.tankGallons, in: 5...300)
                    Picker("Fuel", selection: $settings.fuelGrade) {
                        ForEach(FuelGrade.allCases, id: \.self) { Text($0.displayName).tag($0) }
                    }
                    TextField("Preferred brands, comma separated", text: $settings.preferredBrandsText)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                }
                Section("Routing") {
                    Toggle("Avoid tolls", isOn: $settings.avoidTolls)
                }
                Section("Your trips") {
                    LabeledContent("Lifetime miles", value: Format.miles(library.lifetimeMeters))
                    LabeledContent("States driven", value: "\(library.lifetimeStates.count)")
                    NavigationLink("Trip history") { HistoryView() }
                }
                Section("About the data") {
                    NavigationLink("Data sources and licenses") { DataSourcesView() }
                }
            }
            .navigationTitle("Settings")
        }
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
            Section("Maps and routes") {
                Text("Maps, routes and travel times: Apple Maps (MapKit). Route geometry is kept only for the active trip.")
                    .font(.subheadline)
            }
            Section("Not live in this version") {
                Text("Fuel prices, hotel rates and availability, restaurant hours and ratings, traffic incidents and weather alerts need licensed or live sources and are not shown. ExitAtlas never displays estimated prices as real ones.")
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
