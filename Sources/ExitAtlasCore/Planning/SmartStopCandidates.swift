import Foundation

/// stations.json: what OpenStreetMap says today about the gas stations in interstates.eax (hours,
/// restroom tag, rebrands, stations no longer listed), and what the brands' own store listings say (All
/// the Places: hours, restroom). Built by tools/data-pipeline/build_stations.py.
public struct StationFacts: Sendable {
    public struct Fact: Sendable, Hashable, Decodable {
        /// opening_hours as written.
        public let h: String?
        /// When mappers last checked the hours.
        public let hc: String?
        /// The toilets tag, only when tagged.
        public let t: Bool?
        /// The current brand when it differs from the exit data.
        public let b: String?
        /// Why not to offer it: "deleted" or "not fuel".
        public let gone: String?
        /// The brand's listed hours, whether it lists a restroom, and the brand as the listing names it.
        public let ah: String?
        public let at: Bool?
        public let ab: String?
    }

    public struct Meta: Sendable, Decodable {
        public let kind: String
        public let count: Int
        public let tags_fetched: String?
        public let with_hours: Int?
        public let with_toilets: Int?
        public let gone: Int?
        public let license: String
        /// When the brand listings were collected (the All the Places run date), and how many stations have them.
        public let brand_collected: String?
        public let with_brand_hours: Int?
        public let with_brand_toilets: Int?
    }

    public let metadata: Meta
    public let items: [String: Fact]

    struct File: Decodable {
        let meta: Meta
        let items: [String: Fact]
    }

    public init(data: Data) throws {
        let f = try JSONDecoder().decode(File.self, from: data)
        guard f.meta.kind == "stations" else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not a station dataset")) }
        metadata = f.meta
        items = f.items
    }

    public init(contentsOf url: URL) throws { try self.init(data: Data(contentsOf: url)) }

    public subscript(placeID: String) -> Fact? { items[placeID] }
}

/// SmartStop candidates from the trip: gas stations at exits (with stations.json facts), service plazas
/// with fuel, and rest areas for restroom stops. Port of web/js/app/smartstops.js.
public extension SmartStop {
    /// Google's record for an OpenStreetMap station near an exit: within 50 m, or within 150 m with a
    /// matching name or brand.
    static func live(_ stations: [GasPriceFeed.Station], place: Place, brand: String) -> GasPriceFeed.Station? {
        var best: (GasPriceFeed.Station, Double)?
        for g in stations {
            guard let c = g.coordinate else { continue }
            let d = Geodesy.distance(place.coordinate, c)
            let named = [brand, place.name].contains { !$0.isEmpty && RangePlanner.matchesFavorite(g.name, favorites: [$0]) }
            if d <= 50 || (d <= 150 && named), d < (best?.1 ?? .infinity) { best = (g, d) }
        }
        return best?.0
    }

    /// The name a station shows. When OpenStreetMap now tags another brand and the exit data's name was only the
    /// old brand ("Shell", now tagged Circle K), the current brand, so a former Shell is never shown or ranked as a
    /// Shell; otherwise the exit data's name. Same rule as stationName in web/js/app/smartstops.js.
    static func stationName(_ place: Place, brand: String) -> String {
        let name = place.displayName
        guard !brand.isEmpty, !place.brand.isEmpty, brand != place.brand,
              ServiceRequirement.simplified(name) == ServiceRequirement.simplified(place.brand) else { return name }
        return brand
    }

    /// How prices are compared: the driver's grade and payment, and how old a report may be.
    struct PriceOptions: Sendable {
        public var grade: GasPriceFeed.Grade
        public var payment: GasPrices.Payment
        public var maxAgeHours: Double
        public var now: Date

        public init(grade: GasPriceFeed.Grade, payment: GasPrices.Payment = .credit, maxAgeHours: Double = 24, now: Date) {
            self.grade = grade
            self.payment = payment
            self.maxAgeHours = maxAgeHours
            self.now = now
        }
    }

    /// The price a stop shows for the driver's grade: reported prices, plus Google's when the driver looked
    /// it up and Google says when it was updated (kept in memory only). Nil: price unavailable. Same rule as
    /// stopPrice in web/js/app/smartstops.js.
    static func stopPrice(_ ctx: TripContext, stationId: String, live: GasPriceFeed.Station? = nil, grade: GasPriceFeed.Grade? = nil) -> GasPrices.StationPrice? {
        guard let o = ctx.priceOptions else { return nil }
        let g = grade ?? o.grade
        var records = ctx.priceRecords[stationId] ?? []
        if let live, let p = live.prices[g], let updated = p.updated {
            records.append(GasPrices.Record(id: "google:\(live.id):\(g.code)", stationId: stationId, grade: g.code, price: p.dollars, payment: nil,
                                            reportedAt: updated, reporter: nil, source: .init(id: "google", name: "Google Maps", kind: .google)))
        }
        return GasPrices.stationPrice(records, stationId: stationId, grade: g.code, now: o.now, payment: o.payment, maxAgeHours: o.maxAgeHours)
    }

    /// Everything the candidate builders need from the trip.
    struct TripContext {
        public var plan: TripPlan
        public var snapshot: TripSnapshot
        public var dataset: InterstateDataset
        public var stations: StationFacts?
        /// Live Google stations by exit id, where the driver looked prices up (Google Maps prices on).
        public var live: [String: [GasPriceFeed.Station]]
        public var grade: GasPriceFeed.Grade
        /// Reported prices by station id (the driver's own, and SIMULATED demo prices), and how to read them;
        /// nil options when comparing prices is off (docs/17).
        public var priceRecords: [String: [GasPrices.Record]]
        public var priceOptions: PriceOptions?

        public init(plan: TripPlan, snapshot: TripSnapshot, dataset: InterstateDataset, stations: StationFacts?,
                    live: [String: [GasPriceFeed.Station]] = [:], grade: GasPriceFeed.Grade = .regular,
                    priceRecords: [String: [GasPrices.Record]] = [:], priceOptions: PriceOptions? = nil) {
            self.plan = plan
            self.snapshot = snapshot
            self.dataset = dataset
            self.stations = stations
            self.live = live
            self.grade = grade
            self.priceRecords = priceRecords
            self.priceOptions = priceOptions
        }

        func eta(_ along: Double) -> Date {
            plan.eta(to: along, from: snapshot)
        }

        func zone(_ along: Double) -> TimeZone {
            plan.timeZoneID(at: along).flatMap(TimeZone.init(identifier:)) ?? TimeZone(identifier: "America/New_York")!
        }
    }

    /// One candidate per gas station at the exits in the window. A station linked to two exits (a split
    /// interchange, or the next exit) is one stop: the exit with the shorter detour, or the first one when
    /// they are equal (same rule as onePerStation in web/js/app/smartstops.js).
    static func stationCandidates(_ ctx: TripContext, window: Double, rangeLeft: Double?) -> [Candidate] {
        let d = ctx.snapshot.progress
        var out: [Candidate] = []
        var detours: [Double] = []
        for x in RangePlanner.gasCandidates(plan: ctx.plan, from: d, range: window, dataset: ctx.dataset) {
            guard let exit = x.exit else { continue }
            let ahead = x.along - d
            let eta = ctx.eta(x.along)
            let zone = ctx.zone(x.along)
            let nearby = ctx.live[exit.id] ?? []
            for g in x.gasStations {
                let fact = ctx.stations?[g.place.id]
                let brand = fact?.b ?? g.place.brand
                let live = live(nearby, place: g.place, brand: brand)
                let sp = stopPrice(ctx, stationId: g.place.id, live: live)
                let current = sp?.state == .current ? sp : nil
                let routed = g.detourBasis == .routedOneWayDoubled
                out.append(Candidate(
                    id: g.place.id, name: stationName(g.place, brand: brand), brand: brand, kind: .station, exitID: exit.id, exitLabel: exit.label,
                    along: x.along, ahead: ahead, arrival: eta.addingTimeInterval((g.detourSeconds ?? 0) / 2), timeZone: zone,
                    detourMinutes: routed ? g.detourSeconds.map { $0 / 60 } : nil,
                    rangeOnArrival: rangeLeft.map { $0 - ahead - g.detourMeters / 2 },
                    price: current?.record.price, pricePayment: current?.record.payment?.rawValue, priceText: current?.text,
                    priceSource: current?.record.source.name, priceInfo: sp, detourMeters: g.detourMeters, coordinate: g.place.coordinate,
                    osmHours: fact?.h, osmChecked: fact?.hc, osmToilets: fact?.t, gone: fact?.gone,
                    livePeriods: live?.periods, liveRestroom: live?.restroom,
                    brandHours: fact?.ah, brandToilets: fact?.at, listedBy: fact?.ab,
                    brandCollected: fact?.ah != nil || fact?.at != nil ? ctx.stations?.metadata.brand_collected : nil))
                detours.append(g.detourMeters)
            }
        }
        var best: [String: Int] = [:]
        for (i, c) in out.enumerated() where best[c.id].map({ detours[i] < detours[$0] }) ?? true { best[c.id] = i }
        return out.indices.filter { best[out[$0].id] == $0 }.map { out[$0] }
    }

    /// Service plazas with fuel (fuel stops), or rest areas and welcome centers (restroom stops).
    static func plazaCandidates(_ ctx: TripContext, window: Double, rangeLeft: Double?, fuelOnly: Bool = true) -> [Candidate] {
        let d = ctx.snapshot.progress
        return ctx.plan.restAreas(after: d, upTo: d + window).compactMap { r in
            let fuel = r.kind == .plaza && !r.gas.isEmpty
            if fuelOnly ? !fuel : (fuel || r.kind == .parking) { return nil }
            let ahead = r.distanceAlongRoute - d
            let sp = fuel ? stopPrice(ctx, stationId: r.id) : nil
            let current = sp?.state == .current ? sp : nil
            return Candidate(
                id: r.id, name: r.title, brand: r.gas.first ?? "", otherNames: r.gas, kind: fuel ? .plaza : .rest,
                along: r.distanceAlongRoute, ahead: ahead, arrival: ctx.eta(r.distanceAlongRoute), timeZone: ctx.zone(r.distanceAlongRoute),
                rangeOnArrival: rangeLeft.map { $0 - ahead },
                price: current?.record.price, pricePayment: current?.record.payment?.rawValue, priceText: current?.text,
                priceSource: current?.record.source.name, priceInfo: sp, detourMeters: 0, coordinate: r.coordinate,
                plazaHours: r.hours, plazaToilets: r.amenities[.toilets], truckSpaces: r.fhwaTruckSpaces)
        }
    }

    /// Fuel stop candidates: a little past the range, so a favorite just out of reach can be explained.
    static func fuelCandidates(_ ctx: TripContext, rangeLeft: Double) -> [Candidate] {
        let window = rangeLeft + 50 * Geodesy.metersPerMile
        return (stationCandidates(ctx, window: window, rangeLeft: rangeLeft) + plazaCandidates(ctx, window: window, rangeLeft: rangeLeft))
            .sorted { $0.along < $1.along }
    }

    /// Stops in the next `miles`; restroom stops add rest areas.
    static func aheadCandidates(_ ctx: TripContext, miles: Double, rangeLeft: Double?, restrooms: Bool = false) -> [Candidate] {
        let window = miles * Geodesy.metersPerMile
        var list = stationCandidates(ctx, window: window, rangeLeft: rangeLeft) + plazaCandidates(ctx, window: window, rangeLeft: rangeLeft)
        if restrooms { list += plazaCandidates(ctx, window: window, rangeLeft: rangeLeft, fuelOnly: false) }
        return list.sorted { $0.along < $1.along }
    }
}
