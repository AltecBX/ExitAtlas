import Foundation

/// A named area with polygon geometry: a U.S. state, or a time zone.
public struct Region: Sendable, Identifiable, Hashable {
    public let id: Int
    /// "FL", "NY" for states; "Eastern", "Central" for time zones.
    public let code: String
    public let name: String
    /// State FIPS code, or UTC offset label for time zones.
    public let extra: String
    public let boundingBox: GeoBoundingBox

    public static func == (lhs: Region, rhs: Region) -> Bool { lhs.id == rhs.id && lhs.code == rhs.code }
    public func hash(into hasher: inout Hasher) { hasher.combine(code) }
}

/// Polygon index for point-in-region queries and exact boundary crossings along a segment.
///
/// Reads the EAB1 format produced by tools/data-pipeline/build_regions.py.
public struct RegionIndex: Sendable {
    public let metadata: DatasetMetadata
    public let regions: [Region]

    struct Ring: Sendable {
        let box: GeoBoundingBox
        let points: [GeoCoordinate]
    }

    struct Polygon: Sendable {
        let box: GeoBoundingBox
        let rings: [Ring]
    }

    private let polygons: [[Polygon]]  // per region
    private let edgeStart: [GeoCoordinate]
    private let edgeEnd: [GeoCoordinate]
    private let edgeGrid: SpatialGrid

    public init(data: Data) throws {
        var r = BinaryReader(data)
        metadata = try r.readHeader(magic: "EAB1", supportedVersion: 1)
        let count = Int(try r.read(UInt32.self))
        var regions: [Region] = []
        var polygons: [[Polygon]] = []
        var edgeStart: [GeoCoordinate] = [], edgeEnd: [GeoCoordinate] = []
        var grid = SpatialGrid(cellSizeDegrees: 0.05)
        for id in 0..<count {
            let code = try r.readString(lengthPrefix: 1)
            let name = try r.readString(lengthPrefix: 2)
            let extra = try r.readString(lengthPrefix: 1)
            let minLat = try r.read(Int32.self), minLon = try r.read(Int32.self)
            let maxLat = try r.read(Int32.self), maxLon = try r.read(Int32.self)
            let box = GeoBoundingBox(minLatitude: Double(minLat) / 1e7, minLongitude: Double(minLon) / 1e7,
                                     maxLatitude: Double(maxLat) / 1e7, maxLongitude: Double(maxLon) / 1e7)
            regions.append(Region(id: id, code: code, name: name, extra: extra, boundingBox: box))
            let polyCount = Int(try r.read(UInt32.self))
            var regionPolys: [Polygon] = []
            for _ in 0..<polyCount {
                let ringCount = Int(try r.read(UInt32.self))
                var rings: [Ring] = []
                for _ in 0..<ringCount {
                    let n = Int(try r.read(UInt32.self))
                    var pts: [GeoCoordinate] = []
                    pts.reserveCapacity(n)
                    for _ in 0..<n {
                        let lat = try r.read(Int32.self), lon = try r.read(Int32.self)
                        pts.append(BinaryReader.coordinate(latE7: lat, lonE7: lon))
                    }
                    guard let ringBox = GeoBoundingBox(pts) else { continue }
                    for k in 0..<max(pts.count - 1, 0) where pts[k] != pts[k + 1] {
                        grid.insertSegment(Int32(edgeStart.count), from: pts[k], to: pts[k + 1])
                        edgeStart.append(pts[k])
                        edgeEnd.append(pts[k + 1])
                    }
                    rings.append(Ring(box: ringBox, points: pts))
                }
                if let first = rings.first {
                    regionPolys.append(Polygon(box: first.box, rings: rings))
                }
            }
            polygons.append(regionPolys)
        }
        self.regions = regions
        self.polygons = polygons
        self.edgeStart = edgeStart
        self.edgeEnd = edgeEnd
        self.edgeGrid = grid
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: try Data(contentsOf: url, options: .mappedIfSafe))
    }

    public func region(code: String) -> Region? {
        regions.first { $0.code == code }
    }

    // MARK: Point queries

    /// The region containing the point, or nil when the point is outside every region
    /// (offshore beyond state waters, or in another country).
    public func region(containing c: GeoCoordinate) -> Region? {
        for region in regions where region.boundingBox.contains(c) {
            if contains(regionIndex: region.id, c) { return region }
        }
        return nil
    }

    func contains(regionIndex: Int, _ c: GeoCoordinate) -> Bool {
        for polygon in polygons[regionIndex] where polygon.box.contains(c) {
            var inside = false
            for ring in polygon.rings where ring.box.contains(c) {
                if Self.rayCrossings(ring.points, c) { inside.toggle() }
            }
            if inside { return true }
        }
        return false
    }

    /// Even-odd test for a single ring: true when a ray from the point crosses the ring an odd number of times.
    private static func rayCrossings(_ pts: [GeoCoordinate], _ c: GeoCoordinate) -> Bool {
        var inside = false
        let x = c.longitude, y = c.latitude
        var j = pts.count - 1
        for i in 0..<pts.count {
            let xi = pts[i].longitude, yi = pts[i].latitude
            let xj = pts[j].longitude, yj = pts[j].latitude
            if (yi > y) != (yj > y) {
                let xCross = (xj - xi) * (y - yi) / (yj - yi) + xi
                if x < xCross { inside.toggle() }
            }
            j = i
        }
        return inside
    }

    // MARK: Crossings

    /// Parameters t in [0, 1] where the straight segment a to b crosses any region boundary.
    /// Computed in longitude/latitude space; the parameter is invariant under the affine
    /// scaling between degrees and local meters, so it maps directly onto route distance.
    public func boundaryCrossings(from a: GeoCoordinate, to b: GeoCoordinate) -> [Double] {
        let candidates = edgeGrid.querySegment(from: a, to: b)
        guard !candidates.isEmpty else { return [] }
        var ts: [Double] = []
        let px = a.longitude, py = a.latitude
        let rx = b.longitude - px, ry = b.latitude - py
        for e in candidates {
            let s0 = edgeStart[Int(e)], s1 = edgeEnd[Int(e)]
            let sx = s1.longitude - s0.longitude, sy = s1.latitude - s0.latitude
            let denom = rx * sy - ry * sx
            if denom == 0 { continue }  // parallel or collinear: classification by midpoint handles it
            let qx = s0.longitude - px, qy = s0.latitude - py
            let t = (qx * sy - qy * sx) / denom
            let u = (qx * ry - qy * rx) / denom
            if t >= 0, t <= 1, u >= 0, u <= 1 { ts.append(t) }
        }
        ts.sort()
        var unique: [Double] = []
        for t in ts where unique.last.map({ t - $0 > 1e-12 }) ?? true {
            unique.append(t)
        }
        return unique
    }
}
