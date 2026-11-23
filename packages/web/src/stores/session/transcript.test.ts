import type { AssistantMessage, FileEntry } from "@pivia/protocol";
import { projectSessionTranscript } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { buildTranscript, describeToolCall, formatToolDuration, formatTurnDuration } from "./transcript";

const EMPTY_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const HEADER: FileEntry = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T00:00:00.000Z",
    cwd: "/tmp/pivia",
};

function userEntry(id: string, parentId: string | null, text: string, timestamp: number): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: new Date(timestamp).toISOString(),
        message: { role: "user", content: text, timestamp },
    };
}

function assistantEntry(
    id: string,
    parentId: string | null,
    content: AssistantMessage["content"],
    overrides: Partial<AssistantMessage> = {},
): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content,
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "stop",
            timestamp: 2_000,
            ...overrides,
        },
    };
}

function toolResultEntry(id: string, parentId: string | null, toolCallId: string, output: string): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:02.500Z",
        message: {
            role: "toolResult",
            toolCallId,
            toolName: "bash",
            content: [{ type: "text", text: output }],
            isError: false,
            timestamp: 2_500,
        },
    };
}

/**
 * Build an assistant entry with content the SDK type forbids.
 *
 * A hand-edited or legacy session file can hold holes, non-string fields or a non-array content
 * value; the assertion is the point of the test, which checks that the view still renders.
 */
function corruptAssistantEntry(content: unknown): FileEntry {
    return {
        type: "message",
        id: "bad",
        parentId: "m1",
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content,
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "stop",
            timestamp: 2_000,
        },
    } as FileEntry;
}

/** Build a tool result whose content violates the SDK type, to test the render boundary. */
function corruptToolResultEntry(content: unknown): FileEntry {
    return {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-04-01T00:00:02.500Z",
        message: {
            role: "toolResult",
            toolCallId: "call-r",
            toolName: "read",
            content,
            isError: false,
            timestamp: 2_500,
        },
    } as FileEntry;
}

function project(entries: readonly FileEntry[]) {
    return projectSessionTranscript([HEADER, ...entries]).items;
}

function turnOf(items: ReturnType<typeof buildTranscript>, index: number) {
    const item = items[index];
    if (item?.kind !== "turn") {
        throw new Error(`Expected a turn at index ${index}`);
    }
    return item;
}

function toolStepOf(items: ReturnType<typeof buildTranscript>, index: number, stepIndex: number) {
    const step = turnOf(items, index).steps[stepIndex];
    if (step?.kind !== "toolCall") {
        throw new Error(`Expected a tool call step at index ${stepIndex}`);
    }
    return step;
}

describe("buildTranscript", () => {
    it("groups multi-round agent work into one turn and keeps only the final reply outside", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Submit the change", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [
                        { type: "thinking", thinking: "Check the repository status first." },
                        { type: "text", text: "Checking repository status." },
                        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } },
                    ],
                    { timestamp: 1_500, stopReason: "toolUse" },
                ),
                toolResultEntry("m3", "m2", "call-1", "clean"),
                assistantEntry(
                    "m4",
                    "m3",
                    [
                        { type: "thinking", thinking: "The tree is clean; present the result." },
                        { type: "text", text: "Committed as `b8a713e`." },
                    ],
                    { timestamp: 2_000, durationMs: 10_200 },
                ),
            ]),
        );

        expect(items).toHaveLength(2);
        expect(items[0]).toEqual({
            kind: "user",
            id: "user-m1",
            text: "Submit the change",
            images: [],
            timestamp: 1_000,
        });

        const turn = turnOf(items, 1);
        expect(turn.id).toBe("turn-1500");
        expect(turn.finalReply).toBe("Committed as `b8a713e`.");
        expect(turn.errorMessage).toBeNull();
        expect(turn.timing).toEqual({ kind: "static", durationMs: 11_200 });
        expect(turn.streaming).toBe(false);
        expect(turn.steps.map((step) => step.kind)).toEqual(["thinking", "reply", "toolCall", "thinking"]);
        expect(turn.steps[1]).toMatchObject({ kind: "reply", text: "Checking repository status." });
        expect(toolStepOf(items, 1, 2)).toMatchObject({
            id: "call-1",
            toolKind: "bash",
            label: "Bash",
            summary: "git status",
            status: "done",
            output: "clean",
            timing: { kind: "static", durationMs: 1_000 },
        });
    });

    it("prefers context_edit replacement content over the stored entry content", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Original prompt", 1_000),
                assistantEntry("m2", "m1", [{ type: "text", text: "Original answer" }], { timestamp: 2_000 }),
                {
                    type: "context_edit",
                    id: "e1",
                    parentId: "m2",
                    timestamp: "2026-04-01T00:00:03.000Z",
                    targetId: "m1",
                    replacement: { content: "Edited prompt" },
                },
                {
                    type: "context_edit",
                    id: "e2",
                    parentId: "e1",
                    timestamp: "2026-04-01T00:00:04.000Z",
                    targetId: "m2",
                    replacement: { content: "Edited answer" },
                },
            ]),
        );

        expect(items[0]).toMatchObject({ kind: "user", text: "Edited prompt" });
        expect(turnOf(items, 1).finalReply).toBe("Edited answer");
    });

    it("renders a compaction checkpoint as a note and keeps the entries after its boundary", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Dropped old prompt", 1_000),
                userEntry("m2", "m1", "Kept prompt", 2_000),
                assistantEntry("m3", "m2", [{ type: "text", text: "Kept answer" }], { timestamp: 3_000 }),
                {
                    type: "compaction",
                    id: "c1",
                    parentId: "m3",
                    timestamp: "2026-04-01T00:00:04.000Z",
                    summary: "Earlier context",
                    firstKeptEntryId: "m2",
                    tokensBefore: 1_200,
                },
                userEntry("m4", "c1", "Next prompt", 5_000),
            ]),
        );

        expect(items[0]).toEqual({ kind: "note", id: "note-c1", title: "Session compacted", text: "Earlier context" });
        expect(items[1]).toMatchObject({ kind: "user", text: "Kept prompt" });
        expect(turnOf(items, 2).finalReply).toBe("Kept answer");
        expect(items[3]).toMatchObject({ kind: "user", text: "Next prompt" });
    });

    it("renders a branch summary as its own note", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Prompt", 1_000),
                {
                    type: "branch_summary",
                    id: "b1",
                    parentId: "m1",
                    timestamp: "2026-04-01T00:00:02.000Z",
                    fromId: "m1",
                    summary: "Abandoned branch explored another layout.",
                },
            ]),
        );

        expect(items).toEqual([
            { kind: "user", id: "user-m1", text: "Prompt", images: [], timestamp: 1_000 },
            {
                kind: "note",
                id: "note-b1",
                title: "Branch summary",
                text: "Abandoned branch explored another layout.",
            },
        ]);
    });

    it("renders only displayed extension messages as user bubbles", () => {
        const items = buildTranscript(
            project([
                {
                    type: "custom_message",
                    id: "c1",
                    parentId: null,
                    timestamp: "2026-04-01T00:00:01.000Z",
                    customType: "task",
                    content: "Visible extension message",
                    display: true,
                },
                {
                    type: "custom_message",
                    id: "c2",
                    parentId: "c1",
                    timestamp: "2026-04-01T00:00:02.000Z",
                    customType: "task",
                    content: "Hidden extension message",
                    display: false,
                },
            ]),
        );

        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            kind: "user",
            text: "Visible extension message",
            timestamp: Date.parse("2026-04-01T00:00:01.000Z"),
        });
    });

    it("appends the live assistant message and marks the trailing block as streaming", () => {
        const live: AssistantMessage = {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "Finished thought" },
                { type: "text", text: "Streaming answer" },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "pending",
            timestamp: 10_500,
        };

        const items = buildTranscript(project([userEntry("m1", null, "Explain", 10_000)]), {
            liveMessage: live,
            runtimeActive: true,
        });

        const turn = turnOf(items, 1);
        expect(turn.streaming).toBe(true);
        expect(turn.timing).toEqual({ kind: "since", startedAtMs: 10_000 });
        // A pending text-only answer is the final reply; its Markdown streams with the turn flag.
        expect(turn.finalReply).toBe("Streaming answer");
        expect(turn.steps.map((step) => step.kind)).toEqual(["thinking"]);
        expect(turn.steps[0]).toMatchObject({ kind: "thinking", streaming: false });
    });

    it("does not animate a live message after the runtime stops streaming", () => {
        const live: AssistantMessage = {
            role: "assistant",
            content: [{ type: "text", text: "Partial answer" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "pending",
            timestamp: 2_000,
        };

        const items = buildTranscript(project([userEntry("m1", null, "Explain", 1_000)]), {
            liveMessage: live,
            runtimeActive: false,
        });

        const turn = turnOf(items, 1);
        expect(turn.streaming).toBe(false);
        expect(turn.finalReply).toBe("Partial answer");
        expect(turn.steps).toEqual([]);
        expect(turn.timing).toEqual({ kind: "static", durationMs: 1_000 });
    });

    it("keeps one turn when the live message already landed as a persisted entry", () => {
        const persisted = assistantEntry("m2", "m1", [{ type: "text", text: "Final answer" }], { timestamp: 2_000 });
        const entries = project([userEntry("m1", null, "Explain", 1_000), persisted]);

        const items = buildTranscript(entries, {
            liveMessage: {
                role: "assistant",
                content: [{ type: "text", text: "Final answer" }],
                api: "test",
                provider: "test",
                model: "test",
                usage: EMPTY_USAGE,
                stopReason: "stop",
                timestamp: 2_000,
            },
            runtimeActive: false,
        });

        expect(items).toHaveLength(2);
        expect(turnOf(items, 1).finalReply).toBe("Final answer");
    });

    it("keeps a tool call without a result running and reports its live duration", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run the suite", 10_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "call-run", name: "bash", arguments: { command: "pnpm test" } }],
                    { timestamp: 10_500, stopReason: "toolUse" },
                ),
            ]),
            { runtimeActive: true },
        );

        const turn = turnOf(items, 1);
        expect(turn.streaming).toBe(true);
        expect(turn.finalReply).toBeNull();
        expect(turn.timing).toEqual({ kind: "since", startedAtMs: 10_000 });
        expect(turn.steps[0]).toMatchObject({
            kind: "toolCall",
            status: "running",
            timing: { kind: "since", startedAtMs: 10_500 },
        });
    });

    it("marks a tool call aborted by an aborted assistant message as an error without a duration", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run the suite", 10_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "call-abort", name: "bash", arguments: { command: "pnpm test" } }],
                    { timestamp: 10_500, stopReason: "aborted" },
                ),
            ]),
            { runtimeActive: true },
        );

        expect(toolStepOf(items, 1, 0)).toMatchObject({
            status: "error",
            timing: { kind: "static", durationMs: null },
        });
    });

    it("falls back to timestamps for completed tool durations and marks result errors", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Read the file", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "call-err", name: "read", arguments: { path: "a.ts" } }],
                    {
                        timestamp: 2_000,
                        stopReason: "toolUse",
                    },
                ),
                {
                    type: "message",
                    id: "m3",
                    parentId: "m2",
                    timestamp: "2026-04-01T00:00:02.700Z",
                    message: {
                        role: "toolResult",
                        toolCallId: "call-err",
                        toolName: "read",
                        content: [{ type: "text", text: "ENOENT" }],
                        isError: true,
                        timestamp: 2_700,
                    },
                },
                assistantEntry("m4", "m3", [{ type: "text", text: "File not found." }], { timestamp: 3_000 }),
            ]),
        );

        expect(toolStepOf(items, 1, 0)).toMatchObject({
            status: "error",
            output: "ENOENT",
            timing: { kind: "static", durationMs: 700 },
        });
        expect(turnOf(items, 1).timing).toEqual({ kind: "static", durationMs: 2_000 });
    });

    it("surfaces the assistant error message when the turn ends with an error stop reason", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Hello", 1_000),
                assistantEntry("m2", "m1", [], {
                    timestamp: 1_500,
                    stopReason: "error",
                    errorMessage: "529 overloaded",
                }),
            ]),
        );

        const turn = turnOf(items, 1);
        expect(turn.finalReply).toBeNull();
        expect(turn.errorMessage).toBe("529 overloaded");
        expect(turn.streaming).toBe(false);
    });

    it("reports a generic assistant failure when an error has no message", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Hello", 1_000),
                assistantEntry("m2", "m1", [], { timestamp: 1_500, stopReason: "error" }),
            ]),
        );

        expect(turnOf(items, 1).errorMessage).toBe("Assistant request failed");
    });

    it("keeps intermediate text inside the timeline when the last message still carries a tool call", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run tests", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [
                        { type: "text", text: "Running the suite now." },
                        { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "pnpm test" } },
                    ],
                    { timestamp: 1_200, stopReason: "toolUse" },
                ),
            ]),
        );

        const turn = turnOf(items, 1);
        expect(turn.finalReply).toBeNull();
        expect(turn.steps.map((step) => step.kind)).toEqual(["reply", "toolCall"]);
    });
});

describe("buildTranscript boundary handling", () => {
    it("keeps an unmatched tool call running only in the trailing turn of an active runtime", () => {
        const pendingCall = assistantEntry(
            "m2",
            "m1",
            [{ type: "toolCall", id: "call-pending", name: "bash", arguments: { command: "pnpm test" } }],
            { timestamp: 2_000, stopReason: "toolUse" },
        );

        const active = buildTranscript(project([userEntry("m1", null, "Run", 1_000), pendingCall]), {
            runtimeActive: true,
        });
        expect(toolStepOf(active, 1, 0)).toMatchObject({ status: "running" });
        expect(turnOf(active, 1).streaming).toBe(true);

        const idle = buildTranscript(project([userEntry("m1", null, "Run", 1_000), pendingCall]), {
            runtimeActive: false,
        });
        expect(toolStepOf(idle, 1, 0)).toMatchObject({ status: "error" });
        expect(turnOf(idle, 1).streaming).toBe(false);
    });

    it("never reports a historical unmatched tool call as running", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "call-lost", name: "bash", arguments: { command: "pnpm test" } }],
                    { timestamp: 2_000, stopReason: "toolUse" },
                ),
                userEntry("m3", "m2", "Never mind", 3_000),
                assistantEntry("m4", "m3", [{ type: "text", text: "Stopped." }], { timestamp: 4_000 }),
            ]),
            { runtimeActive: true },
        );

        expect(toolStepOf(items, 1, 0)).toMatchObject({ status: "error" });
        expect(turnOf(items, 1).streaming).toBe(false);
        expect(turnOf(items, 3).streaming).toBe(false);
    });

    it("keeps turn and step ids stable when the live message becomes a persisted entry", () => {
        const live: AssistantMessage = {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "Plan the change." },
                { type: "text", text: "Working on it." },
                { type: "toolCall", id: "call-stable", name: "bash", arguments: { command: "pnpm test" } },
            ],
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "toolUse",
            timestamp: 2_000,
        };
        const entries = project([userEntry("m1", null, "Run", 1_000)]);

        const streamingItems = buildTranscript(entries, { liveMessage: live, runtimeActive: true });
        const persistedItems = buildTranscript(
            project([
                userEntry("m1", null, "Run", 1_000),
                assistantEntry("m2", "m1", live.content, { timestamp: 2_000, stopReason: "toolUse" }),
            ]),
            { runtimeActive: true },
        );

        expect(turnOf(streamingItems, 1).id).toBe(turnOf(persistedItems, 1).id);
        expect(turnOf(streamingItems, 1).steps.map((step) => step.id)).toEqual(
            turnOf(persistedItems, 1).steps.map((step) => step.id),
        );
    });

    it("drops sparse holes and malformed blocks instead of throwing", () => {
        const blocks: unknown[] = [];
        blocks.length = 4;
        blocks[1] = { type: "toolCall", id: "call-x", name: "bash", arguments: null };
        blocks[2] = { type: "thinking", thinking: 42 };
        blocks[3] = { type: "text", text: "Kept reply" };

        const items = buildTranscript(project([userEntry("m1", null, "Run", 1_000), corruptAssistantEntry(blocks)]), {
            runtimeActive: true,
        });

        const turn = turnOf(items, 1);
        expect(turn.steps.map((step) => step.kind)).toEqual(["toolCall", "reply"]);
        expect(toolStepOf(items, 1, 0)).toMatchObject({ status: "running", arguments: {} });
        expect(turn.steps[1]).toMatchObject({ kind: "reply", text: "Kept reply" });
    });

    it("reads a non-array assistant content as plain text", () => {
        const items = buildTranscript(
            project([userEntry("m1", null, "Explain", 1_000), corruptAssistantEntry("Plain replacement")]),
        );

        expect(turnOf(items, 1).finalReply).toBe("Plain replacement");
    });

    it("ignores an edited tool result whose content is not an array", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Read", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "call-r", name: "read", arguments: { path: "a" } }],
                    {
                        timestamp: 2_000,
                        stopReason: "toolUse",
                    },
                ),
                corruptToolResultEntry(null),
            ]),
        );

        expect(toolStepOf(items, 1, 0)).toMatchObject({ status: "done", output: "", images: [] });
    });
});

describe("describeToolCall", () => {
    it("classifies built-in tools with labels and single-line summaries", () => {
        expect(describeToolCall("bash", { command: "git status\n  --short" })).toEqual({
            kind: "bash",
            label: "Bash",
            summary: "git status --short",
        });
        expect(describeToolCall("powershell", { command: "Get-ChildItem   -Force" })).toEqual({
            kind: "powershell",
            label: "PowerShell",
            summary: "Get-ChildItem -Force",
        });
        expect(describeToolCall("read", { path: "src/main.tsx" })).toEqual({
            kind: "read",
            label: "Read",
            summary: "src/main.tsx",
        });
        expect(describeToolCall("write", { path: "plan.md" })).toEqual({
            kind: "write",
            label: "Write",
            summary: "plan.md",
        });
        expect(describeToolCall("edit", { path: "src/App.tsx" })).toEqual({
            kind: "edit",
            label: "Edit",
            summary: "src/App.tsx",
        });
        expect(describeToolCall("grep", { pattern: "useSessionStore", path: "src" })).toEqual({
            kind: "grep",
            label: "Grep",
            summary: "useSessionStore in src",
        });
        expect(describeToolCall("find", { pattern: "*.stories.tsx" })).toEqual({
            kind: "find",
            label: "Find",
            summary: "*.stories.tsx",
        });
        expect(describeToolCall("ls", {})).toEqual({ kind: "ls", label: "Ls", summary: "." });
        expect(describeToolCall("codemode", { code: "\n  // run checks\n  return 1;" })).toEqual({
            kind: "codemode",
            label: "Codemode",
            summary: "// run checks",
        });
        expect(describeToolCall("tool_search", { query: "github pull request" })).toEqual({
            kind: "tool_search",
            label: "Tool search",
            summary: "github pull request",
        });
    });

    it("falls back to generic with the original name and first scalar argument", () => {
        expect(
            describeToolCall("mcp__github__get_issue", { nested: { ignored: true }, issue_number: 42, repo: "pivia" }),
        ).toEqual({ kind: "generic", label: "mcp__github__get_issue", summary: "42" });
        expect(describeToolCall("custom_ping", {})).toEqual({ kind: "generic", label: "custom_ping", summary: "" });
    });
});

describe("formatTurnDuration and formatToolDuration", () => {
    it("formats turn durations across second and minute boundaries", () => {
        expect(formatTurnDuration(0)).toBe("0s");
        expect(formatTurnDuration(100)).toBe("0s");
        expect(formatTurnDuration(2_740)).toBe("3s");
        expect(formatTurnDuration(11_200)).toBe("11s");
        expect(formatTurnDuration(60_000)).toBe("1m");
        expect(formatTurnDuration(125_000)).toBe("2m 5s");
    });

    it("formats tool durations with tenths under one minute and minutes above", () => {
        expect(formatToolDuration(0)).toBe("0.0s");
        expect(formatToolDuration(100)).toBe("0.1s");
        expect(formatToolDuration(2_740)).toBe("2.7s");
        expect(formatToolDuration(11_200)).toBe("11.2s");
        expect(formatToolDuration(60_000)).toBe("1m");
        expect(formatToolDuration(125_000)).toBe("2m 5s");
    });
});
