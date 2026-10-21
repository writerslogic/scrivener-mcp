import AppKit
import ScrivenerMCPCore
import SwiftUI

struct ContentView: View {
    let model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("Looking for your AI apps...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .failed(let message):
                FailureView(message: message, model: model)
            case .ready:
                HomeView(model: model)
            }
        }
        .frame(minWidth: 600, idealWidth: 640, minHeight: 620, idealHeight: 760)
        .background(Color(nsColor: .windowBackgroundColor))
        .animation(reduceMotion ? nil : .smooth, value: model.phase)
    }
}

struct HomeView: View {
    let model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                if let update = model.update { UpdateBanner(update: update) }
                Hero(model: model)
                if let notice = model.notice { NoticeBanner(notice: notice, model: model) }
                if model.rows.isEmpty {
                    EmptyAppsGroup()
                } else {
                    AppsGroup(model: model)
                }
                ManuscriptsGroup(model: model)
                if !model.connectedRows.isEmpty { PromptsGroup(model: model) }
                Footer(model: model)
            }
            .frame(maxWidth: 560)
            .padding(.horizontal, 24)
            .padding(.top, 20)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity)
        }
        .animation(reduceMotion ? nil : .smooth, value: model.stage)
        .animation(reduceMotion ? nil : .smooth, value: model.pendingRestartID)
        .animation(reduceMotion ? nil : .smooth, value: model.notice)
    }
}

// MARK: - Hero

/// The one thing to do next, decided by `SetupStage`.
struct Hero: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            if let row = model.pendingRestartRow {
                restart(row)
            } else {
                switch model.stage {
                case .noApps: noApps
                case .connectFirst: connectFirst
                case .needsAttention: attention
                case .ready: ready
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }

    private func title(_ text: String) -> some View {
        Text(text).font(.title.weight(.semibold)).multilineTextAlignment(.center)
    }

    private func body(_ text: String) -> some View {
        Text(text)
            .font(.body).foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 440)
    }

    private var noApps: some View {
        VStack(spacing: 12) {
            AppGlyph().frame(width: 84, height: 84)
            title("Draftbridge for Scrivener")
            body("Install an AI app that supports connectors, then come back. Draftbridge will connect it to your manuscripts in one click.")
        }
    }

    @ViewBuilder private var connectFirst: some View {
        if let row = model.recommendedRow {
            let isManual = row.state == .manual
            AppIconView(row: row, size: 72)
            title(isManual ? "Set up \(row.name)" : "Connect \(row.name)")
            body("Let \(row.name) read, search and safely edit your Scrivener manuscripts. One click, and you can undo it any time.")
            Button {
                Task { await model.connect(row.id) }
            } label: {
                HStack(spacing: 8) {
                    if row.busy { ProgressView().controlSize(.small) }
                    Text(isManual ? "Open \(row.name) setup" : "Connect \(row.name)")
                }
                .frame(minWidth: 180)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(row.busy)
            .keyboardShortcut(.defaultAction)
            StepsStrip(current: 1).padding(.top, 8)
        }
    }

    private func restart(_ row: AppRow) -> some View {
        VStack(spacing: 12) {
            AppIconView(row: row, size: 72)
            title("Restart \(row.name) to finish")
            body("\(row.name) reads its settings when it starts. Draftbridge can restart it for you, and any open chats will be closed.")
            HStack {
                Button {
                    Task { await model.restart(row.id) }
                } label: {
                    Text("Restart \(row.name)").frame(minWidth: 160)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction)
                Button("Later") { model.pendingRestartID = nil }.controlSize(.large)
            }
            StepsStrip(current: 2).padding(.top, 8)
        }
    }

    @ViewBuilder private var attention: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 52)).foregroundStyle(.orange)
        title("A connection needs attention")
        body(attentionDetail)
        Button {
            Task { await model.repairAll() }
        } label: {
            Text("Fix it").frame(minWidth: 140)
        }
        .buttonStyle(.borderedProminent).controlSize(.large).tint(.orange)
    }

    private var attentionDetail: String {
        for row in model.rows {
            if case .problem(let message) = row.state { return "\(row.name): \(message)" }
        }
        return "An older setup was found. Updating it takes a moment and keeps your other settings."
    }

    @ViewBuilder private var ready: some View {
        let first = model.connectedRows.first { $0.appURL != nil }
        Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 52)).foregroundStyle(.green)
        title("You're all set")
        body(readyDetail)
        HStack {
            if let first, first.appURL != nil {
                Button {
                    model.open(first.id)
                } label: {
                    Text("Open \(first.name)").frame(minWidth: 150)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction)
            }
            Button {
                Task { await model.testConnection() }
            } label: {
                HStack(spacing: 6) {
                    if model.isTesting { ProgressView().controlSize(.small) }
                    Text(model.isTesting ? "Testing..." : "Test connection")
                }
            }
            .controlSize(.large)
            .disabled(model.isTesting)
        }
    }

    private var readyDetail: String {
        let names = model.connectedRows.map(\.name)
        let list = names.count > 2
            ? names.dropLast().joined(separator: ", ") + ", and " + (names.last ?? "")
            : names.joined(separator: " and ")
        return "\(list) can now work with your Scrivener projects. Open it and try one of the questions below."
    }
}

/// Connect, restart, ask: where the person is in the first-run path.
struct StepsStrip: View {
    let current: Int
    private let steps = ["Connect", "Restart", "Ask"]

    var body: some View {
        HStack(spacing: 10) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, name in
                let number = index + 1
                HStack(spacing: 6) {
                    ZStack {
                        Circle().fill(number < current ? Color.green : number == current ? Color.accentColor : Color.secondary.opacity(0.2))
                        if number < current {
                            Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                        } else {
                            Text("\(number)").font(.caption2.weight(.bold)).foregroundStyle(number == current ? .white : .secondary)
                        }
                    }
                    .frame(width: 18, height: 18)
                    Text(name).font(.callout).foregroundStyle(number == current ? .primary : .secondary)
                }
                if number < steps.count {
                    Rectangle().fill(.separator).frame(width: 24, height: 1)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(current) of \(steps.count): \(steps[current - 1])")
    }
}

// MARK: - AI apps

struct AppsGroup: View {
    let model: AppModel

    var body: some View {
        SettingsGroup("Your AI apps", footnote: "Draftbridge only edits the entry it added. The rest of each app's settings stay as they were.") {
            ForEach(Array(model.rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { RowDivider() }
                ClientRow(row: row, model: model)
            }
        }
    }
}

struct ClientRow: View {
    let row: AppRow
    let model: AppModel

    var body: some View {
        HStack(spacing: 12) {
            AppIconView(row: row)
            VStack(alignment: .leading, spacing: 2) {
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
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
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
            if row.appURL != nil {
                Button("Open") { model.open(row.id) }.controlSize(.small)
            }
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

struct EmptyAppsGroup: View {
    var body: some View {
        SettingsGroup("Works with") {
            let apps = ClientCatalog.all.filter { $0.downloadURL != nil }
            ForEach(Array(apps.enumerated()), id: \.element.id) { index, info in
                if index > 0 { RowDivider() }
                if let url = info.downloadURL {
                    Link(destination: url) {
                        HStack(spacing: 12) {
                            Image(systemName: info.symbol).frame(width: 24).foregroundStyle(.secondary)
                            Text(info.appName?.replacingOccurrences(of: ".app", with: "") ?? info.id)
                            Spacer()
                            Image(systemName: "arrow.up.forward").font(.caption).foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

// MARK: - Manuscripts

struct ManuscriptsGroup: View {
    let model: AppModel
    @State private var showAll = false
    private let collapsedCount = 4

    var body: some View {
        SettingsGroup("Your manuscripts", footnote: footnote) {
            scrivenerRow
            if model.scrivener.isRunning { RowDivider(); safetyRow }
            RowDivider()
            projectsContent
        }
    }

    private var footnote: String {
        "Draftbridge never writes to a project while Scrivener has it open, and takes a Scrivener snapshot before risky edits."
    }

    private var scrivenerRow: some View {
        HStack(spacing: 12) {
            Group {
                if let url = model.scrivener.appURL {
                    Image(nsImage: NSWorkspace.shared.icon(forFile: url.path)).resizable()
                } else {
                    Image(systemName: "book.closed").font(.system(size: 18)).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
            .frame(width: 36, height: 36)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.scrivener.version.map { "Scrivener \($0)" } ?? "Scrivener").font(.body.weight(.medium))
                Text(scrivenerDetail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if model.scrivener.isInstalled, !model.scrivener.isRunning {
                Button("Open") { model.openScrivener() }.controlSize(.small)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private var scrivenerDetail: String {
        if !model.scrivener.isInstalled { return "Not found. Draftbridge can still read projects stored on this Mac." }
        return model.scrivener.isRunning ? "Open" : "Closed"
    }

    private var safetyRow: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill").foregroundStyle(.orange).frame(width: 18).padding(.top, 2)
            Text("Scrivener is open. Close a project in Scrivener before asking your AI to change it. Reading and searching still work.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08))
    }

    @ViewBuilder private var projectsContent: some View {
        if model.isFindingProjects && model.projects.isEmpty {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Looking for your projects...").font(.callout).foregroundStyle(.secondary)
            }
            .padding(14)
        } else if model.projects.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("No projects found yet. Spotlight may still be indexing, or your projects are in a folder it does not search.")
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Search again") { Task { await model.findProjects() } }.controlSize(.small)
            }
            .padding(14)
        } else {
            let visible = showAll ? model.projects : Array(model.projects.prefix(collapsedCount))
            ForEach(Array(visible.enumerated()), id: \.element.id) { index, project in
                if index > 0 { RowDivider() }
                ProjectRow(project: project)
            }
            if model.projects.count > collapsedCount {
                RowDivider()
                Button {
                    showAll.toggle()
                } label: {
                    Text(showAll ? "Show fewer" : "Show all \(model.projects.count) projects")
                        .font(.callout)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.accentColor)
            }
        }
    }
}

struct ProjectRow: View {
    let project: ProjectInfo

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "book.closed.fill")
                .foregroundStyle(.secondary)
                .frame(width: 36)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).font(.body)
                if let edited = project.editedDescription() {
                    Text(edited).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([project.url])
            } label: {
                Image(systemName: "magnifyingglass.circle")
            }
            .buttonStyle(.borderless)
            .help("Show in Finder")
            .accessibilityLabel("Show \(project.name) in Finder")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }
}

// MARK: - Prompts

struct PromptsGroup: View {
    let model: AppModel
    private let prompts = [
        ("Find my work", "List my Scrivener projects and open the most recent one."),
        ("Get oriented", "Give me a word count for each chapter and tell me which is longest."),
        ("Search by meaning", "Find the scenes where my narrator is afraid, even if the word 'afraid' never appears."),
        ("Get feedback", "Read Chapter 3 and tell me where the pacing drags."),
        ("Revise safely", "Take a snapshot of this scene, then tighten the dialogue without changing the meaning."),
    ]
    @State private var copied: String?

    var body: some View {
        SettingsGroup("Try asking", footnote: "Click a line to copy it, then paste it into \(target).") {
            ForEach(Array(prompts.enumerated()), id: \.element.0) { index, prompt in
                if index > 0 { RowDivider() }
                Button {
                    copy(prompt)
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(prompt.0).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            Text(prompt.1).font(.callout).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: copied == prompt.0 ? "checkmark" : "doc.on.doc")
                            .foregroundStyle(copied == prompt.0 ? .green : .secondary)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Copies this question")
            }
        }
    }

    private var target: String {
        model.connectedRows.first.map(\.name) ?? "your AI app"
    }

    private func copy(_ prompt: (String, String)) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(prompt.1, forType: .string)
        withAnimation { copied = prompt.0 }
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if copied == prompt.0 { withAnimation { copied = nil } }
        }
    }
}

// MARK: - Footer and failure

struct Footer: View {
    let model: AppModel

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 14) {
                Link("Help", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/blob/main/docs/install-mac.md")!)
                Button("Copy diagnostics") { model.copyDiagnostics() }.buttonStyle(.link)
                Link("Report a problem", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/issues/new?labels=mac-app")!)
            }
            .font(.caption)
            Text("Draftbridge \(model.appVersion). Not affiliated with Literature & Latte.")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
    }
}

struct FailureView: View {
    let message: String
    let model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            AppGlyph().frame(width: 72, height: 72)
            Text("Draftbridge can't start").font(.title2.weight(.semibold))
            Text(message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Text("Download the app again from the releases page and replace this copy. If it keeps happening, copy the details and send them with your report.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                .frame(maxWidth: 420)
            HStack {
                Link("Open the releases page", destination: URL(string: "https://github.com/writerslogic/scrivener-mcp/releases")!)
                Button("Copy diagnostics") { model.copyDiagnostics() }
                Button("Try again") { Task { await model.bootstrap() } }.keyboardShortcut(.defaultAction)
            }
            .padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
