import SwiftUI

// Root: onboarding until every toolchain check passes, then the chat UI.
struct RootView: View {
    @StateObject private var store = ChatStore.shared
    @State private var bypassOnboarding = false

    var body: some View {
        Group {
            if store.onboardingDone || bypassOnboarding {
                ChatView()
            } else {
                OnboardingView(continueAnyway: { bypassOnboarding = true })
            }
        }
    }
}

struct OnboardingView: View {
    var continueAnyway: () -> Void

    @StateObject private var checks = OnboardingChecks()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Welcome to Devin Computer Use")
                .font(.title2).bold()
            Text("Devin can see and control apps on this Mac once these are set up.")
                .foregroundStyle(.secondary)

            ForEach(checks.rows) { row in
                HStack(spacing: 10) {
                    Image(systemName: row.ok ? "checkmark.circle.fill" : "xmark.circle")
                        .foregroundStyle(row.ok ? .green : .orange)
                        .frame(width: 20)
                    Text(row.title)
                    Spacer()
                    if !row.ok, let fix = row.fix {
                        Button(fix, action: row.action)
                    }
                }
            }

            if checks.installing {
                ScrollView {
                    Text(checks.installOutput)
                        .font(.system(.caption, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 120)
                .padding(6)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }

            HStack {
                Button("Re-check") { checks.recheck() }
                Spacer()
                Button("Continue anyway", action: continueAnyway)
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { checks.recheck() }
        .onChange(of: checks.allPass) { pass in
            if pass { ChatStore.shared.onboardingDone = true }
        }
    }
}

struct CheckRow: Identifiable {
    let id = UUID()
    var title: String
    var ok: Bool
    var fix: String?
    var action: () -> Void = {}
}

@MainActor
final class OnboardingChecks: ObservableObject {
    @Published var rows: [CheckRow] = []
    @Published var installing = false
    @Published var installOutput = ""
    @Published var allPass = false

    func recheck() {
        let installAction = { [weak self] in self?.installDevinCLI() }
        let signInAction = { Self.openDevinLogin() }
        Task {
            let devin = Toolchain.find("devin") != nil
            let signedIn = devin && Toolchain.devinSignedIn()
            let node = Toolchain.find("node") != nil
            let accessibility = Screenshot.accessibilityGranted()
            let screen = Screenshot.screenRecordingGranted()
            rows = [
                CheckRow(title: "Devin CLI installed", ok: devin,
                         fix: devin ? nil : "Install Devin CLI", action: installAction),
                CheckRow(title: "Signed in to Devin", ok: signedIn,
                         fix: signedIn ? nil : "Sign in", action: signInAction),
                CheckRow(title: "Node.js installed", ok: node, fix: nil),
                CheckRow(title: "Accessibility permission", ok: accessibility,
                         fix: accessibility ? nil : "Open Settings",
                         action: { Self.open("Privacy_Accessibility") }),
                CheckRow(title: "Screen Recording permission", ok: screen,
                         fix: screen ? nil : "Open Settings",
                         action: { Self.open("Privacy_ScreenCapture") }),
            ]
            allPass = rows.allSatisfy { $0.ok }
        }
    }

    private func installDevinCLI() {
        installing = true
        installOutput = ""
        Thread.detachNewThread {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-lc", "curl -fsSL https://cli.devin.ai/install.sh | bash"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let text = String(decoding: handle.availableData, as: UTF8.self)
                if !text.isEmpty {
                    DispatchQueue.main.async { [weak self] in
                        self?.installOutput += text
                    }
                }
            }
            try? process.run()
            process.waitUntilExit()
            DispatchQueue.main.async { [weak self] in
                self?.installing = false
                self?.recheck()
            }
        }
    }

    // devin auth login needs a TTY: run it in Terminal.
    private static func openDevinLogin() {
        let script = FileManager.default.temporaryDirectory
            .appendingPathComponent("devin-login.command")
        try? "#!/bin/zsh\ndevin auth login\n".write(to: script, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        NSWorkspace.shared.open(script)
    }

    private static func open(_ pane: String) {
        NSWorkspace.shared.open(
            URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)")!)
    }
}
