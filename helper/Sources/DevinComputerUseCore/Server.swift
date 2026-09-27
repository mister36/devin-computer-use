import AppKit
import Darwin
import Foundation

// Unix-domain-socket JSONL server. Reads requests on a background thread and
// dispatches AX/CGEvent work on the main thread.
final class SocketServer {
    let socketPath: String
    private var listenFd: Int32 = -1
    private var running = false

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    func start() throws {
        try FileManager.default.createDirectory(
            atPath: (socketPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        unlink(socketPath)

        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFd >= 0 else {
            throw HelperException("socket_error", "socket() failed: \(errno)")
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count <= maxLen else {
            throw HelperException("socket_error", "socket path too long")
        }
        _ = withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: maxLen) { dest in
                pathBytes.withUnsafeBytes { src in
                    memcpy(dest, src.baseAddress!, min(pathBytes.count, maxLen))
                }
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                bind(listenFd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            throw HelperException("socket_error", "bind(\(socketPath)) failed: \(errno)")
        }
        chmod(socketPath, 0o600)
        guard listen(listenFd, 4) == 0 else {
            throw HelperException("socket_error", "listen() failed: \(errno)")
        }

        running = true
        Thread.detachNewThread { [weak self] in self?.acceptLoop() }
    }

    func stop() {
        running = false
        if listenFd >= 0 { close(listenFd) }
        unlink(socketPath)
    }

    private func acceptLoop() {
        while running {
            let client = accept(listenFd, nil, nil)
            if client < 0 {
                if running { usleep(50_000) }
                continue
            }
            Thread.detachNewThread { [weak self] in self?.serve(client) }
        }
    }

    private func serve(_ fd: Int32) {
        defer { close(fd) }
        var pending = Data()
        var buffer = [UInt8](repeating: 0, count: 65_536)
        while running {
            let count = recv(fd, &buffer, buffer.count, 0)
            if count <= 0 { break }
            pending.append(contentsOf: buffer[0..<count])
            while let newline = pending.firstIndex(of: UInt8(ascii: "\n")) {
                let line = pending[pending.startIndex..<newline]
                pending.removeSubrange(pending.startIndex...newline)
                guard !line.isEmpty else { continue }
                handleLine(Data(line), fd: fd)
            }
        }
    }

    private func handleLine(_ line: Data, fd: Int32) {
        var response: HelperResponse
        do {
            let request = try JSONDecoder().decode(HelperRequest.self, from: line)
            // Approval runs on the socket thread first: the chat-window card
            // path blocks on a semaphore, which would deadlock on main.
            if let failure = RequestHandler.shared.preflight(request) {
                response = failure
            } else {
                response = DispatchQueue.main.sync {
                    RequestHandler.shared.handle(request)
                }
            }
        } catch {
            response = HelperResponse.failure(id: 0, code: "bad_request", message: "Invalid request: \(error)")
        }
        if let data = try? JSONEncoder().encode(response) {
            var out = data
            out.append(UInt8(ascii: "\n"))
            out.withUnsafeBytes { bytes in
                _ = send(fd, bytes.baseAddress!, bytes.count, 0)
            }
        }
    }
}
