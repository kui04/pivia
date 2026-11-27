import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDbAppCache } from "@/lib/cache";
import { createApiClient, type FetchLike } from "@/lib/transport";
import { FakeWebSocket } from "@/test/fake-socket";
import { jsonResponse, makeSessionStateSnapshot, makeSessionSummary, mockLocation } from "@/test/fixtures";
import { ev, sessionEpoch, sessionSeq, sid } from "@/test/ids";

import { createAppStores } from "./index";

const SESSION_1 = sid("session-1");
const SESSION_2 = sid("session-2");
const V152 = ev("3:1.5.2");

function requestUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function createTestCache(): IndexedDbAppCache {
    return new IndexedDbAppCache({
        indexedDB: new IDBFactory(),
        keyRange: IDBKeyRange,
    });
}

describe("createAppStores", () => {
    beforeEach(() => {
        FakeWebSocket.reset();
        mockLocation("http://localhost:3141/workspace");
    });

    it("clears session memory and persisted cache and marks auth unauthenticated on 401", async () => {
        let returnUnauthorized = false;
        const fetchMock = vi.fn<FetchLike>((input) => {
            const url = requestUrl(input);
            if (url.endsWith("/api/auth/status")) {
                return Promise.resolve(jsonResponse({ authRequired: true, authenticated: true }));
            }
            if (returnUnauthorized) {
                return Promise.resolve(
                    jsonResponse({ error: "unauthorized", message: "Authentication required." }, { status: 401 }),
                );
            }
            return Promise.resolve(jsonResponse({ sessions: [], scannedAtMs: 1_000 }));
        });

        const cache = createTestCache();
        const clearAllSpy = vi.spyOn(cache, "clearAll");
        const apiClient = createApiClient({ fetch: fetchMock });
        const { useAuthStore, useSessionStore } = createAppStores({
            apiClient,
            cache,
            WebSocket: FakeWebSocket,
        });
        const clearCacheSpy = vi.spyOn(useSessionStore.getState(), "clearCache");

        await useAuthStore.getState().checkStatus();
        expect(useAuthStore.getState().phase).toBe("authenticated");

        useSessionStore.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const sock = FakeWebSocket.instances[0];
        if (sock === undefined) {
            throw new Error("expected FakeWebSocket instance");
        }
        sock.open();
        sock.receive({
            type: "sync:snapshot",
            cursor: { epoch: sessionEpoch("rt-1"), seq: sessionSeq(1) },
            snapshot: {
                entriesVersion: V152,
                baseEntryCount: 0,
                entries: { mode: "inline", data: [] },
                state: makeSessionStateSnapshot({ sessionId: SESSION_1 }),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });
        expect(useSessionStore.getState().sessionId).toBe(SESSION_1);

        returnUnauthorized = true;
        await expect(apiClient.listSessions()).rejects.toThrow("Authentication required.");

        expect(useAuthStore.getState().phase).toBe("unauthenticated");
        expect(clearCacheSpy).toHaveBeenCalledTimes(1);
        expect(clearAllSpy).toHaveBeenCalledTimes(1);
        expect(useSessionStore.getState().sessionId).toBeNull();
    });

    it("clears session memory and persisted cache on logout", async () => {
        const fetchMock = vi.fn<FetchLike>((input) => {
            const url = requestUrl(input);
            if (url.endsWith("/api/auth/status")) {
                return Promise.resolve(jsonResponse({ authRequired: true, authenticated: true }));
            }
            if (url.endsWith("/api/auth/logout")) {
                return Promise.resolve(jsonResponse({ authenticated: false }));
            }
            return Promise.resolve(jsonResponse({}, { status: 404 }));
        });

        const cache = createTestCache();
        const clearAllSpy = vi.spyOn(cache, "clearAll");
        const apiClient = createApiClient({ fetch: fetchMock });
        const { useAuthStore, useSessionStore } = createAppStores({
            apiClient,
            cache,
            WebSocket: FakeWebSocket,
        });
        const clearCacheSpy = vi.spyOn(useSessionStore.getState(), "clearCache");

        await useAuthStore.getState().checkStatus();
        useSessionStore.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });

        await useAuthStore.getState().logout();

        expect(useAuthStore.getState().phase).toBe("unauthenticated");
        expect(clearCacheSpy).toHaveBeenCalledTimes(1);
        expect(clearAllSpy).toHaveBeenCalledTimes(1);
        expect(useSessionStore.getState().sessionId).toBeNull();
    });

    it("removes a missing session from the workspace store when HTTP sync returns 404", async () => {
        const fetchMock = vi.fn<FetchLike>(() =>
            Promise.resolve(jsonResponse({ error: "not_found", message: "Session not found." }, { status: 404 })),
        );
        const cache = createTestCache();
        const apiClient = createApiClient({ fetch: fetchMock });
        const { useWorkspaceStore, useSessionStore } = createAppStores({
            apiClient,
            cache,
            WebSocket: FakeWebSocket,
        });

        useWorkspaceStore.getState().commitSyncedCatalog({
            sessions: [makeSessionSummary(SESSION_1), makeSessionSummary(SESSION_2)],
            updatedAtMs: 5_000,
            sync: { kind: "live" },
        });
        useWorkspaceStore.getState().togglePinned(SESSION_1);
        useWorkspaceStore.getState().select(SESSION_1);

        useSessionStore.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const sock = FakeWebSocket.instances[0];
        if (sock === undefined) {
            throw new Error("expected FakeWebSocket instance");
        }
        sock.open();
        sock.receive({
            type: "sync:snapshot",
            cursor: { epoch: sessionEpoch("rt-missing"), seq: sessionSeq(1) },
            snapshot: {
                entriesVersion: V152,
                baseEntryCount: 0,
                entries: { mode: "http", meta: { entryCount: 1 } },
                state: makeSessionStateSnapshot({ sessionId: SESSION_1 }),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });

        await vi.waitFor(() => {
            expect(useWorkspaceStore.getState().sessions.map((session) => session.id)).toEqual([SESSION_2]);
        });
        expect(useWorkspaceStore.getState().pins).toEqual([]);
        expect(useWorkspaceStore.getState().selectedId).toBeNull();
    });

    it("detaches only its own unauthorized handler when disposed", async () => {
        let unauthorized = false;
        const fetchMock = vi.fn<FetchLike>((input) => {
            const url = requestUrl(input);
            if (url.endsWith("/api/auth/status")) {
                return Promise.resolve(jsonResponse({ authRequired: true, authenticated: true }));
            }
            if (unauthorized) {
                return Promise.resolve(
                    jsonResponse({ error: "unauthorized", message: "Authentication required." }, { status: 401 }),
                );
            }
            return Promise.resolve(jsonResponse({ sessions: [], scannedAtMs: 1_000 }));
        });

        const apiClient = createApiClient({ fetch: fetchMock });
        const first = createAppStores({ apiClient, cache: createTestCache(), WebSocket: FakeWebSocket });
        await first.useAuthStore.getState().checkStatus();
        first.dispose();

        unauthorized = true;
        await expect(apiClient.listSessions()).rejects.toThrow("Authentication required.");
        expect(first.useAuthStore.getState().phase).toBe("authenticated");

        unauthorized = false;
        const secondFirst = createAppStores({ apiClient, cache: createTestCache(), WebSocket: FakeWebSocket });
        const secondNext = createAppStores({ apiClient, cache: createTestCache(), WebSocket: FakeWebSocket });
        await secondFirst.useAuthStore.getState().checkStatus();
        await secondNext.useAuthStore.getState().checkStatus();
        // Disposing the earlier graph must not clear the newer graph's handler on the shared client.
        secondFirst.dispose();

        unauthorized = true;
        await expect(apiClient.listSessions()).rejects.toThrow("Authentication required.");
        expect(secondFirst.useAuthStore.getState().phase).toBe("authenticated");
        expect(secondNext.useAuthStore.getState().phase).toBe("unauthenticated");
    });
});
