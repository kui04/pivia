import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
    SESSION_CLOSE_CODE,
    type SessionDelta,
    type SessionId,
    type SessionSnapshot,
    type SessionWsServerMessage,
} from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, type ApiClient } from "@/lib/transport";
import { FakeWebSocket } from "@/test/fake-socket";
import { makeSessionStateSnapshot, mockLocation } from "@/test/fixtures";
import { ev, sessionEpoch, sessionSeq, sid } from "@/test/ids";

import { createSessionPool, DEFAULT_MAX_BACKGROUND_SESSIONS, isSessionKeepAliveBusy } from "./pool";
import { initialSessionState, type SessionState } from "./store";

const S1 = sid("session-1");
const S2 = sid("session-2");
const S3 = sid("session-3");
const S4 = sid("session-4");
const RUNTIME_1 = sessionEpoch("runtime-1");
const V152 = ev("3:1.5.2");

const stubApiClient: Pick<ApiClient, "getSession"> = {
    getSession: () => Promise.reject(new Error("unexpected getSession call")),
};

function dialogRequest(id: string): RpcExtensionUIRequest {
    return {
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: "Continue?",
        message: "Confirm the action.",
    };
}

function snapshotFrame(
    sessionId: SessionId,
    seqNum: number,
    overrides: Partial<SessionSnapshot> = {},
): SessionWsServerMessage {
    return {
        type: "sync:snapshot",
        cursor: { epoch: RUNTIME_1, seq: sessionSeq(seqNum) },
        snapshot: {
            entriesVersion: V152,
            baseEntryCount: 0,
            entries: { mode: "inline", data: [] },
            state: makeSessionStateSnapshot({ sessionId }),
            liveMessage: null,
            pendingUiRequests: [],
            ...overrides,
        },
    };
}

function deltaFrame(seqNum: number, delta: SessionDelta): SessionWsServerMessage {
    return {
        type: "sync:delta",
        cursor: { epoch: RUNTIME_1, seq: sessionSeq(seqNum) },
        delta,
    };
}

function socketFor(sessionId: SessionId): FakeWebSocket {
    const match = FakeWebSocket.instances.findLast(
        (socket) => new URL(socket.url).pathname === `/ws/sessions/${sessionId}`,
    );
    if (match === undefined) {
        throw new Error(`No socket created for session ${sessionId}`);
    }
    return match;
}

function connectSession(
    pool: ReturnType<typeof createSessionPool>,
    sessionId: SessionId,
    seq = 1,
    snapshotOverrides: Partial<SessionSnapshot> = {},
): FakeWebSocket {
    pool.attach(sessionId);
    const socket = socketFor(sessionId);
    socket.open();
    socket.receive(snapshotFrame(sessionId, seq, snapshotOverrides));
    return socket;
}

beforeEach(() => {
    FakeWebSocket.reset();
    mockLocation("http://localhost:3141/workspace");
});

describe("isSessionKeepAliveBusy", () => {
    it("returns false for initial idle state with null summary and no UI requests", () => {
        expect(isSessionKeepAliveBusy(initialSessionState)).toBe(false);
    });

    it("returns false when summary is present, idle, and pendingUiRequests is empty", () => {
        const idle: SessionState = {
            ...initialSessionState,
            sessionId: S1,
            state: makeSessionStateSnapshot({ sessionId: S1, isStreaming: false, isCompacting: false }),
            pendingUiRequests: [],
        };

        expect(isSessionKeepAliveBusy(idle)).toBe(false);
    });

    it("returns true when state.isStreaming is true", () => {
        const streaming: SessionState = {
            ...initialSessionState,
            sessionId: S1,
            state: makeSessionStateSnapshot({ sessionId: S1, isStreaming: true }),
        };

        expect(isSessionKeepAliveBusy(streaming)).toBe(true);
    });

    it("returns true when state.isCompacting is true", () => {
        const compacting: SessionState = {
            ...initialSessionState,
            sessionId: S1,
            state: makeSessionStateSnapshot({ sessionId: S1, isCompacting: true }),
        };

        expect(isSessionKeepAliveBusy(compacting)).toBe(true);
    });

    it("returns true when pendingUiRequests is non-empty even if runtime state is null or idle", () => {
        const withNullSummary: SessionState = {
            ...initialSessionState,
            sessionId: S1,
            state: null,
            pendingUiRequests: [dialogRequest("ui-1")],
        };
        const withIdleSummary: SessionState = {
            ...initialSessionState,
            sessionId: S1,
            state: makeSessionStateSnapshot({ sessionId: S1, isStreaming: false, isCompacting: false }),
            pendingUiRequests: [dialogRequest("ui-2")],
        };

        expect(isSessionKeepAliveBusy(withNullSummary)).toBe(true);
        expect(isSessionKeepAliveBusy(withIdleSummary)).toBe(true);
    });
});

describe("createSessionPool", () => {
    it("rejects negative, fractional, and non-finite maxBackgroundSessions", () => {
        for (const invalidBudget of [-1, -0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            expect(() =>
                createSessionPool({
                    WebSocket: FakeWebSocket,
                    apiClient: stubApiClient,
                    maxBackgroundSessions: invalidBudget,
                }),
            ).toThrow(/maxBackgroundSessions/i);
        }
    });

    it("attaches idempotently and exposes stores via getStore", () => {
        const pool = createSessionPool({ WebSocket: FakeWebSocket, apiClient: stubApiClient });

        expect(pool.getStore(S1)).toBeNull();
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set(),
        });

        const firstStore = pool.attach(S1);
        const secondStore = pool.attach(S1);

        expect(secondStore).toBe(firstStore);
        expect(pool.getStore(S1)).toBe(firstStore);
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(socketFor(S1).url).toBe("ws://localhost:3141/ws/sessions/session-1");
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set([S1]),
        });
    });

    it("isolates state and sockets across concurrently attached sessions", () => {
        const pool = createSessionPool({ WebSocket: FakeWebSocket, apiClient: stubApiClient });

        const sock1 = connectSession(pool, S1, 1);
        const sock2 = connectSession(pool, S2, 1);

        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(sock1.readyState).toBe(1);
        expect(sock2.readyState).toBe(1);

        sock1.receive(deltaFrame(2, { kind: "agent_event", event: { type: "agent_start" } }));

        expect(pool.getStore(S1)?.getState().state?.isStreaming).toBe(true);
        expect(pool.getStore(S2)?.getState().state?.isStreaming).toBe(false);
        expect(pool.getStore(S2)?.getState().sessionId).toBe(S2);
    });

    it("keeps all visible sessions attached even above maxBackgroundSessions and tracks backgroundIds", () => {
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            maxBackgroundSessions: 1,
        });

        pool.setVisibleSessions(new Set([S1, S2, S3]));
        expect(FakeWebSocket.instances).toHaveLength(3);
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set([S1, S2, S3]),
        });

        // Moving S1 out of visibleIds keeps it in background within budget (1).
        pool.setVisibleSessions(new Set([S2, S3]));
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set([S1, S2, S3]),
        });
        expect(socketFor(S1).closeCalls).toHaveLength(0);
    });

    it("defaults maxBackgroundSessions to DEFAULT_MAX_BACKGROUND_SESSIONS", () => {
        expect(DEFAULT_MAX_BACKGROUND_SESSIONS).toBe(8);
        const pool = createSessionPool({ WebSocket: FakeWebSocket, apiClient: stubApiClient });

        const ids = Array.from({ length: DEFAULT_MAX_BACKGROUND_SESSIONS + 1 }, (_, idx) =>
            sid(`session-default-${idx}`),
        );
        for (const id of ids) {
            connectSession(pool, id, 1);
        }

        const firstId = ids[0];
        expect(firstId).toBeDefined();
        if (firstId !== undefined) {
            expect(pool.getStore(firstId)).toBeNull();
            expect(socketFor(firstId).closeCalls.length).toBeGreaterThan(0);
        }
        expect(pool.getSnapshot().attachedIds.size).toBe(DEFAULT_MAX_BACKGROUND_SESSIONS);
    });

    it("evicts the least-recently-used background session and refreshes recency on attach or view", () => {
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            maxBackgroundSessions: 2,
        });

        const sock1 = connectSession(pool, S1, 1);
        const sock2 = connectSession(pool, S2, 1);

        // Touch S1 so S2 becomes the least-recently-used background session.
        pool.attach(S1);
        const sock3 = connectSession(pool, S3, 1);

        expect(pool.getStore(S2)).toBeNull();
        expect(sock2.closeCalls.length).toBeGreaterThan(0);
        expect(sock1.closeCalls).toHaveLength(0);
        expect(sock3.closeCalls).toHaveLength(0);
        expect(pool.getSnapshot().attachedIds).toEqual(new Set([S1, S3]));

        // Viewing S1 then hiding it refreshes S1's recency so S3 is evicted next.
        pool.setVisibleSessions(new Set([S1]));
        pool.setVisibleSessions(new Set());
        const sock4 = connectSession(pool, S4, 1);

        expect(pool.getStore(S3)).toBeNull();
        expect(sock3.closeCalls.length).toBeGreaterThan(0);
        expect(sock1.closeCalls).toHaveLength(0);
        expect(sock4.closeCalls).toHaveLength(0);
        expect(pool.getSnapshot().attachedIds).toEqual(new Set([S1, S4]));
    });

    it("skips busy background sessions (streaming, compacting, pending UI) during eviction and evicts when idle", () => {
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            maxBackgroundSessions: 1,
        });

        // S1 is streaming (busy), S2 is idle -> adding S3 skips S1 and evicts S2.
        const sock1 = connectSession(pool, S1, 1, {
            state: makeSessionStateSnapshot({ sessionId: S1, isStreaming: true }),
        });
        const sock2 = connectSession(pool, S2, 1);
        const sock3 = connectSession(pool, S3, 1);

        expect(pool.getStore(S1)).not.toBeNull();
        expect(sock1.closeCalls).toHaveLength(0);
        expect(pool.getStore(S2)).toBeNull();
        expect(sock2.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S3)).not.toBeNull();

        // Compacting session S3 also cannot be evicted; when S1 finishes streaming, S1 is evicted
        // because background count (2) exceeds maxBackgroundSessions (1).
        sock3.receive(deltaFrame(2, { kind: "agent_event", event: { type: "compaction_start", reason: "manual" } }));
        expect(isSessionKeepAliveBusy(pool.getStore(S3)!.getState())).toBe(true);

        // Both S1 and S3 are busy, so attaching S4 leaves S1 and S3 protected while S4 stays within/over?
        // First settle S1 so S1 becomes idle while S3 stays compacting -> S1 is evicted.
        sock1.receive(deltaFrame(2, { kind: "agent_event", event: { type: "agent_settled", aborted: false } }));

        expect(pool.getStore(S1)).toBeNull();
        expect(sock1.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S3)).not.toBeNull();

        // Now test pendingUiRequests protection on S3: resolve compaction, add UI request, attach S4.
        sock3.receive(
            deltaFrame(3, {
                kind: "agent_event",
                event: {
                    type: "compaction_end",
                    reason: "manual",
                    result: undefined,
                    aborted: false,
                    willRetry: false,
                },
            }),
        );
        sock3.receive(deltaFrame(4, { kind: "ui_request", request: dialogRequest("req-1") }));
        const sock4 = connectSession(pool, S4, 1);

        // S3 is protected by pending UI request; S4 is newest within budget (1) or wait: background has S3 + S4.
        // S3 is skipped, S4 is kept if S4 is busy or wait: if budget is 1 and S3 is busy + S4 is idle, S4 could be evicted
        // unless S4 is also busy or visible; make S4 busy first, then settle S3 via ui_resolved!
        expect(pool.getStore(S3)).not.toBeNull();
        sock4.receive(deltaFrame(2, { kind: "agent_event", event: { type: "agent_start" } }));

        // Attach S2 again as idle -> with S3 (pending UI) and S4 (streaming) busy, S2 is evicted, or keep S3+S4 busy:
        // Resolving S3's UI request while S4 is also in background (count 2 > 1) evicts S3 automatically.
        sock3.receive(deltaFrame(5, { kind: "ui_resolved", requestId: "req-1" }));

        expect(pool.getStore(S3)).toBeNull();
        expect(sock3.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S4)).not.toBeNull();
    });

    it("evicts non-visible sessions immediately when maxBackgroundSessions is 0 unless busy", () => {
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            maxBackgroundSessions: 0,
        });

        pool.setVisibleSessions(new Set([S1, S2]));
        const sock1 = socketFor(S1);
        sock1.open();
        sock1.receive(snapshotFrame(S1, 1));

        const sock2 = socketFor(S2);
        sock2.open();
        sock2.receive(
            snapshotFrame(S2, 1, {
                state: makeSessionStateSnapshot({ sessionId: S2, isStreaming: true }),
            }),
        );

        // Leaving visibleIds immediately disconnects idle S1, while busy S2 stays in background.
        pool.setVisibleSessions(new Set());

        expect(pool.getStore(S1)).toBeNull();
        expect(sock1.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S2)).not.toBeNull();
        expect(sock2.closeCalls).toHaveLength(0);
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set([S2]),
        });

        // Once S2 becomes idle, it is evicted automatically because budget is 0.
        sock2.receive(deltaFrame(2, { kind: "agent_event", event: { type: "agent_settled", aborted: false } }));

        expect(pool.getStore(S2)).toBeNull();
        expect(sock2.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set(),
        });
    });

    it("detaches a single session without disturbing other attached sessions", () => {
        const pool = createSessionPool({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        pool.setVisibleSessions(new Set([S1, S2]));
        const sock1 = socketFor(S1);
        const sock2 = socketFor(S2);
        sock1.open();
        sock2.open();

        pool.detach(S1);
        pool.detach(S3); // detaching absent session is a safe no-op

        expect(pool.getStore(S1)).toBeNull();
        expect(sock1.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S2)).not.toBeNull();
        expect(sock2.closeCalls).toHaveLength(0);
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set([S2]),
        });
    });

    it("disconnects every store and clears caches on clearAll", () => {
        const pool = createSessionPool({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        pool.setVisibleSessions(new Set([S1]));
        const sock1 = socketFor(S1);
        sock1.open();
        sock1.receive(
            snapshotFrame(S1, 1, {
                entries: {
                    mode: "inline",
                    data: [
                        {
                            type: "message",
                            id: "m1",
                            parentId: null,
                            timestamp: "2026-04-01T00:00:01.000Z",
                            message: { role: "user", content: "cached", timestamp: 1 },
                        },
                    ],
                },
            }),
        );
        const sock2 = connectSession(pool, S2, 1);

        pool.clearAll();

        expect(sock1.closeCalls.length).toBeGreaterThan(0);
        expect(sock2.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S1)).toBeNull();
        expect(pool.getStore(S2)).toBeNull();
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set(),
        });

        // Re-attaching S1 starts fresh with cleared in-memory entries.
        const freshStore = pool.attach(S1);
        expect(freshStore.getState().entries).toEqual([]);
    });

    it("notifies subscribe listeners when attachedIds change and ignores no-op setVisibleSessions", () => {
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            maxBackgroundSessions: 1,
        });
        const listener = vi.fn();
        const unsubscribe = pool.subscribe(listener);

        pool.attach(S1);
        expect(listener).toHaveBeenCalledTimes(1);

        // S1 is already attached; adding/marking S1 visible without attaching new entries avoids extra emits.
        pool.setVisibleSessions(new Set([S1]));
        expect(listener).toHaveBeenCalledTimes(1);

        pool.setVisibleSessions(new Set([S1, S2]));
        expect(listener).toHaveBeenCalledTimes(2);
        const countAfterSecondAttach = listener.mock.calls.length;

        pool.detach(S1);
        expect(listener.mock.calls.length).toBeGreaterThan(countAfterSecondAttach);

        const countBeforeUnsub = listener.mock.calls.length;
        unsubscribe();
        pool.attach(S3);
        expect(listener).toHaveBeenCalledTimes(countBeforeUnsub);
    });

    it("setVisibleSessions does not reconnect an already-attached session in closed or error state", () => {
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            maxReconnectAttempts: 0,
        });
        pool.setVisibleSessions(new Set([S1]));
        const sock1 = socketFor(S1);
        sock1.open();
        sock1.receive(snapshotFrame(S1, 1));
        sock1.serverClose(SESSION_CLOSE_CODE.sessionClosed, "Closed on host");

        expect(pool.getStore(S1)?.getState().status).toBe("closed");
        const socketCountBeforeSplit = FakeWebSocket.instances.length;

        // Opening another visible pane keeps S1 in its closed terminal state rather than resetting/reconnecting.
        pool.setVisibleSessions(new Set([S1, S2]));
        expect(pool.getStore(S1)?.getState().status).toBe("closed");
        expect(FakeWebSocket.instances.length).toBe(socketCountBeforeSplit + 1);

        // Explicit attach(S1) retries connecting S1 when requested by the user.
        pool.attach(S1);
        expect(FakeWebSocket.instances.length).toBe(socketCountBeforeSplit + 2);
    });

    it("invokes onSessionMissing and removes the session cleanly on 4404 close", () => {
        const onSessionMissing = vi.fn();
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: stubApiClient,
            onSessionMissing,
        });

        pool.setVisibleSessions(new Set([S1]));
        const sock1 = socketFor(S1);
        sock1.open();
        sock1.receive(snapshotFrame(S1, 1));

        sock1.serverClose(SESSION_CLOSE_CODE.sessionNotFound, "Session not found");

        expect(onSessionMissing).toHaveBeenCalledExactlyOnceWith(S1);
        expect(pool.getStore(S1)).toBeNull();
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set(),
        });
    });

    it("invokes onSessionMissing and removes the session cleanly on HTTP 404 during hydration", async () => {
        const onSessionMissing = vi.fn();
        const getSession = vi
            .fn<ApiClient["getSession"]>()
            .mockRejectedValueOnce(new ApiClientError({ status: 404, code: "not_found", message: "Missing session" }));
        const pool = createSessionPool({
            WebSocket: FakeWebSocket,
            apiClient: { getSession },
            retryDelaysMs: [],
            onSessionMissing,
        });

        const sock1 = connectSession(pool, S1, 1, {
            entries: { mode: "http", meta: { entryCount: 1 } },
        });

        await vi.waitFor(() => {
            expect(onSessionMissing).toHaveBeenCalledExactlyOnceWith(S1);
        });
        expect(pool.getStore(S1)).toBeNull();
        expect(sock1.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getSnapshot()).toEqual({
            attachedIds: new Set(),
        });
    });

    it("releases all sockets and clears the pool on dispose without notifying cleared listeners", () => {
        const pool = createSessionPool({ WebSocket: FakeWebSocket, apiClient: stubApiClient });
        const listener = vi.fn();
        pool.subscribe(listener);
        const sock1 = connectSession(pool, S1, 1);
        const sock2 = connectSession(pool, S2, 1);
        listener.mockClear();

        pool.dispose();

        expect(sock1.closeCalls.length).toBeGreaterThan(0);
        expect(sock2.closeCalls.length).toBeGreaterThan(0);
        expect(pool.getStore(S1)).toBeNull();
        expect(pool.getStore(S2)).toBeNull();
        expect(pool.getSnapshot()).toEqual({ attachedIds: new Set() });
        expect(listener).not.toHaveBeenCalled();
    });
});
