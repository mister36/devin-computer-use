import AppKit
import Foundation

// Chat state: conversations, transcript items, ACP session management,
// permission and app-approval cards. Everything runs on the main actor.

enum ToolContent: Codable, Equatable {
    case text(String)
    case image(base64: String, mimeType: String)

    enum CodingKeys: String, CodingKey { case type, text, base64, mimeType }
    enum Kind: String, Codable { case text, image }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = (try? c.decode(Kind.self, forKey: .type)) ?? .text
        switch kind {
        case .image:
            self = .image(base64: try c.decode(String.self, forKey: .base64),
                          mimeType: (try? c.decode(String.self, forKey: .mimeType)) ?? "image/png")
        default:
            self = .text(try c.decode(String.self, forKey: .text))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let s):
            try c.encode("text", forKey: .type)
            try c.encode(s, forKey: .text)
        case .image(let b64, let mime):
            try c.encode("image", forKey: .type)
            try c.encode(b64, forKey: .base64)
            try c.encode(mime, forKey: .mimeType)
        }
    }
}

struct PermissionOption: Codable, Equatable {
    let optionId: String
    let name: String
    let kind: String
}

struct PlanEntry: Codable, Equatable {
    let content: String
    let status: String
}

enum TranscriptItem: Codable, Equatable {
    case userMessage(text: String)
    case assistantText(id: String, text: String)
    case thought(text: String)
    case toolCall(id: String, title: String, kind: String, status: String, content: [ToolContent])
    case plan(entries: [PlanEntry])
    case permissionRequest(id: String, title: String, options: [PermissionOption], decision: String?)
    case appApproval(id: String, appName: String, decision: String?)
    case systemNote(text: String)

    enum CodingKeys: String, CodingKey {
        case type, id, text, title, kind, status, content, entries, options, decision, appName
    }
    enum Kind: String, Codable {
        case userMessage, assistantText, thought, toolCall, plan, permissionRequest, appApproval, systemNote
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(Kind.self, forKey: .type) {
        case .userMessage:
            self = .userMessage(text: try c.decode(String.self, forKey: .text))
        case .assistantText:
            self = .assistantText(id: try c.decode(String.self, forKey: .id),
                                  text: try c.decode(String.self, forKey: .text))
        case .thought:
            self = .thought(text: try c.decode(String.self, forKey: .text))
        case .toolCall:
            self = .toolCall(id: try c.decode(String.self, forKey: .id),
                             title: try c.decode(String.self, forKey: .title),
                             kind: (try? c.decode(String.self, forKey: .kind)) ?? "other",
                             status: (try? c.decode(String.self, forKey: .status)) ?? "pending",
                             content: (try? c.decode([ToolContent].self, forKey: .content)) ?? [])
        case .plan:
            self = .plan(entries: try c.decode([PlanEntry].self, forKey: .entries))
        case .permissionRequest:
            self = .permissionRequest(id: try c.decode(String.self, forKey: .id),
                                      title: try c.decode(String.self, forKey: .title),
                                      options: try c.decode([PermissionOption].self, forKey: .options),
                                      decision: try? c.decode(String.self, forKey: .decision))
        case .appApproval:
            self = .appApproval(id: try c.decode(String.self, forKey: .id),
                                appName: try c.decode(String.self, forKey: .appName),
                                decision: try? c.decode(String.self, forKey: .decision))
        case .systemNote:
            self = .systemNote(text: try c.decode(String.self, forKey: .text))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .userMessage(let text):
            try c.encode("userMessage", forKey: .type)
            try c.encode(text, forKey: .text)
        case .assistantText(let id, let text):
            try c.encode("assistantText", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(text, forKey: .text)
        case .thought(let text):
            try c.encode("thought", forKey: .type)
            try c.encode(text, forKey: .text)
        case .toolCall(let id, let title, let kind, let status, let content):
            try c.encode("toolCall", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(title, forKey: .title)
            try c.encode(kind, forKey: .kind)
            try c.encode(status, forKey: .status)
            try c.encode(content, forKey: .content)
        case .plan(let entries):
            try c.encode("plan", forKey: .type)
            try c.encode(entries, forKey: .entries)
        case .permissionRequest(let id, let title, let options, let decision):
            try c.encode("permissionRequest", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(title, forKey: .title)
            try c.encode(options, forKey: .options)
            try c.encodeIfPresent(decision, forKey: .decision)
        case .appApproval(let id, let appName, let decision):
            try c.encode("appApproval", forKey: .type)
            try c.encode(id, forKey: .id)
            try c.encode(appName, forKey: .appName)
            try c.encodeIfPresent(decision, forKey: .decision)
        case .systemNote(let text):
            try c.encode("systemNote", forKey: .type)
            try c.encode(text, forKey: .text)
        }
    }
}

struct Conversation: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    let createdAt: Date
    var acpSessionId: String?
    var items: [TranscriptItem]
}

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
                self?.acpReady = false
                self?.isRunning = false
                self?.appendSystemNote("Devin CLI exited (code \(code)).")
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

    // MARK: actions

    func newConversation() {
        let conversation = Conversation(
            id: UUID().uuidString,
            title: "New chat",
            createdAt: Date(),
            acpSessionId: nil,
            items: []
        )
        conversations.insert(conversation, at: 0)
        selectedId = conversation.id
        persist(conversation)
    }

    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if selectedId == nil || selected == nil {
            newConversation()
        }
        guard let conversationId = selectedId else { return }

        append(.userMessage(text: trimmed), to: conversationId)
        if selected?.title == "New chat" {
            update(conversationId) { $0.title = String(trimmed.prefix(60)) }
        }
        isRunning = true

        Task {
            do {
                try await ensureStarted()
                let sessionId = try await ensureSession(conversationId: conversationId)
                try await prompt(sessionId: sessionId, text: trimmed)
            } catch let error as ACPError {
                appendSystemNote("Devin CLI error: \(error.message)", to: conversationId)
            } catch {
                appendSystemNote("Error: \(error.localizedDescription)", to: conversationId)
            }
            isRunning = false
        }
    }

    func stop() {
        guard let conversationId = selectedId,
              let sessionId = conversations.first(where: { $0.id == conversationId })?.acpSessionId
        else { return }
        acp.notify("session/cancel", .object(["sessionId": .string(sessionId)]))
        // Answer pending permission prompts as cancelled.
        for (cardId, pending) in pendingPermissions where pending.conversationId == conversationId {
            acp.respond(id: pending.acpId, result: .object([
                "outcome": .object(["outcome": .string("cancelled")]),
            ]))
            markPermission(cardId: cardId, decision: "cancelled", in: conversationId)
            pendingPermissions.removeValue(forKey: cardId)
        }
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
            _ = try await acpRequest("session/load", .object([
                "sessionId": .string(existing),
                "cwd": .string(cwd),
                "mcpServers": mcpServers,
            ]))
            return existing
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
              let kind = payload["sessionUpdate"]?.stringValue,
              let sessionId = params.objectValue?["sessionId"]?.stringValue,
              let conversationId = conversations.first(where: { $0.acpSessionId == sessionId })?.id
        else { return }

        switch kind {
        case "agent_message_chunk":
            let text = payload["content"]?.objectValue?["text"]?.stringValue ?? ""
            let messageId = payload["messageId"]?.stringValue ?? "assistant"
            appendStreamed(text, messageId: messageId, kind: .assistant, to: conversationId)
        case "agent_thought_chunk":
            let text = payload["content"]?.objectValue?["text"]?.stringValue ?? ""
            appendStreamed(text, messageId: "thought", kind: .thought, to: conversationId)
        case "user_message_chunk":
            break // we already appended the user item
        case "tool_call":
            let item = TranscriptItem.toolCall(
                id: payload["toolCallId"]?.stringValue ?? UUID().uuidString,
                title: payload["title"]?.stringValue ?? "Tool call",
                kind: payload["kind"]?.stringValue ?? "other",
                status: payload["status"]?.stringValue ?? "pending",
                content: toolContents(payload["content"])
            )
            append(item, to: conversationId)
        case "tool_call_update":
            guard let toolCallId = payload["toolCallId"]?.stringValue else { return }
            update(conversationId) { conv in
                for index in conv.items.indices {
                    if case .toolCall(let id, var title, let kind, var status, var content) = conv.items[index],
                       id == toolCallId {
                        if let t = payload["title"]?.stringValue { title = t }
                        if let s = payload["status"]?.stringValue { status = s }
                        let newContent = toolContents(payload["content"])
                        if !newContent.isEmpty { content = newContent }
                        conv.items[index] = .toolCall(id: id, title: title, kind: kind,
                                                      status: status, content: content)
                    }
                }
            }
        case "plan":
            let entries = (payload["entries"]?.arrayValue ?? []).map { entry -> PlanEntry in
                let object = entry.objectValue
                return PlanEntry(content: object?["content"]?.stringValue ?? "",
                                 status: object?["status"]?.stringValue ?? "pending")
            }
            update(conversationId) { conv in
                if let index = conv.items.lastIndex(where: {
                    if case .plan = $0 { return true }
                    return false
                }) {
                    conv.items[index] = .plan(entries: entries)
                } else {
                    conv.items.append(.plan(entries: entries))
                }
            }
        case "usage_update", "available_commands_update", "current_mode_update":
            break
        default:
            break
        }
    }

    private enum StreamKind { case assistant, thought }

    private func appendStreamed(_ text: String, messageId: String, kind: StreamKind, to conversationId: String) {
        guard !text.isEmpty else { return }
        update(conversationId) { conv in
            switch kind {
            case .assistant:
                if let last = conv.items.last,
                   case .assistantText(let id, let existing) = last, id == messageId {
                    conv.items[conv.items.count - 1] = .assistantText(id: id, text: existing + text)
                } else {
                    conv.items.append(.assistantText(id: messageId, text: text))
                }
            case .thought:
                if let last = conv.items.last, case .thought(let existing) = last {
                    conv.items[conv.items.count - 1] = .thought(text: existing + text)
                } else {
                    conv.items.append(.thought(text: text))
                }
            }
        }
    }

    private func toolContents(_ value: JSONValue?) -> [ToolContent] {
        guard let items = value?.arrayValue else { return [] }
        return items.compactMap { item -> ToolContent? in
            let object = item.objectValue
            // ACP wraps MCP content blocks: {type:"content", content:{type:"text"|"image",...}}
            let content = (object?["type"]?.stringValue == "content"
                           ? object?["content"]?.objectValue : object)
            switch content?["type"]?.stringValue {
            case "text":
                return content?["text"]?.stringValue.map { .text($0) }
            case "image":
                guard let data = content?["data"]?.stringValue else { return nil }
                return .image(base64: data, mimeType: content?["mimeType"]?.stringValue ?? "image/png")
            case "resource":
                let text = content?["resource"]?.objectValue?["text"]?.stringValue
                return text.map { .text($0) }
            default:
                return nil
            }
        }
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
        markPermission(cardId: cardId, decision: name, in: pending.conversationId)
    }

    private func markPermission(cardId: String, decision: String, in conversationId: String) {
        update(conversationId) { conv in
            for index in conv.items.indices {
                if case .permissionRequest(let id, let title, let options, _) = conv.items[index],
                   id == cardId {
                    conv.items[index] = .permissionRequest(id: id, title: title,
                                                           options: options, decision: decision)
                }
            }
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
        update(selectedId ?? "") { conv in
            for index in conv.items.indices {
                if case .appApproval(let id, let appName, _) = conv.items[index], id == cardId {
                    conv.items[index] = .appApproval(id: id, appName: appName,
                                                    decision: "\(decision)")
                }
            }
        }
        completion(decision)
    }

    // MARK: helpers

    private func append(_ item: TranscriptItem, to conversationId: String) {
        update(conversationId) { $0.items.append(item) }
    }

    private func appendSystemNote(_ text: String, to conversationId: String? = nil) {
        if let conversationId {
            append(.systemNote(text: text), to: conversationId)
        } else if let selectedId {
            append(.systemNote(text: text), to: selectedId)
        }
    }
}
