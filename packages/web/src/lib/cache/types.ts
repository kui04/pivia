import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { CatalogSnapshot, EntriesVersion, SessionId } from "@pivia/protocol";

/** Metadata stored per cached session in `session_meta`. */
export interface SessionCacheMeta {
    readonly sessionId: SessionId;
    readonly entriesVersion: EntriesVersion;
    /** Total cached entry count including the session header (`entries[0]`). Must be >= 1. */
    readonly entryCount: number;
    /** Id of `entries[entryCount - 1]`; equals `sessionId` when `entryCount === 1`. */
    readonly lastEntryId: string;
    readonly estimatedBytes: number;
    readonly lastAccessedAtMs: number;
}

/** Result of loading a cached session from {@link SessionCache}. */
export interface CachedSessionSnapshot {
    readonly meta: SessionCacheMeta;
    readonly entries: readonly FileEntry[];
}

/** Explicit outcome of a cache write transaction. */
export type CacheWriteOutcome = "written" | "skipped-stale" | "degraded-memory";

/**
 * Persistence contract for a single-record domain snapshot.
 *
 * Implementations fall back to memory when IndexedDB is unavailable or fails, and discard
 * corrupted persisted records by returning `null` from `get()`.
 */
export interface SnapshotCache<TSnapshot> {
    get(): Promise<TSnapshot | null>;
    put(snapshot: TSnapshot): Promise<void>;
}

/**
 * Persistence contract for row-level session entries.
 *
 * `appendEntries` and `replaceEntries` skip stale writes when a newer or longer snapshot for the
 * same `entriesVersion` is already stored. An empty `entries` array in `replaceEntries` removes
 * the session from the cache.
 */
export interface SessionCache {
    get(sessionId: SessionId): Promise<CachedSessionSnapshot | null>;
    appendEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        baseEntryCount: number,
        entries: readonly FileEntry[],
    ): Promise<CacheWriteOutcome>;
    replaceEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        entries: readonly FileEntry[],
    ): Promise<CacheWriteOutcome>;
    delete(sessionId: SessionId): Promise<void>;
}

/** Persistence contract for the workspace session catalog snapshot. */
export type WorkspaceCatalogCache = SnapshotCache<CatalogSnapshot>;

/** Cross-domain cache lifecycle contract required on sign-out or `401`. */
export interface ClearableCache {
    clearAll(): Promise<void>;
}

/** Unified client persistence contract composed of domain sub-caches. */
export interface AppCache extends ClearableCache {
    readonly sessions: SessionCache;
    readonly catalog: WorkspaceCatalogCache;
}

/** IndexedDB connection and clock dependencies shared across cache slices. */
export interface IndexedDbCoordinatorOptions {
    /** Defaults to `globalThis.indexedDB`; pass `fake-indexeddb` in Node unit tests. */
    readonly indexedDB?: IDBFactory | undefined;
    /** Defaults to `globalThis.IDBKeyRange`; pass `IDBKeyRange` from `fake-indexeddb` in Node unit tests. */
    readonly keyRange?: typeof IDBKeyRange | undefined;
    readonly nowMs?: (() => number) | undefined;
}

/** Eviction budget options for the session entries cache slice. */
export interface SessionCacheBudgetOptions {
    /** Total cache byte budget across all sessions; defaults to 100 MB. */
    readonly maxBytes?: number | undefined;
    /** Maximum number of cached sessions; defaults to 80. */
    readonly maxSessions?: number | undefined;
}

/** Construction options for the IndexedDB-backed {@link AppCache} implementation. */
export interface AppCacheOptions extends IndexedDbCoordinatorOptions, SessionCacheBudgetOptions {}
