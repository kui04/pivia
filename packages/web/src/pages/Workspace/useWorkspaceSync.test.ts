import {
    parseSessionId,
    parseSyncEpoch,
    parseSyncSeq,
    type AuthStatusResponse,
    type SessionId,
    type SessionListResponse,
    type SessionSummary,
    type SyncEpoch,
    type SyncSeq,
} from "@pivia/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function epoch(raw: string): SyncEpoch<"catalog"> {
    const parsed = parseSyncEpoch<"catalog">(raw);
    if (parsed === null) {
        throw new Error(`Invalid test catalog epoch: ${raw}`);
    }
    return parsed;
}

function seq(raw: number): SyncSeq<"catalog"> {
    const parsed = parseSyncSeq<"catalog">(raw);
    if (parsed === null) {
        throw new Error(`Invalid test catalog seq: ${raw}`);
    }
    return parsed;
}

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
    Object.defineProperty(globalThis, "localStorage", {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
    return entries;
});

import type { WebSocketLike } from "@/lib/transport";
import { createWorkspaceStore, type WorkspaceCatalogCache } from "@/stores/workspace";

import { createWorkspaceSyncController } from "./useWorkspaceSync";

class FakeWorkspaceSocket implements WebSocketLike {
    static instances: FakeWorkspaceSocket[] = [];

    readonly url: string;
    readonly closeCalls: Array<{ readonly code?: number; readonly reason?: string }> = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(url: string) {
        this.url = url;
        FakeWorkspaceSocket.instances.push(this);
    }

    send(): void {}

    close(code?: number, reason?: string): void {
        this.closeCalls.push({
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
        });
        this.readyState = 3;
    }

    triggerOpen(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    triggerMessage(payload: unknown): void {
        this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent);
    }

    triggerClose(code = 1006, reason = "", wasClean = false): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean } as CloseEvent);
    }
}

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

const SESSION_1 = sid("session-1");
const SESSION_2 = sid("session-2");
const CACHED = sid("session-cached");
const EPOCH_1 = epoch("epoch-1");

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
    }
}

const okAuthStatus = (): Promise<AuthStatusResponse> => Promise.resolve({ authRequired: false, authenticated: true });

describe("createWorkspaceSyncController", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storageBacking.clear();
        FakeWorkspaceSocket.instances = [];
        Object.defineProperty(globalThis, "location", {
            value: new URL("http://127.0.0.1:3141/workspace"),
            configurable: true,
            writable: true,
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("hydrates IndexedDB cache on start and applies live snapshot and incremental events", async () => {
        const cache: WorkspaceCatalogCache = {
            get: vi.fn(() => Promise.resolve({ sessions: [summary(CACHED)], updatedAtMs: 500 })),
            put: vi.fn(() => Promise.resolve()),
        };
        const workspaceStore = createWorkspaceStore({ cache });
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions: vi.fn(), getAuthStatus: okAuthStatus },
            WebSocket: FakeWorkspaceSocket,
            minRefreshDurationMs: 0,
        });

        controller.start();
        await flushMicrotasks();
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([CACHED]);
        expect(workspaceStore.getState().updatedAtMs).toBe(500);

        const socket = FakeWorkspaceSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected workspace socket");
        }
        socket.triggerOpen();
        socket.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(0) },
            snapshot: {
                sessions: [summary(SESSION_1)],
                updatedAtMs: 2_000,
            },
        });

        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1]);
        expect(workspaceStore.getState().updatedAtMs).toBe(2_000);

        socket.triggerMessage({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: seq(1) },
            delta: {
                op: "upsert",
                item: summary(SESSION_2, { runtimeState: "streaming", attachedClients: 1 }),
            },
        });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1, SESSION_2]);

        socket.triggerMessage({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: seq(2) },
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

        socket.triggerMessage({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: seq(3) },
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
            WebSocket: FakeWorkspaceSocket,
            reconnectDelaysMs: [500, 1_500],
            minRefreshDurationMs: 0,
        });

        controller.start();
        expect(FakeWorkspaceSocket.instances).toHaveLength(1);

        FakeWorkspaceSocket.instances[0]?.triggerClose(1006, "Lost", false);
        expect(workspaceStore.getState().sync).toEqual({ kind: "reconnecting", attempt: 1 });

        vi.advanceTimersByTime(499);
        expect(FakeWorkspaceSocket.instances).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(FakeWorkspaceSocket.instances).toHaveLength(2);

        FakeWorkspaceSocket.instances[1]?.triggerClose(1006, "Lost again", false);
        await flushMicrotasks();
        expect(workspaceStore.getState().sync).toEqual({ kind: "reconnecting", attempt: 2 });

        // Becoming visible cancels the 1500ms backoff and opens immediately.
        controller.handleVisibilityChange(true);
        expect(FakeWorkspaceSocket.instances).toHaveLength(3);

        FakeWorkspaceSocket.instances[2]?.triggerOpen();
        FakeWorkspaceSocket.instances[2]?.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(0) },
            snapshot: { sessions: [], updatedAtMs: 5_000 },
        });
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });

        // Stopping cancels any pending timer cleanly.
        FakeWorkspaceSocket.instances[2]?.triggerClose(1006, "Drop", false);
        controller.stop();
        vi.advanceTimersByTime(10_000);
        expect(FakeWorkspaceSocket.instances).toHaveLength(3);
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
            WebSocket: FakeWorkspaceSocket,
            minRefreshDurationMs: 0,
            onError,
        });

        controller.start();
        FakeWorkspaceSocket.instances[0]?.triggerClose(1006, "Drop", false);
        expect(FakeWorkspaceSocket.instances).toHaveLength(1);

        controller.refresh();
        controller.refresh();
        expect(listSessions).toHaveBeenCalledTimes(1);
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });

        resolveRefresh?.({
            sessions: [summary(SESSION_1)],
            updatedAtMs: 8_000,
            cursor: { epoch: EPOCH_1, seq: seq(1) },
        });
        await flushMicrotasks();

        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions.map((item) => item.id)).toEqual([SESSION_1]);
        expect(workspaceStore.getState().updatedAtMs).toBe(8_000);
        expect(FakeWorkspaceSocket.instances).toHaveLength(2);

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
            WebSocket: FakeWorkspaceSocket,
            minRefreshDurationMs: 0,
        });

        controller.start();
        controller.refresh();
        controller.stop();

        resolveRefresh?.({
            sessions: [summary(SESSION_1)],
            updatedAtMs: 9_000,
            cursor: { epoch: EPOCH_1, seq: seq(1) },
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
                        sessions: [summary(SESSION_1)],
                        updatedAtMs: 8_000,
                        cursor: { epoch: EPOCH_1, seq: seq(1) },
                    }),
                getAuthStatus: okAuthStatus,
            },
            WebSocket: FakeWorkspaceSocket,
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
            WebSocket: FakeWorkspaceSocket,
            reconnectDelaysMs: [500],
            minRefreshDurationMs: 0,
            onUnauthorized,
        });

        controller.start();
        FakeWorkspaceSocket.instances[0]?.triggerClose(1006, "Drop", false);
        expect(getAuthStatus).not.toHaveBeenCalled();

        vi.advanceTimersByTime(500);
        expect(FakeWorkspaceSocket.instances).toHaveLength(2);

        FakeWorkspaceSocket.instances[1]?.triggerClose(1006, "Unauthorized", false);
        expect(getAuthStatus).toHaveBeenCalledTimes(1);
        await flushMicrotasks();

        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5_000);
        expect(FakeWorkspaceSocket.instances).toHaveLength(2);
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
            WebSocket: FakeWorkspaceSocket,
            reconnectDelaysMs: [500],
            minRefreshDurationMs: 0,
        });

        controller.start();
        FakeWorkspaceSocket.instances[0]?.triggerClose(1006, "Drop", false);
        vi.advanceTimersByTime(500);
        expect(FakeWorkspaceSocket.instances).toHaveLength(2);

        FakeWorkspaceSocket.instances[1]?.triggerClose(1006, "Drop again", false);
        expect(getAuthStatus).toHaveBeenCalledTimes(1);

        // The visibility handler opens a new socket while the auth probe is still pending.
        controller.handleVisibilityChange(true);
        expect(FakeWorkspaceSocket.instances).toHaveLength(3);
        FakeWorkspaceSocket.instances[2]?.triggerOpen();
        FakeWorkspaceSocket.instances[2]?.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(0) },
            snapshot: { sessions: [], updatedAtMs: 5_000 },
        });
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });

        resolveAuth?.({ authRequired: false, authenticated: true });
        await flushMicrotasks();

        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        vi.advanceTimersByTime(5_000);
        expect(FakeWorkspaceSocket.instances).toHaveLength(3);
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
            WebSocket: FakeWorkspaceSocket,
            minRefreshDurationMs: 300,
        });

        controller.start();
        const socket = FakeWorkspaceSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected workspace socket");
        }
        socket.triggerOpen();
        socket.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(10) },
            snapshot: {
                sessions: [summary(SESSION_1, { runtimeState: "idle" })],
                updatedAtMs: 1_000,
            },
        });
        put.mockClear();

        // Start manual refresh while server snapshot is still at seq 10.
        controller.refresh();
        resolveRefresh?.({
            sessions: [summary(SESSION_1, { runtimeState: "idle" })],
            updatedAtMs: 2_010,
            cursor: { epoch: EPOCH_1, seq: seq(10) },
        });
        await flushMicrotasks();

        // Before the 300ms minRefreshDurationMs settles, a newer WS patch arrives at seq 11.
        socket.triggerMessage({
            type: "sync:delta",
            cursor: { epoch: EPOCH_1, seq: seq(11) },
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
            summary(SESSION_1, { runtimeState: "streaming", attachedClients: 1, modifiedAtMs: 2_020 }),
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
            WebSocket: FakeWorkspaceSocket,
            reconnectDelaysMs: [100],
            minRefreshDurationMs: 0,
        });

        controller.start();
        const first = FakeWorkspaceSocket.instances[0];
        if (first === undefined) {
            throw new Error("expected initial socket");
        }
        expect(new URL(first.url).search).toBe("");
        first.triggerOpen();
        first.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(4) },
            snapshot: { sessions: [summary(SESSION_1)], updatedAtMs: 1_000 },
        });
        first.triggerClose(1006, "Drop", false);
        vi.advanceTimersByTime(100);

        const second = FakeWorkspaceSocket.instances[1];
        if (second === undefined) {
            throw new Error("expected reconnect socket");
        }
        expect(new URL(second.url).search).toBe(`?epoch=${EPOCH_1}&afterSeq=4`);
        second.triggerOpen();
        second.triggerMessage({
            type: "sync:replay",
            cursor: { epoch: EPOCH_1, seq: seq(5) },
            fromSeq: seq(4),
            deltas: [
                {
                    seq: seq(5),
                    payload: { op: "patch", id: SESSION_1, patch: { runtimeState: "streaming" } },
                },
            ],
        });
        expect(workspaceStore.getState().sessions[0]?.runtimeState).toBe("streaming");

        second.triggerMessage({ type: "sync:resync", reason: "gap" });
        await flushMicrotasks();

        const third = FakeWorkspaceSocket.instances[2];
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
                cursor: { epoch: EPOCH_1, seq: seq(4) },
                updatedAtMs: 2_000,
                sessions: [summary(SESSION_1)],
            }),
        );
        const controller = createWorkspaceSyncController({
            workspaceStore,
            apiClient: { listSessions, getAuthStatus: okAuthStatus },
            WebSocket: FakeWorkspaceSocket,
            minRefreshDurationMs: 300,
        });

        controller.start();
        const sock = FakeWorkspaceSocket.instances[0];
        if (sock === undefined) {
            throw new Error("expected initial socket");
        }
        sock.triggerOpen();
        sock.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(2) },
            snapshot: { sessions: [summary(SESSION_1)], updatedAtMs: 1_000 },
        });

        controller.refresh();
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });
        await flushMicrotasks();

        // While HTTP minRefreshDurationMs is still pending, WS delivers a strictly newer snapshot.
        sock.triggerMessage({
            type: "sync:snapshot",
            cursor: { epoch: EPOCH_1, seq: seq(10) },
            snapshot: { sessions: [summary(SESSION_1, { runtimeState: "streaming" })], updatedAtMs: 3_000 },
        });
        expect(workspaceStore.getState().sync).toEqual({ kind: "syncing" });

        // Once the refresh timer finishes and sees completeExternalRefresh() === false, sync returns to live.
        vi.advanceTimersByTime(300);
        expect(workspaceStore.getState().sync).toEqual({ kind: "live" });
        expect(workspaceStore.getState().sessions[0]?.runtimeState).toBe("streaming");

        controller.stop();
    });
});
