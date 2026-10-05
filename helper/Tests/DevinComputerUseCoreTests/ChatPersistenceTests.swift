import XCTest
@testable import DevinComputerUseCore

final class SessionTrackerTests: XCTestCase {
    func testSessionIsLoadedOncePerProcess() {
        var tracker = ACPSessionTracker()
        XCTAssertTrue(tracker.needsLoad("s1"))
        tracker.beginLoad("s1")
        tracker.finishLoad("s1", succeeded: true)
        XCTAssertFalse(tracker.needsLoad("s1"))

        tracker.reset()
        XCTAssertTrue(tracker.needsLoad("s1"))
    }

    func testFailedLoadIsRetried() {
        var tracker = ACPSessionTracker()
        tracker.beginLoad("s1")
        tracker.finishLoad("s1", succeeded: false)
        XCTAssertTrue(tracker.needsLoad("s1"))
    }

    func testNewSessionsNeverNeedLoading() {
        var tracker = ACPSessionTracker()
        tracker.markLive("s2")
        XCTAssertFalse(tracker.needsLoad("s2"))
    }

    func testReplayIsIgnoredExceptForTitles() {
        var tracker = ACPSessionTracker()
        tracker.beginLoad("s1")
        XCTAssertFalse(tracker.accepts(update: "user_message_chunk", sessionId: "s1"))
        XCTAssertFalse(tracker.accepts(update: "agent_message_chunk", sessionId: "s1"))
        XCTAssertTrue(tracker.accepts(update: "session_info_update", sessionId: "s1"))
        XCTAssertTrue(tracker.accepts(update: "agent_message_chunk", sessionId: "other"))
        tracker.finishLoad("s1", succeeded: true)
        XCTAssertTrue(tracker.accepts(update: "agent_message_chunk", sessionId: "s1"))
    }
}

@MainActor
final class ConversationArchiveTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("archive-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func record(_ id: String, _ message: String, createdAt: Date = Date()) -> ConversationRecord {
        var record = ConversationRecord(
            conversation: Conversation(id: id, title: id, createdAt: createdAt, acpSessionId: nil))
        record.transcript.appendUserMessage(message)
        return record
    }

    func testWritesAreCoalescedUntilFlush() {
        let archive = ConversationArchive(directory: directory, delay: 60)
        archive.save(record("c1", "first"))
        archive.save(record("c1", "second"))
        XCTAssertNil(archive.readRecord(id: "c1"))
        XCTAssertNotNil(archive.pendingRecord(id: "c1"))

        archive.flush()
        XCTAssertNil(archive.pendingRecord(id: "c1"))
        XCTAssertEqual(archive.readRecord(id: "c1")?.transcript.entries.count, 1)
        guard case .userMessage(let text) = archive.readRecord(id: "c1")?.transcript.entries.first?.item else {
            return XCTFail("expected a user message")
        }
        XCTAssertEqual(text, "second")
    }

    func testIndexListsChatsNewestFirst() {
        let archive = ConversationArchive(directory: directory, delay: 60)
        let older = record("old", "a", createdAt: Date(timeIntervalSince1970: 1))
        let newer = record("new", "b", createdAt: Date(timeIntervalSince1970: 2))
        archive.save(older)
        archive.save(newer)
        archive.saveIndex([newer.conversation, older.conversation])
        archive.flush()

        XCTAssertEqual(ConversationArchive(directory: directory).loadIndex().map(\.id), ["new", "old"])
    }

    func testChatsMissingFromTheIndexAreRecovered() throws {
        // Files written by builds without an index.
        let legacy = record("legacy", "hi")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try ConversationArchive.encoder().encode(legacy)
            .write(to: directory.appendingPathComponent("legacy.json"))

        let archive = ConversationArchive(directory: directory, delay: 60)
        XCTAssertEqual(archive.loadIndex().map(\.id), ["legacy"])
        archive.flush()
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("index.json").path))
    }

    func testDeletedChatsDropOutOfTheIndex() {
        let archive = ConversationArchive(directory: directory, delay: 60)
        let chat = record("gone", "x")
        archive.save(chat)
        archive.saveIndex([chat.conversation])
        archive.flush()
        archive.delete(id: "gone")
        archive.flush()

        XCTAssertEqual(ConversationArchive(directory: directory).loadIndex().map(\.id), [])
    }
}

final class GroupingTests: XCTestCase {
    func testLongToolRunsGroupLinearly() {
        var transcript = Transcript()
        transcript.appendUserMessage("go")
        for index in 0..<5000 {
            transcript.apply(update: [
                "sessionUpdate": .string("tool_call"),
                "toolCallId": .string("t\(index)"),
                "title": .string("Step \(index)"),
            ])
        }
        let groups = transcript.entries.grouped()
        XCTAssertEqual(groups.count, 2)
        guard case .tools(let tools) = groups[1] else { return XCTFail("expected a tool group") }
        XCTAssertEqual(tools.count, 5000)
    }
}
