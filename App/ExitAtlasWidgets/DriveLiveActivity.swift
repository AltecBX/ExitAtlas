import ActivityKit
import ExitAtlasCore
import SwiftUI
import WidgetKit

@main
struct ExitAtlasWidgetsBundle: WidgetBundle {
    var body: some Widget {
        DriveLiveActivity()
    }
}

/// Lock Screen, Dynamic Island, CarPlay Dashboard and Apple Watch Smart Stack. A Live Activity cannot
/// read location or the network; the app sends each update.
struct DriveLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DriveActivityAttributes.self) { context in
            LockScreenOrSmall(content: context.state, title: context.attributes.title, isStale: context.isStale)
                .activityBackgroundTint(Tokens.card)
        } dynamicIsland: { context in
            let c = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActivityExitTab(label: c.exitLabel, size: 17).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(ActivityFormat.miles(c.exitMeters))
                        .font(.system(size: 22, weight: .heavy, design: .rounded)).monospacedDigit().padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(c.exitWords?.isEmpty == false ? c.exitWords! : "Next exit").font(.footnote.weight(.semibold)).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            if let next = c.nextStateCode {
                                Label("\(next) line \(ActivityFormat.miles(c.stateLineMeters))", systemImage: "flag.checkered")
                            }
                            Spacer()
                            if let eta = c.eta { Text("Arrive \(eta, style: .time)") }
                        }
                        if let warning = c.gasWarning {
                            Label(warning, systemImage: "fuelpump.slash.fill").foregroundStyle(Tokens.amber)
                        } else if let rest = c.restTitle {
                            Label("\(rest), \(ActivityFormat.miles(c.restMeters))", systemImage: "toilet.fill").foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                ActivityExitTab(label: c.exitLabel, size: 12)
            } compactTrailing: {
                Text(ActivityFormat.miles(c.exitMeters)).font(.caption.weight(.bold)).monospacedDigit()
            } minimal: {
                Text(ActivityFormat.value(c.exitMeters)).font(.caption2.weight(.heavy)).monospacedDigit()
            }
        }
        .supplementalActivityFamilies([.small])
    }
}

/// The small family (CarPlay Dashboard, Watch) gets its own layout; everything else the Lock Screen one.
private struct LockScreenOrSmall: View {
    @Environment(\.activityFamily) private var family
    let content: DriveActivityContent
    let title: String
    let isStale: Bool

    var body: some View {
        switch family {
        case .small:
            DriveActivitySmallView(content: content)
        default:
            DriveActivityLockScreenView(content: content, title: title, isStale: isStale)
        }
    }
}
