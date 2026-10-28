import Foundation

/// Geodesic math on the WGS84 ellipsoid.
///
/// Route mileage uses Vincenty's inverse formula per polyline segment (sub millimeter
/// accuracy for road segments). Point to segment projection uses a local tangent plane
/// scaled by the ellipsoid radii of curvature, which is accurate to well under a meter
/// at the distances involved (GPS fix to nearby road).
public enum Geodesy {
    public static let semiMajorAxis = 6_378_137.0
    public static let flattening = 1 / 298.257223563
    public static let semiMinorAxis = semiMajorAxis * (1 - flattening)
    public static let eccentricitySquared = flattening * (2 - flattening)
    public static let metersPerMile = 1609.344

    // MARK: Distances

    /// Ellipsoidal distance in meters (Vincenty inverse, haversine fallback for the rare
    /// nearly antipodal non convergence case, which cannot occur for road segments).
    public static func distance(_ a: GeoCoordinate, _ b: GeoCoordinate) -> Double {
        if a == b { return 0 }
        return vincentyDistance(a, b) ?? haversineDistance(a, b)
    }

    public static func haversineDistance(_ a: GeoCoordinate, _ b: GeoCoordinate) -> Double {
        let r = 6_371_008.8
        let p1 = a.latitude * .pi / 180, p2 = b.latitude * .pi / 180
        let dp = p2 - p1
        let dl = (b.longitude - a.longitude) * .pi / 180
        let h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * r * asin(min(1, sqrt(h)))
    }

    static func vincentyDistance(_ p: GeoCoordinate, _ q: GeoCoordinate) -> Double? {
        let a = semiMajorAxis, b = semiMinorAxis, f = flattening
        let L = (q.longitude - p.longitude) * .pi / 180
        let U1 = atan((1 - f) * tan(p.latitude * .pi / 180))
        let U2 = atan((1 - f) * tan(q.latitude * .pi / 180))
        let sinU1 = sin(U1), cosU1 = cos(U1), sinU2 = sin(U2), cosU2 = cos(U2)
        var lambda = L
        var iterations = 0
        var sinSigma = 0.0, cosSigma = 0.0, sigma = 0.0, cosSqAlpha = 0.0, cos2SigmaM = 0.0
        while true {
            let sinLambda = sin(lambda), cosLambda = cos(lambda)
            let t1 = cosU2 * sinLambda
            let t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
            sinSigma = sqrt(t1 * t1 + t2 * t2)
            if sinSigma == 0 { return 0 }
            cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
            sigma = atan2(sinSigma, cosSigma)
            let sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma
            cosSqAlpha = 1 - sinAlpha * sinAlpha
            cos2SigmaM = cosSqAlpha != 0 ? cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha : 0
            let C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha))
            let previous = lambda
            lambda = L + (1 - C) * f * sinAlpha
                * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
            iterations += 1
            if abs(lambda - previous) < 1e-12 { break }
            if iterations > 200 { return nil }
        }
        let uSq = cosSqAlpha * (a * a - b * b) / (b * b)
        let A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
        let B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
        let deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
            - B / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
        return b * A * (sigma - deltaSigma)
    }

    // MARK: Bearings

    /// Initial bearing in degrees clockwise from true north, in [0, 360).
    public static func initialBearing(_ a: GeoCoordinate, _ b: GeoCoordinate) -> Double {
        let p1 = a.latitude * .pi / 180, p2 = b.latitude * .pi / 180
        let dl = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dl) * cos(p2)
        let x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
        return normalizedDegrees(atan2(y, x) * 180 / .pi)
    }

    public static func normalizedDegrees(_ value: Double) -> Double {
        let r = value.truncatingRemainder(dividingBy: 360)
        return r < 0 ? r + 360 : r
    }

    /// Smallest absolute difference between two bearings, in [0, 180].
    public static func angleDifference(_ a: Double, _ b: Double) -> Double {
        let d = abs(normalizedDegrees(a) - normalizedDegrees(b))
        return d > 180 ? 360 - d : d
    }

    // MARK: Local plane

    public static func metersPerDegreeLatitude(at latitude: Double) -> Double {
        let s = sin(latitude * .pi / 180)
        let w = 1 - eccentricitySquared * s * s
        let m = semiMajorAxis * (1 - eccentricitySquared) / (w * sqrt(w))
        return m * .pi / 180
    }

    public static func metersPerDegreeLongitude(at latitude: Double) -> Double {
        let phi = latitude * .pi / 180
        let s = sin(phi)
        let n = semiMajorAxis / sqrt(1 - eccentricitySquared * s * s)
        return n * cos(phi) * .pi / 180
    }

    /// Point at a distance and bearing from a start point (local plane, valid for short distances).
    public static func offset(_ c: GeoCoordinate, bearing: Double, meters: Double) -> GeoCoordinate {
        let theta = bearing * .pi / 180
        let north = meters * cos(theta), east = meters * sin(theta)
        return GeoCoordinate(latitude: c.latitude + north / metersPerDegreeLatitude(at: c.latitude),
                             longitude: c.longitude + east / metersPerDegreeLongitude(at: c.latitude))
    }
}

/// Local east/north meters around an origin. Used for projections over short distances.
struct LocalFrame {
    let origin: GeoCoordinate
    let metersPerLat: Double
    let metersPerLon: Double

    init(origin: GeoCoordinate) {
        self.origin = origin
        metersPerLat = Geodesy.metersPerDegreeLatitude(at: origin.latitude)
        metersPerLon = Geodesy.metersPerDegreeLongitude(at: origin.latitude)
    }

    @inline(__always)
    func project(_ c: GeoCoordinate) -> (x: Double, y: Double) {
        ((c.longitude - origin.longitude) * metersPerLon, (c.latitude - origin.latitude) * metersPerLat)
    }
}
