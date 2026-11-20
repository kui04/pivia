import type { SessionListResponse, SessionSummary } from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    // storage when the store module loads.
    Object.defineProperty(globalThis, "localStorage", {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
    return entries;
});

import { initialWorkspaceState, useWorkspaceStore } from "./store";

const PERSIST_KEY = "pivia.workspace.v1";

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
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

function resetStore(): void {
    useWorkspaceStore.setState({ ...initialWorkspaceState });
    storageBacking.clear();
}

describe("useWorkspaceStore", () => {
    beforeEach(() => {
        resetStore();
    });

    it("keeps one scan phase while a scan is in flight", () => {
        const store = useWorkspaceStore.getState();
        store.applyScan(listResponse([summary("a")]));
        expect(useWorkspaceStore.getState().scan).toEqual({ kind: "ready" });

        store.beginScan(true);
        store.beginScan(false);

        expect(useWorkspaceStore.getState().scan).toEqual({ kind: "scanning", manual: true });
    });

    it("applies a complete scan and reconciles the selection and pins", () => {
        const store = useWorkspaceStore.getState();
        store.togglePinned("deleted");
        store.togglePinned("live");
        store.select("deleted");
        store.beginScan(true);

        store.applyScan(listResponse([summary("live")], 42_000));

        const state = useWorkspaceStore.getState();
        expect(state.sessions.map((session) => session.id)).toEqual(["live"]);
        expect(state.scannedAtMs).toBe(42_000);
        expect(state.scan).toEqual({ kind: "ready" });
        expect(state.pins).toEqual(["live"]);
        expect(state.selectedId).toBeNull();
    });

    it("keeps the last rows and selection when a scan fails", () => {
        const store = useWorkspaceStore.getState();
        store.applyScan(listResponse([summary("a")], 7_000));
        store.select("a");
        store.beginScan(false);

        store.failScan("The session directory is unreadable.");

        const state = useWorkspaceStore.getState();
        expect(state.sessions.map((session) => session.id)).toEqual(["a"]);
        expect(state.scannedAtMs).toBe(7_000);
        expect(state.selectedId).toBe("a");
        expect(state.scan).toEqual({ kind: "failed", message: "The session directory is unreadable." });
    });

    it("manages the query, selection, pins and collapsed folders", () => {
        const store = useWorkspaceStore.getState();

        store.setQuery("parser");
        store.select("a");
        store.togglePinned("a");
        store.togglePinned("b");
        store.toggleFolder("/home/u/pivia");
        store.toggleFolder("/home/u/notes");

        let state = useWorkspaceStore.getState();
        expect(state.query).toBe("parser");
        expect(state.selectedId).toBe("a");
        expect(state.pins).toEqual(["b", "a"]);
        expect(state.collapsed).toEqual(["/home/u/pivia", "/home/u/notes"]);

        store.togglePinned("a");
        store.toggleFolder("/home/u/pivia");

        state = useWorkspaceStore.getState();
        expect(state.pins).toEqual(["b"]);
        expect(state.collapsed).toEqual(["/home/u/notes"]);
    });

    it("upserts a live session and removes it with its pin and selection", () => {
        const store = useWorkspaceStore.getState();
        store.applyScan(listResponse([summary("a", { name: "A" })]));
        store.togglePinned("a");
        store.select("a");

        store.upsertSession(summary("b", { name: "B" }));
        store.upsertSession(summary("a", { name: "Renamed", modifiedAtMs: 5_000 }));

        let state = useWorkspaceStore.getState();
        expect(state.sessions.map((session) => session.id)).toEqual(["a", "b"]);
        expect(state.sessions[0]?.name).toBe("Renamed");

        store.removeSession("a");

        state = useWorkspaceStore.getState();
        expect(state.sessions.map((session) => session.id)).toEqual(["b"]);
        expect(state.pins).toEqual([]);
        expect(state.selectedId).toBeNull();
    });

    it("drops connection state on reset but keeps pins", () => {
        const store = useWorkspaceStore.getState();
        store.applyScan(listResponse([summary("a")]));
        store.togglePinned("a");
        store.select("a");
        store.setQuery("a");
        store.toggleFolder("/home/u/pivia");
        store.beginScan(true);

        store.reset();

        const state = useWorkspaceStore.getState();
        expect(state.sessions).toEqual([]);
        expect(state.scannedAtMs).toBeNull();
        expect(state.scan).toEqual({ kind: "idle" });
        expect(state.query).toBe("");
        expect(state.selectedId).toBeNull();
        expect(state.collapsed).toEqual([]);
        expect(state.pins).toEqual(["a"]);
    });

    it("skips a storage write when the persisted pins are unchanged", () => {
        const setItem = vi.spyOn(localStorage, "setItem");
        const store = useWorkspaceStore.getState();

        store.setQuery("parser");
        store.select("a");
        store.toggleFolder("/home/u/pivia");
        expect(setItem).not.toHaveBeenCalled();

        store.togglePinned("a");
        expect(setItem).toHaveBeenCalledTimes(1);

        setItem.mockRestore();
    });

    it("rehydrates only sanitized pins from localStorage", async () => {
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

        await useWorkspaceStore.persist.rehydrate();

        let state = useWorkspaceStore.getState();
        expect(state.pins).toEqual(["a", "b"]);
        expect(state.sessions).toEqual([]);
        expect(state.selectedId).toBeNull();

        storageBacking.set(PERSIST_KEY, JSON.stringify({ version: 1, state: { pins: null } }));

        await useWorkspaceStore.persist.rehydrate();

        state = useWorkspaceStore.getState();
        expect(state.pins).toEqual([]);
    });
});
