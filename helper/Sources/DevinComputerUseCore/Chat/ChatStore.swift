import AppKit
import Foundation

// Chat state: conversations, ACP session management, permission and
// app-approval cards. Everything runs on the main actor. Each transcript lives
// in its own TranscriptModel (loaded when the chat is opened); persistence is
// in ConversationArchive.

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
    private var sessions = ACPSessionTracker()

    private let archive = ConversationArchive(
        directory: Approval.shared.supportDir.appendingPathComponent("conversations", isDirectory: true))
    private var models: [String: TranscriptModel] = [:]

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
                self.sessions.reset()
                self.queued.removeAll()
                self.isRunning = false
                self.appendSystemNote("Devin CLI exited (code \(code)).")
            }
        }
    }

    // MARK: persistence

    private func loadConversations() {
        conversations = archive.loadIndex()
        selectedId = conversations.first?.id
    }

    /// The observable transcript for a chat. Opening a chat reads it from disk
    /// in the background so a long history never blocks the window.
    func transcriptModel(for id: String) -> TranscriptModel {
        if let model = models[id] { return model }
        let model = TranscriptModel(conversationId: id)
        models[id] = model
        let archive = archive
        Task.detached(priority: .userInitiated) {
            let record = archive.readRecord(id: id)
            await MainActor.run {
                model.load(record?.transcript ?? Transcript())
            }
        }
        return model
    }

    /// The transcript, read synchronously if it is about to be written to.
    private func loadedModel(_ id: String) -> TranscriptModel {
        let model = transcriptModel(for: id)
        if !model.isLoaded {
            let record = archive.pendingRecord(id: id) ?? archive.readRecord(id: id)
            model.load(record?.transcript ?? Transcript())
        }
        return model
    }

    private func persist(_ id: String) {
        guard let conversation = conversations.first(where: { $0.id == id }) else { return }
        archive.save(ConversationRecord(conversation: conversation, transcript: loadedModel(id).transcript))
    }

    /// Writes unsaved chats before the app quits.
    func flushToDisk() {
        archive.flush()
    }

    private func update(_ id: String, _ mutate: (inout Conversation) -> Void) {
        guard let index = conversations.firstIndex(where: { $0.id == id }) else { return }
        mutate(&conversations[index])
        archive.saveIndex(conversations)
        persist(id)
    }

    private func updateTranscript(_ id: String, _ mutate: (inout Transcript) -> Void) {
        guard conversations.contains(where: { $0.id == id }) else { return }
        loadedModel(id).mutate(mutate)
        persist(id)
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
        models[conversation.id] = TranscriptModel(conversationId: conversation.id, transcript: Transcript())
        selectedId = conversation.id
        archive.saveIndex(conversations)
        persist(conversation.id)
    }

    func delete(conversationId: String) {
        queued.removeAll { $0.conversationId == conversationId }
        conversations.removeAll { $0.id == conversationId }
        models.removeValue(forKey: conversationId)
        archive.delete(id: conversationId)
        archive.saveIndex(conversations)
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
            sessions.reset()
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
        if let existing, !sessions.needsLoad(existing) {
            return existing
        }
        if let existing, loadSessionSupported {
            sessions.beginLoad(existing)
            do {
                _ = try await acpRequest("session/load", .object([
                    "sessionId": .string(existing),
                    "cwd": .string(cwd),
                    "mcpServers": mcpServers,
                ]))
                sessions.finishLoad(existing, succeeded: true)
                return existing
            } catch let error as ACPError {
                sessions.finishLoad(existing, succeeded: false)
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
        sessions.markLive(sessionId)
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

        // The local transcript already holds what session/load replays.
        let kind = payload["sessionUpdate"]?.stringValue ?? ""
        guard sessions.accepts(update: kind, sessionId: sessionId) else { return }
        if kind == "session_info_update" {
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
