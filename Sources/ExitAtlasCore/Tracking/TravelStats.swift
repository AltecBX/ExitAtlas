import Foundation

/// Travel statistics from the trip history (real GPS trips only): miles and trips per state, and totals.
/// No achievements, badges or state collecting. Port of web/js/engine/travels.js.
public struct TravelStats: Sendable {
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

    public struct State: Sendable, Hashable, Identifiable {
        public let code: String
        public let name: String
        public var meters: Double
        public var trips: Int
        public var firstAt: Date
        public var lastAt: Date
        public var id: String { code }
    }

    /// Most miles first.
    public let states: [State]
    public let totalMeters: Double
    public let tripCount: Int

    public init(trips: [Trip]) {
        var byCode: [String: State] = [:]
        var total = 0.0
        for t in trips {
            total += t.totalMeters
            for s in t.states {
                guard let code = s.code, s.meters > 0 else { continue }
                if var e = byCode[code] {
                    e.meters += s.meters
                    e.trips += 1
                    e.firstAt = min(e.firstAt, t.startedAt)
                    e.lastAt = max(e.lastAt, t.startedAt)
                    byCode[code] = e
                } else {
                    byCode[code] = State(code: code, name: s.name, meters: s.meters, trips: 1, firstAt: t.startedAt, lastAt: t.startedAt)
                }
            }
        }
        states = byCode.values.sorted { ($0.meters, $1.code) > ($1.meters, $0.code) }
        totalMeters = total
        tripCount = trips.count
    }
}
