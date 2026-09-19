import Foundation

// JSON-RPC 2.0 (newline-delimited) client for `devin acp` (Agent Client
// Protocol). Spawns the process, frames messages by newline, dispatches
// agent->client requests/notifications to callbacks.
struct ACPError: Error {
    let code: Int
    let message: String

    init(_ code: Int, _ message: String) {
        self.code = code
        self.message = message
    }
}

struct ACPMessage: Codable {
    var id: JSONValue?
    var method: String?
    var params: JSONValue?
    var result: JSONValue?
    var error: JSONValue?
}

final class ACPClient {
    var onNotification: ((String, JSONValue) -> Void)?
    var onRequest: ((JSONValue, String, JSONValue) -> Void)?
    var onExit: ((Int32) -> Void)?

    private var process: Process?
    private var stdin: FileHandle?
    private var nextId = 1
    private var pending: [String: (Result<JSONValue, ACPError>) -> Void] = [:]
    private var readBuffer = Data()
    private let writeLock = NSLock()
    private let pendingLock = NSLock()
    private let stderrLog: URL

    init(supportDir: URL) {
        stderrLog = supportDir.appendingPathComponent("acp-stderr.log")
    }

    func start(devinPath: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: devinPath)
        process.arguments = ["acp"]

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = errPipe

        process.terminationHandler = { [weak self] proc in
            self?.failPending(ACPError(-32000, "devin acp exited with code \(proc.terminationStatus)"))
            DispatchQueue.main.async {
                self?.onExit?(proc.terminationStatus)
            }
        }

        self.process = process
        self.stdin = inPipe.fileHandleForWriting
        try process.run()

        Thread.detachNewThread { [weak self] in self?.readLoop(outPipe.fileHandleForReading) }
        Thread.detachNewThread { [weak self] in self?.stderrLoop(errPipe.fileHandleForReading) }
    }

    var isRunning: Bool {
        process?.isRunning ?? false
    }

    func stop() {
        process?.terminate()
    }

    private func failPending(_ error: ACPError) {
        pendingLock.lock()
        let completions = pending
        pending.removeAll()
        pendingLock.unlock()
        for completion in completions.values {
            completion(.failure(error))
        }
    }

    private func stderrLoop(_ handle: FileHandle) {
        FileManager.default.createFile(atPath: stderrLog.path, contents: nil)
        let log = try? FileHandle(forWritingTo: stderrLog)
        while true {
            let data = handle.availableData
            if data.isEmpty { break }
            try? log?.write(contentsOf: data)
        }
    }

    private func readLoop(_ handle: FileHandle) {
        while true {
            // availableData returns as soon as any bytes arrive; read(upToCount:)
            // on a pipe blocks until the full count or EOF.
            let data = handle.availableData
            guard !data.isEmpty else { break }
            readBuffer.append(data)
            while let newline = readBuffer.firstIndex(of: UInt8(ascii: "\n")) {
                let line = readBuffer[readBuffer.startIndex..<newline]
                readBuffer.removeSubrange(readBuffer.startIndex...newline)
                if !line.isEmpty {
                    handleLine(Data(line))
                }
            }
        }
    }

    private func handleLine(_ line: Data) {
        guard let message = try? JSONDecoder().decode(ACPMessage.self, from: line) else {
            return
        }
        if let method = message.method, let id = message.id {
            // Agent -> client request.
            if method == "session/request_permission" {
                let params = message.params ?? .object([:])
                DispatchQueue.main.async {
                    self.onRequest?(id, method, params)
                }
            } else {
                // fs/terminal capabilities are declared unsupported.
                respondError(id: id, code: -32601, message: "Method not supported: \(method)")
            }
        } else if let method = message.method {
            let params = message.params ?? .object([:])
            DispatchQueue.main.async {
                self.onNotification?(method, params)
            }
        } else if let id = message.id {
            let key = idKey(id)
            pendingLock.lock()
            let completion = pending.removeValue(forKey: key)
            pendingLock.unlock()
            if let completion {
                if let error = message.error {
                    let code = error.objectValue?["code"]?.intValue ?? -32000
                    let text = error.objectValue?["message"]?.stringValue ?? "JSON-RPC error"
                    completion(.failure(ACPError(code, text)))
                } else {
                    completion(.success(message.result ?? .null))
                }
            }
        }
    }

    private func idKey(_ id: JSONValue) -> String {
        switch id {
        case .number(let n): return "n:\(n)"
        case .string(let s): return "s:\(s)"
        default: return "?"
        }
    }

    private func write(_ dict: [String: JSONValue]) {
        guard let stdin else { return }
        writeLock.lock()
        defer { writeLock.unlock() }
        var object = dict
        object["jsonrpc"] = .string("2.0")
        guard let data = try? JSONEncoder().encode(JSONValue.object(object)) else { return }
        var framed = data
        framed.append(UInt8(ascii: "\n"))
        try? stdin.write(contentsOf: framed)
    }

    func request(_ method: String, _ params: JSONValue, completion: @escaping (Result<JSONValue, ACPError>) -> Void) {
        guard isRunning else {
            completion(.failure(ACPError(-32000, "devin acp is not running")))
            return
        }
        pendingLock.lock()
        let id = nextId
        nextId += 1
        pending["n:\(Double(id))"] = completion
        pendingLock.unlock()
        write([
            "id": .number(Double(id)),
            "method": .string(method),
            "params": params,
        ])
    }

    func notify(_ method: String, _ params: JSONValue) {
        write([
            "method": .string(method),
            "params": params,
        ])
    }

    func respond(id: JSONValue, result: JSONValue) {
        write(["id": id, "result": result])
    }

    func respond(id: JSONValue, error: ACPError) {
        respondError(id: id, code: error.code, message: error.message)
    }

    func respondError(id: JSONValue, code: Int, message: String) {
        write([
            "id": id,
            "error": .object([
                "code": .number(Double(code)),
                "message": .string(message),
            ]),
        ])
    }
}
