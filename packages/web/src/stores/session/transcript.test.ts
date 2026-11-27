import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { projectSessionTranscript } from "./projection";
import { buildTranscript, describeToolCall } from "./transcript";

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

/** Build a user entry as the terminal client writes an expanded `/skill:` command. */
function skillEntry(id: string, parentId: string | null, name: string, prompt: string | null): FileEntry {
    const block = `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n# ${name}\n</skill>`;
    return userEntry(id, parentId, prompt === null ? block : `${block}\n\n${prompt}`, 1_000);
}

type BashOverrides = Partial<{
    command: string;
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath: string;
    excludeFromContext: boolean;
}>;

/** Build a user `!` command record as the session appends it after the command ends. */
function bashEntry(id: string, parentId: string | null, overrides: BashOverrides = {}): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:01.500Z",
        message: {
            role: "bashExecution",
            command: "git status",
            output: "clean",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: 1_500,
            ...overrides,
        },
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

/**
 * Build an assistant entry whose stop reason violates the SDK type.
 *
 * A session written by another Pi version or edited by hand can hold a reason this build does not
 * know; the view must degrade one turn instead of failing the render.
 */
function corruptStopReasonEntry(stopReason: unknown): FileEntry {
    return {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content: [{ type: "text", text: "Partial answer" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason,
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

type CustomContent =
    | string
    | (
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "image"; readonly data: string; readonly mimeType: string }
      )[];

type CustomOverrides = Partial<{
    customType: string;
    display: boolean;
    timestamp: string;
}>;

/** Build an extension message the session appends for `sendCustomMessage`. */
function customMessageEntry(
    id: string,
    parentId: string | null,
    content: CustomContent,
    overrides: CustomOverrides = {},
): FileEntry {
    return {
        type: "custom_message",
        id,
        parentId,
        timestamp: overrides.timestamp ?? "2026-04-01T00:00:01.000Z",
        customType: overrides.customType ?? "task",
        content,
        display: overrides.display ?? true,
    };
}

/** Build an extension message whose label and content violate the SDK type, to test the boundary. */
function corruptCustomMessageEntry(customType: unknown, content: unknown): FileEntry {
    return {
        type: "custom_message",
        id: "c-bad",
        parentId: null,
        timestamp: "2026-04-01T00:00:01.000Z",
        customType,
        content,
        display: true,
    } as FileEntry;
}

/** Build a prompt whose timestamp violates the SDK type, to test the boundary. */
function corruptUserMessageEntry(timestamp: unknown): FileEntry {
    return {
        type: "message",
        id: "m-bad",
        parentId: null,
        timestamp: "2026-04-01T00:00:01.000Z",
        message: { role: "user", content: "Hello", timestamp },
    } as FileEntry;
}

function project(entries: readonly FileEntry[]) {
    return projectSessionTranscript([HEADER, ...entries]);
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
        });

        const turn = turnOf(items, 1);
        expect(turn.id).toBe("turn-1500");
        expect(turn.finalReply).toBe("Committed as `b8a713e`.");
        expect(turn.outcome).toEqual({ kind: "completed" });
        expect(turn.timing).toEqual({ kind: "static", durationMs: 11_200 });
        expect(turn.streaming).toBe(false);
        expect(turn.steps.map((step) => step.kind)).toEqual(["thinking", "reply", "toolCall", "thinking"]);
        expect(turn.steps[1]).toMatchObject({ kind: "reply", text: "Checking repository status." });
        expect(toolStepOf(items, 1, 2)).toMatchObject({
            id: "call-1",
            toolKind: "bash",
            toolName: "bash",
            summary: "git status",
            status: "done",
            output: "clean",
            preview: { kind: "none" },
            warnings: [],
            timing: { kind: "static", durationMs: 1_000 },
        });
    });

    it("attaches edit diff previews, write code previews, read previews and tool truncation warnings", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Update files", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [
                        { type: "toolCall", id: "call-edit", name: "edit", arguments: { path: "src/App.tsx" } },
                        {
                            type: "toolCall",
                            id: "call-write",
                            name: "write",
                            arguments: { path: "src/new.ts", content: "export const x = 1;\n" },
                        },
                        {
                            type: "toolCall",
                            id: "call-bash",
                            name: "bash",
                            arguments: { command: "cat big.log" },
                        },
                    ],
                    { timestamp: 1_500, stopReason: "toolUse" },
                ),
                {
                    type: "message",
                    id: "m3",
                    parentId: "m2",
                    timestamp: "2026-04-01T00:00:02.000Z",
                    message: {
                        role: "toolResult",
                        toolCallId: "call-edit",
                        toolName: "edit",
                        content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/App.tsx." }],
                        details: {
                            diff: "-1 const a = 1;\n+1 const a = 2;",
                            patch: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
                        },
                        isError: false,
                        timestamp: 2_000,
                    },
                },
                {
                    type: "message",
                    id: "m4",
                    parentId: "m3",
                    timestamp: "2026-04-01T00:00:02.100Z",
                    message: {
                        role: "toolResult",
                        toolCallId: "call-write",
                        toolName: "write",
                        content: [{ type: "text", text: "Successfully wrote to src/new.ts" }],
                        isError: false,
                        timestamp: 2_100,
                    },
                },
                {
                    type: "message",
                    id: "m5",
                    parentId: "m4",
                    timestamp: "2026-04-01T00:00:02.200Z",
                    message: {
                        role: "toolResult",
                        toolCallId: "call-bash",
                        toolName: "bash",
                        content: [{ type: "text", text: "tail output" }],
                        details: {
                            fullOutputPath: "/tmp/bash-full.log",
                            truncation: {
                                content: "tail output",
                                truncated: true,
                                truncatedBy: "lines",
                                totalLines: 5000,
                                totalBytes: 80_000,
                                outputLines: 2000,
                                outputBytes: 30_000,
                                lastLinePartial: false,
                                firstLineExceedsLimit: false,
                                maxLines: 2000,
                                maxBytes: 50 * 1024,
                            },
                        },
                        isError: false,
                        timestamp: 2_200,
                    },
                },
            ]),
        );

        expect(toolStepOf(items, 1, 0).preview).toEqual({
            kind: "diff",
            diff: "--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
        });
        expect(toolStepOf(items, 1, 1).preview).toEqual({
            kind: "code",
            code: "export const x = 1;",
            language: "typescript",
            startLine: 1,
        });
        expect(toolStepOf(items, 1, 2).warnings).toEqual([
            { kind: "fullOutput", path: "/tmp/bash-full.log" },
            { kind: "notice", message: "Truncated: showing 2000 of 5000 lines" },
        ]);
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

        expect(items[0]).toEqual({
            kind: "note",
            id: "note-c1",
            title: "Compaction",
            text: "Earlier context",
            tokensBefore: 1_200,
        });
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
            { kind: "user", id: "user-m1", text: "Prompt", images: [] },
            {
                kind: "note",
                id: "note-b1",
                title: "Branch summary",
                text: "Abandoned branch explored another layout.",
            },
        ]);
    });

    it("renders only displayed extension messages, labeled with their custom type", () => {
        const items = buildTranscript(
            project([
                customMessageEntry("c1", null, "Visible extension message"),
                customMessageEntry("c2", "c1", "Hidden extension message", { display: false }),
            ]),
        );

        expect(items).toEqual([
            {
                kind: "custom",
                id: "custom-c1",
                customType: "task",
                text: "Visible extension message",
                images: [],
            },
        ]);
    });

    it("keeps attachments on an extension message that carries no text", () => {
        const items = buildTranscript(
            project([customMessageEntry("c1", null, [{ type: "image", data: "AAAA", mimeType: "image/png" }])]),
        );

        expect(items).toEqual([
            {
                kind: "custom",
                id: "custom-c1",
                customType: "task",
                text: "",
                images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
            },
        ]);
    });

    it("prefers a context_edit replacement over the stored extension message", () => {
        const items = buildTranscript(
            project([
                customMessageEntry("c1", null, "Original extension text"),
                {
                    type: "context_edit",
                    id: "e1",
                    parentId: "c1",
                    timestamp: "2026-04-01T00:00:03.000Z",
                    targetId: "c1",
                    replacement: { content: "Edited extension text" },
                },
            ]),
        );

        expect(items).toMatchObject([{ kind: "custom", text: "Edited extension text" }]);
    });

    it("degrades a corrupt extension record instead of dropping it", () => {
        const items = buildTranscript(project([corruptCustomMessageEntry(undefined, { text: "not content" })]));

        expect(items).toEqual([
            {
                kind: "custom",
                id: "custom-c-bad",
                customType: "extension",
                text: "",
                images: [],
            },
        ]);
    });

    it("does not seed the next turn from an unreadable extension timestamp", () => {
        const items = buildTranscript(
            project([
                customMessageEntry("c1", null, "Note", { timestamp: "not-a-date" }),
                assistantEntry("m2", "c1", [{ type: "text", text: "Answer" }], { timestamp: 2_000 }),
            ]),
        );

        expect(items[0]).toMatchObject({ kind: "custom" });
        expect(turnOf(items, 1).timing).toEqual({ kind: "static", durationMs: 0 });
    });

    it("does not seed the next turn from an unreadable prompt timestamp", () => {
        const items = buildTranscript(
            project([
                corruptUserMessageEntry(Number.NaN),
                assistantEntry("m2", "m-bad", [{ type: "text", text: "Answer" }], { timestamp: 2_000 }),
            ]),
        );

        expect(items[0]).toMatchObject({ kind: "user" });
        expect(turnOf(items, 1).timing).toEqual({ kind: "static", durationMs: 0 });
    });

    it("ends the pending turn at an extension message and seeds the next duration", () => {
        const start = Date.parse("2026-04-01T00:00:01.000Z");
        const items = buildTranscript(
            project([
                userEntry("m1", null, "First prompt", start),
                assistantEntry("m2", "m1", [{ type: "text", text: "First answer" }], { timestamp: start + 500 }),
                customMessageEntry("c1", "m2", "Extension note", {
                    timestamp: "2026-04-01T00:00:03.000Z",
                }),
                assistantEntry("m4", "c1", [{ type: "text", text: "Second answer" }], { timestamp: start + 4_000 }),
            ]),
        );

        expect(items.map((item) => item.kind)).toEqual(["user", "turn", "custom", "turn"]);
        expect(turnOf(items, 1).timing).toEqual({ kind: "static", durationMs: 500 });
        expect(turnOf(items, 3).timing).toEqual({ kind: "static", durationMs: 2_000 });
    });

    it("splits a skill invocation into its own block before the typed prompt", () => {
        const items = buildTranscript(
            project([
                skillEntry("m1", null, "tydd", "Review this diff"),
                assistantEntry("m2", "m1", [{ type: "text", text: "Reviewed." }], { timestamp: 2_000 }),
            ]),
        );

        expect(items).toHaveLength(3);
        expect(items[0]).toEqual({
            kind: "skill",
            id: "skill-m1",
            name: "tydd",
            location: "/skills/tydd/SKILL.md",
            content: "References are relative to /skills/tydd.\n\n# tydd",
        });
        expect(items[1]).toEqual({
            kind: "user",
            id: "user-m1",
            text: "Review this diff",
            images: [],
        });
        // The turn still starts at the prompt entry, not at the assistant reply.
        expect(turnOf(items, 2).timing).toEqual({ kind: "static", durationMs: 1_000 });
    });

    it("keeps a skill invocation without a prompt from creating an empty user bubble", () => {
        const items = buildTranscript(
            project([
                skillEntry("m1", null, "tydd", null),
                assistantEntry("m2", "m1", [{ type: "text", text: "Reviewed." }], { timestamp: 2_000 }),
            ]),
        );

        expect(items.map((item) => item.kind)).toEqual(["skill", "turn"]);
    });

    it("keeps attachments from a skill invocation on the user bubble", () => {
        const block = '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>';
        const items = buildTranscript(
            project([
                {
                    type: "message",
                    id: "m1",
                    parentId: null,
                    timestamp: "2026-04-01T00:00:01.000Z",
                    message: {
                        role: "user",
                        content: [
                            { type: "text", text: block },
                            { type: "image", data: "AAAA", mimeType: "image/png" },
                        ],
                        timestamp: 1_000,
                    },
                },
            ]),
        );

        expect(items.map((item) => item.kind)).toEqual(["skill", "user"]);
        expect(items[1]).toEqual({
            kind: "user",
            id: "user-m1",
            text: "",
            images: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
        });
    });

    it("keeps a prompt that only mentions the skill tag as a user bubble", () => {
        const items = buildTranscript(project([userEntry("m1", null, "Explain the <skill> tag", 1_000)]));

        expect(items).toEqual([{ kind: "user", id: "user-m1", text: "Explain the <skill> tag", images: [] }]);
    });

    it("renders a persisted `!` command between the turns it ran between", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run checks", 1_000),
                assistantEntry("m2", "m1", [{ type: "text", text: "Checks started." }], { timestamp: 1_200 }),
                bashEntry("m3", "m2", { command: "pnpm test", output: "261 passed", exitCode: 0 }),
                assistantEntry("m4", "m3", [{ type: "text", text: "Done." }], { timestamp: 3_000 }),
            ]),
        );

        expect(items.map((item) => item.kind)).toEqual(["user", "turn", "bash", "turn"]);
        expect(items[2]).toEqual({
            kind: "bash",
            id: "bash-m3",
            command: "pnpm test",
            output: "261 passed",
            excludeFromContext: false,
            status: { kind: "succeeded" },
            truncation: { kind: "none" },
        });
        // The command ends the turn before it and must not seed the next turn's duration.
        expect(turnOf(items, 1).timing).toEqual({ kind: "static", durationMs: 200 });
        expect(turnOf(items, 3).timing).toEqual({ kind: "static", durationMs: 0 });
    });

    it("maps the cancelled flag, the exit code, and their absence to distinct states", () => {
        const itemOf = (overrides: BashOverrides) => {
            const item = buildTranscript(project([bashEntry("m1", null, overrides)]))[0];
            if (item === undefined) {
                throw new Error("Expected one bash item");
            }
            return item;
        };

        expect(itemOf({ exitCode: 0 })).toMatchObject({ status: { kind: "succeeded" } });
        expect(itemOf({ exitCode: 2 })).toMatchObject({ status: { kind: "failed", exitCode: 2 } });
        expect(itemOf({ cancelled: true })).toMatchObject({ status: { kind: "cancelled" } });
        expect(itemOf({ exitCode: undefined })).toMatchObject({ status: { kind: "noExitCode" } });
    });

    it("records truncation with the full output path when the record carries one", () => {
        const truncated = buildTranscript(
            project([bashEntry("m1", null, { truncated: true, fullOutputPath: "/tmp/pi-bash-a3d610.log" })]),
        )[0];
        const withoutPath = buildTranscript(project([bashEntry("m2", null, { truncated: true })]))[0];

        expect(truncated).toMatchObject({
            truncation: { kind: "truncated", fullOutputPath: "/tmp/pi-bash-a3d610.log" },
        });
        expect(withoutPath).toMatchObject({ truncation: { kind: "truncated", fullOutputPath: null } });
    });

    it("strips terminal escapes from the recorded output and keeps the excluded flag", () => {
        const item = buildTranscript(
            project([
                bashEntry("m1", null, {
                    output: "\u001B[31mfailed\u001B[0m: one test",
                    excludeFromContext: true,
                }),
            ]),
        )[0];

        expect(item).toMatchObject({ output: "failed: one test", excludeFromContext: true });
    });

    it("degrades a corrupt bash record instead of throwing", () => {
        const corrupt = {
            type: "message",
            id: "m1",
            parentId: null,
            timestamp: "2026-04-01T00:00:01.500Z",
            message: {
                role: "bashExecution",
                command: 42,
                output: null,
                exitCode: "two",
                cancelled: "yes",
                truncated: 1,
                timestamp: "soon",
            },
        } as unknown as FileEntry;

        const item = buildTranscript(project([corrupt]))[0];

        expect(item).toEqual({
            kind: "bash",
            id: "bash-m1",
            command: "",
            output: "",
            excludeFromContext: false,
            status: { kind: "noExitCode" },
            truncation: { kind: "none" },
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

    it.each([
        ["stop", null, { kind: "completed" }],
        ["length", null, { kind: "truncated" }],
        ["pending", null, { kind: "open" }],
        ["toolUse", null, { kind: "open" }],
        ["deferred", null, { kind: "deferred" }],
        ["aborted", null, { kind: "aborted", message: "Operation aborted" }],
        ["aborted", "Request was aborted", { kind: "aborted", message: "Operation aborted" }],
        ["aborted", "Stopped by the reader", { kind: "aborted", message: "Stopped by the reader" }],
        ["error", null, { kind: "error", message: "Error: Assistant request failed" }],
        ["error", " 529 overloaded ", { kind: "error", message: "Error: 529 overloaded" }],
        ["error", "Error: Rate limit exceeded", { kind: "error", message: "Error: Rate limit exceeded" }],
        ["error", "error: lowercase provider text", { kind: "error", message: "error: lowercase provider text" }],
    ] as const)("maps stop reason %s to its turn outcome", (stopReason, errorMessage, expected) => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Hello", 1_000),
                assistantEntry("m2", "m1", [], {
                    timestamp: 1_500,
                    stopReason,
                    ...(errorMessage === null ? {} : { errorMessage }),
                }),
            ]),
        );

        expect(turnOf(items, 1).outcome).toEqual(expected);
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

    it("projects codemode script preview, stripped output header, and nested calls", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run codemode check", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [
                        {
                            type: "toolCall",
                            id: "cm-1",
                            name: "codemode",
                            arguments: { code: "const files = await tools.find({ pattern: '*.ts' });\nreturn files;" },
                        },
                    ],
                    { timestamp: 1_200, stopReason: "toolUse" },
                ),
                {
                    type: "message",
                    id: "m3",
                    parentId: "m2",
                    timestamp: "2026-04-01T00:00:01.600Z",
                    message: {
                        role: "toolResult",
                        toolCallId: "cm-1",
                        toolName: "codemode",
                        content: [
                            { type: "text", text: "Script completed\nWall time 0.40 seconds\nOutput:\nsrc/a.ts" },
                        ],
                        details: {
                            calls: [
                                {
                                    id: "cm-1/1",
                                    name: "find",
                                    args: '{"pattern":"*.ts"}',
                                    status: "ok",
                                    durationMs: 18,
                                },
                                {
                                    id: "cm-1/2",
                                    name: "models.classify",
                                    args: "{}",
                                    status: "ok",
                                    durationMs: 120,
                                    cost: 0.002,
                                },
                                {
                                    id: "cm-1/3",
                                    name: "models.classify",
                                    args: "{}",
                                    status: "ok",
                                    durationMs: 140,
                                    cost: 0.004,
                                },
                            ],
                        },
                        nestedCalls: {
                            calls: [{ id: "cm-1/1", name: "find", arguments: { pattern: "*.ts" }, status: "ok" }],
                            complete: true,
                        },
                        isError: false,
                        timestamp: 1_600,
                    },
                },
                assistantEntry("m4", "m3", [{ type: "text", text: "Done." }], { timestamp: 2_000 }),
            ]),
        );

        expect(toolStepOf(items, 1, 0)).toMatchObject({
            toolKind: "codemode",
            output: "src/a.ts",
            preview: {
                kind: "script",
                code: "const files = await tools.find({ pattern: '*.ts' });\nreturn files;",
                language: "javascript",
            },
            nestedCalls: {
                complete: true,
                totalCost: 0.006,
                calls: [
                    { id: "cm-1/1", name: "find", status: "ok", durationMs: 18 },
                    { id: "cm-1/2", name: "models.classify", status: "ok", durationMs: 120, cost: 0.002 },
                    { id: "cm-1/3", name: "models.classify", status: "ok", durationMs: 140, cost: 0.004 },
                ],
            },
        });
    });

    it("merges running and settled liveToolExecutions until persisted toolResult arrives", () => {
        const entries = project([
            userEntry("m1", null, "Run codemode check", 1_000),
            assistantEntry("m2", "m1", [{ type: "toolCall", id: "live-1", name: "bash", arguments: {} }], {
                timestamp: 1_200,
                stopReason: "toolUse",
            }),
        ]);

        const runningItems = buildTranscript(entries, {
            runtimeActive: true,
            liveToolExecutions: {
                "live-1": {
                    kind: "running",
                    toolCallId: "live-1",
                    toolName: "bash",
                    args: { command: "pnpm test" },
                    partialResult: {
                        content: [{ type: "text", text: "running..." }],
                        details: { fullOutputPath: "/tmp/live.log" },
                    },
                },
            },
        });
        expect(toolStepOf(runningItems, 1, 0)).toMatchObject({
            summary: "pnpm test",
            status: "running",
            output: "running...",
            warnings: [{ kind: "fullOutput", path: "/tmp/live.log" }],
            timing: { kind: "since", startedAtMs: 1_200 },
        });

        const settledItems = buildTranscript(entries, {
            runtimeActive: true,
            liveToolExecutions: {
                "live-1": {
                    kind: "settled",
                    toolCallId: "live-1",
                    toolName: "bash",
                    args: { command: "pnpm test" },
                    result: { content: [{ type: "text", text: "exit 1" }], details: undefined },
                    isError: true,
                    durationMs: 420,
                },
            },
        });
        expect(toolStepOf(settledItems, 1, 0)).toMatchObject({
            status: "error",
            output: "exit 1",
            timing: { kind: "static", durationMs: 420 },
        });
        expect(turnOf(settledItems, 1).streaming).toBe(true);

        // A historical unmatched call must ignore liveToolExecutions when runtimeActive is false.
        const historicalItems = buildTranscript(entries, {
            runtimeActive: false,
            liveToolExecutions: {
                "live-1": {
                    kind: "running",
                    toolCallId: "live-1",
                    toolName: "bash",
                    args: { command: "pnpm test" },
                    partialResult: { content: [{ type: "text", text: "stale" }], details: undefined },
                },
            },
        });
        expect(toolStepOf(historicalItems, 1, 0)).toMatchObject({
            status: "error",
            output: "",
        });
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

    it.each([undefined, null, "futureReason", 42])(
        "degrades an unknown persisted stop reason (%s) to a completed turn",
        (stopReason) => {
            const items = buildTranscript(
                project([userEntry("m1", null, "Hello", 1_000), corruptStopReasonEntry(stopReason)]),
            );

            const turn = turnOf(items, 1);
            expect(turn.outcome).toEqual({ kind: "completed" });
            expect(turn.finalReply).toBe("Partial answer");
        },
    );

    it("degrades an unknown live stop reason to a completed turn", () => {
        const live = {
            role: "assistant",
            content: [{ type: "text", text: "Live answer" }],
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "futureReason",
            timestamp: 2_000,
        } as unknown as AssistantMessage;

        const items = buildTranscript(project([userEntry("m1", null, "Hello", 1_000)]), {
            liveMessage: live,
            runtimeActive: true,
        });

        expect(turnOf(items, 1).outcome).toEqual({ kind: "completed" });
        expect(turnOf(items, 1).finalReply).toBe("Live answer");
    });

    it("ignores an entry type and a message role a newer session may hold", () => {
        const unknownEntry = {
            type: "future_entry",
            id: "f1",
            parentId: null,
            timestamp: "2026-04-01T00:00:01.000Z",
            data: {},
        } as unknown as FileEntry;
        const unknownRole = {
            type: "message",
            id: "f2",
            parentId: "f1",
            timestamp: "2026-04-01T00:00:02.000Z",
            message: { role: "futureRole", timestamp: 2_000 },
        } as unknown as FileEntry;

        expect(buildTranscript(project([unknownEntry, unknownRole]))).toEqual([]);
    });
});

describe("describeToolCall", () => {
    it.each([
        ["bash", { command: "git status\n  --short" }, "bash", "git status --short"],
        ["powershell", { command: "Get-ChildItem   -Force" }, "powershell", "Get-ChildItem -Force"],
        ["read", { path: "src/main.tsx" }, "read", "src/main.tsx"],
        ["write", { path: "plan.md" }, "write", "plan.md"],
        ["edit", { path: "src/App.tsx" }, "edit", "src/App.tsx"],
        ["grep", { pattern: "useSessionStore", path: "src" }, "grep", "useSessionStore in src"],
        ["find", { pattern: "*.stories.tsx" }, "find", "*.stories.tsx"],
        ["ls", {}, "ls", "."],
        ["codemode", { code: "\n  // run checks\n  return 1;" }, "codemode", "// run checks"],
        ["tool_search", { query: "github pull request" }, "tool_search", "github pull request"],
        ["read", { file_path: "src/App.tsx", offset: 10, limit: 25 }, "read", "src/App.tsx:10-34"],
        ["bash", { command: "pnpm test", timeout: 30 }, "bash", "pnpm test (timeout 30s)"],
        ["grep", { pattern: "foo", path: "src", glob: "*.ts", limit: 20 }, "grep", "foo in src (*.ts) (limit 20)"],
        ["find", { pattern: "*.css", path: "src", limit: 50 }, "find", "*.css in src (limit 50)"],
        ["ls", { path: "packages", limit: 10 }, "ls", "packages (limit 10)"],
        ["mcp__github__get_issue", { nested: { ignored: true }, issue_number: 42, repo: "pivia" }, "generic", "42"],
        ["custom_ping", {}, "generic", ""],
    ] as const)("classifies %s as %s with a single-line summary", (name, args, toolKind, summary) => {
        expect(describeToolCall(name, args)).toEqual({ toolKind, summary });
    });
});

describe("Step 5 metadata, cache warming usage, and diagnostics", () => {
    it("extracts billing metadata on compaction and branch_summary notes", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "First prompt", 1_000),
                {
                    type: "compaction",
                    id: "c1",
                    parentId: "m1",
                    timestamp: "2026-04-01T00:00:02.000Z",
                    summary: "Compacted",
                    firstKeptEntryId: "m1",
                    tokensBefore: 42_100,
                    usage: {
                        input: 2_500,
                        output: 500,
                        cacheRead: 200,
                        cacheWrite: 0,
                        totalTokens: 3_200,
                        cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
                    },
                },
                {
                    type: "branch_summary",
                    id: "b1",
                    parentId: "c1",
                    timestamp: "2026-04-01T00:00:03.000Z",
                    fromId: "m1",
                    summary: "Branch exploration",
                    usage: {
                        input: 1_500,
                        output: 300,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 1_800,
                        cost: { input: 0.004, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.005 },
                    },
                },
            ]),
        );

        expect(items[0]).toEqual({
            kind: "note",
            id: "note-c1",
            title: "Compaction",
            text: "Compacted",
            tokensBefore: 42_100,
            billing: { billedTokens: 3_200, approxCostUsd: 0.02 },
        });
        expect(items[2]).toEqual({
            kind: "note",
            id: "note-b1",
            title: "Branch summary",
            text: "Branch exploration",
            billing: { billedTokens: 1_800, approxCostUsd: null },
        });
    });

    it("collapses adjacent cache_warm usage entries with matching notes and ignores other usage kinds", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "First prompt", 1_000),
                assistantEntry("m2", "m1", [{ type: "text", text: "Done." }], { timestamp: 2_000 }),
                {
                    type: "usage",
                    id: "u1",
                    parentId: "m2",
                    timestamp: "2026-04-01T00:01:00.000Z",
                    kind: "cache_warm",
                    provider: "anthropic",
                    model: "claude",
                    usage: {
                        ...EMPTY_USAGE,
                        cost: { ...EMPTY_USAGE.cost, total: 0.001 },
                    },
                    note: "idle",
                },
                {
                    type: "usage",
                    id: "u2",
                    parentId: "u1",
                    timestamp: "2026-04-01T00:02:00.000Z",
                    kind: "cache_warm",
                    provider: "anthropic",
                    model: "claude",
                    usage: {
                        ...EMPTY_USAGE,
                        cost: { ...EMPTY_USAGE.cost, total: 0.0015 },
                    },
                    note: "idle",
                },
                {
                    type: "usage",
                    id: "u3",
                    parentId: "u2",
                    timestamp: "2026-04-01T00:03:00.000Z",
                    kind: "other_metric",
                    provider: "anthropic",
                    model: "claude",
                    usage: {
                        ...EMPTY_USAGE,
                        cost: { ...EMPTY_USAGE.cost, total: 5 },
                    },
                },
                {
                    type: "usage",
                    id: "u4",
                    parentId: "u3",
                    timestamp: "2026-04-01T00:04:00.000Z",
                    kind: "cache_warm",
                    provider: "anthropic",
                    model: "claude",
                    usage: {
                        ...EMPTY_USAGE,
                        cost: { ...EMPTY_USAGE.cost, total: 0.002 },
                    },
                },
                userEntry("m3", "u4", "Follow-up", 300_000),
                {
                    type: "usage",
                    id: "u5",
                    parentId: "m3",
                    timestamp: "2026-04-01T00:06:00.000Z",
                    kind: "cache_warm",
                    provider: "anthropic",
                    model: "claude",
                    usage: {
                        ...EMPTY_USAGE,
                        cost: { ...EMPTY_USAGE.cost, total: 0.001 },
                    },
                    note: "idle",
                },
            ]),
        );

        expect(items[2]).toEqual({
            kind: "notice",
            id: "notice-u1",
            text: "Cache warmed (idle): $0.0025",
        });
        expect(items[3]).toEqual({
            kind: "notice",
            id: "notice-u4",
            text: "Cache warmed: $0.002",
        });
        expect(items[5]).toEqual({
            kind: "notice",
            id: "notice-u5",
            text: "Cache warmed (idle): $0.001",
        });
    });

    it("keeps mid-turn tool execution paired across cache_warm usage entries and skips invalid costs", () => {
        const items = buildTranscript(
            project([
                userEntry("m1", null, "Run slow command", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 60" } }],
                    { timestamp: 2_000, stopReason: "toolUse" },
                ),
                {
                    type: "usage",
                    id: "u-mid",
                    parentId: "m2",
                    timestamp: "2026-04-01T00:05:00.000Z",
                    kind: "cache_warm",
                    provider: "anthropic",
                    model: "claude",
                    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost, total: 0 } },
                },
                {
                    type: "usage",
                    id: "u-bad",
                    parentId: "u-mid",
                    timestamp: "2026-04-01T00:05:30.000Z",
                    kind: "cache_warm",
                    provider: "anthropic",
                    model: "claude",
                    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost, total: -1 } },
                },
                toolResultEntry("m3", "u-bad", "c1", "ok"),
                assistantEntry("m4", "m3", [{ type: "text", text: "Completed." }], { timestamp: 6_000 }),
            ]),
        );

        const turn = turnOf(items, 1);
        expect(turn.steps).toHaveLength(1);
        expect(turn.steps[0]).toMatchObject({ kind: "toolCall", id: "c1", status: "done", output: "ok" });
        expect(turn.finalReply).toBe("Completed.");
        expect(items[2]).toEqual({
            kind: "notice",
            id: "notice-u-mid",
            text: "Cache warmed: $0.000",
        });
        expect(items).toHaveLength(3);
    });

    it("tracks Anthropic thinking_dropped across multi-round turns, compaction, live messages, and aborted stops", () => {
        const makeDiagnostics = (count: number) => [
            {
                type: "anthropic_input_transformations",
                timestamp: 2_000,
                details: {
                    transformations: Array.from({ length: count }, () => ({ type: "thinking_dropped" })),
                },
            },
        ];

        const items = buildTranscript(
            project([
                userEntry("m0", null, "Initial", 500),
                assistantEntry("m0a", "m0", [{ type: "text", text: "Baseline" }], {
                    timestamp: 800,
                    diagnostics: makeDiagnostics(1),
                }),
                userEntry("m1", "m0a", "First", 1_000),
                assistantEntry(
                    "m2",
                    "m1",
                    [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }],
                    { timestamp: 2_000, stopReason: "toolUse", diagnostics: makeDiagnostics(1) },
                ),
                toolResultEntry("m3", "m2", "c1", "contents"),
                assistantEntry("m4", "m3", [{ type: "text", text: "One" }], {
                    timestamp: 2_500,
                    diagnostics: makeDiagnostics(2),
                }),
                {
                    type: "compaction",
                    id: "cmp1",
                    parentId: "m4",
                    timestamp: "2026-04-01T00:00:03.000Z",
                    summary: "Compacted",
                    firstKeptEntryId: "m1",
                    tokensBefore: 10_000,
                },
                userEntry("m5", "cmp1", "Aborted", 3_500),
                assistantEntry("m6", "m5", [{ type: "text", text: "Partial" }], {
                    timestamp: 4_000,
                    stopReason: "aborted",
                    diagnostics: makeDiagnostics(5),
                }),
                userEntry("m7", "m6", "Same", 4_500),
                assistantEntry("m8", "m7", [{ type: "text", text: "Equal after abort" }], {
                    timestamp: 5_000,
                    diagnostics: makeDiagnostics(5),
                }),
                userEntry("m9", "m8", "Live", 5_500),
            ]),
            {
                liveMessage: {
                    role: "assistant",
                    content: [{ type: "text", text: "Streaming reply" }],
                    api: "test",
                    provider: "test",
                    model: "test",
                    usage: EMPTY_USAGE,
                    stopReason: "stop",
                    timestamp: 6_000,
                    diagnostics: makeDiagnostics(6),
                },
            },
        );

        expect(turnOf(items, 2).diagnosticsNotice).toBe("Anthropic dropped 2 thinking blocks");
        expect(turnOf(items, 4).diagnosticsNotice).toBeUndefined();
        expect(turnOf(items, 6).diagnosticsNotice).toBeUndefined();
        expect(turnOf(items, 8).diagnosticsNotice).toBe("Anthropic dropped 6 thinking blocks");
    });
});
