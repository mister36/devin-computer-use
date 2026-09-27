import AppKit
import Foundation

// Chat state: conversations, ACP session management, permission and
// app-approval cards. Everything runs on the main actor. The transcript itself
// lives in Transcript.swift.

@MainActor
final class ChatStore: ObservableObject {
    static let shared = ChatStore()

    @Published var conversations: [Conversation] = []
    @Published var selectedId: String?
    @Published var isRunning = false
    @Published var approveForMe: Bool {
        didSet { UserDefaults.standard.set(approveForMe, forKey: "approveForMe") }
    }
    @Published var onboardingDone = false

    // Pending session/request_permission calls: cardId -> ACP id.
    private var pendingPermissions: [String: (acpId: JSONValue, conversationId: String)] = [:]
    // Pending app-approval cards: cardId -> semaphore waiter.
    private var pendingAppApprovals: [String: (Approval.Decision) -> Void] = [:]
    private var cardCounter = 0

    /// Prompts wait their turn: the agent handles one prompt per session at a
    /// time, and overlapping sends used to interleave their streamed output.
    private var queued: [(conversationId: String, text: String)] = []
    private var pumping = false
    private var cancelledConversations: Set<String> = []

    private let acp = ACPClient(supportDir: Approval.shared.supportDir)
    private var acpReady = false
    private var loadSessionSupported = false
    private var starting = false

    private var conversationsDir: URL {
        Approval.shared.supportDir.appendingPathComponent("conversations", isDirectory: true)
    }

    var selected: Conversation? {
        conversations.first { $0.id == selectedId }
    }

    /// True when the chat window is up and can host inline approval cards.
    var canPresentApproval: Bool {
        NSApp.windows.contains { $0.isVisible && $0.canBecomeMain } && selectedId != nil
    }

    private init() {
        approveForMe = UserDefaults.standard.bool(forKey: "approveForMe")
        loadConversations()
        acp.onNotification = { [weak self] method, params in
            guard method == "session/update" else { return }
            MainActor.assumeIsolated {
                self?.handleSessionUpdate(params)
            }
        }
        acp.onRequest = { [weak self] id, method, params in
            MainActor.assumeIsolated {
                self?.handlePermissionRequest(acpId: id, params: params)
            }
        }
        acp.onExit = { [weak self] code in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.acpReady = false
                self.queued.removeAll()
                self.isRunning = false
                self.appendSystemNote("Devin CLI exited (code \(code)).")
            }
        }
    }

    // MARK: persistence

    private func loadConversations() {
        try? FileManager.default.createDirectory(at: conversationsDir, withIntermediateDirectories: true)
        let files = (try? FileManager.default.contentsOfDirectory(
            at: conversationsDir, includingPropertiesForKeys: nil)) ?? []
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        conversations = files
            .filter { $0.pathExtension == "json" }
            .compactMap { try? decoder.decode(Conversation.self, from: Data(contentsOf: $0)) }
            .sorted { $0.createdAt > $1.createdAt }
        selectedId = conversations.first?.id
    }

    private func persist(_ conversation: Conversation) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted]
        if let data = try? encoder.encode(conversation) {
            try? data.write(to: conversationsDir.appendingPathComponent("\(conversation.id).json"),
                            options: .atomic)
        }
    }

    private func update(_ id: String, _ mutate: (inout Conversation) -> Void) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        mutate(&conversations[index])
        persist(conversations[index])
    }

    private func updateTranscript(_ id: String, _ mutate: (inout Transcript) -> Void) {
        update(id) { mutate(&$0.transcript) }
    }

    // MARK: actions

    func newConversation() {
        let conversation = Conversation(
            id: UUID().uuidString,
            title: "New chat",
            createdAt: Date(),
            acpSessionId: nil
        )
        conversations.insert(conversation, at: 0)
        selectedId = conversation.id
        persist(conversation)
    }

    func delete(conversationId: String) {
        queued.removeAll { $0.conversationId == conversationId }
        conversations.removeAll { $0.id == conversationId }
        try? FileManager.default.removeItem(
            at: conversationsDir.appendingPathComponent("\(conversationId).json"))
        if selectedId == conversationId { selectedId = conversations.first?.id }
    }

    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if selectedId == nil || selected == nil {
            newConversation()
        }
        guard let conversationId = selectedId else { return }

        updateTranscript(conversationId) { $0.appendUserMessage(trimmed) }
        if selected?.title == "New chat" {
            update(conversationId) { $0.title = String(trimmed.prefix(60)) }
        }
        cancelledConversations.remove(conversationId)
        queued.append((conversationId, trimmed))
        isRunning = true
        pump()
    }

    /// Runs queued prompts one at a time so streamed output stays ordered.
    private func pump() {
        guard !pumping else { return }
        pumping = true
        Task {
            defer {
                pumping = false
                isRunning = false
            }
            while !queued.isEmpty {
                let next = queued.removeFirst()
                guard conversations.contains(where: { $0.id == next.conversationId }),
                      !cancelledConversations.contains(next.conversationId)
                else { continue }
                isRunning = true
                do {
                    try await ensureStarted()
                    let sessionId = try await ensureSession(conversationId: next.conversationId)
                    try await prompt(sessionId: sessionId, text: next.text)
                } catch let error as ACPError {
                    appendSystemNote("Devin CLI error: \(error.message)", to: next.conversationId)
                } catch {
                    appendSystemNote("Error: \(error.localizedDescription)", to: next.conversationId)
                }
                updateTranscript(next.conversationId) { $0.endTurn() }
            }
        }
    }

    func stop() {
        guard let conversationId = selectedId else { return }
        cancelledConversations.insert(conversationId)
        queued.removeAll { $0.conversationId == conversationId }
        if let sessionId = conversations.first(where: { $0.id == conversationId })?.acpSessionId {
            acp.notify("session/cancel", .object(["sessionId": .string(sessionId)]))
        }
        // Answer pending permission prompts as cancelled.
        for (cardId, pending) in pendingPermissions where pending.conversationId == conversationId {
            acp.respond(id: pending.acpId, result: .object([
                "outcome": .object(["outcome": .string("cancelled")]),
            ]))
            updateTranscript(conversationId) {
                $0.setPermissionDecision(cardId: cardId, decision: "cancelled")
            }
            pendingPermissions.removeValue(forKey: cardId)
        }
        updateTranscript(conversationId) { $0.endTurn() }
        isRunning = false
    }

    // MARK: ACP plumbing

    private func ensureStarted() async throws {
        if acpReady { return }
        if starting {
            // Another send is already starting; wait for it.
            while starting { try await Task.sleep(nanoseconds: 50_000_000) }
            if acpReady { return }
        }
        starting = true
        defer { starting = false }

        guard let devinPath = Toolchain.find("devin") else {
            throw HelperException("devin_missing",
                                  "Devin CLI is not installed. Install it from onboarding.")
        }
        if !acp.isRunning {
            try acp.start(devinPath: devinPath)
        }
        let result = try await acpRequest("initialize", .object([
            "protocolVersion": .number(1),
            "clientCapabilities": .object([
                "fs": .object([
                    "readTextFile": .bool(false),
                    "writeTextFile": .bool(false),
                ]),
                "terminal": .bool(false),
            ]),
        ]))
        loadSessionSupported = result.objectValue?["agentCapabilities"]?
            .objectValue?["loadSession"]?.boolValue ?? false
        acpReady = true
    }

    private func ensureSession(conversationId: String) async throws -> String {
        guard let node = Toolchain.find("node") else {
            throw HelperException("node_missing", "Node.js is not installed.")
        }
        guard let server = Toolchain.bundledServerPath else {
            throw HelperException("server_missing",
                                  "Bundled MCP server not found in the app bundle.")
        }
        let mcpServers = JSONValue.array([.object([
            "name": .string("computer-use"),
            "command": .string(node),
            "args": .array([.string(server)]),
            "env": .array([]),
        ])])
        let cwd = FileManager.default.homeDirectoryForCurrentUser.path

        let existing = conversations.first { $0.id == conversationId }?.acpSessionId
        if let existing, loadSessionSupported {
            do {
                _ = try await acpRequest("session/load", .object([
                    "sessionId": .string(existing),
                    "cwd": .string(cwd),
                    "mcpServers": mcpServers,
                ]))
                return existing
            } catch let error as ACPError {
                // The CLI answers -32016 "Session not found" for sessions it no
                // longer has; start a fresh one and keep the local transcript.
                appendSystemNote("Previous Devin session unavailable (\(error.message)); starting a new one.",
                                 to: conversationId)
            }
        }

        let result = try await acpRequest("session/new", .object([
            "cwd": .string(cwd),
            "mcpServers": mcpServers,
        ]))
        guard let sessionId = result.objectValue?["sessionId"]?.stringValue else {
            throw HelperException("acp_error", "session/new did not return a sessionId.")
        }
        update(conversationId) { $0.acpSessionId = sessionId }
        return sessionId
    }

    private func prompt(sessionId: String, text: String) async throws {
        _ = try await acpRequest("session/prompt", .object([
            "sessionId": .string(sessionId),
            "prompt": .array([.object([
                "type": .string("text"),
                "text": .string(text),
            ])]),
        ]))
    }

    private func acpRequest(_ method: String, _ params: JSONValue) async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation in
            acp.request(method, params) { result in
                continuation.resume(with: result)
            }
        }
    }

    // MARK: session/update notifications

    private func handleSessionUpdate(_ params: JSONValue) {
        guard let payload = params.objectValue?["update"]?.objectValue,
              let sessionId = params.objectValue?["sessionId"]?.stringValue,
              let conversationId = conversations.first(where: { $0.acpSessionId == sessionId })?.id
        else { return }

        if payload["sessionUpdate"]?.stringValue == "session_info_update" {
            if let title = payload["title"]?.stringValue, !title.isEmpty {
                update(conversationId) { $0.title = title }
            }
            return
        }
        updateTranscript(conversationId) { $0.apply(update: payload) }
    }

    // MARK: permission requests (session/request_permission)

    private func handlePermissionRequest(acpId: JSONValue, params: JSONValue) {
        let object = params.objectValue ?? [:]
        let toolCall = object["toolCall"]?.objectValue ?? [:]
        let title = toolCall["title"]?.stringValue ?? "Permission required"
        let options = (object["options"]?.arrayValue ?? []).map { option -> PermissionOption in
            let o = option.objectValue
            return PermissionOption(optionId: o?["optionId"]?.stringValue ?? "",
                                    name: o?["name"]?.stringValue ?? "Allow",
                                    kind: o?["kind"]?.stringValue ?? "")
        }
        // Route to the conversation owning this session, else the selected one.
        let sessionId = object["sessionId"]?.stringValue
        let conversationId = conversations.first(where: { $0.acpSessionId == sessionId })?.id
            ?? selectedId ?? {
                newConversation()
                return selectedId!
            }()

        cardCounter += 1
        let cardId = "perm-\(cardCounter)"

        if approveForMe {
            // Auto-pick first allow_always, else first allow_once.
            let pick = options.first { $0.kind == "allow_always" }
                ?? options.first { $0.kind == "allow_once" }
                ?? options.first
            acp.respond(id: acpId, result: .object([
                "outcome": .object([
                    "outcome": .string("selected"),
                    "optionId": .string(pick?.optionId ?? ""),
                ]),
            ]))
            append(.permissionRequest(id: cardId, title: title, options: options,
                                      decision: pick?.name ?? "allowed"),
                   to: conversationId)
            return
        }

        pendingPermissions[cardId] = (acpId, conversationId)
        append(.permissionRequest(id: cardId, title: title, options: options, decision: nil),
               to: conversationId)
    }

    /// Called by PermissionCard buttons.
    func answerPermission(cardId: String, optionId: String, name: String) {
        guard let pending = pendingPermissions.removeValue(forKey: cardId) else { return }
        acp.respond(id: pending.acpId, result: .object([
            "outcome": .object([
                "outcome": .string("selected"),
                "optionId": .string(optionId),
            ]),
        ]))
        updateTranscript(pending.conversationId) {
            $0.setPermissionDecision(cardId: cardId, decision: name)
        }
    }

    // MARK: app approval cards (helper per-app gate)

    /// Called on the main actor from Approval's card presenter. The socket
    /// thread is blocked on a semaphore until the completion runs.
    func requestAppApproval(appName: String, completion: @escaping (Approval.Decision) -> Void) {
        let conversationId = selectedId ?? {
            newConversation()
            return selectedId!
        }()
        cardCounter += 1
        let cardId = "app-\(cardCounter)"
        pendingAppApprovals[cardId] = completion
        append(.appApproval(id: cardId, appName: appName, decision: nil), to: conversationId)
    }

    /// Called by AppApprovalCard buttons.
    func answerAppApproval(cardId: String, decision: Approval.Decision) {
        guard let completion = pendingAppApprovals.removeValue(forKey: cardId) else { return }
        if let conversationId = selectedId {
            updateTranscript(conversationId) {
                $0.setAppApprovalDecision(cardId: cardId, decision: "\(decision)")
            }
        }
        completion(decision)
    }

    // MARK: helpers

    private func append(_ item: TranscriptItem, to conversationId: String) {
        updateTranscript(conversationId) { $0.append(item) }
    }

    private func appendSystemNote(_ text: String, to conversationId: String? = nil) {
        if let conversationId {
            append(.systemNote(text: text), to: conversationId)
        } else if let selectedId {
            append(.systemNote(text: text), to: selectedId)
        }
    }
}
