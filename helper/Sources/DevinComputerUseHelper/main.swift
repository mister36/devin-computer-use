import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // LSUIElement menu-bar app

let delegate = AppDelegate()
app.delegate = delegate

app.run()
