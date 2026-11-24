import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    isRecord,
    parseCatalogSnapshot,
    parseEntriesVersion,
    parseSessionId,
    type CatalogSnapshot,
    type EntriesVersion,
    type SessionId,
    type SessionSummary,
} from "@pivia/protocol";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";

import { IndexedDbCoordinator, IndexedDbSnapshotCache } from "./idb";
import { IndexedDbAppCache } from "./index";
import { IndexedDbSessionCacheSlice } from "./session";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function ev(raw: string): EntriesVersion {
    const parsed = parseEntriesVersion(raw);
    if (parsed === null) {
        throw new Error(`Invalid test entries version: ${raw}`);
    }
    return parsed;
}

const S1 = sid("s1");
const S2 = sid("s2");
const S3 = sid("s3");
const V152 = ev("3:1.5.2");
const V153 = ev("3:1.5.3");

function createTestCache(options: { nowMs?: () => number; maxSessions?: number; maxBytes?: number } = {}) {
    return new IndexedDbAppCache({
        indexedDB: new IDBFactory(),
        keyRange: IDBKeyRange,
        ...options,
    });
}

function header(id: string): FileEntry {
    return {
        type: "session",
        version: 3,
        id,
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd: "/tmp/project",
    };
}

function userEntry(id: string, parentId: string | null, text: string): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:01.000Z",
        message: { role: "user", content: text, timestamp: 1 },
    };
}

function summary(id: SessionId): SessionSummary {
    return {
        id,
        cwd: "/tmp/project",
        name: null,
        firstMessage: "hi",
        messageCount: 1,
        createdAtMs: 1000,
        modifiedAtMs: 2000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
    };
}

describe("IndexedDbAppCache", () => {
    it("persists row-level entries, appends incrementally, and skips stale/mismatched appends", async () => {
        let now = 1_000;
        const cache = createTestCache({ nowMs: () => now });
        const entries = [header("s1"), userEntry("e1", null, "first")];

        expect(await cache.sessions.replaceEntries(S1, V152, entries)).toBe("written");
        now = 2_000;

        const appendOk = await cache.sessions.appendEntries(S1, V152, 2, [userEntry("e2", "e1", "second")]);
        expect(appendOk).toBe("written");

        // Overlapping idempotent append from an older base advances only missing rows.
        const overlapAppend = await cache.sessions.appendEntries(S1, V152, 2, [
            userEntry("e2", "e1", "second"),
            userEntry("e3", "e2", "third"),
        ]);
        expect(overlapAppend).toBe("written");

        // Stale or version-mismatched appends are skipped safely.
        expect(await cache.sessions.appendEntries(S1, V152, 2, [userEntry("e2", "e1", "second")])).toBe(
            "skipped-stale",
        );
        expect(await cache.sessions.appendEntries(S1, V153, 4, [userEntry("e4", "e3", "fourth")])).toBe(
            "skipped-stale",
        );

        const loaded = await cache.sessions.get(S1);
        expect(loaded?.meta).toMatchObject({
            sessionId: S1,
            entriesVersion: V152,
            entryCount: 4,
            lastEntryId: "e3",
        });
        expect(loaded?.entries.map((entry) => entry.id)).toEqual(["s1", "e1", "e2", "e3"]);
    });

    it("prevents slow-tab rollback overwrites while allowing divergent overwrites", async () => {
        const cache = createTestCache();
        const full = [header("s1"), userEntry("e1", null, "one"), userEntry("e2", "e1", "two")];
        await cache.sessions.replaceEntries(S1, V152, full);

        // Slow tab tries to overwrite with an older prefix of length 2 -> skipped.
        const staleOverwrite = await cache.sessions.replaceEntries(S1, V152, full.slice(0, 2));
        expect(staleOverwrite).toBe("skipped-stale");
        expect((await cache.sessions.get(S1))?.entries).toHaveLength(3);

        // Divergent rewrite (e.g. external CLI replaced entry e1 with e1-alt) -> accepted.
        const divergent = [header("s1"), userEntry("e1-alt", null, "rewritten")];
        expect(await cache.sessions.replaceEntries(S1, V152, divergent)).toBe("written");
        expect((await cache.sessions.get(S1))?.entries.map((entry) => entry.id)).toEqual(["s1", "e1-alt"]);
    });

    it("evicts oldest sessions when exceeding maxSessions or maxBytes, deletes sessions, and clears all stores", async () => {
        let now = 100;
        const cache = createTestCache({
            nowMs: () => now,
            maxSessions: 2,
            maxBytes: 100_000,
        });

        await cache.sessions.replaceEntries(S1, V152, [header("s1")]);
        now = 200;
        await cache.sessions.replaceEntries(S2, V152, [header("s2")]);
        now = 300;
        // Touch s1 so s2 becomes the LRU victim when s3 is added.
        await cache.sessions.get(S1);
        now = 400;
        await cache.sessions.replaceEntries(S3, V152, [header("s3")]);

        expect(await cache.sessions.get(S2)).toBeNull();
        expect(await cache.sessions.get(S1)).not.toBeNull();
        expect(await cache.sessions.get(S3)).not.toBeNull();

        await cache.sessions.delete(S1);
        expect(await cache.sessions.get(S1)).toBeNull();

        await cache.catalog.put({ sessions: [summary(S3)], updatedAtMs: 9_000 });
        expect(await cache.catalog.get()).toEqual({
            sessions: [summary(S3)],
            updatedAtMs: 9_000,
        });

        await cache.clearAll();
        expect(await cache.sessions.get(S3)).toBeNull();
        expect(await cache.catalog.get()).toBeNull();
    });

    it("still deletes persisted rows after a quota failure degraded the cache to memory", async () => {
        const factory = new IDBFactory();
        const seeded = new IndexedDbAppCache({ indexedDB: factory, keyRange: IDBKeyRange });
        await seeded.sessions.replaceEntries(S1, V152, [header("s1"), userEntry("e1", null, "first")]);

        // Every range write reports a full device, so eviction plus retry cannot succeed.
        const quotaKeyRange = {
            bound(): IDBKeyRange {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
            },
        } as unknown as typeof IDBKeyRange;
        const failing = new IndexedDbAppCache({ indexedDB: factory, keyRange: quotaKeyRange });
        expect(
            await failing.sessions.replaceEntries(S1, V152, [header("s1"), userEntry("e1-alt", null, "rewritten")]),
        ).toBe("degraded-memory");

        // Logout and a removed session must still reach IndexedDB after the degradation.
        await failing.clearAll();

        const reader = new IndexedDbAppCache({ indexedDB: factory, keyRange: IDBKeyRange });
        expect(await reader.sessions.get(S1)).toBeNull();
    });

    it("degrades gracefully to in-memory storage when indexedDB is unavailable", async () => {
        const cache = new IndexedDbAppCache({ indexedDB: undefined });
        expect(await cache.sessions.replaceEntries(S1, V152, [header("s1")])).toBe("degraded-memory");
        expect(await cache.sessions.appendEntries(S1, V152, 1, [userEntry("e1", null, "hi")])).toBe("degraded-memory");
        expect((await cache.sessions.get(S1))?.entries).toHaveLength(2);

        await cache.catalog.put({ sessions: [summary(S1)], updatedAtMs: 1_000 });
        expect(await cache.catalog.get()).toEqual({
            sessions: [summary(S1)],
            updatedAtMs: 1_000,
        });
    });

    it("rejects and self-heals corrupted IndexedDB meta and catalog records", async () => {
        const factory = new IDBFactory();
        const cache = new IndexedDbAppCache({ indexedDB: factory, keyRange: IDBKeyRange });
        await cache.sessions.replaceEntries(S1, V152, [header("s1")]);
        await cache.catalog.put({ sessions: [summary(S1)], updatedAtMs: 5_000 });

        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open("pivia.cache.v1", 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB."));
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(["session_meta", "workspace_catalog"], "readwrite");
            tx.objectStore("session_meta").put({ sessionId: S1, entriesVersion: "corrupt" });
            tx.objectStore("session_meta").put({ sessionId: "s-corrupt", entriesVersion: "bad" });
            tx.objectStore("workspace_catalog").put({
                key: "default",
                value: { sessions: [{ id: "../bad" }], updatedAtMs: 1 },
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Failed to write corrupted IndexedDB rows."));
        });
        db.close();

        expect(await cache.sessions.get(S1)).toBeNull();
        expect(await cache.catalog.get()).toBeNull();
        expect(await cache.sessions.replaceEntries(S2, V152, [header("s2")])).toBe("written");

        const reopened = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open("pivia.cache.v1", 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error("Failed to reopen IndexedDB."));
        });
        const remaining = await new Promise<{
            metaS1: unknown;
            metaCorrupt: unknown;
            catalog: unknown;
        }>((resolve, reject) => {
            const tx = reopened.transaction(["session_meta", "workspace_catalog"], "readonly");
            const reqS1 = tx.objectStore("session_meta").get(S1);
            const reqCorrupt = tx.objectStore("session_meta").get("s-corrupt");
            const reqCatalog = tx.objectStore("workspace_catalog").get("default");
            tx.oncomplete = () =>
                resolve({
                    metaS1: reqS1.result,
                    metaCorrupt: reqCorrupt.result,
                    catalog: reqCatalog.result,
                });
            tx.onerror = () => reject(tx.error ?? new Error("Failed to inspect IndexedDB."));
        });
        reopened.close();

        expect(remaining).toEqual({
            metaS1: undefined,
            metaCorrupt: undefined,
            catalog: undefined,
        });
    });

    it("evicts oldest sessions by maxBytes budget using UTF-16 byte accounting", async () => {
        const s1Header = header("s1");
        const s2Header = header("s2");
        const s3Header = header("s3");
        const singleBytes = JSON.stringify(s1Header).length * 2;
        let now = 100;
        const cache = createTestCache({
            nowMs: () => now,
            maxSessions: 10,
            maxBytes: singleBytes * 2 + 10,
        });

        await cache.sessions.replaceEntries(S1, V152, [s1Header]);
        now = 200;
        await cache.sessions.replaceEntries(S2, V152, [s2Header]);
        now = 300;
        await cache.sessions.get(S1);
        now = 400;
        await cache.sessions.replaceEntries(S3, V152, [s3Header]);

        expect(await cache.sessions.get(S2)).toBeNull();
        expect(await cache.sessions.get(S1)).not.toBeNull();
        expect(await cache.sessions.get(S3)).not.toBeNull();
    });

    it("retries successfully after QuotaExceededError by evicting older sessions", async () => {
        const coordinator = new IndexedDbCoordinator("pivia.quota-retry.v1", 1, {
            indexedDB: new IDBFactory(),
            keyRange: IDBKeyRange,
        });
        const sessions = coordinator.registerSlice(new IndexedDbSessionCacheSlice(coordinator));
        await sessions.replaceEntries(S1, V152, [header("s1")]);

        const db = await coordinator.openDb();
        if (db === null) {
            throw new Error("Expected opened IDBDatabase.");
        }
        let failFirstPut = true;
        const origTx = db.transaction.bind(db);
        const txSpy = vi.spyOn(db, "transaction").mockImplementation(((
            storeNames: string | string[],
            mode?: IDBTransactionMode,
        ) => {
            const tx = origTx(storeNames, mode);
            const origObjectStore = tx.objectStore.bind(tx);
            tx.objectStore = (storeName: string) => {
                const store = origObjectStore(storeName);
                if (storeName === "session_entries") {
                    const origPut = store.put.bind(store);
                    store.put = (value: unknown, key?: IDBValidKey) => {
                        if (failFirstPut) {
                            failFirstPut = false;
                            throw new DOMException("Quota exceeded", "QuotaExceededError");
                        }
                        return origPut(value, key);
                    };
                }
                return store;
            };
            return tx;
        }) as typeof db.transaction);

        expect(await sessions.replaceEntries(S2, V152, [header("s2")])).toBe("written");
        txSpy.mockRestore();

        expect(await sessions.get(S1)).toBeNull();
        expect(await sessions.get(S2)).not.toBeNull();
    });

    it("evicts sessions when catalog.put hits QuotaExceededError before degrading", async () => {
        const coordinator = new IndexedDbCoordinator("pivia.catalog-quota.v1", 1, {
            indexedDB: new IDBFactory(),
            keyRange: IDBKeyRange,
        });
        const sessions = coordinator.registerSlice(new IndexedDbSessionCacheSlice(coordinator));
        const catalog = coordinator.registerSlice(
            new IndexedDbSnapshotCache<CatalogSnapshot>({
                coordinator,
                storeName: "workspace_catalog",
                parse: parseCatalogSnapshot,
            }),
        );
        await sessions.replaceEntries(S1, V152, [header("s1")]);

        const db = await coordinator.openDb();
        if (db === null) {
            throw new Error("Expected opened IDBDatabase.");
        }
        let failOnce = true;
        const origTx = db.transaction.bind(db);
        const txSpy = vi.spyOn(db, "transaction").mockImplementation(((
            storeNames: string | string[],
            mode?: IDBTransactionMode,
        ) => {
            const tx = origTx(storeNames, mode);
            const origObjectStore = tx.objectStore.bind(tx);
            tx.objectStore = (storeName: string) => {
                const store = origObjectStore(storeName);
                if (storeName === "workspace_catalog") {
                    const origPut = store.put.bind(store);
                    store.put = (value: unknown, key?: IDBValidKey) => {
                        if (failOnce) {
                            failOnce = false;
                            throw new DOMException("Quota exceeded", "QuotaExceededError");
                        }
                        return origPut(value, key);
                    };
                }
                return store;
            };
            return tx;
        }) as typeof db.transaction);

        await catalog.put({ sessions: [summary(S1)], updatedAtMs: 12_000 });
        txSpy.mockRestore();

        expect(coordinator.isDegraded()).toBe(false);
        expect(await sessions.get(S1)).toBeNull();
        expect(await catalog.get()).toEqual({ sessions: [summary(S1)], updatedAtMs: 12_000 });
    });

    it("deletes session on empty replaceEntries in both healthy and degraded modes", async () => {
        const healthy = createTestCache();
        await healthy.sessions.replaceEntries(S1, V152, [header("s1")]);
        expect(await healthy.sessions.replaceEntries(S1, V152, [])).toBe("written");
        expect(await healthy.sessions.get(S1)).toBeNull();

        const degraded = new IndexedDbAppCache({ indexedDB: undefined });
        await degraded.sessions.replaceEntries(S1, V152, [header("s1")]);
        expect(await degraded.sessions.replaceEntries(S1, V152, [])).toBe("degraded-memory");
        expect(await degraded.sessions.get(S1)).toBeNull();
    });

    it("self-heals corrupted session_entries rows (gaps, bad header, mismatched tail id, invalid record)", async () => {
        const factory = new IDBFactory();
        const cache = new IndexedDbAppCache({ indexedDB: factory, keyRange: IDBKeyRange });

        const runCorruptionCase = async (
            mutateTx: (metaStore: IDBObjectStore, entriesStore: IDBObjectStore) => void,
        ): Promise<void> => {
            await cache.sessions.replaceEntries(S1, V152, [header("s1"), userEntry("e1", null, "one")]);
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const req = factory.open("pivia.cache.v1", 1);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error ?? new Error("Failed to open DB."));
            });
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(["session_meta", "session_entries"], "readwrite");
                mutateTx(tx.objectStore("session_meta"), tx.objectStore("session_entries"));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error ?? new Error("Corruption tx failed."));
            });
            db.close();

            expect(await cache.sessions.get(S1)).toBeNull();
        };

        // 1. Gap in row indices ([0, 2] with entryCount === 2).
        await runCorruptionCase((_metaStore, entriesStore) => {
            entriesStore.delete([S1, 1]);
            entriesStore.put({ sessionId: S1, index: 2, entry: userEntry("e2", "e1", "two") });
        });

        // 2. Index 0 is not a "session" header.
        await runCorruptionCase((_metaStore, entriesStore) => {
            entriesStore.put({ sessionId: S1, index: 0, entry: userEntry("e0", null, "not-header") });
        });

        // 3. Tail entry id disagrees with meta.lastEntryId.
        await runCorruptionCase((metaStore) => {
            metaStore.put({
                sessionId: S1,
                entriesVersion: V152,
                entryCount: 2,
                lastEntryId: "wrong-tail",
                estimatedBytes: 100,
                lastAccessedAtMs: 1_000,
            });
        });

        // 4. Invalid entry record shape.
        await runCorruptionCase((_metaStore, entriesStore) => {
            entriesStore.put({ sessionId: S1, index: 1, entry: { invalid: true } });
        });
    });

    it("deletes persisted sessions after degradation, clears memory in degraded mode, and keeps isDegraded intact across cleanup", async () => {
        const factory = new IDBFactory();
        const seeded = new IndexedDbAppCache({ indexedDB: factory, keyRange: IDBKeyRange });
        await seeded.sessions.replaceEntries(S1, V152, [header("s1"), userEntry("e1", null, "first")]);

        let throwOnBound = true;
        const toggleQuotaKeyRange = {
            bound(lower: unknown, upper: unknown): IDBKeyRange {
                if (throwOnBound) {
                    throw new DOMException("Quota exceeded", "QuotaExceededError");
                }
                return IDBKeyRange.bound(lower, upper);
            },
        } as unknown as typeof IDBKeyRange;
        const degraded = new IndexedDbAppCache({ indexedDB: factory, keyRange: toggleQuotaKeyRange });
        expect(
            await degraded.sessions.replaceEntries(S1, V152, [header("s1"), userEntry("e1-alt", null, "rewritten")]),
        ).toBe("degraded-memory");
        // Allow range creation again so delete() reaches IndexedDB while coordinator remains degraded.
        throwOnBound = false;
        await degraded.sessions.delete(S1);
        const reader = new IndexedDbAppCache({ indexedDB: factory, keyRange: IDBKeyRange });
        expect(await reader.sessions.get(S1)).toBeNull();

        // In-memory-only mode clears memMeta, memEntries, and memSnapshot on clearAll.
        const memoryOnly = new IndexedDbAppCache({ indexedDB: undefined });
        expect(await memoryOnly.sessions.replaceEntries(S1, V152, [header("s1")])).toBe("degraded-memory");
        await memoryOnly.catalog.put({ sessions: [summary(S1)], updatedAtMs: 100 });
        await memoryOnly.clearAll();
        expect(await memoryOnly.sessions.get(S1)).toBeNull();
        expect(await memoryOnly.catalog.get()).toBeNull();

        // Initial open failure followed by clearAll must still keep degraded state intact.
        const brokenFactory = {
            open(): IDBOpenDBRequest {
                throw new Error("IDB blocked");
            },
        } as unknown as IDBFactory;
        const broken = new IndexedDbAppCache({ indexedDB: brokenFactory, keyRange: IDBKeyRange });
        await broken.clearAll();
        expect(await broken.sessions.replaceEntries(S1, V152, [header("s1")])).toBe("degraded-memory");
    });

    it("preserves cross-slice snapshot fallback, isolates domain `key` fields, and recovers from closed/versionchanged connections", async () => {
        const factory = new IDBFactory();
        const coordinator = new IndexedDbCoordinator("pivia.snapshot-test.v1", 1, {
            indexedDB: factory,
            keyRange: IDBKeyRange,
        });
        type KeyedSnapshot = { readonly key: string; readonly label: string };
        const snapshotCache = coordinator.registerSlice(
            new IndexedDbSnapshotCache<KeyedSnapshot>({
                coordinator,
                storeName: "keyed_snap",
                parse: (raw) => {
                    if (!isRecord(raw) || typeof raw.key !== "string" || typeof raw.label !== "string") {
                        return null;
                    }
                    // Reject unknown extra keys to verify `{ key, value }` wrapper keeps storage key isolated.
                    if (Object.keys(raw).length !== 2) {
                        return null;
                    }
                    return { key: raw.key, label: raw.label };
                },
            }),
        );

        await snapshotCache.put({ key: "domain-key", label: "hello" });
        expect(await snapshotCache.get()).toEqual({ key: "domain-key", label: "hello" });

        // Simulate another slice degrading the shared coordinator: snapshotCache still serves memSnapshot.
        coordinator.degrade();
        expect(await snapshotCache.get()).toEqual({ key: "domain-key", label: "hello" });

        const flakyFactory = new IDBFactory();
        const flakyCoord = new IndexedDbCoordinator("pivia.flaky.v1", 1, {
            indexedDB: flakyFactory,
            keyRange: IDBKeyRange,
        });
        const flakySnap = flakyCoord.registerSlice(
            new IndexedDbSnapshotCache<{ readonly v: number }>({
                coordinator: flakyCoord,
                storeName: "snap",
                parse: (raw) => (isRecord(raw) && typeof raw.v === "number" ? { v: raw.v } : null),
            }),
        );
        const opened = await flakyCoord.openDb();
        expect(opened).not.toBeNull();
        // Close underlying handle unexpectedly and verify runCleanup/clearAll recovers without throwing.
        opened?.close();
        await flakyCoord.clearAll();
        expect(flakyCoord.isDegraded()).toBe(false);

        // Trigger onversionchange and verify the next openDb() opens a fresh connection.
        const freshHandle = await flakyCoord.openDb();
        expect(freshHandle).not.toBeNull();
        freshHandle?.onversionchange?.({} as IDBVersionChangeEvent);
        const reopenedHandle = await flakyCoord.openDb();
        expect(reopenedHandle).not.toBeNull();
        expect(reopenedHandle).not.toBe(freshHandle);

        // If a transaction throws inside snapshotCache.get or .put, coordinator degrades cleanly.
        const getFailCoord = new IndexedDbCoordinator("pivia.snap-get-fail.v1", 1, {
            indexedDB: new IDBFactory(),
            keyRange: IDBKeyRange,
        });
        const getFailSnap = getFailCoord.registerSlice(
            new IndexedDbSnapshotCache<{ readonly v: number }>({
                coordinator: getFailCoord,
                storeName: "snap",
                parse: (raw) => (isRecord(raw) && typeof raw.v === "number" ? { v: raw.v } : null),
            }),
        );
        await getFailSnap.put({ v: 7 });
        const getHandle = await getFailCoord.openDb();
        if (getHandle !== null) {
            vi.spyOn(getHandle, "transaction").mockImplementation(() => {
                throw new Error("read tx exploded");
            });
        }
        expect(await getFailSnap.get()).toEqual({ v: 7 });
        expect(getFailCoord.isDegraded()).toBe(true);

        if (reopenedHandle !== null) {
            vi.spyOn(reopenedHandle, "transaction").mockImplementation(() => {
                throw new Error("write tx exploded");
            });
        }
        await flakySnap.put({ v: 42 });
        expect(flakyCoord.isDegraded()).toBe(true);
        expect(await flakySnap.get()).toEqual({ v: 42 });
    });
});
