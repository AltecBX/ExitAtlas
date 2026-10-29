import Foundation

/// The profile as typed values for the iOS app, read from and written back to the profile JSON. Writing
/// back keeps every key it does not cover (and anything a newer version added), and goes through the
/// same checks as stored data. Mirrors settingsFromProfile/applyToProfile in web/js/app/profilestore.js.
public struct ProfileSettings: Sendable, Equatable {
    public var vehicles: [DriverVehicle] = []
    public var defaultVehicleID: String?

    public var favoriteBrands: [String] = ["Shell"]
    /// Fuel grade for prices ("R", "M", "P", "D"); nil uses the vehicle's fuel.
    public var fuelGrade: String?
    public var reserveMiles: Double = 50
    public var maxDetourMinutes: Double = 8
    /// "overnight", "always" or "off".
    public var require24Hours = "overnight"
    public var requireRestroom = "overnight"
    public var priceOverBrand = false
    public var teslaOnlyChargers = true

    /// "auto", "on" or "off"; the window is local "HH:MM" at the stop.
    public var overnightMode = "auto"
    public var overnightStart = "00:00"
    public var overnightEnd = "04:00"

    public var home: Waypoint?
    public var savedPlaces: [Waypoint] = []
    public var recentPlaces: [Waypoint] = []
    public var favoriteHotels: [String] = []
    public var favoriteRestaurants: [String] = []
    public var favoriteCategories: [String] = []

    public var speedAlertOver: Double = 5
    public var exitLookaheadMiles: Double = 25
    public var gasGapMiles: Double = 40
    public var avoidTolls = false
    public var keepAwake = true
    public var liveActivityEnabled = true
    /// "auto", "light" or "dark".
    public var theme = "auto"
    /// The Drive screen: "map" (Navigation View) or "focus" (the compact dashboard).
    public var drivePresentation = "map"

    public var voiceEnabled = true
    public var announceStateLines = true
    public var announceExits = false
    public var announceFuel = true
    public var announceRestAreas = true
    public var announceGasGaps = true
    public var announceTimeZones = true

    /// Road alert groups switched on (RoadIntel.Group raw values), and whether alerts are spoken.
    public var alertGroups: [String: Bool] = ["closures": true, "incidents": true, "traffic": true, "weather": true, "police": true,
                                              "cameras": true]
    public var announceAlerts = true

    /// Traffic (docs/16): Apple's traffic layer on the map, traffic aware arrival times, spoken heavy traffic,
    /// and faster route offers saving at least `minSavingMinutes`.
    public var trafficOnMap = true
    public var trafficInETA = true
    public var announceTraffic = true
    public var suggestFasterRoutes = true
    public var minSavingMinutes = 10.0

    /// Gas prices (docs/17): compare reported prices, the usual payment, the oldest report that still competes,
    /// telling when another stop beats the favorite by `minSavingsDollars` on a fill, and the sources.
    public var comparePrices = true
    public var pricePayment = "credit"
    public var priceMaxAgeHours = 24.0
    public var tellCheaper = true
    public var minSavingsDollars = 2.0
    public var ownPriceReports = true
    public var communityPrices = false
    public var googlePrices = false

    public init() {}

    /// The vehicle that plans fuel stops.
    public var vehicle: DriverVehicle? { vehicles.first { $0.id == defaultVehicleID } }

    /// Reads a profile (checked first, so any profile JSON works).
    public init(profile raw: JSONValue) {
        let p = ProfileRules.normalize(raw).profile
        func sec(_ s: String) -> [String: JSONValue] { p[s]?.object ?? [:] }
        func strings(_ v: JSONValue?) -> [String] { v?.array?.compactMap(\.string) ?? [] }
        func place(_ v: JSONValue?) -> Waypoint? {
            guard let o = v?.object, let name = o["name"]?.string, let lat = o["lat"]?.number, let lon = o["lon"]?.number else { return nil }
            return Waypoint(name: name, coordinate: GeoCoordinate(latitude: lat, longitude: lon))
        }
        vehicles = p["vehicles"]?.array?.compactMap { DriverVehicle(profile: $0) } ?? []
        defaultVehicleID = p["defaultVehicleId"]?.string
        let f = sec("fuel")
        favoriteBrands = strings(f["brands"])
        fuelGrade = f["grade"]?.string
        reserveMiles = f["reserveMiles"]?.number ?? 50
        maxDetourMinutes = f["maxDetourMinutes"]?.number ?? 8
        require24Hours = f["require24Hours"]?.string ?? "overnight"
        requireRestroom = f["requireRestroom"]?.string ?? "overnight"
        priceOverBrand = f["priceOverBrand"]?.bool ?? false
        teslaOnlyChargers = f["chargerNetwork"]?.string != "all"
        let o = sec("overnight")
        overnightMode = o["mode"]?.string ?? "auto"
        overnightStart = o["start"]?.string ?? "00:00"
        overnightEnd = o["end"]?.string ?? "04:00"
        let pl = sec("places")
        home = place(pl["home"])
        savedPlaces = pl["saved"]?.array?.compactMap(place) ?? []
        recentPlaces = pl["recent"]?.array?.compactMap(place) ?? []
        let fav = sec("favorites")
        favoriteHotels = strings(fav["hotels"])
        favoriteRestaurants = strings(fav["restaurants"])
        let d = sec("driving")
        favoriteCategories = strings(d["favoriteCategories"])
        speedAlertOver = d["speedAlertOver"]?.number ?? 5
        exitLookaheadMiles = d["exitLookaheadMiles"]?.number ?? 25
        gasGapMiles = d["gasGapMiles"]?.number ?? 40
        avoidTolls = d["avoidTolls"]?.bool ?? false
        keepAwake = d["keepAwake"]?.bool ?? true
        liveActivityEnabled = d["liveActivity"]?.bool ?? true
        theme = d["theme"]?.string ?? "auto"
        drivePresentation = d["drivePresentation"]?.string ?? "map"
        let v = sec("voice")
        voiceEnabled = v["enabled"]?.bool ?? true
        announceStateLines = v["stateLines"]?.bool ?? true
        announceExits = v["exits"]?.bool ?? false
        announceFuel = v["fuel"]?.bool ?? true
        announceRestAreas = v["restAreas"]?.bool ?? true
        announceGasGaps = v["gasGaps"]?.bool ?? true
        announceTimeZones = v["timeZones"]?.bool ?? true
        let a = sec("alerts")
        for g in alertGroups.keys { alertGroups[g] = a[g]?.bool ?? true }
        announceAlerts = a["voice"]?.bool ?? true
        let t = sec("traffic")
        trafficOnMap = t["map"]?.bool ?? true
        trafficInETA = t["eta"]?.bool ?? true
        announceTraffic = t["voice"]?.bool ?? true
        suggestFasterRoutes = t["suggestRoutes"]?.bool ?? true
        minSavingMinutes = t["minSavingMinutes"]?.number ?? 10
        let pr = sec("prices")
        comparePrices = pr["compare"]?.bool ?? true
        pricePayment = pr["payment"]?.string ?? "credit"
        priceMaxAgeHours = pr["maxAgeHours"]?.number ?? 24
        tellCheaper = pr["tellCheaper"]?.bool ?? true
        minSavingsDollars = pr["minSavingsDollars"]?.number ?? 2
        ownPriceReports = pr["ownReports"]?.bool ?? true
        communityPrices = pr["community"]?.bool ?? false
        googlePrices = pr["google"]?.bool ?? false
    }

    /// The profile with these values written into it. Saved places keep their ids when the name and
    /// position are unchanged.
    public func applied(to raw: JSONValue) -> JSONValue {
        var p = ProfileRules.normalize(raw).profile.object ?? [:]
        func merge(_ section: String, _ values: [String: JSONValue]) {
            var s = p[section]?.object ?? [:]
            for (k, v) in values { s[k] = v }
            p[section] = .object(s)
        }
        let strs: ([String]) -> JSONValue = { .array($0.map { .string($0) }) }
        let oldSaved = p["places"]?["saved"]?.array ?? []
        func place(_ w: Waypoint?, keepIDFrom old: [JSONValue] = []) -> JSONValue {
            guard let w else { return .null }
            var o: [String: JSONValue] = ["name": .string(w.name), "lat": .number(w.coordinate.latitude),
                                          "lon": .number(w.coordinate.longitude)]
            if let match = old.first(where: { $0["name"]?.string == w.name && $0["lat"]?.number == w.coordinate.latitude
                && $0["lon"]?.number == w.coordinate.longitude }), let id = match["id"] { o["id"] = id }
            return .object(o)
        }
        p["vehicles"] = .array(vehicles.map(\.profileJSON))
        p["defaultVehicleId"] = defaultVehicleID.map { .string($0) } ?? .null
        merge("fuel", [
            "brands": strs(favoriteBrands), "grade": fuelGrade.map { .string($0) } ?? .null,
            "reserveMiles": .number(reserveMiles), "maxDetourMinutes": .number(maxDetourMinutes),
            "require24Hours": .string(require24Hours), "requireRestroom": .string(requireRestroom),
            "priceOverBrand": .bool(priceOverBrand), "chargerNetwork": .string(teslaOnlyChargers ? "Tesla" : "all"),
        ])
        merge("overnight", ["mode": .string(overnightMode), "start": .string(overnightStart), "end": .string(overnightEnd)])
        merge("places", [
            "home": place(home), "saved": .array(savedPlaces.map { place($0, keepIDFrom: oldSaved) }),
            "recent": .array(recentPlaces.map { place($0) }),
        ])
        merge("favorites", ["hotels": strs(favoriteHotels), "restaurants": strs(favoriteRestaurants)])
        merge("driving", [
            "speedAlertOver": .number(speedAlertOver), "exitLookaheadMiles": .number(exitLookaheadMiles),
            "gasGapMiles": .number(gasGapMiles), "favoriteCategories": strs(favoriteCategories),
            "avoidTolls": .bool(avoidTolls), "keepAwake": .bool(keepAwake), "liveActivity": .bool(liveActivityEnabled),
            "theme": .string(theme), "drivePresentation": .string(drivePresentation),
        ])
        merge("voice", [
            "enabled": .bool(voiceEnabled), "stateLines": .bool(announceStateLines), "exits": .bool(announceExits),
            "fuel": .bool(announceFuel), "restAreas": .bool(announceRestAreas), "gasGaps": .bool(announceGasGaps),
            "timeZones": .bool(announceTimeZones),
        ])
        merge("alerts", alertGroups.mapValues { JSONValue.bool($0) }.merging(["voice": .bool(announceAlerts)]) { $1 })
        merge("traffic", [
            "map": .bool(trafficOnMap), "eta": .bool(trafficInETA), "voice": .bool(announceTraffic),
            "suggestRoutes": .bool(suggestFasterRoutes), "minSavingMinutes": .number(minSavingMinutes),
        ])
        merge("prices", [
            "compare": .bool(comparePrices), "payment": .string(pricePayment), "maxAgeHours": .number(priceMaxAgeHours),
            "tellCheaper": .bool(tellCheaper), "minSavingsDollars": .number(minSavingsDollars), "ownReports": .bool(ownPriceReports),
            "community": .bool(communityPrices), "google": .bool(googlePrices),
        ])
        return ProfileRules.normalize(.object(p)).profile
    }
}

/// A saved trip plan in the profile ("places.plans"): the places only, never route geometry. The iOS app
/// keeps its saved trips in their own file and carries them in exports as plans; the website keeps them
/// in the profile.
public struct SavedPlan: Sendable, Equatable {
    public var name: String
    /// nil starts at the current location.
    public var from: Waypoint?
    public var stops: [Waypoint]
    public var to: Waypoint

    public init(name: String, from: Waypoint?, stops: [Waypoint], to: Waypoint) {
        self.name = name
        self.from = from
        self.stops = stops
        self.to = to
    }

    public init?(json: JSONValue) {
        guard let p = ProfileRules.plan(json), let name = p["name"]?.string, let to = Self.waypoint(p["to"]) else { return nil }
        self.init(name: name, from: Self.waypoint(p["from"]), stops: p["stops"]?.array?.compactMap { Self.waypoint($0) } ?? [], to: to)
    }

    public var json: JSONValue {
        func place(_ w: Waypoint) -> JSONValue {
            ["name": .string(w.name), "lat": .number(w.coordinate.latitude), "lon": .number(w.coordinate.longitude)]
        }
        return ["name": .string(String(name.prefix(80))), "from": from.map(place) ?? .null, "stops": .array(stops.map(place)), "to": place(to)]
    }

    static func waypoint(_ v: JSONValue?) -> Waypoint? {
        guard let o = v?.object, let name = o["name"]?.string, let lat = o["lat"]?.number, let lon = o["lon"]?.number else { return nil }
        return Waypoint(name: name, coordinate: GeoCoordinate(latitude: lat, longitude: lon))
    }

    /// The plans in a profile (checked first).
    public static func plans(in profile: JSONValue) -> [SavedPlan] {
        ProfileRules.normalize(profile).profile["places"]?["plans"]?.array?.compactMap { SavedPlan(json: $0) } ?? []
    }

    /// The profile with its plans replaced.
    public static func profile(_ profile: JSONValue, withPlans plans: [SavedPlan]) -> JSONValue {
        var p = profile.object ?? [:]
        var places = p["places"]?.object ?? [:]
        places["plans"] = .array(plans.prefix(20).map(\.json))
        p["places"] = .object(places)
        return ProfileRules.normalize(.object(p)).profile
    }
}
