import ExitAtlasCore
import Foundation
import Observation

/// User preferences, persisted in UserDefaults. API keys stay on this device.
@MainActor
@Observable
final class UserSettings {
    private let defaults = UserDefaults.standard

    var exitLookaheadMiles: Double { didSet { defaults.set(exitLookaheadMiles, forKey: "exitLookaheadMiles") } }
    var voiceEnabled: Bool { didSet { defaults.set(voiceEnabled, forKey: "voiceEnabled") } }
    var announceExits: Bool { didSet { defaults.set(announceExits, forKey: "announceExits") } }
    var announceStateLines: Bool { didSet { defaults.set(announceStateLines, forKey: "announceStateLines") } }
    var announceFuel: Bool { didSet { defaults.set(announceFuel, forKey: "announceFuel") } }
    var announceRestAreas: Bool { didSet { defaults.set(announceRestAreas, forKey: "announceRestAreas") } }
    var announceGasGaps: Bool { didSet { defaults.set(announceGasGaps, forKey: "announceGasGaps") } }
    var announceTimeZones: Bool { didSet { defaults.set(announceTimeZones, forKey: "announceTimeZones") } }
    /// Stretches without gas longer than this many miles are flagged on screen and spoken.
    var gasGapMiles: Double { didSet { defaults.set(gasGapMiles, forKey: "gasGapMiles") } }
    /// The drive on the Lock Screen, Dynamic Island, CarPlay Dashboard and Apple Watch.
    var liveActivityEnabled: Bool { didSet { defaults.set(liveActivityEnabled, forKey: "liveActivityEnabled") } }
    var avoidTolls: Bool { didSet { defaults.set(avoidTolls, forKey: "avoidTolls") } }

    /// The driver's car from the EPA list (nil until chosen).
    var vehicle: DriverVehicle? { didSet { store(vehicle, "vehicle") } }
    /// Miles of range to keep when choosing a fuel or charging stop.
    var bufferMiles: Double { didSet { defaults.set(bufferMiles, forKey: "bufferMiles") } }
    var favoriteBrands: [String] { didSet { store(favoriteBrands, "favoriteBrands") } }
    /// Google Maps Platform key for gas prices (Places API New). Empty means prices are off.
    var googleKey: String { didSet { defaults.set(googleKey, forKey: "googleKey") } }
    /// NREL developer key for the charger search; empty uses the demo key (10 an hour).
    var nrelKey: String { didSet { defaults.set(nrelKey, forKey: "nrelKey") } }
    var teslaOnlyChargers: Bool { didSet { defaults.set(teslaOnlyChargers, forKey: "teslaOnlyChargers") } }
    /// Red speedometer when over the posted limit by more than this (amber up to it).
    var speedAlertOver: Double { didSet { defaults.set(speedAlertOver, forKey: "speedAlertOver") } }

    init() {
        defaults.register(defaults: [
            "exitLookaheadMiles": 25.0, "voiceEnabled": true, "announceExits": false, "announceStateLines": true,
            "announceFuel": true, "avoidTolls": false, "bufferMiles": 50.0, "googleKey": "", "nrelKey": "",
            "teslaOnlyChargers": true, "speedAlertOver": 5.0,
            "announceRestAreas": true, "announceGasGaps": true, "announceTimeZones": true, "gasGapMiles": 40.0,
            "liveActivityEnabled": true,
        ])
        exitLookaheadMiles = defaults.double(forKey: "exitLookaheadMiles")
        voiceEnabled = defaults.bool(forKey: "voiceEnabled")
        announceExits = defaults.bool(forKey: "announceExits")
        announceStateLines = defaults.bool(forKey: "announceStateLines")
        announceFuel = defaults.bool(forKey: "announceFuel")
        announceRestAreas = defaults.bool(forKey: "announceRestAreas")
        announceGasGaps = defaults.bool(forKey: "announceGasGaps")
        announceTimeZones = defaults.bool(forKey: "announceTimeZones")
        gasGapMiles = defaults.double(forKey: "gasGapMiles")
        liveActivityEnabled = defaults.bool(forKey: "liveActivityEnabled")
        avoidTolls = defaults.bool(forKey: "avoidTolls")
        vehicle = Self.load("vehicle", from: defaults)
        bufferMiles = defaults.double(forKey: "bufferMiles")
        googleKey = defaults.string(forKey: "googleKey") ?? ""
        nrelKey = defaults.string(forKey: "nrelKey") ?? ""
        teslaOnlyChargers = defaults.bool(forKey: "teslaOnlyChargers")
        speedAlertOver = defaults.double(forKey: "speedAlertOver")
        // Earlier versions kept favorite brands as comma separated text.
        favoriteBrands = Self.load("favoriteBrands", from: defaults)
            ?? (defaults.string(forKey: "preferredBrands") ?? "").split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    var gasGrade: GasPriceFeed.Grade { GasPriceFeed.Grade(vehicle?.fuel ?? .regular) }

    private func store<T: Encodable>(_ value: T?, _ key: String) {
        if let value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    private static func load<T: Decodable>(_ key: String, from defaults: UserDefaults) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}
