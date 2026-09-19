import AppKit
import Darwin
import Foundation

// Menu-bar app: status icon, allowed-apps management, settings shortcuts,
// owns the socket server and the request handler.
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: SocketServer!
    private let statusMenuItem = NSMenuItem()
    private var allowedWindow: NSWindow?

    var socketPath: String {
        Approval.shared.supportDir.appendingPathComponent("helper.sock").path
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "◉"
        statusItem.button?.toolTip = "Devin Computer Use"

        let menu = NSMenu()
        statusMenuItem.title = statusLine()
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        let allowed = NSMenuItem(title: "Allowed apps…", action: #selector(showAllowedApps), keyEquivalent: "")
        allowed.target = self
        menu.addItem(allowed)
        let accessibility = NSMenuItem(title: "Open Accessibility Settings", action: #selector(openAccessibilitySettings), keyEquivalent: "")
        accessibility.target = self
        menu.addItem(accessibility)
        let screen = NSMenuItem(title: "Open Screen Recording Settings", action: #selector(openScreenRecordingSettings), keyEquivalent: "")
        screen.target = self
        menu.addItem(screen)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Devin Computer Use", action: #selector(quitApp), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu

        RequestHandler.shared.statusChanged = { [weak self] in
            self?.statusMenuItem.title = self?.statusLine() ?? ""
        }

        do {
            server = SocketServer(socketPath: socketPath)
            try server.start()
        } catch {
            let alert = NSAlert()
            alert.messageText = "Devin Computer Use failed to start"
            alert.informativeText = "\(error)"
            alert.runModal()
        }

        // Warm the TCC prompts lazily: do not request permissions until the
        // first request needs them, but surface a clear status in the menu.
        statusMenuItem.title = statusLine()
    }

    private func statusLine() -> String {
        let ax = Screenshot.accessibilityGranted() ? "Accessibility ✓" : "Accessibility ✗"
        let sr = Screenshot.screenRecordingGranted() ? "Screen Recording ✓" : "Screen Recording ✗"
        let busy = RequestHandler.shared.isBusy ? " — working…" : ""
        return "\(ax) · \(sr)\(busy)"
    }

    @objc private func showAllowedApps() {
        let apps = Approval.shared.alwaysAllowed.sorted()
        guard !apps.isEmpty else {
            let alert = NSAlert()
            alert.messageText = "No always-allowed apps"
            alert.informativeText = "Apps Devin has been allowed to use will appear here."
            alert.runModal()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Always-allowed apps"
        alert.informativeText = apps.joined(separator: "\n")
        alert.addButton(withTitle: "Reset all")
        alert.addButton(withTitle: "Done")
        if alert.runModal() == .alertFirstButtonReturn {
            Approval.shared.reset()
        }
    }

    @objc private func openAccessibilitySettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }

    @objc private func openScreenRecordingSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
    }

    @objc private func quitApp() {
        server?.stop()
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.stop()
    }
}

// Dispatches helper methods to AX/screenshot/input work. Runs on the main
// thread (the socket server hops via DispatchQueue.main.sync).
final class RequestHandler {
    static let shared = RequestHandler()

    var statusChanged: (() -> Void)?
    private(set) var isBusy = false

    private let reader = TreeReader()

    func handle(_ request: HelperRequest) -> HelperResponse {
        isBusy = true
        statusChanged?()
        defer {
            isBusy = false
            statusChanged?()
        }
        do {
            let result = try dispatch(request)
            return .ok(id: request.id, result)
        } catch let error as HelperException {
            return .failure(id: request.id, code: error.code, message: error.message)
        } catch {
            return .failure(id: request.id, code: "internal", message: "\(error)")
        }
    }

    private func param(_ request: HelperRequest, _ name: String) -> JSONValue? {
        request.params?[name]
    }

    private func requireString(_ request: HelperRequest, _ name: String) throws -> String {
        guard let value = param(request, name)?.stringValue else {
            throw HelperException("bad_request", "Missing string param \"\(name)\".")
        }
        return value
    }

    private func dispatch(_ request: HelperRequest) throws -> [String: JSONValue] {
        switch request.method {
        case "ping":
            return [
                "version": .string("0.1.0"),
                "accessibility": .bool(Screenshot.accessibilityGranted()),
                "screenRecording": .bool(Screenshot.screenRecordingGranted()),
            ]
        case "list_apps":
            return try listApps()
        case "open_app":
            let app = try requireString(request, "app")
            return try openApp(app)
        case "get_app_state":
            let app = try gatedApp(request)
            return try appState(app, request: request)
        case "click":
            let app = try gatedApp(request)
            try doClick(app: app, request: request)
            return ["ok": .bool(true)]
        case "type_text":
            let app = try gatedApp(request)
            try doType(app: app, request: request)
            return ["ok": .bool(true)]
        case "press_key":
            let app = try gatedApp(request)
            try Input.key(pid: app.pid,
                          name: requireString(request, "key"),
                          modifiers: param(request, "modifiers")?.arrayValue?.compactMap { $0.stringValue } ?? [])
            return ["ok": .bool(true)]
        case "scroll":
            let app = try gatedApp(request)
            try doScroll(app: app, request: request)
            return ["ok": .bool(true)]
        case "drag":
            let app = try gatedApp(request)
            try doDrag(app: app, request: request)
            return ["ok": .bool(true)]
        case "set_value":
            let app = try gatedApp(request)
            try doSetValue(app: app, request: request)
            return ["ok": .bool(true)]
        default:
            throw HelperException("unknown_method", "Unknown method \"\(request.method)\".")
        }
    }

    /// Resolve the app param and pass it through the approval gate.
    private func gatedApp(_ request: HelperRequest) throws -> ResolvedApp {
        let spec = try requireString(request, "app")
        guard Screenshot.requestAccessibility() else {
            throw HelperException("permission_required",
                                  "Accessibility access is not granted. Enable \"Devin Computer Use\" in System Settings > Privacy & Security > Accessibility.")
        }
        let app = try AppResolver.resolve(spec)
        try Approval.shared.check(appName: app.name, bundleId: app.bundleId)
        return app
    }

    private func listApps() throws -> [String: JSONValue] {
        var apps: [JSONValue] = []
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier
        for running in NSWorkspace.shared.runningApplications where running.activationPolicy == .regular {
            let windows = windowList(pid: running.processIdentifier)
            guard !windows.isEmpty else { continue }
            apps.append(.object([
                "pid": .number(Double(running.processIdentifier)),
                "name": .string(running.localizedName ?? ""),
                "bundleId": running.bundleIdentifier.map { .string($0) } ?? .null,
                "active": .bool(running.processIdentifier == frontmost),
                "windows": .array(windows),
            ]))
        }
        return ["apps": .array(apps)]
    }

    private func windowList(pid: pid_t) -> [JSONValue] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        return list.compactMap { info in
            guard let owner = info[kCGWindowOwnerPID as String] as? Int32, owner == pid,
                  let id = info[kCGWindowNumber as String] as? UInt32 else { return nil }
            let title = info[kCGWindowName as String] as? String ?? ""
            var bounds: [Double] = [0, 0, 0, 0]
            if let rect = info[kCGWindowBounds as String] as? [String: CGFloat] {
                bounds = [Double(rect["X"] ?? 0), Double(rect["Y"] ?? 0),
                          Double(rect["Width"] ?? 0), Double(rect["Height"] ?? 0)]
            }
            return .object([
                "id": .number(Double(id)),
                "title": .string(title),
                "bounds": .array(bounds.map { .number($0) }),
            ])
        }
    }

    private func appState(_ app: ResolvedApp, request: HelperRequest) throws -> [String: JSONValue] {
        let windowId = param(request, "windowId")?.doubleValue.map { CGWindowID(UInt32($0)) }
        let maxNodes = param(request, "maxNodes")?.intValue ?? AX.maxNodesDefault
        let maxDepth = param(request, "maxDepth")?.intValue ?? AX.maxDepthDefault
        let wantScreenshot = param(request, "screenshot")?.boolValue ?? true

        let (window, info, elements, truncated) = reader.flatten(
            app: app, windowId: windowId, maxNodes: maxNodes, maxDepth: maxDepth)

        var result: [String: JSONValue] = [
            "app": .object([
                "pid": .number(Double(app.pid)),
                "name": .string(app.name),
                "bundleId": app.bundleId.map { .string($0) } ?? .null,
            ]),
            "window": .object([
                "id": .number(Double(info.id)),
                "title": .string(info.title),
                "bounds": .rect(info.bounds),
            ]),
            "elements": .array(elements.map { .object($0.json) }),
            "truncated": .bool(truncated),
        ]
        if wantScreenshot, Screenshot.requestScreenRecording(),
           let shot = Screenshot.captureWindow(info.id, windowBounds: info.bounds) {
            result["screenshot"] = .object(shot)
        }
        _ = window
        return result
    }

    // Resolve click target: elementId -> AX element centre on screen, or x,y
    // (window-relative points) -> screen point.
    private func targetPoint(app: ResolvedApp, request: HelperRequest) throws -> (point: CGPoint, element: AXUIElement?) {
        if let id = param(request, "elementId")?.intValue {
            guard let element = reader.cache.element(pid: app.pid, id: id) else {
                throw HelperException("stale_element", "Element \(id) is gone; call get_app_state again.")
            }
            if let point = reader.screenPoint(for: element) {
                return (point, element)
            }
            throw HelperException("stale_element", "Element \(id) has no bounds.")
        }
        guard let x = param(request, "x")?.doubleValue, let y = param(request, "y")?.doubleValue else {
            throw HelperException("bad_request", "click/scroll needs elementId or x,y.")
        }
        let origin = reader.windowOrigin(frontWindow(app: app))
        return (CGPoint(x: origin.x + x, y: origin.y + y), nil)
    }

    private func frontWindow(app: ResolvedApp) -> AXUIElement {
        var value: AnyObject?
        if AXUIElementCopyAttributeValue(app.element, kAXFocusedWindowAttribute as CFString, &value) == .success,
           let window = value {
            return (window as! AXUIElement)
        }
        if AXUIElementCopyAttributeValue(app.element, kAXWindowsAttribute as CFString, &value) == .success,
           let windows = value as? [AXUIElement], let first = windows.first {
            return first
        }
        return app.element
    }

    private func doClick(app: ResolvedApp, request: HelperRequest) throws {
        let button = param(request, "button")?.stringValue ?? "left"
        let count = param(request, "count")?.intValue ?? 1
        let (point, element) = try targetPoint(app: app, request: request)
        if let element, count == 1, button == "left", Input.press(element) {
            return
        }
        Input.click(pid: app.pid, point: point, button: button, count: count)
    }

    private func doType(app: ResolvedApp, request: HelperRequest) throws {
        let text = try requireString(request, "text")
        let replace = param(request, "replace")?.boolValue ?? false
        let submit = param(request, "submit")?.boolValue ?? false
        if let id = param(request, "elementId")?.intValue {
            guard let element = reader.cache.element(pid: app.pid, id: id) else {
                throw HelperException("stale_element", "Element \(id) is gone; call get_app_state again.")
            }
            if replace {
                // Prefer setting the value directly when supported.
                if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) == .success {
                    if submit { try Input.key(pid: app.pid, name: "return", modifiers: []) }
                    return
                }
            }
            Input.focus(element)
        }
        if replace {
            Input.selectAll(pid: app.pid)
        }
        Input.typeText(pid: app.pid, text: text)
        if submit {
            try Input.key(pid: app.pid, name: "return", modifiers: [])
        }
    }

    private func doScroll(app: ResolvedApp, request: HelperRequest) throws {
        let dx = param(request, "dx")?.doubleValue ?? 0
        let dy = param(request, "dy")?.doubleValue ?? 0
        let (point, _) = try targetPoint(app: app, request: request)
        Input.scroll(pid: app.pid, point: point, dx: dx, dy: dy)
    }

    private func doDrag(app: ResolvedApp, request: HelperRequest) throws {
        guard let from = param(request, "from")?.objectValue,
              let to = param(request, "to")?.objectValue,
              let fx = from["x"]?.doubleValue, let fy = from["y"]?.doubleValue,
              let tx = to["x"]?.doubleValue, let ty = to["y"]?.doubleValue else {
            throw HelperException("bad_request", "drag needs from:{x,y} and to:{x,y}.")
        }
        let origin = reader.windowOrigin(frontWindow(app: app))
        Input.drag(pid: app.pid,
                   from: CGPoint(x: origin.x + fx, y: origin.y + fy),
                   to: CGPoint(x: origin.x + tx, y: origin.y + ty))
    }

    private func doSetValue(app: ResolvedApp, request: HelperRequest) throws {
        guard let id = param(request, "elementId")?.intValue,
              let element = reader.cache.element(pid: app.pid, id: id) else {
            throw HelperException("stale_element", "Element is gone; call get_app_state again.")
        }
        guard let value = param(request, "value") else {
            throw HelperException("bad_request", "set_value needs a value.")
        }
        let cf: CFTypeRef
        switch value {
        case .string(let s): cf = s as CFString
        case .number(let n): cf = n as CFNumber
        case .bool(let b): cf = b as CFBoolean
        default: cf = "\(value)" as CFString
        }
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, cf) == .success else {
            throw HelperException("action_failed", "Element does not accept AXValue.")
        }
    }

    private func openApp(_ spec: String) throws -> [String: JSONValue] {
        if let existing = try? AppResolver.resolve(spec) {
            NSRunningApplication(processIdentifier: existing.pid)?.activate()
            return ["pid": .number(Double(existing.pid))]
        }
        var url: URL?
        if spec.contains(".") {
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: spec)
        }
        if url == nil {
            url = NSWorkspace.shared.urlForApplication(toOpen: URL(fileURLWithPath: "/\(spec)"))
        }
        if url == nil {
            // Try "open -a <name>" as a fallback.
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            process.arguments = ["-a", spec]
            try? process.run()
            process.waitUntilExit()
        } else {
            let semaphore = DispatchSemaphore(value: 0)
            var launchedPid: pid_t = 0
            NSWorkspace.shared.openApplication(at: url!, configuration: NSWorkspace.OpenConfiguration()) { app, _ in
                launchedPid = app?.processIdentifier ?? 0
                semaphore.signal()
            }
            _ = semaphore.wait(timeout: .now() + 10)
            if launchedPid > 0 {
                return ["pid": .number(Double(launchedPid))]
            }
        }
        if let resolved = try? AppResolver.resolve(spec) {
            return ["pid": .number(Double(resolved.pid))]
        }
        throw HelperException("app_not_found", "Could not launch \"\(spec)\".")
    }
}
