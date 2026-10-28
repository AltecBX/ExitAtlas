import Foundation

/// Google encoded polyline format (used by Google Routes API, OSRM and Valhalla).
public enum EncodedPolyline {
    /// Decodes an encoded polyline. Precision is 5 for Google, 6 for OSRM polyline6 and Valhalla.
    public static func decode(_ encoded: String, precision: Int = 5) -> [GeoCoordinate]? {
        let factor = pow(10.0, Double(precision))
        var coordinates: [GeoCoordinate] = []
        var lat = 0, lon = 0
        var bytes = Array(encoded.utf8)[...]
        func next() -> Int? {
            var result = 0, shift = 0
            while let byte = bytes.first {
                bytes = bytes.dropFirst()
                let chunk = Int(byte) - 63
                guard chunk >= 0 else { return nil }
                result |= (chunk & 0x1F) << shift
                shift += 5
                if chunk < 0x20 {
                    return (result & 1) != 0 ? ~(result >> 1) : (result >> 1)
                }
            }
            return nil
        }
        while !bytes.isEmpty {
            guard let dLat = next(), let dLon = next() else { return nil }
            lat += dLat
            lon += dLon
            coordinates.append(GeoCoordinate(latitude: Double(lat) / factor, longitude: Double(lon) / factor))
        }
        return coordinates
    }

    public static func encode(_ coordinates: [GeoCoordinate], precision: Int = 5) -> String {
        let factor = pow(10.0, Double(precision))
        var out = ""
        var lastLat = 0, lastLon = 0
        func append(_ value: Int) {
            var v = value < 0 ? ~(value << 1) : (value << 1)
            while v >= 0x20 {
                out.unicodeScalars.append(UnicodeScalar(UInt8((0x20 | (v & 0x1F)) + 63)))
                v >>= 5
            }
            out.unicodeScalars.append(UnicodeScalar(UInt8(v + 63)))
        }
        for c in coordinates {
            let lat = Int((c.latitude * factor).rounded()), lon = Int((c.longitude * factor).rounded())
            append(lat - lastLat)
            append(lon - lastLon)
            lastLat = lat
            lastLon = lon
        }
        return out
    }
}
