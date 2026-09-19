import Foundation

// Locates external tools regardless of the Finder launch environment.
enum Toolchain {
    static func find(_ tool: String) -> String? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for dir in ["\(home)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"] {
            let path = "\(dir)/\(tool)"
            if FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
        }
        // Fall back to a login shell so nvm/volta/homebrew paths resolve.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", "command -v \(tool)"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let semaphore = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            process.waitUntilExit()
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + 5) == .timedOut {
            process.terminate()
            return nil
        }
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    static func devinSignedIn() -> Bool {
        guard let devin = find("devin") else { return false }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: devin)
        process.arguments = ["auth", "status"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return false
        }
        process.waitUntilExit()
        return process.terminationStatus == 0
    }

    /// Path to the MCP server bundled inside the .app.
    static var bundledServerPath: String? {
        if let dev = ProcessInfo.processInfo.environment["DEVIN_COMPUTER_USE_SERVER"],
           FileManager.default.fileExists(atPath: dev) {
            return dev
        }
        guard let path = Bundle.main.resourceURL?
            .appendingPathComponent("server/src/server.mjs").path,
              FileManager.default.fileExists(atPath: path)
        else { return nil }
        return path
    }
}
