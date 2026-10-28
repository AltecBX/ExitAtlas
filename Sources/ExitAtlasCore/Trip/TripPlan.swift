import Foundation

/// Datasets the engine needs. Load once and share.
public struct TripDatasets: Sendable {
    public let states: RegionIndex
    public let timeZones: TimeZoneResolver?
    public let interstates: InterstateDataset?
    public let restAreas: RestAreaDataset?

    public init(states: RegionIndex, timeZones: TimeZoneResolver?, interstates: InterstateDataset?,
                restAreas: RestAreaDataset? = nil) {
        self.states = states
        self.timeZones = timeZones
        self.interstates = interstates
        self.restAreas = restAreas
    }
}

/// Everything derived from one selected route: ordered state segments, time zones, exits and rest areas.
/// Rebuilt whenever the route changes (reroute, stop added, alternative chosen).
public struct TripPlan: Sendable {
    public let route: PlannedRoute
    public let states: RegionProfile
    public let exits: [RouteExit]
    /// Rest areas and service plazas on the driver's side, in route order.
    public let restAreas: [RouteRestArea]
    /// Exit distances along the route, for fast counting.
    private let exitDistances: [Double]
    private let restAreaDistances: [Double]
    private let timeZoneIDs: [String?]  // per state segment, at its start

    public init(route: PlannedRoute, datasets: TripDatasets,
                segmenter: RegionSegmenter = RegionSegmenter(), matcher: ExitMatcher? = nil) {
        self.route = route
        let states = segmenter.segment(route.polyline, regions: datasets.states)
        self.states = states
        if let interstates = datasets.interstates {
            exits = (matcher ?? ExitMatcher(source: route.source)).match(route: route.polyline, dataset: interstates)
        } else {
            exits = []
        }
        exitDistances = exits.map(\.distanceAlongRoute)
        if let restDataset = datasets.restAreas {
            let route = route
            restAreas = RestAreaMatcher().match(route: route.polyline, dataset: restDataset) { route.step(at: $0)?.highways ?? [] }
        } else {
            restAreas = []
        }
        restAreaDistances = restAreas.map(\.distanceAlongRoute)
        timeZoneIDs = states.segments.map { seg in
            datasets.timeZones?.identifier(at: seg.entryCoordinate, stateCode: seg.code)
        }
        self.timeZoneResolver = datasets.timeZones
    }

    private let timeZoneResolver: TimeZoneResolver?

    /// Number of exits strictly after `start` and before `end` (meters along the route).
    /// Counting is by position along the route, never by exit numbers.
    public func exitCount(after start: Double, before end: Double) -> Int {
        guard end > start else { return 0 }
        return lowerBound(exitDistances, end) - upperBound(exitDistances, start)
    }

    public func exits(after start: Double, upTo end: Double) -> ArraySlice<RouteExit> {
        let lo = upperBound(exitDistances, start), hi = upperBound(exitDistances, end)
        return lo < hi ? exits[lo..<hi] : []
    }

    public func nextExit(after distance: Double) -> RouteExit? {
        let i = upperBound(exitDistances, distance)
        return i < exits.count ? exits[i] : nil
    }

    /// Rest areas strictly after `start` up to `end`.
    public func restAreas(after start: Double, upTo end: Double) -> ArraySlice<RouteRestArea> {
        let lo = upperBound(restAreaDistances, start), hi = upperBound(restAreaDistances, end)
        return lo < hi ? restAreas[lo..<hi] : []
    }

    public func nextRestArea(after distance: Double) -> RouteRestArea? {
        let i = upperBound(restAreaDistances, distance)
        return i < restAreas.count ? restAreas[i] : nil
    }

    /// IANA time zone at a distance along the route.
    public func timeZoneID(at distance: Double) -> String? {
        guard let resolver = timeZoneResolver else { return nil }
        let code = states.segment(at: distance)?.code
        return resolver.identifier(at: route.polyline.coordinate(at: distance), stateCode: code)
    }

    public func timeZoneIDAtSegmentStart(_ index: Int) -> String? {
        index < timeZoneIDs.count ? timeZoneIDs[index] : nil
    }

    // Binary search helpers over sorted distances.
    private func lowerBound(_ a: [Double], _ x: Double) -> Int {
        var lo = 0, hi = a.count
        while lo < hi { let m = (lo + hi) / 2; if a[m] < x { lo = m + 1 } else { hi = m } }
        return lo
    }

    private func upperBound(_ a: [Double], _ x: Double) -> Int {
        var lo = 0, hi = a.count
        while lo < hi { let m = (lo + hi) / 2; if a[m] <= x { lo = m + 1 } else { hi = m } }
        return lo
    }
}
