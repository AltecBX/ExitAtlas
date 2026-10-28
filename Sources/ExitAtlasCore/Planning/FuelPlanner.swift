import Foundation

public enum FuelGrade: String, Sendable, Codable, CaseIterable, Hashable {
    case regular, midgrade, premium, diesel, e85

    public var displayName: String {
        switch self {
        case .regular: return "Regular"
        case .midgrade: return "Midgrade"
        case .premium: return "Premium"
        case .diesel: return "Diesel"
        case .e85: return "E85"
        }
    }
}

/// One price reading from a licensed provider. Never synthesized by the app.
public struct FuelPriceObservation: Sendable, Codable, Hashable {
    public let placeID: String
    public let grade: FuelGrade
    public let pricePerGallon: Double
    /// When the provider says the price was observed or last updated.
    public let observedAt: Date
    /// Provider name shown next to the price ("OPIS", "iExit", "Entered by you").
    public let source: String

    public init(placeID: String, grade: FuelGrade, pricePerGallon: Double, observedAt: Date, source: String) {
        self.placeID = placeID
        self.grade = grade
        self.pricePerGallon = pricePerGallon
        self.observedAt = observedAt
        self.source = source
    }
}

public struct VehicleProfile: Sendable, Codable, Hashable {
    public var milesPerGallon: Double
    public var tankGallons: Double
    /// Fuel the driver never wants to drop below.
    public var reserveGallons: Double
    public var grade: FuelGrade
    /// Lowercased brand names; empty means any brand.
    public var preferredBrands: [String]

    public init(milesPerGallon: Double, tankGallons: Double, reserveGallons: Double = 2,
                grade: FuelGrade = .regular, preferredBrands: [String] = []) {
        self.milesPerGallon = milesPerGallon
        self.tankGallons = tankGallons
        self.reserveGallons = reserveGallons
        self.grade = grade
        self.preferredBrands = preferredBrands
    }

    public var metersPerGallon: Double { milesPerGallon * Geodesy.metersPerMile }
}

/// How old a price is. Prices are never labeled live.
public enum PriceFreshness: String, Sendable, Codable {
    case recent  // under 6 hours
    case today  // under 24 hours
    case stale  // 24 hours or more

    public init(age: TimeInterval) {
        self = age < 6 * 3600 ? .recent : (age < 24 * 3600 ? .today : .stale)
    }
}

/// A gas station ahead with the full cost of choosing it.
public struct FuelOption: Sendable, Identifiable {
    public let exit: UpcomingExit
    public let service: ExitService
    public let price: FuelPriceObservation?
    public let freshness: PriceFreshness?
    /// Can be reached with current fuel, keeping the reserve, including the detour to it.
    public let reachable: Bool
    /// Gallons bought to fill the tank on arrival.
    public let fillGallons: Double
    /// Extra fuel burned by the detour (round trip off the highway).
    public let detourGallons: Double
    /// Extra driving time for the detour, when the data has it.
    public let detourSeconds: TimeInterval?
    /// Fill cost plus the cost of the detour fuel, at this station's price.
    public let effectiveCost: Double?
    /// Effective cost divided by gallons put in the tank.
    public let effectivePricePerGallon: Double?
    public let matchesPreferredBrand: Bool

    public var id: String { service.id }
}

public struct FuelPlan: Sendable {
    public let options: [FuelOption]
    /// Cheapest posted price among reachable stations with a price under `maxPriceAge`.
    public let cheapestPrice: FuelOption?
    /// Lowest effective cost (price plus detour) among reachable stations.
    public let bestValue: FuelOption?
    /// Savings of `bestValue` against the nearest reachable priced station, in dollars.
    public let savingsVersusNearest: Double?
    /// Reachable stations ahead with no verified price.
    public let unpricedReachableCount: Int
}

/// Compares fuel stops ahead using only verified price observations.
public struct FuelPlanner: Sendable {
    public var maxPriceAge: TimeInterval = 48 * 3600

    public init() {}

    /// - Parameters:
    ///   - fuelGallons: fuel in the tank now.
    ///   - window: only stations within this many meters ahead (nil means 1.5 times the usable range, at least 50 miles).
    public func plan(snapshot: TripSnapshot, plan: TripPlan, dataset: InterstateDataset,
                     vehicle: VehicleProfile, fuelGallons: Double,
                     prices: [String: [FuelPriceObservation]], window: Double? = nil, now: Date) -> FuelPlan {
        let usableMeters = max(0, fuelGallons - vehicle.reserveGallons) * vehicle.metersPerGallon
        // At or below the reserve nothing is "reachable", but the nearest stations still matter most,
        // so the search always covers at least 50 miles.
        let horizon = min(window ?? max(usableMeters * 1.5, 50 * Geodesy.metersPerMile), 500 * Geodesy.metersPerMile)
        let d = snapshot.progress
        var options: [FuelOption] = []
        for exit in plan.exits(after: d, upTo: d + horizon) {
            let ahead = exit.distanceAlongRoute - d
            let upcoming = UpcomingExit(exit: exit, distance: ahead, eta: snapshot.eta, stateCode: nil)
            for service in dataset.services(for: exit) where service.place.category == .gas {
                let oneWayDetour = service.detourMeters / 2
                let reachable = ahead + oneWayDetour <= usableMeters
                let gallonsUsedToArrive = (ahead + oneWayDetour) / vehicle.metersPerGallon
                let fill = max(0, vehicle.tankGallons - (fuelGallons - gallonsUsedToArrive))
                let detourGallons = service.detourMeters / vehicle.metersPerGallon
                let observation = prices[service.place.id]?
                    .filter { $0.grade == vehicle.grade && now.timeIntervalSince($0.observedAt) <= maxPriceAge }
                    .max { $0.observedAt < $1.observedAt }
                var effective: Double?
                var effectivePerGallon: Double?
                if let p = observation?.pricePerGallon, fill > 0 {
                    effective = (fill + detourGallons) * p
                    effectivePerGallon = effective! / fill
                }
                let brand = (service.place.brand.isEmpty ? service.place.name : service.place.brand).lowercased()
                options.append(FuelOption(
                    exit: upcoming, service: service, price: observation,
                    freshness: observation.map { PriceFreshness(age: now.timeIntervalSince($0.observedAt)) },
                    reachable: reachable, fillGallons: fill, detourGallons: detourGallons,
                    detourSeconds: service.detourSeconds, effectiveCost: effective,
                    effectivePricePerGallon: effectivePerGallon,
                    matchesPreferredBrand: vehicle.preferredBrands.isEmpty
                        || vehicle.preferredBrands.contains { brand.contains($0.lowercased()) }))
            }
        }
        let priced = options.filter { $0.reachable && $0.price != nil && $0.matchesPreferredBrand }
        let cheapest = priced.min { $0.price!.pricePerGallon < $1.price!.pricePerGallon }
        let best = priced.min { ($0.effectivePricePerGallon ?? .infinity) < ($1.effectivePricePerGallon ?? .infinity) }
        let nearest = priced.min { $0.exit.distance < $1.exit.distance }
        var savings: Double?
        if let best, let nearest, let b = best.effectivePricePerGallon, let n = nearest.effectivePricePerGallon {
            savings = max(0, (n - b) * best.fillGallons)
        }
        let unpriced = options.filter { $0.reachable && $0.price == nil }.count
        return FuelPlan(options: options, cheapestPrice: cheapest, bestValue: best,
                        savingsVersusNearest: savings, unpricedReachableCount: unpriced)
    }
}
