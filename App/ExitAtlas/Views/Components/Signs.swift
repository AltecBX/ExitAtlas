import ExitAtlasCore
import SwiftUI

/// Interstate style shield. Other routes get a neutral rounded badge.
struct HighwayShield: View {
    let ref: HighwayRef?
    var size: CGFloat = 44

    var body: some View {
        if let ref, ref.kind == .interstate {
            ZStack(alignment: .top) {
                ShieldShape().fill(Theme.shieldBlue)
                ShieldShape().fill(Theme.shieldRed)
                    .mask(alignment: .top) { Rectangle().frame(height: size * 0.28) }
                ShieldShape().stroke(.white, lineWidth: size * 0.05).padding(size * 0.04)
                Text(ref.number)
                    .font(.system(size: size * (ref.number.count > 2 ? 0.34 : 0.42), weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.5)
                    .padding(.top, size * 0.34)
                    .padding(.horizontal, size * 0.1)
            }
            .frame(width: size, height: size)
            .accessibilityLabel("Interstate \(ref.number)")
        } else {
            Text(ref?.description ?? "—")
                .font(.system(size: size * 0.3, weight: .heavy, design: .rounded))
                .foregroundStyle(.primary)
                .padding(.horizontal, size * 0.18)
                .frame(minWidth: size, minHeight: size * 0.7)
                .background(RoundedRectangle(cornerRadius: size * 0.16).stroke(.primary, lineWidth: 2))
        }
    }
}

/// Approximation of the interstate shield outline.
struct ShieldShape: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        let w = r.width, h = r.height
        p.move(to: CGPoint(x: r.minX + w * 0.08, y: r.minY + h * 0.06))
        p.addQuadCurve(to: CGPoint(x: r.midX, y: r.minY + h * 0.08), control: CGPoint(x: r.minX + w * 0.3, y: r.minY + h * 0.14))
        p.addQuadCurve(to: CGPoint(x: r.maxX - w * 0.08, y: r.minY + h * 0.06), control: CGPoint(x: r.maxX - w * 0.3, y: r.minY + h * 0.14))
        p.addCurve(to: CGPoint(x: r.midX, y: r.maxY), control1: CGPoint(x: r.maxX + w * 0.04, y: r.minY + h * 0.55),
                   control2: CGPoint(x: r.maxX - w * 0.2, y: r.maxY - h * 0.1))
        p.addCurve(to: CGPoint(x: r.minX + w * 0.08, y: r.minY + h * 0.06), control1: CGPoint(x: r.minX + w * 0.2, y: r.maxY - h * 0.1),
                   control2: CGPoint(x: r.minX - w * 0.04, y: r.minY + h * 0.55))
        p.closeSubpath()
        return p
    }
}

/// Exit number tab, as on a guide sign: "EXIT 119" in sign lettering on green with a white border.
struct ExitSign: View {
    let label: String
    var compact = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: compact ? 4 : 5) {
            Text("EXIT").font(SignFont.font(compact ? 12 : 13, relativeTo: .caption))
            Text(label.isEmpty ? "—" : label)
                .font(SignFont.font(compact ? 18 : 22, weight: .heavy, relativeTo: .title3))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, compact ? 7 : 9)
        .padding(.top, compact ? 5 : 6)
        .padding(.bottom, compact ? 3 : 4)
        .frame(minWidth: compact ? 64 : nil)
        .background(Theme.signGreen, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(.white.opacity(0.95), lineWidth: 1.5).padding(2))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label.isEmpty ? "Unnumbered exit" : "Exit \(label)")
    }
}

/// Two letter state badge.
struct StateBadge: View {
    let code: String?
    var highlighted = false
    var compact = false

    var body: some View {
        Text(code ?? "—")
            .font(.system(size: compact ? 12 : 13, weight: .heavy, design: .rounded))
            .foregroundStyle(highlighted ? .white : .primary)
            .frame(width: compact ? 26 : 36, height: compact ? 18 : 26)
            .background(highlighted ? AnyShapeStyle(Theme.signGreen) : AnyShapeStyle(Theme.cardStroke),
                        in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .accessibilityLabel(code.map { "State \($0)" } ?? "No state")
    }
}
