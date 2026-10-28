import ExitAtlasCore
import SwiftUI
import UIKit

/// Visual language: interstate sign colors on a calm automotive dashboard, light and dark.
enum Theme {
    static let signGreen = Color(light: 0x0B6B3A, dark: 0x13824A)
    static let shieldBlue = Color(light: 0x1D3E8C, dark: 0x2E56B8)
    static let shieldRed = Color(light: 0xC8102E, dark: 0xE0293F)
    static let amber = Color(light: 0xD98E04, dark: 0xF2A900)
    static let background = Color(light: 0xF2F3F5, dark: 0x0A0C0F)
    static let card = Color(light: 0xFFFFFF, dark: 0x161A20)
    static let cardStroke = Color(light: 0xE3E6EA, dark: 0x262B33)
    static let secondaryText = Color(light: 0x5B636E, dark: 0x9AA3AE)

    /// Alternating route colors so state segments are visible on the map.
    static let segmentColors: [Color] = [
        Color(light: 0x1D6FE0, dark: 0x4C93FF), Color(light: 0x0E9F6E, dark: 0x2FC48D),
        Color(light: 0x8E44AD, dark: 0xB57BDB), Color(light: 0xD35400, dark: 0xF07F2B),
    ]

    static func number(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded).monospacedDigit()
    }

    static let label = Font.system(.caption, design: .rounded).weight(.semibold)
}

extension Color {
    init(light: UInt32, dark: UInt32) {
        self.init(uiColor: UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                           blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        })
    }
}

struct CardStyle: ViewModifier {
    var padding: CGFloat = 16

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(Theme.cardStroke, lineWidth: 1))
    }
}

extension View {
    func card(padding: CGFloat = 16) -> some View { modifier(CardStyle(padding: padding)) }
}

/// Small uppercase caption used above metrics.
struct Eyebrow: View {
    let text: String
    var color: Color = Theme.secondaryText

    var body: some View {
        Text(text.uppercased())
            .font(Theme.label)
            .tracking(0.8)
            .foregroundStyle(color)
    }
}
