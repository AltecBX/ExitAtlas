import Foundation

/// Service categories available in the bundled OpenInterstate data.
/// Grocery, pharmacy, convenience and truck stop categories need an additional source (see docs).
public enum PlaceCategory: UInt8, Sendable, Codable, CaseIterable, Hashable {
    case unknown = 0
    case gas = 1
    case food = 2
    case lodging = 3
    case restArea = 4
    case evCharging = 5
    case park = 6
    case dogPark = 7

    public var displayName: String {
        switch self {
        case .unknown: return "Other"
        case .gas: return "Gas"
        case .food: return "Food"
        case .lodging: return "Lodging"
        case .restArea: return "Rest Area"
        case .evCharging: return "EV Charging"
        case .park: return "Park"
        case .dogPark: return "Dog Park"
        }
    }

    /// SF Symbol name used by the app.
    public var symbolName: String {
        switch self {
        case .unknown: return "mappin"
        case .gas: return "fuelpump.fill"
        case .food: return "fork.knife"
        case .lodging: return "bed.double.fill"
        case .restArea: return "toilet.fill"
        case .evCharging: return "bolt.car.fill"
        case .park: return "tree.fill"
        case .dogPark: return "pawprint.fill"
        }
    }
}

/// One physical exit (highway diverge point) from the dataset.
public struct ExitRecord: Sendable, Hashable, Identifiable {
    public let datasetIndex: Int32
    public let osmNodeID: Int64
    public let coordinate: GeoCoordinate
    /// Travel bearing(s) of the carriageway at the exit node. Empty when unknown.
    public let bearings: [Double]
    /// Posted exit number, normalized ("23A", "4A-B"). Empty for unnumbered exits.
    public let label: String
    /// Destination or exit name text when mapped ("Hallandale Beach Boulevard"). Often empty.
    public let name: String
    /// Interstates the source associated with this exit. A weak hint only: corridor assignment
    /// in the source is noisy, so direction and identity come from geometry, not from this.
    public let highways: [String]
    let linkStart: UInt32
    let linkCount: UInt16

    public var id: Int64 { osmNodeID }
}

/// A business or facility linked to exits.
public struct Place: Sendable, Hashable, Identifiable {
    public let datasetIndex: Int32
    /// Source identifier, for example "node/123456" (OpenStreetMap).
    public let id: String
    public let coordinate: GeoCoordinate
    public let name: String
    public let brand: String
    public let category: PlaceCategory

    public var displayName: String { name.isEmpty ? (brand.isEmpty ? category.displayName : brand) : name }
}

/// A place reachable from an exit.
public struct ExitPlaceLink: Sendable, Hashable {
    public let place: Place
    /// Straight line meters from the exit node to the place.
    public let straightLineMeters: Double
    /// One way driving meters from the exit to the place (OSRM, OpenInterstate reachability release).
    public let driveMeters: Double?
    public let driveSeconds: Double?
    public let rank: Int
    /// nil when the reachability release has no result for this pair.
    public let reachable: Bool?
}

/// Exits, places and exit-place links from the bundled EAX1 dataset (built from OpenInterstate).
public struct InterstateDataset: Sendable {
    public let metadata: DatasetMetadata
    public let exits: [ExitRecord]
    private let strings: StringTable
    private let data: Data
    private let placeOffset: Int
    public let placeCount: Int
    private let linkOffset: Int
    public let linkCount: Int
    private let grid: SpatialGrid

    private static let exitRecordSize = 40
    private static let placeRecordSize = 24
    private static let linkRecordSize = 12

    public init(data: Data) throws {
        var r = BinaryReader(data)
        metadata = try r.readHeader(magic: "EAX1", supportedVersion: 1)
        strings = try StringTable(reader: &r)
        let exitCount = Int(try r.read(UInt32.self))
        var exits: [ExitRecord] = []
        exits.reserveCapacity(exitCount)
        var grid = SpatialGrid(cellSizeDegrees: 0.02)
        for i in 0..<exitCount {
            let nodeID = try r.read(Int64.self)
            let lat = try r.read(Int32.self), lon = try r.read(Int32.self)
            let b1 = try r.read(UInt16.self), b2 = try r.read(UInt16.self)
            let label = try r.read(UInt32.self), name = try r.read(UInt32.self), highways = try r.read(UInt32.self)
            let linkStart = try r.read(UInt32.self), linkCount = try r.read(UInt16.self)
            _ = try r.read(UInt16.self)
            var bearings: [Double] = []
            if b1 != 0xFFFF { bearings.append(Double(b1) / 10) }
            if b2 != 0xFFFF { bearings.append(Double(b2) / 10) }
            let coordinate = BinaryReader.coordinate(latE7: lat, lonE7: lon)
            exits.append(ExitRecord(
                datasetIndex: Int32(i), osmNodeID: nodeID, coordinate: coordinate, bearings: bearings,
                label: strings.string(label) ?? "", name: strings.string(name) ?? "",
                highways: (strings.string(highways) ?? "").split(separator: ";").map(String.init),
                linkStart: linkStart, linkCount: linkCount))
            grid.insert(Int32(i), at: coordinate)
        }
        placeCount = Int(try r.read(UInt32.self))
        placeOffset = r.offset
        try r.skip(placeCount * Self.placeRecordSize)
        linkCount = Int(try r.read(UInt32.self))
        linkOffset = r.offset
        try r.skip(linkCount * Self.linkRecordSize)
        self.exits = exits
        self.data = data
        self.grid = grid
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: try Data(contentsOf: url, options: .mappedIfSafe))
    }

    /// Exits inside a box (expanded by `radius` meters).
    public func exits(near box: GeoBoundingBox, radius: Double = 0) -> [ExitRecord] {
        var ids = grid.query(radius > 0 ? box.expanded(byMeters: radius) : box)
        ids.sort()
        var out: [ExitRecord] = []
        var last: Int32 = -1
        for i in ids where i != last {
            let e = exits[Int(i)]
            if box.expanded(byMeters: radius).contains(e.coordinate) { out.append(e) }
            last = i
        }
        return out
    }

    /// Exit indices in grid cells touched by a segment, padded by `radius` meters. May include extras.
    func exitIndices(alongSegment a: GeoCoordinate, _ b: GeoCoordinate, radius: Double) -> [Int32] {
        grid.querySegment(from: a, to: b, padding: radius)
    }

    public func place(at index: Int) -> Place? {
        guard index >= 0, index < placeCount else { return nil }
        let base = placeOffset + index * Self.placeRecordSize
        let r = BinaryReader(data)
        guard let lat = try? r.value(at: base, as: Int32.self),
              let lon = try? r.value(at: base + 4, as: Int32.self),
              let name = try? r.value(at: base + 8, as: UInt32.self),
              let brand = try? r.value(at: base + 12, as: UInt32.self),
              let osmID = try? r.value(at: base + 16, as: UInt32.self),
              let category = try? r.value(at: base + 20, as: UInt8.self) else { return nil }
        return Place(datasetIndex: Int32(index), id: strings.string(osmID) ?? "",
                     coordinate: BinaryReader.coordinate(latE7: lat, lonE7: lon),
                     name: strings.string(name) ?? "", brand: strings.string(brand) ?? "",
                     category: PlaceCategory(rawValue: category) ?? .unknown)
    }

    /// Places linked to an exit, nearest first within each category.
    public func links(for exit: ExitRecord) -> [ExitPlaceLink] {
        let r = BinaryReader(data)
        var out: [ExitPlaceLink] = []
        out.reserveCapacity(Int(exit.linkCount))
        for k in 0..<Int(exit.linkCount) {
            let base = linkOffset + (Int(exit.linkStart) + k) * Self.linkRecordSize
            guard let placeIndex = try? r.value(at: base, as: UInt32.self),
                  let straight = try? r.value(at: base + 4, as: UInt16.self),
                  let driveM = try? r.value(at: base + 6, as: UInt16.self),
                  let driveS = try? r.value(at: base + 8, as: UInt16.self),
                  let rank = try? r.value(at: base + 10, as: UInt8.self),
                  let flags = try? r.value(at: base + 11, as: UInt8.self),
                  let place = place(at: Int(placeIndex)) else { continue }
            let hasDrive = flags & 1 != 0
            out.append(ExitPlaceLink(
                place: place, straightLineMeters: Double(straight),
                driveMeters: hasDrive && driveM != 0xFFFF ? Double(driveM) : nil,
                driveSeconds: hasDrive && driveS != 0xFFFF ? Double(driveS) : nil,
                rank: Int(rank), reachable: hasDrive || flags & 2 != 0 ? (flags & 2 != 0) : nil))
        }
        return out
    }
}
