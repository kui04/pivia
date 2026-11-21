import {
    parseEntriesVersion,
    parseSessionId,
    type EntriesVersion,
    type SessionId,
    type SessionStateSnapshot,
    type SessionSummary,
    type WsServerMessage,
} from "@pivia/protocol";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDbSessionCache } from "@/lib/cache/session-cache";
import { createApiClient, type FetchLike } from "@/lib/transport/http";
import type { SessionSocketLike } from "@/lib/transport/session-socket";

import { createAppStores } from "./index";

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

const SESSION_1 = sid("session-1");
const SESSION_2 = sid("session-2");
const V152 = ev("3:1.5.2");

class FakeSocket implements SessionSocketLike {
    static instances: FakeSocket[] = [];

    readonly url: string;
    readonly sent: string[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(message: WsServerMessage): void {
        this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    }
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function summary(id: SessionId): SessionSummary {
    return {
        id,
        cwd: "/home/u/project",
        name: null,
        firstMessage: "Hello",
        messageCount: 1,
        createdAtMs: 1_000,
        modifiedAtMs: 1_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 0,
    };
}

function stateSnapshot(sessionId: SessionId): SessionStateSnapshot {
    return {
        sessionId,
        cwd: "/home/u/project",
        name: null,
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
        steeringMessages: [],
        followUpMessages: [],
    };
}

function requestUrl(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function createTestCache(): IndexedDbSessionCache {
    return new IndexedDbSessionCache({
        indexedDB: new IDBFactory(),
        keyRange: IDBKeyRange,
    });
}

describe("createAppStores", () => {
    beforeEach(() => {
        FakeSocket.instances = [];
        Object.defineProperty(globalThis, "location", {
            value: { href: "http://localhost:3141/workspace" },
            configurable: true,
        });
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
                    jsonResponse({ error: "unauthorized", message: "Authentication required." }, 401),
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
            WebSocket: FakeSocket,
        });
        const clearCacheSpy = vi.spyOn(useSessionStore.getState(), "clearCache");

        await useAuthStore.getState().checkStatus();
        expect(useAuthStore.getState().phase).toBe("authenticated");

        useSessionStore.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });
        const sock = FakeSocket.instances[0];
        if (sock === undefined) {
            throw new Error("expected FakeSocket instance");
        }
        sock.open();
        sock.receive({
            type: "snapshot",
            sessionId: SESSION_1,
            runtimeId: "rt-1",
            seq: 1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entriesMode: "inline",
            entries: [],
            state: stateSnapshot(SESSION_1),
            liveMessage: null,
            pendingUiRequests: [],
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
            return Promise.resolve(jsonResponse({}, 404));
        });

        const cache = createTestCache();
        const clearAllSpy = vi.spyOn(cache, "clearAll");
        const apiClient = createApiClient({ fetch: fetchMock });
        const { useAuthStore, useSessionStore } = createAppStores({
            apiClient,
            cache,
            WebSocket: FakeSocket,
        });
        const clearCacheSpy = vi.spyOn(useSessionStore.getState(), "clearCache");

        await useAuthStore.getState().checkStatus();
        useSessionStore.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });

        await useAuthStore.getState().logout();

        expect(useAuthStore.getState().phase).toBe("unauthenticated");
        expect(clearCacheSpy).toHaveBeenCalledTimes(1);
        expect(clearAllSpy).toHaveBeenCalledTimes(1);
        expect(useSessionStore.getState().sessionId).toBeNull();
    });

    it("removes a missing session from the workspace store when HTTP sync returns 404", async () => {
        const fetchMock = vi.fn<FetchLike>(() =>
            Promise.resolve(jsonResponse({ error: "not_found", message: "Session not found." }, 404)),
        );
        const cache = createTestCache();
        const apiClient = createApiClient({ fetch: fetchMock });
        const { useWorkspaceStore, useSessionStore } = createAppStores({
            apiClient,
            cache,
            WebSocket: FakeSocket,
        });

        useWorkspaceStore.getState().applyScan({
            sessions: [summary(SESSION_1), summary(SESSION_2)],
            scannedAtMs: 5_000,
        });
        useWorkspaceStore.getState().togglePinned(SESSION_1);
        useWorkspaceStore.getState().select(SESSION_1);

        useSessionStore.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });
        const sock = FakeSocket.instances[0];
        if (sock === undefined) {
            throw new Error("expected FakeSocket instance");
        }
        sock.open();
        sock.receive({
            type: "snapshot",
            sessionId: SESSION_1,
            runtimeId: "rt-missing",
            seq: 1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entriesMode: "http",
            entryCount: 1,
            state: stateSnapshot(SESSION_1),
            liveMessage: null,
            pendingUiRequests: [],
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
                    jsonResponse({ error: "unauthorized", message: "Authentication required." }, 401),
                );
            }
            return Promise.resolve(jsonResponse({ sessions: [], scannedAtMs: 1_000 }));
        });

        const apiClient = createApiClient({ fetch: fetchMock });
        const first = createAppStores({ apiClient, cache: createTestCache(), WebSocket: FakeSocket });
        await first.useAuthStore.getState().checkStatus();
        first.dispose();

        unauthorized = true;
        await expect(apiClient.listSessions()).rejects.toThrow("Authentication required.");
        expect(first.useAuthStore.getState().phase).toBe("authenticated");

        unauthorized = false;
        const secondFirst = createAppStores({ apiClient, cache: createTestCache(), WebSocket: FakeSocket });
        const secondNext = createAppStores({ apiClient, cache: createTestCache(), WebSocket: FakeSocket });
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
