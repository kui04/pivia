import type { SessionRuntimeState, SessionSummary } from "./http.ts";
import type { SessionId } from "./parse/session.ts";
import type { CollectionDelta, SyncFrame } from "./sync/index.ts";

/**
 * Mutable fields of {@link SessionSummary} carried in incremental `patch` deltas.
 *
 * Immutable fields (`id`, `cwd`, `createdAtMs`, `hasParent`) are sent once on `sync:snapshot`
 * or `upsert` and omitted from subsequent updates.
 */
export interface SessionSummaryPatch {
    readonly name?: string | null | undefined;
    readonly firstMessage?: string | undefined;
    readonly messageCount?: number | undefined;
    readonly modifiedAtMs?: number | undefined;
    readonly runtimeState?: SessionRuntimeState | undefined;
    readonly attachedClients?: number | undefined;
}

/** Full workspace catalog snapshot replicated on initial sync or resync. */
export interface CatalogSnapshot {
    readonly sessions: readonly SessionSummary[];
    readonly updatedAtMs: number;
}

/** Incremental catalog mutation replicated over `/ws/workspace`. */
export type CatalogDelta = CollectionDelta<SessionId, SessionSummary, SessionSummaryPatch>;

/** Server-to-client synchronization frames streamed over `/ws/workspace`. */
export type WorkspaceWsServerMessage = SyncFrame<"catalog", CatalogSnapshot, CatalogDelta>;
