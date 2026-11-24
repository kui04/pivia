import { describe, expect, it } from "vitest";

import {
    buildToolPresentation,
    formatByteSize,
    formatReadLineRangeSummary,
    inferLanguageFromPath,
    parseEditToolDetails,
    parseFindToolDetails,
    parseGrepToolDetails,
    parseLsToolDetails,
    parseReadToolDetails,
    parseShellToolDetails,
    parseTruncationResult,
    readToolFilePath,
} from "./tool-details";

function makeTruncation(overrides: Partial<NonNullable<ReturnType<typeof parseTruncationResult>>> = {}) {
    return {
        content: "line1\nline2",
        truncated: true,
        truncatedBy: "lines" as const,
        totalLines: 5000,
        totalBytes: 120_000,
        outputLines: 2000,
        outputBytes: 40_000,
        lastLinePartial: false,
        firstLineExceedsLimit: false,
        maxLines: 2000,
        maxBytes: 50 * 1024,
        ...overrides,
    };
}

describe("formatByteSize", () => {
    it("formats bytes, kilobytes and megabytes matching pi-coding-agent", () => {
        expect(formatByteSize(512)).toBe("512B");
        expect(formatByteSize(50 * 1024)).toBe("50.0KB");
        expect(formatByteSize(2 * 1024 * 1024)).toBe("2.0MB");
    });
});

describe("readToolFilePath", () => {
    it("falls back to file_path when path is blank or absent", () => {
        expect(readToolFilePath({ path: "src/a.ts", file_path: "src/b.ts" })).toBe("src/a.ts");
        expect(readToolFilePath({ path: "   ", file_path: "src/b.ts" })).toBe("src/b.ts");
        expect(readToolFilePath({ path: "" })).toBeNull();
    });
});

describe("formatReadLineRangeSummary", () => {
    it("formats positive integer offset and limit into colon-prefixed line ranges", () => {
        expect(formatReadLineRangeSummary(undefined, undefined)).toBe("");
        expect(formatReadLineRangeSummary(null, null)).toBe("");
        expect(formatReadLineRangeSummary(10, undefined)).toBe(":10");
        expect(formatReadLineRangeSummary(undefined, 20)).toBe(":1-20");
        expect(formatReadLineRangeSummary(10, 50)).toBe(":10-59");
        expect(formatReadLineRangeSummary("10", "5")).toBe(":10-14");
    });

    it("ignores non-positive, fractional, non-finite or malformed range inputs", () => {
        expect(formatReadLineRangeSummary(Number.NaN, 10)).toBe("");
        expect(formatReadLineRangeSummary(0, 10)).toBe("");
        expect(formatReadLineRangeSummary(1, -1)).toBe("");
        expect(formatReadLineRangeSummary(1.5, 10)).toBe("");
        expect(formatReadLineRangeSummary(10, "abc")).toBe("");
        expect(formatReadLineRangeSummary({}, [])).toBe("");
    });
});

describe("inferLanguageFromPath", () => {
    it("resolves Shiki-supported language identifiers from file paths", () => {
        expect(inferLanguageFromPath("src/App.tsx")).toBe("tsx");
        expect(inferLanguageFromPath("packages/server/src/index.ts")).toBe("typescript");
        expect(inferLanguageFromPath("script.mjs")).toBe("javascript");
        expect(inferLanguageFromPath("flake.nix")).toBe("nix");
        expect(inferLanguageFromPath("Makefile")).toBe("make");
        expect(inferLanguageFromPath("Dockerfile")).toBe("docker");
        expect(inferLanguageFromPath("README.md")).toBe("markdown");
    });

    it("returns undefined for extensionless unknown files or binary images", () => {
        expect(inferLanguageFromPath("LICENSE")).toBeUndefined();
        expect(inferLanguageFromPath("assets/logo.png")).toBeUndefined();
        expect(inferLanguageFromPath("")).toBeUndefined();
    });
});

describe("boundary parsers for SDK tool details", () => {
    it("validates TruncationResult payloads and rejects malformed shapes", () => {
        const valid = makeTruncation();
        expect(parseTruncationResult(valid)).toEqual(valid);
        expect(parseTruncationResult(null)).toBeNull();
        expect(parseTruncationResult({ truncated: "yes" })).toBeNull();
        expect(parseTruncationResult({ ...valid, truncatedBy: "unknown" })).toBeNull();
    });

    it("parses EditToolDetails preferring unified patch and preserving legacy diff", () => {
        expect(
            parseEditToolDetails({
                diff: "-1 a\n+1 b",
                patch: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b",
                firstChangedLine: 4,
            }),
        ).toEqual({
            patch: "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b",
            diff: "-1 a\n+1 b",
            firstChangedLine: 4,
        });
        expect(parseEditToolDetails({ diff: "-1 a\n+1 b" })).toEqual({
            patch: "",
            diff: "-1 a\n+1 b",
        });
        expect(parseEditToolDetails({ diff: "", patch: "" })).toBeNull();
        expect(parseEditToolDetails({ diff: 123 })).toBeNull();
    });

    it("parses shell, read, grep, find and ls tool details safely", () => {
        const truncation = makeTruncation();
        expect(parseShellToolDetails({ truncation, fullOutputPath: "/tmp/out.log" })).toEqual({
            truncation,
            fullOutputPath: "/tmp/out.log",
        });
        expect(parseReadToolDetails({ truncation })).toEqual({ truncation });
        expect(parseGrepToolDetails({ truncation, matchLimitReached: 100, linesTruncated: true })).toEqual({
            truncation,
            matchLimitReached: 100,
            linesTruncated: true,
        });
        expect(parseFindToolDetails({ resultLimitReached: 1000 })).toEqual({ resultLimitReached: 1000 });
        expect(parseLsToolDetails({ entryLimitReached: 500 })).toEqual({ entryLimitReached: 500 });
        expect(parseShellToolDetails("bad")).toBeNull();
    });
});

describe("buildToolPresentation", () => {
    it("prefers unified patch over display diff for succeeded edit calls and suppresses it on error", () => {
        const ok = buildToolPresentation({
            toolKind: "edit",
            args: { path: "src/App.tsx" },
            argumentsError: null,
            status: "done",
            output: "Successfully replaced 1 block(s) in src/App.tsx.",
            hasImages: false,
            details: {
                diff: "-1 old\n+1 new",
                patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new",
            },
        });
        expect(ok.preview).toEqual({
            kind: "diff",
            diff: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-old\n+new",
        });
        expect(ok.warnings).toEqual([]);

        const legacy = buildToolPresentation({
            toolKind: "edit",
            args: { path: "src/App.tsx" },
            argumentsError: null,
            status: "done",
            output: "Successfully replaced 1 block(s) in src/App.tsx.",
            hasImages: false,
            details: { diff: "-old\n+new" },
        });
        expect(legacy.preview).toEqual({
            kind: "diff",
            diff: "-old\n+new",
        });

        const err = buildToolPresentation({
            toolKind: "edit",
            args: { path: "src/App.tsx" },
            argumentsError: null,
            status: "error",
            output: "Target text not found",
            hasImages: false,
            details: { patch: "-old\n+new" },
        });
        expect(err.preview).toEqual({ kind: "none" });
    });

    it("produces a syntax-highlighted code preview for succeeded write calls and falls back to output on error", () => {
        const result = buildToolPresentation({
            toolKind: "write",
            args: { path: "src/helper.ts", content: "export const ok = true;\n" },
            argumentsError: null,
            status: "done",
            output: "Successfully wrote to src/helper.ts",
            hasImages: false,
            details: undefined,
        });
        expect(result.preview).toEqual({
            kind: "code",
            code: "export const ok = true;",
            language: "typescript",
            startLine: 1,
        });

        const failedWrite = buildToolPresentation({
            toolKind: "write",
            args: { path: "/root/locked.ts", content: "export const ok = true;\n" },
            argumentsError: null,
            status: "error",
            output: "EACCES: permission denied",
            hasImages: false,
            details: undefined,
        });
        expect(failedWrite.preview).toEqual({ kind: "none" });
    });

    it("returns none preview for empty write content or argument parse errors", () => {
        expect(
            buildToolPresentation({
                toolKind: "write",
                args: { path: "empty.txt", content: "" },
                argumentsError: null,
                status: "done",
                output: "Successfully wrote to empty.txt",
                hasImages: false,
                details: undefined,
            }).preview,
        ).toEqual({ kind: "none" });

        expect(
            buildToolPresentation({
                toolKind: "write",
                args: { path: "broken.ts", content: "const x = 1;" },
                argumentsError: "Unexpected EOF",
                status: "error",
                output: "",
                hasImages: false,
                details: undefined,
            }).preview,
        ).toEqual({ kind: "none" });
    });

    it("strips read continuation footers from code preview and keeps accurate startLine and warnings", () => {
        const truncated = buildToolPresentation({
            toolKind: "read",
            args: { path: "src/App.tsx", offset: 15 },
            argumentsError: null,
            status: "done",
            output: "const a = 1;\nconst b = 2;\n\n[Showing lines 15-16 of 3000. Use offset=17 to continue.]",
            hasImages: false,
            details: {
                truncation: makeTruncation({
                    truncatedBy: "lines",
                    outputLines: 2000,
                    totalLines: 3000,
                    maxLines: 2000,
                }),
            },
        });
        expect(truncated.preview).toEqual({
            kind: "code",
            code: "const a = 1;\nconst b = 2;",
            language: "tsx",
            startLine: 15,
        });
        expect(truncated.warnings).toEqual([
            {
                kind: "notice",
                message: "Truncated: showing 2000 of 3000 lines (2000 line limit)",
            },
        ]);

        const limited = buildToolPresentation({
            toolKind: "read",
            args: { path: "src/App.tsx", offset: 1, limit: 2 },
            argumentsError: null,
            status: "done",
            output: "const a = 1;\nconst b = 2;\n\n[40 more lines in file. Use offset=3 to continue.]",
            hasImages: false,
            details: undefined,
        });
        expect(limited.preview).toEqual({
            kind: "code",
            code: "const a = 1;\nconst b = 2;",
            language: "tsx",
            startLine: 1,
        });
        expect(limited.warnings).toEqual([
            {
                kind: "notice",
                message: "40 more lines in file. Use offset=3 to continue.",
            },
        ]);
    });

    it("skips code preview on read calls with firstLineExceedsLimit, images or errors", () => {
        const firstLineOver = buildToolPresentation({
            toolKind: "read",
            args: { path: "minified.js" },
            argumentsError: null,
            status: "done",
            output: "[Line 1 is 80.0KB, exceeds 50.0KB limit. Use bash: ...]",
            hasImages: false,
            details: {
                truncation: makeTruncation({ firstLineExceedsLimit: true, truncatedBy: "bytes" }),
            },
        });
        expect(firstLineOver.preview).toEqual({ kind: "none" });
        expect(firstLineOver.warnings).toEqual([{ kind: "notice", message: "First line exceeds 50.0KB limit" }]);

        expect(
            buildToolPresentation({
                toolKind: "read",
                args: { path: "diagram.png" },
                argumentsError: null,
                status: "done",
                output: "Read image file [image/png]",
                hasImages: true,
                details: undefined,
            }).preview,
        ).toEqual({ kind: "none" });

        expect(
            buildToolPresentation({
                toolKind: "read",
                args: { path: "missing.ts" },
                argumentsError: null,
                status: "error",
                output: "ENOENT",
                hasImages: false,
                details: undefined,
            }).preview,
        ).toEqual({ kind: "none" });
    });

    it("extracts truncation and fullOutput warnings for bash, grep, find, ls and generic tools", () => {
        const bash = buildToolPresentation({
            toolKind: "bash",
            args: { command: "cat huge.log" },
            argumentsError: null,
            status: "done",
            output: "tail...",
            hasImages: false,
            details: {
                truncation: makeTruncation({ truncatedBy: "bytes", outputLines: 120, maxBytes: 50 * 1024 }),
                fullOutputPath: "/tmp/pi-bash-123.log",
            },
        });
        expect(bash.warnings).toEqual([
            { kind: "fullOutput", path: "/tmp/pi-bash-123.log" },
            { kind: "notice", message: "Truncated: 120 lines shown (50.0KB limit)" },
        ]);

        const grep = buildToolPresentation({
            toolKind: "grep",
            args: { pattern: "foo" },
            argumentsError: null,
            status: "done",
            output: "src/a.ts:1:foo",
            hasImages: false,
            details: {
                matchLimitReached: 100,
                linesTruncated: true,
                truncation: makeTruncation({ truncatedBy: "bytes", maxBytes: 50 * 1024 }),
            },
        });
        expect(grep.warnings).toEqual([
            { kind: "notice", message: "Truncated: 100 matches limit, 50.0KB limit, some lines truncated" },
        ]);

        const find = buildToolPresentation({
            toolKind: "find",
            args: { pattern: "*.ts" },
            argumentsError: null,
            status: "done",
            output: "a.ts",
            hasImages: false,
            details: { resultLimitReached: 1000 },
        });
        expect(find.warnings).toEqual([{ kind: "notice", message: "Truncated: 1000 results limit" }]);

        const ls = buildToolPresentation({
            toolKind: "ls",
            args: {},
            argumentsError: null,
            status: "done",
            output: "a.ts",
            hasImages: false,
            details: { entryLimitReached: 500 },
        });
        expect(ls.warnings).toEqual([{ kind: "notice", message: "Truncated: 500 entries limit" }]);

        const generic = buildToolPresentation({
            toolKind: "generic",
            args: {},
            argumentsError: null,
            status: "done",
            output: "partial",
            hasImages: false,
            details: { fullOutputPath: "/tmp/mcp-out.txt" },
        });
        expect(generic.warnings).toEqual([{ kind: "fullOutput", path: "/tmp/mcp-out.txt" }]);
    });
});
