import { parseSessionId, type SessionId, type SessionSummary } from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

const A = sid("a");
const B = sid("b");
const DELETED = sid("deleted");
const LIVE = sid("live");
const CACHED = sid("cached");

const storageBacking = vi.hoisted(() => {
    const entries = new Map<string, string>();
    const memoryStorage: Storage = {
        get length() {
            return entries.size;
        },
        clear() {
            entries.clear();
        },
        getItem(key) {
            return entries.get(key) ?? null;
        },
        key(index) {
            return [...entries.keys()][index] ?? null;
        },
        removeItem(key) {
            entries.delete(key);
        },
        setItem(key, value) {
            entries.set(key, value);
        },
    };
    // Node leaves globalThis.localStorage undefined, and Zustand's persist middleware reads the
    // storage when createWorkspaceStore() runs.
    Object.defineProperty(globalThis, "localStorage", {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
    return entries;
});

import { Log } from "@/lib/log";

import { createWorkspaceStore, type WorkspaceCatalogCache } from "./store";

function noopCache(): WorkspaceCatalogCache {
    return {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
    };
}

const PERSIST_KEY = "pivia.workspace.v1";

function summary(id: SessionId, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
        id,
        cwd: "/home/u/pivia",
        name: null,
        firstMessage: "First prompt",
        messageCount: 1,
        createdAtMs: 1_000,
        modifiedAtMs: 1_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
        ...overrides,
    };
}

describe("createWorkspaceStore", () => {
    beforeEach(() => {
        storageBacking.clear();
    });

    it("tracks syncing state while a sync is in flight and records reconnecting", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.commitSyncedCatalog({
            sessions: [summary(A)],
            updatedAtMs: 10_000,
            sync: { kind: "live" },
        });
        expect(workspace.getState().sync).toEqual({ kind: "live" });

        store.setSync({ kind: "syncing" });
        store.setSync({ kind: "syncing" });

        expect(workspace.getState().sync).toEqual({ kind: "syncing" });

        store.setSync({ kind: "reconnecting", attempt: 2 });
        expect(workspace.getState().sync).toEqual({ kind: "reconnecting", attempt: 2 });
    });

    it("commits synced catalog snapshot, persists cache when requested, and reconciles selection and pins", () => {
        const put = vi.fn(() => Promise.resolve());
        const cache: WorkspaceCatalogCache = {
            get: vi.fn(() => Promise.resolve(null)),
            put,
        };
        const workspace = createWorkspaceStore({ cache });
        const store = workspace.getState();
        store.togglePinned(DELETED);
        store.togglePinned(LIVE);
        store.select(DELETED);
        store.setSync({ kind: "syncing" });

        const liveSessions = [summary(LIVE)];
        store.commitSyncedCatalog({
            sessions: liveSessions,
            updatedAtMs: 42_000,
            sync: { kind: "live" },
            persistCache: true,
        });

        const state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([LIVE]);
        expect(state.updatedAtMs).toBe(42_000);
        expect(state.sync).toEqual({ kind: "live" });
        expect(state.pins).toEqual([LIVE]);
        expect(state.selectedId).toBeNull();
        expect(put).toHaveBeenCalledWith({ sessions: liveSessions, updatedAtMs: 42_000 });
    });

    it("keeps the last rows and selection when a sync fails", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.commitSyncedCatalog({
            sessions: [summary(A)],
            updatedAtMs: 7_000,
            sync: { kind: "live" },
        });
        store.select(A);
        store.setSync({ kind: "syncing" });

        store.setSync({ kind: "failed", message: "The server is unreachable." });

        const state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([A]);
        expect(state.updatedAtMs).toBe(7_000);
        expect(state.selectedId).toBe(A);
        expect(state.sync).toEqual({ kind: "failed", message: "The server is unreachable." });
    });

    it("manages the query, selection, pins and collapsed folders", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();

        store.setQuery("parser");
        store.select(A);
        store.togglePinned(A);
        store.togglePinned(B);
        store.toggleFolder("/home/u/pivia");
        store.toggleFolder("/home/u/notes");

        let state = workspace.getState();
        expect(state.query).toBe("parser");
        expect(state.selectedId).toBe(A);
        expect(state.pins).toEqual([B, A]);
        expect(state.collapsed).toEqual(["/home/u/pivia", "/home/u/notes"]);

        store.togglePinned(A);
        store.toggleFolder("/home/u/pivia");

        state = workspace.getState();
        expect(state.pins).toEqual([B]);
        expect(state.collapsed).toEqual(["/home/u/notes"]);
    });

    it("applies local deltas via createCatalogSyncReducer and removes pins/selection on delete", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.commitSyncedCatalog({
            sessions: [summary(A, { name: "A" })],
            updatedAtMs: 10_000,
            sync: { kind: "live" },
        });
        store.togglePinned(A);
        store.select(A);

        store.applyCatalogDelta({ op: "upsert", item: summary(B, { name: "B" }) });
        store.applyCatalogDelta({ op: "upsert", item: summary(A, { name: "Renamed", modifiedAtMs: 5_000 }) });

        let state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([A, B]);
        expect(state.sessions[0]?.name).toBe("Renamed");

        // Applying an identical upsert or patch keeps the sessions array reference stable.
        const beforeNoop = workspace.getState().sessions;
        store.applyCatalogDelta({ op: "upsert", item: summary(A, { name: "Renamed", modifiedAtMs: 5_000 }) });
        expect(workspace.getState().sessions).toBe(beforeNoop);

        store.applyCatalogDelta({ op: "patch", id: A, patch: { name: "Renamed" } });
        expect(workspace.getState().sessions).toBe(beforeNoop);

        store.applyCatalogDelta({ op: "patch", id: A, patch: { runtimeState: "streaming", attachedClients: 2 } });
        expect(workspace.getState().sessions[0]).toMatchObject({
            id: A,
            name: "Renamed",
            runtimeState: "streaming",
            attachedClients: 2,
        });

        store.applyCatalogDelta({ op: "patch", id: DELETED, patch: { runtimeState: "idle" } });
        expect(workspace.getState().sessions).toHaveLength(2);

        store.applyCatalogDelta({ op: "remove", id: A });

        state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([B]);
        expect(state.pins).toEqual([]);
        expect(state.selectedId).toBeNull();
    });

    it("drops connection state on reset but keeps pins", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.commitSyncedCatalog({
            sessions: [summary(A)],
            updatedAtMs: 10_000,
            sync: { kind: "live" },
        });
        store.togglePinned(A);
        store.select(A);
        store.setQuery("a");
        store.toggleFolder("/home/u/pivia");
        store.setSync({ kind: "syncing" });

        store.reset();

        const state = workspace.getState();
        expect(state.sessions).toEqual([]);
        expect(state.updatedAtMs).toBeNull();
        expect(state.sync).toEqual({ kind: "idle" });
        expect(state.query).toBe("");
        expect(state.selectedId).toBeNull();
        expect(state.collapsed).toEqual([]);
        expect(state.pins).toEqual([A]);
    });

    it("skips a storage write when the persisted pins are unchanged", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.togglePinned(A);

        const setItem = vi.spyOn(localStorage, "setItem");

        store.setQuery("parser");
        store.select(A);
        store.toggleFolder("/home/u/pivia");
        expect(setItem).not.toHaveBeenCalled();

        store.togglePinned(B);
        expect(setItem).toHaveBeenCalledTimes(1);

        setItem.mockRestore();
    });

    it("rehydrates only sanitized pins from localStorage", async () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        storageBacking.set(
            PERSIST_KEY,
            JSON.stringify({
                version: 1,
                state: {
                    pins: ["a", 42, null, "b", "a"],
                    sessions: [{ id: "injected" }],
                    selectedId: "injected",
                },
            }),
        );

        await workspace.persist.rehydrate();

        let state = workspace.getState();
        expect(state.pins).toEqual([A, B]);
        expect(state.sessions).toEqual([]);
        expect(state.selectedId).toBeNull();

        storageBacking.set(PERSIST_KEY, JSON.stringify({ version: 1, state: { pins: null } }));

        await workspace.persist.rehydrate();

        state = workspace.getState();
        expect(state.pins).toEqual([]);
    });

    it("hydrates stale-while-revalidate catalog rows from cache only before the first live sync", async () => {
        const fakeCache: WorkspaceCatalogCache = {
            get: vi.fn(() => Promise.resolve({ sessions: [summary(CACHED)], updatedAtMs: 5_000 })),
            put: vi.fn(() => Promise.resolve()),
        };
        const workspace = createWorkspaceStore({ cache: fakeCache });
        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([CACHED]);
        expect(workspace.getState().updatedAtMs).toBe(5_000);

        workspace.getState().commitSyncedCatalog({
            sessions: [summary(LIVE)],
            updatedAtMs: 9_000,
            sync: { kind: "live" },
            persistCache: true,
        });
        // A late cache hydration after a live sync must not overwrite live sessions.
        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([LIVE]);
    });

    it("warns once when created without a catalog cache", async () => {
        const warnSpy = vi.spyOn(Log, "warn").mockImplementation(() => {});
        const workspace = createWorkspaceStore();

        await workspace.getState().hydrateCatalog();
        workspace.getState().commitSyncedCatalog({
            sessions: [summary(A)],
            updatedAtMs: 10_000,
            sync: { kind: "live" },
            persistCache: true,
        });

        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });

    it("skips cache writes when persistCache is false or updatedAtMs is null, and tolerates null or failing hydrateCatalog", async () => {
        const warnSpy = vi.spyOn(Log, "warn").mockImplementation(() => {});
        const put = vi.fn(() => Promise.resolve());
        const get = vi
            .fn<WorkspaceCatalogCache["get"]>()
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error("read failed"));
        const workspace = createWorkspaceStore({ cache: { get, put } });

        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions).toEqual([]);

        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions).toEqual([]);
        expect(warnSpy).toHaveBeenCalledTimes(1);

        workspace.getState().commitSyncedCatalog({
            sessions: [summary(A)],
            updatedAtMs: 1_000,
            sync: { kind: "live" },
        });
        workspace.getState().commitSyncedCatalog({
            sessions: [summary(A)],
            updatedAtMs: null,
            sync: { kind: "live" },
            persistCache: true,
        });
        expect(put).not.toHaveBeenCalled();

        warnSpy.mockRestore();
    });
});
