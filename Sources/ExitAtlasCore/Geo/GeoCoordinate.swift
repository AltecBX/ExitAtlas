import Foundation

/// WGS84 latitude and longitude in degrees.
public struct GeoCoordinate: Hashable, Codable, Sendable, CustomStringConvertible {
    public var latitude: Double
    public var longitude: Double

    public init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    public var isValid: Bool {
        latitude.isFinite && longitude.isFinite && abs(latitude) <= 90 && abs(longitude) <= 180
    }

    public var description: String {
        String(format: "(%.6f, %.6f)", latitude, longitude)
    }
}

/// Axis aligned latitude/longitude box. Routes in this app never cross the antimeridian
/// (US states only, Alaska and Hawaii included), so a simple min/max box is sufficient.
public struct GeoBoundingBox: Hashable, Codable, Sendable {
    public var minLatitude: Double
    public var minLongitude: Double
    public var maxLatitude: Double
    public var maxLongitude: Double

    public init(minLatitude: Double, minLongitude: Double, maxLatitude: Double, maxLongitude: Double) {
        self.minLatitude = minLatitude
        self.minLongitude = minLongitude
        self.maxLatitude = maxLatitude
        self.maxLongitude = maxLongitude
    }

    public init?(_ coordinates: [GeoCoordinate]) {
        guard let first = coordinates.first else { return nil }
        var box = GeoBoundingBox(minLatitude: first.latitude, minLongitude: first.longitude,
                                 maxLatitude: first.latitude, maxLongitude: first.longitude)
        for c in coordinates.dropFirst() { box.include(c) }
        self = box
    }

    public mutating func include(_ c: GeoCoordinate) {
        minLatitude = min(minLatitude, c.latitude)
        maxLatitude = max(maxLatitude, c.latitude)
        minLongitude = min(minLongitude, c.longitude)
        maxLongitude = max(maxLongitude, c.longitude)
    }

    public func contains(_ c: GeoCoordinate) -> Bool {
        c.latitude >= minLatitude && c.latitude <= maxLatitude
            && c.longitude >= minLongitude && c.longitude <= maxLongitude
    }

    public func intersects(_ other: GeoBoundingBox) -> Bool {
        !(other.minLatitude > maxLatitude || other.maxLatitude < minLatitude
            || other.minLongitude > maxLongitude || other.maxLongitude < minLongitude)
    }

    /// Expands the box by a distance in meters on every side.
    public func expanded(byMeters meters: Double) -> GeoBoundingBox {
        let midLat = (minLatitude + maxLatitude) / 2
        let dLat = meters / Geodesy.metersPerDegreeLatitude(at: midLat)
        let lonScale = Geodesy.metersPerDegreeLongitude(at: max(abs(minLatitude), abs(maxLatitude)))
        let dLon = meters / max(lonScale, 1)
        return GeoBoundingBox(minLatitude: minLatitude - dLat, minLongitude: minLongitude - dLon,
                              maxLatitude: maxLatitude + dLat, maxLongitude: maxLongitude + dLon)
    }
}
