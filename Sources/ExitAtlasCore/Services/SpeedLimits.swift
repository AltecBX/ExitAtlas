import Foundation

/// Posted speed limits along the route from OpenStreetMap `maxspeed`, via a Valhalla
/// `trace_attributes` request (the same scheme as the web version, web/js/app/limits.js).
///
/// The route is sampled every 100 m and fetched in 80 km chunks just ahead of the driver, so a whole
/// trip costs about one request per 50 miles. This type holds the table and builds and reads the
/// requests; the app does the networking, backoff and retries.
public struct SpeedLimitTable: Sendable {
    public static let step = 100.0
    public static let chunkMeters = 80_000.0
    public static let prefetchMeters = 2 * chunkMeters
    public static let endpoint = URL(string: "https://valhalla1.openstreetmap.de/trace_attributes")!

    public enum State: Sendable { case known, unknown, loading }

    /// Sample indexes `first...last` along the route.
    public struct Chunk: Sendable, Hashable {
        public let first: Int
        public let last: Int
    }

    static let notFetched: Int16 = -2
    static let unknown: Int16 = -1

    public let routeLength: Double
    private var mph: [Int16]

    public init(routeLength: Double) {
        self.routeLength = routeLength
        mph = Array(repeating: Self.notFetched, count: Int(routeLength / Self.step) + 1)
    }

    func index(_ d: Double) -> Int {
        min(mph.count - 1, max(0, Int((d / Self.step).rounded())))
    }

    /// Posted limit in mph at a distance along the route, or nil when unknown or not loaded yet.
    public func limit(at d: Double) -> Int? {
        let v = mph[index(d)]
        return v >= 0 ? Int(v) : nil
    }

    public func state(at d: Double) -> State {
        let v = mph[index(d)]
        return v >= 0 ? .known : v == Self.unknown ? .unknown : .loading
    }

    /// The next different known limit within `within` meters ahead.
    public func nextChange(after d: Double, within: Double = 3218) -> (mph: Int, distance: Double)? {
        let i0 = index(d), current = mph[i0]
        let last = min(mph.count - 1, index(d + within))
        guard i0 + 1 <= last else { return nil }
        for i in (i0 + 1)...last {
            let v = mph[i]
            if v >= 0, v != current { return (Int(v), Double(i) * Self.step - d) }
        }
        return nil
    }

    /// The next chunk still missing within the prefetch window ahead of `d`, or nil.
    public func missingChunk(ahead d: Double) -> Chunk? {
        let start = index(d), end = index(d + Self.prefetchMeters)
        guard let first = (start...end).first(where: { mph[$0] == Self.notFetched }) else { return nil }
        return Chunk(first: first, last: min(mph.count - 1, first + Int(Self.chunkMeters / Self.step)))
    }

    /// JSON body for a chunk (send as `text/plain` from a browser to avoid a CORS preflight).
    public func requestBody(for chunk: Chunk, polyline: RoutePolyline) -> Data {
        let shape: [[String: Double]] = (chunk.first...chunk.last).map { i in
            let c = polyline.coordinate(at: min(Double(i) * Self.step, routeLength))
            return ["lat": (c.latitude * 1e6).rounded() / 1e6, "lon": (c.longitude * 1e6).rounded() / 1e6]
        }
        let body: [String: Any] = [
            "shape": shape, "costing": "auto", "shape_match": "map_snap", "units": "miles",
            "filters": ["attributes": ["edge.speed_limit", "matched.edge_index", "matched.type"], "action": "include"],
        ]
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
    }

    public enum ApplyResult: Sendable, Equatable {
        case applied
        /// The server could not match the shape (errors 443 and 444): marked unknown, not asked again.
        case unmatchable
        /// Anything else: try again later.
        case failed(String)
    }

    /// Reads a trace_attributes response for a chunk.
    public mutating func apply(response data: Data, httpStatus: Int, for chunk: Chunk) -> ApplyResult {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard (200..<300).contains(httpStatus), let json else {
            if let code = json?["error_code"] as? Int, code == 443 || code == 444 {
                for i in chunk.first...chunk.last { mph[i] = Self.unknown }
                return .unmatchable
            }
            return .failed((json?["error"] as? String) ?? "HTTP \(httpStatus)")
        }
        let edges = json["edges"] as? [[String: Any]] ?? []
        let points = json["matched_points"] as? [[String: Any]] ?? []
        for k in 0...(chunk.last - chunk.first) {
            var value = Self.unknown
            if k < points.count, (points[k]["type"] as? String) != "unmatched",
               let e = points[k]["edge_index"] as? Int, e >= 0, e < edges.count,
               let v = (edges[e]["speed_limit"] as? NSNumber)?.doubleValue, v > 0, v < 100 {
                value = Int16(v.rounded())
            }
            mph[chunk.first + k] = value
        }
        return .applied
    }
}
