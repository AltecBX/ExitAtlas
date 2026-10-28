import ActivityKit
import ExitAtlasCore
import Foundation

/// Starts, updates and ends the drive's Live Activity (Lock Screen, Dynamic Island, CarPlay Dashboard,
/// Apple Watch). ActivityKit only starts one while the app is in front, so the trip start (a tap)
/// starts it; updates come from location callbacks while the app runs in the background. The system
/// ends a Live Activity after 8 hours, so it is restarted the next time the app is in front after 7.5.
@MainActor
final class LiveActivityController {
    private var activity: Activity<DriveActivityAttributes>?
    private var lastContent: DriveActivityContent?
    private var lastUpdate: Date?
    private var startedAt: Date?
    private var attributes: DriveActivityAttributes?
    private let throttle = DriveActivityThrottle()
    /// Why the last start failed (Live Activities off in Settings, or the app was not in front).
    private(set) var lastError: String?

    static let restartAge: TimeInterval = 7.5 * 3600
    /// The Lock Screen shows the data as stale when no update arrives for this long.
    static let staleAfter: TimeInterval = 5 * 60

    var isEnabledInSettings: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
    var isRunning: Bool { activity != nil }

    func start(title: String, discovery: Bool, content: DriveActivityContent) {
        end(immediately: true)
        guard isEnabledInSettings else {
            lastError = "Live Activities are off for ExitAtlas in the iPhone Settings app."
            return
        }
        let attributes = DriveActivityAttributes(title: title, discovery: discovery)
        do {
            activity = try Activity.request(attributes: attributes,
                                            content: ActivityContent(state: content, staleDate: Date().addingTimeInterval(Self.staleAfter)),
                                            pushType: nil)
            self.attributes = attributes
            lastContent = content
            lastUpdate = Date()
            startedAt = Date()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    /// Sends new content when the throttle allows (wall clock time, so a fast simulation does not flood it).
    func update(_ content: DriveActivityContent) {
        guard let activity else { return }
        let now = Date()
        guard throttle.shouldUpdate(from: lastContent, to: content, lastUpdate: lastUpdate, now: now) else { return }
        lastContent = content
        lastUpdate = now
        let state = ActivityContent(state: content, staleDate: now.addingTimeInterval(Self.staleAfter))
        Task { await activity.update(state) }
    }

    /// Restarts an activity close to the 8 hour limit. Call when the app comes to the front.
    func restartIfOld() {
        guard let startedAt, let attributes, let content = lastContent,
              Date().timeIntervalSince(startedAt) > Self.restartAge else { return }
        start(title: attributes.title, discovery: attributes.discovery, content: content)
    }

    /// Ends the activity; the last state stays on the Lock Screen for 15 minutes unless `immediately`.
    func end(immediately: Bool = false) {
        guard let activity else { return }
        let final = lastContent.map { ActivityContent(state: $0, staleDate: nil) }
        self.activity = nil
        lastContent = nil
        lastUpdate = nil
        startedAt = nil
        attributes = nil
        Task { await activity.end(final, dismissalPolicy: immediately ? .immediate : .after(Date().addingTimeInterval(15 * 60))) }
    }
}
