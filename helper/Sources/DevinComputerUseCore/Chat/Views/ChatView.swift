import SwiftUI

// Devin-desktop-style chat: quiet sidebar of conversations, dense transcript
// where assistant prose reads like a document, and a rounded composer.
struct ChatView: View {
    @ObservedObject var store = ChatStore.shared

    var body: some View {
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 280)
        } detail: {
            VStack(spacing: 0) {
                TranscriptView(conversation: store.selected)
                ComposerView()
            }
            .background(Color(nsColor: .textBackgroundColor))
        }
        .navigationTitle(store.selected?.title ?? "Devin")
    }
}

struct SidebarView: View {
    @ObservedObject var store = ChatStore.shared

    var body: some View {
        VStack(spacing: 0) {
            List(selection: $store.selectedId) {
                Section("Chats") {
                    ForEach(store.conversations) { conversation in
                        Text(conversation.title)
                            .lineLimit(1)
                            .font(.callout)
                            .padding(.vertical, 1)
                            .tag(conversation.id)
                            .contextMenu {
                                Button("Delete", role: .destructive) {
                                    store.delete(conversationId: conversation.id)
                                }
                            }
                    }
                }
            }
            .listStyle(.sidebar)

            Divider()
            Button(action: { store.newConversation() }) {
                Label("New chat", systemImage: "square.and.pencil")
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
        }
    }
}

struct TranscriptView: View {
    let conversation: Conversation?

    private var groups: [TranscriptGroup] {
        (conversation?.transcript.entries ?? []).grouped()
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if groups.isEmpty { EmptyStateView() }
                    ForEach(groups) { group in
                        switch group {
                        case .single(let entry):
                            TranscriptItemView(item: entry.item)
                        case .tools(let entries):
                            ToolGroupView(entries: entries)
                        }
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: 740, alignment: .leading)
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: conversation?.transcript.entries.count ?? 0) { _ in
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom") }
            }
            .onChange(of: lastTextLength) { _ in
                proxy.scrollTo("bottom")
            }
        }
    }

    private var lastTextLength: Int {
        guard let last = conversation?.transcript.entries.last?.item else { return 0 }
        switch last {
        case .assistantText(_, let text), .thought(let text), .systemNote(let text),
             .userMessage(let text):
            return text.count
        default:
            return 0
        }
    }
}

struct EmptyStateView: View {
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "sparkles")
                .font(.system(size: 26))
                .foregroundStyle(.tertiary)
            Text("Work with Devin")
                .font(.title3.weight(.medium))
            Text("Ask Devin to use the apps on your Mac.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }
}

struct TranscriptItemView: View {
    let item: TranscriptItem

    var body: some View {
        switch item {
        case .userMessage(let text):
            HStack(alignment: .top) {
                Spacer(minLength: 48)
                Text(text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 13)
                    .padding(.vertical, 8)
                    .background(Color.accentColor.opacity(0.14),
                                in: RoundedRectangle(cornerRadius: 14))
                    .frame(maxWidth: 560, alignment: .trailing)
            }
        case .assistantText(_, let text):
            MarkdownView(text: text)
        case .thought(let text):
            ThoughtView(text: text)
        case .toolCall(let id, let title, let kind, let status, let content):
            ToolGroupView(entries: [TranscriptEntry(
                id: id,
                item: .toolCall(id: id, title: title, kind: kind, status: status, content: content))])
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
}

/// Reasoning is background noise until you want it: one muted line, expandable.
struct ThoughtView: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button(action: { expanded.toggle() }) {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                    Text(expanded ? "Thinking" : firstLine)
                        .lineLimit(1)
                        .font(.callout)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
                MarkdownView(text: text, baseFont: .callout)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 16)
            }
        }
    }

    private var firstLine: String {
        text.split(separator: "\n").first.map(String.init) ?? "Thinking"
    }
}

/// Consecutive tool calls render as compact one-line rows inside a single
/// bordered block, each row expandable for its output.
struct ToolGroupView: View {
    let entries: [TranscriptEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                if index > 0 { Divider().opacity(0.4) }
                if case .toolCall(_, let title, let kind, let status, let content) = entry.item {
                    ToolCallRow(title: title, kind: kind, status: status, content: content)
                }
            }
        }
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary, lineWidth: 1))
    }
}

struct ToolCallRow: View {
    let title: String
    let kind: String
    let status: String
    let content: [ToolContent]
    @State private var expanded = false

    private var hasOutput: Bool { !content.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: { if hasOutput { expanded.toggle() } }) {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(title)
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    if hasOutput {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    statusIcon
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded {
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
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
    }

    private var icon: String {
        switch kind {
        case "read": return "doc.text"
        case "edit": return "pencil"
        case "execute": return "terminal"
        case "search": return "magnifyingglass"
        case "fetch": return "network"
        case "think": return "brain"
        case "move", "switch_mode": return "arrow.triangle.branch"
        default: return "wrench.and.screwdriver"
        }
    }

    @ViewBuilder private var statusIcon: some View {
        switch status {
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.green)
        case "failed", "error":
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 11))
                .foregroundStyle(.red)
        default:
            ProgressView().controlSize(.small).scaleEffect(0.6).frame(width: 12, height: 12)
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
                .font(.system(size: 12, weight: .medium))
            if let decision {
                Text(decision).foregroundStyle(.secondary).font(.caption)
            } else {
                HStack(spacing: 8) {
                    ForEach(options, id: \.optionId) { option in
                        Button(option.name) {
                            ChatStore.shared.answerPermission(cardId: id, optionId: option.optionId,
                                                              name: option.name)
                        }
                        .controlSize(.small)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.orange.opacity(0.3), lineWidth: 1))
    }
}

struct AppApprovalCard: View {
    let id: String
    let appName: String
    let decision: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Allow Devin to use \(appName)?", systemImage: "app.badge.checkmark")
                .font(.system(size: 12, weight: .medium))
            Text("Devin will be able to see and control \(appName).")
                .font(.caption).foregroundStyle(.secondary)
            if let decision {
                Text(decision).foregroundStyle(.secondary).font(.caption)
            } else {
                HStack(spacing: 8) {
                    Button("Always allow") {
                        ChatStore.shared.answerAppApproval(cardId: id, decision: .always)
                    }
                    .controlSize(.small)
                    Button("Allow once") {
                        ChatStore.shared.answerAppApproval(cardId: id, decision: .allow)
                    }
                    .controlSize(.small)
                    Button("Cancel") {
                        ChatStore.shared.answerAppApproval(cardId: id, decision: .cancel)
                    }
                    .controlSize(.small)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.blue.opacity(0.3), lineWidth: 1))
    }
}

struct PlanView: View {
    let entries: [PlanEntry]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Plan")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: icon(for: entry.status))
                        .font(.system(size: 10))
                        .foregroundStyle(entry.status == "completed" ? .green : .secondary)
                    Text(entry.content)
                        .font(.system(size: 12))
                        .strikethrough(entry.status == "completed", color: .secondary)
                        .foregroundStyle(entry.status == "completed" ? .secondary : .primary)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary, lineWidth: 1))
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
    @State private var newlineMonitor: Any?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Work with Devin", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.body)
                    .lineLimit(1...8)
                    .focused($focused)
                    .onSubmit(send)
                if store.isRunning {
                    Button(action: { store.stop() }) {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("Stop")
                }
                Button(action: send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(canSend ? Color.accentColor : Color.secondary.opacity(0.4))
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 9)
            .background(Color(nsColor: .controlBackgroundColor),
                        in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16)
                .stroke(focused ? Color.accentColor.opacity(0.5) : Color.secondary.opacity(0.25)))

            HStack(spacing: 10) {
                Toggle("Approve for me", isOn: $store.approveForMe)
                    .toggleStyle(.checkbox)
                    .font(.caption)
                Spacer()
                if store.isRunning {
                    Text("Devin is working…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Return to send · Shift+Return for a new line")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: 788)
        .frame(maxWidth: .infinity)
        .onAppear(perform: startNewlineMonitor)
        .onDisappear(perform: stopNewlineMonitor)
    }

    /// AppKit submits the field editor on any Return, so Shift+Return has to be
    /// turned into a literal newline before the field sees it.
    private func startNewlineMonitor() {
        guard newlineMonitor == nil else { return }
        newlineMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard focused,
                  event.keyCode == 36,
                  event.modifierFlags.contains(.shift),
                  let editor = event.window?.firstResponder as? NSTextView
            else { return event }
            editor.insertNewlineIgnoringFieldEditor(nil)
            return nil
        }
    }

    private func stopNewlineMonitor() {
        if let newlineMonitor { NSEvent.removeMonitor(newlineMonitor) }
        newlineMonitor = nil
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        guard canSend else { return }
        let text = draft
        draft = ""
        store.send(text: text)
    }
}
