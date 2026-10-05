import Foundation

/// One chat's transcript as its own observable, so a streamed chunk redraws
/// that transcript only — not the sidebar, the composer or other chats.
@MainActor
final class TranscriptModel: ObservableObject {
    let conversationId: String
    private(set) var transcript = Transcript()
    private(set) var groups: [TranscriptGroup] = []
    private(set) var isLoaded = false
    /// Bumped on every change; cheap to observe for scroll-to-bottom.
    private(set) var revision = 0

    init(conversationId: String, transcript: Transcript? = nil) {
        self.conversationId = conversationId
        if let transcript { load(transcript) }
    }

    func load(_ transcript: Transcript) {
        guard !isLoaded else { return }
        objectWillChange.send()
        isLoaded = true
        set(transcript)
    }

    func mutate(_ body: (inout Transcript) -> Void) {
        objectWillChange.send()
        isLoaded = true
        var copy = transcript
        transcript = Transcript()
        body(&copy)
        set(copy)
    }

    private func set(_ transcript: Transcript) {
        self.transcript = transcript
        groups = transcript.entries.grouped()
        revision &+= 1
    }
}
