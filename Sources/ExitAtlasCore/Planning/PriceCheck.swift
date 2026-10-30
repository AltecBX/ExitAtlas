import Foundation

/// Links to official consumer pages where a driver can see a station's posted price themselves (docs/17).
/// ExitAtlas opens them and never reads or copies prices from them. Same links as web/js/engine/pricecheck.js.
public enum PriceCheck {
    public static let states: [String: String] = [
        "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
        "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
        "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
        "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
        "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
        "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
        "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
        "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    ]

    /// "New York" -> "new-york", "St. Mary's" -> "st-marys".
    public static func slug(_ text: String?) -> String {
        let folded = (text ?? "").folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US")).lowercased()
        let cleaned = folded.filter { !"'’.".contains($0) }
        var out = ""
        var dash = false
        for ch in cleaned {
            if ch.isASCII && (ch.isLetter || ch.isNumber) {
                if dash && !out.isEmpty { out.append("-") }
                out.append(ch)
                dash = false
            } else {
                dash = true
            }
        }
        return out
    }

    /// The characters JavaScript's encodeURIComponent leaves alone.
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

    /// The brand (or name) near the station on Google Maps (a documented Maps URLs search).
    public static func googleMaps(name: String, brand: String, latitude: Double, longitude: Double) -> String {
        let what = (brand.isEmpty ? (name.isEmpty ? "gas station" : name) : brand).trimmingCharacters(in: .whitespaces)
        let query = "\(what) \(String(format: "%.5f", latitude)),\(String(format: "%.5f", longitude))"
        return "https://www.google.com/maps/search/?api=1&query=" + (query.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")
    }

    /// GasBuddy's price page for the city, else the state; nil when the state is not known. state: a two
    /// letter code or a full name.
    public static func gasBuddy(city: String?, state: String?) -> String? {
        guard let state else { return nil }
        let name = states[state.uppercased()] ?? state
        guard states.values.contains(name) else { return nil }
        let c = slug(city)
        return "https://www.gasbuddy.com/gasprices/\(slug(name))" + (c.isEmpty ? "" : "/\(c)")
    }
}
