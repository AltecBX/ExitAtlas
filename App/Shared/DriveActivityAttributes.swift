import ActivityKit
import ExitAtlasCore
import Foundation

/// The Live Activity for a drive. The content (next exit, state line, rest area, arrival) comes from
/// the engine's `DriveActivityContent`; the static part names the trip.
struct DriveActivityAttributes: ActivityAttributes {
    typealias ContentState = DriveActivityContent

    /// "Manhattan, NY", or the interstate in discovery mode ("I-95 North").
    var title: String
    var discovery: Bool
}
