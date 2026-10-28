import Foundation

/// Opening hours: the OpenStreetMap format (the common subset) and Google Places periods, read into one
/// weekly table, and whether a place is open at a local time. Port of web/js/engine/openinghours.js,
/// tested on the same fixtures (Tests/ExitAtlasCoreTests/Fixtures/smartstop/opening_hours.json).
///
/// Read: "24/7"; weekday lists and ranges (Mo-Fr, Sa,Su, Fr-Mo); times with a closing time after
/// midnight (22:00-02:00, 06:00-24:00); "off" or "closed"; rules separated by ";" (a later rule replaces
/// earlier ones on its days) or by "," before a weekday (an added rule). Public and school holidays
/// (PH, SH) are not known here: a rule only for them is skipped and `holidays` is set. Anything else
/// (months, dates, weeks, sunrise, open ends like "18:00+", comments) does not parse, and the hours
/// count as unknown rather than guessed.
public struct OpeningHours: Sendable, Equatable {
    public struct Span: Sendable, Equatable {
        public var start: Int
        /// May pass 1440: open past midnight.
        public var end: Int
    }

    /// Monday first.
    public var week: [[Span]]
    /// The text has rules for public or school holidays only, which are not applied.
    public var holidays: Bool

    static let days = ["mo", "tu", "we", "th", "fr", "sa", "su"]
    static let dayToken = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)"
    static let selector = try! NSRegularExpression(
        pattern: "^(\(dayToken)(?:-\(dayToken))?(?:\\s*,\\s*\(dayToken)(?:-\(dayToken))?)*)(?:\\s+|$)", options: .caseInsensitive)
    static let time = try! NSRegularExpression(pattern: "^(\\d{1,2}):(\\d{2})\\s*-\\s*(\\d{1,2}):(\\d{2})$")
    static let dayStart = try! NSRegularExpression(pattern: "^\(dayToken)\\b", options: .caseInsensitive)
    static let endsTimeOrOff = try! NSRegularExpression(pattern: "(\\d|off|closed)$", options: .caseInsensitive)

    /// OpenStreetMap opening_hours text, or nil when it does not parse.
    public init?(osm text: String?) {
        guard let text else { return nil }
        let src = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !src.isEmpty else { return nil }
        var week: [[Span]] = Array(repeating: [], count: 7)
        var holidays = false
        for ruleText in src.split(separator: ";").map({ $0.trimmingCharacters(in: .whitespaces) }) where !ruleText.isEmpty {
            var first = true
            for part in Self.addedRules(ruleText) {
                guard let rule = Self.parseRule(part) else { return nil }
                if rule.holidayOnly { holidays = true; first = false; continue }
                for d in rule.days {
                    if first { week[d] = rule.spans } else { week[d] += rule.spans }
                }
                first = false
            }
        }
        self.week = week.map { $0.sorted { $0.start < $1.start } }
        self.holidays = holidays
    }

    /// Google Places currentOpeningHours or regularOpeningHours periods. A period without a close is
    /// open around the clock.
    public init?(googlePeriods periods: [GooglePeriod]) {
        guard !periods.isEmpty else { return nil }
        var week: [[Span]] = Array(repeating: [], count: 7)
        for p in periods {
            let day = (p.open.day + 6) % 7
            let start = p.open.hour * 60 + p.open.minute
            guard let c = p.close else {
                self.week = Array(repeating: [Span(start: 0, end: 1440)], count: 7)
                self.holidays = false
                return
            }
            let cday = (c.day + 6) % 7
            var end = c.hour * 60 + c.minute + ((cday - day + 7) % 7) * 1440
            if end <= start { end += 7 * 1440 }
            week[day].append(Span(start: start, end: end))
        }
        self.week = week.map { $0.sorted { $0.start < $1.start } }
        self.holidays = false
    }

    /// Whether the hours say open on `weekday` (0 = Monday) at `minute` (0 to 1439), and how many minutes
    /// until it closes (nil when open around the clock for the next seven days).
    public func open(weekday: Int, minute: Int) -> (open: Bool, closesIn: Int?) {
        let t = weekday * 1440 + minute
        var spans: [(Int, Int)] = []
        for d in 0..<7 {
            for s in week[d] {
                // Each span as absolute minutes in a two week line so spans past Sunday midnight wrap around.
                spans.append((d * 1440 + s.start, d * 1440 + s.end))
                spans.append(((d + 7) * 1440 + s.start, (d + 7) * 1440 + s.end))
                if d * 1440 + s.end > 7 * 1440 { spans.append(((d - 7) * 1440 + s.start, (d - 7) * 1440 + s.end)) }
            }
        }
        spans.sort { $0.0 < $1.0 }
        guard let at = spans.first(where: { $0.0 <= t && t < $0.1 }) else { return (false, nil) }
        // Follow touching or overlapping spans to the real closing time.
        var end = at.1
        for (s, e) in spans where s <= end && e > end { end = e }
        return (true, end - t >= 7 * 1440 ? nil : end - t)
    }

    /// Weekday (0 = Monday) and minute of the day at a moment in a time zone.
    public static func localTime(_ date: Date, in zone: TimeZone) -> (weekday: Int, minute: Int) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let c = cal.dateComponents([.weekday, .hour, .minute], from: date)
        return (((c.weekday ?? 1) + 5) % 7, (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    // MARK: Parsing

    struct Rule {
        var days: [Int] = []
        var spans: [Span] = []
        var holidayOnly = false
    }

    /// "Mo-Fr 08:00-17:00, Sa 09:00-12:00" is two rules, the second added to the first; "Sa,Su 07:00-19:00"
    /// is one. A comma starts an added rule only after a time or "off" and before a weekday.
    static func addedRules(_ text: String) -> [String] {
        var out: [String] = []
        var start = text.startIndex
        var search = text.startIndex
        while let comma = text.range(of: ",", range: search..<text.endIndex) {
            var afterStart = comma.upperBound
            while afterStart < text.endIndex, text[afterStart].isWhitespace { afterStart = text.index(after: afterStart) }
            let before = text[start..<comma.lowerBound].trimmingCharacters(in: .whitespaces)
            let after = String(text[afterStart...])
            if matches(endsTimeOrOff, before), matches(dayStart, after) {
                out.append(before)
                start = afterStart
            }
            search = comma.upperBound
        }
        out.append(text[start...].trimmingCharacters(in: .whitespaces))
        return out
    }

    static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    static func dayIndex(_ t: String) -> Int? { days.firstIndex(of: t.lowercased()) }

    static func parseRule(_ rule: String) -> Rule? {
        if rule == "24/7" { return Rule(days: Array(0..<7), spans: [Span(start: 0, end: 1440)]) }
        var days = Array(0..<7)
        var rest = rule
        if let m = selector.firstMatch(in: rule, range: NSRange(rule.startIndex..., in: rule)),
           let all = Range(m.range, in: rule), let list = Range(m.range(at: 1), in: rule) {
            days = []
            for item in rule[list].split(separator: ",").map({ $0.trimmingCharacters(in: .whitespaces) }) {
                let ends = item.split(separator: "-").map { $0.trimmingCharacters(in: .whitespaces) }
                let a = ends[0]
                if ["ph", "sh"].contains(a.lowercased()) {
                    if ends.count > 1 { return nil }
                    continue // holidays share these hours; nothing to add for the weekdays
                }
                guard let i = dayIndex(a) else { return nil }
                guard ends.count > 1 else { days.append(i); continue }
                guard let j = dayIndex(ends[1]) else { return nil }
                var k = i
                while true {
                    days.append(k)
                    if k == j { break }
                    k = (k + 1) % 7
                }
            }
            rest = rule[all.upperBound...].trimmingCharacters(in: .whitespaces)
            if days.isEmpty { return Rule(holidayOnly: true) }
        }
        var seen = Set<Int>()
        days = days.filter { seen.insert($0).inserted }
        if rest.isEmpty { return Rule(days: days, spans: [Span(start: 0, end: 1440)]) }
        if ["off", "closed"].contains(rest.lowercased()) { return Rule(days: days, spans: []) }
        var spans: [Span] = []
        for span in rest.split(separator: ",", omittingEmptySubsequences: false).map({ $0.trimmingCharacters(in: .whitespaces) }) {
            guard let t = time.firstMatch(in: span, range: NSRange(span.startIndex..., in: span)) else { return nil }
            let n = (1...4).map { Int(span[Range(t.range(at: $0), in: span)!])! }
            let (h1, m1, h2, m2) = (n[0], n[1], n[2], n[3])
            guard h1 <= 24, h2 <= 24, m1 <= 59, m2 <= 59 else { return nil }
            let start = h1 * 60 + m1
            var end = h2 * 60 + m2
            guard start < 1440 else { return nil }
            if end <= start { end += 1440 } // closes after midnight (00:00-00:00 is the whole day)
            spans.append(Span(start: start, end: end))
        }
        return Rule(days: days, spans: spans)
    }
}

/// One Google Places opening period: days 0 (Sunday) to 6, local hours.
public struct GooglePeriod: Sendable, Codable, Hashable {
    public struct Point: Sendable, Codable, Hashable {
        public var day: Int
        public var hour: Int
        public var minute: Int

        public init(day: Int, hour: Int = 0, minute: Int = 0) {
            self.day = day
            self.hour = hour
            self.minute = minute
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            day = try c.decode(Int.self, forKey: .day)
            hour = try c.decodeIfPresent(Int.self, forKey: .hour) ?? 0
            minute = try c.decodeIfPresent(Int.self, forKey: .minute) ?? 0
        }
    }

    public var open: Point
    public var close: Point?

    public init(open: Point, close: Point? = nil) {
        self.open = open
        self.close = close
    }
}
