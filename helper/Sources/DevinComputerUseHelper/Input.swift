import ApplicationServices
import CoreGraphics
import Foundation

// Synthetic input posted to the target pid so it works in the background
// without moving the user's cursor.
enum Input {
    // key name -> virtual keycode (kVK_* values)
    static let keycodes: [String: CGKeyCode] = [
        "return": 36, "enter": 36,
        "tab": 48,
        "escape": 53, "esc": 53,
        "space": 49,
        "delete": 51, "backspace": 51, "forwarddelete": 117,
        "up": 126, "down": 125, "left": 123, "right": 124,
        "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
        "j": 38, "k": 40, "n": 45, "m": 46,
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22,
        "7": 26, "8": 28, "9": 25,
    ]

    static func flags(for modifiers: [String]) -> CGEventFlags {
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: break
            }
        }
        return flags
    }

    static func post(_ event: CGEvent?, to pid: pid_t) {
        event?.postToPid(pid)
    }

    /// Click at a screen point. Prefer AXPress in the caller when available.
    static func click(pid: pid_t, point: CGPoint, button: String, count: Int) {
        let (downType, upType, cgButton): (CGEventType, CGEventType, CGMouseButton) =
            button == "right"
                ? (.rightMouseDown, .rightMouseUp, .right)
                : (.leftMouseDown, .leftMouseUp, .left)
        for click in 1...max(1, count) {
            let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: cgButton)
            down?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            post(down, to: pid)
            let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: cgButton)
            up?.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            post(up, to: pid)
        }
    }

    /// Press an AX element's press action when supported.
    static func press(_ element: AXUIElement) -> Bool {
        AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
    }

    static func typeText(pid: pid_t, text: String) {
        // keyboardSetUnicodeString is limited to 20 UTF-16 units per event.
        let utf16 = Array(text.utf16)
        var index = 0
        while index < utf16.count {
            let end = min(index + 20, utf16.count)
            let chunk = Array(utf16[index..<end])
            for keyDown in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown) else { continue }
                event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                post(event, to: pid)
            }
            index = end
        }
    }

    static func key(pid: pid_t, name: String, modifiers: [String]) throws {
        guard let code = keycodes[name.lowercased()] else {
            throw HelperException("bad_key", "Unknown key name \"\(name)\".")
        }
        let flags = self.flags(for: modifiers)
        for keyDown in [true, false] {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: keyDown) else { continue }
            event.flags = flags
            post(event, to: pid)
        }
    }

    static func scroll(pid: pid_t, point: CGPoint, dx: Double, dy: Double) {
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(dy),
            wheel2: Int32(dx),
            wheel3: 0
        ) else { return }
        event.location = point
        post(event, to: pid)
    }

    static func drag(pid: pid_t, from: CGPoint, to: CGPoint) {
        let steps = 12
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left), to: pid)
        for step in 1...steps {
            let t = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left), to: pid)
            usleep(8_000)
        }
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left), to: pid)
    }

    static func focus(_ element: AXUIElement) {
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }

    static func selectAll(pid: pid_t) {
        try? key(pid: pid, name: "a", modifiers: ["cmd"])
    }
}
