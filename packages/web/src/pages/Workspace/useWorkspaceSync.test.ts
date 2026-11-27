import type { AuthStatusResponse, SessionListResponse } from "@pivia/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkspaceStore, type WorkspaceCatalogCache } from "@/stores/workspace";
import { FakeWebSocket } from "@/test/fake-socket";
import { makeSessionSummary, mockLocation } from "@/test/fixtures";
import { catalogEpoch, catalogSeq, sid } from "@/test/ids";
import { installMemoryLocalStorage } from "@/test/local-storage";

import { createWorkspaceSyncController } from "./useWorkspaceSync";

const storage = installMemoryLocalStorage();

const SESSION_1 = sid("session-1");
const SESSION_2 = sid("session-2");
const CACHED = sid("session-cached");
const EPOCH_1 = catalogEpoch("epoch-1");

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
    }
}

const okAuthStatus = (): Promise<AuthStatusResponse> => Promise.resolve({ authRequired: false, authenticated: true });

describe("createWorkspaceSyncController", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.clear();
        FakeWebSocket.reset();
        mockLocation();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("hydrates IndexedDB cache on start and applies live snapshot and incremental events", async () => {
        const cache: WorkspaceCatalogCache = {
            get: vi.fn(() => Promise.resolve({ sessions: [makeSessionSummary(CACHED)], updatedAtMs: 500 })),
            put: vi.fn(() => Promise.resolve()),
        };
        const workspaceStore = createWorkspaceStore({ cache });
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions: vi.fn(), getAuthStatus: okAuthStatus },
            WebSocket: FakeWebSocket,
            minRefreshDurationMs: 0,
        });

        controller.start();
        await flushMicrotasks();
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([CACHED]);
        expect(workspaceStore.getState().updatedAtMs).toBe(500);

        const socket = FakeWebSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected workspace socket");
        }
        socket.open();
        socket.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(0) },
            snapshot: {
                sessions: [makeSessionSummary(SESSION_1)],
                updatedAtMs: 2_000,
            },
        });

        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1]);
        expect(workspaceStore.getState().updatedAtMs).toBe(2_000);

        socket.receive({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(1) },
            delta: {
                op: "upsert",
                item: makeSessionSummary(SESSION_2, { runtimeState: "streaming", attachedClients: 1 }),
            },
        });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1, SESSION_2]);

        socket.receive({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(2) },
            delta: {
                op: "patch",
                id: SESSION_2,
                patch: { runtimeState: "idle", attachedClients: 0, modifiedAtMs: 3_000 },
            },
        });
        expect(workspaceStore.getState().sessions[1]).toMatchObject({
            id: SESSION_2,
            runtimeState: "idle",
            attachedClients: 0,
            modifiedAtMs: 3_000,
            firstMessage: "First prompt",
        });

        socket.receive({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(3) },
            delta: {
                op: "remove",
                id: SESSION_1,
            },
        });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_2]);

        controller.stop();
    });

    it("reconnects with backoff on unexpected close and reconnects immediately on visibility change", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions: vi.fn(), getAuthStatus: okAuthStatus },
            WebSocket: FakeWebSocket,
            reconnectDelaysMs: [500, 1_500],
            minRefreshDurationMs: 0,
        });

        controller.start();
        expect(FakeWebSocket.instances).toHaveLength(1);

        FakeWebSocket.instances[0]?.serverClose(1006, "Lost", false);
        expect(workspaceStore.getState().sync).toEqual({ kind: "reconnecting", attempt: 1 });

        vi.advanceTimersByTime(499);
        expect(FakeWebSocket.instances).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(FakeWebSocket.instances).toHaveLength(2);

        FakeWebSocket.instances[1]?.serverClose(1006, "Lost again", false);
        await flushMicrotasks();
        expect(workspaceStore.getState().sync).toEqual({ kind: "reconnecting", attempt: 2 });

        // Becoming visible cancels the 1500ms backoff and opens immediately.
        controller.handleVisibilityChange(true);
        expect(FakeWebSocket.instances).toHaveLength(3);

        FakeWebSocket.instances[2]?.open();
        FakeWebSocket.instances[2]?.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(0) },
            snapshot: { sessions: [], updatedAtMs: 5_000 },
        });
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });

        // Stopping cancels any pending timer cleanly.
        FakeWebSocket.instances[2]?.serverClose(1006, "Drop", false);
        controller.stop();
        vi.advanceTimersByTime(10_000);
        expect(FakeWebSocket.instances).toHaveLength(3);
    });

    it("enforces single-flight manual refresh, reconnects if disconnected, and notifies on failure", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        let resolveRefresh: ((value: SessionListResponse) => void) | undefined;
        let rejectRefresh: ((reason: Error) => void) | undefined;
        const listSessions = vi
            .fn<() => Promise<SessionListResponse>>()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveRefresh = resolve;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        rejectRefresh = reject;
                    }),
            );
        const onError = vi.fn();

        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions, getAuthStatus: okAuthStatus },
            WebSocket: FakeWebSocket,
            minRefreshDurationMs: 0,
            onError,
        });

        controller.start();
        FakeWebSocket.instances[0]?.serverClose(1006, "Drop", false);
        expect(FakeWebSocket.instances).toHaveLength(1);

        controller.refresh();
        controller.refresh();
        expect(listSessions).toHaveBeenCalledTimes(1);
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });

        resolveRefresh?.({
            sessions: [makeSessionSummary(SESSION_1)],
            updatedAtMs: 8_000,
            cursor: { epoch: EPOCH_1, seq: catalogSeq(1) },
        });
        await flushMicrotasks();

        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1]);
        expect(workspaceStore.getState().updatedAtMs).toBe(8_000);
        expect(FakeWebSocket.instances).toHaveLength(2);

        controller.refresh();
        rejectRefresh?.(new Error("Server unreachable"));
        await flushMicrotasks();

        expect(workspaceStore.getState().sync).toEqual({ kind: "failed", message: "Server unreachable" });
        expect(onError).toHaveBeenCalledWith("Server unreachable");

        controller.stop();
    });

    it("ignores late refresh responses after stop", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        let resolveRefresh: ((value: SessionListResponse) => void) | undefined;
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: {
                listSessions: () =>
                    new Promise((resolve) => {
                        resolveRefresh = resolve;
                    }),
                getAuthStatus: okAuthStatus,
            },
            WebSocket: FakeWebSocket,
            minRefreshDurationMs: 0,
        });

        controller.start();
        controller.refresh();
        controller.stop();

        resolveRefresh?.({
            sessions: [makeSessionSummary(SESSION_1)],
            updatedAtMs: 9_000,
            cursor: { epoch: EPOCH_1, seq: catalogSeq(1) },
        });
        await flushMicrotasks();

        expect(workspaceStore.getState().sessions).toEqual([]);
    });

    it("keeps syncing phase active for minRefreshDurationMs when refresh settles quickly", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: {
                listSessions: () =>
                    Promise.resolve({
                        sessions: [makeSessionSummary(SESSION_1)],
                        updatedAtMs: 8_000,
                        cursor: { epoch: EPOCH_1, seq: catalogSeq(1) },
                    }),
                getAuthStatus: okAuthStatus,
            },
            WebSocket: FakeWebSocket,
            minRefreshDurationMs: 300,
        });

        controller.start();
        controller.refresh();
        await flushMicrotasks();
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });

        vi.advanceTimersByTime(299);
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });

        vi.advanceTimersByTime(1);
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1]);

        controller.stop();
    });

    it("probes auth status after repeated close failures and triggers unauthorized when expired", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        const getAuthStatus = vi.fn(() => Promise.resolve({ authRequired: true, authenticated: false }));
        const onUnauthorized = vi.fn();
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: {
                listSessions: vi.fn(),
                getAuthStatus,
            },
            WebSocket: FakeWebSocket,
            reconnectDelaysMs: [500],
            minRefreshDurationMs: 0,
            onUnauthorized,
        });

        controller.start();
        FakeWebSocket.instances[0]?.serverClose(1006, "Drop", false);
        expect(getAuthStatus).not.toHaveBeenCalled();

        vi.advanceTimersByTime(500);
        expect(FakeWebSocket.instances).toHaveLength(2);

        FakeWebSocket.instances[1]?.serverClose(1006, "Unauthorized", false);
        expect(getAuthStatus).toHaveBeenCalledTimes(1);
        await flushMicrotasks();

        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_000);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("keeps the reconnected socket live when an older auth probe settles later", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        let resolveAuth: ((status: AuthStatusResponse) => void) | undefined;
        const getAuthStatus = vi.fn(
            () =>
                new Promise<AuthStatusResponse>((resolve) => {
                    resolveAuth = resolve;
                }),
        );
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: {
                listSessions: vi.fn(),
                getAuthStatus,
            },
            WebSocket: FakeWebSocket,
            reconnectDelaysMs: [500],
            minRefreshDurationMs: 0,
        });

        controller.start();
        FakeWebSocket.instances[0]?.serverClose(1006, "Drop", false);
        vi.advanceTimersByTime(500);
        expect(FakeWebSocket.instances).toHaveLength(2);

        FakeWebSocket.instances[1]?.serverClose(1006, "Drop again", false);
        expect(getAuthStatus).toHaveBeenCalledTimes(1);

        // The visibility handler opens a new socket while the auth probe is still pending.
        controller.handleVisibilityChange(true);
        expect(FakeWebSocket.instances).toHaveLength(3);
        FakeWebSocket.instances[2]?.open();
        FakeWebSocket.instances[2]?.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(0) },
            snapshot: { sessions: [], updatedAtMs: 5_000 },
        });
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });

        resolveAuth?.({ authRequired: false, authenticated: true });
        await flushMicrotasks();

        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        vi.advanceTimersByTime(5_000);
        expect(FakeWebSocket.instances).toHaveLength(3);
        controller.stop();
    });

    it("merges newer WS patches onto an older in-flight HTTP refresh before updating store and cache", async () => {
        const put = vi.fn(() => Promise.resolve());
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put,
            },
        });
        let resolveRefresh: ((value: SessionListResponse) => void) | undefined;
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: {
                listSessions: () =>
                    new Promise((resolve) => {
                        resolveRefresh = resolve;
                    }),
                getAuthStatus: okAuthStatus,
            },
            WebSocket: FakeWebSocket,
            minRefreshDurationMs: 300,
        });

        controller.start();
        const socket = FakeWebSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected workspace socket");
        }
        socket.open();
        socket.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(10) },
            snapshot: {
                sessions: [makeSessionSummary(SESSION_1, { runtimeState: "idle" })],
                updatedAtMs: 1_000,
            },
        });
        put.mockClear();

        // Start manual refresh while server snapshot is still at seq 10.
        controller.refresh();
        resolveRefresh?.({
            sessions: [makeSessionSummary(SESSION_1, { runtimeState: "idle" })],
            updatedAtMs: 2_010,
            cursor: { epoch: EPOCH_1, seq: catalogSeq(10) },
        });
        await flushMicrotasks();

        // Before the 300ms minRefreshDurationMs settles, a newer WS patch arrives at seq 11.
        socket.receive({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(11) },
            delta: {
                op: "patch",
                id: SESSION_1,
                patch: { runtimeState: "streaming", attachedClients: 1, modifiedAtMs: 2_020 },
            },
        });
        expect(workspaceStore.getState().sessions[0]).toMatchObject({
            runtimeState: "streaming",
            attachedClients: 1,
            modifiedAtMs: 2_020,
        });

        vi.advanceTimersByTime(300);

        // The settled refresh must keep the seq 11 patch and persist the merged catalog to IndexedDB.
        const expectedMerged = [
            makeSessionSummary(SESSION_1, { runtimeState: "streaming", attachedClients: 1, modifiedAtMs: 2_020 }),
        ];
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions).toEqual(expectedMerged);
        expect(put).toHaveBeenCalledTimes(1);
        expect(put).toHaveBeenCalledWith({ sessions: expectedMerged, updatedAtMs: 2_010 });

        controller.stop();
    });

    it("resumes with cursor handshake and resets cursor when server requests resync", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions: vi.fn(), getAuthStatus: okAuthStatus },
            WebSocket: FakeWebSocket,
            reconnectDelaysMs: [100],
            minRefreshDurationMs: 0,
        });

        controller.start();
        const first = FakeWebSocket.instances[0];
        if (first === undefined) {
            throw new Error("expected initial socket");
        }
        expect(new URL(first.url).search).toBe("");
        first.open();
        first.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(4) },
            snapshot: { sessions: [makeSessionSummary(SESSION_1)], updatedAtMs: 1_000 },
        });
        first.serverClose(1006, "Drop", false);
        vi.advanceTimersByTime(100);

        const second = FakeWebSocket.instances[1];
        if (second === undefined) {
            throw new Error("expected reconnect socket");
        }
        expect(new URL(second.url).search).toBe(`?epoch=${EPOCH_1}&afterSeq=4`);
        second.open();
        second.receive({
            type: "sync:replay",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(5) },
            fromSeq: catalogSeq(4),
            deltas: [
                {
                    seq: catalogSeq(5),
                    payload: { op: "patch", id: SESSION_1, patch: { runtimeState: "streaming" } },
                },
            ],
        });
        expect(workspaceStore.getState().sessions[0]?.runtimeState).toBe("streaming");

        second.receive({ type: "sync:resync", reason: "gap" });
        await flushMicrotasks();

        const third = FakeWebSocket.instances[2];
        if (third === undefined) {
            throw new Error("expected resync socket");
        }
        expect(new URL(third.url).search).toBe("");

        controller.stop();
    });

    it("exits syncing cleanly back to live when a manual refresh is superseded by a newer WS snapshot", async () => {
        const workspaceStore = createWorkspaceStore({
            cache: {
                get: () => Promise.resolve(null),
                put: () => Promise.resolve(),
            },
        });
        const listSessions = vi.fn<() => Promise<SessionListResponse>>(() =>
            Promise.resolve({
                cursor: { epoch: EPOCH_1, seq: catalogSeq(4) },
                updatedAtMs: 2_000,
                sessions: [makeSessionSummary(SESSION_1)],
            }),
        );
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions, getAuthStatus: okAuthStatus },
            WebSocket: FakeWebSocket,
            minRefreshDurationMs: 300,
        });

        controller.start();
        const sock = FakeWebSocket.instances[0];
        if (sock === undefined) {
            throw new Error("expected initial socket");
        }
        sock.open();
        sock.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(2) },
            snapshot: { sessions: [makeSessionSummary(SESSION_1)], updatedAtMs: 1_000 },
        });

        controller.refresh();
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });
        await flushMicrotasks();

        // While HTTP minRefreshDurationMs is still pending, WS delivers a strictly newer snapshot.
        sock.receive({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: catalogSeq(10) },
            snapshot: { sessions: [makeSessionSummary(SESSION_1, { runtimeState: "streaming" })], updatedAtMs: 3_000 },
        });
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });

        // Once the refresh timer finishes and sees completeExternalRefresh() === false, sync returns to live.
        vi.advanceTimersByTime(300);
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions[0]?.runtimeState).toBe("streaming");

        controller.stop();
    });
});
