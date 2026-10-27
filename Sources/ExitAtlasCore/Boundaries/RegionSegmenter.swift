import Foundation

/// One continuous stretch of the route inside a single region (state or time zone).
public struct RegionSegment: Sendable, Codable, Hashable, Identifiable {
    /// Position of the segment along the route, starting at 0.
    public let index: Int
    /// Region code ("FL"), or nil when the route is outside every region (for example in Canada).
    public let code: String?
    public let name: String
    public let startDistance: Double
    public let endDistance: Double
    /// 1 for the first time the route is in this region, 2 when it re-enters, and so on.
    public let visit: Int
    /// True when the stretch is shorter than the brief threshold (default 1 mile).
    public let isBrief: Bool
    public let entryCoordinate: GeoCoordinate
    public let exitCoordinate: GeoCoordinate

    public var id: Int { index }
    public var length: Double { endDistance - startDistance }
    public var displayName: String { code == nil ? "Outside U.S. states" : name }
}

/// Total route distance in one region across all of its visits.
public struct RegionTotal: Sendable, Hashable, Identifiable {
    public let code: String?
    public let name: String
    public let length: Double
    public let visits: Int
    public var id: String { code ?? "-" }
}

/// Ordered region segments along a route.
public struct RegionProfile: Sendable, Codable, Hashable {
    public let segments: [RegionSegment]
    public let routeLength: Double

    public init(segments: [RegionSegment], routeLength: Double) {
        self.segments = segments
        self.routeLength = routeLength
    }

    /// Index of the segment containing a distance along the route.
    public func segmentIndex(at distance: Double) -> Int? {
        guard !segments.isEmpty else { return nil }
        if distance <= segments[0].startDistance { return 0 }
        var lo = 0, hi = segments.count - 1
        while lo < hi {
            let mid = (lo + hi + 1) / 2
            if segments[mid].startDistance <= distance { lo = mid } else { hi = mid - 1 }
        }
        return lo
    }

    public func segment(at distance: Double) -> RegionSegment? {
        segmentIndex(at: distance).map { segments[$0] }
    }

    /// Distances along the route where the region changes.
    public var crossings: [Double] { segments.dropFirst().map(\.startDistance) }

    /// Per region totals in order of first appearance.
    public var totals: [RegionTotal] {
        var order: [String?] = []
        var lengths: [String: Double] = [:], visits: [String: Int] = [:], names: [String: String] = [:]
        for s in segments {
            let key = s.code ?? "-"
            if lengths[key] == nil { order.append(s.code) }
            lengths[key, default: 0] += s.length
            visits[key, default: 0] += 1
            names[key] = s.displayName
        }
        return order.map { code in
            let key = code ?? "-"
            return RegionTotal(code: code, name: names[key] ?? key, length: lengths[key] ?? 0, visits: visits[key] ?? 0)
        }
    }
}

/// Splits a route polyline into ordered region segments using exact boundary crossings.
///
/// The route is walked segment by segment. Where a route segment crosses a boundary edge
/// the crossing parameter is computed exactly and each resulting piece is classified with a
/// point-in-polygon test at its midpoint. Segments with no crossings inherit the current
/// region, so the cost is proportional to the route length plus the number of crossings.
public struct RegionSegmenter: Sendable {
    /// Stretches shorter than this are flagged `isBrief` (still reported).
    public var briefThreshold: Double
    /// A-B-A sandwiches with a middle piece shorter than this are treated as boundary noise
    /// and merged (default 50 m). Gaps outside every region shorter than this are absorbed too.
    public var noiseThreshold: Double

    public init(briefThreshold: Double = Geodesy.metersPerMile, noiseThreshold: Double = 50) {
        self.briefThreshold = briefThreshold
        self.noiseThreshold = noiseThreshold
    }

    struct Piece {
        var region: Int?
        var start: Double
        var end: Double
        var entry: GeoCoordinate
        var exit: GeoCoordinate
        var length: Double { end - start }
    }

    public func segment(_ route: RoutePolyline, regions: RegionIndex) -> RegionProfile {
        var pieces: [Piece] = []
        let first = route.points[0]
        var current = regions.region(containing: first)?.id
        pieces.append(Piece(region: current, start: 0, end: 0, entry: first, exit: first))

        for i in 0..<route.segmentCount {
            let a = route.points[i], b = route.points[i + 1]
            let d0 = route.cumulativeDistances[i], d1 = route.cumulativeDistances[i + 1]
            let ts = regions.boundaryCrossings(from: a, to: b)
            if ts.isEmpty {
                pieces[pieces.count - 1].end = d1
                pieces[pieces.count - 1].exit = b
                continue
            }
            var bounds = [0.0]
            for t in ts where t > 0 && t < 1 { bounds.append(t) }
            bounds.append(1)
            for k in 0..<(bounds.count - 1) {
                let t0 = bounds[k], t1 = bounds[k + 1]
                guard t1 > t0 else { continue }
                let mid = RoutePolyline.lerp(a, b, (t0 + t1) / 2)
                let region = regions.region(containing: mid)?.id
                let start = d0 + (d1 - d0) * t0, end = d0 + (d1 - d0) * t1
                let p0 = RoutePolyline.lerp(a, b, t0), p1 = RoutePolyline.lerp(a, b, t1)
                if region == current {
                    pieces[pieces.count - 1].end = end
                    pieces[pieces.count - 1].exit = p1
                } else {
                    pieces.append(Piece(region: region, start: start, end: end, entry: p0, exit: p1))
                    current = region
                }
            }
        }
        pieces = cleaned(pieces)

        var visits: [Int: Int] = [:]
        var outsideVisits = 0
        var segments: [RegionSegment] = []
        for (index, p) in pieces.enumerated() {
            let visit: Int
            if let r = p.region {
                visits[r, default: 0] += 1
                visit = visits[r]!
            } else {
                outsideVisits += 1
                visit = outsideVisits
            }
            let region = p.region.map { regions.regions[$0] }
            segments.append(RegionSegment(
                index: index, code: region?.code, name: region?.name ?? "Outside U.S. states",
                startDistance: p.start, endDistance: p.end, visit: visit,
                isBrief: p.length < briefThreshold, entryCoordinate: p.entry, exitCoordinate: p.exit))
        }
        return RegionProfile(segments: segments, routeLength: route.length)
    }

    /// Removes zero length pieces, boundary noise sandwiches and tiny gaps outside every region.
    func cleaned(_ input: [Piece]) -> [Piece] {
        var pieces = input.filter { $0.length > 0 || input.count == 1 }
        if pieces.isEmpty { pieces = Array(input.prefix(1)) }
        var changed = true
        while changed && pieces.count > 1 {
            changed = false
            var i = 0
            while i < pieces.count {
                let p = pieces[i]
                guard p.length < noiseThreshold, pieces.count > 1 else { i += 1; continue }
                let prev = i > 0 ? pieces[i - 1] : nil
                let next = i + 1 < pieces.count ? pieces[i + 1] : nil
                if let prev, let next, prev.region == next.region {
                    // A, tiny B, A: merge all three.
                    pieces[i - 1].end = next.end
                    pieces[i - 1].exit = next.exit
                    pieces.removeSubrange(i...(i + 1))
                    changed = true
                } else if p.region == nil || prev == nil || next == nil {
                    // Tiny unclassified gap, or a tiny piece at either end of the route.
                    if prev != nil {
                        pieces[i - 1].end = p.end
                        pieces[i - 1].exit = p.exit
                    } else if next != nil {
                        pieces[i + 1].start = p.start
                        pieces[i + 1].entry = p.entry
                    }
                    pieces.remove(at: i)
                    changed = true
                } else {
                    i += 1
                }
            }
            // Merge neighbors that became identical.
            var merged: [Piece] = []
            for p in pieces {
                if let last = merged.last, last.region == p.region {
                    merged[merged.count - 1].end = p.end
                    merged[merged.count - 1].exit = p.exit
                } else {
                    merged.append(p)
                }
            }
            pieces = merged
        }
        return pieces
    }
}
