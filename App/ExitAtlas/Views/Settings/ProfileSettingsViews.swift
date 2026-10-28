import ExitAtlasCore
import SwiftUI
import UniformTypeIdentifiers

// Settings for the driver's profile: saved vehicles, fuel stop preferences, overnight driving, places,
// favorites, and the profile itself (where it is kept, export and import). Same choices as the website.

/// Other saved vehicles, switched with one tap; the one in use is shown by SettingsView above them.
struct OtherVehiclesRows: View {
    @Environment(UserSettings.self) private var settings

    var body: some View {
        ForEach(settings.otherVehicles, id: \.id) { v in
            Button {
                settings.vehicle = v
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(v.title).foregroundStyle(.primary)
                        Text(v.versionLabel).font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                    Spacer()
                    Text("Use").font(.subheadline.weight(.semibold))
                }
            }
            .swipeActions {
                Button("Remove", role: .destructive) { settings.vehicles.removeAll { $0.id == v.id } }
            }
        }
    }
}

/// Favorite brands in priority order and what a fuel stop must have.
struct FuelPreferencesView: View {
    @Environment(UserSettings.self) private var settings
    @State private var custom = ""

    static let common = ["Shell", "Chevron", "BP", "Exxon", "Mobil", "Sunoco", "Speedway", "Valero", "Marathon", "Love's",
                         "Circle K", "Citgo", "QuikTrip", "Pilot", "Flying J", "76", "Phillips 66", "Arco", "7-Eleven", "Conoco",
                         "Sinclair", "Sheetz", "Wawa", "RaceTrac", "Buc-ee's", "Costco", "Sam's Club", "Murphy USA", "Casey's",
                         "Kwik Trip", "Texaco", "Gulf", "Maverik", "Kroger", "Holiday", "TA", "Royal Farms", "GetGo", "Thorntons", "Cenex"]

    var body: some View {
        @Bindable var settings = settings
        List {
            Section {
                if settings.favoriteBrands.isEmpty {
                    Text("No favorite brands. Stops are chosen by distance, hours and restrooms.").foregroundStyle(Theme.secondaryText)
                }
                ForEach(Array(settings.favoriteBrands.enumerated()), id: \.element) { i, brand in
                    HStack {
                        Text("\(i + 1).").monospacedDigit().foregroundStyle(Theme.secondaryText)
                        Text(brand)
                    }
                }
                .onMove { settings.favoriteBrands.move(fromOffsets: $0, toOffset: $1) }
                .onDelete { settings.favoriteBrands.remove(atOffsets: $0) }
            } header: {
                Text("Favorite brands, in order")
            } footer: {
                Text("The first brand that fits your range, hours and restroom needs ranks first. Drag to reorder, swipe to remove.")
            }
            Section("Add a brand") {
                HStack {
                    TextField("Brand name", text: $custom).autocorrectionDisabled()
                    Button("Add") { add(custom); custom = "" }.disabled(custom.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                ForEach(Self.common.filter { b in !settings.favoriteBrands.contains { $0.caseInsensitiveCompare(b) == .orderedSame } }, id: \.self) { brand in
                    Button(brand) { add(brand) }
                }
            }
            Section {
                Picker("Fuel grade", selection: $settings.fuelGrade) {
                    Text("Vehicle's fuel").tag(String?.none)
                    Text("Regular").tag(String?.some("R"))
                    Text("Midgrade").tag(String?.some("M"))
                    Text("Premium").tag(String?.some("P"))
                    Text("Diesel").tag(String?.some("D"))
                }
                Picker("Open 24 hours", selection: $settings.require24Hours) { WhenOptions() }
                Picker("Restroom", selection: $settings.requireRestroom) { WhenOptions() }
                Picker("Longest detour", selection: $settings.maxDetourMinutes) {
                    ForEach([3.0, 5, 8, 12, 20], id: \.self) { Text("\(Int($0)) min").tag($0) }
                }
                Toggle("Cheaper fuel over favorite brands", isOn: $settings.priceOverBrand)
            } header: {
                Text("A good stop")
            } footer: {
                Text("Open 24 hours and Restroom prefer stops listed that way: overnight only, always, or never. Cheaper fuel applies only when live prices are available.")
            }
        }
        .navigationTitle("Fuel Stops")
        .toolbar { EditButton() }
    }

    private func add(_ name: String) {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty, !settings.favoriteBrands.contains(where: { $0.caseInsensitiveCompare(n) == .orderedSame }) else { return }
        settings.favoriteBrands.append(n)
    }
}

private struct WhenOptions: View {
    var body: some View {
        Text("Overnight").tag("overnight")
        Text("Always").tag("always")
        Text("Off").tag("off")
    }
}

/// Overnight Drive Mode: automatic in a local time window at the stop, or on or off by hand.
struct OvernightRows: View {
    @Environment(UserSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        Picker("Overnight Drive Mode", selection: $settings.overnightMode) {
            Text("Auto").tag("auto")
            Text("On").tag("on")
            Text("Off").tag("off")
        }
        .pickerStyle(.segmented)
        DatePicker("Starts at", selection: clock($settings.overnightStart), displayedComponents: .hourAndMinute)
            .disabled(settings.overnightMode != "auto")
        DatePicker("Ends at", selection: clock($settings.overnightEnd), displayedComponents: .hourAndMinute)
            .disabled(settings.overnightMode != "auto")
    }

    /// "HH:MM" as a Date for the picker (today's date; only the time is used).
    private func clock(_ text: Binding<String>) -> Binding<Date> {
        Binding {
            let parts = text.wrappedValue.split(separator: ":").compactMap { Int($0) }
            return Calendar.current.date(bySettingHour: parts.first ?? 0, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
        } set: { date in
            let c = Calendar.current.dateComponents([.hour, .minute], from: date)
            text.wrappedValue = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
    }
}

/// Home, saved places and recent places.
struct PlacesSettingsView: View {
    @Environment(UserSettings.self) private var settings

    var body: some View {
        List {
            Section("Home") {
                if let home = settings.home {
                    Text(home.name)
                        .swipeActions { Button("Clear", role: .destructive) { settings.home = nil } }
                } else {
                    Text("Not set. Choose Set as Home on any place when planning a trip.").foregroundStyle(Theme.secondaryText)
                }
            }
            Section {
                if settings.savedPlaces.isEmpty {
                    Text("Save places you return to from the recent list below.").foregroundStyle(Theme.secondaryText)
                }
                ForEach(settings.savedPlaces, id: \.self) { Text($0.name) }
                    .onDelete { settings.savedPlaces.remove(atOffsets: $0) }
            } header: {
                Text("Saved places")
            }
            Section {
                ForEach(settings.recentPlaces, id: \.self) { place in
                    HStack {
                        Text(place.name)
                        Spacer()
                        if !settings.savedPlaces.contains(where: { $0.name == place.name }) {
                            Button("Save") { settings.savePlace(place) }.buttonStyle(.borderless)
                        }
                    }
                }
                if !settings.recentPlaces.isEmpty {
                    Button("Clear recent places", role: .destructive) { settings.recentPlaces = [] }
                }
            } header: {
                Text("Recent")
            }
        }
        .navigationTitle("Places")
    }
}

/// Service categories shown first, and favorite hotel and restaurant brands.
struct FavoritesSettingsView: View {
    @Environment(UserSettings.self) private var settings
    @State private var hotel = ""
    @State private var restaurant = ""

    static let categories: [(String, String)] = [("gas", "Gas"), ("food", "Food"), ("lodging", "Lodging"),
                                                  ("evCharging", "EV charging"), ("restArea", "Rest areas"), ("travelCenter", "Travel centers")]

    var body: some View {
        @Bindable var settings = settings
        List {
            Section {
                ForEach(Self.categories, id: \.0) { key, name in
                    Toggle(name, isOn: Binding {
                        settings.favoriteCategories.contains(key)
                    } set: { on in
                        settings.favoriteCategories = on ? settings.favoriteCategories + [key] : settings.favoriteCategories.filter { $0 != key }
                    })
                }
            } header: {
                Text("Shown first")
            }
            brandSection("Hotel brands", list: $settings.favoriteHotels, entry: $hotel)
            brandSection("Restaurant brands", list: $settings.favoriteRestaurants, entry: $restaurant)
        }
        .navigationTitle("Favorites")
    }

    private func brandSection(_ title: String, list: Binding<[String]>, entry: Binding<String>) -> some View {
        Section(title) {
            ForEach(list.wrappedValue, id: \.self) { Text($0) }
                .onDelete { list.wrappedValue.remove(atOffsets: $0) }
            HStack {
                TextField("Add a brand", text: entry).autocorrectionDisabled()
                Button("Add") {
                    let n = entry.wrappedValue.trimmingCharacters(in: .whitespaces)
                    if !n.isEmpty, !list.wrappedValue.contains(where: { $0.caseInsensitiveCompare(n) == .orderedSame }) { list.wrappedValue.append(n) }
                    entry.wrappedValue = ""
                }
                .disabled(entry.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }
}

/// Where the profile is kept, whether the last change was saved, and export and import.
struct ProfileSection: View {
    @Environment(UserSettings.self) private var settings
    @Environment(TripLibrary.self) private var library
    @State private var importing = false
    @State private var message: String?

    var body: some View {
        Section {
            if let error = settings.status.saveError {
                Text("Not saved: \(error)").foregroundStyle(Theme.amber)
            } else {
                Text("Saved on this iPhone. Vehicles, favorite brands, places and preferences stay through trips, app updates and new data.")
                    .font(.footnote)
            }
            if !settings.status.problems.isEmpty {
                Text("\(settings.status.problems.count) saved setting\(settings.status.problems.count == 1 ? " was" : "s were") unreadable at launch and now use defaults (\(settings.status.problems.prefix(4).joined(separator: ", "))). The unreadable copy is kept.")
                    .font(.footnote).foregroundStyle(Theme.amber)
            }
            if let data = try? settings.exportData(plans: library.saved.map(\.plan)) {
                ShareLink(item: ProfileFile(data: data), preview: SharePreview("ExitAtlas profile")) {
                    Label("Export profile", systemImage: "square.and.arrow.up")
                }
            }
            Button { importing = true } label: { Label("Import profile", systemImage: "square.and.arrow.down") }
            if let message { Text(message).font(.footnote) }
        } header: {
            Text("Your profile")
        } footer: {
            Text("The website and this app keep separate profiles. Export here and import there (or the other way) to use the same one. The file includes saved trips; API keys are never included.")
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                let (problems, plans) = try settings.importProfile(Data(contentsOf: url))
                library.importPlans(plans)
                message = problems.isEmpty ? "Profile imported." : "Profile imported; \(problems.count) unreadable field(s) use defaults."
            } catch {
                message = error.localizedDescription
            }
        }
    }
}

/// The exported profile as a .json file for the share sheet.
struct ProfileFile: Transferable {
    let data: Data

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { $0.data }
            .suggestedFileName("exitatlas-profile.json")
    }
}
