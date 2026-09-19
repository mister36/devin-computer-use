import AppKit
import CoreGraphics
import Foundation

enum Screenshot {
    static let maxLongEdge: CGFloat = 1280

    static func accessibilityGranted() -> Bool {
        AXIsProcessTrusted()
    }

    static func screenRecordingGranted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    private static var requestedScreenRecording = false

    /// Prompts the system Screen Recording dialog once per launch. Returns
    /// whether access is currently granted.
    @discardableResult
    static func requestScreenRecording() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        if !requestedScreenRecording {
            requestedScreenRecording = true
            CGRequestScreenCaptureAccess()
        }
        return false
    }

    /// Prompts the system Accessibility dialog (which also registers the app
    /// in System Settings > Privacy & Security > Accessibility). Returns
    /// whether access is currently granted.
    static func requestAccessibility() -> Bool {
        if AXIsProcessTrusted() { return true }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Capture a window by CGWindowID, downscale the long edge to <= 1280 px,
    /// return PNG base64 plus dimensions and scale (png px per window point).
    static func captureWindow(_ windowId: CGWindowID, windowBounds: CGRect) -> [String: JSONValue]? {
        guard let image = CGWindowListCreateImage(
            .null,
            .optionIncludingWindow,
            windowId,
            [.boundsIgnoreFraming, .bestResolution]
        ) else { return nil }

        let width = image.width
        let height = image.height
        let longEdge = CGFloat(max(width, height))
        var scaled = image
        if longEdge > maxLongEdge {
            let factor = maxLongEdge / longEdge
            let newW = Int((CGFloat(width) * factor).rounded())
            let newH = Int((CGFloat(height) * factor).rounded())
            if let resized = resize(image, width: newW, height: newH) {
                scaled = resized
            }
        }

        let bitmap = NSBitmapImageRep(cgImage: scaled)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }

        let scale = windowBounds.width > 0
            ? Double(scaled.width) / Double(windowBounds.width)
            : 1
        return [
            "png": .string(png.base64EncodedString()),
            "width": .number(Double(scaled.width)),
            "height": .number(Double(scaled.height)),
            "scale": .number(scale),
        ]
    }

    private static func resize(_ image: CGImage, width: Int, height: Int) -> CGImage? {
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: image.bitsPerComponent,
            bytesPerRow: 0,
            space: image.colorSpace ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: image.bitmapInfo.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }
}
