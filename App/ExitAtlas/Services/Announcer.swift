import AVFoundation
import ExitAtlasCore
import Foundation

/// Speaks state line and exit announcements. Music is ducked only while speaking.
@MainActor
final class Announcer: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    /// What to say lives in the engine (shared with the web version and tested there).
    private var announcements = VoiceAnnouncements()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func reset() {
        announcements.reset()
    }

    /// Compares the new snapshot with what was already said and speaks at most one message.
    func consider(_ s: TripSnapshot, settings: UserSettings) {
        let voice = VoiceAnnouncements.Settings(enabled: settings.voiceEnabled,
                                                stateLines: settings.announceStateLines,
                                                exits: settings.announceExits)
        if let text = announcements.message(for: s, settings: voice) { speak(text) }
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
