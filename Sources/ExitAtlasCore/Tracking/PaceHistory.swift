import Foundation

/// The driver's moving pace on earlier trips, as actual and modeled seconds per trip. The prior for a
/// new trip is the ratio over the last 20 trips, once they add up to at least 30 modeled minutes.
/// Keep one history per travel time model (MapKit and OSRM model speeds differently).
public struct PaceHistory: Sendable, Codable, Hashable {
    public struct Trip: Sendable, Codable, Hashable {
        public var key: String
        public var observedSeconds: Double
        public var expectedSeconds: Double
    }

    public static let maxTrips = 20
    public private(set) var trips: [Trip] = []

    public init() {}

    /// Adds or updates the record for a trip (most recent first).
    public mutating func record(key: String, pace: PaceModel) {
        guard pace.expectedSeconds > 0 else { return }
        trips.removeAll { $0.key == key }
        trips.insert(Trip(key: key, observedSeconds: pace.observedSeconds, expectedSeconds: pace.expectedSeconds), at: 0)
        if trips.count > Self.maxTrips { trips.removeLast(trips.count - Self.maxTrips) }
    }

    /// The usual pace relative to the model, excluding one trip (the one in progress); 1 without enough history.
    public func priorFactor(excluding key: String? = nil) -> Double {
        var o = 0.0, e = 0.0
        for t in trips where t.key != key {
            o += t.observedSeconds
            e += t.expectedSeconds
        }
        return e >= 1800 ? PaceModel.clamp(o / e) : 1
    }

    /// Hours of driving the prior is based on.
    public var hours: Double { trips.reduce(0) { $0 + $1.observedSeconds } / 3600 }
}
