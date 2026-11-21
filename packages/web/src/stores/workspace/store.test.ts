import { parseSessionId, type SessionId, type SessionListResponse, type SessionSummary } from "@pivia/protocol";
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

function listResponse(sessions: SessionSummary[], scannedAtMs = 10_000): SessionListResponse {
    return { sessions, scannedAtMs };
}

describe("createWorkspaceStore", () => {
    beforeEach(() => {
        storageBacking.clear();
    });

    it("keeps one scan phase while a scan is in flight", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.applyScan(listResponse([summary(A)]));
        expect(workspace.getState().scan).toEqual({ kind: "ready" });

        store.beginScan(true);
        store.beginScan(false);

        expect(workspace.getState().scan).toEqual({ kind: "scanning", manual: true });
    });

    it("applies a complete scan and reconciles the selection and pins", () => {
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
        store.beginScan(true);

        const scannedSessions = [summary(LIVE)];
        store.applyScan(listResponse(scannedSessions, 42_000));

        const state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([LIVE]);
        expect(state.scannedAtMs).toBe(42_000);
        expect(state.scan).toEqual({ kind: "ready" });
        expect(state.pins).toEqual([LIVE]);
        expect(state.selectedId).toBeNull();
        expect(putWorkspaceCatalog).toHaveBeenCalledWith(scannedSessions, 42_000);
    });

    it("keeps the last rows and selection when a scan fails", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.applyScan(listResponse([summary(A)], 7_000));
        store.select(A);
        store.beginScan(false);

        store.failScan("The session directory is unreadable.");

        const state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([A]);
        expect(state.scannedAtMs).toBe(7_000);
        expect(state.selectedId).toBe(A);
        expect(state.scan).toEqual({ kind: "failed", message: "The session directory is unreadable." });
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
        store.applyScan(listResponse([summary(A, { name: "A" })]));
        store.togglePinned(A);
        store.select(A);

        store.upsertSession(summary(B, { name: "B" }));
        store.upsertSession(summary(A, { name: "Renamed", modifiedAtMs: 5_000 }));

        let state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([A, B]);
        expect(state.sessions[0]?.name).toBe("Renamed");

        store.removeSession(A);

        state = workspace.getState();
        expect(state.sessions.map((session) => session.id)).toEqual([B]);
        expect(state.pins).toEqual([]);
        expect(state.selectedId).toBeNull();
    });

    it("drops connection state on reset but keeps pins", () => {
        const workspace = createWorkspaceStore({ cache: noopCache() });
        const store = workspace.getState();
        store.applyScan(listResponse([summary(A)]));
        store.togglePinned(A);
        store.select(A);
        store.setQuery("a");
        store.toggleFolder("/home/u/pivia");
        store.beginScan(true);

        store.reset();

        const state = workspace.getState();
        expect(state.sessions).toEqual([]);
        expect(state.scannedAtMs).toBeNull();
        expect(state.scan).toEqual({ kind: "idle" });
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

    it("hydrates stale-while-revalidate catalog rows from cache only before the first live scan", async () => {
        const fakeCache: WorkspaceCatalogCache = {
            getWorkspaceCatalog: vi.fn(() =>
                Promise.resolve({ key: "default" as const, sessions: [summary(CACHED)], scannedAtMs: 5_000 }),
            ),
            putWorkspaceCatalog: vi.fn(() => Promise.resolve()),
        };
        const workspace = createWorkspaceStore({ cache: fakeCache });
        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([CACHED]);
        expect(workspace.getState().scannedAtMs).toBe(5_000);

        workspace.getState().applyScan(listResponse([summary(LIVE)], 9_000));
        // A late cache hydration after a live scan must not overwrite live sessions.
        await workspace.getState().hydrateCatalog();
        expect(workspace.getState().sessions.map((session) => session.id)).toEqual([LIVE]);
    });

    it("warns once when created without a catalog cache", async () => {
        const warnSpy = vi.spyOn(Log, "warn").mockImplementation(() => {});
        const workspace = createWorkspaceStore();

        await workspace.getState().hydrateCatalog();
        workspace.getState().applyScan(listResponse([summary(A)]));

        expect(warnSpy).toHaveBeenCalledTimes(1);
        warnSpy.mockRestore();
    });
});
