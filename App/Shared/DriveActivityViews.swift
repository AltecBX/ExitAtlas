import ExitAtlasCore
import SwiftUI

// Live Activity layouts. Compiled into the widget extension (the real Live Activity) and into the app
// (Settings shows the same views as a preview, which is also how the UI tests capture them).

enum ActivityFormat {
    static func miles(_ meters: Double?) -> String {
        guard let meters else { return "—" }
        let mi = max(0, meters / Geodesy.metersPerMile)
        return mi < 10 ? String(format: "%.1f mi", mi) : String(format: "%.0f mi", mi.rounded())
    }

    static func value(_ meters: Double?) -> String {
        guard let meters else { return "—" }
        let mi = max(0, meters / Geodesy.metersPerMile)
        return mi < 10 ? String(format: "%.1f", mi) : String(format: "%.0f", mi.rounded())
    }
}

/// Green exit tab, as on a guide sign, in the system font (the extension does not bundle Overpass).
struct ActivityExitTab: View {
    let label: String?
    var size: CGFloat = 15

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 3) {
            Text("EXIT").font(.system(size: size * 0.62, weight: .bold, design: .rounded))
            Text(label ?? "—").font(.system(size: size, weight: .heavy, design: .rounded)).lineLimit(1).minimumScaleFactor(0.6)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, size * 0.45)
        .padding(.vertical, size * 0.22)
        .background(Tokens.signGreen, in: RoundedRectangle(cornerRadius: size * 0.4, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).stroke(.white.opacity(0.9), lineWidth: 1).padding(1.5))
        .accessibilityLabel(label.map { "Exit \($0)" } ?? "No exit")
    }
}

/// Lock Screen and notification banner. Stays under the 160 point height the system allows.
struct DriveActivityLockScreenView: View {
    let content: DriveActivityContent
    let title: String
    var isStale = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 10) {
                ActivityExitTab(label: content.exitLabel, size: 18)
                Text(content.exitWords?.isEmpty == false ? content.exitWords! : "Next exit")
                    .font(.subheadline.weight(.semibold)).lineLimit(2).minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                Text(ActivityFormat.miles(content.exitMeters))
                    .font(.system(size: 26, weight: .heavy, design: .rounded)).monospacedDigit()
            }
            HStack(spacing: 8) {
                if let next = content.nextStateCode ?? content.nextStateName {
                    // The state line and arrival keep their full width; the exit count gives way first.
                    // Plain views rather than a Label: a fixed size Label lost its title inside a List row.
                    HStack(spacing: 5) {
                        Image(systemName: "flag.checkered")
                        Text("\(next) line \(ActivityFormat.miles(content.stateLineMeters))").lineLimit(1).fixedSize()
                    }
                    .layoutPriority(2)
                    if let left = content.exitsLeftInState, let here = content.stateCode {
                        Text("· \(left) \(left == 1 ? "exit" : "exits") left in \(here)").foregroundStyle(.secondary)
                            .lineLimit(1).minimumScaleFactor(0.85)
                    }
                } else if let here = content.stateCode {
                    Label("In \(here), last state", systemImage: "flag.checkered")
                }
                Spacer(minLength: 4)
                if let eta = content.eta {
                    Text("Arrive \(eta, style: .time)").monospacedDigit().lineLimit(1).fixedSize().layoutPriority(2)
                }
            }
            .font(.footnote.weight(.semibold))
            if let warning = content.gasWarning {
                Label(warning, systemImage: "fuelpump.slash.fill").font(.footnote.weight(.bold)).foregroundStyle(Tokens.amber).lineLimit(1)
            } else if let rest = content.restTitle {
                Label("\(rest), \(ActivityFormat.miles(content.restMeters))", systemImage: "toilet.fill")
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            if isStale || content.simulated || content.offRoute {
                HStack(spacing: 6) {
                    if content.simulated { Text("SIMULATED").font(.caption2.weight(.heavy)).foregroundStyle(.purple) }
                    if content.offRoute { Text("Off route").font(.caption2.weight(.bold)).foregroundStyle(Tokens.danger) }
                    if isStale { Text("Updated \(content.updatedAt, style: .relative) ago").font(.caption2).foregroundStyle(.secondary) }
                }
            }
        }
        .padding(14)
        .accessibilityElement(children: .combine)
    }
}

/// The small family: CarPlay Dashboard and the Apple Watch Smart Stack. Large type, no buttons.
struct DriveActivitySmallView: View {
    let content: DriveActivityContent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                ActivityExitTab(label: content.exitLabel, size: 14)
                Spacer(minLength: 2)
                Text(ActivityFormat.miles(content.exitMeters))
                    .font(.system(size: 20, weight: .heavy, design: .rounded)).monospacedDigit()
            }
            if let warning = content.gasWarning {
                Text(warning).font(.caption.weight(.bold)).foregroundStyle(Tokens.amber).lineLimit(1).minimumScaleFactor(0.8)
            } else if let next = content.nextStateCode {
                Text("\(next) line \(ActivityFormat.miles(content.stateLineMeters))").font(.caption.weight(.semibold)).lineLimit(1)
            } else if let rest = content.restTitle {
                Text("Rest \(ActivityFormat.miles(content.restMeters)): \(rest)").font(.caption).lineLimit(1)
            }
        }
        .padding(10)
        .accessibilityElement(children: .combine)
    }
}
