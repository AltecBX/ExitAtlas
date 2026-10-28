import Foundation

/// Notable places near the route (discover.json from tools/data-pipeline/build_discover.py, Wikidata,
/// CC0). Port of web/js/engine/discover.js.
public enum DiscoverCategory: String, Sendable, Codable, Hashable, CaseIterable {
    case nationalPark, nationalMonument, statePark, waterfall, cave, viewpoint, museum, zoo, amusementPark, historicSite, landmark

    public var title: String {
        switch self {
        case .nationalPark: return "National park"
        case .nationalMonument: return "National monument"
        case .statePark: return "State park"
        case .waterfall: return "Waterfall"
        case .cave: return "Cave"
        case .viewpoint: return "Scenic viewpoint"
        case .museum: return "Museum"
        case .zoo: return "Zoo"
        case .amusementPark: return "Amusement park"
        case .historicSite: return "Historic site"
        case .landmark: return "Landmark"
        }
    }

    public var symbolName: String {
        switch self {
        case .nationalPark, .statePark: return "tree.fill"
        case .nationalMonument, .landmark: return "building.columns.fill"
        case .waterfall: return "drop.fill"
        case .cave: return "mountain.2.fill"
        case .viewpoint: return "binoculars.fill"
        case .museum: return "building.columns"
        case .zoo: return "pawprint.fill"
        case .amusementPark: return "star.circle.fill"
        case .historicSite: return "clock.arrow.circlepath"
        }
    }

    /// How far from the route a place may be: parks and natural sites are worth a longer detour.
    public var nearMeters: Double {
        switch self {
        case .nationalPark, .nationalMonument, .statePark, .waterfall, .cave: return 16000
        default: return 8000
        }
    }
}

public struct DiscoverDataset: Sendable {
    public struct Item: Sendable, Hashable, Decodable {
        public let id: String
        public let name: String
        public let cat: DiscoverCategory
        public let lat: Double
        public let lon: Double
        public let sitelinks: Int
        public let score: Int
        public let road: String
        public let offMeters: Double
        public let desc: String?
        public let wiki: String?

        public var coordinate: GeoCoordinate { GeoCoordinate(latitude: lat, longitude: lon) }
    }

    public struct Metadata: Sendable, Decodable {
        public let kind: String
        public let source: String
        public let license: String
        public let attribution: String
        public let fetched: String?
        public let count: Int
    }

    private struct File: Decodable {
        let meta: Metadata
        let items: [Item]
    }

    public let metadata: Metadata
    public let items: [Item]

    public init(data: Data) throws {
        let file = try JSONDecoder().decode(File.self, from: data)
        guard file.meta.kind == "discover" else { throw DatasetError.badMagic(expected: "discover", found: file.meta.kind) }
        metadata = file.meta
        items = file.items
    }

    public init(contentsOf url: URL) throws {
        try self.init(data: Data(contentsOf: url))
    }
}

/// A place near the route, with the exit nearest along the route when one is within 5 km.
public struct RouteDiscovery: Sendable, Hashable, Identifiable {
    public let item: DiscoverDataset.Item
    public let distanceAlongRoute: Double
    /// Straight line from the route; the drive is longer.
    public let offMeters: Double
    public let exit: RouteExit?
    public var id: String { item.id }
}

public enum DiscoverAhead {
    /// Places within their category's distance of the route, in route order.
    public static func match(route: RoutePolyline, dataset: DiscoverDataset, exits: [RouteExit]) -> [RouteDiscovery] {
        let box = route.boundingBox.expanded(byMeters: 16000)
        var out: [RouteDiscovery] = []
        for item in dataset.items where box.contains(item.coordinate) {
            guard let p = route.nearestProjection(of: item.coordinate, within: item.cat.nearMeters) else { continue }
            var nearest: RouteExit?
            var best = Double.infinity
            for e in exits {
                let d = abs(e.distanceAlongRoute - p.distanceAlong)
                if d < best { best = d; nearest = e }
                if e.distanceAlongRoute > p.distanceAlong + best { break }
            }
            out.append(RouteDiscovery(item: item, distanceAlongRoute: p.distanceAlong, offMeters: p.offset,
                                      exit: best <= 5000 ? nearest : nil))
        }
        return out.sorted { $0.distanceAlongRoute < $1.distanceAlongRoute }
    }
}
