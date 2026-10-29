import ExitAtlasCore
import SwiftUI

/// Words and icons for road alerts, shared by the Drive card, Road Ahead and the alert sheet.
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

    /// "I-95 North" where the alert starts on the route.
    static func road(_ a: RoadIntel.Alert, plan: TripPlan?) -> String? {
        plan?.route.highway(at: a.start).map { "\($0.ref) \($0.direction.word)" }
    }
}

/// What the alert sources say, each group with its state: "no relevant reports" and "data unavailable"
/// are different things and both are shown as such.
struct AlertStatusView: View {
    let intel: RoadIntel.Result
    @State private var open: Bool

    init(intel: RoadIntel.Result, expanded: Bool = false) {
        self.intel = intel
        _open = State(initialValue: expanded)
    }

    /// Groups that are switched on.
    private var groups: [RoadIntel.Group] { RoadIntel.Group.allCases.filter { (intel.status[$0]?.state ?? .off) != .off } }

    private var title: String {
        let n = intel.alerts.count
        if n > 0 { return "\(n) road \(n == 1 ? "alert" : "alerts") on your route" }
        if groups.contains(where: { intel.status[$0]?.state == .unavailable }) { return "Some road alert sources are unavailable" }
        return "Road alerts: none from connected sources"
    }

    var body: some View {
        DisclosureGroup(title, isExpanded: $open) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(groups, id: \.self) { g in
                    let st = intel.status[g]
                    HStack(alignment: .firstTextBaseline) {
                        Text(g.label).font(.caption.weight(.semibold)).frame(width: 130, alignment: .leading)
                        Text((st?.label ?? "") + (st?.note.map { " · \($0)" } ?? "")).font(.caption).foregroundStyle(Theme.secondaryText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .font(.subheadline)
        .accessibilityIdentifier("alertStatus")
    }
}
