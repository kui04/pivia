import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { summarizeSessionStats } from "./stats";

type MessageEntry = Extract<FileEntry, { type: "message" }>;

function usage(
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    cost: number,
): AssistantMessage["usage"] {
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    };
}

function messageEntry(id: string, message: MessageEntry["message"]): MessageEntry {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-04-01T00:00:00.000Z",
        message,
    };
}

function assistant(content: AssistantMessage["content"], assistantUsage: AssistantMessage["usage"]): MessageEntry {
    return messageEntry("assistant-1", {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage: assistantUsage,
        stopReason: "stop",
        timestamp: 1,
    });
}

function user(text: string): MessageEntry {
    return messageEntry("user-1", { role: "user", content: text, timestamp: 1 });
}

function toolResult(resultUsage: AssistantMessage["usage"]): MessageEntry {
    return messageEntry("result-1", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        usage: resultUsage,
        isError: false,
        timestamp: 1,
    });
}

describe("summarizeSessionStats", () => {
    it("returns zeros and no cache rate for an empty entry list or a header alone", () => {
        const header: FileEntry = {
            type: "session",
            version: 3,
            id: "session-1",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };

        expect(summarizeSessionStats([])).toEqual({
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: 0,
            cacheHitRate: null,
            userMessages: 0,
            assistantMessages: 0,
            toolCalls: 0,
            toolResults: 0,
            totalMessages: 0,
        });
        expect(summarizeSessionStats([header])).toMatchObject({ totalMessages: 0, userMessages: 0 });
    });

    it("counts messages, tool calls, and every usage entry like the SDK", () => {
        const entries: FileEntry[] = [
            {
                type: "session",
                version: 3,
                id: "session-1",
                timestamp: "2026-04-01T00:00:00.000Z",
                cwd: "/tmp",
            },
            user("hello"),
            assistant(
                [
                    { type: "text", text: "working" },
                    { type: "toolCall", id: "call-1", name: "read", arguments: {} },
                ],
                usage(100, 50, 300, 50, 0.012),
            ),
            toolResult(usage(10, 5, 20, 5, 0.001)),
            {
                type: "usage",
                id: "usage-1",
                parentId: null,
                timestamp: "2026-04-01T00:00:03.000Z",
                kind: "cache_warm",
                provider: "test",
                model: "test",
                usage: usage(1, 2, 3, 4, 0.0005),
            },
            {
                type: "compaction",
                id: "compact-1",
                parentId: null,
                timestamp: "2026-04-01T00:00:04.000Z",
                summary: "compacted",
                firstKeptEntryId: "user-1",
                tokensBefore: 1_000,
                usage: usage(7, 0, 0, 0, 0.002),
            },
        ];

        expect(summarizeSessionStats(entries)).toEqual({
            input: 118,
            output: 57,
            cacheRead: 323,
            cacheWrite: 59,
            cost: 0.012 + 0.001 + 0.0005 + 0.002,
            cacheHitRate: (300 / (100 + 300 + 50)) * 100,
            userMessages: 1,
            assistantMessages: 1,
            toolCalls: 1,
            toolResults: 1,
            totalMessages: 3,
        });
    });
});
