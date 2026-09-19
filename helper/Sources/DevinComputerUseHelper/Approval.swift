import AppKit
import Foundation

// How the user is asked "Allow Devin to use <app>?".
protocol ApprovalPresenter {
    /// May be called on a socket thread; implementations must hop to main as
    /// needed and invoke completion with the user's decision.
    func prompt(appName: String, completion: @escaping (Approval.Decision) -> Void)
}

// Inline card in the chat window; the socket thread blocks on a semaphore.
final class ChatApprovalPresenter: ApprovalPresenter {
    func prompt(appName: String, completion: @escaping (Approval.Decision) -> Void) {
        let semaphore = DispatchSemaphore(value: 0)
        var decision: Approval.Decision = .cancel
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                ChatStore.shared.requestAppApproval(appName: appName) { answer in
                    decision = answer
                    semaphore.signal()
                }
            }
            NSApp.activate(ignoringOtherApps: true)
        }
        semaphore.wait()
        completion(decision)
    }
}

// Classic modal alert fallback when the chat window is not visible.
final class AlertApprovalPresenter: ApprovalPresenter {
    func prompt(appName: String, completion: @escaping (Approval.Decision) -> Void) {
        var decision: Approval.Decision = .cancel
        DispatchQueue.main.sync {
            let alert = NSAlert()
            alert.messageText = "Allow Devin to use \(appName)?"
            alert.informativeText = "Devin will be able to see and control \(appName) while it works on your task."
            alert.alertStyle = .warning
            alert.addButton(withTitle: "Always allow")
            alert.addButton(withTitle: "Allow once")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            switch alert.runModal() {
            case .alertFirstButtonReturn: decision = .always
            case .alertSecondButtonReturn: decision = .allow
            default: decision = .cancel
            }
        }
        completion(decision)
    }
}

// Per-app approval gate, persisted in config.json next to the socket.
// Thread-safe: check() may be called from a socket thread (the UI-card path
// blocks that thread on a semaphore; the alert path hops to main itself).
final class Approval {
    static let shared = Approval()

    let supportDir: URL
    let configURL: URL
    private let lock = NSLock()
    private var alwaysAllowedStorage: Set<String>
    private(set) var blocked: Set<String>

    var alwaysAllowed: Set<String> {
        lock.lock()
        defer { lock.unlock() }
        return alwaysAllowedStorage
    }

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
        alwaysAllowedStorage = allowed
        self.blocked = blocked
    }

    private func persist() {
        lock.lock()
        let payload: [String: [String]] = [
            "alwaysAllowed": alwaysAllowedStorage.sorted(),
            "blocked": blocked.sorted(),
        ]
        lock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) {
            try? data.write(to: configURL, options: .atomic)
        }
    }

    func remove(_ bundleId: String) {
        lock.lock()
        alwaysAllowedStorage.remove(bundleId)
        lock.unlock()
        persist()
    }

    func reset() {
        lock.lock()
        alwaysAllowedStorage.removeAll()
        lock.unlock()
        persist()
    }

    private func insertAlwaysAllowed(_ bundleId: String) {
        lock.lock()
        alwaysAllowedStorage.insert(bundleId)
        lock.unlock()
        persist()
    }

    /// May be called on any thread. Throws app_not_allowed/blocked_app on denial.
    func check(appName: String, bundleId: String?) throws {
        if Approval.blockedBundleIds.contains(bundleId ?? "") {
            throw HelperException("blocked_app",
                                  "Devin cannot control \(appName): terminal apps are always blocked.")
        }
        if let bundleId, !bundleId.isEmpty, alwaysAllowed.contains(bundleId) {
            return
        }
        let decision = promptDecision(appName: appName)
        switch decision {
        case .always:
            if let bundleId, !bundleId.isEmpty {
                insertAlwaysAllowed(bundleId)
            }
        case .allow:
            return
        case .cancel:
            throw HelperException("app_not_allowed", "The user declined to let Devin use \(appName).")
        }
    }

    private func promptDecision(appName: String) -> Approval.Decision {
        let presenter: ApprovalPresenter = chatWindowAvailable() ? ChatApprovalPresenter() : AlertApprovalPresenter()
        var decision: Approval.Decision = .cancel
        presenter.prompt(appName: appName) { decision = $0 }
        return decision
    }

    private func chatWindowAvailable() -> Bool {
        if Thread.isMainThread {
            return MainActor.assumeIsolated {
                ChatStore.shared.canPresentApproval
            }
        }
        return DispatchQueue.main.sync {
            MainActor.assumeIsolated {
                ChatStore.shared.canPresentApproval
            }
        }
    }

    enum Decision {
        case cancel, allow, always
        var allowed: Bool { self != .cancel }
    }
}
