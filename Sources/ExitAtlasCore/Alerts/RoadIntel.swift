import Foundation

/// Road Intelligence: road incidents, closures, work zones, weather alerts and (when an authorized source
/// exists) enforcement reports from several providers, in one schema, matched to the route ahead by road,
/// direction and position, deduplicated and expired, with an honest status for every kind of alert.
/// Port of web/js/engine/roadintel.js, tested on the same fixtures (Fixtures/roadintel/cases.json).
///
/// Matching never trusts distance alone: a point near the route must be on the same road and in the same
/// direction, so the other carriageway and parallel roads do not raise warnings.
public enum RoadIntel {
    /// Kinds of alert, most serious first.
    public enum Kind: String, Sendable, CaseIterable {
        case closure, crash, flooding, weather, hazard, disabledVehicle, construction, congestion, police, speedCamera, other

        public var label: String {
            switch self {
            case .closure: return "Road closed"
            case .crash: return "Crash"
            case .flooding: return "Flooding"
            case .weather: return "Weather alert"
            case .hazard: return "Hazard on the road"
            case .disabledVehicle: return "Disabled vehicle"
            case .construction: return "Work zone"
            case .congestion: return "Traffic slowdown"
            case .police: return "Police reported"
            case .speedCamera: return "Speed camera"
            case .other: return "Road incident"
            }
        }

        public var rank: Int { Kind.allCases.firstIndex(of: self)! + 1 }

        /// The Settings switch that controls it.
        public var group: Group {
            switch self {
            case .closure, .construction: return .closures
            case .crash, .hazard, .disabledVehicle, .other: return .incidents
            case .congestion: return .traffic
            case .weather, .flooding: return .weather
            case .police: return .police
            case .speedCamera: return .cameras
            }
        }
    }

    public enum Group: String, Sendable, CaseIterable {
        case closures, incidents, traffic, weather, police, cameras

        public var label: String {
            switch self {
            case .closures: return "Closures and work zones"
            case .incidents: return "Crashes, hazards and delays"
            // Measured slowdowns from a traffic provider (Trip/Traffic.swift), on the route and direction driven.
            case .traffic: return "Traffic slowdowns"
            case .weather: return "Weather and flooding"
            case .police: return "Police reports"
            case .cameras: return "Speed cameras"
            }
        }

        public var kinds: [Kind] { Kind.allCases.filter { $0.group == self } }
    }

    /// measured: a traffic provider's own measurement on the route (Trip/Traffic.swift).
    public enum Verification: String, Sendable { case official, measured, community, mapped }
    public enum Severity: String, Sendable { case severe, major, moderate, minor, unknown }
    public enum Tier: String, Sendable { case urgent, caution, info }

    public enum Geometry: Sendable {
        case point(GeoCoordinate)
        case line([GeoCoordinate])
        /// Outer rings of a weather polygon.
        case polygon([[GeoCoordinate]])
        /// An area alert known only at sample points on the route.
        case points([GeoCoordinate])
        /// Measured on the active route (its id) and direction by a traffic provider, in meters along it.
        case route(routeId: String, from: Double, to: Double)
    }

    public struct Source: Sendable, Hashable {
        public let id: String
        public let name: String
        public init(id: String, name: String) { self.id = id; self.name = name }
    }

    public struct Incident: Sendable {
        public var id: String
        public var kind: Kind
        public var description: String
        public var source: Source
        public var verification: Verification
        public var reportedAt: Date?
        public var updatedAt: Date?
        public var startsAt: Date?
        public var endsAt: Date?
        public var expiresAt: Date?
        public var geometry: Geometry?
        public var road: String?
        public var direction: String?
        public var lanes: String?
        public var severity: Severity
        /// The provider's headline, when it has one ("Flash Flood Warning issued ... until 8:45 PM").
        public var detail: String?
        /// The provider's area description, for area alerts.
        public var area: String?
        /// Traffic slowdowns: the provider's added time, when it gives one, and the speed it measured.
        public var delaySeconds: Double?
        public var speedMph: Double?

        public init(id: String, kind: Kind, description: String, source: Source, verification: Verification,
                    reportedAt: Date? = nil, updatedAt: Date? = nil, startsAt: Date? = nil, endsAt: Date? = nil, expiresAt: Date? = nil,
                    geometry: Geometry?, road: String? = nil, direction: String? = nil, lanes: String? = nil, severity: Severity = .unknown) {
            self.id = id
            self.kind = kind
            self.description = description
            self.source = source
            self.verification = verification
            self.reportedAt = reportedAt
            self.updatedAt = updatedAt
            self.startsAt = startsAt
            self.endsAt = endsAt
            self.expiresAt = expiresAt
            self.geometry = geometry
            self.road = road
            self.direction = direction
            self.lanes = lanes
            self.severity = severity
        }

        /// Closures always; crashes, weather, flooding and hazards when major or severe.
        public var isSerious: Bool {
            if kind == .closure { return true }
            return (severity == .severe || severity == .major) && [.crash, .weather, .flooding, .hazard].contains(kind)
        }

        /// Worth the Drive screen and a spoken warning: everything except a work zone that leaves the travel
        /// lanes open or does not say (those stay in Road Ahead).
        public var isNotable: Bool {
            isSerious || !(kind == .construction && (severity == .minor || severity == .unknown))
        }

        /// How loud an alert looks: urgent (red: closures, major or severe crashes, weather, flooding and
        /// hazards), info (blue: work zones that leave the lanes open or do not say, anything minor), else caution.
        public var tier: Tier {
            if isSerious { return .urgent }
            if !isNotable || severity == .minor { return .info }
            return .caution
        }

        /// The alert card's headline: what happened, in a few words.
        public var headline: String {
            switch kind {
            case .closure: return "Road closed ahead"
            case .crash: return "Crash ahead"
            case .flooding: return "Flooding ahead"
            case .weather: return tier == .urgent ? "Severe weather ahead" : "Weather alert"
            case .hazard: return "Road hazard ahead"
            case .disabledVehicle: return "Disabled vehicle ahead"
            case .construction: return "Work zone ahead"
            case .congestion: return severity == .severe ? "Stopped traffic ahead" : severity == .major ? "Heavy traffic ahead" : "Slow traffic ahead"
            case .police: return "Police reported ahead"
            case .speedCamera: return "Speed camera ahead"
            case .other: return "Road incident ahead"
            }
        }

        /// Expired or ended events are not current.
        public func isCurrent(at now: Date) -> Bool {
            if let e = expiresAt, e <= now { return false }
            if let e = endsAt, e <= now { return false }
            return true
        }
    }

    public struct Rules: Sendable {
        public var window = 150 * Geodesy.metersPerMile
        public var sameRoadOffset = 200.0
        public var unnamedOffset = 40.0
        public var otherCarriageway = 15.0
        public var lineOffset = 120.0
        public var lineBearing = 60.0
        /// A reported direction (southbound, or a bearing) agrees with the way the route runs when it is less
        /// than this many degrees off: a road signed south may run southwest; the other carriageway is about 180 off.
        public var directionAngle = 90.0
        public var areaStep = 1000.0
        public var duplicate = 800.0
        /// An area alert known only at sample points (every 25 miles) still stands for the road this far past a
        /// point the driver has passed (half the spacing), until the next answer moves the points.
        public var pointsReach = 12.5 * Geodesy.metersPerMile
        public init() {}
    }

    /// Where an incident sits on the route ahead (meters along it), or why it does not.
    public enum Placement: Sendable, Equatable {
        case ahead(start: Double, end: Double, directionKnown: Bool, approximate: Bool = false)
        case rejected(String)
    }

    public struct Alert: Sendable {
        public let incident: Incident
        public let start: Double
        public let end: Double
        public let ahead: Double
        public let directionKnown: Bool
        /// An area alert known only at sample points: its extent along the route is not known.
        public let approximate: Bool
        public let serious: Bool
        public var notable: Bool { incident.isNotable }
        /// Takes the Drive card: notable, except a weather or flooding alert the driver is already inside that is
        /// not Severe or Extreme (NWS) and not a warning; those advisories stay in Road Ahead and the weather
        /// details. Ahead of the driver nothing changes. Same rule as onDriveCard in roadintel.js.
        public func onDriveCard(progress: Double) -> Bool {
            guard notable else { return false }
            let i = incident
            // Inside: the alert starts where the driver is (within a meter, for rounding) or behind.
            if (i.kind != .weather && i.kind != .flooding) || start - progress > 1 { return true }
            return i.severity == .severe || i.severity == .major
                || i.description.trimmingCharacters(in: .whitespaces).lowercased().hasSuffix("warning")
        }
        public internal(set) var sources: [Source]
    }

    public enum ProviderState: String, Sendable { case ok, pending, error, notConfigured, unsupported }

    public struct Provider: Sendable {
        public var id: String
        public var name: String
        public var kinds: Set<Kind>
        public var state: ProviderState
        public var fetchedAt: Date?
        public var maxAge: TimeInterval
        public var incidents: [Incident]
        /// States on the route this source does not cover.
        public var uncovered: [String]

        public init(id: String, name: String, kinds: Set<Kind>, state: ProviderState, fetchedAt: Date?, maxAge: TimeInterval = 900,
                    incidents: [Incident] = [], uncovered: [String] = []) {
            self.id = id
            self.name = name
            self.kinds = kinds
            self.state = state
            self.fetchedAt = fetchedAt
            self.maxAge = maxAge
            self.incidents = incidents
            self.uncovered = uncovered
        }

        func isFresh(at now: Date) -> Bool {
            guard state == .ok, let fetchedAt else { return false }
            return now.timeIntervalSince(fetchedAt) <= maxAge
        }
    }

    public enum StatusState: String, Sendable {
        case ok, noRelevant, unavailable, notConfigured, unsupported, expired, off, loading

        public var label: String {
            switch self {
            case .ok: return "Alerts on your route"
            case .noRelevant: return "No relevant reports"
            case .unavailable: return "Data unavailable"
            case .notConfigured: return "No source connected"
            case .unsupported: return "Coverage not supported on this route"
            case .expired: return "Reports expired"
            case .off: return "Off in Settings"
            case .loading: return "Checking"
            }
        }
    }

    public struct GroupStatus: Sendable, Equatable {
        public let state: StatusState
        public let note: String?
        public var label: String { state.label }
    }

    public struct Result: Sendable {
        public let alerts: [Alert]
        public let status: [Group: GroupStatus]
    }

    // MARK: Normalizing provider text

    static let stateNames: [String: String] = [
        "ALABAMA": "AL", "ALASKA": "AK", "ARIZONA": "AZ", "ARKANSAS": "AR", "CALIFORNIA": "CA", "COLORADO": "CO", "CONNECTICUT": "CT",
        "DELAWARE": "DE", "DISTRICT OF COLUMBIA": "DC", "FLORIDA": "FL", "FLORIDAS": "FL", "GEORGIA": "GA", "HAWAII": "HI", "IDAHO": "ID",
        "ILLINOIS": "IL", "INDIANA": "IN", "IOWA": "IA", "KANSAS": "KS", "KENTUCKY": "KY", "LOUISIANA": "LA", "MAINE": "ME", "MARYLAND": "MD",
        "MASSACHUSETTS": "MA", "MICHIGAN": "MI", "MINNESOTA": "MN", "MISSISSIPPI": "MS", "MISSOURI": "MO", "MONTANA": "MT", "NEBRASKA": "NE",
        "NEVADA": "NV", "NEW HAMPSHIRE": "NH", "NEW JERSEY": "NJ", "NEW MEXICO": "NM", "NEW YORK": "NY", "NORTH CAROLINA": "NC",
        "NORTH DAKOTA": "ND", "OHIO": "OH", "OKLAHOMA": "OK", "OREGON": "OR", "PENNSYLVANIA": "PA", "RHODE ISLAND": "RI",
        "SOUTH CAROLINA": "SC", "SOUTH DAKOTA": "SD", "TENNESSEE": "TN", "TEXAS": "TX", "UTAH": "UT", "VERMONT": "VT", "VIRGINIA": "VA",
        "WASHINGTON": "WA", "WEST VIRGINIA": "WV", "WISCONSIN": "WI", "WYOMING": "WY",
    ]
    static let stateNameRegex = try! NSRegularExpression(pattern: "\\b(" + stateNames.keys.sorted { $0.count > $1.count }.joined(separator: "|") + ")\\b")
    /// Short forms written out, in order, once capitals and punctuation are dealt with.
    static let roadForms: [(String, String)] = [
        (#"\bINTERSTATE (?=\d)"#, "I "), (#"\bU S\b"#, "US"), (#"\bUS (?:ROUTE|RT|HWY|HIGHWAY) (?=\d)"#, "US "), (#"\bN J\b"#, "NJ"),
        (#"\bNJTP\b"#, "NJ TURNPIKE"), (#"\b(?:TPKE|TPK|TNPK|TURNPK)\b"#, "TURNPIKE"), (#"\b(?:PKWY|PKY|PWY)\b"#, "PARKWAY"),
        (#"\b(?:EXPWY|EXPY|EXWY)\b"#, "EXPRESSWAY"), (#"\b(?:THWY|THRWY|THROUGHWAY)\b"#, "THRUWAY"), (#"\bNYS\b"#, "NY STATE"),
    ]

    /// Road text in one form for comparison: capitals, no punctuation, common short forms written out and state
    /// names as codes. "N.J. Tpke", "NJTP" and "New Jersey Turnpike" all read "NJ TURNPIKE"; "Interstate 95" and
    /// "i-95" read "I 95". Separators (";" and "/") are kept so names on either side of one stay apart.
    /// Same as normalizeRoadText in roadintel.js.
    public static func normalizeRoadText(_ text: String?) -> String {
        var t = (text ?? "").uppercased()
            .replacingOccurrences(of: "[.'\u{2019}]", with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[^A-Z0-9;/]+"#, with: " ", options: .regularExpression)
        for (pattern, to) in roadForms { t = t.replacingOccurrences(of: pattern, with: to, options: .regularExpression) }
        let out = NSMutableString(string: t)
        for m in stateNameRegex.matches(in: t, range: NSRange(location: 0, length: out.length)).reversed() {
            out.replaceCharacters(in: m.range, with: stateNames[out.substring(with: m.range)] ?? out.substring(with: m.range))
        }
        t = out as String
        return t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    /// "I-95", "Interstate 95", "I 95 N" as a highway reference, or nil.
    public static func roadRef(_ text: String?) -> HighwayRef? {
        roadRefs(text).first
    }

    /// Every highway named in the text ("I 95 / J F K Memorial Hwy" names I-95).
    public static func roadRefs(_ text: String?) -> [HighwayRef] {
        guard let text, !text.isEmpty else { return [] }
        return HighwayRef.parse(normalizeRoadText(text))
    }

    /// Named roads in the text by their full name ("NJ TURNPIKE", "HENRY HUDSON PARKWAY"). A bare "Parkway" names
    /// no road in particular, so one word names are left out.
    public static func namedRoads(_ text: String?) -> [String] {
        let t = normalizeRoadText(text)
        let ns = t as NSString
        guard let regex = try? NSRegularExpression(pattern: #"((?:[A-Z0-9]+ ){0,4})(TURNPIKE|PARKWAY|EXPRESSWAY|THRUWAY)\b"#) else { return [] }
        var out: [String] = []
        for m in regex.matches(in: t, range: NSRange(location: 0, length: ns.length)) {
            let name = (ns.substring(with: m.range(at: 1)) + ns.substring(with: m.range(at: 2))).trimmingCharacters(in: .whitespaces)
            if name.contains(" ") && !out.contains(name) { out.append(name) }
        }
        return out
    }

    /// One name is the other, or ends with it ("NY 9A HENRY HUDSON PARKWAY" and "HENRY HUDSON PARKWAY").
    static func sameName(_ a: String, _ b: String) -> Bool {
        let (long, short) = a.count >= b.count ? (a, b) : (b, a)
        return long == short || long.hasSuffix(" " + short)
    }

    static func spur(_ text: String?) -> String? {
        let t = normalizeRoadText(text)
        guard let r = t.range(of: #"\b(EASTERN|WESTERN) SPUR\b"#, options: .regularExpression) else { return nil }
        return String(t[r])
    }

    /// Is the incident's road the route's road at `d`? A highway must be one the route is on there (all its
    /// names count, as where I-95 runs on the New Jersey Turnpike), whatever the case, punctuation or short form
    /// on either side. A named road that is not a highway (a street, a county road) is never the route's road
    /// while the route is on a highway there. No name: unknown.
    static func onSameRoad(_ route: PlannedRoute, _ i: Incident, _ d: Double) -> Bool {
        guard let road = i.road, !road.isEmpty else { return true }
        let step = route.step(at: d)
        let here = step?.highways ?? route.highway(at: d).map { [$0.ref] } ?? []
        let refs = roadRefs(road), names = namedRoads(road)
        if refs.isEmpty && names.isEmpty { return here.isEmpty }
        if refs.contains(where: { r in r.kind != .named && here.contains(r) }) { return true }
        // Turnpikes and parkways by their full name. The Turnpike's two spurs run side by side and are not one road.
        let ours = ([step?.roadName].compactMap { $0 } + here.filter { $0.kind == .named }.map(\.number)).joined(separator: " ; ")
        if let a = spur(road), let b = spur(ours), a != b { return false }
        let known = namedRoads(ours)
        return names.contains { a in known.contains { sameName(a, $0) } }
    }

    /// "Northbound", "NB", "north", "both directions" as "N", "S", "E", "W" or "both", else nil.
    public static func directionCode(_ text: String?) -> String? {
        guard let text else { return nil }
        let t = text.trimmingCharacters(in: .whitespaces).lowercased()
        if t.isEmpty { return nil }
        if t.contains("both") || t.contains("all") || t.range(of: "two.?way", options: .regularExpression) != nil
            || t.range(of: "\\band\\b", options: .regularExpression) != nil { return "both" }
        switch t {
        case "n", "nb", "north", "northbound": return "N"
        case "s", "sb", "south", "southbound": return "S"
        case "e", "eb", "east", "eastbound": return "E"
        case "w", "wb", "west", "westbound": return "W"
        default: return nil
        }
    }

    // MARK: Matching

    public static func place(_ i: Incident, on route: PlannedRoute, progress: Double, rules: Rules = Rules()) -> Placement {
        switch i.geometry {
        case nil: return .rejected("no location")
        case .point(let c): return placePoint(c, i, route, progress, rules)
        case .points(let cs):
            let along = cs.compactMap { route.polyline.nearestProjection(of: $0, within: rules.unnamedOffset)?.distanceAlong }
            let hits = along.filter { $0 >= progress }
            // A point just passed (the first one is where the driver was when NWS answered): the driver is in the area.
            let here = along.contains { $0 < progress && progress - $0 <= rules.pointsReach }
            if hits.isEmpty && !here { return .rejected(along.isEmpty ? "off route" : "behind") }
            // Where it starts and ends between the sample points is not known, so the extent is approximate.
            return .ahead(start: here ? progress : hits.min()!, end: hits.max() ?? progress, directionKnown: true, approximate: true)
        case .line(let cs): return placeLine(cs, i, route, progress, rules)
        case .polygon(let rings): return placeArea(rings, route, progress, rules)
        case .route(let routeId, let from, let to):
            // Measured on this route and direction by a traffic provider: no position matching.
            guard routeId == route.id.uuidString else { return .rejected("other route") }
            return to > progress ? .ahead(start: max(from, progress), end: to, directionKnown: true) : .rejected("behind")
        }
    }

    /// The way the route runs at `d`, from its geometry over a kilometer around it (a curve or a lane shift does
    /// not decide it). Not the road's signed name: on the New Jersey Turnpike, southbound runs southwest.
    static func travelBearing(_ route: PlannedRoute, _ d: Double) -> Double {
        let a = max(0, d - 500), b = min(route.polyline.length, d + 500)
        return b - a >= 100 ? Geodesy.initialBearing(route.polyline.coordinate(at: a), route.polyline.coordinate(at: b)) : route.polyline.bearing(at: d)
    }

    /// A reported direction as a bearing in degrees (northbound 0, eastbound 90, or a bearing the provider gives
    /// as a number), nil for both directions or none. Same as directionBearing in roadintel.js.
    static func directionBearing(_ text: String?) -> Double? {
        let t = (text ?? "").trimmingCharacters(in: .whitespaces)
        if t.range(of: #"^\d{1,3}(?:\.\d+)?$"#, options: .regularExpression) != nil, let b = Double(t), b <= 360 {
            return b.truncatingRemainder(dividingBy: 360)
        }
        return ["N": 0.0, "E": 90, "S": 180, "W": 270][directionCode(t) ?? ""]
    }

    static func axis(_ code: String) -> String { code == "N" || code == "S" ? "NS" : "EW" }

    /// Is a reported direction not the way the route runs at `d`? A report in the same pair as the road's signed
    /// direction (southbound on a road signed north and south) is compared with that sign: I-95 in Delaware and
    /// I-295 in New Jersey are signed north and south while they run east and west, where the map alone cannot
    /// tell the carriageways apart. Otherwise (the New Jersey Turnpike reads west on the map but is signed south,
    /// or a bearing) the way the route actually runs decides, within `directionAngle`. Same as roadintel.js.
    static func otherDirection(_ route: PlannedRoute, _ text: String?, _ d: Double, _ rules: Rules) -> Bool {
        guard let dir = directionBearing(text) else { return false }
        if let code = directionCode(text), code != "both", let signed = route.highway(at: d)?.direction.rawValue, axis(code) == axis(signed) {
            return code != signed
        }
        return Geodesy.angleDifference(dir, travelBearing(route, d)) >= rules.directionAngle
    }

    /// The direction is given (a direction, a bearing, or both directions).
    static func directionGiven(_ text: String?) -> Bool {
        directionCode(text) != nil || directionBearing(text) != nil
    }

    static func placePoint(_ c: GeoCoordinate, _ i: Incident, _ route: PlannedRoute, _ progress: Double, _ rules: Rules) -> Placement {
        let given = directionGiven(i.direction)
        var best: Double?
        var why = "off route"
        let named = !roadRefs(i.road).isEmpty || !namedRoads(i.road).isEmpty
        for p in route.polyline.projections(of: c, within: named ? rules.sameRoadOffset : rules.unnamedOffset) {
            if p.distanceAlong < progress { why = "behind"; continue }
            if !onSameRoad(route, i, p.distanceAlong) { why = "other road"; continue }
            if otherDirection(route, i.direction, p.distanceAlong, rules) { why = "other direction"; continue }
            if !given && p.signedOffset < -rules.otherCarriageway { why = "other direction"; continue }
            if best.map({ p.distanceAlong < $0 }) ?? true { best = p.distanceAlong }
        }
        guard let best else { return .rejected(why) }
        return .ahead(start: best, end: best, directionKnown: given)
    }

    static func placeLine(_ cs: [GeoCoordinate], _ i: Incident, _ route: PlannedRoute, _ progress: Double, _ rules: Rules) -> Placement {
        let along = cs.compactMap { route.polyline.nearestProjection(of: $0, within: rules.lineOffset)?.distanceAlong }
        guard along.count >= min(2, cs.count), let start = along.min(), let end = along.max() else { return .rejected("off route") }
        if end < progress { return .rejected("behind") }
        let mid = (start + end) / 2
        if !onSameRoad(route, i, mid) { return .rejected("other road") }
        let given = directionGiven(i.direction)
        if otherDirection(route, i.direction, mid, rules) { return .rejected("other direction") }
        if !given, cs.count >= 2,
           Geodesy.angleDifference(Geodesy.initialBearing(cs[0], cs[cs.count - 1]), route.polyline.bearing(at: mid)) > rules.lineBearing {
            return .rejected("other direction")
        }
        return .ahead(start: max(start, progress), end: end, directionKnown: given || cs.count >= 2)
    }

    static func placeArea(_ rings: [[GeoCoordinate]], _ route: PlannedRoute, _ progress: Double, _ rules: Rules) -> Placement {
        func inside(_ d: Double) -> Bool { rings.contains { inRing(route.polyline.coordinate(at: d), $0) } }
        // Bisects between an outside and an inside position, to about 10 m.
        func edge(_ outside: Double, _ inside0: Double) -> Double {
            var out = outside, inn = inside0
            while abs(inn - out) > 10 { let mid = (out + inn) / 2; if inside(mid) { inn = mid } else { out = mid } }
            return inn
        }
        var start: Double?, end: Double?
        var last = progress
        let stop = min(route.polyline.length, progress + rules.window)
        var d = progress
        while d <= stop {
            if inside(d) {
                if start == nil { start = d == progress ? d : edge(last, d) }
                end = d
            } else if let e = end {
                end = edge(d, e)
                break
            }
            last = d
            d += rules.areaStep
        }
        guard let start, let end else { return .rejected("off route") }
        return .ahead(start: start, end: end, directionKnown: true)
    }

    static func inRing(_ c: GeoCoordinate, _ ring: [GeoCoordinate]) -> Bool {
        var inside = false
        var b = ring.count - 1
        for a in 0..<ring.count {
            let (xa, ya, xb, yb) = (ring[a].longitude, ring[a].latitude, ring[b].longitude, ring[b].latitude)
            if (ya > c.latitude) != (yb > c.latitude), c.longitude < (xb - xa) * (c.latitude - ya) / (yb - ya) + xa { inside.toggle() }
            b = a
        }
        return inside
    }

    // MARK: Deduplication and status

    static let verificationOrder: [Verification: Int] = [.official: 0, .measured: 1, .community: 2, .mapped: 3]
    static let severityOrder: [Severity: Int] = [.severe: 0, .major: 1, .moderate: 2, .minor: 3, .unknown: 4]

    /// One alert per real event: same family of kinds, same direction, overlapping or within `duplicate`.
    /// The one kept is the best verified, then the most severe (it carries lane details), then the latest.
    public static func dedupe(_ alerts: [Alert], rules: Rules = Rules()) -> [Alert] {
        func before(_ a: Alert, _ b: Alert) -> Bool {
            let va = verificationOrder[a.incident.verification]!, vb = verificationOrder[b.incident.verification]!
            if va != vb { return va < vb }
            let sa = severityOrder[a.incident.severity]!, sb = severityOrder[b.incident.severity]!
            if sa != sb { return sa < sb }
            let ua = a.incident.updatedAt ?? .distantPast, ub = b.incident.updatedAt ?? .distantPast
            if ua != ub { return ua > ub }
            return a.incident.id < b.incident.id
        }
        var kept: [Alert] = []
        for a in alerts.sorted(by: before) {
            if let k = kept.firstIndex(where: { sameEvent($0, a, rules) }) {
                if !kept[k].sources.contains(a.incident.source) { kept[k].sources.append(a.incident.source) }
                continue
            }
            var first = a
            first.sources = [a.incident.source]
            kept.append(first)
        }
        return kept.sorted { $0.start != $1.start ? $0.start < $1.start : $0.incident.kind.rank < $1.incident.kind.rank }
    }

    static func sameEvent(_ a: Alert, _ b: Alert, _ rules: Rules) -> Bool {
        func family(_ k: Kind) -> String { [.crash, .disabledVehicle, .hazard].contains(k) ? "incident" : k.rawValue }
        guard family(a.incident.kind) == family(b.incident.kind) else { return false }
        if let da = directionCode(a.incident.direction), let db = directionCode(b.incident.direction),
           da != "both", db != "both", da != db { return false }
        return a.start <= b.end + rules.duplicate && b.start <= a.end + rules.duplicate
    }

    /// Alerts on the route ahead and a status for each Settings group.
    /// - Parameters:
    ///   - enabled: groups switched off in Settings are left out (missing means on).
    ///   - etaAt: arrival time at a distance along the route; events that end before you arrive are left out.
    public static func evaluate(route: PlannedRoute, progress: Double, providers: [Provider], now: Date,
                                enabled: [Group: Bool] = [:], rules: Rules = Rules(), etaAt: ((Double) -> Date)? = nil) -> Result {
        var matched: [Alert] = []
        var expired = Set<Group>()
        for p in providers where p.isFresh(at: now) {
            for i in p.incidents {
                let group = i.kind.group
                if enabled[group] == false { continue }
                guard case let .ahead(start, end, known, approximate) = place(i, on: route, progress: progress, rules: rules),
                      start - progress <= rules.window else { continue }
                let at = etaAt?(start) ?? now
                if !i.isCurrent(at: now) || (i.endsAt.map { $0 <= at } ?? false) { expired.insert(group); continue }
                if let s = i.startsAt, let etaAt, s > etaAt(end) { continue }
                matched.append(Alert(incident: i, start: start, end: end, ahead: start - progress, directionKnown: known,
                                     approximate: approximate, serious: i.isSerious, sources: []))
            }
        }
        let alerts = dedupe(matched, rules: rules)
        var status: [Group: GroupStatus] = [:]
        for g in Group.allCases {
            status[g] = groupStatus(g, providers: providers, alerts: alerts, expired: expired.contains(g), enabled: enabled, now: now)
        }
        return Result(alerts: alerts, status: status)
    }

    static func groupStatus(_ g: Group, providers: [Provider], alerts: [Alert], expired: Bool, enabled: [Group: Bool], now: Date) -> GroupStatus {
        if enabled[g] == false { return GroupStatus(state: .off, note: nil) }
        let covering = providers.filter { !$0.kinds.isDisjoint(with: g.kinds) }
        if covering.isEmpty || covering.allSatisfy({ $0.state == .notConfigured }) { return GroupStatus(state: .notConfigured, note: nil) }
        if covering.allSatisfy({ $0.state == .unsupported || $0.state == .notConfigured }) { return GroupStatus(state: .unsupported, note: nil) }
        let usable = covering.filter { $0.isFresh(at: now) }
        let failed = covering.filter { $0.state == .error || ($0.state == .ok && !$0.isFresh(at: now)) }
        var uncovered: [String] = []
        for s in usable.flatMap(\.uncovered) where !uncovered.contains(s) { uncovered.append(s) }
        let coverageNote = uncovered.isEmpty ? nil : "No coverage in \(uncovered.joined(separator: ", "))"
        let failedNote = failed.isEmpty ? nil : "\(failed.map(\.name).joined(separator: ", ")) unavailable"
        if alerts.contains(where: { g.kinds.contains($0.incident.kind) }) { return GroupStatus(state: .ok, note: failedNote ?? coverageNote) }
        // Never an "all clear" while a source that covers this group failed or has not answered yet.
        if failed.isEmpty && covering.contains(where: { $0.state == .pending }) { return GroupStatus(state: .loading, note: nil) }
        if usable.isEmpty || !failed.isEmpty { return GroupStatus(state: .unavailable, note: failedNote) }
        if expired { return GroupStatus(state: .expired, note: nil) }
        return GroupStatus(state: .noRelevant, note: coverageNote)
    }

    /// "Reported 6 minutes ago", "Updated 2 h ago".
    public static func freshnessText(_ i: Incident, now: Date) -> String {
        guard let t = i.updatedAt ?? i.reportedAt else { return "Time not reported" }
        let min = max(0, Int((now.timeIntervalSince(t) / 60).rounded()))
        let ago = min < 1 ? "just now" : min < 60 ? "\(min) \(min == 1 ? "minute" : "minutes") ago" : "\(Int((Double(min) / 60).rounded())) h ago"
        let updated = i.updatedAt != nil && i.reportedAt != nil && i.updatedAt != i.reportedAt
        return "\(updated ? "Updated" : "Reported") \(ago)"
    }
}

extension RoadIntel.Result {
    /// The alert the Drive screen considers: the first serious one within 50 miles, else the nearest. Work
    /// zones that leave the travel lanes open, and weather advisories the driver is already in, stay in Road
    /// Ahead (same rule as driveCardAlert in roadintel.js).
    public func focusAlert(progress: Double) -> RoadIntel.Alert? {
        let shown = alerts.filter { $0.onDriveCard(progress: progress) }
        return shown.first { $0.serious && $0.start - progress <= 50 * Geodesy.metersPerMile } ?? shown.first
    }
}
