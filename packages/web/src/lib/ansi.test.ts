import { describe, expect, it } from "vitest";

import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
    it.each([
        ["removes SGR colors and keeps the text", "\u001B[31merror\u001B[0m: failed", "error: failed"],
        ["removes SGR colors and keeps the text", "\u001B[1;38;5;196mbold red\u001B[22;39m", "bold red"],
        ["removes cursor and erase sequences", "\u001B[2K\u001B[1Gprogress 10%", "progress 10%"],
        ["removes cursor and erase sequences", "\u001B[?25lhidden cursor\u001B[?25h", "hidden cursor"],
        ["removes OSC titles and hyperlinks", "\u001B]0;window title\u0007visible", "visible"],
        [
            "removes OSC titles and hyperlinks",
            "\u001B]8;;https://example.com\u0007link text\u001B]8;;\u0007",
            "link text",
        ],
        [
            "removes OSC titles and hyperlinks",
            "\u001B]8;;https://example.com\u001B\\link text\u001B]8;;\u001B\\",
            "link text",
        ],
        ["removes the C1 CSI introducer and two-byte escapes", "\u009B31mc1 red\u009B0m", "c1 red"],
        ["removes the C1 CSI introducer and two-byte escapes", "\u001B=keypad\u001B>", "keypad"],
        ["keeps plain text that looks like an escape", "array[0] = 1", "array[0] = 1"],
        ["keeps plain text that looks like an escape", "ESC is \\u001B in prose", "ESC is \\u001B in prose"],
        ["keeps plain text that looks like an escape", "", ""],
        ["turns CRLF and a lone CR into LF", "first\r\nsecond\rthird", "first\nsecond\nthird"],
        ["turns CRLF and a lone CR into LF", "progress 10%\rprogress 100%\r\n", "progress 10%\nprogress 100%\n"],
        ["normalizes line endings after removing an escape sequence", "\u001B[31mred\u001B[0m\r\nnext", "red\nnext"],
        ["normalizes line endings after removing an escape sequence", "one\r\u001B]0;title\u0007two", "one\ntwo"],
        ["drops a sequence cut off at the end without eating printable text", "partial \u001B[31", "partial "],
        ["drops a sequence cut off at the end without eating printable text", "partial \u001B]0;title", "partial "],
        ["drops a sequence cut off at the end without eating printable text", "x\u001B", "x"],
    ] as const)("%s", (_case, input, expected) => {
        expect(stripAnsi(input)).toBe(expected);
    });
});
