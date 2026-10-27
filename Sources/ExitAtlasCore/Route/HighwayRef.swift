import Foundation

/// A highway designation parsed from provider text ("I 95", "Merge onto I-95 N", "US 17").
public struct HighwayRef: Sendable, Codable, Hashable, CustomStringConvertible {
    public enum Kind: String, Sendable, Codable {
        case interstate, usRoute, stateRoute, named
    }

    public let kind: Kind
    /// "I", "US", "FL", "SR"; empty for named roads.
    public let prefix: String
    /// "95", "35E"; the road name for named roads ("Florida's Turnpike").
    public let number: String

    public init(kind: Kind, prefix: String, number: String) {
        self.kind = kind
        self.prefix = prefix
        self.number = number
    }

    public var description: String {
        kind == .named ? number : "\(prefix)-\(number)"
    }

    /// Numeric part of the route number ("35" for "35E").
    public var numericValue: Int? { Int(number.prefix { $0.isNumber }) }

    private static let stateCodes: Set<String> = [
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
        "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
        "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
        "SR", "CR", "PR",
    ]

    /// All highway designations found in a string, in order of appearance, without duplicates.
    public static func parse(_ text: String) -> [HighwayRef] {
        var found: [(Int, HighwayRef)] = []
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        func scan(_ pattern: String, _ make: (NSTextCheckingResult) -> HighwayRef?) {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { return }
            for m in regex.matches(in: text, range: full) {
                if let ref = make(m) { found.append((m.range.location, ref)) }
            }
        }
        scan(#"\b(?:I|Interstate)[- ]?(\d{1,3}[A-Z]?)\b"#) { m in
            HighwayRef(kind: .interstate, prefix: "I", number: ns.substring(with: m.range(at: 1)))
        }
        scan(#"\bUS[- ]?(\d{1,3}[A-Z]?)\b"#) { m in
            HighwayRef(kind: .usRoute, prefix: "US", number: ns.substring(with: m.range(at: 1)))
        }
        scan(#"\b([A-Z]{2})[- ](\d{1,4}[A-Z]?)\b"#) { m in
            let prefix = ns.substring(with: m.range(at: 1))
            guard stateCodes.contains(prefix), prefix != "US" else { return nil }
            return HighwayRef(kind: .stateRoute, prefix: prefix, number: ns.substring(with: m.range(at: 2)))
        }
        scan(#"(?i)\b((?:[A-Z][\w']*\s){0,3}Turnpike|NJTP|Parkway|Expressway|Thruway)\b"#) { m in
            let name = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            return HighwayRef(kind: .named, prefix: "", number: name == "NJTP" ? "New Jersey Turnpike" : name)
        }
        found.sort { $0.0 < $1.0 }
        var out: [HighwayRef] = []
        for (_, ref) in found where !out.contains(ref) { out.append(ref) }
        return out
    }
}

public enum CardinalDirection: String, Sendable, Codable {
    case north = "N", south = "S", east = "E", west = "W"

    public var word: String {
        switch self {
        case .north: return "North"
        case .south: return "South"
        case .east: return "East"
        case .west: return "West"
        }
    }

    /// Signed direction of travel for a highway at a point on the route.
    ///
    /// Interstates follow the national convention: odd numbers are signed north/south, even
    /// numbers east/west. The sign comes from net displacement over the next 25 km of route,
    /// so local curves do not flip it. Other roads use the dominant axis of displacement.
    public static func signed(for ref: HighwayRef?, along route: RoutePolyline, at distance: Double,
                              window: Double = 25_000) -> CardinalDirection {
        var start = distance, end = min(route.length, distance + window)
        if end - start < window / 2 { start = max(0, end - window) }
        if end <= start { end = min(route.length, start + 1) }
        let a = route.coordinate(at: start), b = route.coordinate(at: end)
        let north = (b.latitude - a.latitude) * Geodesy.metersPerDegreeLatitude(at: a.latitude)
        let east = (b.longitude - a.longitude) * Geodesy.metersPerDegreeLongitude(at: a.latitude)
        if let ref, ref.kind == .interstate, let n = ref.numericValue {
            // Three digit interstates take the parity of their last two digits for signage.
            let base = n % 100
            return base % 2 == 1 ? (north >= 0 ? .north : .south) : (east >= 0 ? .east : .west)
        }
        if abs(north) >= abs(east) { return north >= 0 ? .north : .south }
        return east >= 0 ? .east : .west
    }
}

/// Highway with its signed direction, for display ("I-95 N").
public struct SignedHighway: Sendable, Hashable {
    public let ref: HighwayRef
    public let direction: CardinalDirection
    public var shortLabel: String { "\(ref) \(direction.rawValue)" }
}
