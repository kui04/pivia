import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { SessionStateSnapshot, SessionSummary } from "@pivia/protocol";

import type { WorkspaceCatalogCache } from "@/lib/cache";

import { sid } from "./ids";

/** All-zero token usage for assistant messages that do not exercise billing. */
export const EMPTY_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Builds a catalog row; pass `overrides` for the fields a test asserts or sorts by. */
export function makeSessionSummary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id: sid(id),
        cwd: "/home/u/project",
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

/** Builds a session state snapshot; pass `overrides` for the fields a test asserts. */
export function makeSessionStateSnapshot(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return {
        sessionId: sid("session-1"),
        cwd: "/home/u/project",
        name: null,
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 0,
        steeringMessages: [],
        followUpMessages: [],
        ...overrides,
    };
}

/** Builds a session header entry; pass `overrides` for the header fields a test asserts. */
export function makeSessionHeader(overrides: Partial<SessionHeader> = {}): SessionHeader {
    return {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd: "/home/u/project",
        ...overrides,
    };
}

/** Builds a user message entry. The timestamp is milliseconds on the test's own clock. */
export function makeUserEntry(id: string, parentId: string | null, text: string, timestamp = 1): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: new Date(timestamp).toISOString(),
        message: { role: "user", content: text, timestamp },
    };
}

/** Builds an assistant message entry; `content` carries the text, thinking, or tool blocks. */
export function makeAssistantEntry(
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

/** Catalog cache double that never returns or stores anything. */
export const noopCatalogCache: WorkspaceCatalogCache = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
};

/** Builds a JSON `Response` for a fetch double. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
        ...init,
    });
}

/** Replaces `globalThis.location`, which is absent in Node, for code that reads the page URL. */
export function mockLocation(url = "http://127.0.0.1:3141/workspace"): void {
    Object.defineProperty(globalThis, "location", {
        value: new URL(url),
        configurable: true,
        writable: true,
    });
}
