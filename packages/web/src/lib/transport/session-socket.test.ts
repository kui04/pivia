import {
    SESSION_CLOSE_CODE,
    type SessionRpcServerMessage,
    type SessionSyncFrame,
    type SessionWsServerMessage,
} from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_1 = sid("session-1");
const RUNTIME_1 = sessionEpoch("runtime-1");
const V152 = ev("3:1.5.2");

import { FakeWebSocket } from "@/test/fake-socket";
import { ev, sessionEpoch, sessionSeq, sid } from "@/test/ids";

import { buildSessionSocketUrl, SessionCommandError, SessionSocket, SessionSocketClosedError } from "./session-socket";

function openSocket(options: Partial<ConstructorParameters<typeof SessionSocket>[0]> = {}): {
    socket: SessionSocket;
    instance: FakeWebSocket;
} {
    const socket = new SessionSocket({
        sessionId: SESSION_1,
        url: "ws://example.test/ws/sessions/session-1",
        WebSocket: FakeWebSocket,
        ...options,
    });
    socket.connect();
    const instance = FakeWebSocket.instances.at(-1);
    if (instance === undefined) {
        throw new Error("The socket did not connect");
    }
    return { socket, instance };
}

function parseSent(instance: FakeWebSocket, index: number): Record<string, unknown> {
    const sent = instance.sent[index];
    if (sent === undefined) {
        throw new Error(`No message was sent at index ${String(index)}`);
    }
    return JSON.parse(sent) as Record<string, unknown>;
}

beforeEach(() => {
    FakeWebSocket.reset();
});

describe("buildSessionSocketUrl", () => {
    it("maps the page origin to ws or wss", () => {
        expect(buildSessionSocketUrl(sid("s1"), undefined, "https://example.test/workspace")).toBe(
            "wss://example.test/ws/sessions/s1",
        );
        expect(buildSessionSocketUrl(sid("s1"), undefined, "http://example.test/workspace")).toBe(
            "ws://example.test/ws/sessions/s1",
        );
    });

    it("encodes the session id and appends cursor and hint", () => {
        expect(
            buildSessionSocketUrl(
                sid("session.1_a-b"),
                {
                    cursor: { epoch: sessionEpoch("runtime-1"), seq: sessionSeq(12) },
                    hint: { entriesVersion: V152, afterCount: 3, afterEntryId: "e3" },
                },
                "http://127.0.0.1:3141/workspace?x=1#top",
            ),
        ).toBe(
            "ws://127.0.0.1:3141/ws/sessions/session.1_a-b?epoch=runtime-1&afterSeq=12&entriesVersion=3%3A1.5.2&afterCount=3&afterEntryId=e3",
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

    it("adds a command id, wraps rpc:command, and resolves the matching successful response", async () => {
        const { socket, instance } = openSocket();
        instance.open();

        const response = socket.sendCommand({ type: "abort" });
        const envelope = parseSent(instance, 0);
        const sentCommand = envelope["command"] as Record<string, unknown>;

        expect(envelope["type"]).toBe("rpc:command");
        expect(sentCommand["type"]).toBe("abort");
        expect(typeof sentCommand["id"]).toBe("string");

        instance.receive({
            type: "rpc:response",
            id: String(sentCommand["id"]),
            command: "abort",
            success: true,
        });

        await expect(response).resolves.toMatchObject({ type: "rpc:response", command: "abort", success: true });
    });

    it("reuses a caller-provided id and rejects a failed response", async () => {
        const { socket, instance } = openSocket();
        instance.open();

        const response = socket.sendCommand({ type: "clear_queue", id: "my-command" });
        const envelope = parseSent(instance, 0);
        const sentCommand = envelope["command"] as Record<string, unknown>;
        expect(sentCommand["id"]).toBe("my-command");

        instance.receive({
            type: "rpc:response",
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
        instance.receive({ type: "rpc:error", id: "prompt-1", code: "invalid_request", message: "Invalid command." });

        await expect(response).rejects.toMatchObject({
            command: "prompt",
            code: "invalid_request",
            message: "Invalid command.",
        });
    });

    it("sends an extension UI response wrapped in rpc:ui_response out of band", () => {
        const { socket, instance } = openSocket();
        instance.open();

        socket.sendUiResponse({ type: "extension_ui_response", id: "dialog-1", confirmed: true });

        expect(parseSent(instance, 0)).toEqual({
            type: "rpc:ui_response",
            response: {
                type: "extension_ui_response",
                id: "dialog-1",
                confirmed: true,
            },
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
        expect((parseSent(instance, 0)["command"] as Record<string, unknown>)["id"]).toBe("first");
        expect((parseSent(instance, 1)["command"] as Record<string, unknown>)["id"]).toBe("second");

        instance.receive({ type: "rpc:response", id: "first", command: "abort", success: true });
        instance.receive({ type: "rpc:response", id: "second", command: "clear_queue", success: true });

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

    it("delivers sync frames and unmatched rpc errors to callbacks", () => {
        const onSyncFrame = vi.fn<(frame: SessionSyncFrame) => void>();
        const onRpcError = vi.fn<(error: Extract<SessionRpcServerMessage, { type: "rpc:error" }>) => void>();
        const { instance } = openSocket({ onSyncFrame, onRpcError });
        instance.open();

        const state = {
            sessionId: SESSION_1,
            cwd: "/tmp",
            name: null,
            model: null,
            thinkingLevel: "off" as const,
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time" as const,
            followUpMode: "one-at-a-time" as const,
            autoCompactionEnabled: false,
            messageCount: 0,
            steeringMessages: [],
            followUpMessages: [],
        };

        const messages: SessionWsServerMessage[] = [
            {
                type: "sync:snapshot",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(0) },
                snapshot: {
                    entriesVersion: V152,
                    baseEntryCount: 0,
                    entries: { mode: "inline", data: [] },
                    state,
                    liveMessage: null,
                    pendingUiRequests: [],
                },
            },
            {
                type: "sync:replay",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(0) },
                fromSeq: sessionSeq(0),
                deltas: [],
            },
            {
                type: "sync:delta",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(1) },
                delta: { kind: "agent_event", event: { type: "agent_start" } },
            },
            {
                type: "sync:delta",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(2) },
                delta: {
                    kind: "ui_request",
                    request: {
                        type: "extension_ui_request",
                        id: "dialog",
                        method: "confirm",
                        title: "Continue?",
                        message: "Confirm",
                    },
                },
            },
            {
                type: "sync:delta",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(3) },
                delta: { kind: "ui_resolved", requestId: "dialog" },
            },
            {
                type: "sync:delta",
                cursor: { epoch: RUNTIME_1, seq: sessionSeq(4) },
                delta: {
                    kind: "extension_error",
                    extensionPath: "/ext.js",
                    event: "tool_call",
                    error: "boom",
                },
            },
            { type: "sync:resync", reason: "gap" },
            { type: "rpc:error", code: "invalid_json", message: "Failed to parse command JSON." },
        ];

        for (const message of messages) {
            instance.receive(message);
        }

        expect(onSyncFrame).toHaveBeenCalledTimes(messages.length - 1);
        expect(onRpcError).toHaveBeenCalledOnce();
        expect(onRpcError).toHaveBeenCalledWith({
            type: "rpc:error",
            code: "invalid_json",
            message: "Failed to parse command JSON.",
        });
    });

    it("ignores malformed JSON and responses without a pending command", () => {
        const onRpcError = vi.fn<(error: Extract<SessionRpcServerMessage, { type: "rpc:error" }>) => void>();
        const { instance } = openSocket({ onRpcError });
        instance.open();

        instance.onmessage?.({ data: "not json" } as MessageEvent);
        instance.onmessage?.({ data: JSON.stringify({ type: "unknown_message" }) } as MessageEvent);
        instance.onmessage?.({
            data: JSON.stringify({
                type: "sync:delta",
                cursor: { epoch: "rt", seq: 0 },
                delta: { kind: "ui_resolved", requestId: "x" },
            }),
        } as MessageEvent);
        instance.receive({ type: "rpc:response", command: "abort", success: true });
        instance.receive({ type: "rpc:error", code: "unknown", message: "No id." });

        expect(onRpcError).toHaveBeenCalledOnce();
        expect(onRpcError).toHaveBeenCalledWith({ type: "rpc:error", code: "unknown", message: "No id." });
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
