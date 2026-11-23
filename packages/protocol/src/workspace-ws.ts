import type { SessionSummary } from "./http.ts";
import type { PatchOf } from "./parse/primitives.ts";
import type { SessionId } from "./parse/session.ts";
import type { CollectionDelta, SyncCursor, SyncFrame } from "./sync/index.ts";

/** Logical clock cursor for the workspace session catalog stream. */
export type CatalogCursor = SyncCursor<"catalog">;

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

/** Full workspace catalog snapshot replicated on initial sync or resync. */
export interface CatalogSnapshot {
    readonly sessions: readonly SessionSummary[];
    readonly updatedAtMs: number;
}

/** Incremental catalog mutation replicated over `/ws/workspace`. */
export type CatalogDelta = CollectionDelta<SessionId, SessionSummary, SessionSummaryPatch>;

/** Server-to-client synchronization frames streamed over `/ws/workspace`. */
export type WorkspaceWsServerMessage = SyncFrame<"catalog", CatalogSnapshot, CatalogDelta>;
