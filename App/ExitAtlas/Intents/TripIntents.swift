import AppIntents
import ExitAtlasCore
import Foundation

// Siri, Shortcuts, Spotlight and the Action button: "How far to Georgia in ExitAtlas". Each phrase
// must name the app. The answers are spoken in full, because in CarPlay and on a locked phone they are
// only heard. They run in the app's process; when no trip is running they say so.

@MainActor
enum TripIntentAnswers {
    static var trip: TripController? { AppModel.shared?.trip }

    static func answer(_ make: (TripSnapshot, TripController) -> String) -> String {
        guard let trip, trip.mode != .idle, let snapshot = trip.snapshot else { return TripAnswers.noTrip }
        return make(snapshot, trip)
    }
}

struct NextStateLineIntent: AppIntent {
    static let title: LocalizedStringResource = "Next state line"
    static let description = IntentDescription("How far to the next state line, and how many exits remain before it.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = TripIntentAnswers.answer { s, _ in TripAnswers.nextStateLine(snapshot: s) }
        return .result(dialog: "\(text)")
    }
}

struct DistanceToStateIntent: AppIntent {
    static let title: LocalizedStringResource = "Distance to a state"
    static let description = IntentDescription("How far until a state on your route, and when you cross into it.")

    @Parameter(title: "State")
    var state: USStateOption

    static var parameterSummary: some ParameterSummary {
        Summary("How far to \(\.$state)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let name = USStateOption.names[state] ?? state.rawValue
        let text = TripIntentAnswers.answer { s, _ in TripAnswers.distanceToState(name, snapshot: s) }
        return .result(dialog: "\(text)")
    }
}

struct NextExitIntent: AppIntent {
    static let title: LocalizedStringResource = "Next exit"
    static let description = IntentDescription("The next exit on your route and its services.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = TripIntentAnswers.answer { s, trip in
            TripAnswers.nextExit(snapshot: s, services: s.nextExit.map { trip.services(for: $0.exit) } ?? [])
        }
        return .result(dialog: "\(text)")
    }
}

struct NextRestAreaIntent: AppIntent {
    static let title: LocalizedStringResource = "Next rest area"
    static let description = IntentDescription("The next rest area, welcome center or service plaza on your side of the highway.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = TripIntentAnswers.answer { s, _ in TripAnswers.nextRestArea(snapshot: s) }
        return .result(dialog: "\(text)")
    }
}

struct NextGasIntent: AppIntent {
    static let title: LocalizedStringResource = "Next gas"
    static let description = IntentDescription("The next exit or service plaza with gas, and any long stretch without gas after it.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = TripIntentAnswers.answer { s, trip in TripAnswers.nextGas(snapshot: s, stops: trip.gasStops()) }
        return .result(dialog: "\(text)")
    }
}

struct ArrivalIntent: AppIntent {
    static let title: LocalizedStringResource = "Arrival time"
    static let description = IntentDescription("When you arrive, at your current pace.")

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let text = TripIntentAnswers.answer { s, trip in
            guard trip.mode == .trip, let plan = trip.plan else { return "Discovery mode has no destination, so there is no arrival time." }
            return TripAnswers.arrival(snapshot: s, destination: plan.route.destination.name,
                                       timeZoneID: plan.timeZoneID(at: plan.route.length))
        }
        return .result(dialog: "\(text)")
    }
}

struct ExitAtlasShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: NextStateLineIntent(),
                    phrases: ["How far to the next state line in \(.applicationName)", "Next state line in \(.applicationName)"],
                    shortTitle: "Next state line", systemImageName: "flag.checkered")
        AppShortcut(intent: DistanceToStateIntent(),
                    phrases: ["How far to \(\.$state) in \(.applicationName)", "How far until \(\.$state) in \(.applicationName)",
                              "Distance to a state in \(.applicationName)"],
                    shortTitle: "Distance to a state", systemImageName: "map")
        AppShortcut(intent: NextExitIntent(),
                    phrases: ["Next exit in \(.applicationName)", "What is the next exit in \(.applicationName)"],
                    shortTitle: "Next exit", systemImageName: "arrow.up.right.square")
        AppShortcut(intent: NextRestAreaIntent(),
                    phrases: ["Next rest area in \(.applicationName)", "Where is the next rest area in \(.applicationName)"],
                    shortTitle: "Next rest area", systemImageName: "toilet")
        AppShortcut(intent: NextGasIntent(),
                    phrases: ["Next gas in \(.applicationName)", "Where is the next gas in \(.applicationName)"],
                    shortTitle: "Next gas", systemImageName: "fuelpump")
        AppShortcut(intent: ArrivalIntent(),
                    phrases: ["When do I arrive in \(.applicationName)", "Arrival time in \(.applicationName)"],
                    shortTitle: "Arrival time", systemImageName: "clock")
    }
}
