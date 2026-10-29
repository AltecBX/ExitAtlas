import Foundation

/// Converters from provider formats to the Road Intelligence schema. Pure functions, tested on real captured
/// responses; fetching, caching and retries live in the app. Port of web/js/engine/alertsources.js.
public enum AlertSources {
    /// National Weather Service events that matter on the road, and the kind each becomes. Marine, beach,
    /// air quality, frost and heat products are left out; watches are left out (favorable, not occurring).
    public static let nwsEvents: [String: RoadIntel.Kind] = [
        "Tornado Warning": .weather, "Severe Thunderstorm Warning": .weather, "Snow Squall Warning": .weather,
        "Blizzard Warning": .weather, "Ice Storm Warning": .weather, "Winter Storm Warning": .weather,
        "Winter Weather Advisory": .weather, "Dense Fog Advisory": .weather, "Freezing Fog Advisory": .weather,
        "High Wind Warning": .weather, "Wind Advisory": .weather, "Dust Storm Warning": .weather,
        "Blowing Dust Warning": .weather, "Hurricane Warning": .weather, "Tropical Storm Warning": .weather,
        "Extreme Wind Warning": .weather,
        "Flash Flood Warning": .flooding, "Flood Warning": .flooding, "Coastal Flood Warning": .flooding,
    ]

    static let nwsSeverity: [String: RoadIntel.Severity] = ["Extreme": .severe, "Severe": .major, "Moderate": .moderate, "Minor": .minor]
    public static let nwsSource = RoadIntel.Source(id: "nws", name: "National Weather Service")

    static func date(_ v: JSONValue?) -> Date? {
        guard let s = v?.string else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }

    /// NWS alerts returned by point queries along the route, as incidents. An alert returned at several
    /// points is one incident. An alert with a polygon keeps it; a zone or county alert (no polygon) is placed
    /// at the points where NWS returned it.
    public static func nwsIncidents(_ responses: [(point: GeoCoordinate, features: [JSONValue])]) -> [RoadIntel.Incident] {
        var order: [String] = []
        var byID: [String: RoadIntel.Incident] = [:]
        for (point, features) in responses {
            for f in features {
                guard let p = f["properties"], let event = p["event"]?.string, let kind = nwsEvents[event],
                      p["status"]?.string == "Actual" else { continue }
                let id = "nws:\(p["id"]?.string ?? f["id"]?.string ?? event)"
                if var known = byID[id] {
                    if case .points(var cs) = known.geometry {
                        cs.append(point)
                        known.geometry = .points(cs)
                        byID[id] = known
                    }
                    continue
                }
                var incident = RoadIntel.Incident(
                    id: id, kind: kind, description: event, source: nwsSource, verification: .official,
                    reportedAt: date(p["sent"]), updatedAt: date(p["sent"]), startsAt: date(p["onset"]) ?? date(p["effective"]),
                    endsAt: date(p["ends"]) ?? date(p["expires"]), expiresAt: date(p["expires"]),
                    geometry: nwsGeometry(f["geometry"]) ?? .points([point]), road: nil, direction: "both",
                    severity: nwsSeverity[p["severity"]?.string ?? ""] ?? .unknown)
                incident.detail = p["headline"]?.string
                incident.area = p["areaDesc"]?.string
                order.append(id)
                byID[id] = incident
            }
        }
        return order.compactMap { byID[$0] }
    }

    static func nwsGeometry(_ g: JSONValue?) -> RoadIntel.Geometry? {
        func ring(_ v: JSONValue) -> [GeoCoordinate] {
            (v.array ?? []).compactMap { pt in
                guard let a = pt.array, a.count >= 2, let lon = a[0].number, let lat = a[1].number else { return nil }
                return GeoCoordinate(latitude: lat, longitude: lon)
            }
        }
        switch g?["type"]?.string {
        case "Polygon":
            guard let outer = g?["coordinates"]?.array?.first else { return nil }
            return .polygon([ring(outer)])
        case "MultiPolygon":
            return .polygon((g?["coordinates"]?.array ?? []).compactMap { $0.array?.first.map(ring) })
        default:
            return nil
        }
    }

    // MARK: Work zones (WZDx)

    /// A work zone feed (WZDx) that needs no key and states a CC0 license in its feed_info, checked 2026-10-28
    /// (docs/13). `cors`: a browser can read it directly (the web app reads the others through the key proxy).
    /// `large`: over 1 MB, refreshed less often. `njdot`: road_names holds the cross streets, so the road,
    /// direction, start time and lanes come from the description.
    public struct WZDxFeed: Sendable {
        public let name: String
        public let url: URL
        public let cors: Bool
        public var large = false
        var njdot = false
        var zone: String?
    }

    /// Same table as WZDX_FEEDS in web/js/engine/alertsources.js (the reasons for the states left out are there).
    public static let wzdxFeeds: [String: WZDxFeed] = [
        "DE": WZDxFeed(name: "DelDOT", url: URL(string: "https://wzdx.e-dot.com/del_dot_feed_wzdx_v4.1.geojson")!, cors: true),
        "IN": WZDxFeed(name: "INDOT", url: URL(string: "https://in.carsprogram.org/carsapi_v1/api/wzdx")!, cors: true, large: true),
        "KY": WZDxFeed(name: "KYTC", url: URL(string: "https://storage.googleapis.com/kytc-its-2020-openrecords/public/feeds/WZDx/kytc_wzdx_v4.1.geojson")!, cors: false),
        "LA": WZDxFeed(name: "LADOTD", url: URL(string: "https://wzdx.e-dot.com/la_dot_d_feed_wzdx_v4.1.geojson")!, cors: true),
        "MD": WZDxFeed(name: "MDOT SHA", url: URL(string: "https://filter.ritis.org/wzdx_v4.1/mdot.geojson")!, cors: false),
        "MN": WZDxFeed(name: "MnDOT", url: URL(string: "https://mn.carsprogram.org/carsapi_v1/api/wzdx")!, cors: false),
        "MO": WZDxFeed(name: "MoDOT", url: URL(string: "https://traveler.modot.org/timconfig/feed/desktop/mo_wzdx.json")!, cors: false, large: true),
        "MS": WZDxFeed(name: "MDOT Mississippi", url: URL(string: "https://api.mdottraffic.com/prod/v3/data/wzdx")!, cors: true),
        "ND": WZDxFeed(name: "NDDOT", url: URL(string: "https://travelfiles.dot.nd.gov/geojson_nc/wzdx_geojson.json")!, cors: true),
        "NJ": WZDxFeed(name: "NJDOT", url: URL(string: "https://smartworkzones.njit.edu/nj/wzdx")!, cors: false, njdot: true, zone: "America/New_York"),
        "WA": WZDxFeed(name: "WSDOT", url: URL(string: "https://wzdx.wsdot.wa.gov/api/v4/WorkZoneFeed")!, cors: true),
        "WI": WZDxFeed(name: "WisDOT", url: URL(string: "https://511wi.gov/api/wzdx")!, cors: false, large: true),
    ]

    public static let wzdxKinds: Set<RoadIntel.Kind> = [.closure, .construction]

    public static func wzdxSource(_ state: String) -> RoadIntel.Source {
        RoadIntel.Source(id: "wzdx-\(state)", name: "\(wzdxFeeds[state]?.name ?? state) work zones")
    }

    /// A feed's bytes as JSON; one feed sends its JSON inside a JSON string.
    public static func parseWZDx(_ data: Data) throws -> JSONValue {
        let body = try JSONValue(data: data)
        if let inner = body.string { return try JSONValue(data: Data(inner.utf8)) }
        return body
    }

    /// When the publisher last updated the whole feed (feed_info.update_date), or nil.
    public static func wzdxUpdatedAt(_ body: JSONValue) -> Date? {
        validDate((body["feed_info"] ?? body["road_event_feed_info"])?["update_date"])
    }

    public static func wzdxIncidents(_ data: Data, state: String) throws -> [RoadIntel.Incident] {
        wzdxIncidents(try parseWZDx(data), state: state)
    }

    /// A feed's work zones as incidents. Detours and features without a location are left out.
    public static func wzdxIncidents(_ body: JSONValue, state: String) -> [RoadIntel.Incident] {
        let feed = wzdxFeeds[state]
        let source = wzdxSource(state)
        var out: [RoadIntel.Incident] = []
        for f in body["features"]?.array ?? [] {
            guard let p = f["properties"], let core = p["core_details"], core["event_type"]?.string == "work-zone",
                  let geometry = wzdxGeometry(f["geometry"]) else { continue }
            let words = (core["description"]?.string ?? "").components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
            let text = words.isEmpty ? nil : words.joined(separator: " ")
            let nj = feed?.njdot == true ? njdotDetails(text, zone: feed?.zone) : nil
            let impact = nj?.impact ?? wzdxImpact(p)
            let direction = core["direction"]?.string.flatMap { $0 == "unknown" || $0 == "undefined" || $0.isEmpty ? nil : $0 }
            out.append(RoadIntel.Incident(
                id: "wzdx:\(state):\(idText(f["id"]) ?? String(out.count))", kind: impact.closed ? .closure : .construction,
                description: text ?? "Work zone", source: source, verification: .official,
                reportedAt: validDate(core["creation_date"]),
                updatedAt: validDate(core["update_date"]) ?? validDate(p["worker_presence"]?["worker_presence_last_confirmed_date"]),
                startsAt: nj?.startsAt ?? validDate(p["start_date"]), endsAt: validDate(p["end_date"]), expiresAt: nil,
                geometry: geometry, road: nj != nil ? nj?.road : roadNames(core["road_names"], state: state),
                direction: nj?.direction ?? direction, lanes: nj != nil ? nj?.lanes : impact.lanes, severity: impact.severity))
        }
        return out
    }

    static func idText(_ v: JSONValue?) -> String? {
        if let s = v?.string { return s }
        if let n = v?.number { return n == n.rounded() ? String(Int(n)) : String(n) }
        return nil
    }

    /// ISO 8601 with a zone, fractions of a second dropped (feeds send up to 7 digits). Dates before 2000 are
    /// placeholders some feeds send ("0001-01-01").
    static func validDate(_ v: JSONValue?) -> Date? {
        guard let s = v?.string?.trimmingCharacters(in: .whitespaces),
              let m = captures("^(\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d)(?:\\.\\d+)?(Z|[+-]\\d\\d:\\d\\d)$", in: s),
              let date = ISO8601DateFormatter().date(from: (m[1] ?? "") + (m[2] ?? "")) else { return nil }
        return date.timeIntervalSince1970 > 946_684_800 ? date : nil
    }

    /// LineString as a line; MultiPoint as a point (one) or a line from start to end (two or more).
    static func wzdxGeometry(_ g: JSONValue?) -> RoadIntel.Geometry? {
        let list: [GeoCoordinate] = (g?["coordinates"]?.array ?? []).compactMap { pt in
            guard let a = pt.array, a.count >= 2, let lon = a[0].number, let lat = a[1].number else { return nil }
            return GeoCoordinate(latitude: lat, longitude: lon)
        }
        switch g?["type"]?.string {
        case "LineString" where list.count >= 2: return .line(list)
        case "MultiPoint" where list.count == 1: return .point(list[0])
        case "MultiPoint" where list.count >= 2: return .line([list[0], list[list.count - 1]])
        default: return nil
        }
    }

    /// "SR1 Southbound", "MD42", "US50", "I95" as "DE 1", "MD 42", "US 50", "I 95" so the highway parser reads
    /// them. A two letter prefix that is not this state, US or I (a county "CO140") stays as it is, and so does a
    /// lettered route ("MD3BU", business MD 3, becomes "MD 3BU", which no highway matches).
    static func roadNames(_ names: JSONValue?, state: String) -> String? {
        var out: [String] = []
        for raw in names?.array ?? [] {
            var n = (raw.string ?? "").replacingOccurrences(of: "\\s+(north|south|east|west)bound$", with: "",
                                                            options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if n.isEmpty || n.lowercased() == "no name" { continue }
            n = n.replacingOccurrences(of: "^(?:SR|SH|STATE ROUTE|STATE HWY|RT|ROUTE)\\s*-?\\s*(\\d+[A-Z]?)\\b", with: "\(state) $1",
                                       options: [.regularExpression, .caseInsensitive])
            if let m = captures("^([A-Z]{1,2})-?(\\d+)([A-Z]*)$", in: n, options: .caseInsensitive),
               let prefix = m[1]?.uppercased(), [state, "US", "I"].contains(prefix) {
                n = "\(prefix) \(m[2] ?? "")\(m[3] ?? "")"
            }
            if !out.contains(n) { out.append(n) }
        }
        return out.isEmpty ? nil : out.joined(separator: " / ")
    }

    struct Impact { var closed: Bool; var severity: RoadIntel.Severity; var lanes: String? }

    static let someClosed: Set<String> = ["some-lanes-closed", "some-lanes-closed-merge-left", "some-lanes-closed-merge-right", "some-lanes-closed-split"]

    /// Closure, severity and a lane summary from vehicle_impact and the lanes list.
    static func wzdxImpact(_ p: JSONValue) -> Impact {
        let lanes = p["lanes"]?.array ?? []
        let general = lanes.filter { $0["type"]?.string == "general" }
        let closed = general.filter { $0["status"]?.string == "closed" }.count
        var text: String?
        if !general.isEmpty && closed == general.count { text = "All lanes closed" }
        else if closed > 0 { text = "\(closed) of \(general.count) lanes closed" }
        else if lanes.contains(where: { $0["type"]?.string == "shoulder" && $0["status"]?.string == "closed" }) { text = "Shoulder closed" }
        else if lanes.contains(where: { ($0["status"]?.string ?? "").hasPrefix("shift") || ($0["status"]?.string ?? "").hasPrefix("merge") }) { text = "Lane shift" }
        let v = p["vehicle_impact"]?.string ?? ""
        if v == "all-lanes-closed" { return Impact(closed: true, severity: .major, lanes: "All lanes closed") }
        // Some feeds count a closed shoulder as a closed lane; a lanes list with every travel lane open wins.
        if someClosed.contains(v) { return Impact(closed: false, severity: !general.isEmpty && closed == 0 ? .minor : .moderate, lanes: text) }
        if v == "alternating-one-way" { return Impact(closed: false, severity: .moderate, lanes: "Alternating one way traffic") }
        if v == "all-lanes-open" { return Impact(closed: false, severity: .minor, lanes: text ?? "All lanes open") }
        // Unknown impact: only what the lanes list says.
        if !general.isEmpty && closed == general.count { return Impact(closed: true, severity: .major, lanes: text) }
        return Impact(closed: false, severity: closed > 0 ? .moderate : .unknown, lanes: text)
    }

    struct NJDetails { var road: String?; var direction: String?; var startsAt: Date?; var lanes: String?; var impact: Impact }

    static let weekday = "(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)"
    static let months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

    /// NJDOT text: "NJDOT - STMC: Roadwork on I-287 Northbound between A and B, Friday October 30, 2026 12:00 AM
    /// thru Saturday October 31, 2026 12:00 AM, at least one lane closed". Its start_date is when the entry
    /// was made, so the start comes from the text (local time in `zone`).
    static func njdotDetails(_ text: String?, zone: String?) -> NJDetails {
        let s = text ?? ""
        let on = captures("\\bon (.+?)\\s+(?:(northbound|southbound|eastbound|westbound|both directions)\\b|(?=(?:near|between|at)\\b))",
                          in: s, options: .caseInsensitive)
        let whenPattern = "\(weekday) ([A-Za-z]+) (\\d{1,2}), (\\d{4}) (\\d{1,2}):(\\d\\d) ([AP]M)(?: thru (?:\(weekday) [A-Za-z]+ \\d{1,2}, \\d{4} )?\\d{1,2}:\\d\\d [AP]M)?"
        let when = match(whenPattern, in: s)
        var startsAt: Date?
        if let when, let m = when.groups, let month = months.firstIndex(of: (m[1] ?? "").lowercased()),
           let day = Int(m[2] ?? ""), let year = Int(m[3] ?? ""), let h = Int(m[4] ?? ""), let minute = Int(m[5] ?? "") {
            startsAt = zonedDate(year: year, month: month, day: day, hour: h % 12 + (m[6] == "PM" ? 12 : 0), minute: minute,
                                 zone: zone ?? "America/New_York")
        }
        // Lane details follow the schedule (or the last place name in parentheses when there is no schedule).
        let ns = s as NSString
        let cut = when.map { $0.range.location + $0.range.length } ?? (ns.range(of: ")", options: .backwards).location == NSNotFound
                                                                         ? 0 : ns.range(of: ")", options: .backwards).location + 1)
        let after = cut > 0 ? ns.substring(from: cut) : ""
        var tail = after
        while let c = tail.first, c == "," || c.isWhitespace { tail.removeFirst() }
        tail = tail.trimmingCharacters(in: .whitespacesAndNewlines)
        let clauses = tail.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let closed = !clauses.isEmpty && clauses.allSatisfy { $0.range(of: "all lanes closed", options: .caseInsensitive) != nil }
        let has = { (p: String) in tail.range(of: p, options: [.regularExpression, .caseInsensitive]) != nil }
        let severity: RoadIntel.Severity = closed ? .major : has("lanes? closed|alternating") ? .moderate
            : has("shoulder|all lanes open") ? .minor : .unknown
        let lanes = tail.isEmpty ? nil : String((tail.prefix(1).uppercased() + tail.dropFirst()).prefix(140))
        return NJDetails(road: on?[1]?.trimmingCharacters(in: .whitespaces), direction: on?[2], startsAt: startsAt, lanes: lanes,
                         impact: Impact(closed: closed, severity: severity, lanes: nil))
    }

    /// A wall clock time in an IANA zone as a date (the zone's offset at that moment, DST included).
    public static func zonedDate(year: Int, month: Int, day: Int, hour: Int, minute: Int, zone: String) -> Date? {
        var cal = Calendar(identifier: .gregorian)
        guard let tz = TimeZone(identifier: zone) else { return nil }
        cal.timeZone = tz
        return cal.date(from: DateComponents(year: year, month: month + 1, day: day, hour: hour, minute: minute))
    }

    /// The first match's capture groups (index 0 is the whole match; a group that did not take part is nil).
    static func captures(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [String?]? {
        match(pattern, in: text, options: options)?.groups
    }

    static func match(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> (range: NSRange, groups: [String?]?)? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        let ns = text as NSString
        let groups: [String?] = (0..<m.numberOfRanges).map { k in
            let r = m.range(at: k)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        return (m.range, groups)
    }
}
