import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    isFileEntryRecord,
    isRecord,
    parseCatalogSnapshot,
    parseEntriesVersion,
    parseSessionId,
    type CatalogSnapshot,
    type EntriesVersion,
    type SessionId,
    type SessionSummary,
} from "@pivia/protocol";

import { Log } from "@/lib/log";

/** Metadata stored per cached session in `session_meta`. */
export interface SessionCacheMeta {
    readonly sessionId: SessionId;
    readonly entriesVersion: EntriesVersion;
    /** Total cached entry count including the session header (`entries[0]`). */
    readonly entryCount: number;
    /** Id of `entries[entryCount - 1]`; equals `sessionId` when `entryCount === 1`. */
    readonly lastEntryId: string;
    readonly estimatedBytes: number;
    readonly lastAccessedAtMs: number;
}

/** One row stored in `session_entries` under composite primary key `[sessionId, index]`. */
export interface SessionCacheEntryRow {
    readonly sessionId: SessionId;
    readonly index: number;
    readonly entry: FileEntry;
}

/** Cached workspace catalog snapshot stored in `workspace_catalog` under key `"default"`. */
export interface WorkspaceCatalogCacheRecord extends CatalogSnapshot {
    readonly key: "default";
}

/** Result of loading a cached session from {@link SessionCacheStore}. */
export interface CachedSessionSnapshot {
    readonly meta: SessionCacheMeta;
    readonly entries: readonly FileEntry[];
}

/** Explicit outcome of an IndexedDB write transaction. */
export type CacheWriteOutcome = "written" | "skipped-stale" | "degraded-memory";

/** Construction options for {@link IndexedDbSessionCache}. */
export interface SessionCacheOptions {
    /** Defaults to `globalThis.indexedDB`; pass `fake-indexeddb` in Node unit tests. */
    readonly indexedDB?: IDBFactory | undefined;
    /** Defaults to `globalThis.IDBKeyRange`; pass `IDBKeyRange` from `fake-indexeddb` in Node unit tests. */
    readonly keyRange?: typeof IDBKeyRange | undefined;
    readonly nowMs?: (() => number) | undefined;
    /** Total cache byte budget across all sessions; defaults to 100 MB. */
    readonly maxBytes?: number | undefined;
    /** Maximum number of cached sessions; defaults to 80. */
    readonly maxSessions?: number | undefined;
}

/** Persistence contract consumed by the session, workspace, and auth stores. */
export interface SessionCacheStore {
    getSession(sessionId: SessionId): Promise<CachedSessionSnapshot | null>;
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
    deleteSession(sessionId: SessionId): Promise<void>;
    getWorkspaceCatalog(): Promise<WorkspaceCatalogCacheRecord | null>;
    putWorkspaceCatalog(sessions: readonly SessionSummary[], updatedAtMs: number): Promise<void>;
    clearAll(): Promise<void>;
}

const DB_NAME = "pivia.cache.v1";
const DB_VERSION = 1;
const STORE_META = "session_meta";
const STORE_ENTRIES = "session_entries";
const STORE_CATALOG = "workspace_catalog";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 80;

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    });
}

/**
 * Bytes one entry occupies in IndexedDB.
 *
 * IndexedDB stores strings as UTF-16, so one code unit costs two bytes. Counting the serialized
 * length alone would let the cache grow to twice the documented budget before eviction starts.
 */
function entryBytes(entry: FileEntry): number {
    return JSON.stringify(entry).length * 2;
}

function estimateEntriesBytes(entries: readonly FileEntry[]): number {
    let bytes = 0;
    for (const entry of entries) {
        bytes += entryBytes(entry);
    }
    return bytes;
}

function parseSessionCacheMeta(raw: unknown): SessionCacheMeta | null {
    if (!isRecord(raw)) {
        return null;
    }
    const sessionId = parseSessionId(raw.sessionId);
    const entriesVersion = parseEntriesVersion(raw.entriesVersion);
    if (
        sessionId === null ||
        entriesVersion === null ||
        typeof raw.entryCount !== "number" ||
        !Number.isSafeInteger(raw.entryCount) ||
        raw.entryCount < 1 ||
        typeof raw.lastEntryId !== "string" ||
        raw.lastEntryId.length === 0 ||
        typeof raw.estimatedBytes !== "number" ||
        !Number.isFinite(raw.estimatedBytes) ||
        raw.estimatedBytes < 0 ||
        typeof raw.lastAccessedAtMs !== "number" ||
        !Number.isFinite(raw.lastAccessedAtMs)
    ) {
        return null;
    }
    return {
        sessionId,
        entriesVersion,
        entryCount: raw.entryCount,
        lastEntryId: raw.lastEntryId,
        estimatedBytes: raw.estimatedBytes,
        lastAccessedAtMs: raw.lastAccessedAtMs,
    };
}

function parseSessionCacheEntryRow(raw: unknown, expectedSessionId: SessionId): SessionCacheEntryRow | null {
    if (!isRecord(raw)) {
        return null;
    }
    const sessionId = parseSessionId(raw.sessionId);
    if (
        sessionId !== expectedSessionId ||
        typeof raw.index !== "number" ||
        !Number.isSafeInteger(raw.index) ||
        raw.index < 0 ||
        !isFileEntryRecord(raw.entry)
    ) {
        return null;
    }
    return {
        sessionId,
        index: raw.index,
        entry: raw.entry,
    };
}

function parseSessionCacheEntryRows(raw: unknown, expectedSessionId: SessionId): SessionCacheEntryRow[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }
    const rows: SessionCacheEntryRow[] = [];
    for (const item of raw) {
        const parsed = parseSessionCacheEntryRow(item, expectedSessionId);
        if (parsed === null) {
            return null;
        }
        rows.push(parsed);
    }
    return rows;
}

function partitionSessionCacheMetas(raw: unknown): {
    readonly valid: SessionCacheMeta[];
    readonly corruptIds: string[];
} {
    if (!Array.isArray(raw)) {
        return { valid: [], corruptIds: [] };
    }
    const valid: SessionCacheMeta[] = [];
    const corruptIds: string[] = [];
    for (const item of raw) {
        const parsed = parseSessionCacheMeta(item);
        if (parsed !== null) {
            valid.push(parsed);
        } else if (isRecord(item) && typeof item.sessionId === "string" && item.sessionId.length > 0) {
            corruptIds.push(item.sessionId);
        }
    }
    return { valid, corruptIds };
}

function parseWorkspaceCatalogRecord(raw: unknown): WorkspaceCatalogCacheRecord | null {
    if (!isRecord(raw) || raw.key !== "default") {
        return null;
    }
    const snapshot = parseCatalogSnapshot(raw);
    return snapshot === null ? null : { key: "default", ...snapshot };
}

function isQuotaExceededError(error: unknown): boolean {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
        return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
    }
    return error instanceof Error && error.name === "QuotaExceededError";
}

/**
 * Row-level IndexedDB cache (`pivia.cache.v1`) with graceful in-memory fallback.
 *
 * `session_entries` stores one row per entry (`[sessionId, index]`) so streaming appends write
 * only O(new bytes) instead of re-serializing up to 64 MB per turn.
 */
export class IndexedDbSessionCache implements SessionCacheStore {
    private readonly idbFactory: IDBFactory | undefined;
    private readonly keyRange: typeof IDBKeyRange | undefined;
    private readonly nowMs: () => number;
    private readonly maxBytes: number;
    private readonly maxSessions: number;

    private dbPromise: Promise<IDBDatabase | null> | null = null;
    private degradedToMemory = false;

    private readonly memMeta = new Map<SessionId, SessionCacheMeta>();
    private readonly memEntries = new Map<SessionId, FileEntry[]>();
    private memCatalog: WorkspaceCatalogCacheRecord | null = null;

    constructor(options: SessionCacheOptions = {}) {
        this.idbFactory = options.indexedDB ?? (typeof globalThis !== "undefined" ? globalThis.indexedDB : undefined);
        this.keyRange = options.keyRange ?? (typeof globalThis !== "undefined" ? globalThis.IDBKeyRange : undefined);
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
        if (this.idbFactory === undefined || this.keyRange === undefined) {
            this.degradedToMemory = true;
        }
    }

    private rawSessionEntryRange(rawSessionId: string): IDBKeyRange {
        if (this.keyRange === undefined) {
            throw new Error("IDBKeyRange is unavailable.");
        }
        return this.keyRange.bound([rawSessionId, 0], [rawSessionId, Infinity]);
    }

    private sessionEntryRange(sessionId: SessionId): IDBKeyRange {
        return this.rawSessionEntryRange(sessionId);
    }

    async getSession(sessionId: SessionId): Promise<CachedSessionSnapshot | null> {
        const db = await this.openDb();
        if (db === null) {
            return this.getMemorySession(sessionId);
        }
        try {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            const metaStore = tx.objectStore(STORE_META);
            const entriesStore = tx.objectStore(STORE_ENTRIES);

            const metaRaw: unknown = await requestPromise(metaStore.get(sessionId));
            if (metaRaw === undefined) {
                await transactionDone(tx);
                return null;
            }
            const meta = parseSessionCacheMeta(metaRaw);
            const rowsRaw: unknown = await requestPromise(entriesStore.getAll(this.sessionEntryRange(sessionId)));
            const rows = meta === null ? null : parseSessionCacheEntryRows(rowsRaw, sessionId);
            if (
                meta === null ||
                rows === null ||
                rows.length !== meta.entryCount ||
                rows[0]?.entry.type !== "session"
            ) {
                await requestPromise(metaStore.delete(sessionId));
                await requestPromise(entriesStore.delete(this.sessionEntryRange(sessionId)));
                await transactionDone(tx);
                return null;
            }
            const updatedMeta: SessionCacheMeta = { ...meta, lastAccessedAtMs: this.nowMs() };
            await requestPromise(metaStore.put(updatedMeta));
            await transactionDone(tx);
            return {
                meta: updatedMeta,
                entries: rows.map((row) => row.entry),
            };
        } catch (error) {
            Log.warn("IndexedDB getSession failed, falling back to memory cache", error);
            this.degrade();
            return this.getMemorySession(sessionId);
        }
    }

    async appendEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        baseEntryCount: number,
        entries: readonly FileEntry[],
    ): Promise<CacheWriteOutcome> {
        if (entries.length === 0) {
            return "skipped-stale";
        }
        const db = await this.openDb();
        if (db === null) {
            return this.appendMemoryEntries(sessionId, entriesVersion, baseEntryCount, entries);
        }

        const runAttempt = async (): Promise<CacheWriteOutcome> => {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            const metaStore = tx.objectStore(STORE_META);
            const entriesStore = tx.objectStore(STORE_ENTRIES);

            const existingMeta = parseSessionCacheMeta(await requestPromise(metaStore.get(sessionId)));
            if (
                existingMeta === null ||
                existingMeta.entriesVersion !== entriesVersion ||
                existingMeta.entryCount < baseEntryCount
            ) {
                await transactionDone(tx);
                return "skipped-stale";
            }

            const newTotalCount = baseEntryCount + entries.length;
            if (newTotalCount <= existingMeta.entryCount) {
                await transactionDone(tx);
                return "skipped-stale";
            }

            const overlap = existingMeta.entryCount - baseEntryCount;
            const toInsert = entries.slice(overlap);
            let addedBytes = 0;
            for (let offset = 0; offset < toInsert.length; offset += 1) {
                const entry = toInsert[offset];
                if (entry === undefined) {
                    continue;
                }
                addedBytes += entryBytes(entry);
                const row: SessionCacheEntryRow = {
                    sessionId,
                    index: existingMeta.entryCount + offset,
                    entry,
                };
                await requestPromise(entriesStore.put(row));
            }
            const lastEntry = toInsert.at(-1);
            const nextMeta: SessionCacheMeta = {
                sessionId,
                entriesVersion,
                entryCount: newTotalCount,
                lastEntryId: lastEntry?.id ?? existingMeta.lastEntryId,
                estimatedBytes: existingMeta.estimatedBytes + addedBytes,
                lastAccessedAtMs: this.nowMs(),
            };
            await requestPromise(metaStore.put(nextMeta));
            await transactionDone(tx);
            await this.enforceLimits(db, sessionId);
            return "written";
        };

        return this.executeWithQuotaRetry(db, sessionId, runAttempt, () =>
            this.appendMemoryEntries(sessionId, entriesVersion, baseEntryCount, entries),
        );
    }

    async replaceEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        entries: readonly FileEntry[],
    ): Promise<CacheWriteOutcome> {
        if (entries.length === 0) {
            await this.deleteSession(sessionId);
            return "written";
        }
        const db = await this.openDb();
        if (db === null) {
            return this.replaceMemoryEntries(sessionId, entriesVersion, entries);
        }

        const runAttempt = async (): Promise<CacheWriteOutcome> => {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            const metaStore = tx.objectStore(STORE_META);
            const entriesStore = tx.objectStore(STORE_ENTRIES);

            const existingMeta = parseSessionCacheMeta(await requestPromise(metaStore.get(sessionId)));
            const lastEntry = entries[entries.length - 1];
            // A slower tab can only offer an older, shorter snapshot of the same history. A file
            // rewritten down to a strict prefix looks identical here, so it is treated as stale as
            // well; the next handshake repairs that cache once the tail id differs.
            if (
                existingMeta !== null &&
                existingMeta.entriesVersion === entriesVersion &&
                entries.length <= existingMeta.entryCount &&
                lastEntry !== undefined
            ) {
                const rowAtEnd = parseSessionCacheEntryRow(
                    await requestPromise(entriesStore.get([sessionId, entries.length - 1])),
                    sessionId,
                );
                if (rowAtEnd?.entry.id === lastEntry.id) {
                    await transactionDone(tx);
                    return "skipped-stale";
                }
            }

            await requestPromise(entriesStore.delete(this.sessionEntryRange(sessionId)));
            let estimatedBytes = 0;
            for (let index = 0; index < entries.length; index += 1) {
                const entry = entries[index];
                if (entry === undefined) {
                    continue;
                }
                estimatedBytes += entryBytes(entry);
                await requestPromise(entriesStore.put({ sessionId, index, entry } satisfies SessionCacheEntryRow));
            }
            const nextMeta: SessionCacheMeta = {
                sessionId,
                entriesVersion,
                entryCount: entries.length,
                lastEntryId: lastEntry?.id ?? sessionId,
                estimatedBytes,
                lastAccessedAtMs: this.nowMs(),
            };
            await requestPromise(metaStore.put(nextMeta));
            await transactionDone(tx);
            await this.enforceLimits(db, sessionId);
            return "written";
        };

        return this.executeWithQuotaRetry(db, sessionId, runAttempt, () =>
            this.replaceMemoryEntries(sessionId, entriesVersion, entries),
        );
    }

    async deleteSession(sessionId: SessionId): Promise<void> {
        this.memMeta.delete(sessionId);
        this.memEntries.delete(sessionId);

        const db = await this.openDbForCleanup();
        if (db === null) {
            return;
        }
        try {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            await requestPromise(tx.objectStore(STORE_META).delete(sessionId));
            await requestPromise(tx.objectStore(STORE_ENTRIES).delete(this.sessionEntryRange(sessionId)));
            await transactionDone(tx);
        } catch (error) {
            Log.warn("IndexedDB deleteSession failed", error);
        }
    }

    async getWorkspaceCatalog(): Promise<WorkspaceCatalogCacheRecord | null> {
        const db = await this.openDb();
        if (db === null) {
            return this.memCatalog;
        }
        try {
            const tx = db.transaction([STORE_CATALOG], "readwrite");
            const catalogStore = tx.objectStore(STORE_CATALOG);
            const raw: unknown = await requestPromise(catalogStore.get("default"));
            if (raw === undefined) {
                await transactionDone(tx);
                return null;
            }
            const record = parseWorkspaceCatalogRecord(raw);
            if (record === null) {
                await requestPromise(catalogStore.delete("default"));
                await transactionDone(tx);
                return null;
            }
            await transactionDone(tx);
            return record;
        } catch (error) {
            Log.warn("IndexedDB getWorkspaceCatalog failed, falling back to memory cache", error);
            this.degrade();
            return this.memCatalog;
        }
    }

    async putWorkspaceCatalog(sessions: readonly SessionSummary[], updatedAtMs: number): Promise<void> {
        const record: WorkspaceCatalogCacheRecord = { key: "default", sessions, updatedAtMs };
        const db = await this.openDb();
        if (db === null) {
            this.memCatalog = record;
            return;
        }
        try {
            const tx = db.transaction([STORE_CATALOG], "readwrite");
            await requestPromise(tx.objectStore(STORE_CATALOG).put(record));
            await transactionDone(tx);
        } catch (error) {
            Log.warn("IndexedDB putWorkspaceCatalog failed", error);
            this.degrade();
            this.memCatalog = record;
        }
    }

    async clearAll(): Promise<void> {
        this.memMeta.clear();
        this.memEntries.clear();
        this.memCatalog = null;

        const db = await this.openDbForCleanup();
        if (db === null) {
            return;
        }
        try {
            const tx = db.transaction([STORE_META, STORE_ENTRIES, STORE_CATALOG], "readwrite");
            await requestPromise(tx.objectStore(STORE_META).clear());
            await requestPromise(tx.objectStore(STORE_ENTRIES).clear());
            await requestPromise(tx.objectStore(STORE_CATALOG).clear());
            await transactionDone(tx);
        } catch (error) {
            Log.warn("IndexedDB clearAll failed", error);
        }
    }

    private async openDb(): Promise<IDBDatabase | null> {
        if (this.degradedToMemory || this.idbFactory === undefined) {
            return null;
        }
        if (this.dbPromise !== null) {
            return this.dbPromise;
        }
        const factory = this.idbFactory;
        this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
            try {
                const request = factory.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(STORE_META)) {
                        db.createObjectStore(STORE_META, { keyPath: "sessionId" });
                    }
                    if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
                        db.createObjectStore(STORE_ENTRIES, { keyPath: ["sessionId", "index"] });
                    }
                    if (!db.objectStoreNames.contains(STORE_CATALOG)) {
                        db.createObjectStore(STORE_CATALOG, { keyPath: "key" });
                    }
                };
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => {
                        db.close();
                        this.dbPromise = null;
                    };
                    resolve(db);
                };
                request.onerror = () => {
                    this.degrade();
                    resolve(null);
                };
                request.onblocked = () => {
                    this.degrade();
                    resolve(null);
                };
            } catch {
                this.degrade();
                resolve(null);
            }
        });
        return this.dbPromise;
    }

    private async openDbForCleanup(): Promise<IDBDatabase | null> {
        const pending = this.dbPromise;
        if (pending !== null) {
            const opened = await pending;
            if (opened !== null) {
                return opened;
            }
        }
        if (this.idbFactory === undefined) {
            return null;
        }
        // A degraded cache must still drop persisted rows: logout, a `401` and a removed session
        // all rely on it, and a full device is exactly when freeing the rows matters most.
        const wasDegraded = this.degradedToMemory;
        this.dbPromise = null;
        this.degradedToMemory = false;
        try {
            return await this.openDb();
        } finally {
            this.degradedToMemory = wasDegraded;
        }
    }

    private degrade(): void {
        this.degradedToMemory = true;
    }

    private async executeWithQuotaRetry(
        db: IDBDatabase,
        keepSessionId: SessionId,
        attempt: () => Promise<CacheWriteOutcome>,
        memoryFallback: () => CacheWriteOutcome,
    ): Promise<CacheWriteOutcome> {
        try {
            return await attempt();
        } catch (error) {
            if (isQuotaExceededError(error)) {
                try {
                    await this.evictAllExcept(db, keepSessionId);
                    return await attempt();
                } catch (retryError) {
                    Log.warn("IndexedDB quota eviction retry failed, degrading to memory", retryError);
                }
            } else {
                Log.warn("IndexedDB write failed, degrading to memory", error);
            }
            this.degrade();
            return memoryFallback();
        }
    }

    private async evictAllExcept(db: IDBDatabase, keepSessionId: SessionId): Promise<void> {
        const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
        const metaStore = tx.objectStore(STORE_META);
        const entriesStore = tx.objectStore(STORE_ENTRIES);
        const { valid, corruptIds } = partitionSessionCacheMetas(await requestPromise(metaStore.getAll()));
        for (const corruptId of corruptIds) {
            await requestPromise(metaStore.delete(corruptId));
            await requestPromise(entriesStore.delete(this.rawSessionEntryRange(corruptId)));
        }
        for (const meta of valid) {
            if (meta.sessionId === keepSessionId) {
                continue;
            }
            await requestPromise(metaStore.delete(meta.sessionId));
            await requestPromise(entriesStore.delete(this.sessionEntryRange(meta.sessionId)));
        }
        await transactionDone(tx);
    }

    private async enforceLimits(db: IDBDatabase, keepSessionId: SessionId): Promise<void> {
        try {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            const metaStore = tx.objectStore(STORE_META);
            const entriesStore = tx.objectStore(STORE_ENTRIES);
            const { valid: allMetas, corruptIds } = partitionSessionCacheMetas(
                await requestPromise(metaStore.getAll()),
            );
            for (const corruptId of corruptIds) {
                await requestPromise(metaStore.delete(corruptId));
                await requestPromise(entriesStore.delete(this.rawSessionEntryRange(corruptId)));
            }

            let totalBytes = 0;
            for (const meta of allMetas) {
                totalBytes += meta.estimatedBytes;
            }
            if (allMetas.length <= this.maxSessions && totalBytes <= this.maxBytes) {
                await transactionDone(tx);
                return;
            }

            const candidates = allMetas
                .filter((meta) => meta.sessionId !== keepSessionId)
                .sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs);
            let remainingSessions = allMetas.length;

            for (const victim of candidates) {
                if (remainingSessions <= this.maxSessions && totalBytes <= this.maxBytes) {
                    break;
                }
                await requestPromise(metaStore.delete(victim.sessionId));
                await requestPromise(entriesStore.delete(this.sessionEntryRange(victim.sessionId)));
                remainingSessions -= 1;
                totalBytes -= victim.estimatedBytes;
            }
            await transactionDone(tx);
        } catch (error) {
            Log.warn("IndexedDB enforceLimits failed", error);
        }
    }

    private getMemorySession(sessionId: SessionId): CachedSessionSnapshot | null {
        const meta = this.memMeta.get(sessionId);
        const entries = this.memEntries.get(sessionId);
        if (meta === undefined || entries === undefined || entries.length !== meta.entryCount) {
            return null;
        }
        const updatedMeta: SessionCacheMeta = { ...meta, lastAccessedAtMs: this.nowMs() };
        this.memMeta.set(sessionId, updatedMeta);
        return { meta: updatedMeta, entries: [...entries] };
    }

    private appendMemoryEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        baseEntryCount: number,
        entries: readonly FileEntry[],
    ): CacheWriteOutcome {
        const existingMeta = this.memMeta.get(sessionId);
        const existingEntries = this.memEntries.get(sessionId);
        if (
            existingMeta === undefined ||
            existingEntries === undefined ||
            existingMeta.entriesVersion !== entriesVersion ||
            existingMeta.entryCount < baseEntryCount
        ) {
            return "skipped-stale";
        }
        const newTotalCount = baseEntryCount + entries.length;
        if (newTotalCount <= existingMeta.entryCount) {
            return "skipped-stale";
        }
        const overlap = existingMeta.entryCount - baseEntryCount;
        const additions = entries.slice(overlap);
        const merged = [...existingEntries, ...additions];
        this.memEntries.set(sessionId, merged);
        this.memMeta.set(sessionId, {
            sessionId,
            entriesVersion,
            entryCount: merged.length,
            lastEntryId: additions.at(-1)?.id ?? existingMeta.lastEntryId,
            estimatedBytes: existingMeta.estimatedBytes + estimateEntriesBytes(additions),
            lastAccessedAtMs: this.nowMs(),
        });
        this.enforceMemoryLimits(sessionId);
        return this.degradedToMemory ? "degraded-memory" : "written";
    }

    private replaceMemoryEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        entries: readonly FileEntry[],
    ): CacheWriteOutcome {
        if (entries.length === 0) {
            this.memMeta.delete(sessionId);
            this.memEntries.delete(sessionId);
            return this.degradedToMemory ? "degraded-memory" : "written";
        }
        const existingMeta = this.memMeta.get(sessionId);
        const existingEntries = this.memEntries.get(sessionId);
        const lastEntry = entries[entries.length - 1];
        if (
            existingMeta !== undefined &&
            existingEntries !== undefined &&
            existingMeta.entriesVersion === entriesVersion &&
            entries.length <= existingMeta.entryCount &&
            existingEntries[entries.length - 1]?.id === lastEntry?.id
        ) {
            return "skipped-stale";
        }
        this.memEntries.set(sessionId, [...entries]);
        this.memMeta.set(sessionId, {
            sessionId,
            entriesVersion,
            entryCount: entries.length,
            lastEntryId: lastEntry?.id ?? sessionId,
            estimatedBytes: estimateEntriesBytes(entries),
            lastAccessedAtMs: this.nowMs(),
        });
        this.enforceMemoryLimits(sessionId);
        return this.degradedToMemory ? "degraded-memory" : "written";
    }

    private enforceMemoryLimits(keepSessionId: SessionId): void {
        let totalBytes = 0;
        for (const meta of this.memMeta.values()) {
            totalBytes += meta.estimatedBytes;
        }
        if (this.memMeta.size <= this.maxSessions && totalBytes <= this.maxBytes) {
            return;
        }
        const victims = [...this.memMeta.values()]
            .filter((meta) => meta.sessionId !== keepSessionId)
            .sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs);
        for (const victim of victims) {
            if (this.memMeta.size <= this.maxSessions && totalBytes <= this.maxBytes) {
                break;
            }
            this.memMeta.delete(victim.sessionId);
            this.memEntries.delete(victim.sessionId);
            totalBytes -= victim.estimatedBytes;
        }
    }
}

/** Shared app-wide session cache backed by IndexedDB with automatic memory fallback. */
export const sessionCache: SessionCacheStore = new IndexedDbSessionCache();
