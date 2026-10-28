import ExitAtlasCore
import Foundation
import Observation

/// User preferences, persisted in UserDefaults.
@MainActor
@Observable
final class UserSettings {
    private let defaults = UserDefaults.standard

    var exitLookaheadMiles: Double { didSet { defaults.set(exitLookaheadMiles, forKey: "exitLookaheadMiles") } }
    var voiceEnabled: Bool { didSet { defaults.set(voiceEnabled, forKey: "voiceEnabled") } }
    var announceExits: Bool { didSet { defaults.set(announceExits, forKey: "announceExits") } }
    var announceStateLines: Bool { didSet { defaults.set(announceStateLines, forKey: "announceStateLines") } }
    var avoidTolls: Bool { didSet { defaults.set(avoidTolls, forKey: "avoidTolls") } }
    var milesPerGallon: Double { didSet { defaults.set(milesPerGallon, forKey: "mpg") } }
    var tankGallons: Double { didSet { defaults.set(tankGallons, forKey: "tankGallons") } }
    var fuelGrade: FuelGrade { didSet { defaults.set(fuelGrade.rawValue, forKey: "fuelGrade") } }
    var preferredBrandsText: String { didSet { defaults.set(preferredBrandsText, forKey: "preferredBrands") } }

    init() {
        defaults.register(defaults: [
            "exitLookaheadMiles": 25.0, "voiceEnabled": true, "announceExits": false, "announceStateLines": true,
            "avoidTolls": false, "mpg": 25.0, "tankGallons": 15.0, "fuelGrade": FuelGrade.regular.rawValue,
            "preferredBrands": "",
        ])
        exitLookaheadMiles = defaults.double(forKey: "exitLookaheadMiles")
        voiceEnabled = defaults.bool(forKey: "voiceEnabled")
        announceExits = defaults.bool(forKey: "announceExits")
        announceStateLines = defaults.bool(forKey: "announceStateLines")
        avoidTolls = defaults.bool(forKey: "avoidTolls")
        milesPerGallon = defaults.double(forKey: "mpg")
        tankGallons = defaults.double(forKey: "tankGallons")
        fuelGrade = FuelGrade(rawValue: defaults.string(forKey: "fuelGrade") ?? "") ?? .regular
        preferredBrandsText = defaults.string(forKey: "preferredBrands") ?? ""
    }

    var vehicle: VehicleProfile {
        VehicleProfile(milesPerGallon: max(milesPerGallon, 1), tankGallons: max(tankGallons, 1), reserveGallons: 2,
                       grade: fuelGrade,
                       preferredBrands: preferredBrandsText.split(separator: ",")
                           .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { !$0.isEmpty })
    }
}
