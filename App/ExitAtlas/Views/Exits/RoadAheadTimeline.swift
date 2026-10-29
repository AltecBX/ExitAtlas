import ExitAtlasCore
import SwiftUI

// The pieces of the Road Ahead timeline (docs/15): the filters, one row per event with its dot on the rail,
// the alert cards and their detail sheet, and the best stop card. Same layout and words as the website.

/// Road Ahead filters: everything, one kind at a time, then exits by a service they list.
enum AheadFilter: String, CaseIterable, Identifiable {
    case all, alerts, fuel, rest, states, food, lodging, ev, dog

    var id: String { rawValue }
    static let primary: [AheadFilter] = [.all, .alerts, .fuel, .rest, .states]
    static let services: [AheadFilter] = [.food, .lodging, .ev, .dog]

    var title: String {
        switch self {
        case .all: return "All"
        case .alerts: return "Alerts"
        case .fuel: return "Fuel"
        case .rest: return "Rest"
        case .states: return "States"
        case .food: return "Food"
        case .lodging: return "Lodging"
        case .ev: return "EV"
        case .dog: return "Dog parks"
        }
    }

    /// The service an exit must list under the service filters.
    var service: PlaceCategory? {
        switch self {
        case .food: return .food
        case .lodging: return .lodging
        case .ev: return .evCharging
        case .dog: return .dogPark
        default: return nil
        }
    }
}

struct AheadFilterBar: View {
    @Binding var selection: AheadFilter
    let alertCount: Int
    let urgent: Bool

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(AheadFilter.primary) { chip($0) }
                Rectangle().fill(Theme.cardStroke).frame(width: 1, height: 22).padding(.horizontal, 2)
                ForEach(AheadFilter.services) { chip($0) }
            }
            .padding(2)
        }
    }

    private func chip(_ f: AheadFilter) -> some View {
        let on = selection == f
        return Button { withAnimation(.easeInOut(duration: 0.15)) { selection = f } } label: {
            HStack(spacing: 5) {
                if let s = f.service { Image(systemName: s.symbolName).font(.caption.weight(.bold)) }
                Text(f.title).font(.subheadline.weight(.semibold))
                if f == .alerts, alertCount > 0 {
                    Text("\(alertCount)").font(.caption.weight(.heavy)).monospacedDigit()
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .foregroundStyle(urgent ? Theme.danger : Theme.amber)
                        .background(urgent ? Theme.dangerFill : Theme.amberFill, in: Capsule())
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .foregroundStyle(on ? Theme.background : Color.primary)
            .background(on ? AnyShapeStyle(Color.primary) : AnyShapeStyle(Theme.card), in: Capsule())
            .overlay(Capsule().stroke(Theme.cardStroke, lineWidth: on ? 0 : 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("filter-\(f.rawValue)")
    }
}

/// An alert to show in the detail sheet.
struct AlertRef: Identifiable {
    let id: String
}

extension RoadIntel.Tier {
    var color: Color {
        switch self {
        case .urgent: return Theme.danger
        case .caution: return Theme.amber
        case .info: return Theme.info
        }
    }

    var fill: Color {
        switch self {
        case .urgent: return Theme.dangerFill
        case .caution: return Theme.amberFill
        case .info: return Theme.infoFill
        }
    }

    var word: String {
        switch self {
        case .urgent: return "Urgent"
        case .caution: return "Caution"
        case .info: return "Information"
        }
    }
}

extension View {
    /// A timeline card: the surface, its outline, and an optional colored edge on the leading side.
    func timelineCard(fill: Color = Theme.card, stroke: Color = Theme.cardStroke, edge: Color? = nil) -> some View {
        self
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(fill, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .leading) {
                if let edge {
                    UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, style: .continuous).fill(edge).frame(width: 4)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(stroke, lineWidth: 1))
    }
}

/// One row of the timeline: its dot on the rail, colored by kind, beside its card. The rail runs through the
/// dots from the first row to the last.
struct TimelineRow<Content: View>: View {
    let dot: Color
    var filled = false
    var halo = false
    let first: Bool
    let last: Bool
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.leading, 24)
            .padding(.bottom, 8)
            .background(alignment: .topLeading) {
                VStack(spacing: 0) {
                    Rectangle().fill(first ? Color.clear : Theme.cardStroke).frame(width: 2, height: 22)
                    Circle().fill(filled ? dot : Theme.background)
                        .overlay(Circle().stroke(dot, lineWidth: 2.5))
                        .frame(width: 12, height: 12)
                        .background(Circle().fill(halo ? Theme.dangerFill : Color.clear).frame(width: 22, height: 22))
                    Rectangle().fill(last ? Color.clear : Theme.cardStroke).frame(width: 2)
                }
                .frame(width: 14)
                .accessibilityHidden(true)
            }
    }
}

/// Miles to an event, with the time to it or a caption under.
struct TimelineDistance: View {
    let meters: Double
    var eta: TimeInterval?
    var caption: String?

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if meters <= 0 {
                Text("Now").font(Theme.number(22, weight: .heavy))
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(Format.milesValue(meters)).font(Theme.number(24, weight: .heavy)).monospacedDigit()
                    Text("mi").font(.caption.weight(.bold)).foregroundStyle(Theme.secondaryText)
                }
            }
            if let eta { Text(eta < 60 ? "under 1 min" : Format.duration(eta)).font(.caption).foregroundStyle(Theme.secondaryText) }
            if let caption { Text(caption).font(.caption).foregroundStyle(Theme.secondaryText) }
        }
        .fixedSize()
    }
}

/// The SmartStop pick marked on its row, with its hours confidence.
struct PickTag: View {
    let pick: SmartStop.Pick
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(title, systemImage: "star.fill").font(.caption.weight(.heavy)).foregroundStyle(Theme.success)
            ConfidenceLine(status: pick.evaluation.hours.status.rawValue, label: pick.evaluation.hours.label)
        }
        .accessibilityIdentifier("recommendedTag")
    }
}

struct TimelineExitCard: View {
    let upcoming: UpcomingExit
    let services: [ExitService]
    let now: Date
    let pick: SmartStop.Pick?
    let pickTitle: String

    var body: some View {
        let exit = upcoming.exit
        let words = ServicePlaques.words(services, max: 3)
        let title = !exit.name.isEmpty ? exit.name : words.isEmpty ? "No services listed" : words.joined(separator: " · ")
        NavigationLink(value: exit) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    ExitSign(label: exit.label, compact: true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title).font(.subheadline.weight(.semibold)).lineLimit(2)
                            .foregroundStyle(exit.name.isEmpty && words.isEmpty ? Theme.secondaryText : Color.primary)
                        if let pick { PickTag(pick: pick, title: pickTitle) }
                        if exit.confidence == .medium {
                            Text("Direction not verified in source data").font(.caption).foregroundStyle(Theme.amber)
                        }
                    }
                    Spacer(minLength: 4)
                    TimelineDistance(meters: upcoming.distance, eta: upcoming.eta.timeIntervalSince(now))
                }
                if !services.isEmpty { ServicePlaques(services: services, compact: true) }
            }
            .timelineCard(stroke: pick != nil ? Theme.success : Theme.cardStroke, edge: pick != nil ? Theme.success : nil)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("exitRow")
    }
}

struct TimelineRestCard: View {
    let upcoming: UpcomingRestArea
    let now: Date
    let pick: SmartStop.Pick?
    let pickTitle: String

    var body: some View {
        let r = upcoming.restArea
        let sub = [r.side == .both ? "Serves both directions" : nil, r.road].compactMap { $0 }.joined(separator: " · ")
        NavigationLink(value: r) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 12) {
                    RestAreaSign(kind: r.kind, compact: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(r.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                        if !sub.isEmpty { Text(sub).font(.caption).foregroundStyle(Theme.secondaryText) }
                        if let pick { PickTag(pick: pick, title: pickTitle) }
                    }
                    Spacer(minLength: 4)
                    TimelineDistance(meters: upcoming.distance, eta: upcoming.eta.timeIntervalSince(now))
                }
                AmenityChips(restArea: r, maxCount: 4)
            }
            .timelineCard(stroke: pick != nil ? Theme.success : Theme.cardStroke, edge: pick != nil ? Theme.success : nil)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("restAreaRow")
    }
}

/// A state line ahead, or (States filter) the state you are in.
struct TimelineStateCard: View {
    let forecast: SegmentForecast
    let distance: Double
    let current: Bool
    let isFinal: Bool
    let now: Date

    var body: some View {
        let seg = forecast.segment
        HStack(spacing: 12) {
            StateBadge(code: seg.code, highlighted: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(current ? "YOU ARE IN" : "STATE LINE").font(.caption2.weight(.heavy)).tracking(0.8).foregroundStyle(Theme.secondaryText)
                Text(current ? seg.displayName : "Entering \(seg.displayName)\(seg.visit > 1 ? " (again)" : "")")
                    .font(.subheadline.weight(.bold)).lineLimit(2)
                Text(facts).font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer(minLength: 4)
            if isFinal {
                Text("Final state").font(.caption).foregroundStyle(Theme.secondaryText)
            } else {
                TimelineDistance(meters: distance, caption: current ? "to the line" : nil)
            }
        }
        .timelineCard(fill: Theme.accent.opacity(0.09), stroke: Theme.accent.opacity(0.35))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(current ? "currentStateRow" : "stateLineRow")
    }

    private var facts: String {
        if current {
            let pct = Int((min(max(forecast.fractionComplete, 0), 1) * 100).rounded())
            return "\(forecast.exitsRemaining) \(forecast.exitsRemaining == 1 ? "exit" : "exits") left · \(pct)% driven"
        }
        var parts = ["\(Format.miles(forecast.totalMeters)) on route", "\(forecast.exitCount) \(forecast.exitCount == 1 ? "exit" : "exits")"]
        if let t = forecast.entryTime { parts.append("cross \(Format.time(t, timeZoneID: forecast.entryTimeZoneID, relativeTo: now))") }
        if forecast.segment.isBrief { parts.append("brief crossing") }
        return parts.joined(separator: " · ")
    }
}

/// A stretch without gas longer than the driver's setting.
struct TimelineGapCard: View {
    let gap: GasGaps.Gap
    let progress: Double

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "fuelpump.slash.fill").font(.title3).foregroundStyle(Theme.amber).frame(width: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text("No gas for \(Format.miles(gap.length))\(gap.open ? "+" : "")").font(.subheadline.weight(.bold))
                Text((gap.before.map { "After \($0.title)" } ?? "From here")
                     + (gap.after.map { ", next gas at \($0.title)" } ?? (gap.open ? ", none listed beyond" : ", none before your destination")))
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer(minLength: 4)
            TimelineDistance(meters: max(0, gap.from - progress))
        }
        .timelineCard(fill: Theme.amberFill, stroke: .clear)
        .accessibilityElement(children: .combine)
    }
}

struct TimelineStopCard: View {
    let stop: RouteStop
    let distance: Double
    let eta: Date?
    let now: Date

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "mappin.circle.fill").font(.title2).foregroundStyle(Theme.signGreen).frame(width: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(stop.waypoint.name).font(.subheadline.weight(.semibold)).lineLimit(2)
                Text("Planned stop").font(.caption).foregroundStyle(Theme.secondaryText)
            }
            Spacer(minLength: 4)
            TimelineDistance(meters: distance, eta: eta.map { $0.timeIntervalSince(now) })
        }
        .timelineCard()
        .accessibilityElement(children: .combine)
    }
}

/// A road alert in the timeline: the headline in its tier color, the road, the details, how old and whose.
struct TimelineAlertCard: View {
    @Environment(TripController.self) private var trip
    let alert: RoadIntel.Alert
    let progress: Double
    let now: Date
    let eta: Date?
    let open: () -> Void

    var body: some View {
        let i = alert.incident
        let tier = i.tier
        let length = !alert.approximate && alert.end - alert.start > 0.5 * Geodesy.metersPerMile ? " for \(Format.miles(alert.end - alert.start))" : ""
        let flags = [i.verification == .community ? "Reported by drivers, not confirmed" : nil,
                     alert.directionKnown ? nil : "Direction not reported",
                     alert.approximate ? "Area alert, position approximate" : nil].compactMap { $0 }.joined(separator: " · ")
        Button(action: open) {
            HStack(alignment: .center, spacing: 12) {
                AlertIcon(kind: i.kind, tier: tier)
                VStack(alignment: .leading, spacing: 2) {
                    Text(i.headline.uppercased()).font(.caption.weight(.heavy)).tracking(0.8).foregroundStyle(tier.color)
                    Text((AlertText.road(alert, plan: trip.plan) ?? "On your route") + length).font(.subheadline.weight(.bold))
                    if let sub = AlertText.subtitle(i) { Text(sub).font(.caption) }
                    if !flags.isEmpty { Text(flags).font(.caption.weight(.semibold)).foregroundStyle(Theme.amber) }
                    Text(AlertText.meta(alert, now: Date(), timeZoneID: trip.plan?.timeZoneID(at: alert.start), reference: now))
                        .font(.caption2).foregroundStyle(Theme.secondaryText)
                }
                Spacer(minLength: 4)
                TimelineDistance(meters: alert.start - progress, eta: eta.map { $0.timeIntervalSince(now) })
            }
            .timelineCard(fill: tier == .info ? Theme.card : tier.color.opacity(0.10), stroke: tier == .urgent ? Theme.danger : Theme.cardStroke, edge: tier.color)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("alertRow")
    }
}

/// The alert's emoji on a tile in its tier color.
struct AlertIcon: View {
    let kind: RoadIntel.Kind
    let tier: RoadIntel.Tier

    var body: some View {
        Text(AlertText.icon(kind)).font(.system(size: 20))
            .frame(width: 40, height: 40)
            .background(tier.fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// An alert's detail: everything the source said, where it is, how sure, and whether the Drive screen shows it.
struct AlertDetailView: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss
    let alertID: String

    var body: some View {
        let alert = trip.roadIntel?.alerts.first { $0.incident.id == alertID }
        NavigationStack {
            Group {
                if let a = alert, let s = trip.snapshot {
                    content(a, s)
                } else {
                    ContentUnavailableView("This alert is no longer current", systemImage: "clock.arrow.circlepath",
                                           description: Text("It expired, ended, or is now behind you."))
                }
            }
            .navigationTitle(alert?.incident.headline ?? "Road alert")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .accessibilityIdentifier("alertDetail")
    }

    private func content(_ a: RoadIntel.Alert, _ s: TripSnapshot) -> some View {
        let i = a.incident
        let tier = i.tier
        let zone = trip.plan?.timeZoneID(at: a.start)
        let road = AlertText.road(a, plan: trip.plan)
        let now = Date()
        let times = [i.startsAt.map { ($0 > now ? "Starts " : "Started ") + Format.time($0, timeZoneID: zone, relativeTo: s.timestamp) },
                     i.endsAt.map { "until " + Format.time($0, timeZoneID: zone, relativeTo: s.timestamp) },
                     i.expiresAt.map { "report expires " + Format.time($0, timeZoneID: zone, relativeTo: s.timestamp) }].compactMap { $0 }.joined(separator: " · ")
        let ahead = a.start <= s.progress ? "Here now" : "\(Format.miles(a.start - s.progress)) ahead"
        let extent = a.approximate ? "area alert, position approximate" : a.end - a.start > 0.5 * Geodesy.metersPerMile ? "for \(Format.miles(a.end - a.start))" : "at one location"
        let verification: String
        switch i.verification {
        case .official: verification = "Official source"
        case .community: verification = "Reported by drivers, not confirmed"
        case .mapped: verification = "Mapped work zone schedule"
        }
        let drive = !a.notable ? "Road Ahead only: lanes open or not stated" : a.serious ? "Shown from 50 mi ahead, before routine stops" : "Shown within 10 mi"
        let police = trip.roadIntel?.status[.police].map { "\(RoadIntel.Group.police.label): \($0.label)." } ?? ""
        return List {
            Section {
                HStack(alignment: .top, spacing: 12) {
                    AlertIcon(kind: i.kind, tier: tier)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tier.word.uppercased() + (road.map { " · " + $0.uppercased() } ?? "")).font(.caption.weight(.heavy)).tracking(0.8).foregroundStyle(tier.color)
                        Text(i.description.isEmpty ? i.kind.label : i.description).font(.headline)
                        if let lanes = i.lanes, !lanes.isEmpty { Text(lanes).font(.subheadline) }
                    }
                }
                .listRowBackground(tier.fill)
            }
            Section {
                LabeledContent("Where", value: "\(ahead) · \(extent)")
                LabeledContent("Direction", value: a.directionKnown ? "Your direction of travel" : "Not reported by the source")
                LabeledContent("Severity", value: i.severity == .unknown ? "Not stated" : i.severity.rawValue.capitalized)
                LabeledContent("Status", value: verification)
                LabeledContent("Reported", value: RoadIntel.freshnessText(i, now: now))
                if !times.isEmpty { LabeledContent("Times", value: times) }
                LabeledContent("Source", value: a.sources.map(\.name).joined(separator: ", "))
                LabeledContent("Drive screen", value: drive)
            }
            .font(.subheadline)
            Section {
                Text("ExitAtlas shows what the listed sources report and does not confirm events on the road. Expired and ended reports are removed. \(police)")
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
    }
}

/// The best stop ahead (SmartStop): one recommendation with what is known about its hours, its restroom and
/// the detour, then the reasons and up to two alternatives behind "Why this stop".
struct BestStopCard: View {
    @Environment(TripController.self) private var trip
    let result: SmartStop.Result
    let title: String
    @State private var expanded = false

    var body: some View {
        if let p = result.primary {
            let c = p.candidate
            let alternatives = Array(result.alternatives.prefix(2))
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text((result.overnight ? "🌙 " : "") + title.uppercased()).font(.caption.weight(.heavy)).tracking(0.8).foregroundStyle(Theme.success)
                    Spacer(minLength: 4)
                    if p.brandRank != nil { Label("Favorite brand", systemImage: "star.fill").font(.caption).foregroundStyle(Theme.secondaryText) }
                }
                HStack(spacing: 12) {
                    SmartStopSign(candidate: c)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.name).font(.title3.weight(.bold)).lineLimit(2)
                        Text(SmartStopText.arrival(c, now: trip.snapshot?.timestamp ?? Date())).font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                    Spacer(minLength: 4)
                    TimelineDistance(meters: c.ahead ?? 0)
                }
                VStack(alignment: .leading, spacing: 3) {
                    ConfidenceLine(status: p.evaluation.hours.status.rawValue, label: p.evaluation.hours.label)
                    ConfidenceLine(status: p.evaluation.restroom.rawValue, label: p.evaluation.restroom.label)
                    Text(SmartStopText.detour(c)).font(.caption).foregroundStyle(Theme.secondaryText)
                }
                if let notice = result.notice { Text(notice).font(.caption.weight(.semibold)).foregroundStyle(Theme.amber) }
                Button { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } } label: {
                    HStack {
                        Text("Why this stop" + (alternatives.isEmpty ? "" : " · \(alternatives.count) \(alternatives.count == 1 ? "alternative" : "alternatives")"))
                            .font(.subheadline.weight(.semibold))
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.right").font(.caption.weight(.bold)).rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .foregroundStyle(Theme.accent)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("whyThisStop")
                if expanded {
                    VStack(alignment: .leading, spacing: 10) {
                        VStack(alignment: .leading, spacing: 3) {
                            ForEach(Array((p.reasons + (p.nextOption.map { ["Next option \(Format.miles($0)) later"] } ?? [])).enumerated()), id: \.offset) { _, r in
                                Text("• " + r).font(.caption)
                            }
                        }
                        ForEach(Array(alternatives.enumerated()), id: \.offset) { _, x in alternative(x) }
                    }
                }
                HStack(spacing: 10) {
                    if let id = c.exitID, let exit = trip.plan?.exits.first(where: { $0.id == id }) {
                        NavigationLink(value: exit) { buttonLabel("Exit details") }.buttonStyle(.plain)
                    } else if let r = trip.plan?.restAreas.first(where: { $0.id == c.id }) {
                        NavigationLink(value: r) { buttonLabel(c.kind == .rest ? "Rest area details" : "Plaza details") }.buttonStyle(.plain)
                    }
                    Button { trip.skipStop(c.id) } label: { buttonLabel("Not this one") }.buttonStyle(.plain)
                }
            }
            .timelineCard(stroke: Theme.success.opacity(0.55))
            // A container, so the ids of the buttons inside stay theirs.
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("bestStopCard")
        }
    }

    private func alternative(_ x: SmartStop.Pick) -> some View {
        HStack(alignment: .top, spacing: 10) {
            SmartStopSign(candidate: x.candidate)
            VStack(alignment: .leading, spacing: 3) {
                Text(x.candidate.name).font(.subheadline.weight(.bold))
                Text(SmartStopText.whereLine(x.candidate) + " · " + SmartStopText.detour(x.candidate)).font(.caption).foregroundStyle(Theme.secondaryText)
                ConfidenceLine(status: x.evaluation.hours.status.rawValue, label: x.evaluation.hours.label)
                ConfidenceLine(status: x.evaluation.restroom.rawValue, label: x.evaluation.restroom.label)
            }
            Spacer(minLength: 4)
            Button("Skip") { trip.skipStop(x.candidate.id) }.buttonStyle(.bordered).controlSize(.small)
                .accessibilityLabel("Not this one: \(x.candidate.name)")
        }
        .padding(.top, 10)
        .overlay(alignment: .top) { Rectangle().fill(Theme.cardStroke).frame(height: 1) }
    }

    private func buttonLabel(_ text: String) -> some View {
        Text(text).font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity).padding(.vertical, 10)
            .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
