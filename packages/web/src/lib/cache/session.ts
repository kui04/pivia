import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    isFileEntryRecord,
    isRecord,
    parseEntriesVersion,
    parseSessionId,
    type EntriesVersion,
    type SessionId,
} from "@pivia/protocol";

import { Log } from "../log";

import {
    isQuotaExceededError,
    requestPromise,
    transactionDone,
    type CacheSlice,
    type IndexedDbCoordinator,
    type ObjectStoreSchema,
} from "./idb";
import type {
    CachedSessionSnapshot,
    CacheWriteOutcome,
    SessionCache,
    SessionCacheBudgetOptions,
    SessionCacheMeta,
} from "./types";

/** One row stored in `session_entries` under composite primary key `[sessionId, index]`. */
interface SessionCacheEntryRow {
    readonly sessionId: SessionId;
    readonly index: number;
    readonly entry: FileEntry;
}

export const STORE_META = "session_meta";
export const STORE_ENTRIES = "session_entries";

const SESSION_OBJECT_STORES: readonly ObjectStoreSchema[] = [
    { name: STORE_META, options: { keyPath: "sessionId" } },
    { name: STORE_ENTRIES, options: { keyPath: ["sessionId", "index"] } },
];

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 80;

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
    for (let expectedIndex = 0; expectedIndex < raw.length; expectedIndex += 1) {
        const parsed = parseSessionCacheEntryRow(raw[expectedIndex], expectedSessionId);
        if (parsed === null || parsed.index !== expectedIndex) {
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

/**
 * Row-level IndexedDB session entries cache (`session_meta` + `session_entries`) with memory fallback.
 *
 * `session_entries` stores one row per entry (`[sessionId, index]`) so streaming appends write
 * only O(new bytes) instead of re-serializing up to 64 MB per turn.
 */
export class IndexedDbSessionCacheSlice implements SessionCache, CacheSlice {
    readonly schemas = SESSION_OBJECT_STORES;

    private readonly coordinator: IndexedDbCoordinator;
    private readonly maxBytes: number;
    private readonly maxSessions: number;

    private readonly memMeta = new Map<SessionId, SessionCacheMeta>();
    private readonly memEntries = new Map<SessionId, FileEntry[]>();

    constructor(coordinator: IndexedDbCoordinator, options: SessionCacheBudgetOptions = {}) {
        this.coordinator = coordinator;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    }

    clearMemory(): void {
        this.memMeta.clear();
        this.memEntries.clear();
    }

    async freeSpace(db: IDBDatabase): Promise<void> {
        await this.evictAllExcept(db, null);
    }

    private rawSessionEntryRange(rawSessionId: string): IDBKeyRange {
        if (this.coordinator.keyRange === undefined) {
            throw new Error("IDBKeyRange is unavailable.");
        }
        return this.coordinator.keyRange.bound([rawSessionId, 0], [rawSessionId, Infinity]);
    }

    private sessionEntryRange(sessionId: SessionId): IDBKeyRange {
        return this.rawSessionEntryRange(sessionId);
    }

    async get(sessionId: SessionId): Promise<CachedSessionSnapshot | null> {
        const db = await this.coordinator.openDb();
        if (db === null) {
            return this.getMemorySession(sessionId);
        }
        try {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            const metaStore = tx.objectStore(STORE_META);
            const entriesStore = tx.objectStore(STORE_ENTRIES);

            const metaRaw = await requestPromise(metaStore.get(sessionId));
            if (metaRaw === undefined) {
                await transactionDone(tx);
                return null;
            }
            const meta = parseSessionCacheMeta(metaRaw);
            const rowsRaw = await requestPromise(entriesStore.getAll(this.sessionEntryRange(sessionId)));
            const rows = meta === null ? null : parseSessionCacheEntryRows(rowsRaw, sessionId);
            const lastEntry = rows?.at(-1)?.entry;
            if (
                meta === null ||
                rows === null ||
                rows.length !== meta.entryCount ||
                rows[0]?.entry.type !== "session" ||
                (lastEntry?.id !== undefined && lastEntry.id !== meta.lastEntryId)
            ) {
                await requestPromise(metaStore.delete(sessionId));
                await requestPromise(entriesStore.delete(this.sessionEntryRange(sessionId)));
                await transactionDone(tx);
                return null;
            }
            const updatedMeta: SessionCacheMeta = { ...meta, lastAccessedAtMs: this.coordinator.nowMs() };
            await requestPromise(metaStore.put(updatedMeta));
            await transactionDone(tx);
            return {
                meta: updatedMeta,
                entries: rows.map((row) => row.entry),
            };
        } catch (error) {
            Log.warn("IndexedDB session cache get failed, falling back to memory cache", error);
            this.coordinator.degrade();
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
        const db = await this.coordinator.openDb();
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
                lastAccessedAtMs: this.coordinator.nowMs(),
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
            await this.delete(sessionId);
            return this.coordinator.isDegraded() ? "degraded-memory" : "written";
        }
        const db = await this.coordinator.openDb();
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
                lastEntry?.id !== undefined
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
                lastAccessedAtMs: this.coordinator.nowMs(),
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

    async delete(sessionId: SessionId): Promise<void> {
        this.memMeta.delete(sessionId);
        this.memEntries.delete(sessionId);

        if (this.coordinator.keyRange === undefined) {
            return;
        }
        await this.coordinator.runCleanup("session cache delete", async (db) => {
            const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
            await requestPromise(tx.objectStore(STORE_META).delete(sessionId));
            await requestPromise(tx.objectStore(STORE_ENTRIES).delete(this.sessionEntryRange(sessionId)));
            await transactionDone(tx);
        });
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
            this.coordinator.degrade();
            return memoryFallback();
        }
    }

    private async evictAllExcept(db: IDBDatabase, keepSessionId: SessionId | null): Promise<void> {
        const tx = db.transaction([STORE_META, STORE_ENTRIES], "readwrite");
        const metaStore = tx.objectStore(STORE_META);
        const entriesStore = tx.objectStore(STORE_ENTRIES);
        const { valid, corruptIds } = partitionSessionCacheMetas(await requestPromise(metaStore.getAll()));
        for (const corruptId of corruptIds) {
            await requestPromise(metaStore.delete(corruptId));
            await requestPromise(entriesStore.delete(this.rawSessionEntryRange(corruptId)));
        }
        for (const meta of valid) {
            if (keepSessionId !== null && meta.sessionId === keepSessionId) {
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
        const updatedMeta: SessionCacheMeta = { ...meta, lastAccessedAtMs: this.coordinator.nowMs() };
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
            lastAccessedAtMs: this.coordinator.nowMs(),
        });
        this.enforceMemoryLimits(sessionId);
        return this.coordinator.isDegraded() ? "degraded-memory" : "written";
    }

    private replaceMemoryEntries(
        sessionId: SessionId,
        entriesVersion: EntriesVersion,
        entries: readonly FileEntry[],
    ): CacheWriteOutcome {
        const existingMeta = this.memMeta.get(sessionId);
        const existingEntries = this.memEntries.get(sessionId);
        const lastEntry = entries[entries.length - 1];
        if (
            existingMeta !== undefined &&
            existingEntries !== undefined &&
            existingMeta.entriesVersion === entriesVersion &&
            entries.length <= existingMeta.entryCount &&
            lastEntry?.id !== undefined &&
            existingEntries[entries.length - 1]?.id === lastEntry.id
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
            lastAccessedAtMs: this.coordinator.nowMs(),
        });
        this.enforceMemoryLimits(sessionId);
        return this.coordinator.isDegraded() ? "degraded-memory" : "written";
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
