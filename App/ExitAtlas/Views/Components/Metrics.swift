import ExitAtlasCore
import SwiftUI

/// Large number with a unit and caption.
struct MetricTile: View {
    let title: String
    let value: String
    var unit: String? = nil
    var caption: String? = nil
    var valueSize: CGFloat = 30

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Eyebrow(text: title)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(value).font(Theme.number(valueSize)).minimumScaleFactor(0.5).lineLimit(1)
                if let unit { Text(unit).font(.system(.subheadline, design: .rounded).weight(.semibold)).foregroundStyle(Theme.secondaryText) }
            }
            if let caption {
                Text(caption).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(1).minimumScaleFactor(0.8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Progress through the current state.
struct StateProgressBar: View {
    let fraction: Double
    var height: CGFloat = 12

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.cardStroke)
                Capsule()
                    .fill(LinearGradient(colors: [Theme.signGreen, Theme.signGreen.opacity(0.75)], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(height, geo.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: height)
        .accessibilityValue("\(Int((fraction * 100).rounded())) percent")
    }
}

/// Service counts at an exit, by category.
struct ServiceSummary: View {
    let services: [ExitService]
    var categories: [PlaceCategory] = [.gas, .food, .lodging, .restArea, .evCharging]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(categories, id: \.self) { category in
                let count = services.filter { $0.place.category == category }.count
                if count > 0 {
                    HStack(spacing: 3) {
                        Image(systemName: category.symbolName).font(.caption)
                        Text("\(count)").font(.caption.monospacedDigit().weight(.semibold))
                    }
                    .foregroundStyle(Theme.secondaryText)
                    .accessibilityLabel("\(count) \(category.displayName)")
                }
            }
        }
    }
}

/// Shown under the navigation bar on every screen while simulated GPS is driving the app.
struct SimulationBanner: ViewModifier {
    let active: Bool

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            if active {
                Text("SIMULATED GPS · not your real location")
                    .font(.caption2.weight(.bold))
                    .padding(.horizontal, 10).padding(.vertical, 3)
                    .background(.purple, in: Capsule())
                    .foregroundStyle(.white)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity)
            }
        }
    }
}

extension View {
    func simulationBanner(_ active: Bool) -> some View { modifier(SimulationBanner(active: active)) }
}

/// GPS and tracking state, always visible while driving.
struct TrackingStatusPill: View {
    let match: RouteMatch?
    let simulated: Bool
    var rerouting = false

    var body: some View {
        let (text, color, symbol) = describe()
        Label(text, systemImage: symbol)
            .labelStyle(.titleAndIcon)
            .fixedSize()
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: Capsule())
    }

    private func describe() -> (String, Color, String) {
        if rerouting { return ("Rerouting", Theme.amber, "arrow.triangle.branch") }
        if simulated { return ("Simulation", .purple, "play.circle.fill") }
        guard let match else { return ("Waiting for GPS", Theme.secondaryText, "location.slash") }
        switch match.status {
        case .acquiring: return ("Finding route", Theme.secondaryText, "location")
        case .onRoute: return match.isEstimated ? ("Estimating (no GPS)", Theme.amber, "location.slash") : ("On route", Theme.signGreen, "location.fill")
        case .offRoute: return ("Off route", Theme.shieldRed, "exclamationmark.triangle.fill")
        case .signalLost: return ("GPS signal lost", Theme.shieldRed, "location.slash.fill")
        }
    }
}
