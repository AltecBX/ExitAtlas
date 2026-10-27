import Foundation

/// A point projected onto a polyline.
public struct PolylineProjection: Sendable, Equatable {
    /// Index of the segment (points[i] to points[i + 1]).
    public let segmentIndex: Int
    /// Position within the segment, 0...1.
    public let fraction: Double
    /// Meters from the start of the polyline to the projected point, along the polyline.
    public let distanceAlong: Double
    /// Unsigned meters between the query point and the polyline.
    public let offset: Double
    /// Positive when the query point is to the right of the direction of travel.
    public let signedOffset: Double
    public let point: GeoCoordinate
    /// Bearing of the segment in degrees.
    public let bearing: Double
}

/// Ordered route geometry with cumulative ellipsoidal distances and a segment index.
///
/// All "miles along the route" values in the app come from `cumulativeDistances`,
/// never from straight lines between the driver and a target.
public struct RoutePolyline: Sendable {
    public let points: [GeoCoordinate]
    public let cumulativeDistances: [Double]
    public let boundingBox: GeoBoundingBox
    let grid: SpatialGrid

    public var length: Double { cumulativeDistances.last ?? 0 }
    public var segmentCount: Int { max(points.count - 1, 0) }

    public init(points rawPoints: [GeoCoordinate], gridCellDegrees: Double = 0.01) {
        var pts: [GeoCoordinate] = []
        pts.reserveCapacity(rawPoints.count)
        for p in rawPoints where p.isValid {
            if pts.last != p { pts.append(p) }
        }
        precondition(!pts.isEmpty, "a route polyline needs at least one valid coordinate")
        var cumulative = [0.0]
        cumulative.reserveCapacity(pts.count)
        var grid = SpatialGrid(cellSizeDegrees: gridCellDegrees)
        for i in 0..<(pts.count - 1) {
            cumulative.append(cumulative[i] + Geodesy.distance(pts[i], pts[i + 1]))
            grid.insertSegment(Int32(i), from: pts[i], to: pts[i + 1])
        }
        points = pts
        cumulativeDistances = cumulative
        boundingBox = GeoBoundingBox(pts)!
        self.grid = grid
    }

    // MARK: Lookup by distance

    /// Segment index containing a distance along the route (clamped to the route).
    public func segmentIndex(containing distance: Double) -> Int {
        guard segmentCount > 0 else { return 0 }
        if distance <= 0 { return 0 }
        if distance >= length { return segmentCount - 1 }
        var lo = 0, hi = cumulativeDistances.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if cumulativeDistances[mid] <= distance { lo = mid } else { hi = mid }
        }
        return min(lo, segmentCount - 1)
    }

    public func coordinate(at distance: Double) -> GeoCoordinate {
        guard segmentCount > 0 else { return points[0] }
        let i = segmentIndex(containing: distance)
        let d0 = cumulativeDistances[i], d1 = cumulativeDistances[i + 1]
        let t = d1 > d0 ? min(max((distance - d0) / (d1 - d0), 0), 1) : 0
        return Self.lerp(points[i], points[i + 1], t)
    }

    /// Bearing of travel at a distance, measured over a short window to smooth vertex noise.
    public func bearing(at distance: Double, window: Double = 25) -> Double {
        guard segmentCount > 0 else { return 0 }
        let a = coordinate(at: max(0, distance - window))
        let b = coordinate(at: min(length, distance + window))
        if a == b {
            let i = segmentIndex(containing: distance)
            return Geodesy.initialBearing(points[i], points[i + 1])
        }
        return Geodesy.initialBearing(a, b)
    }

    // MARK: Projection

    public func project(_ c: GeoCoordinate, ontoSegment i: Int) -> PolylineProjection {
        let a = points[i], b = points[i + 1]
        let frame = LocalFrame(origin: a)
        let pb = frame.project(b), pc = frame.project(c)
        let lenSq = pb.x * pb.x + pb.y * pb.y
        var t = lenSq > 0 ? (pc.x * pb.x + pc.y * pb.y) / lenSq : 0
        t = min(max(t, 0), 1)
        let dx = pc.x - t * pb.x, dy = pc.y - t * pb.y
        let offset = (dx * dx + dy * dy).squareRoot()
        let cross = pb.x * pc.y - pb.y * pc.x  // > 0 means left of travel (east/north frame)
        let segLen = cumulativeDistances[i + 1] - cumulativeDistances[i]
        return PolylineProjection(
            segmentIndex: i, fraction: t, distanceAlong: cumulativeDistances[i] + t * segLen,
            offset: offset, signedOffset: cross > 0 ? -offset : offset,
            point: Self.lerp(a, b, t), bearing: Geodesy.initialBearing(a, b))
    }

    /// Indices of segments whose bounding boxes come within `radius` meters of the box.
    public func candidateSegments(near box: GeoBoundingBox, radius: Double) -> [Int] {
        var raw = grid.query(box.expanded(byMeters: radius))
        raw.sort()
        var out: [Int] = []
        out.reserveCapacity(raw.count)
        var last: Int32 = -1
        for i in raw where i != last {
            out.append(Int(i))
            last = i
        }
        return out
    }

    /// Every distinct place where the route passes within `radius` meters of the point,
    /// ordered along the route. A route that passes the same spot twice (loops, ramps that
    /// circle back, out and back legs) yields one projection per pass.
    ///
    /// Each pass is a local minimum of the distance to the point along consecutive segments.
    /// Grouping by gaps in along-route distance is not enough: a tight loop keeps every
    /// segment within the radius, which would merge both passes into one.
    public func projections(of c: GeoCoordinate, within radius: Double) -> [PolylineProjection] {
        guard segmentCount > 0 else { return [] }
        let box = GeoBoundingBox(minLatitude: c.latitude, minLongitude: c.longitude,
                                 maxLatitude: c.latitude, maxLongitude: c.longitude)
        var hits: [PolylineProjection] = []
        for i in candidateSegments(near: box, radius: radius) {
            let p = project(c, ontoSegment: i)
            if p.offset <= radius { hits.append(p) }
        }
        guard !hits.isEmpty else { return [] }
        hits.sort { $0.segmentIndex < $1.segmentIndex }
        var minima: [PolylineProjection] = []
        for k in 0..<hits.count {
            let p = hits[k]
            let prev = k > 0 && hits[k - 1].segmentIndex == p.segmentIndex - 1 ? hits[k - 1] : nil
            let next = k + 1 < hits.count && hits[k + 1].segmentIndex == p.segmentIndex + 1 ? hits[k + 1] : nil
            let notAbovePrevious = prev.map { p.offset <= $0.offset } ?? true
            let belowNext = next.map { p.offset < $0.offset } ?? true
            if notAbovePrevious && belowNext { minima.append(p) }
        }
        return minima
    }

    public func nearestProjection(of c: GeoCoordinate, within radius: Double) -> PolylineProjection? {
        projections(of: c, within: radius).min { $0.offset < $1.offset }
    }

    // MARK: Slicing

    /// The part of the route between two distances, as a new polyline starting at 0.
    public func slice(from start: Double, to end: Double) -> RoutePolyline {
        let s = min(max(start, 0), length), e = min(max(end, s), length)
        var pts = [coordinate(at: s)]
        if segmentCount > 0 {
            let i0 = segmentIndex(containing: s) + 1
            let i1 = segmentIndex(containing: e)
            if i0 <= i1 {
                for i in i0...i1 where cumulativeDistances[i] > s && cumulativeDistances[i] < e {
                    pts.append(points[i])
                }
            }
        }
        pts.append(coordinate(at: e))
        return RoutePolyline(points: pts, gridCellDegrees: grid.cellSize)
    }

    static func lerp(_ a: GeoCoordinate, _ b: GeoCoordinate, _ t: Double) -> GeoCoordinate {
        GeoCoordinate(latitude: a.latitude + (b.latitude - a.latitude) * t,
                      longitude: a.longitude + (b.longitude - a.longitude) * t)
    }
}
