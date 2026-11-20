import { SESSION_CLOSE_CODE, type WsServerMessage } from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildSessionSocketUrl,
    SessionCommandError,
    SessionSocket,
    SessionSocketClosedError,
    type SessionSocketLike,
} from "./session-socket";

class FakeSocket implements SessionSocketLike {
    static instances: FakeSocket[] = [];

    readonly url: string;
    readonly sent: string[] = [];
    readonly closeCalls: { code?: number; reason?: string }[] = [];
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

    close(code?: number, reason?: string): void {
        this.closeCalls.push({
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
        });
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

function openSocket(options: Partial<ConstructorParameters<typeof SessionSocket>[0]> = {}): {
    socket: SessionSocket;
    instance: FakeSocket;
} {
    const socket = new SessionSocket({
        sessionId: "session-1",
        url: "ws://example.test/ws/sessions/session-1",
        WebSocket: FakeSocket,
        ...options,
    });
    socket.connect();
    const instance = FakeSocket.instances.at(-1);
    if (instance === undefined) {
        throw new Error("The socket did not connect");
    }
    return { socket, instance };
}

function parseSent(instance: FakeSocket, index: number): Record<string, unknown> {
    const sent = instance.sent[index];
    if (sent === undefined) {
        throw new Error(`No message was sent at index ${String(index)}`);
    }
    return JSON.parse(sent) as Record<string, unknown>;
}

beforeEach(() => {
    FakeSocket.instances = [];
});

describe("buildSessionSocketUrl", () => {
    it("maps the page origin to ws or wss", () => {
        expect(buildSessionSocketUrl("s1", undefined, "https://example.test/workspace")).toBe(
            "wss://example.test/ws/sessions/s1",
        );
        expect(buildSessionSocketUrl("s1", undefined, "http://example.test/workspace")).toBe(
            "ws://example.test/ws/sessions/s1",
        );
    });

    it("encodes the session id and appends afterSeq", () => {
        expect(buildSessionSocketUrl("a/b ?c", 12, "http://127.0.0.1:3141/workspace?x=1#top")).toBe(
            "ws://127.0.0.1:3141/ws/sessions/a%2Fb%20%3Fc?afterSeq=12",
        );
    });
});

describe("SessionSocket", () => {
    it("connects to an injected URL and reports open", () => {
        const onOpen = vi.fn();
        const { instance } = openSocket({ url: "ws://example.test/custom", onOpen });

        expect(instance.url).toBe("ws://example.test/custom");
        expect(onOpen).not.toHaveBeenCalled();

        instance.open();

        expect(onOpen).toHaveBeenCalledOnce();
    });

    it("adds a command id and resolves the matching successful response", async () => {
        const { socket, instance } = openSocket();
        instance.open();

        const response = socket.sendCommand({ type: "abort" });
        const sent = parseSent(instance, 0);

        expect(sent["type"]).toBe("abort");
        expect(typeof sent["id"]).toBe("string");

        instance.receive({
            type: "response",
            id: String(sent["id"]),
            command: "abort",
            success: true,
        });

        await expect(response).resolves.toMatchObject({ command: "abort", success: true });
    });

    it("reuses a caller-provided id and rejects a failed response", async () => {
        const { socket, instance } = openSocket();
        instance.open();

        const response = socket.sendCommand({ type: "clear_queue", id: "my-command" });
        expect(parseSent(instance, 0)["id"]).toBe("my-command");

        instance.receive({
            type: "response",
            id: "my-command",
            command: "clear_queue",
            success: false,
            error: "The queue is locked.",
        });

        await expect(response).rejects.toBeInstanceOf(SessionCommandError);
        await expect(response).rejects.toMatchObject({
            command: "clear_queue",
            message: "The queue is locked.",
        });
    });

    it("rejects a command when a protocol error carries its id", async () => {
        const { socket, instance } = openSocket();
        instance.open();

        const response = socket.sendCommand({ type: "prompt", message: "hello", id: "prompt-1" });
        instance.receive({ type: "error", id: "prompt-1", code: "invalid_request", message: "Invalid command." });

        await expect(response).rejects.toMatchObject({
            command: "prompt",
            code: "invalid_request",
            message: "Invalid command.",
        });
    });

    it("sends an extension UI response out of band without waiting for a command", () => {
        const { socket, instance } = openSocket();
        instance.open();

        socket.sendUiResponse({ type: "extension_ui_response", id: "dialog-1", confirmed: true });

        expect(parseSent(instance, 0)).toEqual({
            type: "extension_ui_response",
            id: "dialog-1",
            confirmed: true,
        });
        expect(instance.sent).toHaveLength(1);
    });

    it("queues commands before open and flushes them in order", async () => {
        const { socket, instance } = openSocket();

        const first = socket.sendCommand({ type: "abort", id: "first" });
        const second = socket.sendCommand({ type: "clear_queue", id: "second" });
        expect(instance.sent).toHaveLength(0);

        instance.open();

        expect(instance.sent).toHaveLength(2);
        expect(parseSent(instance, 0)["id"]).toBe("first");
        expect(parseSent(instance, 1)["id"]).toBe("second");

        instance.receive({ type: "response", id: "first", command: "abort", success: true });
        instance.receive({ type: "response", id: "second", command: "clear_queue", success: true });

        await expect(first).resolves.toMatchObject({ command: "abort" });
        await expect(second).resolves.toMatchObject({ command: "clear_queue" });
    });

    it("rejects pending commands and notifies once on an explicit close", async () => {
        const onClose = vi.fn();
        const { socket, instance } = openSocket({ onClose });
        instance.open();

        const pending = socket.sendCommand({ type: "abort" });
        socket.close();

        await expect(pending).rejects.toBeInstanceOf(SessionSocketClosedError);
        await expect(pending).rejects.toMatchObject({ classification: "client" });
        expect(onClose).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledWith({
            code: 1000,
            reason: "Client closed",
            classification: "client",
            wasClean: true,
        });
        expect(instance.closeCalls).toEqual([{ code: 1000, reason: "Client closed" }]);

        instance.serverClose(SESSION_CLOSE_CODE.goingAway, "Server going away");
        expect(onClose).toHaveBeenCalledOnce();
    });

    it.each([
        [SESSION_CLOSE_CODE.goingAway, "disconnected"],
        [SESSION_CLOSE_CODE.sessionClosed, "session"],
        [SESSION_CLOSE_CODE.sessionNotFound, "session"],
        [SESSION_CLOSE_CODE.slowConsumer, "slow-consumer"],
        [1006, "disconnected"],
    ] as const)("classifies server close code %i as %s", (code, classification) => {
        const onClose = vi.fn();
        const { instance } = openSocket({ onClose });
        instance.open();

        instance.serverClose(code, "closed");

        expect(onClose).toHaveBeenCalledWith({
            code,
            reason: "closed",
            classification,
            wasClean: false,
        });
    });

    it("delivers non-response messages to the message callback", () => {
        const onMessage = vi.fn<(message: WsServerMessage) => void>();
        const { instance } = openSocket({ onMessage });
        instance.open();

        const messages: WsServerMessage[] = [
            {
                type: "snapshot",
                sessionId: "session-1",
                seq: 0,
                state: {
                    sessionId: "session-1",
                    cwd: "/tmp",
                    name: null,
                    model: null,
                    thinkingLevel: "off",
                    isStreaming: false,
                    isCompacting: false,
                    steeringMode: "one-at-a-time",
                    followUpMode: "one-at-a-time",
                    autoCompactionEnabled: false,
                    messageCount: 0,
                    pendingMessageCount: 0,
                    steeringMessages: [],
                    followUpMessages: [],
                },
                entries: [],
                pendingUiRequests: [],
            },
            {
                type: "replay",
                sessionId: "session-1",
                seq: 0,
                state: {
                    sessionId: "session-1",
                    cwd: "/tmp",
                    name: null,
                    model: null,
                    thinkingLevel: "off",
                    isStreaming: false,
                    isCompacting: false,
                    steeringMode: "one-at-a-time",
                    followUpMode: "one-at-a-time",
                    autoCompactionEnabled: false,
                    messageCount: 0,
                    pendingMessageCount: 0,
                    steeringMessages: [],
                    followUpMessages: [],
                },
                events: [],
                pendingUiRequests: [],
            },
            { type: "event", sessionId: "session-1", seq: 1, event: { type: "agent_start" } },
            {
                type: "extension_ui_request",
                sessionId: "session-1",
                request: {
                    type: "extension_ui_request",
                    id: "dialog",
                    method: "confirm",
                    title: "Continue?",
                    message: "Confirm",
                },
            },
            { type: "extension_ui_resolved", sessionId: "session-1", requestId: "dialog" },
            {
                type: "extension_error",
                sessionId: "session-1",
                extensionPath: "/ext.js",
                event: "tool_call",
                error: "boom",
            },
            { type: "error", code: "invalid_json", message: "Failed to parse command JSON." },
        ];

        for (const message of messages) {
            instance.receive(message);
        }

        expect(onMessage).toHaveBeenCalledTimes(messages.length);
        expect(onMessage.mock.calls.map(([message]) => message.type)).toEqual(messages.map((message) => message.type));
    });

    it("ignores malformed JSON and responses without a pending command", () => {
        const onMessage = vi.fn<(message: WsServerMessage) => void>();
        const { instance } = openSocket({ onMessage });
        instance.open();

        instance.onmessage?.({ data: "not json" } as MessageEvent);
        instance.receive({ type: "response", command: "abort", success: true });
        instance.receive({ type: "error", code: "unknown", message: "No id." });

        expect(onMessage).toHaveBeenCalledOnce();
        expect(onMessage).toHaveBeenCalledWith({ type: "error", code: "unknown", message: "No id." });
    });

    it("rejects new commands after a server close", async () => {
        const { socket, instance } = openSocket();
        instance.open();
        instance.serverClose(SESSION_CLOSE_CODE.sessionClosed, "Session closed");

        await expect(socket.sendCommand({ type: "abort" })).rejects.toMatchObject({
            classification: "session",
        });
        expect(() => {
            socket.sendUiResponse({ type: "extension_ui_response", id: "dialog", cancelled: true });
        }).toThrow(SessionSocketClosedError);
    });
});
