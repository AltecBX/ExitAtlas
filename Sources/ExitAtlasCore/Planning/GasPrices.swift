import Foundation

/// Gas prices from reports with a source and a time (docs/17): the driver's own reports on this device,
/// optional shared reports from other ExitAtlas drivers, and open station feeds licensed for reuse. Never a
/// regional average shown as a station's price, never a price made up to fill a gap, never one grade compared
/// with another. Port of web/js/engine/gasprices.js, tested on the same fixtures (Fixtures/prices).
public enum GasPrices {
    public static let grades = ["R", "M", "P", "D"]
    public static let gradeNames = ["R": "Regular", "M": "Midgrade", "P": "Premium", "D": "Diesel"]

    public struct Rules: Sendable {
        /// US pump prices outside this range (dollars per gallon) are typing mistakes or jokes.
        public var minPrice = 1.5
        public var maxPrice = 9.99
        /// Reports older than this are dropped altogether.
        public var keepDays = 7.0
        /// The same station, grade, payment and price again within this time is the same report.
        public var duplicateMinutes = 30.0
        /// Two current reports for the same station, grade and payment this far apart (dollars) conflict.
        public var conflictDollars = 0.1
        /// A report this far from the regional average (as a share of it) is not accepted.
        public var benchmarkShare = 0.5
        /// A driver may correct their own report for this long.
        public var correctMinutes = 30.0
        public init() {}
    }

    public enum Payment: String, Sendable, Codable { case cash, credit }

    public struct Source: Sendable, Codable, Equatable {
        public enum Kind: String, Sendable, Codable { case own, community, open, google }
        public var id: String
        public var name: String
        public var kind: Kind
        public init(id: String, name: String, kind: Kind) { self.id = id; self.name = name; self.kind = kind }
    }

    public struct Record: Sendable, Codable, Equatable {
        public var id: String
        public var stationId: String
        public var grade: String
        public var price: Double
        public var currency = "USD"
        /// nil when the report does not say.
        public var payment: Payment?
        /// A loyalty or member price, shown apart from the others.
        public var member = false
        /// When the price was seen.
        public var reportedAt: Date
        /// An opaque id for the device or reporter, or nil.
        public var reporter: String?
        public var source: Source

        public init(id: String, stationId: String, grade: String, price: Double, payment: Payment?, member: Bool = false,
                    reportedAt: Date, reporter: String?, source: Source) {
            self.id = id
            self.stationId = stationId
            self.grade = grade
            self.price = price
            self.payment = payment
            self.member = member
            self.reportedAt = reportedAt
            self.reporter = reporter
            self.source = source
        }
    }

    /// Checks a report before it is saved; the record has its price rounded to a tenth of a cent.
    public static func validate(_ r: Record, now: Date, benchmark: Double? = nil, rules: Rules = Rules()) -> (record: Record?, problems: [String]) {
        var problems: [String] = []
        if r.stationId.isEmpty { problems.append("station") }
        if !grades.contains(r.grade) { problems.append("grade") }
        let price = (r.price * 1000).rounded() / 1000
        if !(r.price.isFinite && price >= rules.minPrice && price <= rules.maxPrice) {
            problems.append("price out of range")
        } else if let b = benchmark, b > 0, abs(price - b) / b > rules.benchmarkShare {
            problems.append("far from the regional average")
        }
        let age = now.timeIntervalSince(r.reportedAt)
        if age < -60 || age > rules.keepDays * 86400 { problems.append("time") }
        guard problems.isEmpty else { return (nil, problems) }
        var out = r
        out.price = price
        return (out, [])
    }

    public enum State: String, Sendable { case current, old, expired }

    /// "$3.09", or "$3.099" when the price has tenths of a cent (as posted at most US pumps).
    public static func dollars(_ v: Double) -> String {
        let mills = Int((v * 1000).rounded())
        return mills % 10 != 0 ? String(format: "$%.3f", Double(mills) / 1000) : String(format: "$%.2f", Double(mills) / 1000)
    }

    /// How current a record is: current (compared), old (shown greyed, never compared), expired (dropped).
    public static func freshness(reportedAt: Date, now: Date, maxAgeHours: Double = 24, rules: Rules = Rules()) -> (state: State, text: String) {
        let age = max(0, now.timeIntervalSince(reportedAt))
        let state: State = age > rules.keepDays * 86400 ? .expired : age > maxAgeHours * 3600 ? .old : .current
        return (state, reportedText(age))
    }

    public static func reportedText(_ age: TimeInterval) -> String {
        let min = Int(age / 60)
        if min < 1 { return "Reported just now" }
        if min < 60 { return "Reported \(min) \(min == 1 ? "minute" : "minutes") ago" }
        let h = min / 60
        if h < 24 { return "Reported \(h) \(h == 1 ? "hour" : "hours") ago" }
        if h < 48 { return "Reported yesterday" }
        return "Reported \(h / 24) days ago"
    }

    static func samePrice(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.0005 }

    static func sameKind(_ a: Record, _ b: Record) -> Bool {
        a.stationId == b.stationId && a.grade == b.grade && a.payment == b.payment && a.member == b.member
    }

    /// True when `r` repeats a report already in `records` (same station, grade, payment, member flag and
    /// price within duplicateMinutes, from the same reporter or one without a reporter).
    public static func isDuplicate(_ records: [Record], _ r: Record, rules: Rules = Rules()) -> Bool {
        records.contains { x in
            sameKind(x, r) && samePrice(x.price, r.price) && abs(x.reportedAt.timeIntervalSince(r.reportedAt)) <= rules.duplicateMinutes * 60
                && (x.reporter == nil || r.reporter == nil || x.reporter == r.reporter)
        }
    }

    /// Adds a report, or replaces the reporter's own report of the same kind made within correctMinutes.
    /// Drops expired reports.
    public static func add(_ r: Record, to records: [Record], now: Date, rules: Rules = Rules()) -> [Record] {
        let kept = records.filter { now.timeIntervalSince($0.reportedAt) <= rules.keepDays * 86400 }
        if isDuplicate(kept, r, rules: rules) { return kept }
        let correcting = { (x: Record) in
            x.reporter != nil && x.reporter == r.reporter && sameKind(x, r) && r.reportedAt.timeIntervalSince(x.reportedAt) <= rules.correctMinutes * 60
        }
        return kept.filter { !correcting($0) } + [r]
    }

    public enum PaymentMatch: String, Sendable { case exact, unspecified, other }

    public struct StationPrice: Sendable {
        public let record: Record
        public let state: State
        public let text: String
        public let paymentMatch: PaymentMatch
        /// Other current reports of the same price and payment kind.
        public let confirmations: Int
        /// A current report of the same kind differs by more than conflictDollars.
        public let conflict: Bool

        /// The price it competes with: only a current one.
        public var comparable: Double? { state == .current ? record.price : nil }
    }

    /// The price to show for one station and grade (see web/js/engine/gasprices.js stationPrice). Nil: price
    /// unavailable.
    public static func stationPrice(_ records: [Record], stationId: String, grade: String, now: Date, payment: Payment = .credit,
                                    maxAgeHours: Double = 24, member: Bool = false, rules: Rules = Rules()) -> StationPrice? {
        func state(_ r: Record) -> State { freshness(reportedAt: r.reportedAt, now: now, maxAgeHours: maxAgeHours, rules: rules).state }
        let mine = records.filter { $0.stationId == stationId && $0.grade == grade && $0.member == member && state($0) != .expired }
        guard !mine.isEmpty else { return nil }
        func match(_ r: Record) -> PaymentMatch { r.payment == payment ? .exact : r.payment == nil ? .unspecified : .other }
        let rank: [PaymentMatch: Int] = [.exact: 0, .unspecified: 1, .other: 2]
        let best = mine.sorted { a, b in
            let fa = state(a) == .current, fb = state(b) == .current
            if fa != fb { return fa }
            if rank[match(a)]! != rank[match(b)]! { return rank[match(a)]! < rank[match(b)]! }
            return a.reportedAt > b.reportedAt
        }[0]
        let f = freshness(reportedAt: best.reportedAt, now: now, maxAgeHours: maxAgeHours, rules: rules)
        let peers = mine.filter { $0.id != best.id && state($0) == .current && match($0) == match(best) }
        return StationPrice(record: best, state: f.state, text: f.text, paymentMatch: match(best),
                            confirmations: f.state == .current ? peers.filter { samePrice($0.price, best.price) }.count : 0,
                            conflict: f.state == .current && peers.contains { abs($0.price - best.price) > rules.conflictDollars })
    }

    public struct FillCost: Sendable, Equatable {
        /// Bought to fill the tank.
        public let gallons: Double
        /// Burned on the detour (both ways).
        public let detourGallons: Double
        /// Both, at this pump's price.
        public let total: Double
        public var perGallon: Double { total / gallons }
    }

    /// The cost of filling up at a stop, or nil when a value it needs is unknown.
    public static func fillCost(price: Double, rangeOnArrival: Double?, tankGallons: Double?, mpg: Double?, detourMeters: Double = 0) -> FillCost? {
        guard price > 0, let tank = tankGallons, tank > 0, let mpg, mpg > 0, let range = rangeOnArrival else { return nil }
        let onArrival = max(0, range) / Geodesy.metersPerMile / mpg
        let gallons = max(0, tank - onArrival)
        guard gallons > 0 else { return nil }
        let detourGallons = max(0, detourMeters) / Geodesy.metersPerMile / mpg
        return FillCost(gallons: gallons, detourGallons: detourGallons, total: price * (gallons + detourGallons))
    }

    public struct SavingsRules: Sendable {
        /// A cheaper stop is worth mentioning when it saves at least this on a fill...
        public var minDollars = 2.0
        /// ...and at least this much per gallon.
        public var minPerGallon = 0.05
        public init() {}
    }

    public struct Side: Sendable {
        public let price: StationPrice?
        public let cost: FillCost?
        public let detourMeasured: Bool
        public init(price: StationPrice?, cost: FillCost?, detourMeasured: Bool) {
            self.price = price
            self.cost = cost
            self.detourMeasured = detourMeasured
        }
    }

    public struct Comparison: Sendable, Equatable {
        /// Dollars, positive when the other stop is cheaper.
        public let savings: Double
        public let perGallon: Double
        /// A detour was not measured.
        public let estimate: Bool
        public let meaningful: Bool
    }

    /// What stop b saves over stop a for the same fill (the gallons bought at b), each with its own detour fuel.
    /// Nil unless both prices are current and of the same payment kind (or one unspecified).
    public static func compare(_ a: Side, _ b: Side, rules: SavingsRules = SavingsRules()) -> Comparison? {
        guard let pa = a.price?.comparable, let pb = b.price?.comparable, let ca = a.cost, let cb = b.cost else { return nil }
        if let ka = a.price?.record.payment, let kb = b.price?.record.payment, ka != kb { return nil }
        let g = cb.gallons
        let savings = pa * (g + ca.detourGallons) - pb * (g + cb.detourGallons)
        let perGallon = pa - pb
        return Comparison(savings: savings, perGallon: perGallon, estimate: !a.detourMeasured || !b.detourMeasured,
                          meaningful: savings >= rules.minDollars && perGallon >= rules.minPerGallon)
    }

    public enum Sort: String, Sendable, CaseIterable {
        case recommended, price, closest, detour, brand
        public var label: String {
            switch self {
            case .recommended: return "Recommended"
            case .price: return "Lowest price"
            case .closest: return "Closest"
            case .detour: return "Shortest detour"
            case .brand: return "Favorite brand first"
            }
        }
    }

    public struct Row: Sendable {
        public let id: String
        public let ahead: Double
        public let detourMinutes: Double?
        public let brandRank: Int?
        public let recommendedRank: Int?
        public let price: StationPrice?
        public init(id: String, ahead: Double, detourMinutes: Double?, brandRank: Int?, recommendedRank: Int?, price: StationPrice?) {
            self.id = id
            self.ahead = ahead
            self.detourMinutes = detourMinutes
            self.brandRank = brandRank
            self.recommendedRank = recommendedRank
            self.price = price
        }
    }

    /// Orders stations for the Fuel comparison. A station without a current price never sorts as cheaper.
    public static func sort(_ rows: [Row], by sort: Sort) -> [Row] {
        let inf = Double.infinity
        func key(_ r: Row) -> [Double] {
            switch sort {
            case .recommended: return [r.recommendedRank.map(Double.init) ?? inf, r.ahead]
            case .price: return [r.price?.comparable ?? inf, r.ahead]
            case .closest: return [r.ahead]
            case .detour: return [r.detourMinutes ?? inf, r.ahead]
            case .brand: return [r.brandRank.map(Double.init) ?? inf, r.ahead]
            }
        }
        return rows.sorted { a, b in
            let ka = key(a), kb = key(b)
            for (x, y) in zip(ka, kb) where x != y { return x < y }
            return a.id < b.id
        }
    }

    /// EIA's weekly retail price regions (PADD) by state, for the regional average shown as context.
    static let padd: [String: [String]] = [
        "1A": ["CT", "ME", "MA", "NH", "RI", "VT"],
        "1B": ["DE", "DC", "MD", "NJ", "NY", "PA"],
        "1C": ["FL", "GA", "NC", "SC", "VA", "WV"],
        "2": ["IL", "IN", "IA", "KS", "KY", "MI", "MN", "MO", "NE", "ND", "SD", "OH", "OK", "TN", "WI"],
        "3": ["AL", "AR", "LA", "MS", "NM", "TX"],
        "4": ["CO", "ID", "MT", "UT", "WY"],
        "5": ["AK", "AZ", "CA", "HI", "NV", "OR", "WA"],
    ]

    public static func paddFor(_ state: String) -> String? {
        padd.first { $0.value.contains(state) }?.key
    }
}
