import {
    parseCatalogEpoch,
    parseCatalogSeq,
    parseSessionId,
    type CatalogCursor,
    type CatalogEpoch,
    type CatalogSeq,
    type SessionId,
    type SessionSummary,
} from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function epoch(raw: string): CatalogEpoch {
    const parsed = parseCatalogEpoch(raw);
    if (parsed === null) {
        throw new Error(`Invalid test catalog epoch: ${raw}`);
    }
    return parsed;
}

function seq(raw: number): CatalogSeq {
    const parsed = parseCatalogSeq(raw);
    if (parsed === null) {
        throw new Error(`Invalid test catalog seq: ${raw}`);
    }
    return parsed;
}

function cursor(epochId: string, value: number): CatalogCursor {
    return { epoch: epoch(epochId), seq: seq(value) };
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
        getWorkspaceCatalog: () => Promise.resolve(null),
        putWorkspaceCatalog: () => Promise.resolve(),
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
        store.applyCatalog([summary(A)], 10_000, cursor("e1", 0));
        expect(workspace.getState().sync).toEqual({ kind: "live" });

        store.beginSync();
        store.beginSync();

        expect(workspace.getState().sync).toEqual({ kind: "syncing" });

        store.markReconnecting(2);
        expect(workspace.getState().sync).toEqual({ kind: "reconnecting", attempt: 2 });
    });

    it("applies a complete catalog snapshot and reconciles the selection and pins", () => {
        const putWorkspaceCatalog = vi.fn(() => Promise.resolve());
        const cache: WorkspaceCatalogCache = {
            getWorkspaceCatalog: vi.fn(() => Promise.resolve(null)),
            putWorkspaceCatalog,
        };
        const workspace = createWorkspaceStore({ cache });
        const store = workspace.getState();
        store.togglePinned(DELETED);
        store.togglePinned(LIVE);
        store.select(DELETED);
        store.beginSync();

        const liveSessions = [summary(LIVE)];
        store.applyCatalog(liveSessions, 42_000, cursor("e1", 3));

        const state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([LIVE]);
        expect(state.updatedAtMs).toBe(42_000);
        expect(state.catalogCursor).toEqual(cursor("e1", 3));
        expect(state.sync).toEqual({ kind: "live" });
        expect(state.pins).toEqual([LIVE]);
        expect(state.selectedId).toBeNull();
        expect(putWorkspaceCatalog).toHaveBeenCalledWith(liveSessions, 42_000);
    });

    it("rejects stale catalog snapshots by seq while accepting equal-seq refreshes and new server epochs", () => {
        const putWorkspaceCatalog = vi.fn(() => Promise.resolve());
        const cache: WorkspaceCatalogCache = {
            getWorkspaceCatalog: vi.fn(() => Promise.resolve(null)),
            putWorkspaceCatalog,
        };
        const workspace = createWorkspaceStore({ cache });
        const store = workspace.getState();
        store.applyCatalog([summary(LIVE)], 20_000, cursor("e1", 5));
        store.applyCatalogEvent({
            type: "session_updated",
            catalogEpoch: epoch("e1"),
            seq: seq(6),
            sessionId: LIVE,
            patch: { runtimeState: "streaming" },
        });
        putWorkspaceCatalog.mockClear();

        // An older HTTP response returning after a newer WS snapshot or event must be ignored.
        store.applyCatalog([summary(DELETED)], 25_000, cursor("e1", 5));
        expect(workspace.getState().sessions).toEqual([summary(LIVE, { runtimeState: "streaming" })]);
        expect(workspace.getState().catalogCursor).toEqual(cursor("e1", 6));
        expect(putWorkspaceCatalog).not.toHaveBeenCalled();

        // A refresh at the current seq still transitions sync back to live.
        store.beginSync();
        store.applyCatalog([summary(LIVE, { runtimeState: "streaming" }), summary(A)], 20_000, cursor("e1", 6));
        expect(workspace.getState().sync).toEqual({ kind: "live" });
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([LIVE, A]);
        expect(putWorkspaceCatalog).toHaveBeenCalledTimes(1);

        // A new epoch after server restart supersedes a higher seq from the previous epoch.
        store.applyCatalog([summary(A)], 21_000, cursor("e2", 0));
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([A]);
        expect(workspace.getState().catalogCursor).toEqual(cursor("e2", 0));
    });

    it("keeps the last rows and selection when a sync fails", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.applyCatalog([summary(A)], 7_000, cursor("e1", 0));
        store.select(A);
        store.beginSync();

        store.failSync("The server is unreachable.");

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

    it("upserts a live session and removes it with its pin and selection", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.applyCatalog([summary(A, { name: "A" })], 10_000, cursor("e1", 0));
        store.togglePinned(A);
        store.select(A);

        store.upsertSession(summary(B, { name: "B" }));
        store.upsertSession(summary(A, { name: "Renamed", modifiedAtMs: 5_000 }));

        let state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([A, B]);
        expect(state.sessions[0]?.name).toBe("Renamed");

        // Applying an identical upsert or patch keeps the sessions array reference stable.
        const beforeNoop = workspace.getState().sessions;
        store.upsertSession(summary(A, { name: "Renamed", modifiedAtMs: 5_000 }));
        expect(workspace.getState().sessions).toBe(beforeNoop);

        store.patchSession(A, { name: "Renamed" });
        expect(workspace.getState().sessions).toBe(beforeNoop);

        store.patchSession(A, { runtimeState: "streaming", attachedClients: 2 });
        expect(workspace.getState().sessions[0]).toMatchObject({
            id: A,
            name: "Renamed",
            runtimeState: "streaming",
            attachedClients: 2,
        });

        store.patchSession(DELETED, { runtimeState: "idle" });
        expect(workspace.getState().sessions).toHaveLength(2);

        store.removeSession(A);

        state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([B]);
        expect(state.pins).toEqual([]);
        expect(state.selectedId).toBeNull();
    });

    it("drops connection state on reset but keeps pins", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.applyCatalog([summary(A)], 10_000, cursor("e1", 0));
        store.togglePinned(A);
        store.select(A);
        store.setQuery("a");
        store.toggleFolder("/home/u/pivia");
        store.beginSync();

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
            getWorkspaceCatalog: vi.fn(() =>
                Promise.resolve({ key: "default" as const, sessions: [summary(CACHED)], scannedAtMs: 5_000 }),
            ),
            putWorkspaceCatalog: vi.fn(() => Promise.resolve()),
        };
        const workspace = createWorkspaceStore({ cache: fakeCache });
        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([CACHED]);
        expect(workspace.getState().updatedAtMs).toBe(5_000);

        workspace.getState().applyCatalog([summary(LIVE)], 9_000, cursor("e1", 0));
        // A late cache hydration after a live sync must not overwrite live sessions.
        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([LIVE]);
    });

    it("warns once when created without a catalog cache", async () => {
        const warnSpy = vi.spyOn(Log, "warn").mockImplementation(() => {});
        const workspace = createWorkspaceStore();

        await workspace.getState().hydrateCatalog();
        workspace.getState().applyCatalog([summary(A)], 10_000, cursor("e1", 0));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });
});
