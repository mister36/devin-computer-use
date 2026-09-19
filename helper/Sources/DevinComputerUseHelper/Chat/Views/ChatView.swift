import SwiftUI

// ChatGPT-desktop-style chat: sidebar of conversations, centered transcript,
// rounded composer at the bottom.
struct ChatView: View {
    @ObservedObject var store = ChatStore.shared

    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                Button(action: { store.newConversation() }) {
                    Label("New chat", systemImage: "square.and.pencil")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.borderless)
                .padding(10)
                List(selection: $store.selectedId) {
                    ForEach(store.conversations) { conversation in
                        Text(conversation.title)
                            .lineLimit(1)
                            .tag(conversation.id)
                    }
                }
                .listStyle(.sidebar)
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 280)
        } detail: {
            VStack(spacing: 0) {
                TranscriptView(conversation: store.selected)
                Divider()
                ComposerView()
            }
        }
    }
}

struct TranscriptView: View {
    let conversation: Conversation?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(Array((conversation?.items ?? []).enumerated()), id: \.offset) { _, item in
                        TranscriptItemView(item: item)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: 720)
                .padding(20)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: conversation?.items.count ?? 0) { _ in
                withAnimation { proxy.scrollTo("bottom") }
            }
            .onChange(of: lastTextLength) { _ in
                proxy.scrollTo("bottom")
            }
        }
    }

    private var lastTextLength: Int {
        guard let last = conversation?.items.last else { return 0 }
        switch last {
        case .assistantText(_, let text), .thought(let text), .systemNote(let text),
             .userMessage(let text):
            return text.count
        default:
            return 0
        }
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem

    var body: some View {
        switch item {
        case .userMessage(let text):
            HStack {
                Spacer(minLength: 60)
                Text(text)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 16))
            }
        case .assistantText(_, let text):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(paragraphs(text).enumerated()), id: \.offset) { _, paragraph in
                    if let attributed = try? AttributedString(markdown: paragraph) {
                        Text(attributed)
                    } else {
                        Text(paragraph)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .thought(let text):
            Text(text)
                .italic()
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .toolCall(let id, let title, let kind, let status, let content):
            ToolCallCard(id: id, title: title, kind: kind, status: status, content: content)
        case .plan(let entries):
            PlanView(entries: entries)
        case .permissionRequest(let id, let title, let options, let decision):
            PermissionCard(id: id, title: title, options: options, decision: decision)
        case .appApproval(let id, let appName, let decision):
            AppApprovalCard(id: id, appName: appName, decision: decision)
        case .systemNote(let text):
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }

    private func paragraphs(_ text: String) -> [String] {
        text.components(separatedBy: "\n\n")
    }
}

struct ToolCallCard: View {
    let id: String
    let title: String
    let kind: String
    let status: String
    let content: [ToolContent]

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(content.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case .text(let text):
                        Text(text)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    case .image(let base64, _):
                        if let data = Data(base64Encoded: base64), let image = NSImage(data: data) {
                            Image(nsImage: image)
                                .resizable()
                                .aspectRatio(contentMode: .fit)
                                .frame(maxHeight: 220)
                                .cornerRadius(6)
                        }
                    }
                }
            }
            .padding(.top, 6)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon(for: kind))
                Text(title).lineLimit(1)
                Spacer()
                statusIcon
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }

    private func icon(for kind: String) -> String {
        switch kind {
        case "read": return "doc.text"
        case "edit": return "pencil"
        case "execute": return "terminal"
        case "search": return "magnifyingglass"
        case "fetch": return "network"
        case "think": return "brain"
        default: return "wrench"
        }
    }

    @ViewBuilder private var statusIcon: some View {
        switch status {
        case "completed":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "failed", "error":
            Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        default:
            ProgressView().controlSize(.small)
        }
    }
}

struct PermissionCard: View {
    let id: String
    let title: String
    let options: [PermissionOption]
    let decision: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: "hand.raised")
                .font(.headline)
            if let decision {
                Text(decision).foregroundStyle(.secondary).font(.caption)
            } else {
                HStack {
                    ForEach(options, id: \.optionId) { option in
                        Button(option.name) {
                            ChatStore.shared.answerPermission(cardId: id, optionId: option.optionId,
                                                              name: option.name)
                        }
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct AppApprovalCard: View {
    let id: String
    let appName: String
    let decision: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Allow Devin to use \(appName)?", systemImage: "app.badge.checkmark")
                .font(.headline)
            Text("Devin will be able to see and control \(appName).")
                .font(.caption).foregroundStyle(.secondary)
            if let decision {
                Text(decision).foregroundStyle(.secondary).font(.caption)
            } else {
                HStack {
                    Button("Always allow") {
                        ChatStore.shared.answerAppApproval(cardId: id, decision: .always)
                    }
                    Button("Allow once") {
                        ChatStore.shared.answerAppApproval(cardId: id, decision: .allow)
                    }
                    Button("Cancel") {
                        ChatStore.shared.answerAppApproval(cardId: id, decision: .cancel)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct PlanView: View {
    let entries: [PlanEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(spacing: 8) {
                    Image(systemName: icon(for: entry.status))
                        .foregroundStyle(entry.status == "completed" ? .green : .secondary)
                    Text(entry.content).font(.callout)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
    }

    private func icon(for status: String) -> String {
        switch status {
        case "completed": return "checkmark.circle.fill"
        case "in_progress": return "circle.dotted"
        default: return "circle"
        }
    }
}

struct ComposerView: View {
    @ObservedObject var store = ChatStore.shared
    @State private var draft = ""

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Work with Devin", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .onSubmit { send() }
                if store.isRunning {
                    Button(action: { store.stop() }) {
                        Image(systemName: "stop.circle.fill").font(.title2)
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill").font(.title2)
                    }
                    .buttonStyle(.plain)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.background, in: RoundedRectangle(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(.secondary.opacity(0.3)))
            HStack {
                Toggle("Approve for me", isOn: $store.approveForMe)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                Spacer()
                Text("Devin CLI")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
    }

    private func send() {
        let text = draft
        draft = ""
        store.send(text: text)
    }
}
