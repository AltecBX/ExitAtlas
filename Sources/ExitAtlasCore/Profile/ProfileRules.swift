import Foundation

/// Checks, defaults and migrates the driver's profile JSON. Port of web/js/engine/profile.js: the
/// same rules on the same fixtures (Tests/ExitAtlasCoreTests/Fixtures/profiles), so a profile reads the
/// same on the website and the iOS app and in profile files moved between them.
public enum ProfileRules {
    public static let schema = 2
    public static let fuelCodes = ["R", "M", "P", "D", "E"]
    public static let serviceCategories = ["gas", "food", "lodging", "evCharging", "restArea", "travelCenter"]
    static let when = ["overnight", "always", "off"]

    public static func defaults() -> JSONValue {
        [
            "kind": "exitatlas-profile", "schema": .number(Double(schema)), "updatedAt": nil,
            "vehicles": [], "defaultVehicleId": nil,
            "fuel": ["brands": ["Shell"], "grade": nil, "reserveMiles": 50, "maxDetourMinutes": 8,
                     "require24Hours": "overnight", "requireRestroom": "overnight", "priceOverBrand": false,
                     "chargerNetwork": "Tesla"],
            "overnight": ["mode": "auto", "start": "00:00", "end": "04:00"],
            "places": ["home": nil, "saved": [], "recent": [], "plans": []],
            "favorites": ["hotels": [], "restaurants": []],
            "driving": ["speedAlertOver": 5, "exitLookaheadMiles": 25, "gasGapMiles": 40, "favoriteCategories": [],
                        "avoidTolls": false, "keepAwake": true, "liveActivity": true, "theme": "auto"],
            "voice": ["enabled": true, "stateLines": true, "exits": false, "fuel": true, "restAreas": true,
                      "gasGaps": true, "timeZones": true],
        ]
    }

    // MARK: Field checks (each returns nil when the value is wrong)

    static func num(_ v: JSONValue, _ lo: Double, _ hi: Double) -> JSONValue? {
        guard let n = v.number, n.isFinite, n >= lo, n <= hi else { return nil }
        return v
    }

    static func str(_ v: JSONValue, _ max: Int = 200) -> String? {
        guard let s = v.string, s.utf16.count <= max else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    static func oneOf(_ v: JSONValue, _ list: [String]) -> JSONValue? {
        guard let s = v.string, list.contains(s) else { return nil }
        return v
    }

    static func bool(_ v: JSONValue) -> JSONValue? {
        // Not `v.bool == nil ? nil : v`: there the nil literal would become JSON null.
        guard v.bool != nil else { return nil }
        return v
    }

    static func clock(_ v: JSONValue) -> JSONValue? {
        guard let s = v.string, s.count == 5, Array(s)[2] == ":",
              let h = Int(s.prefix(2)), let m = Int(s.suffix(2)), s.prefix(2).allSatisfy(\.isNumber),
              s.suffix(2).allSatisfy(\.isNumber), (0...23).contains(h), (0...59).contains(m) else { return nil }
        return v
    }

    /// A place {name, lat, lon} (and its id when it has one), or nil.
    public static func place(_ p: JSONValue) -> JSONValue? {
        guard let o = p.object, let name = o["name"].flatMap({ str($0) }),
              let lat = o["lat"].flatMap({ num($0, -90, 90) }), let lon = o["lon"].flatMap({ num($0, -180, 180) }) else { return nil }
        var out: [String: JSONValue] = ["name": .string(name), "lat": lat, "lon": lon]
        if let id = o["id"], str(id, 80) != nil { out["id"] = id }
        return .object(out)
    }

    /// A saved trip plan {name, from (null starts at the current location), stops, to}, or nil.
    public static func plan(_ p: JSONValue) -> JSONValue? {
        guard let o = p.object, let name = o["name"].flatMap({ str($0, 80) }), let to = o["to"].flatMap(place) else { return nil }
        let stops = Array((o["stops"]?.array ?? []).compactMap(place).prefix(10))
        var out: [String: JSONValue] = ["name": .string(name), "from": o["from"].flatMap(place) ?? .null, "stops": .array(stops), "to": to]
        if let id = o["id"], str(id, 80) != nil { out["id"] = id }
        return .object(out)
    }

    /// The same id for the same vehicle on every platform: "2015|toyota|camry|4-cyl-2.5-l".
    public static func vehicleId(year: Int, make: String, model: String, version: String) -> String {
        let joined = "\(year)|\(make)|\(model)|\(version)".lowercased()
        var out = ""
        var inRun = false
        for ch in joined.unicodeScalars {
            let keep = ("a"..."z").contains(ch) || ("0"..."9").contains(ch) || ch == "|" || ch == "."
            if keep { out.unicodeScalars.append(ch); inRun = false } else if !inRun { out.append("-"); inRun = true }
        }
        return out
    }

    /// A vehicle in the profile format, or nil when a required field is missing or wrong.
    public static func vehicle(_ v: JSONValue) -> JSONValue? {
        guard let o = v.object, let yearN = o["year"]?.number, yearN.rounded() == yearN, (1984...2100).contains(yearN),
              let make = o["make"].flatMap({ str($0, 80) }), let model = o["model"].flatMap({ str($0, 120) }),
              let fuel = o["fuel"].flatMap({ oneOf($0, fuelCodes) })?.string else { return nil }
        func n(_ key: String, _ lo: Double, _ hi: Double) -> JSONValue? { o[key].flatMap { num($0, lo, hi) } }
        let version = o["version"].flatMap { str($0, 200) } ?? ""
        let epa: JSONValue = o["epaId"]?.number.flatMap { $0.rounded() == $0 && $0 > 0 ? JSONValue.number($0) : nil } ?? .null
        let tank: JSONValue = fuel == "E" ? .null : (n("tankGallons", 1, 100) ?? .null)
        var out: [String: JSONValue] = [
            "year": .number(yearN), "make": .string(make), "model": .string(model), "version": .string(version),
            "epaId": epa, "fuel": .string(fuel),
            "city": n("city", 0, 300) ?? 0, "highway": n("highway", 0, 300) ?? 0, "combined": n("combined", 0, 300) ?? 0,
            "tankGallons": tank, "tankSource": nil,
            "evRangeMiles": n("evRangeMiles", 0, 1500) ?? 0, "evRangeHighwayMiles": n("evRangeHighwayMiles", 0, 1500) ?? 0,
            "mpgBasis": o["mpgBasis"].flatMap { oneOf($0, ["highway", "combined", "custom"]) } ?? "highway",
            "customMpg": n("customMpg", 5, 250) ?? .null, "customRangeMiles": n("customRangeMiles", 10, 1500) ?? .null,
        ]
        if !tank.isNull { out["tankSource"] = o["tankSource"].flatMap { oneOf($0, ["verified", "entered"]) } ?? "entered" }
        out["id"] = .string(o["id"].flatMap { str($0, 120) }
            ?? vehicleId(year: Int(yearN), make: make, model: model, version: version))
        return .object(out)
    }

    static func brandList(_ v: JSONValue, _ max: Int) -> JSONValue? {
        guard let a = v.array else { return nil }
        var out: [String] = []
        for b in a {
            if let s = str(b, 40), !out.contains(where: { $0.lowercased() == s.lowercased() }) { out.append(s) }
        }
        return .array(out.prefix(max).map { .string($0) })
    }

    static func placeList(_ v: JSONValue, _ max: Int) -> JSONValue? {
        guard let a = v.array else { return nil }
        return .array(Array(a.compactMap(place).prefix(max)))
    }

    // MARK: Normalize

    /// Checks a stored profile field by field. Each missing or invalid field takes its default and is
    /// listed in `problems` ("vehicles[2]" for a dropped entry); keys this version does not know are kept.
    public static func normalize(_ raw: JSONValue) -> (profile: JSONValue, problems: [String]) {
        let d = defaults().object!
        guard let r = raw.object else { return (.object(d), ["profile"]) }
        var problems: [String] = []
        var out = r.merging(d) { _, def in def }
        let rawSchema = r["schema"]?.number.flatMap { $0.rounded() == $0 ? Int($0) : nil } ?? 0
        out["schema"] = .number(Double(max(schema, rawSchema)))
        out["updatedAt"] = r["updatedAt"]?.string.map { .string($0) } ?? .null

        if let vs = r["vehicles"] {
            if let list = vs.array {
                var seen = Set<String>()
                var kept: [JSONValue] = []
                for (i, v) in list.enumerated() {
                    guard let ok = vehicle(v), let id = ok["id"]?.string else { problems.append("vehicles[\(i)]"); continue }
                    if seen.insert(id).inserted { kept.append(ok) }
                }
                out["vehicles"] = .array(Array(kept.prefix(10)))
            } else {
                problems.append("vehicles")
            }
        }
        let ids = out["vehicles"]?.array?.compactMap { $0["id"]?.string } ?? []
        let wanted = r["defaultVehicleId"]?.string
        if let wanted, ids.contains(wanted) {
            out["defaultVehicleId"] = .string(wanted)
        } else {
            out["defaultVehicleId"] = ids.first.map { .string($0) } ?? .null
            if let dv = r["defaultVehicleId"], !dv.isNull { problems.append("defaultVehicleId") }
        }

        func section(_ name: String, _ rules: [(String, (JSONValue) -> JSONValue?)]) {
            guard let src = r[name] else { return }
            guard let so = src.object else { problems.append(name); return }
            var s = so.merging(d[name]!.object!) { _, def in def }
            for (key, check) in rules {
                guard let v = so[key] else { continue }
                if let ok = check(v) { s[key] = ok } else { problems.append("\(name).\(key)") }
            }
            out[name] = .object(s)
        }

        section("fuel", [
            ("brands", { brandList($0, 20) }),
            ("grade", { $0.isNull ? .null : oneOf($0, ["R", "M", "P", "D"]) }),
            ("reserveMiles", { num($0, 0, 300) }),
            ("maxDetourMinutes", { num($0, 1, 60) }),
            ("require24Hours", { oneOf($0, when) }),
            ("requireRestroom", { oneOf($0, when) }),
            ("priceOverBrand", bool),
            ("chargerNetwork", { oneOf($0, ["Tesla", "all"]) }),
        ])
        section("overnight", [("mode", { oneOf($0, ["auto", "on", "off"]) }), ("start", clock), ("end", clock)])
        section("places", [
            ("home", { $0.isNull ? .null : place($0) }),
            ("saved", { placeList($0, 50) }),
            ("recent", { placeList($0, 10) }),
            ("plans", { v in v.array.map { JSONValue.array(Array($0.compactMap(plan).prefix(20))) } }),
        ])
        section("favorites", [("hotels", { brandList($0, 20) }), ("restaurants", { brandList($0, 20) })])
        section("driving", [
            ("speedAlertOver", { num($0, 0, 30) }),
            ("exitLookaheadMiles", { num($0, 5, 300) }),
            ("gasGapMiles", { num($0, 10, 200) }),
            ("favoriteCategories", { v in
                guard let a = v.array else { return nil }
                var seen: [String] = []
                for c in a { if let s = c.string, serviceCategories.contains(s), !seen.contains(s) { seen.append(s) } }
                return .array(seen.map { .string($0) })
            }),
            ("avoidTolls", bool), ("keepAwake", bool), ("liveActivity", bool),
            ("theme", { oneOf($0, ["auto", "light", "dark"]) }),
        ])
        section("voice", ["enabled", "stateLines", "exits", "fuel", "restAreas", "gasGaps", "timeZones"].map { ($0, bool) })
        return (.object(out), problems)
    }

    // MARK: Migration from the iOS app's earlier storage (schema 1, UserDefaults keys and places.json)

    /// `defaults` holds the old UserDefaults values (the vehicle and brand list as decoded JSON);
    /// `places` is the old places.json. API keys are not part of the profile and are moved separately.
    public static func migrateIOSV1(defaults v1: [String: JSONValue], places: JSONValue?) -> JSONValue {
        var raw = defaults().object!
        func set(_ section: String, _ key: String, _ value: JSONValue?) {
            guard let value, var s = raw[section]?.object else { return }
            s[key] = value
            raw[section] = .object(s)
        }
        if let v = v1["vehicle"]?.object {
            let tank = v["tankGallons"] ?? .null
            let source: JSONValue = tank.isNull ? .null : (v["tankIsVerified"]?.bool == true ? "verified" : "entered")
            let canonical: JSONValue = .object([
                "year": v["year"] ?? .null, "make": v["make"] ?? .null, "model": v["model"] ?? .null,
                "version": v["versionLabel"] ?? "", "epaId": v["epaID"] ?? .null, "fuel": v["fuel"] ?? .null,
                "city": v["city"] ?? 0, "highway": v["highway"] ?? 0, "combined": v["combined"] ?? 0,
                "tankGallons": tank, "tankSource": source,
                "evRangeMiles": v["evRangeMiles"] ?? 0, "evRangeHighwayMiles": v["evRangeHighwayMiles"] ?? 0,
                "mpgBasis": v["basis"] ?? "highway", "customMpg": v["customMilesPerGallon"] ?? .null,
                "customRangeMiles": v["customRangeMiles"] ?? .null,
            ])
            if let ok = vehicle(canonical) {
                raw["vehicles"] = [ok]
                raw["defaultVehicleId"] = ok["id"] ?? .null
            }
        }
        // Brands: the list, or the older comma separated text. Empty means never chosen, so the Shell
        // default applies once, here; after this the driver's list is kept as is.
        var brands = v1["favoriteBrands"].flatMap { brandList($0, 20) }?.array ?? []
        if brands.isEmpty, let text = v1["preferredBrands"]?.string {
            brands = brandList(.array(text.split(separator: ",").map { .string(String($0)) }), 20)?.array ?? []
        }
        if !brands.isEmpty { set("fuel", "brands", .array(brands)) }
        set("fuel", "reserveMiles", v1["bufferMiles"].flatMap { num($0, 0, 300) })
        if let tesla = v1["teslaOnlyChargers"]?.bool { set("fuel", "chargerNetwork", tesla ? "Tesla" : "all") }

        if let p = places?.object {
            func waypoint(_ w: JSONValue?) -> JSONValue? {
                guard let o = w?.object, let c = o["coordinate"]?.object else { return nil }
                return place(["name": o["name"] ?? .null, "lat": c["latitude"] ?? .null, "lon": c["longitude"] ?? .null])
            }
            set("places", "home", waypoint(p["home"]) ?? .null)
            set("places", "recent", .array(Array((p["recent"]?.array ?? []).compactMap(waypoint).prefix(10))))
        }
        set("driving", "speedAlertOver", v1["speedAlertOver"].flatMap { num($0, 0, 30) })
        set("driving", "exitLookaheadMiles", v1["exitLookaheadMiles"].flatMap { num($0, 5, 300) })
        set("driving", "gasGapMiles", v1["gasGapMiles"].flatMap { num($0, 10, 200) })
        set("driving", "avoidTolls", v1["avoidTolls"].flatMap(bool))
        set("driving", "liveActivity", v1["liveActivityEnabled"].flatMap(bool))
        for (from, to) in [("voiceEnabled", "enabled"), ("announceStateLines", "stateLines"), ("announceExits", "exits"),
                           ("announceFuel", "fuel"), ("announceRestAreas", "restAreas"), ("announceGasGaps", "gasGaps"),
                           ("announceTimeZones", "timeZones")] {
            set("voice", to, v1[from].flatMap(bool))
        }
        return normalize(.object(raw)).profile
    }
}
