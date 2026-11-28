import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

import { isFiniteNumber, isNonNegativeSafeInteger, isRecord, type PatchOf } from "../shared/primitives.ts";
import { parseSessionId, type SessionId } from "./ids.ts";

/** Lifecycle state of one session runtime. */
export type SessionRuntimeState = "starting" | "idle" | "streaming" | "compacting" | "closing";

/** Public model identity sent to clients; never contains credentials. */
export type SessionModelInfo = Pick<Model<Api>, "provider" | "id" | "name" | "contextWindow" | "reasoning">;

/**
 * Summary of one session, merged from disk discovery and any live runtime.
 *
 * `createdAtMs` and `modifiedAtMs` are finite Unix epoch milliseconds. The server uses
 * `modifiedAtMs` as the fallback when the stored creation timestamp cannot be parsed. Live
 * sessions override the disk fields with in-memory state, including sessions whose file has not
 * been written yet.
 */
export interface SessionSummary extends Readonly<Pick<SessionInfo, "cwd" | "firstMessage" | "messageCount">> {
    readonly id: SessionId;
    /** Latest display name set by the user, or `null` when the session has no name. */
    readonly name: string | null;
    readonly createdAtMs: number;
    readonly modifiedAtMs: number;
    /** True when the session header names a parent session (forked session). */
    readonly hasParent: boolean;
    /**
     * Live runtime state. `"starting"` while extensions bind, `"closing"` while resources are
     * released, and `"idle"` when the server has no open runtime for the session.
     */
    readonly runtimeState: SessionRuntimeState;
    /** Number of authenticated WebSocket clients attached to the session runtime. */
    readonly attachedClients: number;
}

/**
 * Mutable fields of {@link SessionSummary} carried in incremental `patch` deltas.
 *
 * Immutable fields (`id`, `cwd`, `createdAtMs`, `hasParent`) are sent once on `sync:snapshot`
 * or `upsert` and omitted from subsequent updates.
 */
export type SessionSummaryPatch = PatchOf<
    SessionSummary,
    "name" | "firstMessage" | "messageCount" | "modifiedAtMs" | "runtimeState" | "attachedClients"
>;

const SESSION_RUNTIME_STATES: Readonly<Record<SessionRuntimeState, true>> = {
    starting: true,
    idle: true,
    streaming: true,
    compacting: true,
    closing: true,
};

function isSessionRuntimeState(value: unknown): value is SessionRuntimeState {
    return typeof value === "string" && Object.hasOwn(SESSION_RUNTIME_STATES, value);
}

/** Parse one {@link SessionModelInfo} payload, or return `null` when malformed. */
export function parseSessionModelInfo(raw: unknown): SessionModelInfo | null {
    if (
        !isRecord(raw) ||
        typeof raw.provider !== "string" ||
        typeof raw.id !== "string" ||
        typeof raw.name !== "string" ||
        !isFiniteNumber(raw.contextWindow) ||
        raw.contextWindow < 0 ||
        typeof raw.reasoning !== "boolean"
    ) {
        return null;
    }
    return {
        provider: raw.provider,
        id: raw.id,
        name: raw.name,
        contextWindow: raw.contextWindow,
        reasoning: raw.reasoning,
    };
}

/** Parse one {@link SessionSummary} payload, or return `null` when malformed. */
export function parseSessionSummary(raw: unknown): SessionSummary | null {
    if (!isRecord(raw)) {
        return null;
    }
    const id = parseSessionId(raw.id);
    if (
        id === null ||
        typeof raw.cwd !== "string" ||
        (raw.name !== null && typeof raw.name !== "string") ||
        typeof raw.firstMessage !== "string" ||
        !isNonNegativeSafeInteger(raw.messageCount) ||
        !isFiniteNumber(raw.createdAtMs) ||
        !isFiniteNumber(raw.modifiedAtMs) ||
        typeof raw.hasParent !== "boolean" ||
        !isSessionRuntimeState(raw.runtimeState) ||
        !isNonNegativeSafeInteger(raw.attachedClients)
    ) {
        return null;
    }
    return {
        id,
        cwd: raw.cwd,
        name: raw.name,
        firstMessage: raw.firstMessage,
        messageCount: raw.messageCount,
        createdAtMs: raw.createdAtMs,
        modifiedAtMs: raw.modifiedAtMs,
        hasParent: raw.hasParent,
        runtimeState: raw.runtimeState,
        attachedClients: raw.attachedClients,
    };
}

/**
 * Parse one {@link SessionSummaryPatch} payload, or return `null` when malformed or empty.
 *
 * Only mutable summary fields are accepted; unknown fields are ignored for forward compatibility,
 * and an empty patch with no recognized mutable fields is rejected.
 */
export function parseSessionSummaryPatch(raw: unknown): SessionSummaryPatch | null {
    if (!isRecord(raw)) {
        return null;
    }
    const patch: {
        name?: string | null;
        firstMessage?: string;
        messageCount?: number;
        modifiedAtMs?: number;
        runtimeState?: SessionRuntimeState;
        attachedClients?: number;
    } = {};
    let hasField = false;

    if (raw.name !== undefined) {
        if (raw.name !== null && typeof raw.name !== "string") {
            return null;
        }
        patch.name = raw.name;
        hasField = true;
    }
    if (raw.firstMessage !== undefined) {
        if (typeof raw.firstMessage !== "string") {
            return null;
        }
        patch.firstMessage = raw.firstMessage;
        hasField = true;
    }
    if (raw.messageCount !== undefined) {
        if (!isNonNegativeSafeInteger(raw.messageCount)) {
            return null;
        }
        patch.messageCount = raw.messageCount;
        hasField = true;
    }
    if (raw.modifiedAtMs !== undefined) {
        if (!isFiniteNumber(raw.modifiedAtMs)) {
            return null;
        }
        patch.modifiedAtMs = raw.modifiedAtMs;
        hasField = true;
    }
    if (raw.runtimeState !== undefined) {
        if (!isSessionRuntimeState(raw.runtimeState)) {
            return null;
        }
        patch.runtimeState = raw.runtimeState;
        hasField = true;
    }
    if (raw.attachedClients !== undefined) {
        if (!isNonNegativeSafeInteger(raw.attachedClients)) {
            return null;
        }
        patch.attachedClients = raw.attachedClients;
        hasField = true;
    }

    return hasField ? patch : null;
}
