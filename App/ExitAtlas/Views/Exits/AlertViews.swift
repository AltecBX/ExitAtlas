import ExitAtlasCore
import SwiftUI

/// Words and icons for road alerts, shared by the Drive card, the Then strip and Road Ahead.
enum AlertText {
    static func icon(_ kind: RoadIntel.Kind) -> String {
        switch kind {
        case .closure: return "⛔"
        case .crash, .hazard, .other: return "⚠️"
        case .flooding: return "🌊"
        case .weather: return "⛈️"
        case .disabledVehicle: return "🚗"
        case .construction: return "🚧"
        case .congestion: return "🐢"
        case .police: return "🚓"
        case .speedCamera: return "📷"
        }
    }

    /// Weather shows the warning's own name; other kinds their label.
    static func title(_ i: RoadIntel.Incident) -> String {
        i.kind == .weather || i.kind == .flooding ? i.description : i.kind.label
    }

    static func subtitle(_ i: RoadIntel.Incident) -> String? {
        if i.kind == .weather || i.kind == .flooding { return i.area }
        if let lanes = i.lanes, !lanes.isEmpty { return lanes }
        return i.description != title(i) && !i.description.isEmpty ? i.description : nil
    }

    /// "Source: National Weather Service · Updated 6 minutes ago · until 8:45 PM", and "starts 8:00 PM" for
    /// scheduled work that has not begun.
    static func meta(_ a: RoadIntel.Alert, now: Date, timeZoneID: String?, reference: Date) -> String {
        var parts = ["Source: " + a.sources.map(\.name).joined(separator: ", "), RoadIntel.freshnessText(a.incident, now: now)]
        if let start = a.incident.startsAt, start > now { parts.append("starts " + Format.time(start, timeZoneID: timeZoneID, relativeTo: reference)) }
        if let end = a.incident.endsAt { parts.append("until " + Format.time(end, timeZoneID: timeZoneID, relativeTo: reference)) }
        return parts.joined(separator: " · ")
    }
}

/// A road alert in Road Ahead, in route order.
struct AlertRow: View {
    @Environment(TripController.self) private var trip
    let alert: RoadIntel.Alert
    let progress: Double
    let now: Date

    var body: some View {
        let i = alert.incident
        let length = !alert.approximate && alert.end - alert.start > 0.5 * Geodesy.metersPerMile ? " for \(Format.miles(alert.end - alert.start))" : ""
        HStack(spacing: 10) {
            Text(AlertText.icon(i.kind)).font(.title2).frame(width: 64)
            VStack(alignment: .leading, spacing: 2) {
                Text(AlertText.title(i) + length).font(.subheadline.weight(.bold))
                let sub = [i.lanes, i.verification == .community ? "Reported by drivers, not confirmed" : nil,
                           alert.directionKnown ? nil : "Direction not reported"].compactMap { $0 }.joined(separator: " · ")
                if !sub.isEmpty { Text(sub).font(.caption) }
                Text(AlertText.meta(alert, now: Date(), timeZoneID: trip.plan?.timeZoneID(at: alert.start), reference: now))
                    .font(.caption2).foregroundStyle(Theme.secondaryText)
            }
            Spacer()
            Text(alert.start <= progress ? "Now" : Format.miles(alert.start - progress)).font(.subheadline.monospacedDigit().weight(.bold))
        }
        .listRowBackground((alert.serious ? Theme.danger : Theme.amber).opacity(0.12))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("alertRow")
    }
}

/// What the alert sources say, each group with its state: "no relevant reports" and "data unavailable"
/// are different things and both are shown as such.
struct AlertStatusView: View {
    let intel: RoadIntel.Result

    /// Groups that are switched on.
    private var groups: [RoadIntel.Group] { RoadIntel.Group.allCases.filter { (intel.status[$0]?.state ?? .off) != .off } }

    private var title: String {
        let n = intel.alerts.count
        if n > 0 { return "\(n) road \(n == 1 ? "alert" : "alerts") on your route" }
        if groups.contains(where: { intel.status[$0]?.state == .unavailable }) { return "Some road alert sources are unavailable" }
        return "Road alerts: none from connected sources"
    }

    var body: some View {
        DisclosureGroup(title) {
            ForEach(groups, id: \.self) { g in
                let st = intel.status[g]
                HStack(alignment: .firstTextBaseline) {
                    Text(g.label).font(.caption.weight(.semibold)).frame(width: 130, alignment: .leading)
                    Text((st?.label ?? "") + (st?.note.map { " · \($0)" } ?? "")).font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
        }
        .font(.subheadline)
        .accessibilityIdentifier("alertStatus")
    }
}
