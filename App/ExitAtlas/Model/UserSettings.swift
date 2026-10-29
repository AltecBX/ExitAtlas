import ExitAtlasCore
import Foundation
import Observation

/// The driver's profile (vehicles, fuel and overnight preferences, places, display and voice), kept in
/// Application Support/Profile/profile.json by ProfileStore and saved on every change. The format, checks
/// and migrations are shared with the website (ExitAtlasCore/Profile). API keys are in the Keychain.
/// Demos and UI tests (-demoTrip) use a throwaway profile and in-memory keys, never the real ones.
@MainActor
@Observable
final class UserSettings {
    struct Status: Equatable {
        var source: ProfileStore.Source
        /// Fields that could not be read at launch and now hold their defaults.
        var problems: [String]
        /// The last save's error; nil when the last change was written and read back.
        var saveError: String?
        var savedAt: Date?
    }

    @ObservationIgnored private let store: ProfileStore
    @ObservationIgnored private let keychain: KeychainStore
    @ObservationIgnored private var profile: JSONValue
    @ObservationIgnored private var loading = true
    private(set) var status: Status

    // Vehicles: every saved vehicle, and the one in use.
    var vehicles: [DriverVehicle] { didSet { save() } }
    var defaultVehicleID: String? { didSet { save() } }

    // Fuel and stops
    var favoriteBrands: [String] { didSet { save() } }
    /// Fuel grade for prices ("R", "M", "P", "D"); nil follows the vehicle.
    var fuelGrade: String? { didSet { save() } }
    /// Miles of range to keep when choosing a fuel or charging stop.
    var bufferMiles: Double { didSet { save() } }
    var maxDetourMinutes: Double { didSet { save() } }
    var require24Hours: String { didSet { save() } }
    var requireRestroom: String { didSet { save() } }
    var priceOverBrand: Bool { didSet { save() } }
    var teslaOnlyChargers: Bool { didSet { save() } }
    var overnightMode: String { didSet { save() } }
    var overnightStart: String { didSet { save() } }
    var overnightEnd: String { didSet { save() } }

    // Places
    var home: Waypoint? { didSet { save() } }
    var savedPlaces: [Waypoint] { didSet { save() } }
    var recentPlaces: [Waypoint] { didSet { save() } }
    var favoriteHotels: [String] { didSet { save() } }
    var favoriteRestaurants: [String] { didSet { save() } }
    var favoriteCategories: [String] { didSet { save() } }

    // Driving and display
    var exitLookaheadMiles: Double { didSet { save() } }
    /// Stretches without gas longer than this many miles are flagged on screen and spoken.
    var gasGapMiles: Double { didSet { save() } }
    /// Red speedometer when over the posted limit by more than this (amber up to it).
    var speedAlertOver: Double { didSet { save() } }
    var avoidTolls: Bool { didSet { save() } }
    /// The drive on the Lock Screen, Dynamic Island, CarPlay Dashboard and Apple Watch.
    var liveActivityEnabled: Bool { didSet { save() } }
    var keepAwake: Bool { didSet { save() } }
    /// "auto", "light" or "dark".
    var theme: String { didSet { save() } }
    /// The Drive screen: "map" (Navigation View) or "focus" (the compact dashboard).
    var drivePresentation: String { didSet { save() } }

    // Voice
    var voiceEnabled: Bool { didSet { save() } }
    var announceStateLines: Bool { didSet { save() } }
    var announceExits: Bool { didSet { save() } }
    var announceFuel: Bool { didSet { save() } }
    var announceRestAreas: Bool { didSet { save() } }
    var announceGasGaps: Bool { didSet { save() } }
    var announceTimeZones: Bool { didSet { save() } }
    /// Road alert groups switched on (RoadIntel.Group raw values) and whether alerts are spoken.
    var alertGroups: [String: Bool] { didSet { save() } }
    var announceAlerts: Bool { didSet { save() } }

    /// Google Maps Platform key for gas prices (Places API New). Empty means prices are off. Keychain.
    var googleKey: String { didSet { keychain.set(googleKey, for: "googleKey") } }
    /// NREL developer key for the charger search; empty uses the demo key (10 an hour). Keychain.
    var nrelKey: String { didSet { keychain.set(nrelKey, for: "nrelKey") } }

    init(demo: Bool = ProcessInfo.processInfo.arguments.contains("-demoTrip")) {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        store = ProfileStore(directory: demo ? fm.temporaryDirectory.appendingPathComponent("DemoProfile-\(UUID().uuidString)")
                                             : support.appendingPathComponent("Profile", isDirectory: true))
        let keys: KeychainStore = demo ? .memory() : .shared
        keychain = keys
        let loaded = store.load { demo ? nil : Self.versionOneProfile(support: support) }
        profile = loaded.profile
        status = Status(source: loaded.source, problems: loaded.problems, saveError: loaded.writeError, savedAt: nil)

        let s = ProfileSettings(profile: loaded.profile)
        vehicles = s.vehicles
        defaultVehicleID = s.defaultVehicleID
        favoriteBrands = s.favoriteBrands
        fuelGrade = s.fuelGrade
        bufferMiles = s.reserveMiles
        maxDetourMinutes = s.maxDetourMinutes
        require24Hours = s.require24Hours
        requireRestroom = s.requireRestroom
        priceOverBrand = s.priceOverBrand
        teslaOnlyChargers = s.teslaOnlyChargers
        overnightMode = s.overnightMode
        overnightStart = s.overnightStart
        overnightEnd = s.overnightEnd
        home = s.home
        savedPlaces = s.savedPlaces
        recentPlaces = s.recentPlaces
        favoriteHotels = s.favoriteHotels
        favoriteRestaurants = s.favoriteRestaurants
        favoriteCategories = s.favoriteCategories
        exitLookaheadMiles = s.exitLookaheadMiles
        gasGapMiles = s.gasGapMiles
        speedAlertOver = s.speedAlertOver
        avoidTolls = s.avoidTolls
        liveActivityEnabled = s.liveActivityEnabled
        keepAwake = s.keepAwake
        theme = s.theme
        drivePresentation = s.drivePresentation
        voiceEnabled = s.voiceEnabled
        announceStateLines = s.announceStateLines
        announceExits = s.announceExits
        announceFuel = s.announceFuel
        announceRestAreas = s.announceRestAreas
        announceGasGaps = s.announceGasGaps
        announceTimeZones = s.announceTimeZones
        alertGroups = s.alertGroups
        announceAlerts = s.announceAlerts
        // A local, not self.keychain: self is not fully initialized until the keys are set.
        if !demo { Self.moveKeysToKeychain(keys) }
        googleKey = keys.get("googleKey") ?? ""
        nrelKey = keys.get("nrelKey") ?? ""
        loading = false
    }

    /// The vehicle that plans fuel stops. Setting it saves it among the driver's vehicles (replacing the
    /// same vehicle, so a new tank size or MPG choice sticks) and makes it the one in use.
    var vehicle: DriverVehicle? {
        get { vehicles.first { $0.id == defaultVehicleID } }
        set {
            guard var v = newValue else { defaultVehicleID = nil; return }
            // The same car chosen again (same id, or same EPA id) replaces the saved one and keeps its id.
            if let match = vehicles.first(where: { $0.id == v.id || ($0.epaID != nil && $0.epaID == v.epaID) }), match.id != v.id {
                v.profileID = match.id
            }
            loading = true
            vehicles = [v] + vehicles.filter { $0.id != v.id }.prefix(9)
            defaultVehicleID = v.id
            loading = false
            save()
        }
    }

    /// Saved vehicles other than the one in use.
    var otherVehicles: [DriverVehicle] { vehicles.filter { $0.id != defaultVehicleID } }

    var gasGrade: GasPriceFeed.Grade {
        if let g = fuelGrade.flatMap(VehicleCatalog.Fuel.init(rawValue:)) { return GasPriceFeed.Grade(g) }
        return GasPriceFeed.Grade(vehicle?.fuel ?? .regular)
    }

    /// The values as the shared profile type.
    var values: ProfileSettings {
        var s = ProfileSettings()
        s.vehicles = vehicles
        s.defaultVehicleID = defaultVehicleID
        s.favoriteBrands = favoriteBrands
        s.fuelGrade = fuelGrade
        s.reserveMiles = bufferMiles
        s.maxDetourMinutes = maxDetourMinutes
        s.require24Hours = require24Hours
        s.requireRestroom = requireRestroom
        s.priceOverBrand = priceOverBrand
        s.teslaOnlyChargers = teslaOnlyChargers
        s.overnightMode = overnightMode
        s.overnightStart = overnightStart
        s.overnightEnd = overnightEnd
        s.home = home
        s.savedPlaces = savedPlaces
        s.recentPlaces = recentPlaces
        s.favoriteHotels = favoriteHotels
        s.favoriteRestaurants = favoriteRestaurants
        s.favoriteCategories = favoriteCategories
        s.exitLookaheadMiles = exitLookaheadMiles
        s.gasGapMiles = gasGapMiles
        s.speedAlertOver = speedAlertOver
        s.avoidTolls = avoidTolls
        s.liveActivityEnabled = liveActivityEnabled
        s.keepAwake = keepAwake
        s.theme = theme
        s.drivePresentation = drivePresentation
        s.voiceEnabled = voiceEnabled
        s.announceStateLines = announceStateLines
        s.announceExits = announceExits
        s.announceFuel = announceFuel
        s.announceRestAreas = announceRestAreas
        s.announceGasGaps = announceGasGaps
        s.announceTimeZones = announceTimeZones
        s.alertGroups = alertGroups
        s.announceAlerts = announceAlerts
        return s
    }

    private func save() {
        guard !loading else { return }
        profile = values.applied(to: profile)
        status.saveError = store.write(profile)
        if status.saveError == nil { status.savedAt = Date() }
    }

    // MARK: Places

    func recordPlace(_ place: Waypoint) {
        guard place.name != "Current location" else { return }
        var list = recentPlaces.filter { !($0 == place || ($0.name == place.name && Geodesy.distance($0.coordinate, place.coordinate) < 100)) }
        list.insert(place, at: 0)
        recentPlaces = Array(list.prefix(10))
    }

    func savePlace(_ place: Waypoint) {
        savedPlaces = [place] + savedPlaces.filter { $0.name != place.name || Geodesy.distance($0.coordinate, place.coordinate) >= 100 }.prefix(49)
    }

    // MARK: Export and import (same file as the website; no API keys)

    /// The profile file, with the saved trips as plans.
    func exportData(plans: [SavedPlan]) throws -> Data { try ProfileStore.export(SavedPlan.profile(profile, withPlans: plans)) }

    /// Replaces this device's profile with an exported one. Returns the fields that could not be read and
    /// the file's trip plans (kept as saved trips, not in the profile).
    func importProfile(_ data: Data) throws -> (problems: [String], plans: [SavedPlan]) {
        let (imported, problems) = try ProfileStore.importProfile(data)
        let s = ProfileSettings(profile: imported)
        let plans = SavedPlan.plans(in: imported)
        loading = true
        profile = SavedPlan.profile(imported, withPlans: [])
        vehicles = s.vehicles
        defaultVehicleID = s.defaultVehicleID
        favoriteBrands = s.favoriteBrands
        fuelGrade = s.fuelGrade
        bufferMiles = s.reserveMiles
        maxDetourMinutes = s.maxDetourMinutes
        require24Hours = s.require24Hours
        requireRestroom = s.requireRestroom
        priceOverBrand = s.priceOverBrand
        teslaOnlyChargers = s.teslaOnlyChargers
        overnightMode = s.overnightMode
        overnightStart = s.overnightStart
        overnightEnd = s.overnightEnd
        home = s.home
        savedPlaces = s.savedPlaces
        recentPlaces = s.recentPlaces
        favoriteHotels = s.favoriteHotels
        favoriteRestaurants = s.favoriteRestaurants
        favoriteCategories = s.favoriteCategories
        exitLookaheadMiles = s.exitLookaheadMiles
        gasGapMiles = s.gasGapMiles
        speedAlertOver = s.speedAlertOver
        avoidTolls = s.avoidTolls
        liveActivityEnabled = s.liveActivityEnabled
        keepAwake = s.keepAwake
        theme = s.theme
        drivePresentation = s.drivePresentation
        voiceEnabled = s.voiceEnabled
        announceStateLines = s.announceStateLines
        announceExits = s.announceExits
        announceFuel = s.announceFuel
        announceRestAreas = s.announceRestAreas
        announceGasGaps = s.announceGasGaps
        announceTimeZones = s.announceTimeZones
        alertGroups = s.alertGroups
        announceAlerts = s.announceAlerts
        loading = false
        save()
        return (problems, plans)
    }

    // MARK: Migration from version one (UserDefaults keys and Trips/places.json)

    private static let versionOneKeys = [
        "exitLookaheadMiles", "voiceEnabled", "announceExits", "announceStateLines", "announceFuel", "announceRestAreas",
        "announceGasGaps", "announceTimeZones", "gasGapMiles", "liveActivityEnabled", "avoidTolls", "bufferMiles",
        "teslaOnlyChargers", "speedAlertOver", "vehicle", "favoriteBrands", "preferredBrands",
    ]

    /// The profile from the older storage, or nil for a new install. The old keys are left in place.
    private static func versionOneProfile(support: URL) -> JSONValue? {
        let d = UserDefaults.standard
        var v1: [String: JSONValue] = [:]
        for key in versionOneKeys {
            switch d.object(forKey: key) {
            case let data as Data: if let j = try? JSONValue(data: data) { v1[key] = j }
            case let s as String: v1[key] = .string(s)
            case let n as NSNumber:
                v1[key] = CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
            default: break
            }
        }
        let placesFile = support.appendingPathComponent("Trips/places.json")
        let places = (try? Data(contentsOf: placesFile)).flatMap { try? JSONValue(data: $0) }
        guard !v1.isEmpty || places != nil else { return nil }
        return ProfileRules.migrateIOSV1(defaults: v1, places: places)
    }

    /// Moves API keys from UserDefaults (version one) into the Keychain; the old copy is removed only
    /// after the Keychain holds the key.
    private static func moveKeysToKeychain(_ keychain: KeychainStore) {
        let d = UserDefaults.standard
        for account in ["googleKey", "nrelKey"] {
            guard let old = d.string(forKey: account) else { continue }
            if !old.isEmpty, keychain.get(account) == nil { keychain.set(old, for: account) }
            if old.isEmpty || keychain.get(account) != nil { d.removeObject(forKey: account) }
        }
    }
}
