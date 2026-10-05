import AppKit
import SwiftUI

/// Renders assistant output as real Markdown blocks: headings, lists, quotes,
/// fenced code, tables and rules, with inline emphasis inside each block.
struct MarkdownView: View {
    let text: String
    var baseFont: Font = .body

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Markdown.cachedBlocks(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            MarkdownInlineText(text: text, font: headingFont(level))
                .padding(.top, level <= 2 ? 6 : 2)
        case .paragraph(let text):
            MarkdownInlineText(text: text, font: baseFont)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(ordered ? (item.marker ?? "\(index + 1).") : "•")
                            .font(baseFont)
                            .foregroundStyle(.secondary)
                            .frame(minWidth: ordered ? 18 : 8, alignment: .trailing)
                        MarkdownInlineText(text: item.text, font: baseFont)
                    }
                    .padding(.leading, CGFloat(item.level) * 16)
                }
            }
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .quote(let text):
            HStack(spacing: 10) {
                Rectangle().fill(.quaternary).frame(width: 3)
                MarkdownInlineText(text: text, font: baseFont)
                    .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .table(let headers, let rows):
            MarkdownTableView(headers: headers, rows: rows, font: baseFont)
        case .rule:
            Divider().padding(.vertical, 2)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .system(.title2, weight: .semibold)
        case 2: return .system(.title3, weight: .semibold)
        case 3: return .system(.headline)
        default: return .system(.subheadline, weight: .semibold)
        }
    }
}

/// One block of text with inline emphasis, code spans and links.
struct MarkdownInlineText: View {
    let text: String
    var font: Font = .body

    var body: some View {
        Markdown.cachedInlineRuns(text)
            .reduce(Text("")) { $0 + styled($1) }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func styled(_ run: MarkdownInlineRun) -> Text {
        if let link = run.link, let url = URL(string: link) {
            var attributed = AttributedString(run.text)
            attributed.link = url
            attributed.underlineStyle = .single
            return Text(attributed).font(font)
        }
        if run.code {
            return Text(run.text)
                .font(.system(.callout, design: .monospaced))
                .foregroundColor(.pink)
        }
        var text = Text(run.text).font(font)
        if run.bold { text = text.bold() }
        if run.italic { text = text.italic() }
        if run.strikethrough { text = text.strikethrough() }
        return text
    }
}

struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language?.uppercased() ?? "CODE")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Button(action: copy) {
                    Label(copied ? "Copied" : "Copy",
                          systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 10))
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.quaternary.opacity(0.45))

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(.quaternary.opacity(0.22))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary, lineWidth: 1))
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

struct MarkdownTableView: View {
    let headers: [String]
    let rows: [[String]]
    var font: Font = .body

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row(headers, bold: true)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, cells in
                Divider()
                row(cells, bold: false)
                    .background(index.isMultiple(of: 2) ? Color.clear : Color.secondary.opacity(0.05))
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private func row(_ cells: [String], bold: Bool) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { _, cell in
                MarkdownInlineText(text: cell, font: bold ? font.bold() : font)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .background(bold ? Color.secondary.opacity(0.1) : Color.clear)
    }
}
