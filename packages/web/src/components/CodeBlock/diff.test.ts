import { describe, expect, it } from "vitest";

import { parseDiffLines } from "./diff";

describe("parseDiffLines", () => {
    it("separates markers from added and removed lines", () => {
        const lines = parseDiffLines(["@@ -1,1 +1,1 @@", "-old", "+new", " context"]);

        expect(lines.map((line) => line.variant)).toEqual(["default", "removed", "added", "default"]);
        expect(lines.map((line) => line.marker)).toEqual(["", "-", "+", ""]);
        expect(lines.map((line) => line.content)).toEqual(["@@ -1,1 +1,1 @@", "old", "new", "context"]);
    });

    it("closes a hunk by its counts so the next file headers stay plain", () => {
        const lines = parseDiffLines([
            "diff --git a/a.ts b/a.ts",
            "@@ -1 +1 @@",
            "-old",
            "+new",
            "diff --git a/b.ts b/b.ts",
            "--- a/b.ts",
            "+++ b/b.ts",
        ]);

        expect(lines[4]).toEqual({ marker: "", content: "diff --git a/b.ts b/b.ts", variant: "default" });
        expect(lines[5]).toEqual({ marker: "", content: "--- a/b.ts", variant: "default" });
        expect(lines[6]).toEqual({ marker: "", content: "+++ b/b.ts", variant: "default" });
    });

    it("keeps carriage returns out of CRLF diff rows", () => {
        const [line] = parseDiffLines(["+added\r"]);

        expect(line).toEqual({ marker: "+", content: "added", variant: "added" });
    });

    it("treats an omitted hunk count as one line", () => {
        const lines = parseDiffLines(["@@ -1 +1 @@", "-old", "+new", "--- a/b.ts"]);

        expect(lines[1]).toEqual({ marker: "-", content: "old", variant: "removed" });
        expect(lines[2]).toEqual({ marker: "+", content: "new", variant: "added" });
        expect(lines[3]).toEqual({ marker: "", content: "--- a/b.ts", variant: "default" });
    });
});
