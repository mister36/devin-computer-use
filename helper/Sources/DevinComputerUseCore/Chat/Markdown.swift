import Foundation

// Block-level Markdown for assistant output. AttributedString(markdown:)
// only understands inline syntax and collapses everything else into one run of
// text, which is why headings, lists, code fences and tables used to arrive as
// a single flat paragraph.

struct MarkdownListItem: Equatable {
    var text: String
    var level: Int
    var marker: String?
}

enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(ordered: Bool, items: [MarkdownListItem])
    case code(language: String?, code: String)
    case quote(String)
    case table(headers: [String], rows: [[String]])
    case rule
}

enum Markdown {
    static func blocks(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var index = 0

        func flushParagraph(_ buffer: inout [String]) {
            guard !buffer.isEmpty else { return }
            blocks.append(.paragraph(buffer.joined(separator: " ")))
            buffer.removeAll()
        }

        var paragraph: [String] = []
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if let fence = fenceToken(trimmed) {
                flushParagraph(&paragraph)
                let language = String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                index += 1
                // An unterminated fence is normal mid-stream: render what is there.
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    code.append(lines[index])
                    index += 1
                }
                index += 1
                blocks.append(.code(language: language.isEmpty ? nil : language,
                                    code: code.joined(separator: "\n")))
                continue
            }

            if trimmed.isEmpty {
                flushParagraph(&paragraph)
                index += 1
                continue
            }

            if isRule(trimmed) {
                flushParagraph(&paragraph)
                blocks.append(.rule)
                index += 1
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph(&paragraph)
                blocks.append(heading)
                index += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph(&paragraph)
                var quoted: [String] = []
                while index < lines.count {
                    let candidate = lines[index].trimmingCharacters(in: .whitespaces)
                    guard candidate.hasPrefix(">") else { break }
                    quoted.append(String(candidate.dropFirst()).trimmingCharacters(in: .whitespaces))
                    index += 1
                }
                blocks.append(.quote(quoted.joined(separator: " ")))
                continue
            }

            if let table = table(lines, from: &index) {
                flushParagraph(&paragraph)
                blocks.append(table)
                continue
            }

            if listItem(line) != nil {
                flushParagraph(&paragraph)
                var items: [MarkdownListItem] = []
                var ordered = false
                while index < lines.count, let item = listItem(lines[index]) {
                    ordered = ordered || item.isOrdered
                    items.append(item.item)
                    index += 1
                    // A wrapped continuation line belongs to the item above it.
                    while index < lines.count, listItem(lines[index]) == nil,
                          lines[index].hasPrefix("  "),
                          !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                        items[items.count - 1].text += " "
                            + lines[index].trimmingCharacters(in: .whitespaces)
                        index += 1
                    }
                }
                blocks.append(.list(ordered: ordered, items: items))
                continue
            }

            paragraph.append(trimmed)
            index += 1
        }
        flushParagraph(&paragraph)
        return blocks
    }

    private static func fenceToken(_ trimmed: String) -> String? {
        for token in ["```", "~~~"] where trimmed.hasPrefix(token) { return token }
        return nil
    }

    private static func isRule(_ trimmed: String) -> Bool {
        guard trimmed.count >= 3 else { return false }
        for character in ["-", "*", "_"] where trimmed.allSatisfy({ String($0) == character }) {
            return true
        }
        return false
    }

    private static func heading(_ trimmed: String) -> MarkdownBlock? {
        var level = 0
        var rest = Substring(trimmed)
        while rest.first == "#", level < 6 {
            level += 1
            rest = rest.dropFirst()
        }
        guard level > 0, rest.first == " " else { return nil }
        return .heading(level: level, text: rest.trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ line: String) -> (item: MarkdownListItem, isOrdered: Bool)? {
        let indent = line.prefix { $0 == " " || $0 == "\t" }.count
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        let level = min(indent / 2, 3)

        for bullet in ["- ", "* ", "+ "] where trimmed.hasPrefix(bullet) {
            return (MarkdownListItem(text: String(trimmed.dropFirst(2)), level: level, marker: nil), false)
        }
        let digits = trimmed.prefix { $0.isNumber }
        if !digits.isEmpty {
            let rest = trimmed.dropFirst(digits.count)
            if (rest.hasPrefix(". ") || rest.hasPrefix(") ")) {
                return (MarkdownListItem(text: String(rest.dropFirst(2)), level: level,
                                         marker: "\(digits)."), true)
            }
        }
        return nil
    }

    private static func table(_ lines: [String], from index: inout Int) -> MarkdownBlock? {
        let header = lines[index].trimmingCharacters(in: .whitespaces)
        guard header.contains("|"), index + 1 < lines.count else { return nil }
        let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
        guard separator.contains("|"),
              separator.allSatisfy({ "|-: ".contains($0) }),
              separator.contains("-")
        else { return nil }

        let headers = cells(header)
        var rows: [[String]] = []
        index += 2
        while index < lines.count {
            let candidate = lines[index].trimmingCharacters(in: .whitespaces)
            guard candidate.contains("|"), !candidate.isEmpty else { break }
            rows.append(cells(candidate))
            index += 1
        }
        return .table(headers: headers, rows: rows)
    }

    private static func cells(_ row: String) -> [String] {
        var trimmed = Substring(row)
        if trimmed.hasPrefix("|") { trimmed = trimmed.dropFirst() }
        if trimmed.hasSuffix("|") { trimmed = trimmed.dropLast() }
        return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

// MARK: inline spans

struct MarkdownInlineRun: Equatable {
    var text: String
    var bold = false
    var italic = false
    var code = false
    var strikethrough = false
    var link: String?
}

extension Markdown {
    /// Splits one block's text into styled runs. Deliberately small: emphasis,
    /// inline code, strikethrough, links and bare URLs.
    static func inlineRuns(_ text: String) -> [MarkdownInlineRun] {
        var runs: [MarkdownInlineRun] = []
        var current = MarkdownInlineRun(text: "")
        var bold = false
        var italic = false
        var strike = false
        let characters = Array(text)
        var index = 0

        func flush() {
            if !current.text.isEmpty { runs.append(current) }
            current = MarkdownInlineRun(text: "", bold: bold, italic: italic, strikethrough: strike)
        }

        while index < characters.count {
            let character = characters[index]

            if character == "`" {
                let ticks = run(of: "`", in: characters, at: index)
                if let close = find(String(repeating: "`", count: ticks),
                                    in: characters, from: index + ticks) {
                    flush()
                    runs.append(MarkdownInlineRun(
                        text: String(characters[(index + ticks)..<close]), code: true))
                    index = close + ticks
                    current = MarkdownInlineRun(text: "", bold: bold, italic: italic, strikethrough: strike)
                    continue
                }
            }

            if character == "*" || character == "_" {
                let width = min(run(of: character, in: characters, at: index), 2)
                let token = String(repeating: character, count: width)
                let isOpen = width == 2 ? bold : italic
                if isOpen || opens(token, in: characters, at: index) {
                    flush()
                    if width == 2 { bold.toggle() } else { italic.toggle() }
                    current = MarkdownInlineRun(text: "", bold: bold, italic: italic, strikethrough: strike)
                    index += width
                    continue
                }
            }

            if character == "~", run(of: "~", in: characters, at: index) >= 2,
               strike || opens("~~", in: characters, at: index) {
                flush()
                strike.toggle()
                current = MarkdownInlineRun(text: "", bold: bold, italic: italic, strikethrough: strike)
                index += 2
                continue
            }

            if character == "[", let close = find("]", in: characters, from: index + 1),
               close + 1 < characters.count, characters[close + 1] == "(",
               let end = find(")", in: characters, from: close + 2) {
                flush()
                runs.append(MarkdownInlineRun(text: String(characters[(index + 1)..<close]),
                                              bold: bold, italic: italic, strikethrough: strike,
                                              link: String(characters[(close + 2)..<end])))
                index = end + 1
                current = MarkdownInlineRun(text: "", bold: bold, italic: italic, strikethrough: strike)
                continue
            }

            current.text.append(character)
            index += 1
        }
        if !current.text.isEmpty { runs.append(current) }
        return runs
    }

    /// A delimiter only opens emphasis when it hugs the word it styles and has
    /// a matching partner, so `2 * 3 * 4` stays arithmetic.
    private static func opens(_ token: String, in characters: [Character], at index: Int) -> Bool {
        let contentStart = index + token.count
        guard contentStart < characters.count, !characters[contentStart].isWhitespace else {
            return false
        }
        var search = contentStart
        while let found = find(token, in: characters, from: search) {
            if found > contentStart, !characters[found - 1].isWhitespace { return true }
            search = found + 1
        }
        return false
    }

    private static func run(of character: Character, in characters: [Character], at index: Int) -> Int {
        var count = 0
        while index + count < characters.count, characters[index + count] == character { count += 1 }
        return count
    }

    private static func find(_ token: String, in characters: [Character], from start: Int) -> Int? {
        let needle = Array(token)
        guard !needle.isEmpty, start >= 0 else { return nil }
        var index = start
        while index + needle.count <= characters.count {
            if Array(characters[index..<(index + needle.count)]) == needle { return index }
            index += 1
        }
        return nil
    }
}
