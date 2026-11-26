import { describe, expect, it } from "vitest";

import { commandRows, parseComposerSubmission, slashName } from "./commands";

describe("slashName", () => {
    it("extracts leading slash token and ignores non-slash input", () => {
        expect(slashName("hello")).toBeNull();
        expect(slashName("/")).toBe("");
        expect(slashName("  /comp")).toBe("comp");
        expect(slashName("/name My Task")).toBe("name");
    });
});

describe("commandRows", () => {
    it("filters local and optional remote commands with Fuzzy ranking", () => {
        const rows = commandRows("comp");
        expect(rows.map((row) => row.name)).toContain("compact");

        const withRemote = commandRows("rev", [{ id: "remote-review", name: "review", description: "Review tree" }]);
        expect(withRemote.map((row) => row.name)).toContain("review");
    });
});

describe("parseComposerSubmission", () => {
    it("returns empty when text is blank and no images are staged", () => {
        expect(parseComposerSubmission("   ", [], "prompt")).toEqual({ kind: "empty" });
    });

    it("parses local slash commands, blocks unknown slash lines, and forwards valid prompts", () => {
        expect(parseComposerSubmission("/compact focus on tests", [], "prompt")).toEqual({
            kind: "local_command",
            command: "compact",
            args: "focus on tests",
        });
        expect(parseComposerSubmission("/clear-queue", [], "steer")).toEqual({
            kind: "local_command",
            command: "clear-queue",
            args: "",
        });
        expect(parseComposerSubmission("/model", [], "prompt")).toMatchObject({
            kind: "blocked_command",
            name: "model",
        });
        expect(parseComposerSubmission("/unknown-cmd", [], "prompt")).toMatchObject({
            kind: "blocked_command",
            name: "unknown-cmd",
        });
        expect(parseComposerSubmission("/review", [], "prompt", ["review"])).toEqual({
            kind: "prompt",
            message: "/review",
            images: [],
            behavior: "prompt",
        });
        expect(parseComposerSubmission("Explain this", [], "followUp")).toEqual({
            kind: "prompt",
            message: "Explain this",
            images: [],
            behavior: "followUp",
        });
    });
});
