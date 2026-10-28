import Foundation

/// Road Trip Passport: states driven and achievements, from real GPS trips only. Port of
/// web/js/engine/passport.js (same achievements and thresholds).
public struct Passport: Sendable {
    public struct Trip: Sendable {
        public var startedAt: Date
        public var totalMeters: Double
        public var states: [(code: String?, name: String, meters: Double)]

        public init(startedAt: Date, totalMeters: Double, states: [(code: String?, name: String, meters: Double)]) {
            self.startedAt = startedAt
            self.totalMeters = totalMeters
            self.states = states
        }
    }

    public struct StateStamp: Sendable, Hashable, Identifiable {
        public let code: String
        public let name: String
        public var meters: Double
        public var trips: Int
        public var firstAt: Date
        public var lastAt: Date
        public var id: String { code }
    }

    public struct Achievement: Sendable, Hashable, Identifiable {
        public let id: String
        public let title: String
        public let detail: String
        public let earned: Bool
        public let progress: Double
    }

    public static let lower48 = ["AL", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY", "LA",
                                 "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
                                 "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
                                 "WI", "WY"]
    /// The 50 states and DC, for the passport grid.
    public static let stateCodes = (lower48 + ["AK", "HI", "DC"]).sorted()
    static let atlantic: Set<String> = ["ME", "NH", "MA", "RI", "CT", "NY", "NJ", "DE", "MD", "VA", "NC", "SC", "GA", "FL"]
    static let pacific: Set<String> = ["CA", "OR", "WA"]

    public let stamps: [String: StateStamp]
    public let totalMeters: Double
    public let tripCount: Int
    public let achievements: [Achievement]

    public init(trips: [Trip]) {
        var stamps: [String: StateStamp] = [:]
        var total = 0.0
        var longest = 0.0
        var most = 0
        for t in trips {
            total += t.totalMeters
            longest = max(longest, t.totalMeters)
            var count = 0
            for s in t.states {
                guard let code = s.code, s.meters > 0 else { continue }
                count += 1
                if var e = stamps[code] {
                    e.meters += s.meters
                    e.trips += 1
                    e.firstAt = min(e.firstAt, t.startedAt)
                    e.lastAt = max(e.lastAt, t.startedAt)
                    stamps[code] = e
                } else {
                    stamps[code] = StateStamp(code: code, name: s.name, meters: s.meters, trips: 1, firstAt: t.startedAt, lastAt: t.startedAt)
                }
            }
            most = max(most, count)
        }
        self.stamps = stamps
        totalMeters = total
        tripCount = trips.count
        let codes = Set(stamps.keys)
        let miles = Int((total / Geodesy.metersPerMile).rounded(.down))
        func tier(_ id: String, _ title: String, _ have: Int, _ need: Int, _ unit: String) -> Achievement {
            let f = NumberFormatter()
            f.numberStyle = .decimal
            f.locale = Locale(identifier: "en_US")
            let shown = f.string(from: NSNumber(value: min(have, need))) ?? "\(min(have, need))"
            let target = f.string(from: NSNumber(value: need)) ?? "\(need)"
            return Achievement(id: id, title: title, detail: "\(shown) of \(target) \(unit)", earned: have >= need,
                               progress: need > 0 ? min(1, Double(have) / Double(need)) : 0)
        }
        let atlantic = !codes.isDisjoint(with: Self.atlantic), pacific = !codes.isDisjoint(with: Self.pacific)
        achievements = [
            tier("first-trip", "First trip", trips.count, 1, "trip"),
            tier("states-5", "Five states", codes.count, 5, "states"),
            tier("states-10", "Ten states", codes.count, 10, "states"),
            tier("states-25", "Half the country", codes.count, 25, "states"),
            tier("lower-48", "All lower 48", codes.intersection(Self.lower48).count, 48, "states"),
            tier("miles-1000", "1,000 miles", miles, 1000, "miles"),
            tier("miles-10000", "10,000 miles", miles, 10000, "miles"),
            tier("long-haul", "Long haul: 500 miles in one trip", Int((longest / Geodesy.metersPerMile).rounded(.down)), 500, "miles"),
            tier("border-hopper", "Border hopper: 5 states in one trip", most, 5, "states"),
            Achievement(id: "coast-to-coast", title: "Coast to coast", detail: "An Atlantic state and a Pacific state",
                        earned: atlantic && pacific, progress: (atlantic ? 0.5 : 0) + (pacific ? 0.5 : 0)),
        ]
    }
}
