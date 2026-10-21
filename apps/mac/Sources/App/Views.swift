import AppKit
import ScrivenerMCPCore
import SwiftUI

// MARK: - Building blocks

struct Card<Content: View>: View {
    let title: String?
    let subtitle: String?
    @ViewBuilder var content: Content

    init(_ title: String? = nil, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    if let subtitle {
                        Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator))
    }
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

    var body: some View {
        Group {
            if let url = row.appURL {
                Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable()
            } else {
                Image(systemName: row.symbol)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
        .frame(width: 36, height: 36)
        .accessibilityHidden(true)
    }
}

// MARK: - Rows

struct ClientRow: View {
    let row: AppRow
    let model: AppModel

    var body: some View {
        HStack(spacing: 12) {
            AppIconView(row: row)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.name).font(.body.weight(.medium))
                subtitle
            }
            Spacer(minLength: 8)
            if row.busy {
                ProgressView().controlSize(.small)
            } else {
                StatusPill(state: row.state)
                action
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private var subtitle: some View {
        switch row.state {
        case .problem(let message):
            Text(message).font(.caption).foregroundStyle(.red).lineLimit(2)
        case .needsRepair:
            Text("An older setup was found. Repair it to keep working.")
                .font(.caption).foregroundStyle(.secondary)
        case .manual:
            Text("Uses an install dialog inside the app.").font(.caption).foregroundStyle(.secondary)
        default:
            if row.isRunning {
                Text("Running").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var action: some View {
        switch row.state {
        case .notConnected:
            Button("Connect") { Task { await model.connect(row.id) } }
                .buttonStyle(.borderedProminent).controlSize(.small)
        case .needsRepair:
            Button("Repair") { Task { await model.connect(row.id) } }
                .buttonStyle(.borderedProminent).controlSize(.small).tint(.orange)
        case .manual:
            Button("Open dialog") { Task { await model.connect(row.id) } }
                .controlSize(.small)
        case .problem:
            Button("Try again") { Task { await model.connect(row.id) } }.controlSize(.small)
        case .connected:
            Menu {
                if row.isRunning {
                    Button("Restart \(row.name)") { Task { await model.restart(row.id) } }
                }
                Button("Disconnect", role: .destructive) { Task { await model.disconnect(row.id) } }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("More actions for \(row.name)")
        }
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
            if let id = notice.restartRowID {
                Button("Restart now") { Task { await model.restart(id) } }.controlSize(.small)
            }
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

// MARK: - Sections

struct PromptCards: View {
    private let prompts = [
        ("Find my work", "List my Scrivener projects and open the most recent one."),
        ("Get oriented", "Give me a word count for each chapter and tell me which is longest."),
        ("Get feedback", "Read Chapter 3 and tell me where the pacing drags."),
        ("Revise safely", "Take a snapshot of this scene, then tighten the dialogue without changing the meaning."),
    ]
    @State private var copied: String?

    var body: some View {
        Card("Try asking", subtitle: "Click a line to copy it, then paste it into your AI app.") {
            VStack(spacing: 6) {
                ForEach(prompts, id: \.0) { title, text in
                    Button {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                        copied = title
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            if copied == title { copied = nil }
                        }
                    } label: {
                        HStack(alignment: .firstTextBaseline) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                Text(text).font(.callout).multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: copied == title ? "checkmark" : "doc.on.doc")
                                .foregroundStyle(copied == title ? .green : .secondary)
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.separator))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Copies this prompt")
                }
            }
        }
    }
}

struct ProjectsCard: View {
    let model: AppModel

    var body: some View {
        Card("Your Scrivener projects", subtitle: "Find them with Spotlight so you know where they are.") {
            if model.projects.isEmpty {
                HStack {
                    Button {
                        Task { await model.findProjects() }
                    } label: {
                        Label("Find my projects", systemImage: "magnifyingglass")
                    }
                    .disabled(model.isFindingProjects)
                    if model.isFindingProjects { ProgressView().controlSize(.small) }
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(model.projects, id: \.self) { url in
                        HStack {
                            Image(systemName: "book.closed").foregroundStyle(.secondary)
                            Text(url.deletingPathExtension().lastPathComponent)
                            Spacer()
                            Button("Show in Finder") {
                                NSWorkspace.shared.activateFileViewerSelecting([url])
                            }
                            .buttonStyle(.link).font(.caption)
                        }
                    }
                }
            }
        }
    }
}

struct EmptyAppsCard: View {
    var body: some View {
        Card("No AI apps found yet", subtitle: "Marginalia works with these. Install one, then come back.") {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(ClientCatalog.all.filter { $0.downloadURL != nil }, id: \.id) { info in
                    if let url = info.downloadURL {
                        Link(destination: url) {
                            Label(info.appName?.replacingOccurrences(of: ".app", with: "") ?? info.id, systemImage: info.symbol)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Screens

struct ContentView: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            Header()
            Divider()
            switch model.phase {
            case .loading:
                ProgressView("Looking for your AI apps...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                FailureView(message: message, model: model)
            case .ready:
                ScrollView {
                    VStack(spacing: 16) {
                        if let update = model.update { UpdateBanner(update: update) }
                        if model.rows.isEmpty {
                            EmptyAppsCard()
                        } else {
                            Card("Your AI apps", subtitle: "Connect the ones you want to use with your manuscripts.") {
                                VStack(spacing: 2) {
                                    ForEach(model.rows) { row in
                                        ClientRow(row: row, model: model)
                                        if row.id != model.rows.last?.id { Divider() }
                                    }
                                }
                            }
                        }
                        if let notice = model.notice { NoticeBanner(notice: notice, model: model) }
                        PromptCards()
                        ProjectsCard(model: model)
                    }
                    .padding(20)
                }
                Divider()
                Footer(model: model)
            }
        }
        .frame(minWidth: 560, idealWidth: 560, minHeight: 640, idealHeight: 700)
        .background(.background)
    }
}

struct Header: View {
    var body: some View {
        HStack(spacing: 14) {
            AppGlyph().frame(width: 56, height: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text("Marginalia for Scrivener").font(.title2.weight(.semibold))
                Text("Let your AI assistant read, search, and edit your Scrivener manuscripts safely.")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }
}

struct Footer: View {
    let model: AppModel

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if model.allHealthy {
                    Label("Everything is connected", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                } else if model.needsAttention {
                    Label("Something needs attention", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                } else {
                    Text("Connect an app to get started.").foregroundStyle(.secondary)
                }
            }
            .font(.callout)
            Spacer()
            if model.rows.contains(where: { $0.state == .notConnected || $0.state == .needsRepair }) {
                Button("Connect all") { Task { await model.connectAll() } }
            }
            Button {
                Task { await model.testConnection() }
            } label: {
                if model.isTesting {
                    HStack(spacing: 6) { ProgressView().controlSize(.small); Text("Testing...") }
                } else {
                    Text("Test connection")
                }
            }
            .disabled(model.isTesting)
            Menu {
                Button("Copy diagnostics") { model.copyDiagnostics() }
                Link("Get help", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/issues")!)
            } label: {
                Image(systemName: "questionmark.circle")
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel("Help")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}

struct FailureView: View {
    let message: String
    let model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").font(.largeTitle).foregroundStyle(.orange)
            Text("Marginalia can't start").font(.headline)
            Text(message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text("Download the app again from the releases page, then replace this copy.")
                .font(.callout).foregroundStyle(.secondary)
            Link("Open the releases page", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/releases")!)
            Button("Try again") { Task { await model.bootstrap() } }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct UpdateBanner: View {
    let update: ReleaseInfo

    var body: some View {
        HStack {
            Image(systemName: "arrow.down.circle.fill").foregroundStyle(.blue)
            Text("Version \(update.version) is available.").font(.callout)
            Spacer()
            Link("Download", destination: update.pageURL).font(.callout)
        }
        .padding(12)
        .background(Color.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// The app's mark: books with a connector dot. Also used to render the app icon.
struct AppGlyph: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height)
            ZStack {
                RoundedRectangle(cornerRadius: s * 0.225, style: .continuous)
                    .fill(LinearGradient(
                        colors: [Color(red: 0.36, green: 0.34, blue: 0.86), Color(red: 0.20, green: 0.55, blue: 0.95)],
                        startPoint: .topLeading, endPoint: .bottomTrailing))
                Image(systemName: "books.vertical.fill")
                    .font(.system(size: s * 0.52, weight: .regular))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.18), radius: s * 0.02, y: s * 0.015)
                Circle()
                    .fill(Color(red: 0.30, green: 0.85, blue: 0.55))
                    .overlay(Circle().strokeBorder(.white, lineWidth: s * 0.03))
                    .frame(width: s * 0.2, height: s * 0.2)
                    .offset(x: s * 0.27, y: s * 0.27)
            }
            .frame(width: s, height: s)
        }
        .accessibilityHidden(true)
    }
}
