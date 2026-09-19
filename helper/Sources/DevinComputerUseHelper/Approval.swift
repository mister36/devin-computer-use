import AppKit
import Foundation

// Per-app approval gate, persisted in config.json next to the socket.
final class Approval {
    static let shared = Approval()

    let supportDir: URL
    let configURL: URL
    private(set) var alwaysAllowed: Set<String>
    private(set) var blocked: Set<String>

    // Terminal bundle ids are always refused: Devin must never drive a shell
    // through the accessibility layer.
    static let blockedBundleIds: Set<String> = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "com.mitchellh.ghostty",
        "org.alacritty",
        "net.kovidgoyal.kitty",
    ]

    private init() {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/DevinComputerUse", isDirectory: true)
        supportDir = base
        configURL = base.appendingPathComponent("config.json")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        var allowed: Set<String> = []
        var blocked: Set<String> = []
        if let data = try? Data(contentsOf: configURL),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: [String]] {
            allowed = Set(parsed["alwaysAllowed"] ?? [])
            blocked = Set(parsed["blocked"] ?? [])
        }
        alwaysAllowed = allowed
        self.blocked = blocked
    }

    private func persist() {
        let payload: [String: [String]] = [
            "alwaysAllowed": alwaysAllowed.sorted(),
            "blocked": blocked.sorted(),
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) {
            try? data.write(to: configURL, options: .atomic)
        }
    }

    func remove(_ bundleId: String) {
        alwaysAllowed.remove(bundleId)
        persist()
    }

    func reset() {
        alwaysAllowed.removeAll()
        persist()
    }

    var isBlocked: (String?) -> Bool = { bundleId in
        guard let bundleId else { return false }
        return Approval.blockedBundleIds.contains(bundleId)
    }

    /// Must be called on the main thread. Returns nil when the app may proceed,
    /// otherwise throws a HelperException with code app_not_allowed/blocked_app.
    func check(appName: String, bundleId: String?) throws {
        if Approval.blockedBundleIds.contains(bundleId ?? "") {
            throw HelperException("blocked_app",
                                  "Devin cannot control \(appName): terminal apps are always blocked.")
        }
        guard let bundleId, !bundleId.isEmpty else {
            // No bundle id: require an interactive allow every time.
            if !prompt(appName: appName).allowed {
                throw HelperException("app_not_allowed", "The user declined to let Devin use \(appName).")
            }
            return
        }
        if alwaysAllowed.contains(bundleId) {
            return
        }
        switch prompt(appName: appName) {
        case .always:
            alwaysAllowed.insert(bundleId)
            persist()
        case .allow:
            return
        case .cancel:
            throw HelperException("app_not_allowed", "The user declined to let Devin use \(appName).")
        }
    }

    enum Decision {
        case cancel, allow, always
        var allowed: Bool { self != .cancel }
    }

    private func prompt(appName: String) -> Decision {
        let alert = NSAlert()
        alert.messageText = "Allow Devin to use \(appName)?"
        alert.informativeText = "Devin will be able to see and control \(appName) while it works on your task."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Always allow")
        alert.addButton(withTitle: "Allow once")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .always
        case .alertSecondButtonReturn: return .allow
        default: return .cancel
        }
    }
}
