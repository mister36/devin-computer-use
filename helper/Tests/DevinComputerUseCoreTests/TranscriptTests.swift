import XCTest
@testable import DevinComputerUseCore

private func chunk(_ kind: String, _ text: String, messageId: String? = nil) -> [String: JSONValue] {
    var payload: [String: JSONValue] = [
        "sessionUpdate": .string(kind),
        "content": .object(["type": .string("text"), "text": .string(text)]),
    ]
    if let messageId { payload["messageId"] = .string(messageId) }
    return payload
}

final class TranscriptTests: XCTestCase {
    private func texts(_ transcript: Transcript) -> [String] {
        transcript.entries.map { entry in
            switch entry.item {
            case .userMessage(let text): return "user: \(text)"
            case .assistantText(_, let text): return "assistant: \(text)"
            case .thought(let text): return "thought: \(text)"
            case .toolCall(_, let title, _, let status, _): return "tool(\(status)): \(title)"
            case .plan(let entries): return "plan: \(entries.map(\.content).joined(separator: ","))"
            case .systemNote(let text): return "note: \(text)"
            default: return "other"
            }
        }
    }

    func testStreamedChunksAccumulateIntoOneMessage() {
        var transcript = Transcript()
        transcript.apply(update: chunk("agent_message_chunk", "Hello", messageId: "m1"))
        transcript.apply(update: chunk("agent_message_chunk", " world", messageId: "m1"))
        XCTAssertEqual(texts(transcript), ["assistant: Hello world"])
    }

    func testSeparateTurnsDoNotMerge() {
        var transcript = Transcript()
        transcript.apply(update: chunk("agent_message_chunk", "first"))
        transcript.endTurn()
        transcript.apply(update: chunk("agent_message_chunk", "second"))
        XCTAssertEqual(texts(transcript), ["assistant: first", "assistant: second"])
    }

    func testDifferentMessageIdsStartNewMessages() {
        var transcript = Transcript()
        transcript.apply(update: chunk("agent_message_chunk", "a", messageId: "m1"))
        transcript.apply(update: chunk("agent_message_chunk", "b", messageId: "m2"))
        XCTAssertEqual(texts(transcript), ["assistant: a", "assistant: b"])
    }

    func testFollowUpAppearsOnceWhenEchoedBack() {
        var transcript = Transcript()
        transcript.appendUserMessage("first question")
        transcript.apply(update: chunk("user_message_chunk", "first "))
        transcript.apply(update: chunk("user_message_chunk", "question"))
        transcript.apply(update: chunk("agent_message_chunk", "answer"))
        transcript.endTurn()
        transcript.appendUserMessage("follow up")
        transcript.apply(update: chunk("user_message_chunk", "follow up"))
        transcript.apply(update: chunk("agent_message_chunk", "second answer"))

        XCTAssertEqual(texts(transcript), [
            "user: first question",
            "assistant: answer",
            "user: follow up",
            "assistant: second answer",
        ])
    }

    func testEchoOfAMessageTheTranscriptLacksIsShown() {
        var transcript = Transcript()
        transcript.apply(update: chunk("user_message_chunk", "sent from the CLI"))
        transcript.apply(update: chunk("agent_message_chunk", "ok"))
        XCTAssertEqual(texts(transcript), ["user: sent from the CLI", "assistant: ok"])
    }

    func testReplayedHistoryDoesNotDuplicatePersistedMessages() {
        var transcript = Transcript()
        transcript.appendUserMessage("older question")
        transcript.apply(update: chunk("agent_message_chunk", "older answer"))
        transcript.endTurn()

        // Reopening the app decodes the transcript and the agent replays the
        // session: the echoed user turn must not appear twice.
        var reloaded = Transcript(entries: transcript.entries)
        reloaded.apply(update: chunk("user_message_chunk", "older question"))
        XCTAssertEqual(texts(reloaded), ["user: older question", "assistant: older answer"])
    }

    func testThoughtAndMessageChunksDoNotBleedTogether() {
        var transcript = Transcript()
        transcript.apply(update: chunk("agent_thought_chunk", "pondering"))
        transcript.apply(update: chunk("agent_message_chunk", "hi"))
        transcript.apply(update: chunk("agent_thought_chunk", "more"))
        XCTAssertEqual(texts(transcript), ["thought: pondering", "assistant: hi", "thought: more"])
    }

    func testToolCallUpdateMutatesMatchingCall() {
        var transcript = Transcript()
        transcript.apply(update: [
            "sessionUpdate": .string("tool_call"),
            "toolCallId": .string("t1"),
            "title": .string("Read file"),
            "kind": .string("read"),
            "status": .string("pending"),
        ])
        transcript.apply(update: [
            "sessionUpdate": .string("tool_call_update"),
            "toolCallId": .string("t1"),
            "status": .string("completed"),
            "content": .array([.object([
                "type": .string("content"),
                "content": .object(["type": .string("text"), "text": .string("done")]),
            ])]),
        ])
        XCTAssertEqual(texts(transcript), ["tool(completed): Read file"])
        guard case .toolCall(_, _, _, _, let content) = transcript.entries[0].item else {
            return XCTFail("expected a tool call")
        }
        XCTAssertEqual(content, [.text("done")])
    }

    func testToolCallClosesTheOpenAssistantMessage() {
        var transcript = Transcript()
        transcript.apply(update: chunk("agent_message_chunk", "before", messageId: "m1"))
        transcript.apply(update: [
            "sessionUpdate": .string("tool_call"),
            "toolCallId": .string("t1"),
            "title": .string("Run"),
        ])
        transcript.apply(update: chunk("agent_message_chunk", "after", messageId: "m1"))
        XCTAssertEqual(texts(transcript), ["assistant: before", "tool(pending): Run", "assistant: after"])
    }

    func testPlanIsReplacedRatherThanAppended() {
        var transcript = Transcript()
        let first: [String: JSONValue] = [
            "sessionUpdate": .string("plan"),
            "entries": .array([.object(["content": .string("step one"), "status": .string("pending")])]),
        ]
        let second: [String: JSONValue] = [
            "sessionUpdate": .string("plan"),
            "entries": .array([.object(["content": .string("step two"), "status": .string("completed")])]),
        ]
        transcript.apply(update: first)
        transcript.apply(update: second)
        XCTAssertEqual(texts(transcript), ["plan: step two"])
    }

    func testEntryIdentitiesAreStableAcrossStreaming() {
        var transcript = Transcript()
        transcript.apply(update: chunk("agent_message_chunk", "one", messageId: "m1"))
        let id = transcript.entries[0].id
        transcript.apply(update: chunk("agent_message_chunk", " two", messageId: "m1"))
        XCTAssertEqual(transcript.entries[0].id, id)
    }

    func testConsecutiveToolCallsGroup() {
        var transcript = Transcript()
        transcript.appendUserMessage("go")
        for index in 0..<3 {
            transcript.apply(update: [
                "sessionUpdate": .string("tool_call"),
                "toolCallId": .string("t\(index)"),
                "title": .string("Step \(index)"),
            ])
        }
        transcript.apply(update: chunk("agent_message_chunk", "done"))
        let groups = transcript.entries.grouped()
        XCTAssertEqual(groups.count, 3)
        guard case .tools(let tools) = groups[1] else { return XCTFail("expected a tool group") }
        XCTAssertEqual(tools.count, 3)
    }

    func testConversationDecodesLegacyFlatItems() throws {
        let json = """
        {
          "id": "c1",
          "title": "Legacy",
          "createdAt": "2024-01-01T00:00:00Z",
          "items": [
            {"type": "userMessage", "text": "hi"},
            {"type": "assistantText", "id": "assistant", "text": "hello"}
          ]
        }
        """
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let record = try decoder.decode(ConversationRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.conversation.title, "Legacy")
        XCTAssertEqual(texts(record.transcript), ["user: hi", "assistant: hello"])
        XCTAssertFalse(record.transcript.entries[0].id.isEmpty)
    }

    func testConversationRoundTripsEntryIdentities() throws {
        var record = ConversationRecord(
            conversation: Conversation(id: "c1", title: "t", createdAt: Date(), acpSessionId: "s1"))
        record.transcript.appendUserMessage("hi")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let decoded = try decoder.decode(ConversationRecord.self, from: encoder.encode(record))
        XCTAssertEqual(decoded.transcript.entries, record.transcript.entries)
        XCTAssertEqual(decoded.conversation.acpSessionId, "s1")
    }
}
