import type { SessionId, SessionSummary } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { makeSessionSummary } from "@/test/fixtures";
import { sid } from "@/test/ids";

import {
    buildWorkspaceModel,
    collectKnownCwds,
    createCatalogSyncReducer,
    folderLabel,
    selectedSession,
    sessionRowStatus,
    sessionTitle,
    sortSessions,
} from "./model";

describe("sessionTitle", () => {
    it("uses a trimmed name and reports it as named", () => {
        expect(
            sessionTitle(makeSessionSummary("a", { name: "  Parser rewrite ", firstMessage: "First prompt" })),
        ).toEqual({
            title: "Parser rewrite",
            named: true,
        });
    });

    it("falls back to the trimmed first message when the name is null or blank", () => {
        expect(sessionTitle(makeSessionSummary("a", { name: null, firstMessage: "  First prompt  " }))).toEqual({
            title: "First prompt",
            named: false,
        });
        expect(sessionTitle(makeSessionSummary("a", { name: "   ", firstMessage: "First prompt" }))).toEqual({
            title: "First prompt",
            named: false,
        });
    });

    it("uses the placeholder when both title sources are blank", () => {
        expect(sessionTitle(makeSessionSummary("a", { name: null, firstMessage: " " }))).toEqual({
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
});

describe("session list helpers", () => {
    it("orders by creation time and then by id, regardless of activity", () => {
        const older = makeSessionSummary("b", { createdAtMs: 1_000, modifiedAtMs: 9_000 });
        const newer = makeSessionSummary("c", { createdAtMs: 5_000, modifiedAtMs: 1_000 });
        const tieA = makeSessionSummary("a", { createdAtMs: 5_000, modifiedAtMs: 3_000 });

        expect(sortSessions([older, newer, tieA]).map((session) => session.id)).toEqual(["a", "c", "b"]);
    });

    it("merges catalog patches into session rows", () => {
        const one = makeSessionSummary("one", { runtimeState: "idle" });
        const two = makeSessionSummary("two", { runtimeState: "starting" });

        const reducer = createCatalogSyncReducer();
        const afterSnap = reducer.applySnapshot(
            { sessions: [], updatedAtMs: null },
            { sessions: [one], updatedAtMs: 5_000 },
        );
        const afterUpsert = reducer.applyDelta(afterSnap, { op: "upsert", item: two });
        const afterPatch = reducer.applyDelta(afterUpsert, {
            op: "patch",
            id: sid("one"),
            patch: { runtimeState: "streaming", attachedClients: 1 },
        });
        const afterRemove = reducer.applyDelta(afterPatch, { op: "remove", id: sid("two") });

        expect(afterRemove).toEqual({
            sessions: [{ ...one, runtimeState: "streaming", attachedClients: 1 }],
            updatedAtMs: 5_000,
        });
    });
});

describe("buildWorkspaceModel", () => {
    it("returns an empty model before the first scan", () => {
        expect(
            buildWorkspaceModel({
                sessions: [],
                pins: [sid("a")],
                query: "a",
                selectedId: sid("a"),
                collapsed: ["/home/u/pivia"],
            }),
        ).toEqual({ pinned: [], folders: [], total: 0, matched: 0 });
    });

    it("moves pinned sessions out of their folders and keeps them filtered", () => {
        const sessions = [
            makeSessionSummary("pin-old", {
                cwd: "/only-pinned",
                name: "Older pin",
                createdAtMs: 1_000,
                modifiedAtMs: 9_000,
            }),
            makeSessionSummary("pin-new", {
                cwd: "/home/u/pivia",
                name: "Newer pin",
                createdAtMs: 5_000,
                modifiedAtMs: 1_000,
            }),
            makeSessionSummary("pin-tie-a", {
                cwd: "/home/u/pivia",
                name: "Pin tie A",
                createdAtMs: 3_000,
                modifiedAtMs: 7_000,
            }),
            makeSessionSummary("pin-tie-b", {
                cwd: "/home/u/pivia",
                name: "Pin tie B",
                createdAtMs: 3_000,
                modifiedAtMs: 1_000,
            }),
            makeSessionSummary("regular", { cwd: "/home/u/pivia", name: "Regular", createdAtMs: 2_000 }),
        ];

        const model = buildWorkspaceModel({
            sessions,
            pins: [sid("pin-old"), sid("pin-new"), sid("pin-tie-a"), sid("pin-tie-b")],
            query: "",
            selectedId: sid("pin-new"),
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

    it("groups by cwd and orders folders and rows by newest creation first", () => {
        const sessions = [
            makeSessionSummary("old", { cwd: "/home/u/alpha", name: "Alpha", createdAtMs: 1_500, modifiedAtMs: 9_000 }),
            makeSessionSummary("b", { cwd: "/home/u/beta", name: "Beta B", createdAtMs: 2_000, modifiedAtMs: 1_000 }),
            makeSessionSummary("a", { cwd: "/home/u/beta", name: "Beta A", createdAtMs: 2_000, modifiedAtMs: 5_000 }),
            makeSessionSummary("oldest", {
                cwd: "/home/u/beta",
                name: "Beta Old",
                createdAtMs: 1_000,
                modifiedAtMs: 8_000,
            }),
        ];

        const model = buildWorkspaceModel({
            sessions,
            pins: [],
            query: "   ",
            selectedId: sid("a"),
            collapsed: ["/home/u/alpha"],
        });

        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/beta", "/home/u/alpha"]);
        expect(model.folders[0]).toMatchObject({ cwd: "/home/u/beta", label: "beta", collapsed: false });
        expect(model.folders[0]?.sessions.map((row) => row.id)).toEqual(["a", "b", "oldest"]);
        expect(model.folders[0]?.sessions[0]?.selected).toBe(true);
        expect(model.folders[1]?.collapsed).toBe(true);
    });

    it("orders folders with the same newest creation time by cwd", () => {
        const model = buildWorkspaceModel({
            sessions: [
                makeSessionSummary("b", { cwd: "/home/u/beta", createdAtMs: 1_000, modifiedAtMs: 9_000 }),
                makeSessionSummary("a", { cwd: "/home/u/alpha", createdAtMs: 1_000, modifiedAtMs: 1_000 }),
            ],
            pins: [],
            query: "",
            selectedId: null,
            collapsed: [],
        });

        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/alpha", "/home/u/beta"]);
    });

    it("keeps rows in creation order when activity and attachments change", () => {
        const older = makeSessionSummary("older", { createdAtMs: 1_000 });
        const newer = makeSessionSummary("newer", { createdAtMs: 2_000 });
        const reducer = createCatalogSyncReducer();
        const before = reducer.applySnapshot(
            { sessions: [], updatedAtMs: null },
            { sessions: [newer, older], updatedAtMs: 0 },
        );
        const after = reducer.applyDelta(before, {
            op: "patch",
            id: sid("older"),
            patch: {
                modifiedAtMs: 9_000,
                messageCount: 2,
                runtimeState: "streaming",
                attachedClients: 1,
            },
        });
        const rowIds = (sessions: readonly SessionSummary[]): SessionId[] =>
            buildWorkspaceModel({ sessions, pins: [], query: "", selectedId: null, collapsed: [] }).folders.flatMap(
                (folder) => folder.sessions.map((row) => row.id),
            );

        expect(rowIds(before.sessions)).toEqual([sid("newer"), sid("older")]);
        expect(rowIds(after.sessions)).toEqual([sid("newer"), sid("older")]);
    });

    it("filters case-insensitively on name, first message and cwd, and expands matches", () => {
        const sessions = [
            makeSessionSummary("one", { cwd: "/home/u/pivia", name: "Parser Rewrite", firstMessage: "unused" }),
            makeSessionSummary("two", {
                cwd: "/home/u/docs",
                name: null,
                firstMessage: "Fix PARSER edge case",
                createdAtMs: 2_000,
                modifiedAtMs: 1_000,
            }),
            makeSessionSummary("three", {
                cwd: "/home/u/Parser-Lab",
                name: "Other",
                firstMessage: "Nothing",
                createdAtMs: 1_500,
                modifiedAtMs: 9_000,
            }),
            makeSessionSummary("four", { cwd: "/home/u/empty-match", name: "Unrelated", firstMessage: "Nothing" }),
        ];

        const model = buildWorkspaceModel({
            sessions,
            pins: [sid("one"), sid("four")],
            query: "  parser ",
            selectedId: null,
            collapsed: ["/home/u/docs", "/home/u/Parser-Lab"],
        });

        expect(model.pinned.map((row) => row.id)).toEqual(["one"]);
        expect(model.folders.map((folder) => folder.cwd)).toEqual(["/home/u/docs", "/home/u/Parser-Lab"]);
        expect(model.folders.map((folder) => folder.sessions.map((row) => row.id))).toEqual([["two"], ["three"]]);
        expect(model.folders.every((folder) => !folder.collapsed)).toBe(true);
        expect(model.total).toBe(4);
        expect(model.matched).toBe(3);
    });
});

describe("selectedSession", () => {
    it("returns null when no session is selected or found, and projects title metadata when matched", () => {
        const one = makeSessionSummary("one", {
            name: "  Named  ",
            cwd: "/repo/a",
            runtimeState: "streaming",
            attachedClients: 2,
        });
        expect(selectedSession([one], null)).toBeNull();
        expect(selectedSession([one], sid("missing"))).toBeNull();
        expect(selectedSession([one], sid("one"))).toEqual({
            id: sid("one"),
            title: "Named",
            named: true,
            cwd: "/repo/a",
            runtimeState: "streaming",
            attachedClients: 2,
        });
    });
});

describe("sessionRowStatus", () => {
    it.each([
        ["idle", 0, { kind: "idle", modifiedAtMs: 5_000 }],
        ["idle", 1, { kind: "active", state: "attached", label: "Attached" }],
        ["starting", 0, { kind: "active", state: "starting", label: "Starting" }],
        ["streaming", 1, { kind: "active", state: "streaming", label: "Streaming" }],
        ["compacting", 1, { kind: "active", state: "compacting", label: "Compacting" }],
        ["closing", 0, { kind: "active", state: "closing", label: "Closing" }],
    ] as const)("maps %s with %i attached clients to its display union", (runtimeState, attachedClients, expected) => {
        expect(sessionRowStatus({ runtimeState, attachedClients, modifiedAtMs: 5_000 })).toEqual(expected);
    });
});

describe("collectKnownCwds", () => {
    it("deduplicates non-empty cwds ordered by most recently created session first", () => {
        const sessions = [
            makeSessionSummary("a", { cwd: "/repo/old", createdAtMs: 1_000, modifiedAtMs: 9_000 }),
            makeSessionSummary("b", { cwd: "/repo/new", createdAtMs: 5_000, modifiedAtMs: 1_000 }),
            makeSessionSummary("c", { cwd: "/repo/old", createdAtMs: 3_000, modifiedAtMs: 2_000 }),
            makeSessionSummary("d", { cwd: "   ", createdAtMs: 9_000 }),
            makeSessionSummary("e", { cwd: "", createdAtMs: 8_000 }),
        ];

        expect(collectKnownCwds(sessions)).toEqual(["/repo/new", "/repo/old"]);
    });
});
