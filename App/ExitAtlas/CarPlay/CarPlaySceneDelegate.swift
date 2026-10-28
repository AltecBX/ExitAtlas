import CarPlay
import ExitAtlasCore
import UIKit

/// CarPlay driving task app: NOT ENABLED. iOS creates this scene only when the app ID carries Apple's
/// CarPlay driving task entitlement (com.apple.developer.carplay-driving-task), which has to be
/// requested from Apple with the developer account, and when the Info.plist declares the CarPlay scene
/// (see docs/10_lock_screen_and_carplay.md). Until then the Live Activity already appears on the
/// CarPlay Dashboard without any entitlement.
///
/// The driving task category allows information, list, grid and point of interest templates, with
/// limited refreshes. This shows the same facts as the Live Activity, refreshed every 10 seconds.
@MainActor
final class CarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var template: CPInformationTemplate?
    private var timer: Timer?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        let template = CPInformationTemplate(title: "ExitAtlas", layout: .leading, items: Self.items(), actions: [])
        self.template = template
        interfaceController.setRootTemplate(template, animated: false, completion: nil)
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.template?.items = Self.items() }
        }
    }

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene,
                                  didDisconnectInterfaceController interfaceController: CPInterfaceController) {
        timer?.invalidate()
        timer = nil
        template = nil
        self.interfaceController = nil
    }

    /// Next exit, state line, rest area and arrival, from the running trip.
    @MainActor
    static func items() -> [CPInformationItem] {
        guard let trip = AppModel.shared?.trip, trip.mode != .idle, let s = trip.snapshot else {
            return [CPInformationItem(title: "No trip", detail: "Start a trip or discovery mode on iPhone before you drive.")]
        }
        let c = trip.activityContent(for: s)
        var items: [CPInformationItem] = []
        if let label = c.exitLabel {
            items.append(CPInformationItem(title: "Exit \(label) in \(ActivityFormat.miles(c.exitMeters))", detail: c.exitWords ?? ""))
        }
        if let next = c.nextStateName {
            items.append(CPInformationItem(title: "\(next) line in \(ActivityFormat.miles(c.stateLineMeters))",
                                           detail: c.exitsLeftInState.map { "\($0) exits left in \(c.stateCode ?? "this state")" } ?? ""))
        }
        if let warning = c.gasWarning {
            items.append(CPInformationItem(title: warning, detail: nil))
        } else if let rest = c.restTitle {
            items.append(CPInformationItem(title: "\(rest) in \(ActivityFormat.miles(c.restMeters))", detail: nil))
        }
        if let eta = c.eta {
            items.append(CPInformationItem(title: "Arrive \(Format.time(eta, relativeTo: s.timestamp))", detail: nil))
        }
        return items
    }
}
