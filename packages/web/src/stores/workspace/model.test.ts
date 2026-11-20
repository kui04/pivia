import type { SessionSummary } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import {
    buildWorkspaceModel,
    compareSessions,
    folderLabel,
    removeSession,
    sessionTitle,
    sortSessions,
    upsertSession,
} from "./model";

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id,
        cwd: "/home/u/pivia",
        name: null,
        firstMessage: "First prompt",
        messageCount: 1,
        createdAtMs: 1_000,
        modifiedAtMs: 1_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
        ...overrides,
    };
}

describe("sessionTitle", () => {
    it("uses a trimmed name and reports it as named", () => {
        expect(sessionTitle(summary("a", { name: "  Parser rewrite ", firstMessage: "First prompt" }))).toEqual({
            title: "Parser rewrite",
            named: true,
        });
    });

    it("falls back to the trimmed first message when the name is null or blank", () => {
        expect(sessionTitle(summary("a", { name: null, firstMessage: "  First prompt  " }))).toEqual({
            title: "First prompt",
            named: false,
        });
        expect(sessionTitle(summary("a", { name: "   ", firstMessage: "First prompt" }))).toEqual({
            title: "First prompt",
            named: false,
        });
    });

    it("uses the placeholder when both title sources are blank", () => {
        expect(sessionTitle(summary("a", { name: null, firstMessage: " " }))).toEqual({
            title: "Untitled session",
            named: false,
        });
    });
});

describe("folderLabel", () => {
    it("returns the final path segment for Unix and Windows paths", () => {
        expect(folderLabel("/home/u/pivia")).toBe("pivia");
        expect(folderLabel("C:\\Users\\u\\pivia")).toBe("pivia");
    });

    it("ignores trailing separators and keeps filesystem roots", () => {
        expect(folderLabel("/home/u/pivia///")).toBe("pivia");
        expect(folderLabel("C:\\Users\\u\\pivia\\\\")).toBe("pivia");
        expect(folderLabel("/")).toBe("/");
        expect(folderLabel("\\")).toBe("\\");
    });

    it("names a missing cwd for sessions from old versions", () => {
        expect(folderLabel("")).toBe("Unknown directory");
    });

    it("returns a bare name unchanged", () => {
        expect(folderLabel("workspace")).toBe("workspace");
    });
});

describe("session list helpers", () => {
    it("orders by modification time and then by id", () => {
        const older = summary("b", { modifiedAtMs: 1_000 });
        const newer = summary("c", { modifiedAtMs: 5_000 });
        const tieA = summary("a", { modifiedAtMs: 5_000 });

        expect(sortSessions([older, newer, tieA]).map((session) => session.id)).toEqual(["a", "c", "b"]);
        expect(compareSessions(older, older)).toBe(0);
        expect(compareSessions(tieA, newer)).toBeLessThan(0);
        expect(compareSessions(newer, older)).toBeLessThan(0);
    });

    it("upserts by id without reordering unrelated sessions", () => {
        const one = summary("one", { name: "One" });
        const two = summary("two", { name: "Two" });
        const replacement = summary("one", { name: "Renamed" });

        expect(upsertSession([one, two], replacement)).toEqual([replacement, two]);
        expect(upsertSession([one], summary("three"))).toEqual([one, summary("three")]);
    });

    it("removes a session by id", () => {
        expect(removeSession([summary("a"), summary("b")], "a").map((session) => session.id)).toEqual(["b"]);
        expect(removeSession([summary("a")], "missing")).toHaveLength(1);
    });
});

describe("buildWorkspaceModel", () => {
    it("returns an empty model before the first scan", () => {
        expect(
            buildWorkspaceModel({
                sessions: [],
                pins: ["a"],
                query: "a",
                selectedId: "a",
                collapsed: ["/home/u/pivia"],
            }),
        ).toEqual({ pinned: [], folders: [], total: 0, matched: 0 });
    });

    it("moves pinned sessions out of their folders and keeps them filtered", () => {
        const sessions = [
            summary("pin-old", { cwd: "/only-pinned", name: "Older pin", modifiedAtMs: 1_000 }),
            summary("pin-new", { cwd: "/home/u/pivia", name: "Newer pin", modifiedAtMs: 5_000 }),
            summary("pin-tie-a", { cwd: "/home/u/pivia", name: "Pin tie A", modifiedAtMs: 3_000 }),
            summary("pin-tie-b", { cwd: "/home/u/pivia", name: "Pin tie B", modifiedAtMs: 3_000 }),
            summary("regular", { cwd: "/home/u/pivia", name: "Regular", modifiedAtMs: 2_000 }),
        ];

        const model = buildWorkspaceModel({
            sessions,
            pins: ["pin-old", "pin-new", "pin-tie-a", "pin-tie-b"],
            query: "",
            selectedId: "pin-new",
            collapsed: [],
        });

        expect(model.pinned.map((row) => row.id)).toEqual(["pin-new", "pin-tie-a", "pin-tie-b", "pin-old"]);
        expect(model.pinned[0]?.selected).toBe(true);
        expect(model.pinned[0]?.pinned).toBe(true);
        expect(model.pinned[0]?.runtimeState).toBe("idle");
        expect(model.pinned[0]?.attachedClients).toBe(0);
        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/pivia"]);
        expect(model.folders[0]?.sessions.map((row) => row.id)).toEqual(["regular"]);
    });

    it("groups by cwd and orders folders and rows newest first", () => {
        const sessions = [
            summary("old", { cwd: "/home/u/alpha", name: "Alpha", modifiedAtMs: 1_500 }),
            summary("b", { cwd: "/home/u/beta", name: "Beta B", modifiedAtMs: 2_000 }),
            summary("a", { cwd: "/home/u/beta", name: "Beta A", modifiedAtMs: 2_000 }),
            summary("oldest", { cwd: "/home/u/beta", name: "Beta Old", modifiedAtMs: 1_000 }),
        ];

        const model = buildWorkspaceModel({
            sessions,
            pins: [],
            query: "   ",
            selectedId: "a",
            collapsed: ["/home/u/alpha"],
        });

        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/beta", "/home/u/alpha"]);
        expect(model.folders[0]).toMatchObject({ cwd: "/home/u/beta", label: "beta", collapsed: false });
        expect(model.folders[0]?.sessions.map((row) => row.id)).toEqual(["a", "b", "oldest"]);
        expect(model.folders[0]?.sessions[0]?.selected).toBe(true);
        expect(model.folders[1]?.collapsed).toBe(true);
    });

    it("orders folders with the same newest session by cwd", () => {
        const model = buildWorkspaceModel({
            sessions: [
                summary("b", { cwd: "/home/u/beta", modifiedAtMs: 1_000 }),
                summary("a", { cwd: "/home/u/alpha", modifiedAtMs: 1_000 }),
            ],
            pins: [],
            query: "",
            selectedId: null,
            collapsed: [],
        });

        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/alpha", "/home/u/beta"]);
    });

    it("filters case-insensitively on name, first message and cwd, and expands matches", () => {
        const sessions = [
            summary("one", { cwd: "/home/u/pivia", name: "Parser Rewrite", firstMessage: "unused" }),
            summary("two", {
                cwd: "/home/u/docs",
                name: null,
                firstMessage: "Fix PARSER edge case",
                modifiedAtMs: 2_000,
            }),
            summary("three", {
                cwd: "/home/u/Parser-Lab",
                name: "Other",
                firstMessage: "Nothing",
                modifiedAtMs: 1_500,
            }),
            summary("four", { cwd: "/home/u/empty-match", name: "Unrelated", firstMessage: "Nothing" }),
        ];

        const model = buildWorkspaceModel({
            sessions,
            pins: ["one"],
            query: "  parser ",
            selectedId: null,
            collapsed: ["/home/u/docs", "/home/u/Parser-Lab"],
        });

        expect(model.pinned.map((row) => row.id)).toEqual(["one"]);
        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/docs", "/home/u/Parser-Lab"]);
        expect(model.folders.every((folder) => !folder.collapsed)).toBe(true);
        expect(model.total).toBe(4);
        expect(model.matched).toBe(3);
    });

    it("shows only sessions that match the search", () => {
        const model = buildWorkspaceModel({
            sessions: [summary("one", { name: "Alpha" }), summary("two", { name: "Beta" })],
            pins: ["two"],
            query: "alpha",
            selectedId: null,
            collapsed: [],
        });

        expect(model.pinned).toEqual([]);
        expect(model.folders[0]?.sessions.map((row) => row.id)).toEqual(["one"]);
    });
});
