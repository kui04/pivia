import type { SessionRuntimeState, SessionSummary } from "./http.ts";
import type { CatalogEpoch, CatalogSeq } from "./parse/catalog.ts";
import type { SessionId } from "./parse/session.ts";

/**
 * Mutable fields of {@link SessionSummary} carried in incremental `session_updated` frames.
 *
 * Immutable fields (`id`, `cwd`, `createdAtMs`, `hasParent`) are sent once on `catalog_snapshot`
 * or `session_upserted` and omitted from subsequent updates.
 */
export interface SessionSummaryPatch {
    readonly name?: string | null;
    readonly firstMessage?: string;
    readonly messageCount?: number;
    readonly modifiedAtMs?: number;
    readonly runtimeState?: SessionRuntimeState;
    readonly attachedClients?: number;
}

/** Initial full workspace session catalog pushed when `/ws/workspace` opens. */
export interface WorkspaceWsCatalogSnapshotMessage {
    readonly type: "catalog_snapshot";
    readonly sessions: readonly SessionSummary[];
    readonly updatedAtMs: number;
    readonly catalogEpoch: CatalogEpoch;
    readonly catalogSeq: CatalogSeq;
}

/** Incremental notification sent when a live session runtime first appears in the catalog. */
export interface WorkspaceWsSessionUpsertedMessage {
    readonly type: "session_upserted";
    readonly catalogEpoch: CatalogEpoch;
    readonly seq: CatalogSeq;
    readonly session: SessionSummary;
}

/** Incremental patch sent when mutable fields of an existing session summary change. */
export interface WorkspaceWsSessionUpdatedMessage {
    readonly type: "session_updated";
    readonly catalogEpoch: CatalogEpoch;
    readonly seq: CatalogSeq;
    readonly sessionId: SessionId;
    readonly patch: SessionSummaryPatch;
}

/** Incremental notification sent when an unflushed session is closed and removed. */
export interface WorkspaceWsSessionRemovedMessage {
    readonly type: "session_removed";
    readonly catalogEpoch: CatalogEpoch;
    readonly seq: CatalogSeq;
    readonly sessionId: SessionId;
}

/** Incremental catalog change events streamed over `/ws/workspace`. */
export type WorkspaceWsCatalogEvent =
    WorkspaceWsSessionUpsertedMessage | WorkspaceWsSessionUpdatedMessage | WorkspaceWsSessionRemovedMessage;

/** Server-to-client messages streamed over `/ws/workspace`. */
export type WorkspaceWsServerMessage = WorkspaceWsCatalogSnapshotMessage | WorkspaceWsCatalogEvent;
