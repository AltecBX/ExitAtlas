import Foundation

/// EPA fuel economy for every vehicle since 2000 with verified tank sizes (`vehicles.json`, built by
/// tools/data-pipeline/build_vehicles.py; the web version reads the same file).
public struct VehicleCatalog: Sendable {
    public struct Tank: Sendable, Hashable, Codable {
        /// One value, or several when the model was sold with different tanks (the driver picks).
        public let gallons: [Double]
        public let sources: [String]
        /// "manufacturer" or "two-sources".
        public let basis: String
    }

    public enum Fuel: String, Sendable, Codable {
        case regular = "R", midgrade = "M", premium = "P", diesel = "D", electric = "E"
    }

    /// One EPA version of a model (engine, transmission, drive).
    public struct Version: Sendable, Hashable {
        public let label: String
        /// EPA city, highway and combined MPG (MPGe for electric vehicles).
        public let city: Int
        public let highway: Int
        public let combined: Int
        public let epaID: Int
        public let tank: Tank?
        public let fuel: Fuel
        /// EPA range for electric vehicles, combined and highway (0 when not rated).
        public let evRangeMiles: Int
        public let evRangeHighwayMiles: Int

        public var isElectric: Bool { fuel == .electric }
    }

    public let sourceSHA256: String
    public let versionsWithTank: Int
    private let tanks: [Tank]
    private let years: [String: [String: [String: [Row]]]]

    struct Row: Decodable {
        let label: String, city: Int, highway: Int, combined: Int, epaID: Int, tankIndex: Int, fuel: String
        let evRange: Int, evRangeHighway: Int

        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            label = try c.decode(String.self)
            city = try c.decode(Int.self)
            highway = try c.decode(Int.self)
            combined = try c.decode(Int.self)
            epaID = try c.decode(Int.self)
            tankIndex = try c.decode(Int.self)
            fuel = try c.decode(String.self)
            evRange = c.isAtEnd ? 0 : try c.decode(Int.self)
            evRangeHighway = c.isAtEnd ? 0 : try c.decode(Int.self)
        }
    }

    struct File: Decodable {
        struct Meta: Decodable {
            let source_sha256: String
            let versions_with_tank: Int
        }
        let meta: Meta
        let tanks: [Tank]
        let years: [String: [String: [String: [Row]]]]
    }

    public init(data: Data) throws {
        let file = try JSONDecoder().decode(File.self, from: data)
        sourceSHA256 = file.meta.source_sha256
        versionsWithTank = file.meta.versions_with_tank
        tanks = file.tanks
        years = file.years
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url))
    }

    /// Model years, newest first.
    public var modelYears: [Int] { years.keys.compactMap(Int.init).sorted(by: >) }

    public func makes(year: Int) -> [String] {
        (years[String(year)] ?? [:]).keys.sorted()
    }

    public func models(year: Int, make: String) -> [String] {
        (years[String(year)]?[make] ?? [:]).keys.sorted()
    }

    public func versions(year: Int, make: String, model: String) -> [Version] {
        (years[String(year)]?[make]?[model] ?? []).map { r in
            Version(label: r.label, city: r.city, highway: r.highway, combined: r.combined, epaID: r.epaID,
                    tank: r.tankIndex >= 0 && r.tankIndex < tanks.count ? tanks[r.tankIndex] : nil,
                    fuel: Fuel(rawValue: r.fuel) ?? .regular, evRangeMiles: r.evRange, evRangeHighwayMiles: r.evRangeHighway)
        }
    }
}

/// The driver's vehicle and how range is computed (EPA highway, combined, or the driver's own figure).
public struct DriverVehicle: Sendable, Codable, Hashable {
    public enum Basis: String, Sendable, Codable, CaseIterable {
        case highway, combined, custom
    }

    public var year: Int
    public var make: String
    public var model: String
    public var versionLabel: String
    public var city: Int
    public var highway: Int
    public var combined: Int
    public var fuel: VehicleCatalog.Fuel
    /// Verified or entered tank size; nil until known.
    public var tankGallons: Double?
    public var tankIsVerified: Bool
    public var evRangeMiles: Int
    public var evRangeHighwayMiles: Int
    public var basis: Basis = .highway
    public var customMilesPerGallon: Double?
    public var customRangeMiles: Double?
    /// EPA vehicle id, for vehicles chosen from the EPA list (nil for ones saved before it was kept).
    public var epaID: Int? = nil
    /// The id in the driver's profile when it differs from the one formed from year, make, model and version.
    public var profileID: String? = nil
    /// Identifies the vehicle among the driver's saved vehicles, the same on iOS and the web.
    public var id: String { profileID ?? ProfileRules.vehicleId(year: year, make: make, model: model, version: versionLabel) }

    public init(year: Int, make: String, model: String, version: VehicleCatalog.Version, tankGallons: Double? = nil) {
        self.year = year
        self.make = make
        self.model = model
        versionLabel = version.label
        city = version.city
        highway = version.highway
        combined = version.combined
        fuel = version.fuel
        let verified = version.tank?.gallons.count == 1 ? version.tank?.gallons.first : nil
        self.tankGallons = tankGallons ?? verified
        tankIsVerified = tankGallons == nil ? verified != nil : version.tank?.gallons.contains(tankGallons!) == true
        evRangeMiles = version.evRangeMiles
        evRangeHighwayMiles = version.evRangeHighwayMiles
        epaID = version.epaID
    }

    /// A vehicle from the driver's profile (ProfileRules.vehicle format), or nil when it does not check out.
    public init?(profile raw: JSONValue) {
        guard let v = ProfileRules.vehicle(raw), let o = v.object,
              let fuel = o["fuel"]?.string.flatMap(VehicleCatalog.Fuel.init(rawValue:)) else { return nil }
        func int(_ k: String) -> Int { Int((o[k]?.number ?? 0).rounded()) }
        year = int("year")
        make = o["make"]?.string ?? ""
        model = o["model"]?.string ?? ""
        versionLabel = o["version"]?.string ?? ""
        city = int("city")
        highway = int("highway")
        combined = int("combined")
        self.fuel = fuel
        tankGallons = o["tankGallons"]?.number
        tankIsVerified = o["tankSource"]?.string == "verified"
        evRangeMiles = int("evRangeMiles")
        evRangeHighwayMiles = int("evRangeHighwayMiles")
        basis = o["mpgBasis"]?.string.flatMap(Basis.init(rawValue:)) ?? .highway
        customMilesPerGallon = o["customMpg"]?.number
        customRangeMiles = o["customRangeMiles"]?.number
        epaID = o["epaId"]?.number.map { Int($0) }
        let id = o["id"]?.string
        profileID = id == ProfileRules.vehicleId(year: year, make: make, model: model, version: versionLabel) ? nil : id
    }

    /// This vehicle in the profile format.
    public var profileJSON: JSONValue {
        let opt: (Double?) -> JSONValue = { $0.map { .number($0) } ?? .null }
        return .object([
            "id": .string(id), "year": .number(Double(year)), "make": .string(make), "model": .string(model),
            "version": .string(versionLabel), "epaId": epaID.map { .number(Double($0)) } ?? .null, "fuel": .string(fuel.rawValue),
            "city": .number(Double(city)), "highway": .number(Double(highway)), "combined": .number(Double(combined)),
            "tankGallons": isElectric ? .null : opt(tankGallons),
            "tankSource": isElectric || tankGallons == nil ? .null : .string(tankIsVerified ? "verified" : "entered"),
            "evRangeMiles": .number(Double(evRangeMiles)), "evRangeHighwayMiles": .number(Double(evRangeHighwayMiles)),
            "mpgBasis": .string(basis.rawValue), "customMpg": opt(customMilesPerGallon), "customRangeMiles": opt(customRangeMiles),
        ])
    }

    public var isElectric: Bool { fuel == .electric }
    public var title: String { "\(year) \(make) \(model)" }

    /// MPG used for range (gas and diesel).
    public var milesPerGallon: Double {
        switch basis {
        case .custom: return customMilesPerGallon.flatMap { $0 > 0 ? $0 : nil } ?? Double(highway)
        case .combined: return Double(combined)
        case .highway: return Double(highway)
        }
    }

    /// Full tank or full charge range in meters, or nil when the tank size is unknown.
    public var fullRangeMeters: Double? {
        if isElectric {
            let miles: Double
            switch basis {
            case .custom: miles = customRangeMiles.flatMap { $0 > 0 ? $0 : nil } ?? Double(evRangeMiles)
            case .combined: miles = Double(evRangeMiles)
            case .highway: miles = Double(evRangeHighwayMiles > 0 ? evRangeHighwayMiles : evRangeMiles)
            }
            return miles > 0 ? miles * Geodesy.metersPerMile : nil
        }
        return RangePlanner.fullTankRange(tankGallons: tankGallons, milesPerGallon: milesPerGallon)
    }
}
