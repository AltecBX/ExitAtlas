import Foundation

/// Uniform latitude/longitude grid that maps cells to the indices of items overlapping them.
/// Used for route segments, boundary edges and exit points.
struct SpatialGrid: Sendable {
    struct Cell: Hashable, Sendable {
        let x: Int32
        let y: Int32
    }

    let cellSize: Double
    private(set) var cells: [Cell: [Int32]] = [:]

    init(cellSizeDegrees: Double) {
        cellSize = cellSizeDegrees
    }

    @inline(__always)
    func cellCoordinate(_ value: Double) -> Int32 {
        Int32(floor(value / cellSize))
    }

    mutating func insert(_ item: Int32, box: GeoBoundingBox) {
        let x0 = cellCoordinate(box.minLongitude), x1 = cellCoordinate(box.maxLongitude)
        let y0 = cellCoordinate(box.minLatitude), y1 = cellCoordinate(box.maxLatitude)
        for x in x0...x1 {
            for y in y0...y1 {
                cells[Cell(x: x, y: y), default: []].append(item)
            }
        }
    }

    /// Inserts a straight segment into only the cells it passes through. Long diagonal
    /// segments (straight state lines, sparse route geometry) would otherwise fill every
    /// cell of their bounding box.
    mutating func insertSegment(_ item: Int32, from a: GeoCoordinate, to b: GeoCoordinate) {
        let dx = b.longitude - a.longitude, dy = b.latitude - a.latitude
        let steps = max(1, Int((max(abs(dx), abs(dy)) / (cellSize * 0.5)).rounded(.up)))
        if steps == 1 {
            insert(item, box: .segment(a, b))
            return
        }
        var seen = Set<Cell>()
        var previous = a
        for k in 1...steps {
            let t = Double(k) / Double(steps)
            let next = GeoCoordinate(latitude: a.latitude + dy * t, longitude: a.longitude + dx * t)
            let box = GeoBoundingBox.segment(previous, next)
            for x in cellCoordinate(box.minLongitude)...cellCoordinate(box.maxLongitude) {
                for y in cellCoordinate(box.minLatitude)...cellCoordinate(box.maxLatitude) {
                    let cell = Cell(x: x, y: y)
                    if seen.insert(cell).inserted {
                        cells[cell, default: []].append(item)
                    }
                }
            }
            previous = next
        }
    }

    /// Items in cells touched by a straight segment. May contain duplicates.
    func querySegment(from a: GeoCoordinate, to b: GeoCoordinate, padding: Double = 0) -> [Int32] {
        var out: [Int32] = []
        let dx = b.longitude - a.longitude, dy = b.latitude - a.latitude
        let steps = max(1, Int((max(abs(dx), abs(dy)) / (cellSize * 0.5)).rounded(.up)))
        var seen = Set<Cell>()
        var previous = a
        for k in 1...steps {
            let t = Double(k) / Double(steps)
            let next = GeoCoordinate(latitude: a.latitude + dy * t, longitude: a.longitude + dx * t)
            var box = GeoBoundingBox.segment(previous, next)
            if padding > 0 { box = box.expanded(byMeters: padding) }
            for x in cellCoordinate(box.minLongitude)...cellCoordinate(box.maxLongitude) {
                for y in cellCoordinate(box.minLatitude)...cellCoordinate(box.maxLatitude) {
                    let cell = Cell(x: x, y: y)
                    if seen.insert(cell).inserted, let items = cells[cell] {
                        out.append(contentsOf: items)
                    }
                }
            }
            previous = next
        }
        return out
    }

    mutating func insert(_ item: Int32, at c: GeoCoordinate) {
        cells[Cell(x: cellCoordinate(c.longitude), y: cellCoordinate(c.latitude)), default: []].append(item)
    }

    /// Items in cells overlapping the box. May contain duplicates when items span cells.
    func query(_ box: GeoBoundingBox, into result: inout [Int32]) {
        let x0 = cellCoordinate(box.minLongitude), x1 = cellCoordinate(box.maxLongitude)
        let y0 = cellCoordinate(box.minLatitude), y1 = cellCoordinate(box.maxLatitude)
        for x in x0...x1 {
            for y in y0...y1 {
                if let items = cells[Cell(x: x, y: y)] {
                    result.append(contentsOf: items)
                }
            }
        }
    }

    func query(_ box: GeoBoundingBox) -> [Int32] {
        var out: [Int32] = []
        query(box, into: &out)
        return out
    }
}

extension GeoBoundingBox {
    static func segment(_ a: GeoCoordinate, _ b: GeoCoordinate) -> GeoBoundingBox {
        GeoBoundingBox(minLatitude: min(a.latitude, b.latitude), minLongitude: min(a.longitude, b.longitude),
                       maxLatitude: max(a.latitude, b.latitude), maxLongitude: max(a.longitude, b.longitude))
    }
}
