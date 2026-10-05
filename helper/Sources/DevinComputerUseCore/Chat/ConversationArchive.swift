import Foundation

/// Chat persistence, kept off the main thread. Streaming marks a chat dirty and
/// the latest snapshot is written once updates go quiet, instead of re-encoding
/// the whole chat (screenshots included) on every chunk. A small index keeps
/// launch cheap: transcripts are only read when a chat is opened.
@MainActor
final class ConversationArchive {
    nonisolated let directory: URL
    private let delay: TimeInterval
    private let queue = DispatchQueue(label: "ai.devin.computer-use.archive", qos: .utility)
    private var pendingRecords: [String: ConversationRecord] = [:]
    private var pendingIndex: [Conversation]?
    private var scheduled: DispatchWorkItem?

    init(directory: URL, delay: TimeInterval = 0.5) {
        self.directory = directory
        self.delay = delay
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private nonisolated var indexURL: URL { directory.appendingPathComponent("index.json") }

    private nonisolated func recordURL(_ id: String) -> URL {
        directory.appendingPathComponent("\(id).json")
    }

    // MARK: reads

    /// Sidebar metadata, newest first. Chats missing from the index (written by
    /// older builds, or before a crash) are recovered from their files.
    func loadIndex() -> [Conversation] {
        let decoder = Self.decoder()
        var byId: [String: Conversation] = [:]
        if let data = try? Data(contentsOf: indexURL),
           let indexed = try? decoder.decode([Conversation].self, from: data) {
            for conversation in indexed { byId[conversation.id] = conversation }
        }
        let indexedIds = Set(byId.keys)
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        let fileIds = Set(files
            .filter { $0.pathExtension == "json" && $0.lastPathComponent != "index.json" }
            .map { $0.deletingPathExtension().lastPathComponent })
        for id in fileIds.subtracting(indexedIds) {
            if let data = try? Data(contentsOf: recordURL(id)),
               let conversation = try? decoder.decode(Conversation.self, from: data) {
                byId[id] = conversation
            }
        }
        for id in indexedIds.subtracting(fileIds) { byId.removeValue(forKey: id) }

        let conversations = byId.values.sorted { $0.createdAt > $1.createdAt }
        if Set(byId.keys) != indexedIds { saveIndex(conversations) }
        return conversations
    }

    /// Safe to call from any thread.
    nonisolated func readRecord(id: String) -> ConversationRecord? {
        guard let data = try? Data(contentsOf: recordURL(id)) else { return nil }
        return try? Self.decoder().decode(ConversationRecord.self, from: data)
    }

    /// Unflushed snapshot for a chat, if one is waiting to be written.
    func pendingRecord(id: String) -> ConversationRecord? {
        pendingRecords[id]
    }

    // MARK: writes

    func save(_ record: ConversationRecord) {
        pendingRecords[record.conversation.id] = record
        schedule()
    }

    func saveIndex(_ conversations: [Conversation]) {
        pendingIndex = conversations
        schedule()
    }

    func delete(id: String) {
        pendingRecords.removeValue(forKey: id)
        let url = recordURL(id)
        queue.async { try? FileManager.default.removeItem(at: url) }
    }

    /// Writes everything pending and waits for it (app termination).
    func flush() {
        scheduled?.cancel()
        scheduled = nil
        let batch = takePending()
        queue.sync { Self.write(batch) }
    }

    private func schedule() {
        guard scheduled == nil else { return }
        let item = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.scheduled = nil
                let batch = self.takePending()
                self.queue.async { Self.write(batch) }
            }
        }
        scheduled = item
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }

    /// Value snapshots handed to the write queue; nothing in it is shared.
    private struct Batch: @unchecked Sendable {
        var records: [(url: URL, record: ConversationRecord)]
        var index: (url: URL, conversations: [Conversation])?
    }

    private func takePending() -> Batch {
        let batch = Batch(
            records: pendingRecords.values.map { (recordURL($0.conversation.id), $0) },
            index: pendingIndex.map { (indexURL, $0) })
        pendingRecords.removeAll()
        pendingIndex = nil
        return batch
    }

    private nonisolated static func write(_ batch: Batch) {
        let encoder = encoder()
        for (url, record) in batch.records {
            if let data = try? encoder.encode(record) { try? data.write(to: url, options: .atomic) }
        }
        if let (url, conversations) = batch.index, let data = try? encoder.encode(conversations) {
            try? data.write(to: url, options: .atomic)
        }
    }

    nonisolated static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    nonisolated static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
