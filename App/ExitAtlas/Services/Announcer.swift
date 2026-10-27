import AVFoundation
import ExitAtlasCore
import Foundation

/// Spoken announcements for state lines and exits. Music is ducked only while speaking.
@MainActor
final class Announcer: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var announcedExitIDs = Set<String>()
    private var announcedBorderWarnings = Set<Int>()
    private var lastSegmentIndex: Int?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func reset() {
        announcedExitIDs.removeAll()
        announcedBorderWarnings.removeAll()
        lastSegmentIndex = nil
    }

    /// Compares the new snapshot with what was already said and speaks at most one message.
    func consider(_ s: TripSnapshot, settings: UserSettings) {
        guard settings.voiceEnabled, s.match.status == .onRoute else {
            lastSegmentIndex = s.current?.segment.index
            return
        }
        if settings.announceStateLines, let current = s.current {
            if let last = lastSegmentIndex, current.segment.index > last {
                lastSegmentIndex = current.segment.index
                var text = "Welcome to \(current.segment.displayName)."
                if s.next != nil {
                    text += " \(Format.spokenMiles(current.remainingMeters)) of your route are in \(current.segment.displayName)."
                }
                speak(text)
                return
            }
            lastSegmentIndex = current.segment.index
            if let next = s.next, let toBorder = s.distanceToNextBorder,
               toBorder <= 5 * Geodesy.metersPerMile, toBorder > 0.5 * Geodesy.metersPerMile,
               !announcedBorderWarnings.contains(next.segment.index) {
                announcedBorderWarnings.insert(next.segment.index)
                let exits = current.exitsRemaining
                speak("\(next.segment.displayName) state line in \(Format.spokenMiles(toBorder)). "
                    + "\(exits) \(exits == 1 ? "exit remains" : "exits remain") in \(current.segment.displayName).")
                return
            }
        }
        if settings.announceExits, let next = s.nextExit, next.distance <= 1.0 * Geodesy.metersPerMile,
           !announcedExitIDs.contains(next.exit.id) {
            announcedExitIDs.insert(next.exit.id)
            var text = "\(next.exit.displayTitle) in \(Format.spokenMiles(next.distance))"
            if !next.exit.name.isEmpty { text += ", \(next.exit.name)" }
            speak(text + ".")
        }
    }

    func speak(_ text: String) {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers])
        try? session.setActive(true)
        synthesizer.speak(AVSpeechUtterance(string: text))
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if !self.synthesizer.isSpeaking {
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            }
        }
    }
}
