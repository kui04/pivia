import { parseSessionId, type SessionId } from "../sessions/ids.ts";
import {
    parseSessionSummary,
    parseSessionSummaryPatch,
    type SessionSummary,
    type SessionSummaryPatch,
} from "../sessions/summary.ts";
import { isFiniteNumber, isRecord, type JsonDecoder } from "../shared/primitives.ts";
import {
    createSyncFrameParser,
    type CollectionDelta,
    type SyncCursor,
    type SyncFrame,
    type SyncHandshake,
} from "../sync/index.ts";

/** Logical clock cursor for the workspace session catalog stream. */
export type CatalogCursor = SyncCursor<"catalog">;

/** Handshake parameters sent on `/ws/workspace` connect and reconnect. */
export type WorkspaceWsHandshake = SyncHandshake<"catalog">;

/** Full workspace catalog snapshot replicated on initial sync or resync. */
export interface CatalogSnapshot {
    readonly sessions: readonly SessionSummary[];
    readonly updatedAtMs: number;
}

/** Incremental catalog mutation replicated over `/ws/workspace`. */
export type CatalogDelta = CollectionDelta<SessionId, SessionSummary, SessionSummaryPatch>;

/** Server-to-client synchronization frames streamed over `/ws/workspace`. */
export type WorkspaceWsServerMessage = SyncFrame<"catalog", CatalogSnapshot, CatalogDelta>;

/** Parse one {@link CatalogSnapshot} payload, or return `null` when malformed. */
export function parseCatalogSnapshot(raw: unknown): CatalogSnapshot | null {
    if (!isRecord(raw) || !Array.isArray(raw.sessions) || !isFiniteNumber(raw.updatedAtMs)) {
        return null;
    }
    const sessions: SessionSummary[] = [];
    for (const entry of raw.sessions) {
        const parsed = parseSessionSummary(entry);
        if (parsed === null) {
            return null;
        }
        sessions.push(parsed);
    }
    return { sessions, updatedAtMs: raw.updatedAtMs };
}

/** Parse one {@link CatalogDelta} payload, or return `null` when malformed. */
export function parseCatalogDelta(raw: unknown): CatalogDelta | null {
    if (!isRecord(raw) || typeof raw.op !== "string") {
        return null;
    }
    switch (raw.op) {
        case "upsert": {
            const item = parseSessionSummary(raw.item);
            return item === null ? null : { op: "upsert", item };
        }
        case "patch": {
            const id = parseSessionId(raw.id);
            const patch = parseSessionSummaryPatch(raw.patch);
            return id === null || patch === null ? null : { op: "patch", id, patch };
        }
        case "remove": {
            const id = parseSessionId(raw.id);
            return id === null ? null : { op: "remove", id };
        }
        default:
            return null;
    }
}

/**
 * Parse one server-sent `/ws/workspace` {@link WorkspaceWsServerMessage} from untrusted JSON, or
 * return `null` when malformed or unknown.
 */
export const parseWorkspaceWsServerMessage: JsonDecoder<WorkspaceWsServerMessage> = createSyncFrameParser<
    "catalog",
    CatalogSnapshot,
    CatalogDelta
>({
    parseSnapshot: parseCatalogSnapshot,
    parseDelta: parseCatalogDelta,
});
