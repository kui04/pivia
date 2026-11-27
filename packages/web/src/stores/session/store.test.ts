import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    SESSION_CLOSE_CODE,
    type SessionDetailResponse,
    type SessionSnapshot,
    type SessionWsServerMessage,
} from "@pivia/protocol";

const SESSION_1 = sid("session-1");
const SESSION_A = sid("session-a");
const SESSION_B = sid("session-b");
const SESSION_BIG = sid("session-big");
const RUNTIME_1 = sessionEpoch("runtime-1");
const V152 = ev("3:1.5.2");
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexedDbAppCache } from "@/lib/cache";
import { ApiClientError, type ApiClient } from "@/lib/transport";
import { FakeWebSocket } from "@/test/fake-socket";
import { makeSessionStateSnapshot, mockLocation } from "@/test/fixtures";
import { ev, sessionEpoch, sessionSeq, sid } from "@/test/ids";

import { createSessionStore } from "./store";

const stubApiClient: Pick<ApiClient, "getSession"> = {
    getSession: () => Promise.reject(new Error("unexpected getSession call")),
};

function snapshot(seqNum: number, overrides: Partial<SessionSnapshot> = {}): SessionWsServerMessage {
    return {
        type: "sync:snapshot",
        cursor: { epoch: RUNTIME_1, seq: sessionSeq(seqNum) },
        snapshot: {
            entriesVersion: V152,
            baseEntryCount: 0,
            entries: { mode: "inline", data: [] },
            state: makeSessionStateSnapshot(),
            liveMessage: null,
            pendingUiRequests: [],
            ...overrides,
        },
    };
}

/** Connects to `SESSION_1`, opens the socket, and applies a snapshot; returns the socket. */
function connectAndOpen(
    store: ReturnType<typeof createSessionStore>,
    options: { readonly seq?: number; readonly snapshot?: Partial<SessionSnapshot> } = {},
): FakeWebSocket {
    store.getState().connect(SESSION_1);
    const socket = lastSocket();
    socket.open();
    socket.receive(snapshot(options.seq ?? 0, options.snapshot));
    return socket;
}

function lastSocket(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
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
    FakeWebSocket.reset();
    mockLocation("http://localhost:3141/workspace");
});

afterEach(() => {
    vi.useRealTimers();
});

describe("createSessionStore", () => {
    it("connects, reports open and replaces the snapshot fields", () => {
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient });

        store.getState().connect(SESSION_1);
        expect(store.getState().status).toBe("connecting");

        const socket = lastSocket();
        expect(socket.url).toBe("ws://localhost:3141/ws/sessions/session-1");
        socket.open();
        expect(store.getState().status).toBe("connecting");

        socket.receive(snapshot(4));

        expect(store.getState()).toMatchObject({
            status: "open",
            sessionId: SESSION_1,
            entries: [],
            pendingUiRequests: [],
        });
        expect(store.getState().state).toEqual(makeSessionStateSnapshot());
    });

    it("is idempotent while the same session is open", () => {
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        lastSocket().open();

        store.getState().connect(SESSION_1);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("sends commands through the active socket and answers UI requests out of band", async () => {
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        const socket = lastSocket();
        socket.open();

        const response = store.getState().sendCommand({ type: "abort", id: "abort-1" });
        expect(JSON.parse(socket.sent[0] ?? "")).toEqual({
            type: "rpc:command",
            command: { type: "abort", id: "abort-1" },
        });

        socket.receive({ type: "rpc:response", id: "abort-1", command: "abort", success: true });
        await expect(response).resolves.toMatchObject({ type: "rpc:response", command: "abort" });

        await expect(
            store.getState().sendUiResponse({ type: "extension_ui_response", id: "dialog-1", cancelled: true }),
        ).resolves.toBeUndefined();
        expect(JSON.parse(socket.sent[1] ?? "")).toEqual({
            type: "rpc:ui_response",
            response: {
                type: "extension_ui_response",
                id: "dialog-1",
                cancelled: true,
            },
        });
    });

    it("moves to closed without reconnecting after a business close", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient, reconnectDelayMs: 10 });
        const socket = connectAndOpen(store, { seq: 2 });

        socket.serverClose(SESSION_CLOSE_CODE.sessionClosed, "Session closed");
        await vi.advanceTimersByTimeAsync(50);

        expect(store.getState().status).toBe("closed");
        expect(store.getState().lastError).toBe("Session closed");
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("reconnects with the last cursor after a server close and applies the replay", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient, reconnectDelayMs: 10 });
        const first = connectAndOpen(store, { seq: 4 });

        first.serverClose(1013, "Slow consumer");
        expect(store.getState().status).toBe("reconnecting");

        await vi.advanceTimersByTimeAsync(10);

        expect(FakeWebSocket.instances).toHaveLength(2);
        const second = lastSocket();
        expect(second.url).toBe("ws://localhost:3141/ws/sessions/session-1?epoch=runtime-1&afterSeq=4");

        second.open();
        second.receive({
            type: "sync:replay",
            cursor: { epoch: RUNTIME_1, seq: sessionSeq(5) },
            fromSeq: sessionSeq(4),
            deltas: [{ seq: sessionSeq(5), payload: { kind: "agent_event", event: { type: "agent_start" } } }],
        });

        expect(store.getState()).toMatchObject({
            status: "open",
        });
        expect(store.getState().state?.isStreaming).toBe(true);
    });

    it("stops reconnecting after the attempt budget", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            reconnectDelayMs: 10,
            maxReconnectAttempts: 1,
        });
        store.getState().connect(SESSION_1);
        lastSocket().open();
        lastSocket().serverClose(1006, "Abnormal closure");

        await vi.advanceTimersByTimeAsync(10);
        expect(FakeWebSocket.instances).toHaveLength(2);

        lastSocket().serverClose(1006, "Abnormal closure");
        await vi.advanceTimersByTimeAsync(50);

        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(store.getState().status).toBe("error");
        expect(store.getState().lastError).toBe("Cannot reconnect to the session.");
    });

    it("rejects pending commands and resets on disconnect", async () => {
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        store.getState().connect(SESSION_1);
        lastSocket().open();

        const pending = store.getState().sendCommand({ type: "abort" });
        store.getState().disconnect();

        await expect(pending).rejects.toMatchObject({ classification: "client" });
        expect(store.getState()).toMatchObject({
            status: "idle",
            sessionId: null,
            state: null,
            pendingUiRequests: [],
        });
    });

    it("resets to idle and drops the memory cache on clearCache", () => {
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        connectAndOpen(store, { seq: 1, snapshot: { entries: { mode: "inline", data: [messageEntry("m1")] } } });
        expect(store.getState().entries).toHaveLength(1);

        // Disconnect caches the branch in memory, so connecting again shows it before the socket answers.
        store.getState().disconnect();
        store.getState().connect(SESSION_1);
        expect(store.getState().entries).toHaveLength(1);

        store.getState().clearCache();
        expect(store.getState()).toMatchObject({
            status: "idle",
            sessionId: null,
            entries: [],
            state: null,
            pendingUiRequests: [],
        });

        // The memory cache is gone, so reconnecting starts from an empty branch.
        store.getState().connect(SESSION_1);
        expect(store.getState().entries).toEqual([]);
    });

    it("rejects a UI response when no socket is open", async () => {
        const store = createSessionStore({ WebSocket: FakeWebSocket, apiClient: stubApiClient });

        await expect(
            store.getState().sendUiResponse({
                type: "extension_ui_response",
                id: "dialog-1",
                cancelled: true,
            }),
        ).rejects.toMatchObject({ classification: "client" });
    });

    it("hydrates from IndexedDB and memory LRU on session switch A -> B -> A with Tier 2 anchors only", async () => {
        const cache = new IndexedDbAppCache({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
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
        await cache.sessions.replaceEntries(SESSION_A, V152, [headerEntry, msgEntry]);

        const store = createSessionStore({ WebSocket: FakeWebSocket, cache: cache.sessions, apiClient: stubApiClient });
        store.getState().connect(SESSION_A);

        // Wait for async IndexedDB read to complete and open WS with prefix anchors.
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-a", "e1"]);
        expect(lastSocket().url).toContain("entriesVersion=3%3A1.5.2");
        expect(lastSocket().url).toContain("afterCount=2");
        expect(lastSocket().url).toContain("afterEntryId=e1");

        const sockA = lastSocket();
        sockA.open();
        sockA.receive({
            type: "sync:snapshot",
            cursor: { epoch: sessionEpoch("rt-a"), seq: sessionSeq(7) },
            snapshot: {
                entriesVersion: V152,
                baseEntryCount: 2,
                entries: { mode: "inline", data: [] },
                state: makeSessionStateSnapshot({ sessionId: SESSION_A }),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });

        // Switch to B then immediately back to A -> A hydrates synchronously from memory LRU with Tier 2 anchor.
        store.getState().connect(SESSION_B);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        store.getState().connect(SESSION_A);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-a", "e1"]);
        const sockA2 = lastSocket();
        expect(sockA2.url).not.toContain("afterSeq=");
        expect(sockA2.url).not.toContain("epoch=");
        expect(sockA2.url).toContain("afterCount=2");
        expect(sockA2.url).toContain("afterEntryId=e1");
    });

    it("loads oversized sessions via HTTP, retries transient errors, and evicts on 404/4404", async () => {
        const cache = new IndexedDbAppCache({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
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
            WebSocket: FakeWebSocket,
            cache: cache.sessions,
            apiClient,
            retryDelaysMs: [0],
            onSessionMissing,
        });
        store.getState().connect(SESSION_BIG);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });

        const sock = lastSocket();
        sock.open();
        sock.receive({
            type: "sync:snapshot",
            cursor: { epoch: sessionEpoch("rt-big"), seq: sessionSeq(1) },
            snapshot: {
                entriesVersion: V152,
                baseEntryCount: 0,
                entries: { mode: "http", meta: { entryCount: 1 } },
                state: makeSessionStateSnapshot({ sessionId: SESSION_BIG }),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });

        await vi.waitFor(() => {
            expect(store.getState().entriesSync).toEqual({ kind: "idle" });
        });
        expect(getSession).toHaveBeenCalledTimes(2);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-big"]);
        expect((await cache.sessions.get(SESSION_BIG))?.entries).toHaveLength(1);

        // Server closing with 4404 evicts IndexedDB cache and notifies workspace store.
        sock.serverClose(SESSION_CLOSE_CODE.sessionNotFound, "Session not found");
        await vi.waitFor(async () => {
            expect(await cache.sessions.get(SESSION_BIG)).toBeNull();
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
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            entriesSyncCooldownMs: 60_000,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const sock = lastSocket();
        sock.open();
        sock.receive(
            snapshot(1, {
                entries: { mode: "http", meta: { entryCount: 1 } },
            }),
        );

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
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            entriesSyncCooldownMs: 0,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const sock = lastSocket();
        sock.open();
        sock.receive(
            snapshot(1, {
                entries: { mode: "http", meta: { entryCount: 1 } },
            }),
        );

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
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            reconnectDelayMs: 0,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const first = lastSocket();
        first.open();
        first.receive(
            snapshot(1, {
                entries: { mode: "inline", data: [sessionHeader(), messageEntry("e1")] },
            }),
        );
        first.receive({
            type: "sync:delta",
            cursor: { epoch: RUNTIME_1, seq: sessionSeq(2) },
            delta: {
                kind: "entries_appended",
                entriesVersion: V152,
                baseEntryCount: 2,
                entries: { mode: "http", meta: { entryCount: 5 } },
            },
        });
        expect(getSession).toHaveBeenCalledTimes(1);

        // The reconnect delivers entries the in-flight request never saw.
        first.serverClose(SESSION_CLOSE_CODE.goingAway, "Server restart");
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const second = lastSocket();
        expect(second.url).toContain("epoch=runtime-1&afterSeq=1");
        second.open();
        second.receive({
            type: "sync:snapshot",
            cursor: { epoch: sessionEpoch("runtime-2"), seq: sessionSeq(0) },
            snapshot: {
                entriesVersion: V152,
                baseEntryCount: 2,
                entries: { mode: "inline", data: [messageEntry("e2"), messageEntry("e3"), messageEntry("e4")] },
                state: makeSessionStateSnapshot(),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2", "e3", "e4"]);

        resolveDetail(sessionDetail(2, [messageEntry("e2")]));
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2", "e3", "e4"]);
        store.getState().disconnect();
    });

    it("hydrates HTTP-offloaded entries_appended deltas mid-stream and skips redundant fetches", async () => {
        const getSession = vi
            .fn<ApiClient["getSession"]>()
            .mockResolvedValueOnce(sessionDetail(2, [messageEntry("e2"), messageEntry("e3")]));
        const store = createSessionStore({
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const sock = lastSocket();
        sock.open();
        sock.receive(
            snapshot(1, {
                entries: { mode: "inline", data: [sessionHeader(), messageEntry("e1")] },
            }),
        );

        sock.receive({
            type: "sync:delta",
            cursor: { epoch: RUNTIME_1, seq: sessionSeq(2) },
            delta: {
                kind: "entries_appended",
                entriesVersion: V152,
                baseEntryCount: 2,
                entries: { mode: "http", meta: { entryCount: 4 } },
            },
        });
        sock.receive({
            type: "sync:delta",
            cursor: { epoch: RUNTIME_1, seq: sessionSeq(3) },
            delta: { kind: "state_patched", patch: { messageCount: 3 } },
        });

        await vi.waitFor(() => {
            expect(store.getState().state?.messageCount).toBe(3);
        });
        expect(getSession).toHaveBeenCalledTimes(1);
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2", "e3"]);

        // Re-receiving an HTTP offload pointing at an entryCount already met skips HTTP.
        sock.receive({
            type: "sync:delta",
            cursor: { epoch: RUNTIME_1, seq: sessionSeq(4) },
            delta: {
                kind: "entries_appended",
                entriesVersion: V152,
                baseEntryCount: 3,
                entries: { mode: "http", meta: { entryCount: 4 } },
            },
        });
        expect(getSession).toHaveBeenCalledTimes(1);
        store.getState().disconnect();
    });

    it("does not burn maxReconnectAttempts when sync:resync triggers client-initiated socket close", async () => {
        const store = createSessionStore({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            reconnectDelayMs: 5,
            maxReconnectAttempts: 1,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const first = lastSocket();
        first.open();
        first.receive(
            snapshot(1, {
                entries: { mode: "inline", data: [sessionHeader()] },
            }),
        );

        // Two server resyncs would exhaust maxReconnectAttempts=1 if client closes fired notifyClosed().
        first.receive({ type: "sync:resync", reason: "gap" });
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        expect(store.getState().status).not.toBe("error");

        const second = lastSocket();
        second.open();
        second.receive(snapshot(2));
        second.receive({ type: "sync:resync", reason: "gap" });
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(3);
        });
        expect(store.getState().status).not.toBe("error");

        store.getState().disconnect();
    });

    it("stays closed when onHydrateHttp gets 404 even if pendingOverflow occurred mid-hydration", async () => {
        let rejectDetail: ((error: unknown) => void) | undefined;
        const getSession = vi.fn<ApiClient["getSession"]>().mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectDetail = reject;
                }),
        );
        const onSessionMissing = vi.fn();
        const store = createSessionStore({
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            onSessionMissing,
            retryDelaysMs: [],
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const sock = lastSocket();
        sock.open();
        sock.receive(
            snapshot(1, {
                entries: { mode: "http", meta: { entryCount: 10 } },
            }),
        );

        // Flood more than DEFAULT_MAX_PENDING_DELTAS (512) deltas while hydration HTTP is in flight.
        for (let i = 2; i <= 520; i += 1) {
            sock.receive({
                type: "sync:delta",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(i) },
                delta: { kind: "state_patched", patch: { messageCount: i } },
            });
        }

        rejectDetail?.(new ApiClientError({ status: 404, code: "not_found", message: "Session missing" }));
        await vi.waitFor(() => {
            expect(store.getState().status).toBe("closed");
        });
        expect(onSessionMissing).toHaveBeenCalledWith(SESSION_1);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("forces a fresh snapshot instead of replay when reconnecting after failed hydration", async () => {
        const interruptedRetry = Promise.withResolvers<SessionDetailResponse>();
        let interruptedSignal: AbortSignal | undefined;
        const getSession = vi
            .fn<ApiClient["getSession"]>()
            .mockRejectedValueOnce(new Error("Temporary 503"))
            .mockImplementationOnce((_id, opts) => {
                interruptedSignal = opts?.signal;
                return interruptedRetry.promise;
            });
        const store = createSessionStore({
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            entriesSyncCooldownMs: 60_000,
            reconnectDelayMs: 5,
        });

        store.getState().connect(SESSION_1);
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(1);
        });
        const first = lastSocket();
        first.open();
        first.receive(
            snapshot(1, {
                entries: { mode: "inline", data: [sessionHeader(), messageEntry("e1")] },
            }),
        );

        first.receive({
            type: "sync:delta",
            cursor: { epoch: RUNTIME_1, seq: sessionSeq(2) },
            delta: {
                kind: "entries_appended",
                entriesVersion: V152,
                baseEntryCount: 2,
                entries: { mode: "http", meta: { entryCount: 4 } },
            },
        });
        await vi.waitFor(() => {
            expect(store.getState().entriesSync.kind).toBe("error");
        });

        // User starts manual retry right before transport drops; reconnect must omit afterSeq/epoch.
        store.getState().retryEntriesSync();
        expect(store.getState().entriesSync.kind).toBe("loading");
        expect(interruptedSignal?.aborted).toBe(false);
        first.serverClose(1006, "Drop");
        expect(interruptedSignal?.aborted).toBe(true);

        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const second = lastSocket();
        const reconnectUrl = new URL(second.url);
        expect(reconnectUrl.searchParams.has("epoch")).toBe(false);
        expect(reconnectUrl.searchParams.has("afterSeq")).toBe(false);
        second.open();
        second.receive(
            snapshot(3, {
                entries: {
                    mode: "inline",
                    data: [sessionHeader(), messageEntry("e1"), messageEntry("e2"), messageEntry("e3")],
                },
                state: makeSessionStateSnapshot({ messageCount: 3 }),
            }),
        );

        expect(store.getState().entriesSync.kind).toBe("idle");
        expect(store.getState().entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2", "e3"]);
        store.getState().disconnect();
    });
});
