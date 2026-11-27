import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
    // `@/stores` creates its persisted workspace store at module load, so Node needs a storage
    // object before the import below runs.
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
    Object.defineProperty(globalThis, "localStorage", {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
});

import { sid } from "@/test/ids";

import {
    attachWorkspaceSession,
    parseWorkspaceSessionRoute,
    type WorkspaceSessionBinding,
} from "./useWorkspaceSession";

function fakeStore() {
    return {
        connect: vi.fn<WorkspaceSessionBinding["connect"]>(),
        disconnect: vi.fn<WorkspaceSessionBinding["disconnect"]>(),
    } satisfies WorkspaceSessionBinding;
}

describe("parseWorkspaceSessionRoute", () => {
    it("reports a missing route segment", () => {
        expect(parseWorkspaceSessionRoute(undefined)).toEqual({ kind: "none" });
    });

    it("accepts a safe session id", () => {
        expect(parseWorkspaceSessionRoute("session-1")).toEqual({ kind: "session", sessionId: sid("session-1") });
    });

    it("reports path traversal, spaces and an empty segment as invalid instead of throwing", () => {
        for (const raw of ["../session", "session/1", "session 1", "", "..", "session%2F1"]) {
            expect(parseWorkspaceSessionRoute(raw)).toEqual({ kind: "invalid", raw });
        }
    });
});

describe("attachWorkspaceSession", () => {
    it("connects the routed session and disconnects on cleanup", () => {
        const store = fakeStore();

        const detach = attachWorkspaceSession(store, { kind: "session", sessionId: sid("session-1") });

        expect(store.connect).toHaveBeenCalledExactlyOnceWith(sid("session-1"));
        expect(store.disconnect).not.toHaveBeenCalled();

        detach();
        expect(store.disconnect).toHaveBeenCalledOnce();
    });

    it("detaches the previous session before connecting the next one", () => {
        const store = fakeStore();

        const detachFirst = attachWorkspaceSession(store, { kind: "session", sessionId: sid("session-1") });
        detachFirst();
        const detachSecond = attachWorkspaceSession(store, { kind: "session", sessionId: sid("session-2") });

        expect(store.connect).toHaveBeenNthCalledWith(1, sid("session-1"));
        expect(store.connect).toHaveBeenNthCalledWith(2, sid("session-2"));
        expect(store.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
            store.connect.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
        );

        detachSecond();
        expect(store.disconnect).toHaveBeenCalledTimes(2);
    });

    it("disconnects without connecting when the route has no usable segment", () => {
        const invalidStore = fakeStore();
        const invalidDetach = attachWorkspaceSession(invalidStore, { kind: "invalid", raw: "not valid" });

        expect(invalidStore.connect).not.toHaveBeenCalled();
        expect(invalidStore.disconnect).toHaveBeenCalledOnce();
        expect(() => {
            invalidDetach();
        }).not.toThrow();

        const emptyStore = fakeStore();
        attachWorkspaceSession(emptyStore, { kind: "none" });

        expect(emptyStore.connect).not.toHaveBeenCalled();
        expect(emptyStore.disconnect).toHaveBeenCalledOnce();
    });
});
