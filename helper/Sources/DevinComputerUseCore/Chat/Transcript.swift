import Foundation

// Transcript model and the pure reducer that turns ACP `session/update`
// notifications into transcript entries. No AppKit, no I/O: ChatStore owns the
// process and persistence, this owns what the user ends up reading.

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

/// A transcript item with an identity stable across streaming updates, so the
/// list does not re-key its rows every time a chunk lands.
struct TranscriptEntry: Codable, Equatable, Identifiable {
    let id: String
    var item: TranscriptItem

    init(id: String = UUID().uuidString, item: TranscriptItem) {
        self.id = id
        self.item = item
    }

    enum CodingKeys: String, CodingKey { case id, item }

    init(from decoder: Decoder) throws {
        // Transcripts written before entries had identities are flat items.
        if let c = try? decoder.container(keyedBy: CodingKeys.self),
           let id = try? c.decode(String.self, forKey: .id),
           let item = try? c.decode(TranscriptItem.self, forKey: .item) {
            self.init(id: id, item: item)
        } else {
            self.init(item: try TranscriptItem(from: decoder))
        }
    }
}

struct Transcript: Equatable {
    private(set) var entries: [TranscriptEntry] = []

    // Streaming cursors. Transient: never persisted, rebuilt as updates arrive.
    private var openAssistantId: String?
    private var openAssistantMessageId: String?
    private var openThoughtId: String?
    private var echoEntryId: String?
    private var echoedText = ""
    /// User messages already visible in the transcript that the agent has not
    /// echoed back yet. Echoes matching one of these are dropped as duplicates.
    private var unechoedUserMessages: [String] = []

    init(entries: [TranscriptEntry] = []) {
        self.entries = entries
        unechoedUserMessages = entries.compactMap {
            if case .userMessage(let text) = $0.item { return text }
            return nil
        }
    }

    // MARK: writes from the app itself

    mutating func appendUserMessage(_ text: String) {
        endTurn()
        unechoedUserMessages.append(text)
        entries.append(TranscriptEntry(item: .userMessage(text: text)))
    }

    mutating func append(_ item: TranscriptItem) {
        endTurn()
        entries.append(TranscriptEntry(item: item))
    }

    /// Closes any open streaming block, so the next chunk starts a new bubble
    /// instead of being glued onto the previous turn.
    mutating func endTurn() {
        openAssistantId = nil
        openAssistantMessageId = nil
        openThoughtId = nil
        dropEcho()
    }

    // MARK: writes from session/update

    mutating func apply(update payload: [String: JSONValue]) {
        let kind = payload["sessionUpdate"]?.stringValue ?? ""
        switch kind {
        case "agent_message_chunk":
            appendAssistantChunk(text(in: payload), messageId: payload["messageId"]?.stringValue)
        case "agent_thought_chunk":
            appendThoughtChunk(text(in: payload))
        case "user_message_chunk":
            appendUserEcho(text(in: payload))
        case "tool_call":
            append(.toolCall(
                id: payload["toolCallId"]?.stringValue ?? UUID().uuidString,
                title: payload["title"]?.stringValue ?? "Tool call",
                kind: payload["kind"]?.stringValue ?? "other",
                status: payload["status"]?.stringValue ?? "pending",
                content: Self.toolContents(payload["content"])))
        case "tool_call_update":
            applyToolCallUpdate(payload)
        case "plan":
            applyPlan(payload)
        default:
            break
        }
    }

    private func text(in payload: [String: JSONValue]) -> String {
        payload["content"]?.objectValue?["text"]?.stringValue ?? ""
    }

    private mutating func appendAssistantChunk(_ text: String, messageId: String?) {
        guard !text.isEmpty else { return }
        dropEcho()
        openThoughtId = nil
        if let messageId, messageId != openAssistantMessageId { openAssistantId = nil }
        if let id = openAssistantId, let index = entries.lastIndex(where: { $0.id == id }),
           case .assistantText(let blockId, let existing) = entries[index].item {
            entries[index].item = .assistantText(id: blockId, text: existing + text)
            return
        }
        let entry = TranscriptEntry(item: .assistantText(id: messageId ?? UUID().uuidString, text: text))
        entries.append(entry)
        openAssistantId = entry.id
        openAssistantMessageId = messageId
    }

    private mutating func appendThoughtChunk(_ text: String) {
        guard !text.isEmpty else { return }
        dropEcho()
        openAssistantId = nil
        openAssistantMessageId = nil
        if let id = openThoughtId, let index = entries.lastIndex(where: { $0.id == id }),
           case .thought(let existing) = entries[index].item {
            entries[index].item = .thought(text: existing + text)
            return
        }
        let entry = TranscriptEntry(item: .thought(text: text))
        entries.append(entry)
        openThoughtId = entry.id
    }

    /// The agent echoes user turns back — including every turn of a session it
    /// replays after `session/load`. Show the ones the transcript is missing
    /// and drop the ones it already has.
    private mutating func appendUserEcho(_ text: String) {
        guard !text.isEmpty else { return }
        openAssistantId = nil
        openAssistantMessageId = nil
        openThoughtId = nil
        echoedText += text

        if echoEntryId == nil,
           let index = unechoedUserMessages.firstIndex(where: { $0.hasPrefix(echoedText) }) {
            if unechoedUserMessages[index] == echoedText { dropEcho() }
            return
        }
        if let id = echoEntryId, let index = entries.lastIndex(where: { $0.id == id }) {
            entries[index].item = .userMessage(text: echoedText)
        } else {
            let entry = TranscriptEntry(item: .userMessage(text: echoedText))
            entries.append(entry)
            echoEntryId = entry.id
        }
    }

    private mutating func dropEcho() {
        if let index = unechoedUserMessages.firstIndex(of: echoedText) {
            unechoedUserMessages.remove(at: index)
        }
        echoedText = ""
        echoEntryId = nil
    }

    private mutating func applyToolCallUpdate(_ payload: [String: JSONValue]) {
        guard let toolCallId = payload["toolCallId"]?.stringValue else { return }
        for index in entries.indices {
            guard case .toolCall(let id, var title, let kind, var status, var content) = entries[index].item,
                  id == toolCallId else { continue }
            if let value = payload["title"]?.stringValue { title = value }
            if let value = payload["status"]?.stringValue { status = value }
            let updated = Self.toolContents(payload["content"])
            if !updated.isEmpty { content = updated }
            entries[index].item = .toolCall(id: id, title: title, kind: kind,
                                            status: status, content: content)
        }
    }

    private mutating func applyPlan(_ payload: [String: JSONValue]) {
        let planEntries = (payload["entries"]?.arrayValue ?? []).map { entry -> PlanEntry in
            let object = entry.objectValue
            return PlanEntry(content: object?["content"]?.stringValue ?? "",
                             status: object?["status"]?.stringValue ?? "pending")
        }
        if let index = entries.lastIndex(where: {
            if case .plan = $0.item { return true }
            return false
        }) {
            entries[index].item = .plan(entries: planEntries)
        } else {
            append(.plan(entries: planEntries))
        }
    }

    // MARK: targeted edits

    mutating func setPermissionDecision(cardId: String, decision: String) {
        for index in entries.indices {
            if case .permissionRequest(let id, let title, let options, _) = entries[index].item,
               id == cardId {
                entries[index].item = .permissionRequest(id: id, title: title,
                                                         options: options, decision: decision)
            }
        }
    }

    mutating func setAppApprovalDecision(cardId: String, decision: String) {
        for index in entries.indices {
            if case .appApproval(let id, let appName, _) = entries[index].item, id == cardId {
                entries[index].item = .appApproval(id: id, appName: appName, decision: decision)
            }
        }
    }

    static func toolContents(_ value: JSONValue?) -> [ToolContent] {
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
}

/// Display grouping: consecutive tool calls collapse into one compact block so
/// a long run of steps does not push the conversation off screen.
enum TranscriptGroup: Identifiable, Equatable {
    case single(TranscriptEntry)
    case tools([TranscriptEntry])

    var id: String {
        switch self {
        case .single(let entry): return entry.id
        case .tools(let entries): return "tools-" + (entries.first?.id ?? "")
        }
    }
}

extension Array where Element == TranscriptEntry {
    func grouped() -> [TranscriptGroup] {
        var groups: [TranscriptGroup] = []
        for entry in self {
            guard case .toolCall = entry.item else {
                groups.append(.single(entry))
                continue
            }
            if case .tools(let pending) = groups.last {
                groups[groups.count - 1] = .tools(pending + [entry])
            } else {
                groups.append(.tools([entry]))
            }
        }
        return groups
    }
}

struct Conversation: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    let createdAt: Date
    var acpSessionId: String?
    var transcript: Transcript

    init(id: String, title: String, createdAt: Date, acpSessionId: String?,
         transcript: Transcript = Transcript()) {
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.acpSessionId = acpSessionId
        self.transcript = transcript
    }

    enum CodingKeys: String, CodingKey { case id, title, createdAt, acpSessionId, items }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(id: try c.decode(String.self, forKey: .id),
                  title: try c.decode(String.self, forKey: .title),
                  createdAt: try c.decode(Date.self, forKey: .createdAt),
                  acpSessionId: try? c.decode(String.self, forKey: .acpSessionId),
                  transcript: Transcript(entries: (try? c.decode([TranscriptEntry].self, forKey: .items)) ?? []))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(acpSessionId, forKey: .acpSessionId)
        try c.encode(transcript.entries, forKey: .items)
    }
}
