import AppKit
import ScrivenerMCPCore
import SwiftUI

/// A titled group in the style of System Settings: a quiet header over a rounded container.
struct SettingsGroup<Content: View>: View {
    let title: String
    let footnote: String?
    @ViewBuilder var content: Content

    init(_ title: String, footnote: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footnote = footnote
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background.secondary)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.separator.opacity(0.7)))
            if let footnote {
                Text(footnote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A row inside a `SettingsGroup`, with the standard inset and a hairline between siblings.
struct RowDivider: View {
    var body: some View { Divider().padding(.leading, 14) }
}

struct StatusPill: View {
    let state: ConnectionState

    private var content: (text: String, symbol: String, color: Color) {
        switch state {
        case .connected: ("Connected", "checkmark.circle.fill", .green)
        case .needsRepair: ("Needs update", "exclamationmark.circle.fill", .orange)
        case .notConnected: ("Not connected", "circle", .secondary)
        case .manual: ("Set up in app", "arrow.up.forward.app", .secondary)
        case .problem: ("Problem", "xmark.octagon.fill", .red)
        }
    }

    var body: some View {
        let c = content
        Label(c.text, systemImage: c.symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(c.color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(c.color.opacity(0.12), in: Capsule())
            .accessibilityLabel("Status: \(c.text)")
    }
}

struct AppIconView: View {
    let row: AppRow
    var size: CGFloat = 36

    var body: some View {
        Group {
            if let url = row.appURL {
                Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable()
            } else {
                Image(systemName: row.symbol)
                    .font(.system(size: size * 0.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct NoticeBanner: View {
    let notice: Notice
    let model: AppModel

    private var color: Color {
        switch notice.kind {
        case .success: .green
        case .info: .blue
        case .error: .red
        }
    }

    private var symbol: String {
        switch notice.kind {
        case .success: "checkmark.circle.fill"
        case .info: "info.circle.fill"
        case .error: "exclamationmark.triangle.fill"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(color)
            Text(notice.text).font(.callout).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button {
                model.notice = nil
            } label: {
                Image(systemName: "xmark").font(.caption)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(color.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct UpdateBanner: View {
    let update: ReleaseInfo

    var body: some View {
        HStack {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(.blue)
            Text("Version \(update.version.trimmingCharacters(in: CharacterSet(charactersIn: "vV"))) is available.").font(.callout)
            Spacer()
            Link("Download", destination: update.pageURL).font(.callout)
        }
        .padding(12)
        .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// A line of body text with a symbol, used for short reassurances.
struct Reassurance: View {
    let symbol: String
    let tint: Color
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 18)
            Text(text).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
}
