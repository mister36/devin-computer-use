import XCTest
@testable import DevinComputerUseCore

final class MarkdownTests: XCTestCase {
    func testHeadingsAndParagraphs() {
        let blocks = Markdown.blocks("""
        # Title

        Some prose
        wrapped over lines.

        ## Subtitle
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Title"),
            .paragraph("Some prose wrapped over lines."),
            .heading(level: 2, text: "Subtitle"),
        ])
    }

    func testHashWithoutSpaceIsNotAHeading() {
        XCTAssertEqual(Markdown.blocks("#hashtag"), [.paragraph("#hashtag")])
    }

    func testBulletAndNumberedLists() {
        let blocks = Markdown.blocks("""
        - one
        - two
          continued

        1. first
        2. second
        """)
        XCTAssertEqual(blocks, [
            .list(ordered: false, items: [
                MarkdownListItem(text: "one", level: 0, marker: nil),
                MarkdownListItem(text: "two continued", level: 0, marker: nil),
            ]),
            .list(ordered: true, items: [
                MarkdownListItem(text: "first", level: 0, marker: "1."),
                MarkdownListItem(text: "second", level: 0, marker: "2."),
            ]),
        ])
    }

    func testNestedBulletsKeepTheirLevel() {
        let blocks = Markdown.blocks("""
        - parent
            - child
        """)
        guard case .list(_, let items) = blocks.first else { return XCTFail("expected a list") }
        XCTAssertEqual(items.map(\.level), [0, 2])
    }

    func testFencedCodeKeepsLinesAndLanguage() {
        let blocks = Markdown.blocks("""
        text

        ```swift
        let a = 1

        let b = 2
        ```
        """)
        XCTAssertEqual(blocks, [
            .paragraph("text"),
            .code(language: "swift", code: "let a = 1\n\nlet b = 2"),
        ])
    }

    func testUnterminatedFenceStillRendersAsCode() {
        XCTAssertEqual(Markdown.blocks("```sh\nnpm test"),
                       [.code(language: "sh", code: "npm test")])
    }

    func testQuotesRulesAndTables() {
        let blocks = Markdown.blocks("""
        > quoted line
        > continues

        ---

        | Name | Count |
        | --- | ----: |
        | a | 1 |
        | b | 2 |
        """)
        XCTAssertEqual(blocks, [
            .quote("quoted line continues"),
            .rule,
            .table(headers: ["Name", "Count"], rows: [["a", "1"], ["b", "2"]]),
        ])
    }

    func testPipeTextWithoutASeparatorRowIsAParagraph() {
        XCTAssertEqual(Markdown.blocks("a | b"), [.paragraph("a | b")])
    }

    func testInlineEmphasisCodeAndLinks() {
        let runs = Markdown.inlineRuns("plain **bold** and `code` and [docs](https://example.com)")
        XCTAssertEqual(runs, [
            MarkdownInlineRun(text: "plain ", bold: false),
            MarkdownInlineRun(text: "bold", bold: true),
            MarkdownInlineRun(text: " and "),
            MarkdownInlineRun(text: "code", code: true),
            MarkdownInlineRun(text: " and "),
            MarkdownInlineRun(text: "docs", link: "https://example.com"),
        ])
    }

    func testUnmatchedMarkersStayLiteral() {
        XCTAssertEqual(Markdown.inlineRuns("2 * 3 * 4 = 24").map(\.text).joined(),
                       "2 * 3 * 4 = 24")
        XCTAssertEqual(Markdown.inlineRuns("an unterminated `fence"),
                       [MarkdownInlineRun(text: "an unterminated `fence")])
    }

    func testInlineCodeKeepsMarkersInside() {
        let runs = Markdown.inlineRuns("use `a_b_c` here")
        XCTAssertEqual(runs[1], MarkdownInlineRun(text: "a_b_c", code: true))
    }
}
