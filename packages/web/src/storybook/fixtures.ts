import type { SessionId, SessionStateSnapshot, SessionSummary } from "@pivia/protocol";

import type { SessionRow as SessionRowModel } from "@/stores/workspace";

import { sid } from "./ids";

/** Fixed clock for stories that render relative ages. */
export const STORY_NOW = Date.parse("2026-01-03T12:00:00.000Z");

/** Builds a workspace row; `overrides` sets the fields a story asserts. */
export function makeStorySessionRow(
    id: string,
    title: string,
    overrides: Partial<SessionRowModel> = {},
): SessionRowModel {
    return {
        id: sid(id),
        title,
        named: true,
        cwd: "/home/u/pivia",
        modifiedAtMs: STORY_NOW - 2 * 60 * 60 * 1000,
        runtimeState: "idle",
        attachedClients: 0,
        pinned: false,
        selected: false,
        ...overrides,
    };
}

/** Builds a catalog row; `overrides` sets the fields a story asserts. */
export function makeStorySessionSummary(
    id: string | SessionId,
    overrides: Partial<SessionSummary> = {},
): SessionSummary {
    return {
        id: typeof id === "string" ? sid(id) : id,
        cwd: "/home/u/pivia",
        name: "First task",
        firstMessage: "Inspect routes",
        messageCount: 2,
        createdAtMs: 1_000,
        modifiedAtMs: 5_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
        ...overrides,
    };
}

/** Builds a session state snapshot; `overrides` sets the fields a story asserts. */
export function makeStorySessionState(
    sessionId: SessionId,
    overrides: Partial<SessionStateSnapshot> = {},
): SessionStateSnapshot {
    return {
        sessionId,
        cwd: "/home/u/pivia",
        name: "First task",
        model: null,
        contextUsage: null,
        routedModel: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 2,
        steeringMessages: [],
        followUpMessages: [],
        ...overrides,
    };
}

/**
 * Builds base64 SVG sample image data. `accent` colors the header bar so a story with two
 * attachments can tell them apart.
 */
export function storyImageData(accent: string): string {
    const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100">',
        '<rect width="160" height="100" rx="8" fill="#1f1f1f"/>',
        `<rect x="16" y="20" width="128" height="16" rx="4" fill="${accent}"/>`,
        '<rect x="16" y="48" width="96" height="12" rx="4" fill="#3c3c3c"/>',
        "</svg>",
    ].join("");

    return btoa(svg);
}
