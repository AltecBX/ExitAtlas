import ExitAtlasCore
import SwiftUI

// Discover ahead, the license plate game, share cards and the Road Trip Passport. Same rules as the
// web version (web/js/app/views.js, sharecard.js).

/// Up to five notable places in the next 200 miles: the best scored, shown in route order.
struct DiscoverSection: View {
    let plan: TripPlan
    let snapshot: TripSnapshot

    var body: some View {
        let ahead = plan.discover.filter {
            $0.distanceAlongRoute > snapshot.progress && $0.distanceAlongRoute - snapshot.progress <= 200 * Geodesy.metersPerMile
        }
        let top = ahead.sorted { $0.item.score > $1.item.score }.prefix(5).sorted { $0.distanceAlongRoute < $1.distanceAlongRoute }
        if !top.isEmpty {
            Section {
                ForEach(top) { x in
                    NavigationLink(value: x) { DiscoverRow(place: x, snapshot: snapshot, plan: plan) }
                        .accessibilityIdentifier("discoverRow")
                }
            } header: {
                Text("Discover ahead")
            } footer: {
                Text("Notable places from Wikidata within 5 to 10 miles of the highway. Distances off the highway are straight lines; the drive is longer. Check hours before you go.")
            }
        }
    }
}

private struct DiscoverRow: View {
    let place: RouteDiscovery
    let snapshot: TripSnapshot
    let plan: TripPlan

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: place.item.cat.symbolName).font(.title3).foregroundStyle(Theme.signBrown).frame(width: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(place.item.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text([place.item.cat.title, place.exit.map { "near \($0.displayTitle)" }, "\(Format.miles(place.offMeters)) off the highway"]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(2)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                Text(Format.miles(place.distanceAlongRoute - snapshot.progress)).font(.subheadline.monospacedDigit().weight(.bold))
                let eta = plan.eta(from: snapshot.progress, to: place.distanceAlongRoute, pace: snapshot.pace, now: snapshot.timestamp)
                Text(Format.duration(eta.timeIntervalSince(snapshot.timestamp))).font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct DiscoverDetailView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.openURL) private var openURL
    let place: RouteDiscovery

    var body: some View {
        let it = place.item
        List {
            Section {
                Label(it.cat.title, systemImage: it.cat.symbolName).foregroundStyle(Theme.signBrown)
                if let snapshot = trip.snapshot, place.distanceAlongRoute > snapshot.progress {
                    LabeledContent("Ahead on the route", value: Format.miles(place.distanceAlongRoute - snapshot.progress))
                }
                if let exit = place.exit { LabeledContent("Nearest exit", value: exit.displayTitle) }
                LabeledContent("Off the highway", value: "\(Format.miles(place.offMeters)) straight line")
                if let desc = it.desc { Text(String(desc.prefix(1)).uppercased() + String(desc.dropFirst())) }
            }
            Section {
                Button("Directions in Apple Maps") { open("https://maps.apple.com/?daddr=\(it.lat),\(it.lon)&dirflg=d") }
                Button("Directions in Google Maps") { open("https://www.google.com/maps/dir/?api=1&destination=\(it.lat),\(it.lon)") }
                if let wiki = it.wiki, let url = URL(string: wiki) { Link("Wikipedia", destination: url) }
                if trip.canAddStop {
                    Button("Add to trip") {
                        trip.addStop(Waypoint(name: it.name, coordinate: it.coordinate), alongRoute: place.distanceAlongRoute)
                    }
                    .bold()
                }
            } footer: {
                Text(note)
            }
        }
        .navigationTitle(it.name)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var note: String {
        let source = "From Wikidata (\(place.item.id), CC0): linked from \(place.item.sitelinks) Wikimedia sites (Wikipedia editions and sister projects). "
            + "Hours, fees and closures are not in this data."
        return trip.canAddStop ? source : "Adding it to the trip reroutes through it, which needs live GPS (not the demo). " + source
    }

    private func open(_ link: String) {
        if let url = URL(string: link) { openURL(url) }
    }
}

/// Passenger game: tap each state's plate when you spot it. Kept for the current trip on this phone.
struct LicensePlatesView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss
    @AppStorage("plates") private var stored = ""

    private var seen: Set<String> {
        let parts = stored.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2, parts[0] == trip.tripKey else { return [] }
        return Set(parts[1].split(separator: ",").map(String.init))
    }

    private func save(_ codes: Set<String>) {
        stored = trip.tripKey + "|" + Passport.stateCodes.filter(codes.contains).joined(separator: ",")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Text("For passengers: tap each state's plate when you spot it. **\(seen.count)** of \(Passport.stateCodes.count) on this trip.")
                    .font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 52), spacing: 6)], spacing: 6) {
                    ForEach(Passport.stateCodes, id: \.self) { code in
                        let on = seen.contains(code)
                        Button {
                            var s = seen
                            if on { s.remove(code) } else { s.insert(code) }
                            save(s)
                        } label: {
                            Text(code).font(.system(.callout, design: .rounded).weight(.heavy))
                                .frame(maxWidth: .infinity).padding(.vertical, 10)
                                .foregroundStyle(on ? .white : Theme.secondaryText)
                                .background(on ? AnyShapeStyle(Theme.signGreen) : AnyShapeStyle(Theme.card), in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.cardStroke, lineWidth: on ? 0 : 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                Button("Start over", role: .destructive) { save([]) }.padding(.top, 12)
            }
            .padding()
            .navigationTitle("License Plates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// The share card for a trip: miles driven and the miles in each state (GPS measured, or marked simulated).
struct TripCardView: View {
    let title: String
    let date: Date
    let totalMeters: Double
    let states: [(code: String, meters: Double)]
    let simulated: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text(simulated ? "SIMULATED DRIVE" : "ROAD TRIP").font(SignFont.font(15, weight: .bold))
                Text(title).font(SignFont.font(28, weight: .heavy)).lineLimit(2).minimumScaleFactor(0.6)
            }
            .foregroundStyle(.white)
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.signGreen, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.white.opacity(0.95), lineWidth: 2.5).padding(5))
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Int((totalMeters / Geodesy.metersPerMile).rounded()).formatted()).font(.system(size: 64, weight: .heavy, design: .rounded))
                Text(Int((totalMeters / Geodesy.metersPerMile).rounded()) == 1 ? "mile" : "miles").font(.title2.weight(.bold)).foregroundStyle(.secondary)
            }
            Text("\(states.count) \(states.count == 1 ? "state" : "states")").font(.title3.weight(.bold)).foregroundStyle(.secondary)
            let longest = max(states.map { $0.meters }.max() ?? 1, 1)
            ForEach(Array(states.prefix(9).enumerated()), id: \.offset) { _, s in
                HStack(spacing: 10) {
                    Text(s.code).font(.system(.headline, design: .rounded).weight(.heavy)).foregroundStyle(.white)
                        .frame(width: 44, height: 30).background(Tokens.signBlue, in: RoundedRectangle(cornerRadius: 6))
                    GeometryReader { geo in
                        RoundedRectangle(cornerRadius: 5).fill(Tokens.signGreen)
                            .frame(width: max(8, geo.size.width * 0.75 * s.meters / longest), height: 22)
                            .frame(maxHeight: .infinity, alignment: .center)
                    }
                    .frame(height: 30)
                    Text("\(Int((s.meters / Geodesy.metersPerMile).rounded())) mi").font(.subheadline.weight(.bold)).frame(width: 70, alignment: .trailing)
                }
            }
            Spacer(minLength: 0)
            HStack {
                Text(date.formatted(date: .long, time: .omitted) + (simulated ? " · simulated GPS, not a real drive" : " · miles measured by GPS"))
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text("ExitAtlas").font(SignFont.font(15, weight: .heavy)).foregroundStyle(Tokens.signGreen)
            }
        }
        .padding(24)
        .frame(width: 400, height: 500)
        .background(Color(light: 0xF2F3F5, dark: 0xF2F3F5))
        .foregroundStyle(Color(light: 0x0E1116, dark: 0x0E1116))
        .environment(\.colorScheme, .light)
    }
}

/// Shows a share card and the system share sheet for its image.
struct ShareCardSheet<Card: View>: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let card: Card
    @State private var image: Image?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                card.scaleEffect(0.8).frame(width: 320, height: 400)
                if let image {
                    ShareLink(item: image, preview: SharePreview(title, image: image)) {
                        Label("Share", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.signGreen)
                }
            }
            .padding()
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task {
                let renderer = ImageRenderer(content: card)
                renderer.scale = 3
                if let ui = renderer.uiImage { image = Image(uiImage: ui) }
            }
        }
    }
}

/// Road Trip Passport: states and achievements from real GPS trips (simulated drives are not saved).
struct PassportView: View {
    @Environment(TripLibrary.self) private var library
    @State private var showShare = false

    private var passport: Passport {
        Passport(trips: library.history.map { r in
            Passport.Trip(startedAt: r.startedAt, totalMeters: r.totalMeters, states: r.states.map { ($0.code, $0.name, $0.meters) })
        })
    }

    var body: some View {
        let p = passport
        List {
            Section {
                HStack {
                    MetricTile(title: "States driven", value: "\(p.stamps.count)", caption: "of \(Passport.stateCodes.count)", valueSize: 26)
                    MetricTile(title: "Miles tracked", value: Int((p.totalMeters / Geodesy.metersPerMile).rounded()).formatted(),
                               caption: "\(p.tripCount) \(p.tripCount == 1 ? "trip" : "trips")", valueSize: 26)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 40), spacing: 4)], spacing: 4) {
                    ForEach(Passport.stateCodes, id: \.self) { code in
                        let stamp = p.stamps[code]
                        Text(code).font(.system(.caption, design: .rounded).weight(.heavy))
                            .frame(maxWidth: .infinity).padding(.vertical, 7)
                            .foregroundStyle(stamp != nil ? .white : Theme.secondaryText)
                            .background(stamp != nil ? AnyShapeStyle(Theme.signGreen) : AnyShapeStyle(Theme.cardStroke.opacity(0.5)),
                                        in: RoundedRectangle(cornerRadius: 8))
                            .accessibilityLabel(stamp.map { "\($0.name), \(Format.miles($0.meters))" } ?? "\(code), not yet")
                    }
                }
                .padding(.vertical, 4)
            } footer: {
                Text("Real GPS trips only, saved on this phone. Simulated drives are not counted.")
            }
            let earned = p.achievements.filter(\.earned)
            if !earned.isEmpty {
                Section("Earned") {
                    ForEach(earned) { a in Label(a.title, systemImage: "star.fill").foregroundStyle(Theme.success) }
                }
            }
            Section("Next up") {
                ForEach(p.achievements.filter { !$0.earned }.sorted { $0.progress > $1.progress }.prefix(4)) { a in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack { Text(a.title).font(.subheadline.weight(.semibold)); Spacer(); Text(a.detail).font(.caption).foregroundStyle(Theme.secondaryText) }
                        ProgressView(value: a.progress).tint(Theme.signGreen)
                    }
                }
            }
            Section {
                Button { showShare = true } label: { Label("Share passport", systemImage: "square.and.arrow.up") }
                    .disabled(p.tripCount == 0)
            }
        }
        .navigationTitle("Road Trip Passport")
        .sheet(isPresented: $showShare) {
            ShareCardSheet(title: "Passport", card: PassportCardView(passport: p))
        }
    }
}

private struct PassportCardView: View {
    let passport: Passport

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("ROAD TRIP PASSPORT").font(SignFont.font(15, weight: .bold))
                Text("\(passport.stamps.count) of \(Passport.stateCodes.count) states").font(SignFont.font(28, weight: .heavy))
            }
            .foregroundStyle(.white)
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.signGreen, in: RoundedRectangle(cornerRadius: 14))
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 4) {
                ForEach(Passport.stateCodes, id: \.self) { code in
                    let on = passport.stamps[code] != nil
                    Text(code).font(.system(size: 13, weight: .heavy, design: .rounded))
                        .frame(maxWidth: .infinity).padding(.vertical, 6)
                        .foregroundStyle(on ? .white : Color(light: 0x525C69, dark: 0x525C69))
                        .background(on ? Tokens.signGreen : Color(light: 0xDFE3E8, dark: 0xDFE3E8), in: RoundedRectangle(cornerRadius: 6))
                }
            }
            Text("\(Int((passport.totalMeters / Geodesy.metersPerMile).rounded()).formatted()) miles · \(passport.tripCount) trips")
                .font(.headline)
            ForEach(passport.achievements.filter(\.earned).prefix(3)) { a in Text("★ \(a.title)").font(.subheadline) }
            Spacer(minLength: 0)
            HStack { Text("Real GPS trips only").font(.caption).foregroundStyle(.secondary); Spacer()
                Text("ExitAtlas").font(SignFont.font(15, weight: .heavy)).foregroundStyle(Tokens.signGreen) }
        }
        .padding(24)
        .frame(width: 400, height: 500)
        .background(Color(light: 0xF2F3F5, dark: 0xF2F3F5))
        .foregroundStyle(Color(light: 0x0E1116, dark: 0x0E1116))
        .environment(\.colorScheme, .light)
    }
}
