import ExitAtlasCore
import SwiftUI
import UIKit

/// Visual language: interstate sign colors on a calm automotive dashboard, light and dark.
enum Theme {
    // Colors come from design/tokens.json through the generated Tokens.swift (shared with the web).
    static let signGreen = Tokens.signGreen
    /// Tabs, switches and tinted buttons: sign green in light mode, a brighter green that reads on dark cards.
    static let tint = Tokens.tint
    static let signBlue = Tokens.signBlue
    static let signBrown = Tokens.signBrown
    static let shieldBlue = Tokens.shieldBlue
    static let shieldRed = Tokens.shieldRed
    static let amber = Tokens.amber
    static let danger = Tokens.danger
    static let success = Tokens.success
    static let background = Tokens.bg
    static let card = Tokens.card
    static let cardStroke = Tokens.stroke
    static let secondaryText = Tokens.text2
    static let amberFill = Tokens.amberFill
    static let raised = Tokens.raised
    static let navy = Tokens.navy
    static let info = Tokens.info
    static let infoFill = Tokens.infoFill
    static let dangerFill = Tokens.dangerFill
    static let successFill = Tokens.successFill
    static let accent = Tokens.accent
    /// The route on the navigation map: ahead, its outline, and the part already driven.
    static let route = Tokens.route
    static let routeCasing = Tokens.routeCasing
    static let routePassed = Tokens.routePassed

    /// Alternating route colors so state segments are visible on the map.
    static let segmentColors: [Color] = [Tokens.seg0, Tokens.seg1, Tokens.seg2, Tokens.seg3]

    static func number(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .rounded).monospacedDigit()
    }

    static let label = Font.system(.caption, design: .rounded).weight(.semibold)
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

    /// A surface floating over the map: raised, outlined, with a soft shadow (never glossy).
    func floating(cornerRadius: CGFloat = 18) -> some View {
        self
            .background(Theme.raised, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(Theme.cardStroke, lineWidth: 1))
            .shadow(color: .black.opacity(0.28), radius: 14, x: 0, y: 8)
    }
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
