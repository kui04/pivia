import type { FileEntry, SessionSummary } from "@pivia/protocol";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import { IndexedDbSessionCache } from "./session-cache";

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

function summary(id: string): SessionSummary {
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

        expect(await cache.replaceEntries("s1", "3:1.5.2", entries)).toBe("written");
        now = 2_000;

        const appendOk = await cache.appendEntries("s1", "3:1.5.2", 2, [userEntry("e2", "e1", "second")]);
        expect(appendOk).toBe("written");

        // Overlapping idempotent append from an older base advances only missing rows.
        const overlapAppend = await cache.appendEntries("s1", "3:1.5.2", 2, [
            userEntry("e2", "e1", "second"),
            userEntry("e3", "e2", "third"),
        ]);
        expect(overlapAppend).toBe("written");

        // Stale or version-mismatched appends are skipped safely.
        expect(await cache.appendEntries("s1", "3:1.5.2", 2, [userEntry("e2", "e1", "second")])).toBe("skipped-stale");
        expect(await cache.appendEntries("s1", "3:1.5.3", 4, [userEntry("e4", "e3", "fourth")])).toBe("skipped-stale");

        const loaded = await cache.getSession("s1");
        expect(loaded?.meta).toMatchObject({
            sessionId: "s1",
            entriesVersion: "3:1.5.2",
            entryCount: 4,
            lastEntryId: "e3",
        });
        expect(loaded?.entries.map((entry) => entry.id)).toEqual(["s1", "e1", "e2", "e3"]);
    });

    it("prevents slow-tab rollback overwrites while allowing divergent overwrites", async () => {
        const cache = createTestCache();
        const full = [header("s1"), userEntry("e1", null, "one"), userEntry("e2", "e1", "two")];
        await cache.replaceEntries("s1", "3:1.5.2", full);

        // Slow tab tries to overwrite with an older prefix of length 2 -> skipped.
        const staleOverwrite = await cache.replaceEntries("s1", "3:1.5.2", full.slice(0, 2));
        expect(staleOverwrite).toBe("skipped-stale");
        expect((await cache.getSession("s1"))?.entries).toHaveLength(3);

        // Divergent rewrite (e.g. external CLI replaced entry e1 with e1-alt) -> accepted.
        const divergent = [header("s1"), userEntry("e1-alt", null, "rewritten")];
        expect(await cache.replaceEntries("s1", "3:1.5.2", divergent)).toBe("written");
        expect((await cache.getSession("s1"))?.entries.map((entry) => entry.id)).toEqual(["s1", "e1-alt"]);
    });

    it("evicts oldest sessions when exceeding maxSessions or maxBytes, deletes sessions, and clears all stores", async () => {
        let now = 100;
        const cache = createTestCache({
            nowMs: () => now,
            maxSessions: 2,
            maxBytes: 100_000,
        });

        await cache.replaceEntries("s1", "3:1.5.2", [header("s1")]);
        now = 200;
        await cache.replaceEntries("s2", "3:1.5.2", [header("s2")]);
        now = 300;
        // Touch s1 so s2 becomes the LRU victim when s3 is added.
        await cache.getSession("s1");
        now = 400;
        await cache.replaceEntries("s3", "3:1.5.2", [header("s3")]);

        expect(await cache.getSession("s2")).toBeNull();
        expect(await cache.getSession("s1")).not.toBeNull();
        expect(await cache.getSession("s3")).not.toBeNull();

        await cache.deleteSession("s1");
        expect(await cache.getSession("s1")).toBeNull();

        await cache.putWorkspaceCatalog([summary("s3")], 9_000);
        expect(await cache.getWorkspaceCatalog()).toEqual({
            key: "default",
            sessions: [summary("s3")],
            scannedAtMs: 9_000,
        });

        await cache.clearAll();
        expect(await cache.getSession("s3")).toBeNull();
        expect(await cache.getWorkspaceCatalog()).toBeNull();
    });

    it("still deletes persisted rows after a quota failure degraded the cache to memory", async () => {
        const factory = new IDBFactory();
        const seeded = new IndexedDbSessionCache({ indexedDB: factory, keyRange: IDBKeyRange });
        await seeded.replaceEntries("s1", "3:1.5.2", [header("s1"), userEntry("e1", null, "first")]);

        // Every range write reports a full device, so eviction plus retry cannot succeed.
        const quotaKeyRange = {
            bound(): IDBKeyRange {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
            },
        } as unknown as typeof IDBKeyRange;
        const failing = new IndexedDbSessionCache({ indexedDB: factory, keyRange: quotaKeyRange });
        expect(
            await failing.replaceEntries("s1", "3:1.5.2", [header("s1"), userEntry("e1-alt", null, "rewritten")]),
        ).toBe("degraded-memory");

        // Logout and a removed session must still reach IndexedDB after the degradation.
        await failing.clearAll();

        const reader = new IndexedDbSessionCache({ indexedDB: factory, keyRange: IDBKeyRange });
        expect(await reader.getSession("s1")).toBeNull();
    });

    it("degrades gracefully to in-memory storage when indexedDB is unavailable", async () => {
        const cache = new IndexedDbSessionCache({ indexedDB: undefined });
        expect(await cache.replaceEntries("s1", "3:1.5.2", [header("s1")])).toBe("degraded-memory");
        expect(await cache.appendEntries("s1", "3:1.5.2", 1, [userEntry("e1", null, "hi")])).toBe("degraded-memory");
        expect((await cache.getSession("s1"))?.entries).toHaveLength(2);
    });
});
