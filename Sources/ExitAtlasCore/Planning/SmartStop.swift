import Foundation

/// SmartStop: one recommended stop and up to two alternatives, each with short reasons, from the stations
/// and service plazas ahead. Port of web/js/engine/smartstop.js: the same rules on the same fixtures
/// (Tests/ExitAtlasCoreTests/Fixtures/smartstop/cases.json), so both platforms rank alike.
///
/// Stop confidence is a status, never a score. Hours and restrooms are only what a source lists:
///   Google Places business hours for the arrival day          "Verified open at estimated arrival"
///   OpenStreetMap hours (community mapped, with a check date) "Reported open, verification limited"
///   or the brand's own store listing (All the Places, with the date it was collected)
///   a source closed at the arrival time (and none open)       "Reported closed at estimated arrival"
///   nothing listed, hours that do not parse, or OpenStreetMap
///   and the brand listing disagree at the arrival time        "Hours unavailable"
/// A restroom is "listed" only when tagged or listed by a source. It is "open at arrival" only
/// where its own hours are known: at rest areas and service plazas, whose listed hours are the
/// building's. A 24 hour gas station can still lock its restroom overnight, so a station restroom is
/// never shown as open at arrival.
public enum SmartStop {
    public enum HoursStatus: String, Sendable {
        case verified, reported, unknown, closed

        public var label: String {
            switch self {
            case .verified: return "Verified open at estimated arrival"
            case .reported: return "Reported open, verification limited"
            case .unknown: return "Hours unavailable"
            case .closed: return "Reported closed at estimated arrival"
            }
        }

        var rank: Double { switch self { case .verified: return 0; case .reported: return 1; case .unknown: return 2; case .closed: return 3 } }
    }

    public enum RestroomStatus: String, Sendable {
        case accessible, available, unknown, none

        public var label: String {
            switch self {
            case .accessible: return "Restroom listed, open at arrival per listed hours"
            case .available: return "Restroom listed, access hours unknown"
            case .unknown: return "Restroom availability unknown"
            case .none: return "Listed without a restroom"
            }
        }

        var rank: Double { switch self { case .accessible: return 0; case .available: return 1; case .unknown: return 2; case .none: return 3 } }
    }

    /// The driver's choices that SmartStop uses (from the profile).
    public struct Preferences: Sendable {
        public var brands: [String]
        public var maxDetourMinutes: Double
        /// "overnight", "always" or "off".
        public var require24Hours: String
        public var requireRestroom: String
        public var priceOverBrand: Bool
        /// "auto", "on" or "off", with the local window "HH:MM" to "HH:MM".
        public var overnightMode: String
        public var overnightStart: String
        public var overnightEnd: String

        public init(brands: [String] = ["Shell"], maxDetourMinutes: Double = 8, require24Hours: String = "overnight",
                    requireRestroom: String = "overnight", priceOverBrand: Bool = false, overnightMode: String = "auto",
                    overnightStart: String = "00:00", overnightEnd: String = "04:00") {
            self.brands = brands
            self.maxDetourMinutes = maxDetourMinutes
            self.require24Hours = require24Hours
            self.requireRestroom = requireRestroom
            self.priceOverBrand = priceOverBrand
            self.overnightMode = overnightMode
            self.overnightStart = overnightStart
            self.overnightEnd = overnightEnd
        }

        public init(_ s: ProfileSettings) {
            self.init(brands: s.favoriteBrands, maxDetourMinutes: s.maxDetourMinutes, require24Hours: s.require24Hours,
                      requireRestroom: s.requireRestroom, priceOverBrand: s.priceOverBrand, overnightMode: s.overnightMode,
                      overnightStart: s.overnightStart, overnightEnd: s.overnightEnd)
        }

        /// True when Overnight Drive Mode applies at a local minute of the day (windows may cross midnight).
        public func overnight(atMinute m: Int) -> Bool {
            if overnightMode == "on" { return true }
            if overnightMode == "off" { return false }
            func minutes(_ s: String) -> Int { (Int(s.prefix(2)) ?? 0) * 60 + (Int(s.suffix(2)) ?? 0) }
            let start = minutes(overnightStart), end = minutes(overnightEnd)
            if start == end { return false }
            return start < end ? (m >= start && m < end) : (m >= start || m < end)
        }

        func needs(_ setting: String, overnight: Bool) -> Bool { setting == "always" || (setting == "overnight" && overnight) }
    }

    /// A stop SmartStop can choose: a gas station at an exit, a service plaza with fuel, or a rest area
    /// (restroom stops).
    public struct Candidate: Sendable {
        public enum Kind: String, Sendable { case station, plaza, rest }

        public var id: String
        public var name: String
        public var brand: String
        /// Other names to match favorite brands (the gas stations inside a service plaza).
        public var otherNames: [String]
        public var kind: Kind
        public var exitID: String?
        /// The exit number shown on its sign (display only).
        public var exitLabel: String?
        /// Meters along the route, and ahead of the driver (nil when not known).
        public var along: Double
        public var ahead: Double?
        public var arrival: Date
        public var timeZone: TimeZone
        /// Measured round trip detour in minutes; nil when not measured.
        public var detourMinutes: Double?
        /// Meters of range left on arrival; nil when no range is known.
        public var rangeOnArrival: Double?
        /// Price per gallon for the driver's grade from Google, when known.
        public var price: Double?
        /// OpenStreetMap: opening_hours text, the date it was checked, the toilets tag, and why the
        /// station should not be offered (removed or no longer a gas station).
        public var osmHours: String?
        public var osmChecked: String?
        public var osmToilets: Bool?
        public var gone: String?
        /// The brand's own store listing (All the Places): its hours for the station, whether it lists a
        /// restroom, the brand as it names itself, and the date the listing was collected.
        public var brandHours: String?
        public var brandToilets: Bool?
        public var listedBy: String?
        public var brandCollected: String?
        /// Google Places, live: business hours for the coming week and the restroom field.
        public var livePeriods: [GooglePeriod]?
        public var liveRestroom: Bool?
        public var liveSource: String
        /// Service plazas and rest areas: their listed hours, restrooms and FHWA truck spaces.
        public var plazaHours: String?
        public var plazaToilets: Bool?
        public var truckSpaces: Int?

        public init(id: String, name: String, brand: String = "", otherNames: [String] = [], kind: Kind = .station,
                    exitID: String? = nil, exitLabel: String? = nil, along: Double, ahead: Double? = nil, arrival: Date, timeZone: TimeZone,
                    detourMinutes: Double? = nil, rangeOnArrival: Double? = nil, price: Double? = nil,
                    osmHours: String? = nil, osmChecked: String? = nil, osmToilets: Bool? = nil, gone: String? = nil,
                    livePeriods: [GooglePeriod]? = nil, liveRestroom: Bool? = nil, liveSource: String = "Google Maps",
                    plazaHours: String? = nil, plazaToilets: Bool? = nil, truckSpaces: Int? = nil,
                    brandHours: String? = nil, brandToilets: Bool? = nil, listedBy: String? = nil, brandCollected: String? = nil) {
            self.id = id
            self.name = name
            self.brand = brand
            self.otherNames = otherNames
            self.kind = kind
            self.exitID = exitID
            self.exitLabel = exitLabel
            self.along = along
            self.ahead = ahead
            self.arrival = arrival
            self.timeZone = timeZone
            self.detourMinutes = detourMinutes
            self.rangeOnArrival = rangeOnArrival
            self.price = price
            self.osmHours = osmHours
            self.osmChecked = osmChecked
            self.osmToilets = osmToilets
            self.gone = gone
            self.livePeriods = livePeriods
            self.liveRestroom = liveRestroom
            self.liveSource = liveSource
            self.plazaHours = plazaHours
            self.plazaToilets = plazaToilets
            self.truckSpaces = truckSpaces
            self.brandHours = brandHours
            self.brandToilets = brandToilets
            self.listedBy = listedBy
            self.brandCollected = brandCollected
        }

        var isPlaza: Bool { kind == .plaza || kind == .rest }
    }

    /// One facility row: pumps, store, restroom, restroom hours, plaza hours, parking.
    public struct Facility: Sendable, Equatable {
        public var name: String
        public var status: String
        public var label: String
        public var source: String?
        public var checked: String?
        public var closesIn: Int?
    }

    public struct Hours: Sendable, Equatable {
        public var status: HoursStatus
        public var source: String?
        public var checked: String?
        /// Minutes from arrival to closing; nil when open around the clock or unknown.
        public var closesIn: Int?
        /// The listed hours have holiday rules that are not applied.
        public var holidays: Bool
        /// Why the hours are unavailable when sources disagree.
        public var note: String? = nil
        /// The hours come from the brand's listing (`checked` is then the date it was collected).
        public var listing = false
        /// `checked` is more than a year before the arrival: shown, with "may be out of date".
        public var stale = false
        public var label: String { status.label }
    }

    public struct Evaluation: Sendable {
        public var weekday: Int
        public var minute: Int
        public var overnight: Bool
        public var hours: Hours
        public var restroom: RestroomStatus
        public var facilities: [Facility]

        /// The hours status came from Google Maps business hours. Google Maps Platform terms forbid text to
        /// speech of their content, so spoken answers leave it out; the app shows it on screen.
        public var hoursFromGoogle: Bool {
            hours.status == .verified || (hours.source?.localizedCaseInsensitiveContains("google") ?? false)
        }

        /// The restroom status came from Google Maps (the restroom field). Not spoken, for the same reason.
        public var restroomFromGoogle: Bool {
            facilities.first { $0.name == "Restroom" }?.source?.localizedCaseInsensitiveContains("google") ?? false
        }
    }

    /// A check or collection date ("2025", "2025-03", "2025-03-14") more than a year before the arrival: the
    /// hours are still shown, with "may be out of date".
    public static func isStale(_ date: String?, arrival: Date) -> Bool {
        guard let date, date.count >= 4, let y = Int(date.prefix(4)) else { return false }
        let parts = date.prefix(10).split(separator: "-").dropFirst().compactMap { Int($0) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        guard let d = cal.date(from: DateComponents(year: y, month: parts.first ?? 1, day: parts.dropFirst().first ?? 1)) else { return false }
        return arrival.timeIntervalSince(d) > 365 * 86400
    }

    struct Pumps {
        var status: HoursStatus
        var closesIn: Int?
        var source: String?
        var checked: String?
        var parsed: OpeningHours?
        var listing = false
        var note: String?
    }

    /// The pumps' hours from OpenStreetMap and the brand's listing: one source when only one lists them; when
    /// both do and agree, the more recently dated one (the listing unless a mapper checked the hours after it
    /// was collected); when they disagree at the arrival time, unknown, with a note saying so.
    static func pumps(hours: String?, checked: String?, brandHours: String?, listedBy: String?, collected: String?,
                      weekday: Int, minute: Int) -> Pumps {
        func at(_ h: OpeningHours?) -> (HoursStatus, Int?) {
            guard let h else { return (.unknown, nil) }
            let r = h.open(weekday: weekday, minute: minute)
            return r.open ? (.reported, r.closesIn) : (.closed, nil)
        }
        let o = OpeningHours(osm: hours), b = OpeningHours(osm: brandHours)
        let os = at(o), bs = at(b)
        let fromOSM = Pumps(status: os.0, closesIn: os.1, source: "OpenStreetMap", checked: checked, parsed: o)
        let fromBrand = Pumps(status: bs.0, closesIn: bs.1, source: "Listed by \(listedBy ?? "the brand")", checked: collected, parsed: b, listing: true)
        if o == nil && b == nil { return Pumps(status: .unknown) }
        guard b != nil else { return fromOSM }
        guard o != nil else { return fromBrand }
        if os.0 != bs.0 { return Pumps(status: .unknown, note: "OpenStreetMap and the \(listedBy ?? "brand") listing disagree") }
        if let checked, let collected, checked > collected { return fromOSM }
        return fromBrand
    }

    /// Everything known about one stop at its arrival time.
    public static func evaluate(_ c: Candidate, preferences p: Preferences) -> Evaluation {
        let local = OpeningHours.localTime(c.arrival, in: c.timeZone)
        let overnight = p.overnight(atMinute: local.minute)
        let rest = c.kind == .rest
        var facilities: [Facility] = []
        func status(_ hours: OpeningHours?, _ kind: HoursStatus) -> (HoursStatus, Int?) {
            guard let hours else { return (.unknown, nil) }
            let r = hours.open(weekday: local.weekday, minute: local.minute)
            return r.open ? (kind, r.closesIn) : (.closed, nil)
        }

        // Pumps: the station's OpenStreetMap hours and its brand listing (or a plaza's hours, which cover its fuel).
        let pumpsFound = c.isPlaza
            ? Self.pumps(hours: c.plazaHours, checked: nil, brandHours: nil, listedBy: nil, collected: nil, weekday: local.weekday, minute: local.minute)
            : Self.pumps(hours: c.osmHours, checked: c.osmChecked, brandHours: c.brandHours, listedBy: c.listedBy, collected: c.brandCollected,
                         weekday: local.weekday, minute: local.minute)
        let parsed = pumpsFound.parsed
        let pumps = (pumpsFound.status, pumpsFound.closesIn)
        if !rest {
            let source = pumpsFound.note ?? (pumpsFound.listing ? pumpsFound.checked.map { "\(pumpsFound.source ?? ""), collected \($0)" } ?? pumpsFound.source : pumpsFound.source)
            facilities.append(Facility(name: "Pumps", status: pumps.0.rawValue, label: pumps.0.label, source: source,
                                       checked: c.isPlaza || pumpsFound.listing ? nil : pumpsFound.checked, closesIn: pumps.1))
        }
        // Store: the business hours Google lists for the arrival day.
        let liveWeek = rest ? nil : c.livePeriods.flatMap { OpeningHours(googlePeriods: $0) }
        let store = status(liveWeek, .verified)
        let liveSource = liveWeek == nil ? nil : c.liveSource
        if !rest {
            facilities.append(Facility(name: "Store", status: store.0.rawValue, label: store.0.label, source: liveSource, checked: nil, closesIn: store.1))
        }

        // The stop as a whole: open when a source says so; closed only when no source says open.
        var hours: Hours
        if store.0 == .verified {
            hours = Hours(status: .verified, source: liveSource, checked: nil, closesIn: store.1, holidays: false)
        } else if pumps.0 == .reported {
            hours = Hours(status: .reported, source: pumpsFound.source, checked: nil, closesIn: pumps.1, holidays: false)
        } else if store.0 == .closed || pumps.0 == .closed {
            hours = Hours(status: .closed, source: store.0 == .closed ? liveSource : pumpsFound.source, checked: nil, closesIn: nil, holidays: false)
        } else {
            hours = Hours(status: .unknown, source: nil, checked: nil, closesIn: nil, holidays: false, note: pumpsFound.note)
        }
        let fromPumps = hours.source != nil && hours.source == pumpsFound.source
        hours.checked = fromPumps && !c.isPlaza ? pumpsFound.checked : nil
        hours.listing = fromPumps && pumpsFound.listing
        hours.stale = isStale(hours.checked, arrival: c.arrival)
        hours.holidays = parsed?.holidays ?? false

        // Restroom: listed by Google, tagged in OpenStreetMap, or listed by the brand, in that order; when
        // OpenStreetMap says none and the brand lists one, unknown. Its own hours only at plazas and rest areas.
        let brandListed = !c.isPlaza && c.brandToilets == true
        let toilets: Bool?
        let restroomSource: String?
        if c.isPlaza { toilets = c.plazaToilets; restroomSource = c.plazaToilets == nil ? nil : "OpenStreetMap" }
        else if let r = c.liveRestroom { toilets = r; restroomSource = c.liveSource }
        else if c.osmToilets == false && brandListed {
            toilets = nil
            restroomSource = "OpenStreetMap and the \(c.listedBy ?? "brand") listing disagree"
        } else if let t = c.osmToilets { toilets = t; restroomSource = "OpenStreetMap" }
        else if brandListed {
            toilets = true
            restroomSource = "Listed by \(c.listedBy ?? "the brand")" + (c.brandCollected.map { ", collected \($0)" } ?? "")
        } else { toilets = nil; restroomSource = nil }
        let restroom: RestroomStatus
        if toilets == false { restroom = .none }
        else if toilets != true { restroom = .unknown }
        else if c.isPlaza && pumps.0 == .reported { restroom = .accessible }
        else { restroom = .available }
        facilities.append(Facility(name: "Restroom", status: restroom.rawValue, label: restroom.label, source: restroomSource))
        facilities.append(Facility(name: "Restroom hours", status: restroom == .accessible ? "reported" : "unknown",
                                   label: restroom == .accessible ? "Open at estimated arrival (the \(rest ? "rest area" : "plaza")'s listed hours)" : "Not listed",
                                   source: restroom == .accessible ? "OpenStreetMap" : nil))
        if c.isPlaza {
            facilities.append(Facility(name: rest ? "Rest area hours" : "Plaza hours", status: pumps.0.rawValue, label: pumps.0.label,
                                       source: c.plazaHours == nil ? nil : "OpenStreetMap"))
            let spaces = c.truckSpaces ?? 0
            facilities.append(Facility(name: "Parking", status: spaces > 0 ? "listed" : "unknown",
                                       label: spaces > 0 ? "\(spaces) truck spaces (FHWA survey, 2019)" : "Spaces not listed", source: spaces > 0 ? "FHWA" : nil))
        } else {
            facilities.append(Facility(name: "Parking", status: "unknown", label: "Not listed", source: nil))
        }
        return Evaluation(weekday: local.weekday, minute: local.minute, overnight: overnight, hours: hours, restroom: restroom, facilities: facilities)
    }

    /// Index of the first favorite brand the stop matches (0 is the driver's first choice), or nil.
    public static func brandIndex(_ c: Candidate, favorites: [String]) -> Int? {
        for (i, f) in favorites.enumerated() where ([c.brand, c.name] + c.otherNames).contains(where: { !$0.isEmpty && RangePlanner.matchesFavorite($0, favorites: [f]) }) {
            return i
        }
        return nil
    }

    public enum Purpose: String, Sendable {
        /// Open pumps rank before restrooms.
        case fuel
        /// The restroom ranks first (restroom stops).
        case restroom
    }

    public enum Context: String, Sendable {
        /// Use the range: later is better.
        case fuel
        /// Nearer is better ("best stop in the next 50 miles").
        case ahead
    }

    public struct Pick: Sendable {
        public var candidate: Candidate
        public var evaluation: Evaluation
        /// Index in the favorite brands, nil when not a favorite.
        public var brandRank: Int?
        public var reasons: [String]
        /// Meters to the next usable stop after this one (primary only).
        public var nextOption: Double?
    }

    public struct FavoriteNote: Sendable, Equatable {
        public var id: String
        public var name: String
        public var brand: String
        public var exitID: String?
        public var reason: String
    }

    public struct Result: Sendable {
        public var primary: Pick?
        public var alternatives: [Pick]
        public var considered: Int
        /// Stops left out, by reason.
        public var passed: [String: Int]
        public var overnight: Bool
        /// Soft limits set aside because nothing would be left.
        public var relaxed: [String]
        /// Every stop is below the reserve.
        public var lowRange: Bool
        /// Why the driver's first choice brand was not picked.
        public var favorite: FavoriteNote?
        /// What no stop ahead offers (overnight restroom or hours).
        public var notice: String?
    }

    /// Picks the stop. Candidates in route order; `rejected` holds ids the driver turned down on this trip.
    public static func choose(_ candidates: [Candidate], preferences p: Preferences, context: Context, purpose: Purpose = .fuel,
                              reserveMeters: Double = 0, rejected: Set<String> = []) -> Result {
        struct Entry { var c: Candidate; var e: Evaluation; var brand: Int? }
        let evaluated = candidates.map { Entry(c: $0, e: evaluate($0, preferences: p), brand: brandIndex($0, favorites: p.brands)) }
        var passed: [String: Int] = [:]
        var why: [String: String] = [:]
        func drop(_ x: Entry, _ reason: String) {
            passed[reason, default: 0] += 1
            why[x.c.id] = reason
        }
        func needs(_ setting: String, _ x: Entry) -> Bool { p.needs(setting, overnight: x.e.overnight) }

        var usable: [Entry] = []
        for x in evaluated {
            if let a = x.c.ahead, a <= 0 { drop(x, "Already passed"); continue }
            if rejected.contains(x.c.id) { drop(x, "You skipped it"); continue }
            if x.c.gone != nil { drop(x, "No longer listed as a gas station"); continue }
            if x.e.hours.status == .closed { drop(x, "Reported closed at arrival"); continue }
            if let r = x.c.rangeOnArrival, r < 0 { drop(x, "Out of range"); continue }
            usable.append(x)
        }
        // Soft limits: kept unless nothing would be left.
        let soft: [(String, (Entry) -> Bool)] = [
            ("Below your reserve", { x in context == .fuel && x.c.rangeOnArrival.map { $0 < reserveMeters } == true }),
            ("Detour over your limit", { x in x.c.detourMinutes.map { $0 > p.maxDetourMinutes } == true }),
            ("Listed without a restroom", { x in needs(p.requireRestroom, x) && x.e.restroom == .none }),
        ]
        var pool = usable
        var relaxed: [String] = []
        for (reason, fails) in soft {
            let kept = pool.filter { !fails($0) }
            if !kept.isEmpty {
                for x in pool where fails(x) { drop(x, reason) }
                pool = kept
            } else if !pool.isEmpty {
                relaxed.append(reason)
            }
        }

        let anyPrice = pool.contains { $0.c.price != nil }
        // Every stop is below the reserve: the nearest comes first (open ones first when hours matter).
        let lowRange = relaxed.contains("Below your reserve")
        func key(_ x: Entry) -> [Double] {
            let hoursRank = needs(p.require24Hours, x) ? x.e.hours.status.rank : 0
            if lowRange { return [hoursRank, x.c.along] }
            let restroomRank = needs(p.requireRestroom, x) ? x.e.restroom.rank : 0
            let brandRank = Double(x.brand ?? p.brands.count)
            let priceRank = p.priceOverBrand && anyPrice ? (x.c.price ?? .infinity) : 0
            let detour = x.c.detourMinutes ?? p.maxDetourMinutes + 1
            let (first, second) = purpose == .restroom ? (restroomRank, hoursRank) : (hoursRank, restroomRank)
            return context == .fuel
                ? [first, second, priceRank, brandRank, -x.c.along, detour]
                : [first, second, priceRank, brandRank, detour, x.c.along]
        }
        let ranked = pool.map { ($0, key($0)) }.sorted { a, b in
            for (l, r) in zip(a.1, b.1) where l != r { return l < r }
            return a.0.c.id < b.0.c.id
        }.map(\.0)

        // Alternatives at other exits first, so they offer a different place to stop.
        let primary = ranked.first
        var alternatives: [Entry] = []
        var used = Set(primary.map { [$0.c.exitID ?? $0.c.id] } ?? [])
        for x in ranked.dropFirst() where alternatives.count < 2 {
            let place = x.c.exitID ?? x.c.id
            if !used.contains(place) { alternatives.append(x); used.insert(place) }
        }
        for x in ranked.dropFirst() where alternatives.count < 2 && !alternatives.contains(where: { $0.c.id == x.c.id }) {
            alternatives.append(x)
        }

        func reasons(_ x: Entry) -> [String] {
            var out: [String] = []
            if lowRange, let r = x.c.rangeOnArrival {
                out.append("Arrive with about \(Int((r / Geodesy.metersPerMile).rounded())) mi, below your \(Int((reserveMeters / Geodesy.metersPerMile).rounded())) mi reserve")
            }
            if let b = x.brand { out.append("\(p.brands[b]), your \(ordinal(b)) choice") }
            let h = x.e.hours
            switch h.status {
            case .verified: out.append("\(h.label) (\(h.source ?? "Google Maps"))")
            case .reported where h.listing:
                let stale = h.stale ? ", may be out of date" : ""
                out.append("\(h.label) (\((h.source ?? "").replacingOccurrences(of: "Listed", with: "listed"))\(h.checked.map { ", \($0.prefix(7))" } ?? "")\(stale))")
            case .reported: out.append(h.label + (h.checked.map { " (OpenStreetMap, checked \($0.prefix(7))\(h.stale ? ", may be out of date" : ""))" } ?? " (OpenStreetMap)"))
            default: out.append(h.label + (h.note.map { " (\($0))" } ?? ""))
            }
            if let c = h.closesIn, c <= 60 { out.append("Closes \(c) min after you arrive") }
            if x.e.restroom != .unknown || needs(p.requireRestroom, x) { out.append(x.e.restroom.label) }
            if let d = x.c.detourMinutes { out.append(d < 1 ? "No detour" : "About \(Int(d.rounded())) min detour (twice the drive from the exit)") }
            else if x.c.isPlaza { out.append("On the highway, no exit needed") }
            else { out.append("Detour not measured") }
            if let price = x.c.price, p.priceOverBrand { out.append(String(format: "$%.2f (Google Maps)", price)) }
            return out
        }
        func pick(_ x: Entry) -> Pick { Pick(candidate: x.c, evaluation: x.e, brandRank: x.brand, reasons: reasons(x), nextOption: nil) }

        var result = Result(primary: primary.map(pick), alternatives: alternatives.map(pick), considered: candidates.count, passed: passed,
                            overnight: evaluated.contains { $0.e.overnight }, relaxed: relaxed, lowRange: lowRange, favorite: nil, notice: nil)
        guard let primary else { return result }

        // The next usable stop after the primary, so the driver knows what skipping it means.
        if let after = usable.filter({ $0.c.along > primary.c.along }).min(by: { $0.c.along < $1.c.along }) {
            result.primary?.nextOption = after.c.along - primary.c.along
        }

        // Why the driver's first choice brand did not win (closed, out of range, over the detour limit...).
        let top = evaluated.filter { $0.brand != nil && !($0.c.ahead.map { $0 <= 0 } ?? false) }
            .min { ($0.brand!, $0.c.along) < ($1.brand!, $1.c.along) }
        if let top, let topBrand = top.brand, primary.brand == nil || topBrand < primary.brand! {
            let reason: String
            if let w = why[top.c.id] { reason = w }
            else if needs(p.require24Hours, top) && top.e.hours.status.rank > primary.e.hours.status.rank {
                reason = "\(top.e.hours.label.lowercased()), and the recommended stop is better confirmed"
            } else if needs(p.requireRestroom, top) && top.e.restroom.rank > primary.e.restroom.rank {
                reason = "\(top.e.restroom.label.lowercased()), and the recommended stop is better confirmed"
            } else if lowRange { reason = "farther, with fuel below your reserve" }
            else if p.priceOverBrand && anyPrice { reason = "cheaper fuel was preferred" }
            else { reason = "ranked lower" }
            result.favorite = FavoriteNote(id: top.c.id, name: top.c.name, brand: p.brands[topBrand], exitID: top.c.exitID, reason: reason)
        }

        // Overnight or restroom stops: say so when nothing ahead is confirmed.
        if needs(p.requireRestroom, primary) && primary.e.restroom != .accessible {
            result.notice = primary.e.restroom == .available
                ? "No stop ahead has a restroom confirmed open at your arrival time. These list a restroom; its hours are not known."
                : "No stop ahead has a confirmed restroom. Restroom availability is unknown at these stops."
        } else if needs(p.require24Hours, primary) && primary.e.hours.status != .verified && primary.e.hours.status != .reported {
            result.notice = "No stop ahead has hours listed for your arrival time. These are the best available; check before you rely on them."
        }
        return result
    }

    static func ordinal(_ i: Int) -> String { ["1st", "2nd", "3rd"].indices.contains(i) ? ["1st", "2nd", "3rd"][i] : "\(i + 1)th" }

    /// The last stop listed open before a long stretch where the stops are not.
    public struct LastOpen: Sendable {
        public let stop: Candidate
        public let evaluation: Evaluation
        /// Meters from the stop to the end of the stretch.
        public let length: Double
        /// Stops in the stretch that are not listed open at their arrival time.
        public let unlisted: Int
        /// The stretch runs to the end of the window.
        public let openEnded: Bool
    }

    /// Overnight: the last stop listed open at its arrival time before a long stretch where the stops are
    /// not (the warning "before the last known suitable opportunity along a long stretch"). A stretch ends
    /// at the next stop listed open, or at a stop reached after the overnight window that is not reported
    /// closed, or at `windowEnd` (meters along the route). It counts when it is at least `minLength` long
    /// and has stops reached overnight in it; a stretch with no stops at all is a gas gap, which has its own
    /// warning, and one without overnight arrivals is not an overnight stretch. Port of lastOpenBeforeGap in
    /// web/js/engine/smartstop.js.
    public static func lastOpenBeforeGap(_ candidates: [Candidate], preferences p: Preferences, minLength: Double, windowEnd: Double,
                                         rejected: Set<String> = []) -> LastOpen? {
        func usable(_ c: Candidate) -> Bool { (c.ahead ?? 1) > 0 && c.gone == nil && !rejected.contains(c.id) }
        func before(_ a: Candidate, _ b: Candidate) -> Bool { a.along != b.along ? a.along < b.along : a.id < b.id }
        let stops: [(c: Candidate, e: Evaluation)] = candidates.filter(usable).sorted(by: before)
            .map { (c: $0, e: evaluate($0, preferences: p)) }
        func listedOpen(_ e: Evaluation) -> Bool { e.hours.status == .verified || e.hours.status == .reported }
        func ends(_ e: Evaluation) -> Bool { listedOpen(e) || (!e.overnight && e.hours.status != .closed) }
        var i = 0
        while i < stops.count {
            guard listedOpen(stops[i].e) else { i += 1; continue }
            var j = i + 1
            while j < stops.count && !ends(stops[j].e) { j += 1 }
            let end = j < stops.count ? stops[j].c.along : windowEnd
            let unlisted = j - i - 1
            let overnight = stops[(i + 1)..<j].contains { $0.e.overnight }
            if overnight && end - stops[i].c.along >= minLength {
                return LastOpen(stop: stops[i].c, evaluation: stops[i].e, length: end - stops[i].c.along, unlisted: unlisted,
                                openEnded: j >= stops.count)
            }
            i = j
        }
        return nil
    }
}
