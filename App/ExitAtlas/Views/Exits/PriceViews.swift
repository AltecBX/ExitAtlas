import CoreLocation
import ExitAtlasCore
import SwiftUI

// Gas prices (docs/17): every price with its time and source; "Price unavailable" without a current report;
// old reports greyed and never compared; Google Maps prices only when turned on and asked for. Same rules and
// words as the website (web/js/app/views.js).

enum PriceText {
    /// Where a price came from: "you", "ExitAtlas drivers (3)", "Google Maps", "SIMULATED test data".
    static func source(_ sp: GasPrices.StationPrice) -> String {
        switch sp.record.source.kind {
        case .own: return "you"
        case .simulated: return "SIMULATED test data"
        case .community: return sp.record.source.name + (sp.confirmations > 0 ? " (\(sp.confirmations + 1))" : "")
        default: return sp.record.source.name
        }
    }

    /// The line under a price: when, by whom, and anything that limits it.
    static func meta(_ sp: GasPrices.StationPrice) -> String {
        var parts = [sp.text, source(sp)]
        switch sp.paymentMatch {
        case .other: parts.append("\(sp.record.payment?.rawValue ?? "other") price")
        case .unspecified: parts.append("cash or credit not said")
        case .exact: break
        }
        if sp.record.member { parts.append("member price") }
        if sp.conflict { parts.append("reports differ") }
        if sp.state != .current { parts.append("old, not compared") }
        return parts.joined(separator: " · ")
    }

    static let problems: [String: String] = [
        "station": "Pick a station", "grade": "Pick a grade", "price out of range": "Enter the price per gallon, for example 3.099",
        "far from the regional average": "That price is far from the regional average; check it", "payment": "Pick cash or credit",
        "time": "The time is off", "storage": "This iPhone did not let ExitAtlas save it",
    ]
}

/// A brand's colors and short name, so a favorite like Shell is found at a glance (a colored name, not a logo).
struct BrandTag: View {
    let name: String
    let brand: String

    private static let tags: [(String, Color, Color, String)] = [
        ("shell", Color(red: 0.98, green: 0.81, blue: 0.03), Color(red: 0.87, green: 0.11, blue: 0.13), "SHELL"),
        ("bp", Color(red: 0, green: 0.61, blue: 0.23), .white, "BP"), ("exxon", Color(red: 0.89, green: 0, blue: 0.17), .white, "EXXON"),
        ("mobil", Color(red: 0.89, green: 0, blue: 0.17), .white, "MOBIL"), ("wawa", Color(red: 0.78, green: 0.06, blue: 0.18), .white, "WAWA"),
        ("pilot", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "PILOT"), ("flying j", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "FLY J"),
        ("love's", Color(red: 1, green: 0.82, blue: 0), Color(red: 0.89, green: 0.09, blue: 0.22), "LOVE'S"),
        ("sunoco", Color(red: 0, green: 0.24, blue: 0.65), Color(red: 1, green: 0.82, blue: 0), "SUNOCO"),
        ("chevron", Color(red: 0, green: 0.33, blue: 0.64), .white, "CHEVRON"), ("sheetz", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "SHEETZ"),
        ("racetrac", Color(red: 0, green: 0.24, blue: 0.65), .white, "RACETRAC"), ("circle k", Color(red: 0.85, green: 0.16, blue: 0.11), .white, "CIRCLE K"),
        ("speedway", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "SPEEDWAY"), ("marathon", Color(red: 0, green: 0.24, blue: 0.65), .white, "MARATHON"),
        ("quiktrip", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "QT"), ("buc-ee", Color(red: 1, green: 0.82, blue: 0), Color(red: 0.84, green: 0.1, blue: 0.13), "BUC-EE'S"),
        ("costco", Color(red: 0, green: 0.36, blue: 0.67), .white, "COSTCO"),
        ("citgo", Color(red: 0.89, green: 0.09, blue: 0.22), .white, "CITGO"), ("valero", Color(red: 0, green: 0.35, blue: 0.61), Color(red: 1, green: 0.78, blue: 0.17), "VALERO"),
        ("7-eleven", Color(red: 0, green: 0.5, blue: 0.38), .white, "7-ELEVEN"), ("murphy", Color(red: 0, green: 0.33, blue: 0.65), .white, "MURPHY"),
        ("gulf", Color(red: 0.96, green: 0.48, blue: 0.13), .white, "GULF"), ("texaco", Color(red: 0.89, green: 0.14, blue: 0.1), .white, "TEXACO"),
        ("phillips 66", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "P66"), ("conoco", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "CONOCO"),
        ("casey", Color(red: 0.84, green: 0.1, blue: 0.13), .white, "CASEY'S"), ("cumberland", Color(red: 0, green: 0.44, blue: 0.24), .white, "CUMB FARMS"),
        ("hess", Color(red: 0, green: 0.52, blue: 0.24), .white, "HESS"), ("sinclair", Color(red: 0, green: 0.52, blue: 0.24), .white, "SINCLAIR"),
    ]

    var body: some View {
        let text = "\(brand) \(name)".lowercased()
        let hit = Self.tags.first { text.contains($0.0) }
        Text(hit?.3 ?? String((brand.isEmpty ? name : brand).prefix(6)).uppercased())
            .font(.system(size: 9.5, weight: .black, design: .rounded))
            .lineLimit(1).minimumScaleFactor(0.6)
            .foregroundStyle(hit?.2 ?? Color.primary)
            .frame(width: 44, height: 34)
            .background(hit?.1 ?? Theme.raised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// "$3.09 Regular" on the right of a row, greyed when old; "Price unavailable" without a report.
struct PriceTag: View {
    let price: GasPrices.StationPrice?
    let grade: GasPriceFeed.Grade

    var body: some View {
        if let sp = price {
            VStack(alignment: .trailing, spacing: 0) {
                Text(GasPrices.dollars(sp.record.price))
                    .font(Theme.number(sp.state == .current ? 21 : 16, weight: .heavy)).monospacedDigit()
                    .foregroundStyle(sp.state == .current ? Color.primary : Theme.secondaryText)
                Text(grade.name).font(.caption2).foregroundStyle(Theme.secondaryText)
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("Price\nunavailable").font(.caption.weight(.bold)).multilineTextAlignment(.trailing).foregroundStyle(Theme.secondaryText)
        }
    }
}

/// One line for a stop's price in cards: the price and its source, or "price unavailable".
struct CandidatePriceLine: View {
    @Environment(TripController.self) private var trip
    let candidate: SmartStop.Candidate
    /// On the Drive screen (a map) a Google Maps price is not shown: Google's terms keep its data off
    /// non-Google maps.
    var onMap = false

    var body: some View {
        if let o = trip.priceOptions, candidate.kind != .rest {
            if onMap, candidate.priceInfo?.record.source.kind == .google {
                Text("Google Maps price: see Road Ahead").font(.caption).foregroundStyle(Theme.secondaryText)
                    .accessibilityIdentifier("stopPrice")
            } else if let sp = candidate.priceInfo {
                (Text(GasPrices.dollars(sp.record.price)).font(.subheadline.weight(.bold).monospacedDigit())
                 + Text("  \(o.grade.name) · \(PriceText.meta(sp))").font(.caption).foregroundStyle(Theme.secondaryText))
                    .foregroundStyle(sp.state == .current ? Color.primary : Theme.secondaryText)
                    .accessibilityIdentifier("stopPrice")
            } else {
                Text("\(o.grade.name): price unavailable").font(.caption).foregroundStyle(Theme.secondaryText)
                    .accessibilityIdentifier("stopPrice")
            }
        }
    }
}

/// SmartStop's note when another stop saves at least the driver's minimum on a fill. A note only: the pick
/// and the favorite brands stay as they are.
struct CheaperNote: View {
    @Environment(TripController.self) private var trip
    let result: SmartStop.Result
    /// One line, for the Drive screen.
    var compact = false

    var body: some View {
        if compact, let ch = result.cheaper, ch.candidate.priceInfo?.record.source.kind != .google,
           result.primary?.candidate.priceInfo?.record.source.kind != .google {
            (Text("Cheaper: ").foregroundStyle(Theme.amber).bold()
             + Text("\(ch.candidate.name)\(ch.candidate.exitLabel.map { ", Exit \($0)" } ?? ""), about \(String(format: "$%.2f", ch.savings)) less (estimate)"))
                .font(.caption).lineLimit(1)
                .accessibilityIdentifier("cheaperNote")
        } else if let ch = result.cheaper, let p = result.primary, let price = ch.candidate.price {
            let c = ch.candidate
            let exit = c.exitLabel.map { ", Exit \($0)" } ?? ""
            let move = ch.farther >= 0 ? "\(Format.milesValue(ch.farther)) mi farther" : "\(Format.milesValue(-ch.farther)) mi sooner"
            let keep = p.brandRank != nil ? "Your \(p.candidate.brand.isEmpty ? p.candidate.name : p.candidate.brand) preference stays as it is."
                : "Your favorite brands stay as they are."
            let grade = (trip.priceOptions?.grade ?? .regular).name.lowercased()
            VStack(alignment: .leading, spacing: 3) {
                (Text("Cheaper stop: ").foregroundStyle(Theme.amber).bold() + Text("\(c.name)\(exit), \(move)"))
                    .font(.subheadline)
                Text("\(GasPrices.dollars(price)) \(grade), \((c.priceText ?? "").lowercased()) (\(c.priceSource ?? "source not stated")). Estimate: about \(String(format: "$%.2f", ch.savings)) less for a \(String(format: "%.1f", ch.gallons)) gal fill, detour fuel included\(ch.estimate ? " (a detour was not measured)" : ""). \(keep)")
                    .font(.caption).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.amberFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("cheaperNote")
        }
    }
}

/// A station's id for a sheet.
struct StationRef: Identifiable, Hashable {
    let id: String
}

/// Road Ahead, Fuel: every station and fuel plaza in the window with its price for the driver's grade, sorted
/// as asked. Unknown and old prices never sort as cheaper.
struct ComparePricesCard: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Binding var station: StationRef?
    @State private var sort: GasPrices.Sort = .recommended

    var body: some View {
        if let o = trip.priceOptions {
            let data = trip.priceStations(miles: settings.exitLookaheadMiles)
            let favorites = settings.favoriteBrands
            let byID = Dictionary(data.stations.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            let rows = data.stations.map { c in
                GasPrices.Row(id: c.id, ahead: c.ahead ?? 0, detourMinutes: c.detourMinutes, brandRank: SmartStop.brandIndex(c, favorites: favorites),
                              recommendedRank: data.order.firstIndex(of: c.id), price: c.priceInfo)
            }
            let sorted = GasPrices.sort(rows, by: sort).compactMap { byID[$0.id] }
            VStack(alignment: .leading, spacing: 10) {
                if !trip.priceReports.simulated.isEmpty {
                    Text("SIMULATED PRICES · test data, not real").font(.caption2.weight(.heavy)).tracking(0.4)
                        .foregroundStyle(.white).padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Color(red: 0.82, green: 0.15, blue: 0.44), in: RoundedRectangle(cornerRadius: 6))
                }
                HStack {
                    Text("\(o.grade.name) · \(o.payment.rawValue)").font(.headline)
                    Spacer()
                    Text("\(data.stations.count) \(data.stations.count == 1 ? "stop" : "stops") in \(Int(settings.exitLookaheadMiles)) mi")
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(GasPrices.Sort.allCases, id: \.self) { s in
                            let label = s == .brand ? favorites.first.map { "\($0) first" } ?? s.label : s.label
                            Button { sort = s } label: {
                                Text(label).font(.subheadline.weight(.semibold)).padding(.horizontal, 12).padding(.vertical, 7)
                                    .foregroundStyle(sort == s ? Theme.background : Color.primary)
                                    .background(sort == s ? Color.primary : Theme.raised, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(sort == s ? .isSelected : [])
                            .accessibilityIdentifier("priceSort-\(s.rawValue)")
                        }
                    }
                }
                if settings.googlePrices, !settings.googleKey.isEmpty {
                    Button { trip.checkGooglePricesAhead(miles: settings.exitLookaheadMiles) } label: {
                        Text("Check Google Maps prices for the next 3 exits").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 9)
                            .background(Theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("googleAhead")
                    Text("Paid, on your own key (keep it capped in Google Cloud). This month: \(PriceCallCounter.thisMonth) lookups. Shown here with Google's name, never on the map, not saved.")
                        .font(.caption2).foregroundStyle(Theme.secondaryText)
                }
                if sorted.isEmpty {
                    Text("No gas listed in the next \(Int(settings.exitLookaheadMiles)) miles. Try a longer window.")
                        .font(.footnote).foregroundStyle(Theme.secondaryText)
                }
                ForEach(Array(sorted.prefix(20).enumerated()), id: \.element.id) { i, c in
                    if i > 0 { Divider() }
                    Button { station = StationRef(id: c.id) } label: { row(c, grade: o.grade) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("priceRow")
                }
                Text(sorted.contains(where: { $0.priceInfo != nil }) ? "Prices are reports with their time and source, not verified pump prices. Reports older than \(Int(o.maxAgeHours)) h show greyed and are not compared."
                     : "No current reports for these stations. Tap a station to add the price you see.")
                    .font(.caption2).foregroundStyle(Theme.secondaryText)
            }
            .timelineCard(stroke: Theme.cardStroke)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("comparePrices")
        }
    }

    private func row(_ c: SmartStop.Candidate, grade: GasPriceFeed.Grade) -> some View {
        let e = SmartStop.evaluate(c, preferences: SmartStop.Preferences(settings.values))
        let detour = c.kind == .plaza ? "On the highway" : c.detourMinutes.map { $0 < 1 ? "under 1 min detour" : "\(Int($0.rounded())) min detour" } ?? "Detour not measured"
        return HStack(alignment: .center, spacing: 10) {
            BrandTag(name: c.name, brand: c.brand)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(c.name).font(.subheadline.weight(.bold)).lineLimit(1)
                    if let label = c.exitLabel { ExitSign(label: label, compact: true).scaleEffect(0.8, anchor: .leading).frame(height: 20) }
                    Text("\(Format.milesValue(c.ahead ?? 0)) mi").font(.caption).foregroundStyle(Theme.secondaryText)
                }
                ConfidenceLine(status: e.hours.status.rawValue, label: e.hours.label)
                ConfidenceLine(status: e.restroom.rawValue, label: e.restroom.label)
                Text(detour).font(.caption).foregroundStyle(Theme.secondaryText)
                if let sp = c.priceInfo {
                    Text(PriceText.meta(sp)).font(.caption).foregroundStyle(sp.state == .current ? Theme.secondaryText : Theme.amber)
                }
            }
            Spacer(minLength: 4)
            PriceTag(price: c.priceInfo, grade: grade)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

/// A station's prices for every grade, with their sources, the driver's own reports there, and reporting.
struct StationPricesView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var reporting = false
    @State private var place: (city: String?, state: String?)?

    var body: some View {
        NavigationStack {
            List {
                if let c = trip.findStation(id: id) {
                    let o = trip.priceOptions ?? SmartStop.PriceOptions(grade: settings.gasGrade, maxAgeHours: settings.priceMaxAgeHours, now: Date())
                    let live = trip.googleStation(for: c)
                    Section {
                        HStack(spacing: 12) {
                            BrandTag(name: c.name, brand: c.brand)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.name).font(.headline)
                                Text((c.exitLabel.map { "Exit \($0) · " } ?? (c.kind == .plaza ? "Service plaza · " : "")) + "\(Format.milesValue(c.ahead ?? 0)) mi ahead")
                                    .font(.caption).foregroundStyle(Theme.secondaryText)
                            }
                        }
                    }
                    Section("Prices here") {
                        ForEach(GasPriceFeed.Grade.allCases, id: \.self) { g in
                            let sp = trip.stationPrice(c, grade: g)
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(g.name + (g == o.grade ? "  " : "")) + Text(g == o.grade ? "your grade" : "").font(.caption).foregroundStyle(Theme.secondaryText)
                                    if let sp { Text(PriceText.meta(sp) + (sp.record.payment.map { " · \($0.rawValue)" } ?? "")).font(.caption).foregroundStyle(Theme.secondaryText) }
                                }
                                Spacer()
                                if let sp {
                                    Text(GasPrices.dollars(sp.record.price)).font(.title3.weight(.bold).monospacedDigit())
                                        .foregroundStyle(sp.state == .current ? Color.primary : Theme.secondaryText)
                                } else {
                                    Text("Price unavailable").font(.footnote).foregroundStyle(Theme.secondaryText)
                                }
                            }
                            .accessibilityElement(children: .combine)
                        }
                    }
                    if let at = c.coordinate {
                        let state = place?.state ?? stateCode(c)
                        let gb = PriceCheck.gasBuddy(city: place?.city, state: state)
                        let area = place?.city ?? state.flatMap { PriceCheck.states[$0.uppercased()] ?? $0 } ?? "state"
                        let brand = c.brand.isEmpty ? c.name : c.brand
                        Section {
                            if let url = URL(string: PriceCheck.googleMaps(name: c.name, brand: c.brand, latitude: at.latitude, longitude: at.longitude)) {
                                Link(destination: url) { Label("Google Maps", systemImage: "arrow.up.right.square") }
                                    .accessibilityIdentifier("checkGoogle")
                            }
                            if let gb, let url = URL(string: gb) {
                                Link(destination: url) { Label("GasBuddy", systemImage: "arrow.up.right.square") }
                                    .accessibilityIdentifier("checkGasBuddy")
                            }
                        } header: {
                            Text("Check the posted price")
                        } footer: {
                            Text(gb == nil ? "Opens \(brand) on Google Maps. ExitAtlas does not read or copy prices from it; report the one you see."
                                 : "Opens \(brand) on Google Maps, or the \(area) price page on GasBuddy. ExitAtlas does not read or copy prices from those sites; report the one you see.")
                        }
                        .task(id: c.id) { await lookUpPlace(at) }
                    }
                    Section {
                        Button { reporting = true } label: { Label("Report a price", systemImage: "square.and.pencil") }
                            .accessibilityIdentifier("reportPrice")
                        if settings.googlePrices, let exitID = c.exitID, !settings.googleKey.isEmpty {
                            Button { trip.checkGooglePrices(exitID: exitID) } label: { Label("Check Google Maps prices (paid)", systemImage: "magnifyingglass") }
                        }
                    } footer: {
                        if live != nil { Text("Google prices: Google Maps, looked up when you asked. Not stored or shared.") }
                    }
                    let mine = trip.priceReports.own().filter { $0.stationId == c.id }.sorted { $0.reportedAt > $1.reportedAt }
                    if !mine.isEmpty {
                        Section("Your reports here") {
                            ForEach(mine, id: \.id) { r in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text("\(GasPriceFeed.Grade(code: r.grade)?.name ?? r.grade) \(GasPrices.dollars(r.price))")
                                        Text("\(r.payment?.rawValue ?? "cash or credit not said")\(r.member ? " · member price" : "") · \(r.reportedAt.formatted(date: .abbreviated, time: .shortened))")
                                            .font(.caption).foregroundStyle(Theme.secondaryText)
                                    }
                                    Spacer()
                                }
                                .swipeActions { Button("Delete", role: .destructive) { trip.priceReports.remove(id: r.id) } }
                            }
                        }
                    }
                    Section {
                        EmptyView()
                    } footer: {
                        Text("Prices are what drivers reported, with the time and source of each, not verified pump prices. Your reports stay on this iPhone. Reports older than \(Int(o.maxAgeHours)) h are shown but not compared; after 7 days they are dropped. Grades are never mixed.")
                    }
                } else {
                    Text("Station not found on this route.").foregroundStyle(Theme.secondaryText)
                }
            }
            .navigationTitle("Prices")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $reporting) { ReportPriceView(id: id) }
        }
    }

    /// The state the station is in, from the route (the GasBuddy link before the city is known).
    private func stateCode(_ c: SmartStop.Candidate) -> String? {
        trip.plan?.states.segment(at: c.along)?.code
    }

    /// The station's city from Apple's free reverse geocoder, once, when the sheet opens.
    private func lookUpPlace(_ at: GeoCoordinate) async {
        guard place == nil else { return }
        let marks = try? await CLGeocoder().reverseGeocodeLocation(CLLocation(latitude: at.latitude, longitude: at.longitude))
        if let m = marks?.first { place = (m.locality, m.administrativeArea) }
    }
}

/// Report a price: a few taps, no photo, no account; saved on this iPhone. Only when parked or by a passenger.
struct ReportPriceView: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    @Environment(\.dismiss) private var dismiss
    let id: String
    @State private var grade: GasPriceFeed.Grade = .regular
    @State private var priceText = ""
    @State private var payment: GasPrices.Payment = .credit
    @State private var member = false
    @State private var passenger = false
    @State private var message: (ok: Bool, text: String)?
    @State private var share = true
    @State private var sharing = false
    @FocusState private var focused: Bool

    private var moving: Bool { trip.gpsSource == .device && (trip.currentSpeed ?? 0) > 4.5 }

    var body: some View {
        NavigationStack {
            Form {
                if let c = trip.findStation(id: id) {
                    Section {
                        HStack(spacing: 12) {
                            BrandTag(name: c.name, brand: c.brand)
                            VStack(alignment: .leading) {
                                Text(c.name).font(.headline)
                                if let label = c.exitLabel { Text("Exit \(label)").font(.caption).foregroundStyle(Theme.secondaryText) }
                            }
                        }
                    }
                }
                Section {
                    Picker("Grade", selection: $grade) { ForEach(GasPriceFeed.Grade.allCases, id: \.self) { Text($0.name).tag($0) } }
                        .pickerStyle(.segmented)
                    HStack {
                        Text("$").font(Theme.number(34, weight: .heavy))
                        TextField("3.099", text: $priceText).font(Theme.number(34, weight: .heavy)).keyboardType(.decimalPad).focused($focused)
                            .accessibilityIdentifier("reportPriceField")
                    }
                    Picker("Payment", selection: $payment) {
                        Text("Credit").tag(GasPrices.Payment.credit)
                        Text("Cash").tag(GasPrices.Payment.cash)
                    }
                    .pickerStyle(.segmented)
                    Toggle("Member or loyalty price", isOn: $member)
                    if trip.sharedOn, let c = trip.findStation(id: id) {
                        let check = trip.nearCheck(c)
                        Toggle(isOn: $share) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Share with other ExitAtlas drivers")
                                Text(check.note).font(.caption).foregroundStyle(check.near ? Theme.success : Theme.secondaryText)
                            }
                        }
                        .accessibilityIdentifier("sharePrice")
                    }
                    if moving {
                        Toggle(isOn: $passenger) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("You are moving").foregroundStyle(Theme.amber).bold()
                                Text("Report only when parked, or let a passenger do it. I'm a passenger:").font(.caption)
                            }
                        }
                    }
                } footer: {
                    Text("Saved on this iPhone, never with your location\(trip.sharedOn ? ", and shared only when the switch is on and you are at the station: no account, no name, no location" : ""). You can correct it for 30 minutes. Enter the price on the pump, for example 3.099.")
                }
                Section {
                    Button("Save price") { save() }
                        .frame(maxWidth: .infinity).bold()
                        .disabled((moving && !passenger) || sharing)
                        .accessibilityIdentifier("savePrice")
                    if let message {
                        Text(message.text).font(.footnote).foregroundStyle(message.ok ? Theme.success : Theme.amber)
                            .accessibilityIdentifier("reportMessage")
                    }
                }
            }
            .navigationTitle("Report a price")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onAppear {
                grade = settings.gasGrade
                payment = GasPrices.Payment(rawValue: settings.pricePayment) ?? .credit
            }
        }
    }

    private func save() {
        let text = priceText.replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
        let out = trip.priceReports.report(stationId: id, grade: grade.code, price: Double(text) ?? .nan, payment: payment, member: member)
        if out.saved, let record = out.record, share, trip.sharedOn, let c = trip.findStation(id: id), trip.nearCheck(c).near {
            message = (true, "Saved on this iPhone. Sharing…")
            focused = false
            sharing = true
            Task { @MainActor in
                let result = await trip.share(record)
                message = (true, "Saved on this iPhone. \(result)")
                sharing = false
            }
        } else if out.saved { message = (true, "Saved on this iPhone."); focused = false }
        else if out.duplicate { message = (true, "Already saved: the same price within 30 minutes.") }
        else { message = (false, out.problems.map { PriceText.problems[$0] ?? $0 }.joined(separator: ". ")) }
    }
}

/// Settings: comparing prices and where prices come from. Google Maps prices are paid and off by default.
struct PriceSettingsRows: View {
    @Environment(UserSettings.self) private var settings
    @Environment(TripController.self) private var trip

    private var sharedNote: String {
        if SharedPriceService.base(settings.proxyURL) == nil { return "Needs the ExitAtlas server below (free plan; off until it is set up)" }
        if !trip.sharedPrices.offered { return "The server does not offer shared reports (or cannot be reached)" }
        if case .unavailable = trip.sharedPrices.state(enabled: settings.communityPrices) { return "On, but the last lookup failed" }
        return "From other ExitAtlas drivers, website and iPhone: no account, reports expire after 7 days"
    }

    var body: some View {
        @Bindable var settings = settings
        Section {
            Toggle(isOn: $settings.comparePrices) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Compare prices")
                    Text("In Road Ahead, the fuel stop and station details").font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            .accessibilityIdentifier("comparePricesToggle")
            Picker("I usually pay", selection: $settings.pricePayment) {
                Text("Credit").tag("credit")
                Text("Cash").tag("cash")
            }
            Picker("Compare reports up to", selection: $settings.priceMaxAgeHours) {
                ForEach([6.0, 12.0, 24.0], id: \.self) { Text("\(Int($0)) h").tag($0) }
            }
            Toggle(isOn: $settings.tellCheaper) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tell me when another stop is cheaper")
                    Text("By $\(Int(settings.minSavingsDollars)) or more on a fill; your favorite brands stay first").font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            Picker("Only when it saves at least", selection: $settings.minSavingsDollars) {
                ForEach([1.0, 2.0, 3.0, 5.0], id: \.self) { Text("$\(Int($0))").tag($0) }
            }
        } header: {
            Text("Gas prices")
        }
        Section {
            Toggle(isOn: $settings.ownPriceReports) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Your reports")
                    Text("On this iPhone · \(trip.priceReports.own().count) saved").font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            Toggle(isOn: $settings.communityPrices) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Shared driver reports")
                    Text(sharedNote).font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            .accessibilityIdentifier("sharedPricesToggle")
            LabeledContent("ExitAtlas server") {
                TextField("https://…workers.dev", text: $settings.proxyURL)
                    .multilineTextAlignment(.trailing).keyboardType(.URL)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                    .accessibilityIdentifier("proxyURLField")
                    .onChange(of: settings.proxyURL) { trip.sharedPrices.configure(settings.proxyURL) }
            }
            .onAppear { trip.sharedPrices.configure(settings.proxyURL) }
            Toggle(isOn: $settings.googlePrices) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Google Maps prices")
                    Text("Paid, billed to your own key. Off: never called").font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            .accessibilityIdentifier("googlePricesToggle")
            if settings.googlePrices {
                SecureField("Google Maps Platform key", text: $settings.googleKey)
                    .autocorrectionDisabled().textInputAutocapitalization(.never)
                LabeledContent("Lookups this month", value: "\(PriceCallCounter.thisMonth)")
            }
        } header: {
            Text("Price sources")
        } footer: {
            Text(settings.googlePrices
                 ? "Google bills each lookup to the key's owner after its monthly free allowance; check Google's current pricing. ExitAtlas looks up an exit only when you tap Check Google Maps prices, never by itself, and never stores or shares the prices."
                 : "No free, licensed source publishes station prices for the US (docs/17), so prices come from reports. A station without a current report says Price unavailable and never ranks as cheaper. Regional averages are never shown as a station's price.")
        }
    }
}
