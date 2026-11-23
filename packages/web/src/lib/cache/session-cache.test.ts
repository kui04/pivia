import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    parseEntriesVersion,
    parseSessionId,
    type EntriesVersion,
    type SessionId,
    type SessionSummary,
} from "@pivia/protocol";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { IndexedDbSessionCache } from "./session-cache";

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
    return new IndexedDbSessionCache({
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

describe("IndexedDbSessionCache", () => {
    it("persists row-level entries, appends incrementally, and skips stale/mismatched appends", async () => {
        let now = 1_000;
        const cache = createTestCache({ nowMs: () => now });
        const entries = [header("s1"), userEntry("e1", null, "first")];

        expect(await cache.replaceEntries(S1, V152, entries)).toBe("written");
        now = 2_000;

        const appendOk = await cache.appendEntries(S1, V152, 2, [userEntry("e2", "e1", "second")]);
        expect(appendOk).toBe("written");

        // Overlapping idempotent append from an older base advances only missing rows.
        const overlapAppend = await cache.appendEntries(S1, V152, 2, [
            userEntry("e2", "e1", "second"),
            userEntry("e3", "e2", "third"),
        ]);
        expect(overlapAppend).toBe("written");

        // Stale or version-mismatched appends are skipped safely.
        expect(await cache.appendEntries(S1, V152, 2, [userEntry("e2", "e1", "second")])).toBe("skipped-stale");
        expect(await cache.appendEntries(S1, V153, 4, [userEntry("e4", "e3", "fourth")])).toBe("skipped-stale");

        const loaded = await cache.getSession(S1);
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
        await cache.replaceEntries(S1, V152, full);

        // Slow tab tries to overwrite with an older prefix of length 2 -> skipped.
        const staleOverwrite = await cache.replaceEntries(S1, V152, full.slice(0, 2));
        expect(staleOverwrite).toBe("skipped-stale");
        expect((await cache.getSession(S1))?.entries).toHaveLength(3);

        // Divergent rewrite (e.g. external CLI replaced entry e1 with e1-alt) -> accepted.
        const divergent = [header("s1"), userEntry("e1-alt", null, "rewritten")];
        expect(await cache.replaceEntries(S1, V152, divergent)).toBe("written");
        expect((await cache.getSession(S1))?.entries.map((entry) => entry.id)).toEqual(["s1", "e1-alt"]);
    });

    it("evicts oldest sessions when exceeding maxSessions or maxBytes, deletes sessions, and clears all stores", async () => {
        let now = 100;
        const cache = createTestCache({
            nowMs: () => now,
            maxSessions: 2,
            maxBytes: 100_000,
        });

        await cache.replaceEntries(S1, V152, [header("s1")]);
        now = 200;
        await cache.replaceEntries(S2, V152, [header("s2")]);
        now = 300;
        // Touch s1 so s2 becomes the LRU victim when s3 is added.
        await cache.getSession(S1);
        now = 400;
        await cache.replaceEntries(S3, V152, [header("s3")]);

        expect(await cache.getSession(S2)).toBeNull();
        expect(await cache.getSession(S1)).not.toBeNull();
        expect(await cache.getSession(S3)).not.toBeNull();

        await cache.deleteSession(S1);
        expect(await cache.getSession(S1)).toBeNull();

        await cache.putWorkspaceCatalog([summary(S3)], 9_000);
        expect(await cache.getWorkspaceCatalog()).toEqual({
            key: "default",
            sessions: [summary(S3)],
            updatedAtMs: 9_000,
        });

        await cache.clearAll();
        expect(await cache.getSession(S3)).toBeNull();
        expect(await cache.getWorkspaceCatalog()).toBeNull();
    });

    it("still deletes persisted rows after a quota failure degraded the cache to memory", async () => {
        const factory = new IDBFactory();
        const seeded = new IndexedDbSessionCache({ indexedDB: factory, keyRange: IDBKeyRange });
        await seeded.replaceEntries(S1, V152, [header("s1"), userEntry("e1", null, "first")]);

        // Every range write reports a full device, so eviction plus retry cannot succeed.
        const quotaKeyRange = {
            bound(): IDBKeyRange {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
            },
        } as unknown as typeof IDBKeyRange;
        const failing = new IndexedDbSessionCache({ indexedDB: factory, keyRange: quotaKeyRange });
        expect(await failing.replaceEntries(S1, V152, [header("s1"), userEntry("e1-alt", null, "rewritten")])).toBe(
            "degraded-memory",
        );

        // Logout and a removed session must still reach IndexedDB after the degradation.
        await failing.clearAll();

        const reader = new IndexedDbSessionCache({ indexedDB: factory, keyRange: IDBKeyRange });
        expect(await reader.getSession(S1)).toBeNull();
    });

    it("degrades gracefully to in-memory storage when indexedDB is unavailable", async () => {
        const cache = new IndexedDbSessionCache({ indexedDB: undefined });
        expect(await cache.replaceEntries(S1, V152, [header("s1")])).toBe("degraded-memory");
        expect(await cache.appendEntries(S1, V152, 1, [userEntry("e1", null, "hi")])).toBe("degraded-memory");
        expect((await cache.getSession(S1))?.entries).toHaveLength(2);
    });

    it("rejects and self-heals corrupted IndexedDB meta and catalog records", async () => {
        const factory = new IDBFactory();
        const cache = new IndexedDbSessionCache({ indexedDB: factory, keyRange: IDBKeyRange });
        await cache.replaceEntries(S1, V152, [header("s1")]);
        await cache.putWorkspaceCatalog([summary(S1)], 5_000);

        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = factory.open("pivia.cache.v1", 1);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error ?? new Error("Failed to open IndexedDB."));
        });
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(["session_meta", "workspace_catalog"], "readwrite");
            tx.objectStore("session_meta").put({ sessionId: S1, entriesVersion: "corrupt" });
            tx.objectStore("session_meta").put({ sessionId: "s-corrupt", entriesVersion: "bad" });
            tx.objectStore("workspace_catalog").put({ key: "default", sessions: [{ id: "../bad" }], updatedAtMs: 1 });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Failed to write corrupted IndexedDB rows."));
        });
        db.close();

        expect(await cache.getSession(S1)).toBeNull();
        expect(await cache.getWorkspaceCatalog()).toBeNull();
        expect(await cache.replaceEntries(S2, V152, [header("s2")])).toBe("written");

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
});
