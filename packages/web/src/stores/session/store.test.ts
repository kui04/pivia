import {
    parseEntriesVersion,
    parseSessionId,
    SESSION_CLOSE_CODE,
    type EntriesVersion,
    type FileEntry,
    type SessionDetailResponse,
    type SessionId,
    type SessionStateSnapshot,
    type WsServerMessage,
} from "@pivia/protocol";

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
const SESSION_A = sid("session-a");
const SESSION_B = sid("session-b");
const SESSION_BIG = sid("session-big");
const V152 = ev("3:1.5.2");
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDbSessionCache } from "@/lib/cache/session-cache";
import { ApiClientError, type ApiClient } from "@/lib/transport/http";
import type { SessionSocketLike } from "@/lib/transport/session-socket";

import { createSessionStore } from "./store";

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

    serverClose(code: number, reason = ""): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean: code === 1000 } as CloseEvent);
    }
}

const stubApiClient: Pick<ApiClient, "getSession"> = {
    getSession: () => Promise.reject(new Error("unexpected getSession call")),
};

function summary(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return {
        sessionId: SESSION_1,
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
        ...overrides,
    };
}

function snapshot(seq: number): WsServerMessage {
    return {
        type: "snapshot",
        sessionId: SESSION_1,
        runtimeId: "runtime-1",
        seq,
        entriesVersion: V152,
        baseEntryCount: 0,
        entriesMode: "inline",
        state: summary(),
        entries: [],
        liveMessage: null,
        pendingUiRequests: [],
    };
}

function lastSocket(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (socket === undefined) {
        throw new Error("The store did not create a socket");
    }
    return socket;
}

function sessionHeader(): FileEntry {
    return {
        type: "session",
        version: 3,
        id: "session-1",
        timestamp: "2026-04-01T00:00:00.000Z",
        cwd: "/home/u/project",
    };
}

function messageEntry(id: string): FileEntry {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-04-01T00:00:01.000Z",
        message: { role: "user", content: id, timestamp: 1 },
    };
}

function sessionDetail(baseEntryCount: number, entries: readonly FileEntry[]): SessionDetailResponse {
    return {
        session: {
            id: SESSION_1,
            cwd: "/home/u/project",
            name: null,
            firstMessage: "hi",
            messageCount: 0,
            createdAtMs: 1,
            modifiedAtMs: 1,
            hasParent: false,
            runtimeState: "idle",
            attachedClients: 1,
        },
        entriesVersion: V152,
        baseEntryCount,
        entries,
    };
}

beforeEach(() => {
    FakeSocket.instances = [];
    Object.defineProperty(globalThis, "location", {
        value: { href: "http://localhost:3141/workspace" },
        configurable: true,
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("createSessionStore", () => {
    it("connects, reports open and replaces the snapshot fields", () => {
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient });

        store.getState().connect(SESSION_1);
        expect(store.getState().status).toBe("connecting");

        const socket = lastSocket();
        expect(socket.url).toBe("ws://localhost:3141/ws/sessions/session-1");
        socket.open();
        expect(store.getState().status).toBe("open");

        socket.receive(snapshot(4));

        expect(store.getState()).toMatchObject({
            status: "open",
            sessionId: SESSION_1,
            seq: 4,
            entries: [],
            pendingUiRequests: [],
        });
        expect(store.getState().state).toEqual(summary());
    });

    it("is idempotent while the same session is open", () => {
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        lastSocket().open();

        store.getState().connect(SESSION_1);

        expect(FakeSocket.instances).toHaveLength(1);
    });

    it("sends commands through the active socket and answers UI requests out of band", async () => {
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        const socket = lastSocket();
        socket.open();

        const response = store.getState().sendCommand({ type: "abort", id: "abort-1" });
        expect(JSON.parse(socket.sent[0] ?? "")).toEqual({ type: "abort", id: "abort-1" });

        socket.receive({ type: "response", id: "abort-1", command: "abort", success: true });
        await expect(response).resolves.toMatchObject({ command: "abort" });

        await expect(
            store.getState().sendUiResponse({ type: "extension_ui_response", id: "dialog-1", cancelled: true }),
        ).resolves.toBeUndefined();
        expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
            type: "extension_ui_response",
            id: "dialog-1",
            cancelled: true,
        });
    });

    it("moves to closed without reconnecting after a business close", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient, reconnectDelayMs: 10 });
        store.getState().connect(SESSION_1);
        const socket = lastSocket();
        socket.open();
        socket.receive(snapshot(2));

        socket.serverClose(SESSION_CLOSE_CODE.sessionClosed, "Session closed");
        await vi.advanceTimersByTimeAsync(50);

        expect(store.getState().status).toBe("closed");
        expect(store.getState().lastError).toBe("Session closed");
        expect(FakeSocket.instances).toHaveLength(1);
    });

    it("reconnects after a server going-away close", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient, reconnectDelayMs: 10 });
        store.getState().connect(SESSION_1);
        const first = lastSocket();
        first.open();
        first.receive(snapshot(2));

        first.serverClose(SESSION_CLOSE_CODE.goingAway, "Server going away");
        expect(store.getState().status).toBe("reconnecting");

        await vi.advanceTimersByTimeAsync(10);

        expect(FakeSocket.instances).toHaveLength(2);
        expect(lastSocket().url).toBe("ws://localhost:3141/ws/sessions/session-1?afterSeq=2&runtimeId=runtime-1");
    });

    it("reconnects after a slow consumer with the last sequence", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient, reconnectDelayMs: 10 });
        store.getState().connect(SESSION_1);
        const first = lastSocket();
        first.open();
        first.receive(snapshot(4));

        first.serverClose(1013, "Slow consumer");
        expect(store.getState().status).toBe("reconnecting");

        await vi.advanceTimersByTimeAsync(10);

        expect(FakeSocket.instances).toHaveLength(2);
        const second = lastSocket();
        expect(second.url).toBe("ws://localhost:3141/ws/sessions/session-1?afterSeq=4&runtimeId=runtime-1");

        second.open();
        second.receive({
            type: "replay",
            sessionId: SESSION_1,
            runtimeId: "runtime-1",
            seq: 5,
            entriesVersion: V152,
            state: summary({ messageCount: 1 }),
            events: [{ seq: 5, event: { type: "agent_start" } }],
            liveMessage: null,
            pendingUiRequests: [],
        });

        expect(store.getState()).toMatchObject({ status: "open", seq: 5 });
        expect(store.getState().state?.isStreaming).toBe(true);
        expect(store.getState().liveEvents.map((entry) => entry.seq)).toEqual([5]);
    });

    it("stops reconnecting after the attempt budget", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({
            WebSocket: FakeSocket,
            apiClient: stubApiClient,
            reconnectDelayMs: 10,
            maxReconnectAttempts: 1,
        });
        store.getState().connect(SESSION_1);
        lastSocket().open();
        lastSocket().serverClose(1006, "Abnormal closure");

        await vi.advanceTimersByTimeAsync(10);
        expect(FakeSocket.instances).toHaveLength(2);

        lastSocket().serverClose(1006, "Abnormal closure");
        await vi.advanceTimersByTimeAsync(50);

        expect(FakeSocket.instances).toHaveLength(2);
        expect(store.getState().status).toBe("error");
        expect(store.getState().lastError).toBe("Cannot reconnect to the session.");
    });

    it("rejects pending commands and resets on disconnect", async () => {
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        lastSocket().open();

        const pending = store.getState().sendCommand({ type: "abort" });
        store.getState().disconnect();

        await expect(pending).rejects.toMatchObject({ classification: "client" });
        expect(store.getState()).toMatchObject({
            status: "idle",
            sessionId: null,
            seq: 0,
            state: null,
            pendingUiRequests: [],
        });
    });

    it("tracks pending dialogs and resolved requests", () => {
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        const socket = lastSocket();
        socket.open();

        socket.receive({
            type: "extension_ui_request",
            sessionId: SESSION_1,
            request: {
                type: "extension_ui_request",
                id: "dialog",
                method: "confirm",
                title: "Continue?",
                message: "Confirm",
            },
        });
        expect(store.getState().pendingUiRequests.map((request) => request.id)).toEqual(["dialog"]);

        socket.receive({ type: "extension_ui_resolved", sessionId: SESSION_1, requestId: "dialog" });
        expect(store.getState().pendingUiRequests).toEqual([]);
    });

    it("rejects a UI response when no socket is open", async () => {
        const store = createSessionStore({ WebSocket: FakeSocket, apiClient: stubApiClient });

        await expect(
            store.getState().sendUiResponse({
                type: "extension_ui_response",
                id: "dialog-1",
                cancelled: true,
            }),
        ).rejects.toMatchObject({ classification: "client" });
    });

    it("hydrates from IndexedDB and memory LRU on session switch A -> B -> A with dual anchors", async () => {
        const cache = new IndexedDbSessionCache({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
        const headerEntry: FileEntry = {
            type: "session",
            version: 3,
            id: "session-a",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };
        const msgEntry: FileEntry = {
            type: "message",
            id: "e1",
            parentId: null,
            timestamp: "2026-04-01T00:00:01.000Z",
            message: { role: "user", content: "from idb", timestamp: 1 },
        };
        await cache.replaceEntries(SESSION_A, V152, [headerEntry, msgEntry]);

        const store = createSessionStore({ WebSocket: FakeSocket, cache, apiClient: stubApiClient });
        store.getState().connect(SESSION_A);

        // Wait for async IndexedDB read to complete and open WS with prefix anchors.
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-a", "e1"]);
        expect(lastSocket().url).toContain("entriesVersion=3%3A1.5.2");
        expect(lastSocket().url).toContain("afterCount=2");
        expect(lastSocket().url).toContain("afterEntryId=e1");

        const sockA = lastSocket();
        sockA.open();
        sockA.receive({
            type: "snapshot",
            sessionId: SESSION_A,
            runtimeId: "rt-a",
            seq: 7,
            entriesVersion: V152,
            baseEntryCount: 2,
            entriesMode: "inline",
            entries: [],
            state: summary({ sessionId: SESSION_A }),
            liveMessage: null,
            pendingUiRequests: [],
        });

        // Switch to B then immediately back to A -> A hydrates synchronously from memory LRU with runtimeId & seq.
        store.getState().connect(SESSION_B);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(2);
        });
        store.getState().connect(SESSION_A);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-a", "e1"]);
        const sockA2 = lastSocket();
        expect(sockA2.url).toContain("afterSeq=7");
        expect(sockA2.url).toContain("runtimeId=rt-a");
        expect(sockA2.url).toContain("afterCount=2");
    });

    it("loads oversized sessions via HTTP, retries transient errors, and evicts on 404/4404", async () => {
        const cache = new IndexedDbSessionCache({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
        const headerEntry: FileEntry = {
            type: "session",
            version: 3,
            id: "session-big",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };
        const getSession = vi
            .fn<ApiClient["getSession"]>()
            .mockRejectedValueOnce(new ApiClientError({ status: 503, code: "internal_error", message: "Busy" }))
            .mockResolvedValueOnce({
                session: {
                    id: SESSION_BIG,
                    cwd: "/tmp",
                    name: null,
                    firstMessage: "hi",
                    messageCount: 0,
                    createdAtMs: 1,
                    modifiedAtMs: 1,
                    hasParent: false,
                    runtimeState: "idle",
                    attachedClients: 1,
                },
                entriesVersion: V152,
                baseEntryCount: 0,
                entries: [headerEntry],
            });
        const onSessionMissing = vi.fn();
        const apiClient: Pick<ApiClient, "getSession"> = { getSession };

        const store = createSessionStore({
            WebSocket: FakeSocket,
            cache,
            apiClient,
            retryDelaysMs: [0],
            onSessionMissing,
        });
        store.getState().connect(SESSION_BIG);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });

        const sock = lastSocket();
        sock.open();
        sock.receive({
            type: "snapshot",
            sessionId: SESSION_BIG,
            runtimeId: "rt-big",
            seq: 1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entriesMode: "http",
            entryCount: 1,
            state: summary({ sessionId: SESSION_BIG }),
            liveMessage: null,
            pendingUiRequests: [],
        });

        await vi.waitFor(() => {
            expect(store.getState().entriesSync).toEqual({ kind: "idle" });
        });
        expect(getSession).toHaveBeenCalledTimes(2);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-big"]);
        expect((await cache.getSession(SESSION_BIG))?.entries).toHaveLength(1);

        // Server closing with 4404 evicts IndexedDB cache and notifies workspace store.
        sock.serverClose(SESSION_CLOSE_CODE.sessionNotFound, "Session not found");
        await vi.waitFor(async () => {
            expect(await cache.getSession(SESSION_BIG)).toBeNull();
        });
        expect(onSessionMissing).toHaveBeenCalledWith(SESSION_BIG);
    });

    it("keeps a failed entry sync visible until the cooldown or a manual retry", async () => {
        const detail = sessionDetail(0, [sessionHeader()]);
        const getSession = vi
            .fn<ApiClient["getSession"]>()
            .mockRejectedValueOnce(new ApiClientError({ status: 503, code: "internal_error", message: "Busy" }))
            .mockResolvedValueOnce(detail);
        const store = createSessionStore({
            WebSocket: FakeSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            entriesSyncCooldownMs: 60_000,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });
        const sock = lastSocket();
        sock.open();
        sock.receive({
            type: "snapshot",
            sessionId: SESSION_1,
            runtimeId: "runtime-1",
            seq: 1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entriesMode: "http",
            entryCount: 1,
            state: summary(),
            liveMessage: null,
            pendingUiRequests: [],
        });

        await vi.waitFor(() => {
            expect(store.getState().entriesSync.kind).toBe("error");
        });
        expect(getSession).toHaveBeenCalledTimes(1);

        // The failure is not retried at append frequency: the cooldown timer is still pending.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(getSession).toHaveBeenCalledTimes(1);
        expect(store.getState().entriesSync.kind).toBe("error");

        // A manual retry skips the cooldown and recovers.
        store.getState().retryEntriesSync();
        await vi.waitFor(() => {
            expect(store.getState().entriesSync).toEqual({ kind: "idle" });
        });
        expect(getSession).toHaveBeenCalledTimes(2);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1"]);

        store.getState().disconnect();
    });

    it("retries a failed entry sync once after the cooldown expires", async () => {
        const getSession = vi
            .fn<ApiClient["getSession"]>()
            .mockRejectedValueOnce(new ApiClientError({ status: 503, code: "internal_error", message: "Busy" }))
            .mockResolvedValueOnce(sessionDetail(0, [sessionHeader()]));
        const store = createSessionStore({
            WebSocket: FakeSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            entriesSyncCooldownMs: 0,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });
        const sock = lastSocket();
        sock.open();
        sock.receive({
            type: "snapshot",
            sessionId: SESSION_1,
            runtimeId: "runtime-1",
            seq: 1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entriesMode: "http",
            entryCount: 1,
            state: summary(),
            liveMessage: null,
            pendingUiRequests: [],
        });

        await vi.waitFor(() => {
            expect(store.getState().entriesSync).toEqual({ kind: "idle" });
        });
        expect(getSession).toHaveBeenCalledTimes(2);

        store.getState().disconnect();
    });

    it("drops a pre-reconnect entry sync response so the handshake keeps newer entries", async () => {
        let resolveDetail!: (value: SessionDetailResponse) => void;
        const pending = new Promise<SessionDetailResponse>((resolve) => {
            resolveDetail = resolve;
        });
        const getSession = vi.fn<ApiClient["getSession"]>(() => pending);
        const store = createSessionStore({
            WebSocket: FakeSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            reconnectDelayMs: 0,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(1);
        });
        const first = lastSocket();
        first.open();
        first.receive({
            type: "snapshot",
            sessionId: SESSION_1,
            runtimeId: "runtime-1",
            seq: 1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entriesMode: "inline",
            entries: [sessionHeader(), messageEntry("e1")],
            state: summary(),
            liveMessage: null,
            pendingUiRequests: [],
        });
        first.receive({
            type: "entries_appended",
            sessionId: SESSION_1,
            entriesVersion: V152,
            entriesMode: "http",
            baseEntryCount: 2,
            entryCount: 5,
        });
        expect(getSession).toHaveBeenCalledTimes(1);

        // The reconnect delivers entries the in-flight request never saw.
        first.serverClose(SESSION_CLOSE_CODE.goingAway, "Server restart");
        await vi.waitFor(() => {
            expect(FakeSocket.instances).toHaveLength(2);
        });
        const second = lastSocket();
        second.open();
        second.receive({
            type: "snapshot",
            sessionId: SESSION_1,
            runtimeId: "runtime-2",
            seq: 0,
            entriesVersion: V152,
            baseEntryCount: 2,
            entriesMode: "inline",
            entries: [messageEntry("e2"), messageEntry("e3"), messageEntry("e4")],
            state: summary(),
            liveMessage: null,
            pendingUiRequests: [],
        });
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2", "e3", "e4"]);

        resolveDetail(sessionDetail(2, [messageEntry("e2")]));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2", "e3", "e4"]);
        store.getState().disconnect();
    });

    it("rejects missing apiClient at construction time", () => {
        // @ts-expect-error -- verify runtime guard for untyped callers
        expect(() => createSessionStore({})).toThrow("createSessionStore requires an apiClient.");
    });
});
