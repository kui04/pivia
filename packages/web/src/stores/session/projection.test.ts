import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { projectSessionTranscript } from "./projection";

const HEADER: SessionHeader = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T00:00:00.000Z",
    cwd: "/tmp/project",
};

function userEntry(id: string, parentId: string | null, text: string): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:01.000Z",
        message: { role: "user", content: text, timestamp: 1 },
    };
}

function assistantEntry(id: string, parentId: string | null, text: string): SessionEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "test",
            provider: "test",
            model: "test",
            usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 2,
        },
    };
}

describe("projectSessionTranscript", () => {
    it("handles header-only sessions and explicit null leafId", () => {
        expect(projectSessionTranscript([HEADER])).toEqual([]);
        expect(projectSessionTranscript([HEADER, userEntry("u1", null, "hi")], { leafId: null })).toEqual([]);
    });

    it("walks the active branch from leafId and breaks cyclic parentId chains", () => {
        const u1 = userEntry("u1", null, "root");
        const a1 = assistantEntry("a1", "u1", "branch A");
        const a2 = assistantEntry("a2", "u1", "branch B");
        const branchSummary: SessionEntry = {
            type: "branch_summary",
            id: "bs1",
            parentId: "a2",
            fromId: "a1",
            summary: "abandoned branch A",
            timestamp: "2026-04-01T00:00:03.000Z",
        };

        const items = projectSessionTranscript([HEADER, u1, a1, a2, branchSummary]);
        expect(items.map((item) => item.entry.id)).toEqual(["u1", "a2", "bs1"]);

        const branchA = projectSessionTranscript([HEADER, u1, a1, a2, branchSummary], { leafId: "a1" });
        expect(branchA.map((item) => item.entry.id)).toEqual(["u1", "a1"]);

        // Cyclic entries must terminate instead of looping infinitely.
        const cyc1 = userEntry("c1", "c2", "one");
        const cyc2 = assistantEntry("c2", "c1", "two");
        const cyclic = projectSessionTranscript([HEADER, cyc1, cyc2]);
        expect(cyclic.map((item) => item.entry.id)).toEqual(["c1", "c2"]);
    });

    it("folds compaction boundaries, omits pre-compaction system messages, and handles self-kept compactions", () => {
        const sys: SessionEntry = {
            type: "message",
            id: "sys",
            parentId: null,
            timestamp: "2026-04-01T00:00:00.500Z",
            message: { role: "system", content: "old system prompt", timestamp: 0 } as never,
        };
        const u1 = userEntry("u1", "sys", "old question");
        const u2 = userEntry("u2", "u1", "kept question");
        const a2 = assistantEntry("a2", "u2", "kept answer");
        const compaction: SessionEntry = {
            type: "compaction",
            id: "comp-1",
            parentId: "a2",
            summary: "earlier summary",
            firstKeptEntryId: "u2",
            tokensBefore: 500,
            timestamp: "2026-04-01T00:00:03.000Z",
        };
        const u3 = userEntry("u3", "comp-1", "after compaction");

        const items = projectSessionTranscript([HEADER, sys, u1, u2, a2, compaction, u3]);
        expect(items.map((item) => item.entry.id)).toEqual(["comp-1", "u2", "a2", "u3"]);
        expect(items[0]).toEqual({ kind: "compaction", entry: compaction });

        // System message at or after firstKeptEntryId before compaction is excluded from active items.
        const sysKept: SessionEntry = {
            type: "message",
            id: "sys-kept",
            parentId: "u2",
            timestamp: "2026-04-01T00:00:02.100Z",
            message: { role: "system", content: "mid system", timestamp: 1 } as never,
        };
        const a2AfterSys = assistantEntry("a2s", "sys-kept", "kept answer");
        const compWithSys: SessionEntry = { ...compaction, parentId: "a2s" };
        const projSys = projectSessionTranscript([HEADER, u1, u2, sysKept, a2AfterSys, compWithSys]);
        expect(projSys.map((item) => item.entry.id)).toEqual(["comp-1", "u2", "a2s"]);

        // firstKeptEntryId === compaction.id keeps zero pre-compaction entries.
        const selfKept: SessionEntry = {
            type: "compaction",
            id: "comp-self",
            parentId: "u1",
            summary: "full reset",
            firstKeptEntryId: "comp-self",
            tokensBefore: 100,
            timestamp: "2026-04-01T00:00:04.000Z",
        };
        const selfProj = projectSessionTranscript([HEADER, u1, selfKept]);
        expect(selfProj).toEqual([{ kind: "compaction", entry: selfKept }]);
    });

    it("applies context_edit omissions and replacements", () => {
        const u1 = userEntry("u1", null, "first");
        const a1 = assistantEntry("a1", "u1", "bad response");
        const a2 = assistantEntry("a2", "a1", "editable response");
        const omitA1: SessionEntry = {
            type: "context_edit",
            id: "ce1",
            parentId: "a2",
            targetId: "a1",
            replacement: null,
            timestamp: "2026-04-01T00:00:03.000Z",
        };
        const replaceA2: SessionEntry = {
            type: "context_edit",
            id: "ce2",
            parentId: "ce1",
            targetId: "a2",
            replacement: { content: "edited text" },
            timestamp: "2026-04-01T00:00:04.000Z",
        };

        const items = projectSessionTranscript([HEADER, u1, a1, a2, omitA1, replaceA2]);
        const renderedIds = items.map((item) => item.entry.id);
        expect(renderedIds).not.toContain("a1");

        const itemA2 = items.find((item) => item.entry.id === "a2");
        expect(itemA2).toMatchObject({
            kind: "entry",
            editedContent: [{ type: "text", text: "edited text" }],
        });
    });

    it("reports no edited content for entries the SDK never rewrites", () => {
        const system: SessionEntry = {
            type: "message",
            id: "sys",
            parentId: null,
            timestamp: "2026-04-01T00:00:01.000Z",
            message: { role: "system", content: "system prompt", timestamp: 1 },
        };
        const editSystem: SessionEntry = {
            type: "context_edit",
            id: "ce1",
            parentId: "sys",
            targetId: "sys",
            replacement: { content: "replaced" },
            timestamp: "2026-04-01T00:00:02.000Z",
        };
        const thinking: SessionEntry = {
            type: "thinking_level_change",
            id: "th1",
            parentId: "ce1",
            thinkingLevel: "high",
            timestamp: "2026-04-01T00:00:03.000Z",
        };
        const editThinking: SessionEntry = {
            type: "context_edit",
            id: "ce2",
            parentId: "th1",
            targetId: "th1",
            replacement: { content: "replaced" },
            timestamp: "2026-04-01T00:00:04.000Z",
        };

        const items = projectSessionTranscript([HEADER, system, editSystem, thinking, editThinking]);

        // `projectContextEntry` keeps both entries unchanged, so the UI must not claim an edit.
        for (const item of items) {
            expect(item).not.toHaveProperty("editedContent");
        }
    });
});
