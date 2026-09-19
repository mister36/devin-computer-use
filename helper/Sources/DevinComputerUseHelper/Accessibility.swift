import AppKit
import ApplicationServices
import Foundation

// Accessibility tree reading, flattening and element caching.
// All functions must be called on the main thread.

// Private but long-stable HIServices symbol mapping an AXUIElement window to
// its CGWindowID; not exposed in the SDK headers.
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ windowId: UnsafeMutablePointer<CGWindowID>) -> AXError

enum AX {
    static let maxDepthDefault = 25
    static let maxNodesDefault = 600

    // Bundle id prefixes for apps that need AXEnhancedUserInterface to expose
    // web/Electron content.
    static let enhancedUIBundlePrefixes = [
        "com.google.Chrome",
        "org.chromium",
        "com.microsoft.VSCode",
        "com.tinyspeck.slackmacgap",
        "com.brave.Browser",
        "com.electron.",
        "dev.zen.", // Zen browser; harmless if absent
    ]

    // Role normalisation: AX role -> compact role name.
    static func normaliseRole(_ raw: String?) -> String {
        switch raw {
        case "AXButton", "AXRadioButton", "AXCheckBox", "AXPopUpButton", "AXTab", "AXMenuButton": return "button"
        case "AXStaticText": return "text"
        case "AXTextField", "AXSearchField", "AXComboBox": return "textfield"
        case "AXTextArea": return "textarea"
        case "AXLink": return "link"
        case "AXMenu", "AXMenuBar": return "menu"
        case "AXMenuItem", "AXMenuBarItem": return "menuitem"
        case "AXWindow", "AXSheet", "AXDrawer": return "window"
        case "AXToolbar": return "toolbar"
        case "AXTabGroup": return "tabgroup"
        case "AXList", "AXOutline", "AXTable": return "list"
        case "AXRow", "AXCell": return "row"
        case "AXScrollArea", "AXScrollBar": return "scrollarea"
        case "AXSlider": return "slider"
        case "AXImage": return "image"
        case "AXWebArea": return "webarea"
        case "AXHeading": return "heading"
        case "AXGroup", "AXSplitGroup", "AXGenericElement": return "group"
        case "AXApplication": return "application"
        case "AXValueIndicator": return "indicator"
        case "AXProgressIndicator": return "progress"
        case "AXDisclosureTriangle": return "disclosure"
        case "AXColorWell": return "colorwell"
        case "AXIncrementor", "AXStepper": return "stepper"
        case "AXSwitch": return "switch"
        default:
            guard let raw else { return "element" }
            return raw.hasPrefix("AX") ? String(raw.dropFirst(2)).lowercased() : raw.lowercased()
        }
    }

    static func isCollapsible(role: String, label: String?, value: String?) -> Bool {
        // Purely structural nodes with no label/value are collapsed; children
        // are promoted.
        (role == "group") && (label?.isEmpty ?? true) && (value?.isEmpty ?? true)
    }
}

struct FlatElement {
    let id: Int
    let role: String
    let label: String?
    let value: String?
    let bounds: [Double]
    let depth: Int
    let focused: Bool
    let enabled: Bool
    let actions: [String]
    let axElement: AXUIElement

    var json: [String: JSONValue] {
        var out: [String: JSONValue] = [
            "id": .number(Double(id)),
            "role": .string(role),
            "depth": .number(Double(depth)),
            "focused": .bool(focused),
            "enabled": .bool(enabled),
            "bounds": .array(bounds.map { .number($0) }),
            "actions": .array(actions.map { .string($0) }),
        ]
        out["label"] = label.map { .string($0) } ?? .null
        out["value"] = value.map { .string($0) } ?? .null
        return out
    }
}

final class ElementCache {
    // pid -> elements of the last observation, keyed by id.
    private var cache: [pid_t: [Int: AXUIElement]] = [:]

    func store(pid: pid_t, elements: [FlatElement]) {
        var map: [Int: AXUIElement] = [:]
        for el in elements {
            map[el.id] = el.axElement
        }
        cache[pid] = map
    }

    func element(pid: pid_t, id: Int) -> AXUIElement? {
        cache[pid]?[id]
    }
}

struct ResolvedApp {
    let pid: pid_t
    let name: String
    let bundleId: String?
    let element: AXUIElement
}

enum AppResolver {
    /// Resolve `app`: numeric -> pid, contains "." -> bundle id, else
    /// case-insensitive localizedName among running apps with windows.
    static func resolve(_ spec: String) throws -> ResolvedApp {
        let running = NSWorkspace.shared.runningApplications.filter {
            $0.activationPolicy != .prohibited
        }

        if let pid = Int32(spec) {
            guard let app = NSRunningApplication(processIdentifier: pid) else {
                throw HelperException("app_not_found", "No process with pid \(spec).")
            }
            return try makeResolved(app)
        }

        if spec.contains(".") {
            if let app = running.first(where: {
                $0.bundleIdentifier?.caseInsensitiveCompare(spec) == .orderedSame
            }) {
                return try makeResolved(app)
            }
            throw HelperException("app_not_found", "No running app with bundle id \(spec).")
        }

        let matches = running.filter {
            $0.localizedName?.caseInsensitiveCompare(spec) == .orderedSame
                || $0.localizedName?.range(of: spec, options: .caseInsensitive) != nil
        }
        for app in matches {
            if let resolved = try? makeResolved(app), hasWindow(pid: resolved.pid) {
                return resolved
            }
        }
        if let app = matches.first {
            return try makeResolved(app)
        }
        throw HelperException("app_not_found", "No running app matching \"\(spec)\".")
    }

    private static func makeResolved(_ app: NSRunningApplication) throws -> ResolvedApp {
        guard app.processIdentifier > 0 else {
            throw HelperException("app_not_found", "App has no pid.")
        }
        let resolved = ResolvedApp(
            pid: app.processIdentifier,
            name: app.localizedName ?? "app",
            bundleId: app.bundleIdentifier,
            element: AXUIElementCreateApplication(app.processIdentifier)
        )
        // Chromium/Electron: enable enhanced UI so web content is exposed.
        if let bundleId = app.bundleIdentifier,
           AX.enhancedUIBundlePrefixes.contains(where: { bundleId.hasPrefix($0) }) {
            enableEnhancedUI(resolved.element)
        }
        return resolved
    }

    static func enableEnhancedUI(_ appElement: AXUIElement) {
        AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    static func hasWindow(pid: pid_t) -> Bool {
        let appElement = AXUIElementCreateApplication(pid)
        var value: AnyObject?
        let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value)
        if result == .success, let windows = value as? [AXUIElement] {
            return !windows.isEmpty
        }
        return false
    }
}

final class TreeReader {
    let cache = ElementCache()

    /// Flatten the AX tree of `app`'s frontmost (or requested) window into
    /// FlatElements with window-relative bounds. Returns elements plus the
    /// window info and a truncated flag.
    func flatten(app: ResolvedApp, windowId: CGWindowID?, maxNodes: Int, maxDepth: Int)
        -> (window: AXUIElement, windowInfo: (id: CGWindowID, title: String, bounds: CGRect), elements: [FlatElement], truncated: Bool)
    {
        let window: AXUIElement
        if let windowId {
            window = findWindow(app: app, cgWindowId: windowId) ?? frontWindow(app: app)
        } else {
            window = frontWindow(app: app)
        }
        let info = windowInfo(app: app, window: window)
        let windowOrigin = info.bounds.origin

        // If the app exposes a web area anywhere, make sure enhanced UI is on.
        var elements: [FlatElement] = []
        var truncated = false
        var nextId = 1

        func emit(_ element: AXUIElement, depth: Int) {
            if elements.count >= maxNodes {
                truncated = true
                return
            }
            let role = AX.normaliseRole(stringAttr(element, kAXRoleAttribute))
            let label = labelFor(element)
            let value = valueFor(element)
            let frame = frameFor(element, windowOrigin: windowOrigin)
            let actions = actionNames(element)
            let focused = boolAttr(element, kAXFocusedAttribute)
            let enabled = !boolAttr(element, "AXDisabled")
            elements.append(FlatElement(
                id: nextId, role: role, label: label, value: value,
                bounds: [Double(frame.origin.x), Double(frame.origin.y),
                         Double(frame.size.width), Double(frame.size.height)],
                depth: depth, focused: focused, enabled: enabled,
                actions: actions, axElement: element
            ))
            nextId += 1
        }

        func walk(_ element: AXUIElement, depth: Int) {
            if depth > maxDepth || elements.count >= maxNodes {
                if elements.count >= maxNodes { truncated = true }
                return
            }
            let role = AX.normaliseRole(stringAttr(element, kAXRoleAttribute))
            let label = labelFor(element)
            let value = valueFor(element)
            let collapse = AX.isCollapsible(role: role, label: label, value: value)
            if !collapse {
                emit(element, depth: depth)
            }
            let childDepth = collapse ? depth : depth + 1
            for child in children(element) {
                walk(child, depth: childDepth)
            }
        }

        // Emit the window itself as a node, then walk children.
        emit(window, depth: 0)
        for child in children(window) {
            walk(child, depth: 1)
        }

        cache.store(pid: app.pid, elements: elements)
        return (window, info, elements, truncated)
    }

    private func frontWindow(app: ResolvedApp) -> AXUIElement {
        var value: AnyObject?
        if AXUIElementCopyAttributeValue(app.element, kAXFocusedWindowAttribute as CFString, &value) == .success,
           let focused = value {
            return (focused as! AXUIElement)
        }
        if AXUIElementCopyAttributeValue(app.element, kAXWindowsAttribute as CFString, &value) == .success,
           let windows = value as? [AXUIElement], let first = windows.first {
            return first
        }
        return app.element
    }

    private func findWindow(app: ResolvedApp, cgWindowId: CGWindowID) -> AXUIElement? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(app.element, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        for window in windows {
            var id: CGWindowID = 0
            if _AXUIElementGetWindow(window, &id) == .success, id == cgWindowId {
                return window
            }
        }
        return nil
    }

    private func windowInfo(app: ResolvedApp, window: AXUIElement) -> (id: CGWindowID, title: String, bounds: CGRect) {
        var id: CGWindowID = 0
        _ = _AXUIElementGetWindow(window, &id)
        let title = stringAttr(window, kAXTitleAttribute) ?? ""
        var origin = CGPoint.zero
        var size = CGSize.zero
        var posValue: AnyObject?
        if AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posValue) == .success {
            AXValueGetValue((posValue as! AXValue), .cgPoint, &origin)
        }
        var sizeValue: AnyObject?
        if AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeValue) == .success {
            AXValueGetValue((sizeValue as! AXValue), .cgSize, &size)
        }
        return (id, title, CGRect(origin: origin, size: size))
    }

    // MARK: attribute helpers

    private func stringAttr(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func boolAttr(_ element: AXUIElement, _ attribute: String) -> Bool {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return false }
        return (value as? NSNumber)?.boolValue ?? false
    }

    private func children(_ element: AXUIElement) -> [AXUIElement] {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

    private func labelFor(_ element: AXUIElement) -> String? {
        for attr in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue"] {
            if let s = stringAttr(element, attr), !s.isEmpty { return s }
        }
        return nil
    }

    private func valueFor(_ element: AXUIElement) -> String? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success else { return nil }
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n.stringValue }
        return nil
    }

    private func frameFor(_ element: AXUIElement, windowOrigin: CGPoint) -> CGRect {
        var origin = CGPoint.zero
        var size = CGSize.zero
        var posValue: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success {
            AXValueGetValue((posValue as! AXValue), .cgPoint, &origin)
        }
        var sizeValue: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success {
            AXValueGetValue((sizeValue as! AXValue), .cgSize, &size)
        }
        // convert to window-relative points
        return CGRect(origin: CGPoint(x: origin.x - windowOrigin.x, y: origin.y - windowOrigin.y), size: size)
    }

    private func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
        return (names as? [String])?.map {
            $0.hasPrefix("AX") ? String($0.dropFirst(2)).lowercased() : $0.lowercased()
        } ?? []
    }

    /// Element centre in *screen* points, for CGEvent posting.
    func screenPoint(for element: AXUIElement) -> CGPoint? {
        var posValue: AnyObject?
        var sizeValue: AnyObject?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posValue) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        AXValueGetValue((posValue as! AXValue), .cgPoint, &origin)
        AXValueGetValue((sizeValue as! AXValue), .cgSize, &size)
        return CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
    }

    func windowOrigin(_ window: AXUIElement) -> CGPoint {
        var posValue: AnyObject?
        var origin = CGPoint.zero
        if AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posValue) == .success {
            AXValueGetValue((posValue as! AXValue), .cgPoint, &origin)
        }
        return origin
    }
}
