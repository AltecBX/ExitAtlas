import ExitAtlasCore
import SwiftUI

/// Sign lettering: Overpass (SIL Open Font License, bundled in Resources/Fonts), scaled with Dynamic Type.
enum SignFont {
    static func font(_ size: CGFloat, weight: Font.Weight = .bold, relativeTo style: Font.TextStyle = .body) -> Font {
        let name: String
        switch weight {
        case .heavy, .black: name = "OverpassRoman-ExtraBold"
        case .semibold, .medium, .regular, .light: name = "OverpassRoman-SemiBold"
        default: name = "OverpassRoman-Bold"
        }
        return .custom(name, size: size, relativeTo: style)
    }
}

/// Wraps its children onto new lines (service plaques).
struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: min(maxX, width), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

/// Service plaques: one tile per category naming the nearest places, as text (no brand logos).
/// Blue for motorist services, brown for parks, following highway sign meanings.
struct ServicePlaques: View {
    let services: [ExitService]
    var compact = false

    static let order: [PlaceCategory] = [.gas, .food, .lodging, .evCharging, .restArea, .park, .dogPark]

    static func word(_ c: PlaceCategory) -> String {
        switch c {
        case .gas: return "GAS"
        case .food: return "FOOD"
        case .lodging: return "LODGING"
        case .evCharging: return "EV"
        case .restArea: return "REST AREA"
        case .park: return "PARK"
        case .dogPark: return "DOG PARK"
        default: return c.displayName.uppercased()
        }
    }

    static func uniqueNames(_ items: [ExitService], _ category: PlaceCategory) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for item in items {
            let name = item.place.brand.isEmpty ? item.place.name : item.place.brand
            if !name.isEmpty, name != category.displayName, seen.insert(name).inserted { out.append(name) }
        }
        return out
    }

    var body: some View {
        FlowLayout(spacing: compact ? 5 : 6) {
            ForEach(Self.order, id: \.self) { category in
                let items = services.filter { $0.place.category == category }.sorted { $0.detourMeters < $1.detourMeters }
                if !items.isEmpty { plaque(category, items) }
            }
        }
    }

    @ViewBuilder
    private func plaque(_ category: PlaceCategory, _ items: [ExitService]) -> some View {
        let names = Self.uniqueNames(items, category)
        let shown = Array(names.prefix(compact ? 1 : 2))
        let more = items.count - shown.count
        let color = (category == .park || category == .dogPark) ? Theme.signBrown : Theme.signBlue
        Group {
            if compact {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(Self.word(category)).font(SignFont.font(12, weight: .heavy, relativeTo: .caption))
                    if let first = shown.first { Text(first).font(SignFont.font(15, weight: .semibold, relativeTo: .subheadline)).lineLimit(1) }
                    if more > 0 { Text(shown.isEmpty ? "\(more)" : "+\(more)").font(SignFont.font(12, weight: .semibold, relativeTo: .caption)) }
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.word(category)).font(SignFont.font(12, weight: .heavy, relativeTo: .caption))
                    ForEach(shown, id: \.self) { Text($0).font(SignFont.font(15, weight: .semibold, relativeTo: .subheadline)).lineLimit(1) }
                    if more > 0 { Text(shown.isEmpty ? "\(more)" : "+\(more) more").font(SignFont.font(12, weight: .semibold, relativeTo: .caption)) }
                }
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 4 : 6)
        .background(color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(.white.opacity(0.9), lineWidth: 1.5).padding(1.5))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(category.displayName): " + (shown.isEmpty ? "\(items.count) places" : shown.joined(separator: ", ") + (more > 0 ? " and \(more) more" : "")))
    }
}

/// Advance guide sign for the next exit: exit tab, the exit's name or its services, distance and time.
struct GuideSign: View {
    let exit: RouteExit
    let distance: Double
    let seconds: TimeInterval
    let services: [ExitService]

    private var title: String {
        if !exit.name.isEmpty { return exit.name }
        let words = ServicePlaques.order.filter { c in c != .park && c != .dogPark && services.contains { $0.place.category == c } }
            .map(ServicePlaques.word)
        return words.isEmpty ? "No services listed" : words.joined(separator: " · ")
    }

    var body: some View {
        let miles = distance / Geodesy.metersPerMile
        let value = miles < 10 ? String(format: "%.1f", miles) : String(Int(miles.rounded()))
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(SignFont.font(24, relativeTo: .title2)).lineLimit(2).minimumScaleFactor(0.7)
                .padding(.trailing, 96)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(value).font(SignFont.font(44, weight: .heavy, relativeTo: .largeTitle)).monospacedDigit()
                Text(value == "1.0" ? "MILE" : "MILES").font(SignFont.font(15, relativeTo: .subheadline))
                Spacer()
                Text(Format.duration(seconds)).font(SignFont.font(20, relativeTo: .title3))
            }
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 16).padding(.top, 20).padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.signGreen, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(.white.opacity(0.95), lineWidth: 2).padding(3))
        .overlay(alignment: .topTrailing) {
            ExitSign(label: exit.label).offset(x: -14, y: -14)
        }
        .padding(.top, 14)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(exit.label.isEmpty ? "Next exit" : "Exit \(exit.label)"), \(title), \(value) miles, \(Format.duration(seconds))")
    }
}

/// The state ledger: the whole route as one bar split into states in proportion to their miles,
/// with the driven part filled and a pin where you are. ExitAtlas's signature element.
struct StateRibbon: View {
    let snapshot: TripSnapshot

    var body: some View {
        let items = snapshot.itinerary
        let total = items.reduce(0) { $0 + $1.segment.length }
        if total > 0, items.count >= 2 {
            let start = items[0].segment.startDistance
            let position = min(1, max(0, (snapshot.progress - start) / total))
            let colors = colorIndexes(items)
            VStack(spacing: 4) {
                GeometryReader { geo in
                    let width = geo.size.width - CGFloat(items.count - 1) * 2
                    ZStack(alignment: .leading) {
                        HStack(spacing: 2) {
                            ForEach(Array(items.enumerated()), id: \.offset) { i, f in
                                let w = max(2, width * f.segment.length / total)
                                let color = colors[i].map { Theme.segmentColors[$0 % 4] } ?? Theme.cardStroke
                                ZStack(alignment: .leading) {
                                    Rectangle().fill(color.opacity(0.28))
                                    Rectangle().fill(color).frame(width: w * filled(f))
                                }
                                .frame(width: w, height: 12)
                                .clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
                            }
                        }
                        RoundedRectangle(cornerRadius: 2).fill(Color.primary)
                            .frame(width: 4, height: 20)
                            .offset(x: geo.size.width * position - 2)
                    }
                    .frame(height: 20)
                }
                .frame(height: 20)
                GeometryReader { geo in
                    let width = geo.size.width - CGFloat(items.count - 1) * 2
                    HStack(spacing: 2) {
                        ForEach(Array(items.enumerated()), id: \.offset) { _, f in
                            let w = max(2, width * f.segment.length / total)
                            Text(w >= 26 ? (f.segment.code ?? "") : "")
                                .font(.system(.caption2, design: .rounded).weight(.heavy))
                                .foregroundStyle(f.status == .current ? Color.primary : Theme.secondaryText)
                                .frame(width: w).lineLimit(1)
                        }
                    }
                }
                .frame(height: 14)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Route by state: " + items.compactMap { f in f.segment.code.map { _ in "\(f.segment.displayName) \(Format.miles(f.segment.length))" } }.joined(separator: ", ")
                + ". You are \(Int((position * 100).rounded())) percent of the way.")
        }
    }

    private func filled(_ f: SegmentForecast) -> Double {
        switch f.status {
        case .completed: return 1
        case .current: return min(1, max(0, (snapshot.progress - f.segment.startDistance) / max(f.segment.length, 1)))
        case .upcoming: return 0
        }
    }

    private func colorIndexes(_ items: [SegmentForecast]) -> [Int?] {
        var next = 0
        return items.map { f in
            guard f.segment.code != nil else { return nil }
            defer { next += 1 }
            return next
        }
    }
}

/// Ring speedometer from GPS speed with the posted limit as a tick; amber over the limit, red when over by the alert margin.
struct Speedometer: View {
    let mph: Int?
    let limit: Int?
    let alertOver: Double

    enum Level { case ok, warn, over }

    var level: Level {
        guard let mph, let limit else { return .ok }
        let over = Double(mph - limit)
        return over <= 0 ? .ok : over <= alertOver ? .warn : .over
    }

    var body: some View {
        let maxMPH = (mph ?? 0) > 112 ? 140.0 : 120.0
        let fraction = min(1, Double(mph ?? 0) / maxMPH)
        let color: Color = level == .over ? Theme.danger : level == .warn ? Theme.amber : Theme.signGreen
        ZStack {
            Circle().trim(from: 0, to: 0.75).stroke(Theme.cardStroke, style: StrokeStyle(lineWidth: 12, lineCap: .round))
                .rotationEffect(.degrees(135))
            Circle().trim(from: 0, to: 0.75 * fraction).stroke(color, style: StrokeStyle(lineWidth: 12, lineCap: .round))
                .rotationEffect(.degrees(135))
            if let limit {
                Rectangle().fill(Color.primary).frame(width: 3, height: 14)
                    .offset(y: -52)
                    .rotationEffect(.degrees(-135 + 270 * min(1, Double(limit) / maxMPH)))
            }
            VStack(spacing: 0) {
                Text(mph.map(String.init) ?? "—").font(Theme.number(48, weight: .heavy)).monospacedDigit()
                    .foregroundStyle(level == .over ? Theme.danger : Color.primary)
                Text("MPH").font(.system(.caption, design: .rounded).weight(.heavy)).foregroundStyle(Theme.secondaryText)
            }
        }
        .frame(width: 128, height: 128)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mph.map { "\($0) miles per hour" } ?? "Speed unavailable")
    }
}

/// White regulatory sign with the posted limit (OpenStreetMap), or a dash when unknown.
struct SpeedLimitSign: View {
    let limit: Int?
    let loading: Bool

    var body: some View {
        VStack(spacing: 2) {
            Text("SPEED\nLIMIT").font(.system(size: 11, weight: .heavy)).multilineTextAlignment(.center).lineSpacing(-2)
            Text(limit.map(String.init) ?? (loading ? "…" : "—")).font(.system(size: 34, weight: .heavy)).monospacedDigit()
        }
        .foregroundStyle(.black)
        .frame(width: 72, height: 88)
        .background(.white, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(.black, lineWidth: 2.5).padding(4))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).stroke(Theme.cardStroke, lineWidth: 1))
        .opacity(limit == nil ? 0.6 : 1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(limit.map { "Speed limit \($0)" } ?? "Speed limit not available")
    }
}
