import { SESSION_CLOSE_CODE, type SessionStateSnapshot, type WsServerMessage } from "@pivia/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function summary(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return {
        sessionId: "session-1",
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
        sessionId: "session-1",
        seq,
        state: summary(),
        entries: [],
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
        const store = createSessionStore({ WebSocket: FakeSocket });

        store.getState().connect("session-1");
        expect(store.getState().status).toBe("connecting");

        const socket = lastSocket();
        expect(socket.url).toBe("ws://localhost:3141/ws/sessions/session-1");
        socket.open();
        expect(store.getState().status).toBe("open");

        socket.receive(snapshot(4));

        expect(store.getState()).toMatchObject({
            status: "open",
            sessionId: "session-1",
            seq: 4,
            entries: [],
            pendingUiRequests: [],
        });
        expect(store.getState().state).toEqual(summary());
    });

    it("is idempotent while the same session is open", () => {
        const store = createSessionStore({ WebSocket: FakeSocket });
        store.getState().connect("session-1");
        lastSocket().open();

        store.getState().connect("session-1");

        expect(FakeSocket.instances).toHaveLength(1);
    });

    it("sends commands through the active socket and answers UI requests out of band", async () => {
        const store = createSessionStore({ WebSocket: FakeSocket });
        store.getState().connect("session-1");
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
        const store = createSessionStore({ WebSocket: FakeSocket, reconnectDelayMs: 10 });
        store.getState().connect("session-1");
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
        const store = createSessionStore({ WebSocket: FakeSocket, reconnectDelayMs: 10 });
        store.getState().connect("session-1");
        const first = lastSocket();
        first.open();
        first.receive(snapshot(2));

        first.serverClose(SESSION_CLOSE_CODE.goingAway, "Server going away");
        expect(store.getState().status).toBe("reconnecting");

        await vi.advanceTimersByTimeAsync(10);

        expect(FakeSocket.instances).toHaveLength(2);
        expect(lastSocket().url).toBe("ws://localhost:3141/ws/sessions/session-1?afterSeq=2");
    });

    it("reconnects after a slow consumer with the last sequence", async () => {
        vi.useFakeTimers();
        const store = createSessionStore({ WebSocket: FakeSocket, reconnectDelayMs: 10 });
        store.getState().connect("session-1");
        const first = lastSocket();
        first.open();
        first.receive(snapshot(4));

        first.serverClose(1013, "Slow consumer");
        expect(store.getState().status).toBe("reconnecting");

        await vi.advanceTimersByTimeAsync(10);

        expect(FakeSocket.instances).toHaveLength(2);
        const second = lastSocket();
        expect(second.url).toBe("ws://localhost:3141/ws/sessions/session-1?afterSeq=4");

        second.open();
        second.receive({
            type: "replay",
            sessionId: "session-1",
            seq: 5,
            state: summary({ messageCount: 1 }),
            events: [{ seq: 5, event: { type: "agent_start" } }],
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
            reconnectDelayMs: 10,
            maxReconnectAttempts: 1,
        });
        store.getState().connect("session-1");
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
        const store = createSessionStore({ WebSocket: FakeSocket });
        store.getState().connect("session-1");
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
        const store = createSessionStore({ WebSocket: FakeSocket });
        store.getState().connect("session-1");
        const socket = lastSocket();
        socket.open();

        socket.receive({
            type: "extension_ui_request",
            sessionId: "session-1",
            request: {
                type: "extension_ui_request",
                id: "dialog",
                method: "confirm",
                title: "Continue?",
                message: "Confirm",
            },
        });
        expect(store.getState().pendingUiRequests.map((request) => request.id)).toEqual(["dialog"]);

        socket.receive({ type: "extension_ui_resolved", sessionId: "session-1", requestId: "dialog" });
        expect(store.getState().pendingUiRequests).toEqual([]);
    });

    it("rejects a UI response when no socket is open", async () => {
        const store = createSessionStore({ WebSocket: FakeSocket });

        await expect(
            store.getState().sendUiResponse({
                type: "extension_ui_response",
                id: "dialog-1",
                cancelled: true,
            }),
        ).rejects.toMatchObject({ classification: "client" });
    });
});
