import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.regular) // dock icon + menu-bar status item

let delegate = AppDelegate()
app.delegate = delegate

app.run()
