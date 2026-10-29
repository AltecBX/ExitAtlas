import ExitAtlasCore
import MapKit
import SwiftUI

// The two Drive presentations (docs/15): the Navigation View, map first, and the Focus View, the compact
// dashboard. Both share the guidance banner, the speed and posted limit, one adaptive card (DashboardFocus,
// held steady by its Stabilizer) and the journey panel (state line and trip strip). Same layout and rules as
// the website (web/js/app/views.js).

// MARK: Shared pieces

extension ServicePlaques {
    /// "Gas", "Food", "Lodging", "EV", "Rest Area": the services an exit sign lists, in sign order.
    static func words(_ services: [ExitService], max: Int = .max) -> [String] {
        order.filter { c in [.gas, .food, .lodging, .evCharging, .restArea].contains(c) && services.contains { $0.place.category == c } }
            .prefix(max).map { $0 == .evCharging ? "EV" : word($0).capitalized }
    }
}

/// The small switch between the two presentations, saved in the profile.
struct DrivePresentationToggle: View {
    @Environment(UserSettings.self) private var settings

    var body: some View {
        HStack(spacing: 2) {
            option("map", symbol: "map", label: "Navigation view", id: "navigationViewButton")
            option("focus", symbol: "gauge.with.dots.needle.33percent", label: "Focus view", id: "focusViewButton")
        }
        .padding(3)
        .background(Theme.raised, in: Capsule())
        .overlay(Capsule().stroke(Theme.cardStroke, lineWidth: 1))
    }

    private func option(_ value: String, symbol: String, label: String, id: String) -> some View {
        let on = (settings.drivePresentation == "focus" ? "focus" : "map") == value
        return Button {
            withAnimation(.easeInOut(duration: 0.2)) { settings.drivePresentation = value }
        } label: {
            Image(systemName: symbol).font(.system(size: 15, weight: .semibold))
                .frame(width: 40, height: 30)
                .foregroundStyle(on ? Color.white : Theme.secondaryText)
                .background(on ? AnyShapeStyle(Theme.accent) : AnyShapeStyle(Color.clear), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(id)
    }
}

/// A round control over the map.
struct RoundIconButton: View {
    let symbol: String
    let label: String
    var id: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 19, weight: .semibold))
                .frame(width: 48, height: 48)
                .foregroundStyle(.primary)
                .background(Theme.raised, in: Circle())
                .overlay(Circle().stroke(Theme.cardStroke, lineWidth: 1))
                .shadow(color: .black.opacity(0.28), radius: 12, y: 6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id ?? label)
    }
}

/// Speed in a ring, colored by the posted limit.
struct SpeedChip: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings

    var body: some View {
        let mph = trip.speedMPH
        let limit = trip.speedLimit.mph
        let over = mph.flatMap { m in limit.map { Double(m - $0) } } ?? 0
        let color: Color = over <= 0 ? Theme.cardStroke : over <= settings.speedAlertOver ? Theme.amber : Theme.danger
        VStack(spacing: 0) {
            Text(mph.map(String.init) ?? "—").font(Theme.number(27, weight: .heavy))
                .foregroundStyle(over > settings.speedAlertOver ? Theme.danger : over > 0 ? Theme.amber : Color.primary)
            Text("MPH").font(.system(size: 10, weight: .heavy, design: .rounded)).foregroundStyle(Theme.secondaryText)
        }
        .frame(width: 70, height: 70)
        .background(Theme.raised, in: Circle())
        .overlay(Circle().stroke(color, lineWidth: 2))
        .shadow(color: .black.opacity(0.28), radius: 12, y: 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(mph.map { "\($0) miles per hour" } ?? "Speed unavailable")
        .accessibilityIdentifier("speedChip")
    }
}

/// The guidance banner: the next maneuver when one comes within 10 miles (from the route's own steps),
/// else the next exit with its services, as a green guide sign. A second line keeps the other in view.
struct GuidanceBanner: View {
    @Environment(TripController.self) private var trip
    let snapshot: TripSnapshot
    let openExit: (RouteExit) -> Void

    var body: some View {
        let maneuver = trip.mode == .trip ? trip.plan.flatMap {
            Guidance.next(on: $0.route, progress: snapshot.progress, within: 10 * Geodesy.metersPerMile,
                          destinationName: $0.route.destination.name, exits: $0.exits)
        } : nil
        VStack(alignment: .leading, spacing: 6) {
            if let m = maneuver {
                sign {
                    HStack(spacing: 12) {
                        Image(systemName: Self.symbol(m)).font(.system(size: 34, weight: .bold)).frame(width: 44)
                        VStack(alignment: .leading, spacing: 2) {
                            distance(m.distance)
                            Text(m.text).font(SignFont.font(19, relativeTo: .headline)).lineLimit(2).minimumScaleFactor(0.8)
                        }
                        Spacer(minLength: 0)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(m.text), in \(Format.miles(m.distance))")
                if let ne = snapshot.nextExit, ne.distance < m.distance - 50, m.kind != .exit {
                    chip("Next exit · \(ne.exit.displayTitle) · \(Format.miles(ne.distance))") { openExit(ne.exit) }
                }
            } else if let ne = snapshot.nextExit {
                Button { openExit(ne.exit) } label: {
                    sign {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 10) {
                                ExitSign(label: ne.exit.label, compact: true)
                                distance(ne.distance)
                                Spacer(minLength: 4)
                                Text(Format.duration(ne.eta.timeIntervalSince(snapshot.timestamp))).font(SignFont.font(17, relativeTo: .body))
                            }
                            let w = words(ne.exit)
                            Text(w.name ?? (w.services.isEmpty ? "No services listed" : w.services))
                                .font(SignFont.font(19, relativeTo: .headline)).lineLimit(1).minimumScaleFactor(0.8)
                            if w.name != nil, !w.services.isEmpty {
                                Text(w.services).font(SignFont.font(14, weight: .semibold, relativeTo: .subheadline)).opacity(0.9).lineLimit(1)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("guidanceExit")
                if let hw = snapshot.highway {
                    let far = trip.mode == .trip ? trip.plan.flatMap { Guidance.next(on: $0.route, progress: snapshot.progress) } : nil
                    chip(hw.shortLabel + (far.map { " for \(Format.miles($0.distance))" } ?? ""), action: nil)
                }
            } else if let hw = snapshot.highway {
                Text("\(hw.shortLabel) · No exits listed ahead on this road").font(.subheadline.weight(.semibold))
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading).floating()
            }
        }
        // A container, so its id does not replace the ids of the exit sign and chips inside.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("guidanceBanner")
    }

    private func sign<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content()
            .foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.signGreen, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 15, style: .continuous).stroke(.white.opacity(0.9), lineWidth: 1.5).padding(3))
            .shadow(color: .black.opacity(0.3), radius: 14, y: 8)
    }

    private func distance(_ meters: Double) -> some View {
        let mi = meters / Geodesy.metersPerMile
        return HStack(alignment: .firstTextBaseline, spacing: 2) {
            if mi < 0.1 {
                Text("Now").font(SignFont.font(28, weight: .heavy, relativeTo: .title))
            } else {
                Text(mi < 10 ? String(format: "%.1f", mi) : String(Int(mi.rounded()))).font(SignFont.font(30, weight: .heavy, relativeTo: .title)).monospacedDigit()
                Text("mi").font(SignFont.font(17, relativeTo: .body))
            }
        }
    }

    private func chip(_ text: String, action: (() -> Void)?) -> some View {
        Button { action?() } label: {
            Text(text).font(.caption.weight(.semibold)).lineLimit(1)
                .foregroundStyle(action == nil ? Theme.secondaryText : Color.primary)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Theme.raised, in: Capsule())
                .overlay(Capsule().stroke(Theme.cardStroke, lineWidth: 1))
                .shadow(color: .black.opacity(0.22), radius: 8, y: 4)
        }
        .buttonStyle(.plain)
        .disabled(action == nil)
    }

    /// The next exit's name, and the services there as a sign lists them.
    private func words(_ exit: RouteExit) -> (name: String?, services: String) {
        (exit.name.isEmpty ? nil : exit.name, ServicePlaques.words(trip.services(for: exit)).joined(separator: " · "))
    }

    static func symbol(_ m: Guidance.Maneuver) -> String {
        switch m.kind {
        case .arrive: return "flag.checkered"
        case .roundabout: return "arrow.triangle.turn.up.right.circle"
        case .merge: return "arrow.triangle.merge"
        case .exit: return m.side == .left ? "arrow.up.left" : "arrow.up.right"
        case .fork, .ramp: return m.side == .left ? "arrow.up.left" : m.side == .right ? "arrow.up.right" : "arrow.up"
        case .turn: return m.side == .left ? "arrow.turn.up.left" : m.side == .right ? "arrow.turn.up.right" : m.side == .uturn ? "arrow.uturn.down" : "arrow.up"
        case .other: return m.side == .left ? "arrow.up.left" : m.side == .right ? "arrow.up.right" : "arrow.up"
        }
    }
}

/// The journey panel, the same in both presentations: the next state with the miles and exits to its line,
/// the crossing time and the share of this state driven, over the trip strip (miles left, arrival, states).
struct JourneyPanel: View {
    @Environment(TripController.self) private var trip
    let snapshot: TripSnapshot
    var emphasis = false
    var large = false
    let openTrip: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let current = snapshot.current {
                VStack(alignment: .leading, spacing: 6) {
                    if large { StateRibbon(snapshot: snapshot).padding(.bottom, 4) }
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        StateBadge(code: current.segment.code, highlighted: true, compact: true)
                        if let next = snapshot.next {
                            Image(systemName: "arrow.right").font(.caption.weight(.heavy)).foregroundStyle(Theme.secondaryText)
                            StateBadge(code: next.segment.code, compact: true)
                            Text(next.segment.displayName).font(.system(size: large ? 24 : 17, weight: .heavy, design: .rounded))
                                .lineLimit(1).minimumScaleFactor(0.7).padding(.leading, 2)
                        } else {
                            Text("Final state: \(current.segment.displayName)").font(.system(size: 17, weight: .heavy, design: .rounded)).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text(Format.milesValue(current.remainingMeters)).font(Theme.number(large ? 31 : 25, weight: .heavy))
                            Text("mi").font(.subheadline.weight(.bold)).foregroundStyle(Theme.secondaryText)
                        }
                        .foregroundStyle(emphasis ? Theme.amber : Color.primary)
                    }
                    Text(facts(current)).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(1).minimumScaleFactor(0.85)
                    StateProgressBar(fraction: current.fractionComplete)
                }
                .padding(.horizontal, 14).padding(.top, 11).padding(.bottom, 10)
                .accessibilityElement(children: .combine)
                Rectangle().fill(Theme.cardStroke).frame(height: 1)
            }
            Button(action: openTrip) { tripStrip }.buttonStyle(.plain)
        }
        .floating()
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(emphasis ? Theme.amber : .clear, lineWidth: 1.5))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("journeyPanel")
    }

    private func facts(_ current: SegmentForecast) -> String {
        guard snapshot.next != nil else { return "\(current.exitsRemaining) exits left · \(Int((current.fractionComplete * 100).rounded()))% driven" }
        var parts = ["\(current.exitsRemaining) exit\(current.exitsRemaining == 1 ? "" : "s") left in \(current.segment.code ?? "this state")"]
        if let t = current.exitTime { parts.append("crossing \(Format.time(t, timeZoneID: current.exitTimeZoneID, relativeTo: snapshot.timestamp))") }
        parts.append("\(Int((min(max(current.fractionComplete, 0), 1) * 100).rounded()))% of \(current.segment.code ?? current.segment.displayName)")
        return parts.joined(separator: " · ")
    }

    private var tripStrip: some View {
        HStack(alignment: .firstTextBaseline) {
            if trip.mode == .discovery {
                metric(Format.milesValue(snapshot.remaining), "mi of corridor ahead")
            } else {
                metric(Format.milesValue(snapshot.remaining), "mi left")
                Spacer(minLength: 6)
                metric(Format.time(snapshot.eta, relativeTo: snapshot.timestamp), "arrival")
                Spacer(minLength: 6)
                metric("\(snapshot.statesAhead.count)", snapshot.statesAhead.count == 1 ? "state" : "states")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("tripStrip")
    }

    private func metric(_ value: String, _ label: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            Text(value).font(Theme.number(16, weight: .heavy)).lineLimit(1)
            Text(label).font(.caption).foregroundStyle(Theme.secondaryText).lineLimit(1)
        }
    }
}

// MARK: Navigation View

/// The map fills the screen: guidance at the top, speed on the left, the presentation switch and the fuel
/// and restroom controls on the right, one adaptive card and the journey panel at the bottom. Sideways, the
/// card and the journey panel move to a column on the right.
struct NavigationDriveView: View {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(TripController.self) private var trip
    let snapshot: TripSnapshot
    let focus: DashboardFocus.Result
    let alert: RoadIntel.Alert?
    let card: AnyView?
    let openExit: (RouteExit) -> Void
    let openFuel: () -> Void
    let openRestroom: () -> Void
    let openTrip: () -> Void
    @State private var following = true

    var body: some View {
        ZStack {
            NavigationMapView(snapshot: snapshot, alert: alert, following: $following)
                .ignoresSafeArea()
            if verticalSizeClass == .compact {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 10) {
                        GuidanceBanner(snapshot: snapshot, openExit: openExit)
                        Spacer(minLength: 0)
                        HStack(alignment: .bottom) { speed; Spacer(); controls(horizontal: true) }
                    }
                    VStack(spacing: 8) {
                        Spacer(minLength: 0)
                        if let card { card }
                        JourneyPanel(snapshot: snapshot, emphasis: focus.focus == .border, openTrip: openTrip)
                    }
                    .frame(maxWidth: 380)
                }
                // Sideways the tab bar floats over the bottom edge; keep the journey panel clear of it.
                .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 22)
            } else {
                VStack(spacing: 10) {
                    GuidanceBanner(snapshot: snapshot, openExit: openExit)
                    HStack(alignment: .top) { speed; Spacer(); controls(horizontal: false) }
                    Spacer(minLength: 0)
                    if let card { card }
                    JourneyPanel(snapshot: snapshot, emphasis: focus.focus == .border, openTrip: openTrip)
                }
                .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("navigationDrive")
    }

    private var speed: some View {
        HStack(spacing: 8) {
            SpeedChip()
            SpeedLimitSign(limit: trip.speedLimit.mph, loading: trip.speedLimit.state == .loading, scale: 0.72)
                .shadow(color: .black.opacity(0.25), radius: 8, y: 4)
        }
    }

    @ViewBuilder
    private func controls(horizontal: Bool) -> some View {
        let layout = horizontal ? AnyLayout(HStackLayout(spacing: 10)) : AnyLayout(VStackLayout(alignment: .trailing, spacing: 10))
        layout {
            DrivePresentationToggle().shadow(color: .black.opacity(0.22), radius: 10, y: 5)
            if !following { RoundIconButton(symbol: "location.north.line.fill", label: "Follow my position", id: "recenterButton") { following = true } }
            RoundIconButton(symbol: "fuelpump.fill", label: "Fuel", id: "fuelButton", action: openFuel)
            RoundIconButton(symbol: "figure.dress.line.vertical.figure", label: "Restroom stop", id: "restroomButton", action: openRestroom)
        }
    }
}

// MARK: Focus View

/// Everything a driver needs on one screen, no map: instruments with the one tap Fuel and Restroom buttons,
/// the journey panel with the state ribbon, the next exit (or the maneuver when one is near) and one adaptive
/// card. Sideways: instruments and the journey on the left, the exit and the card on the right.
struct FocusDriveView: View {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    let snapshot: TripSnapshot
    let focus: DashboardFocus.Result
    let card: AnyView?
    let openExit: (RouteExit) -> Void
    let openFuel: () -> Void
    let openRestroom: () -> Void
    let openTrip: () -> Void

    var body: some View {
        if verticalSizeClass == .compact {
            HStack(alignment: .top, spacing: 12) {
                VStack(spacing: 8) { instruments; JourneyPanel(snapshot: snapshot, emphasis: focus.focus == .border, openTrip: openTrip) }
                VStack(spacing: 8) { exitRow; if let card { card } }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("focusDrive")
        } else {
            VStack(spacing: 8) {
                instruments
                journey
                exitRow
                if let card { card }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("focusDrive")
        }
    }

    private var instruments: some View {
        let limit = trip.speedLimit
        return HStack(alignment: .center, spacing: 10) {
            Speedometer(mph: trip.speedMPH, limit: limit.mph, alertOver: settings.speedAlertOver, size: verticalSizeClass == .compact ? 80 : 90)
            VStack(spacing: 4) {
                SpeedLimitSign(limit: limit.mph, loading: limit.state == .loading, scale: 0.78)
                if let next = limit.next {
                    Text("\(next.mph) in \(Format.miles(next.distance))").font(.caption2.monospacedDigit()).foregroundStyle(Theme.secondaryText)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                HighwayShield(ref: snapshot.highway?.ref, size: 40)
                Text(snapshot.highway.map { $0.ref.description } ?? "Local roads")
                    .font(.system(.title3, design: .rounded).weight(.heavy)).lineLimit(1).minimumScaleFactor(0.7)
                if let direction = snapshot.highway?.direction.word {
                    Text(direction).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.secondaryText)
                }
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 8) {
                DrivePresentationToggle()
                HStack(spacing: 8) {
                    action("Fuel", symbol: "fuelpump.fill", id: "fuelButton", openFuel)
                    action("Restroom stop", symbol: "figure.dress.line.vertical.figure", id: "restroomButton", openRestroom)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.cardStroke, lineWidth: 1))
    }

    private var journey: some View {
        JourneyPanel(snapshot: snapshot, emphasis: focus.focus == .border, large: true, openTrip: openTrip)
    }

    @ViewBuilder
    private var exitRow: some View {
        let near = trip.mode == .trip && trip.plan.flatMap {
            Guidance.next(on: $0.route, progress: snapshot.progress, within: 10 * Geodesy.metersPerMile)
        } != nil
        if near {
            GuidanceBanner(snapshot: snapshot, openExit: openExit)
        } else if let ne = snapshot.nextExit {
            let services = trip.services(for: ne.exit)
            Button { openExit(ne.exit) } label: {
                VStack(alignment: .leading, spacing: 6) {
                    CompactGuideSign(upcoming: ne, services: services, now: snapshot.timestamp)
                    if !services.isEmpty {
                        ServicePlaques(services: services, compact: true).frame(maxHeight: 30, alignment: .top).clipped()
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("nextExitRow")
        }
    }

    /// A one tap shortcut on the instruments card, the same round control as over the map.
    private func action(_ label: String, symbol: String, id: String, _ run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: symbol).font(.system(size: 17, weight: .semibold))
                .frame(width: 40, height: 40)
                .foregroundStyle(.primary)
                .background(Theme.raised, in: Circle())
                .overlay(Circle().stroke(Theme.cardStroke, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}

/// The next exit as a compact green guide sign: number, distance and time on one line, then the name or
/// the services.
struct CompactGuideSign: View {
    let upcoming: UpcomingExit
    let services: [ExitService]
    let now: Date

    var body: some View {
        let exit = upcoming.exit
        let words = ServicePlaques.words(services)
        let title = !exit.name.isEmpty ? exit.name : words.isEmpty ? "No services listed" : words.joined(separator: " · ")
        let mi = upcoming.distance / Geodesy.metersPerMile
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                ExitSign(label: exit.label, compact: true)
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(mi < 10 ? String(format: "%.1f", mi) : String(Int(mi.rounded()))).font(SignFont.font(28, weight: .heavy, relativeTo: .title)).monospacedDigit()
                    Text("mi").font(SignFont.font(15, relativeTo: .body))
                }
                Spacer(minLength: 4)
                Text(Format.duration(upcoming.eta.timeIntervalSince(now))).font(SignFont.font(16, relativeTo: .body))
            }
            Text(title).font(SignFont.font(18, relativeTo: .headline)).lineLimit(1).minimumScaleFactor(0.8)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.signGreen, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(.white.opacity(0.95), lineWidth: 2).padding(3))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Next exit, \(exit.label.isEmpty ? "" : "Exit \(exit.label), ")\(title), \(Format.miles(upcoming.distance))")
    }
}

// MARK: Restroom stop

/// The one tap restroom stop: the best stop with a restroom listed in the next 60 miles and two alternatives,
/// with what is known about its hours and its restroom (never "open" from a 24 hour listing alone).
struct RestroomSheet: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let r = trip.bestStopAhead(miles: 60, restrooms: true), let p = r.primary {
                    if let notice = r.notice {
                        Section { Text(notice).font(.subheadline).foregroundStyle(Theme.amber) }
                    }
                    Section { row(p, best: true) } header: { Text("Best restroom stop ahead") }
                    if !r.alternatives.isEmpty {
                        Section("Alternatives") { ForEach(Array(r.alternatives.prefix(2).enumerated()), id: \.offset) { _, x in row(x, best: false) } }
                    }
                } else {
                    Section {
                        ContentUnavailableView("No stop with a listed restroom in the next 60 miles", systemImage: "figure.dress.line.vertical.figure",
                                               description: Text("Stops without a listing may still have one; Road Ahead shows the exits and rest areas coming up."))
                    }
                }
                Section {
                    Text("Restrooms: rest areas and service plazas list theirs; at stations, a restroom listed by the brand has unknown hours. A station listed open 24 hours can still lock its restroom overnight.")
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                }
            }
            .navigationTitle("Restroom stop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("restroomSheet")
    }

    private func row(_ p: SmartStop.Pick, best: Bool) -> some View {
        let c = p.candidate
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                SmartStopSign(candidate: c)
                VStack(alignment: .leading, spacing: 3) {
                    Text(c.name).font(.headline).lineLimit(2)
                    Text(SmartStopText.whereLine(c) + " · " + SmartStopText.arrival(c, now: trip.snapshot?.timestamp ?? Date()))
                        .font(.caption).foregroundStyle(Theme.secondaryText)
                    ConfidenceLine(status: p.evaluation.hours.status.rawValue, label: p.evaluation.hours.label)
                    ConfidenceLine(status: p.evaluation.restroom.rawValue, label: p.evaluation.restroom.label)
                }
            }
            if let coordinate = coordinate(c) {
                HStack(spacing: 8) {
                    Button("Apple Maps") {
                        let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate.clCoordinate))
                        item.name = c.name
                        item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
                    }
                    .buttonStyle(.bordered)
                    Button("Waze") { WazeHandoff.open(to: coordinate) }.buttonStyle(.bordered)
                }
                .font(.subheadline.weight(.semibold))
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier(best ? "restroomBest" : "restroomAlternative")
    }

    private func coordinate(_ c: SmartStop.Candidate) -> GeoCoordinate? {
        if let id = c.exitID, let exit = trip.plan?.exits.first(where: { $0.id == id }) { return exit.coordinate }
        return trip.plan?.restAreas.first { $0.id == c.id }?.coordinate
    }
}
