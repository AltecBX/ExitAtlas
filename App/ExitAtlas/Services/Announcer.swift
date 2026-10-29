import AVFoundation
import ExitAtlasCore
import Foundation

/// Speaks state line and exit announcements. Music is ducked only while speaking.
@MainActor
final class Announcer: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    /// What to say lives in the engine (shared with the web version and tested there).
    private var announcements = VoiceAnnouncements()
    /// While another app or mode speaks (the experimental Google navigation), nothing is said; what would have
    /// been said is skipped, not queued.
    var suspended = false

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func reset() {
        announcements.reset()
    }

    /// Compares the new snapshot with what was already said and speaks at most one message.
    /// zoneID: the time zone at the driver. gasGap: the next stretch without gas, when one starts ahead.
    /// lastOpen: overnight, the last stop listed open before a long stretch. alerts: road alerts ahead.
    func consider(_ s: TripSnapshot, settings: UserSettings, zoneID: String?, gasGap: GasGaps.Gap?, lastOpen: SmartStop.LastOpen? = nil,
                  alerts: [RoadIntel.Alert] = []) {
        let voice = VoiceAnnouncements.Settings(enabled: settings.voiceEnabled,
                                                stateLines: settings.announceStateLines,
                                                exits: settings.announceExits,
                                                restAreas: settings.announceRestAreas,
                                                gasGaps: settings.announceGasGaps,
                                                timeZones: settings.announceTimeZones,
                                                alerts: settings.announceAlerts)
        if let text = announcements.message(for: s, settings: voice, zoneID: zoneID, gasGap: gasGap, lastOpen: lastOpen, alerts: alerts) {
            speak(text)
        }
    }

    func speak(_ text: String) {
        guard !suspended else { return }
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
