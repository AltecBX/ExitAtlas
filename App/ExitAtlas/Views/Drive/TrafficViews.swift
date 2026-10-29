import ExitAtlasCore
import SwiftUI

/// What the arrival times are based on (docs/16), in words: with traffic (and from which source, how old), or
/// the driver's pace and why traffic is not in them. Never presented as traffic aware when it is not.
enum TrafficText {
    static func usesTraffic(_ s: TripSnapshot) -> Bool { s.arrivalBasis == .traffic || s.arrivalBasis == .trafficThenPace }

    /// The journey panel's label after the arrival time: "+12 min traffic", "with traffic" or "arrival".
    static func arrivalLabel(_ s: TripSnapshot, extra: (seconds: Double, to: String, at: Date)?) -> String {
        guard usesTraffic(s) else { return "arrival" }
        if let extra { return "+\(Int((extra.seconds / 60).rounded())) min traffic" }
        return "with traffic"
    }

    static func detail(_ s: TripSnapshot, state: TripController.TrafficState, extra: (seconds: Double, to: String, at: Date)?) -> String {
        if let r = s.traffic {
            let minutes = max(0, Int(s.timestamp.timeIntervalSince(r.measuredAt) / 60))
            var parts = ["\(r.source.name) estimate, \(minutes < 1 ? "just now" : "\(minutes) min ago")."]
            if let extra { parts.append("Traffic adds about \(Int((extra.seconds / 60).rounded())) min before \(extra.to).") }
            if s.arrivalBasis == .trafficThenPace { parts.append("Beyond the last point Apple timed, your pace.") }
            return parts.joined(separator: " ")
        }
        switch state {
        case .off: return "Traffic in arrival times is off in Settings."
        case .notChecked: return "Apple Maps traffic is not checked during a simulated drive."
        case .checking: return "Checking Apple Maps traffic."
        case .unavailable(let why): return "\(why). Times use your pace until the next check."
        case .ok: return "The last traffic check is too old to use. Times use your pace until the next check."
        }
    }
}

/// The basis of the arrival time, under the Trip tab's summary.
struct TrafficBasisLine: View {
    @Environment(TripController.self) private var trip
    let snapshot: TripSnapshot

    var body: some View {
        let on = TrafficText.usesTraffic(snapshot)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Circle().fill(on ? Theme.success : Theme.secondaryText).frame(width: 7, height: 7)
                Text(snapshot.arrivalBasis.label).font(.caption.weight(.bold))
            }
            .foregroundStyle(on ? Theme.success : Theme.secondaryText)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(Theme.raised, in: Capsule())
            Text(TrafficText.detail(snapshot, state: trip.trafficState, extra: trip.trafficExtra))
                .font(.caption).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("trafficBasis")
    }
}

/// Settings: Apple's traffic layer and Apple's traffic aware times, and plainly what is not available.
struct TrafficSettingsRows: View {
    @Environment(UserSettings.self) private var settings

    var body: some View {
        @Bindable var settings = settings
        Toggle(isOn: $settings.trafficOnMap) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Show traffic on the map")
                Text("Apple Maps traffic colors on the Navigation View").font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .accessibilityIdentifier("trafficOnMapToggle")
        Toggle(isOn: $settings.trafficInETA) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Traffic in arrival times")
                Text("Apple's traffic aware times to your next stop, state line and destination, used only when Apple timed your route")
                    .font(.caption).foregroundStyle(Theme.secondaryText)
            }
        }
        .accessibilityIdentifier("trafficInETAToggle")
        VStack(alignment: .leading, spacing: 6) {
            Text("Source: Apple Maps, no key needed. Checked about every 5 minutes while you drive, never while parked or in the background. When it cannot be checked, times use your pace and say so.")
            Text("Not available yet: where slowdowns are, spoken traffic warnings and faster route offers. Apple does not provide slowdown locations or traffic times for other routes, and no other source is licensed for ExitAtlas (docs/16).")
        }
        .font(.caption).foregroundStyle(Theme.secondaryText)
        .accessibilityIdentifier("trafficSettingsNote")
    }
}
