import AppKit
import ScrivenerMCPCore
import SwiftUI

struct PurchaseSheet: View {
    let licensing: LicenseController
    @Environment(\.dismiss) private var dismiss
    @State private var key = ""
    @FocusState private var keyFocused: Bool

    var body: some View {
        VStack(spacing: 18) {
            AppGlyph().frame(width: 64, height: 64)
            VStack(spacing: 4) {
                Text("Get Draftbridge").font(.title2.weight(.semibold))
                if let price = licensing.priceLabel {
                    Text("\(price), one time").font(.title3).foregroundStyle(.secondary)
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Reassurance(symbol: "bolt.fill", tint: .blue, text: "Connects Claude, BoltAI, Raycast, Cursor and more with one click.")
                Reassurance(symbol: "wrench.and.screwdriver.fill", tint: .blue, text: "Repairs the connection after an app updates.")
                Reassurance(symbol: "terminal.fill", tint: .blue, text: "No Terminal, no Node.js, no settings files to edit.")
                Reassurance(symbol: "checkmark.shield.fill", tint: .green, text: "Looking around and testing stay free, and apps you already connected keep working.")
            }
            .frame(maxWidth: 380, alignment: .leading)

            if let url = licensing.checkoutURL {
                Button {
                    NSWorkspace.shared.open(url)
                } label: {
                    Text(licensing.priceLabel.map { "Buy Draftbridge for \($0)" } ?? "Buy Draftbridge").frame(minWidth: 220)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
            }

            Divider().padding(.vertical, 2)

            VStack(spacing: 8) {
                Text("Already bought it?").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                HStack {
                    TextField("Paste your license key", text: $key)
                        .textFieldStyle(.roundedBorder)
                        .focused($keyFocused)
                        .onSubmit(submit)
                        .accessibilityLabel("License key")
                    Button(action: submit) {
                        HStack(spacing: 6) {
                            if licensing.isWorking { ProgressView().controlSize(.small) }
                            Text("Activate")
                        }
                    }
                    .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || licensing.isWorking)
                    .keyboardShortcut(.defaultAction)
                }
                if let message = licensing.message {
                    Text(message).font(.callout).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxWidth: 420)

            VStack(spacing: 4) {
                Text("Prefer the terminal? The open-source command-line setup does the same job for free.")
                Text("Activating sends your license key and this Mac's name to the license server. Nothing about your manuscripts is ever sent.")
            }
            .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
            .frame(maxWidth: 420)

            Button("Not now") { dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(28)
        .frame(width: 500)
        .onAppear {
            key = licensing.prefilledKey
            if key.isEmpty { keyFocused = true }
        }
        .onChange(of: licensing.prefilledKey) { _, new in if !new.isEmpty { key = new } }
    }

    private func submit() {
        Task { await licensing.enter(key) }
    }
}

/// Shown only when a license exists but cannot be used. A plain unlicensed Mac is not nagged.
struct LicenseBanner: View {
    let licensing: LicenseController

    var body: some View {
        switch licensing.state {
        case .needsActivation(let info):
            banner(
                symbol: "key.fill", tint: .orange,
                text: "Your license for \(info.email) is valid. Activate it on this Mac to connect more apps.",
                action: ("Activate this Mac", { Task { await licensing.activateThisMac() } })
            )
        case .revoked:
            banner(
                symbol: "xmark.octagon.fill", tint: .red,
                text: "This license was refunded or withdrawn. Apps you already connected keep working.",
                action: ("Enter a different key", { licensing.showPurchase = true })
            )
        case .invalid:
            banner(
                symbol: "exclamationmark.triangle.fill", tint: .orange,
                text: "The saved license could not be verified.",
                action: ("Enter license key", { licensing.showPurchase = true })
            )
        default:
            EmptyView()
        }
    }

    private func banner(symbol: String, tint: Color, text: String, action: (String, () -> Void)) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol).foregroundStyle(tint)
                Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button(action.0, action: action.1).controlSize(.small).disabled(licensing.isWorking)
            }
            if let message = licensing.message {
                Text(message).font(.caption).foregroundStyle(.red)
            }
        }
        .padding(12)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

struct LicenseSettingsSection: View {
    let licensing: LicenseController
    @State private var confirmingDeactivation = false

    var body: some View {
        if licensing.isRequired {
            Section("License") {
                switch licensing.state {
                case .licensed(let info):
                    LabeledContent("Status") { Label("Licensed", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
                    LabeledContent("Licensed to", value: info.email)
                    LabeledContent("This Mac") {
                        Button("Deactivate...") { confirmingDeactivation = true }.disabled(licensing.isWorking)
                    }
                    Text("Deactivating frees this Mac's seat so you can use the license on another Mac. Apps you already connected keep working.")
                        .font(.caption).foregroundStyle(.secondary)
                case .needsActivation(let info):
                    LabeledContent("Status") { Label("Needs activation", systemImage: "key.fill").foregroundStyle(.orange) }
                    LabeledContent("Licensed to", value: info.email)
                    Button("Activate this Mac") { Task { await licensing.activateThisMac() } }.disabled(licensing.isWorking)
                case .revoked:
                    LabeledContent("Status") { Label("Withdrawn", systemImage: "xmark.octagon.fill").foregroundStyle(.red) }
                    Button("Enter a different key...") { licensing.showPurchase = true }
                case .invalid, .unlicensed, .notRequired:
                    LabeledContent("Status") { Text("Not licensed").foregroundStyle(.secondary) }
                    Button(licensing.priceLabel.map { "Get Draftbridge, \($0)..." } ?? "Get Draftbridge...") { licensing.showPurchase = true }
                }
                if let message = licensing.message {
                    Text(message).font(.caption).foregroundStyle(.red)
                }
            }
            .confirmationDialog("Deactivate this Mac?", isPresented: $confirmingDeactivation) {
                Button("Deactivate", role: .destructive) { Task { await licensing.deactivate() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Draftbridge will stop connecting new apps on this Mac until you activate it again.")
            }
        }
    }
}
