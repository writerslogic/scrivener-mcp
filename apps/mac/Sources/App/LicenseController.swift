import AppKit
import CryptoKit
import IOKit
import Observation
import ScrivenerMCPCore

/// Owns the license for the UI. Only connecting, repairing and fixing are gated; looking around,
/// testing and disconnecting never are, and connections that already exist keep working whatever
/// happens to the license.
@MainActor
@Observable
final class LicenseController {
    private(set) var state: LicenseState = .unlicensed
    private(set) var priceLabel: String?
    private(set) var checkoutURL: URL?
    private(set) var configError: String?

    var showPurchase = false
    var isWorking = false
    var message: String?
    /// Filled in by a draftbridge://license link. The person still presses Activate.
    var prefilledKey = ""

    private let service: LicenseService

    init(info: [String: Any] = Bundle.main.infoDictionary ?? [:], store: LicenseStore = KeychainLicenseStore()) {
        var config: LicenseConfig?
        do {
            config = try LicenseConfig.load(info: info)
        } catch {
            configError = "This copy of Draftbridge has incomplete license settings."
        }
        priceLabel = config?.priceLabel
        checkoutURL = config?.checkoutURL
        service = LicenseService(
            config: config, store: store,
            deviceID: Self.deviceID(), deviceName: Host.current().localizedName ?? "Mac"
        )
        if config == nil { state = configError == nil ? .notRequired : .invalid }
    }

    var allowsSetup: Bool { state.allowsSetup }

    /// True when this build asks for a license at all.
    var isRequired: Bool { state != .notRequired }

    var licensee: String? {
        switch state {
        case .licensed(let info), .needsActivation(let info): info.email
        default: nil
        }
    }

    /// Reads the saved license. Local and fast, so the first screen already knows whether to gate.
    func loadState() async {
        guard configError == nil else { return }
        state = await service.state()
    }

    /// Also fetches the revocation list, at most once a day. Never blocks the first screen.
    func refresh() async {
        guard configError == nil else { return }
        await loadState()
        await service.refreshRevocations()
        await loadState()
    }

    /// Call before a gated action. Returns true when the action may go ahead.
    func authorize() -> Bool {
        if allowsSetup { return true }
        showPurchase = true
        return false
    }

    func enter(_ key: String) async {
        guard !isWorking else { return }
        isWorking = true
        message = nil
        defer { isWorking = false }
        switch await service.enter(key: key) {
        case .accepted(let newState):
            state = newState
            if newState.allowsSetup { showPurchase = false; prefilledKey = "" }
        case .failed(let text):
            message = text
            state = await service.state()
        }
    }

    func activateThisMac() async {
        guard !isWorking else { return }
        isWorking = true
        message = nil
        defer { isWorking = false }
        switch await service.activate() {
        case .accepted(let newState): state = newState
        case .failed(let text): message = text; state = await service.state()
        }
    }

    func deactivate() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        if await service.deactivate() {
            message = nil
        } else {
            message = "Could not reach the license server, so this Mac's seat was not released. Try again when you are online."
        }
        state = await service.state()
    }

    func handle(_ url: URL) {
        guard url.scheme == "draftbridge", url.host == "license",
              let key = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "key" })?.value
        else { return }
        prefilledKey = key
        showPurchase = true
    }

    /// A stable, anonymous identifier for this Mac: a hash of the hardware UUID, never the UUID itself.
    private static func deviceID() -> String {
        let entry = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        defer { if entry != 0 { IOObjectRelease(entry) } }
        let uuid = (IORegistryEntryCreateCFProperty(entry, "IOPlatformUUID" as CFString, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String) ?? UserDefaults.standard.string(forKey: "fallbackDeviceID") ?? {
                let fresh = UUID().uuidString
                UserDefaults.standard.set(fresh, forKey: "fallbackDeviceID")
                return fresh
            }()
        return SHA256.hash(data: Data(("draftbridge:" + uuid).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// A model state for previews. It never touches the Keychain or the network.
    static func sample(_ state: LicenseState, price: String? = "$14.99") -> LicenseController {
        let controller = LicenseController(info: [:], store: SampleStore())
        controller.state = state
        controller.priceLabel = price
        controller.checkoutURL = URL(string: "https://example.com/buy")
        return controller
    }

    private struct SampleStore: LicenseStore {
        func load() -> StoredLicense? { nil }
        func save(_ license: StoredLicense) {}
        func clear() {}
    }
}
