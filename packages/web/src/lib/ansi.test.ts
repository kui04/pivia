import { describe, expect, it } from "vitest";

import { stripAnsi } from "./ansi";

describe("stripAnsi", () => {
    it("removes SGR colors and keeps the text", () => {
        expect(stripAnsi("\u001B[31merror\u001B[0m: failed")).toBe("error: failed");
        expect(stripAnsi("\u001B[1;38;5;196mbold red\u001B[22;39m")).toBe("bold red");
    });

    it("removes cursor and erase sequences", () => {
        expect(stripAnsi("\u001B[2K\u001B[1Gprogress 10%")).toBe("progress 10%");
        expect(stripAnsi("\u001B[?25lhidden cursor\u001B[?25h")).toBe("hidden cursor");
    });

    it("removes OSC titles and hyperlinks", () => {
        expect(stripAnsi("\u001B]0;window title\u0007visible")).toBe("visible");
        expect(stripAnsi("\u001B]8;;https://example.com\u0007link text\u001B]8;;\u0007")).toBe("link text");
        expect(stripAnsi("\u001B]8;;https://example.com\u001B\\link text\u001B]8;;\u001B\\")).toBe("link text");
    });

    it("removes the C1 CSI introducer and two-byte escapes", () => {
        expect(stripAnsi("\u009B31mc1 red\u009B0m")).toBe("c1 red");
        expect(stripAnsi("\u001B=keypad\u001B>")).toBe("keypad");
    });

    it("keeps plain text that looks like an escape", () => {
        expect(stripAnsi("array[0] = 1")).toBe("array[0] = 1");
        expect(stripAnsi("ESC is \\u001B in prose")).toBe("ESC is \\u001B in prose");
        expect(stripAnsi("")).toBe("");
    });

    it("drops a sequence cut off at the end without eating printable text", () => {
        expect(stripAnsi("partial \u001B[31")).toBe("partial ");
        expect(stripAnsi("partial \u001B]0;title")).toBe("partial ");
        expect(stripAnsi("x\u001B")).toBe("x");
    });
});
