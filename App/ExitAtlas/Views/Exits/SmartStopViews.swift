import ExitAtlasCore
import SwiftUI

// SmartStop on iOS: the recommended stop, up to two alternatives, and what is known at arrival. The same
// engine and labels as the website (ExitAtlasCore/Planning/SmartStop.swift). Confidence is a status
// label with a colored dot, never a score.

/// One status line: green when verified or confirmed, amber when reported, gray when unknown, red when
/// closed or missing.
struct ConfidenceLine: View {
    let status: String
    let label: String

    var color: Color {
        switch status {
        case "verified", "accessible", "listed": return Theme.success
        case "reported", "available": return Theme.amber
        case "closed", "none": return Theme.danger
        default: return Theme.secondaryText
        }
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(status == "unknown" ? Theme.secondaryText : .primary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The sign for a pick: the exit tab, or the blue plaza or rest area sign.
struct SmartStopSign: View {
    let candidate: SmartStop.Candidate

    var body: some View {
        if let label = candidate.exitLabel {
            ExitSign(label: label, compact: true)
        } else {
            RestAreaSign(kind: candidate.kind == .rest ? .rest : .plaza, compact: true)
        }
    }
}

enum SmartStopText {
    static func whereLine(_ c: SmartStop.Candidate) -> String {
        (c.exitLabel == nil ? "On the highway · " : "") + "\(Format.milesValue(c.ahead ?? 0)) mi ahead"
    }

    static func arrival(_ c: SmartStop.Candidate, now: Date) -> String {
        var parts = ["Arrive \(Format.time(c.arrival, timeZoneID: c.timeZone.identifier, relativeTo: now))"]
        if let left = c.rangeOnArrival { parts.append("about \(Format.miles(left)) left") }
        return parts.joined(separator: " · ")
    }

    /// "12:00 AM" from "00:00".
    static func clock(_ hhmm: String) -> String {
        let h = Int(hhmm.prefix(2)) ?? 0, m = Int(hhmm.suffix(2)) ?? 0
        return "\(h % 12 == 0 ? 12 : h % 12):\(String(format: "%02d", m)) \(h < 12 ? "AM" : "PM")"
    }

    static func sentence(_ s: String) -> String { s.prefix(1).uppercased() + s.dropFirst() }

    /// What is known about getting off the highway and back: rest areas and plazas are on it; an exit's round
    /// trip is twice the drive from the ramp (an estimate) when it was measured.
    static func detour(_ c: SmartStop.Candidate) -> String {
        guard c.exitID != nil else { return "On the highway, no exit needed" }
        guard let m = c.detourMinutes else { return "Detour not estimated" }
        return m < 1 ? "Estimated detour: under 1 min" : "Estimated detour: about \(Int(m.rounded())) min round trip"
    }
}

/// Hours, and the restroom when it is known or overnight.
struct SmartStopConfidence: View {
    let pick: SmartStop.Pick
    let overnight: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ConfidenceLine(status: pick.evaluation.hours.status.rawValue, label: pick.evaluation.hours.label)
            if pick.evaluation.restroom != .unknown || overnight {
                ConfidenceLine(status: pick.evaluation.restroom.rawValue, label: pick.evaluation.restroom.label)
            }
        }
    }
}

/// The SmartStop sections of the fuel screen.
struct SmartStopSections: View {
    @Environment(TripController.self) private var trip
    @Environment(UserSettings.self) private var settings
    let result: SmartStop.Result

    var body: some View {
        if let p = result.primary {
            Section {
                if let notice = result.notice {
                    Label(notice, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(Theme.amber)
                }
                HStack(alignment: .top, spacing: 12) {
                    SmartStopSign(candidate: p.candidate)
                    VStack(alignment: .leading, spacing: 3) {
                        Text((p.brandRank != nil ? "★ " : "") + p.candidate.name).font(.headline)
                        Text(SmartStopText.whereLine(p.candidate) + " · " + SmartStopText.arrival(p.candidate, now: trip.snapshot?.timestamp ?? Date()))
                            .font(.caption).foregroundStyle(Theme.secondaryText)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    // A neutral dot, not a checkmark: a reason can be "Hours unavailable" or "Detour not measured".
                    ForEach(p.reasons, id: \.self) { reason in
                        Label { Text(reason) } icon: { Image(systemName: "circle.fill").font(.system(size: 5)) }
                            .font(.footnote).labelStyle(ReasonLabelStyle())
                    }
                    if let next = p.nextOption {
                        Label("Next option \(Format.miles(next)) later", systemImage: "arrow.forward").font(.footnote).labelStyle(ReasonLabelStyle())
                    }
                }
                .accessibilityIdentifier("smartStopReasons")
                DisclosureGroup("What is known at arrival") {
                    ForEach(p.evaluation.facilities, id: \.name) { FacilityRow(facility: $0) }
                }
                .font(.subheadline)
                Button("Not this one", role: .destructive) { trip.skipStop(p.candidate.id) }
                if let fav = result.favorite {
                    Text(favoriteNote(fav)).font(.footnote).foregroundStyle(Theme.secondaryText)
                }
            } header: {
                Text(result.lowRange ? "Nearest stop, fuel below your reserve" : "Recommended stop")
            }
            if !result.alternatives.isEmpty {
                Section("Alternatives") {
                    ForEach(result.alternatives, id: \.candidate.id) { alt in
                        HStack(alignment: .top, spacing: 12) {
                            SmartStopSign(candidate: alt.candidate)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(alt.candidate.name).font(.subheadline.weight(.semibold))
                                Text(SmartStopText.whereLine(alt.candidate) + " · " + SmartStopText.arrival(alt.candidate, now: trip.snapshot?.timestamp ?? Date()))
                                    .font(.caption).foregroundStyle(Theme.secondaryText)
                                SmartStopConfidence(pick: alt, overnight: result.overnight)
                                Text(alt.reasons.filter { !$0.hasPrefix(alt.evaluation.hours.label) && $0 != alt.evaluation.restroom.label }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(Theme.secondaryText)
                            }
                        }
                        .swipeActions { Button("Skip", role: .destructive) { trip.skipStop(alt.candidate.id) } }
                    }
                }
            }
        }
        Section {
            OvernightModeRow()
        } footer: {
            VStack(alignment: .leading, spacing: 6) {
                if !result.passed.isEmpty { Text(passedNote) }
                if !trip.rejectedStops.isEmpty {
                    Button("Offer skipped stops again") { trip.offerSkippedStopsAgain() }.font(.footnote)
                }
                Text("Hours: Google Maps business hours where prices were loaded (live), else OpenStreetMap (mapped by volunteers; the check date shows when). A station listed open 24 hours can still lock its restroom overnight, so restrooms show as open at arrival only at rest areas and service plazas with listed hours.")
            }
        }
    }
}

extension SmartStopSections {
    /// "Shell, Exit 42: Reported closed at arrival."
    func favoriteNote(_ fav: SmartStop.FavoriteNote) -> String {
        var name = fav.name
        if let id = fav.exitID, let exit = trip.plan?.exits.first(where: { $0.id == id }) { name += ", \(exit.displayTitle)" }
        return "\(name): \(SmartStopText.sentence(fav.reason))."
    }

    /// "Passed over: 2 below your reserve, 1 reported closed at arrival."
    var passedNote: String {
        let parts: [String] = result.passed.sorted { $0.key < $1.key }.map { entry in
            let reason = entry.key.prefix(1).lowercased() + String(entry.key.dropFirst())
            return "\(entry.value) \(reason)"
        }
        return "Passed over: " + parts.joined(separator: ", ") + "."
    }
}

private struct ReasonLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.font(.caption2.weight(.bold)).foregroundStyle(Theme.secondaryText)
            configuration.title
        }
    }
}

/// One facility: pumps, store, restroom, restroom hours, plaza hours, parking, with its source.
private struct FacilityRow: View {
    let facility: SmartStop.Facility

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(facility.name).font(.subheadline.weight(.semibold)).frame(width: 118, alignment: .leading)
                ConfidenceLine(status: facility.status, label: facility.label)
            }
            Text(sourceLine).font(.caption).foregroundStyle(Theme.secondaryText).padding(.leading, 126)
        }
        .accessibilityElement(children: .combine)
    }

    private var sourceLine: String {
        var parts = [facility.source ?? "No source lists it"]
        if let checked = facility.checked { parts.append("checked \(checked)") }
        if let c = facility.closesIn, c <= 120 { parts.append("closes \(c) min after arrival") }
        return parts.joined(separator: ", ")
    }
}

/// Overnight Drive Mode: automatic in the window by each stop's local arrival time, or on or off.
struct OvernightModeRow: View {
    @Environment(UserSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        VStack(alignment: .leading, spacing: 6) {
            Picker("Overnight Drive Mode", selection: $settings.overnightMode) {
                Text("Auto").tag("auto")
                Text("On").tag("on")
                Text("Off").tag("off")
            }
            .pickerStyle(.segmented)
            Text(settings.overnightMode == "auto"
                 ? "Overnight Drive Mode: \(SmartStopText.clock(settings.overnightStart)) to \(SmartStopText.clock(settings.overnightEnd)), by each stop's local arrival time."
                 : settings.overnightMode == "on" ? "Overnight Drive Mode is on: open hours and restrooms rank first." : "Overnight Drive Mode is off.")
                .font(.caption).foregroundStyle(Theme.secondaryText)
        }
    }
}
