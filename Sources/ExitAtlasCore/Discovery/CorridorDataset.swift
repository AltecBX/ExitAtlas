import Foundation

/// A directional interstate corridor ("I-95 Northbound") used by discovery mode.
public struct Corridor: Sendable, Identifiable {
    public let id: Int
    /// "I-95"
    public let highway: String
    /// "NB", "SB", "EB", "WB" as published by OpenInterstate.
    public let directionCode: String
    /// "I-95 Northbound"
    public let displayName: String
    public let sourceDistanceMeters: Double
    public let sourceDurationSeconds: Double
    /// Continuous runs. Gaps between parts are real gaps in the corridor geometry.
    public let parts: [RoutePolyline]

    /// Average speed published for the corridor (m/s), used for discovery mode ETAs.
    public var averageSpeed: Double {
        sourceDurationSeconds > 0 ? sourceDistanceMeters / sourceDurationSeconds : 26.8
    }
}

/// Where a location sits on a corridor.
public struct CorridorMatch: Sendable {
    public let corridor: Corridor
    public let partIndex: Int
    public let projection: PolylineProjection
    public let bearingDifference: Double

    public var part: RoutePolyline { corridor.parts[partIndex] }
}

/// Bundled directional interstate geometry (EAC1, built from OpenInterstate reference routes).
public struct CorridorDataset: Sendable {
    public let metadata: DatasetMetadata
    public let corridors: [Corridor]
    private let partBoxes: [(corridor: Int, part: Int, box: GeoBoundingBox)]

    public init(data: Data) throws {
        var r = BinaryReader(data)
        metadata = try r.readHeader(magic: "EAC1", supportedVersion: 1)
        let strings = try StringTable(reader: &r)
        let count = Int(try r.read(UInt32.self))
        var corridors: [Corridor] = []
        var boxes: [(Int, Int, GeoBoundingBox)] = []
        for id in 0..<count {
            let highway = strings.string(try r.read(UInt32.self)) ?? ""
            let direction = strings.string(try r.read(UInt32.self)) ?? ""
            let display = strings.string(try r.read(UInt32.self)) ?? highway
            let distance = Double(try r.readFloat32())
            let duration = Double(try r.readFloat32())
            let partCount = Int(try r.read(UInt32.self))
            var parts: [RoutePolyline] = []
            for _ in 0..<partCount {
                let n = Int(try r.read(UInt32.self))
                var pts: [GeoCoordinate] = []
                pts.reserveCapacity(n)
                for _ in 0..<n {
                    let lat = try r.read(Int32.self), lon = try r.read(Int32.self)
                    pts.append(BinaryReader.coordinate(latE7: lat, lonE7: lon))
                }
                guard pts.count >= 2 else { continue }
                let polyline = RoutePolyline(points: pts, gridCellDegrees: 0.02)
                guard polyline.segmentCount > 0 else { continue }
                boxes.append((id, parts.count, polyline.boundingBox))
                parts.append(polyline)
            }
            corridors.append(Corridor(id: id, highway: highway, directionCode: direction, displayName: display,
                                      sourceDistanceMeters: distance, sourceDurationSeconds: duration, parts: parts))
        }
        self.corridors = corridors
        partBoxes = boxes
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: try Data(contentsOf: url, options: .mappedIfSafe))
    }

    /// Corridor positions near a location whose direction agrees with the course of travel.
    public func matches(near c: GeoCoordinate, course: Double, radius: Double,
                        maxBearingDifference: Double = 35) -> [CorridorMatch] {
        var out: [CorridorMatch] = []
        let probe = GeoBoundingBox(minLatitude: c.latitude, minLongitude: c.longitude,
                                   maxLatitude: c.latitude, maxLongitude: c.longitude).expanded(byMeters: radius)
        for entry in partBoxes where entry.box.intersects(probe) {
            let corridor = corridors[entry.corridor]
            let part = corridor.parts[entry.part]
            for p in part.projections(of: c, within: radius) {
                let diff = Geodesy.angleDifference(part.bearing(at: p.distanceAlong), course)
                if diff <= maxBearingDifference {
                    out.append(CorridorMatch(corridor: corridor, partIndex: entry.part, projection: p,
                                             bearingDifference: diff))
                }
            }
        }
        return out.sorted { ($0.projection.offset + $0.bearingDifference) < ($1.projection.offset + $1.bearingDifference) }
    }
}
