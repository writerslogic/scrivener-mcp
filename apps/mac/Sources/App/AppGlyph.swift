import SwiftUI

/// The app's mark: a suspension bridge whose deck is a page of text. Also renders the app icon.
struct AppGlyph: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            ZStack {
                RoundedRectangle(cornerRadius: s * 0.225, style: .continuous)
                    .fill(LinearGradient(
                        colors: [Color(red: 0.33, green: 0.29, blue: 0.84), Color(red: 0.13, green: 0.50, blue: 0.96)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                RoundedRectangle(cornerRadius: s * 0.225, style: .continuous)
                    .fill(LinearGradient(colors: [.white.opacity(0.22), .clear], startPoint: .top, endPoint: .center))
                ZStack {
                    BridgeMark(part: .hangers)
                        .stroke(.white.opacity(0.85), style: StrokeStyle(lineWidth: s * 0.026, lineCap: .round))
                    BridgeMark(part: .structure)
                        .stroke(.white, style: StrokeStyle(lineWidth: s * 0.052, lineCap: .round, lineJoin: .round))
                }
                .shadow(color: .black.opacity(0.20), radius: s * 0.025, y: s * 0.015)
                .padding(.horizontal, s * 0.15)
                .padding(.top, s * 0.10)
                .padding(.bottom, s * 0.20)
            }
            .frame(width: s, height: s)
        }
        .accessibilityHidden(true)
    }
}

/// The bridge: a flat arch over a deck, with a page of text lines beneath it. Drawn in a unit square.
struct BridgeMark: Shape {
    enum Part { case structure, hangers }
    let part: Part

    private static let deckY = 0.55
    private static let rise = 0.34
    private static let hangerXs = [0.14, 0.28, 0.42, 0.58, 0.72, 0.86]

    private static func archY(_ x: Double) -> Double {
        let t = (x - 0.5) / 0.5
        return deckY - rise * (1 - t * t)
    }

    func path(in rect: CGRect) -> Path {
        func point(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y)
        }
        var path = Path()
        switch part {
        case .structure:
            path.move(to: point(0, Self.deckY))
            path.addLine(to: point(1, Self.deckY))
            path.move(to: point(0, Self.deckY))
            for step in 1...48 {
                let x = Double(step) / 48
                path.addLine(to: point(x, Self.archY(x)))
            }
            path.move(to: point(0.06, 0.76))
            path.addLine(to: point(0.94, 0.76))
            path.move(to: point(0.06, 0.92))
            path.addLine(to: point(0.62, 0.92))
        case .hangers:
            for x in Self.hangerXs {
                path.move(to: point(x, Self.archY(x)))
                path.addLine(to: point(x, Self.deckY))
            }
        }
        return path
    }
}
