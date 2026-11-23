import {
    parseSessionId,
    parseSyncEpoch,
    parseSyncSeq,
    type SessionId,
    type SyncEpoch,
    type SyncSeq,
    type WorkspaceWsServerMessage,
} from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionSocketLike } from "./session-socket";
import { buildWorkspaceSocketUrl, connectWorkspaceSocket } from "./workspace-socket";

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

class FakeWorkspaceSocket implements SessionSocketLike {
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

    triggerMessage(data: unknown): void {
        this.onmessage?.({ data } as MessageEvent);
    }

    triggerClose(code = 1006, reason = "", wasClean = false): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean } as CloseEvent);
    }
}

describe("workspace-socket", () => {
    beforeEach(() => {
        FakeWorkspaceSocket.instances = [];
    });

    it("builds ws and wss URLs from page URL and optional cursor", () => {
        expect(buildWorkspaceSocketUrl("http://127.0.0.1:3141/workspace/abc")).toBe("ws://127.0.0.1:3141/ws/workspace");
        expect(buildWorkspaceSocketUrl("https://pivia.example.com/workspace?x=1#top")).toBe(
            "wss://pivia.example.com/ws/workspace",
        );
        expect(
            buildWorkspaceSocketUrl("https://pivia.example.com/workspace", {
                epoch: epoch("epoch-1"),
                seq: seq(7),
            }),
        ).toBe("wss://pivia.example.com/ws/workspace?epoch=epoch-1&afterSeq=7");
    });

    it("decodes valid workspace messages and reports protocol errors for malformed frames", () => {
        const received: WorkspaceWsServerMessage[] = [];
        const protocolErrors: string[] = [];
        const onOpen = vi.fn();
        const onClose = vi.fn();

        const handle = connectWorkspaceSocket({
            url: "ws://localhost/ws/workspace",
            WebSocket: FakeWorkspaceSocket,
            handlers: {
                onOpen,
                onMessage: (message) => {
                    received.push(message);
                },
                onClose,
                onProtocolError: (reason) => {
                    protocolErrors.push(reason);
                },
            },
        });

        const socket = FakeWorkspaceSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected socket instance");
        }
        expect(socket.url).toBe("ws://localhost/ws/workspace");

        socket.triggerOpen();
        expect(onOpen).toHaveBeenCalledTimes(1);

        const summary = {
            id: sid("session-1"),
            cwd: "/workspace/repo",
            name: "One",
            firstMessage: "hi",
            messageCount: 1,
            createdAtMs: 1000,
            modifiedAtMs: 2000,
            hasParent: false,
            runtimeState: "idle" as const,
            attachedClients: 0,
        };

        const catalogEpoch = epoch("epoch-1");
        socket.triggerMessage(
            JSON.stringify({
                type: "sync:snapshot",
                cursor: { epoch: catalogEpoch, seq: 0 },
                snapshot: {
                    sessions: [summary],
                    updatedAtMs: 3000,
                },
            }),
        );
        socket.triggerMessage(
            JSON.stringify({
                type: "sync:delta",
                cursor: { epoch: catalogEpoch, seq: 1 },
                delta: { op: "upsert", item: summary },
            }),
        );
        socket.triggerMessage(
            JSON.stringify({
                type: "sync:delta",
                cursor: { epoch: catalogEpoch, seq: 2 },
                delta: { op: "patch", id: summary.id, patch: { runtimeState: "streaming" } },
            }),
        );
        socket.triggerMessage(
            JSON.stringify({
                type: "sync:delta",
                cursor: { epoch: catalogEpoch, seq: 3 },
                delta: { op: "remove", id: summary.id },
            }),
        );
        socket.triggerMessage(
            JSON.stringify({
                type: "sync:replay",
                cursor: { epoch: catalogEpoch, seq: 4 },
                fromSeq: 3,
                deltas: [{ seq: 4, payload: { op: "remove", id: summary.id } }],
            }),
        );
        socket.triggerMessage(JSON.stringify({ type: "sync:resync", reason: "gap" }));

        expect(received).toEqual([
            {
                type: "sync:snapshot",
                cursor: { epoch: catalogEpoch, seq: seq(0) },
                snapshot: { sessions: [summary], updatedAtMs: 3000 },
            },
            {
                type: "sync:delta",
                cursor: { epoch: catalogEpoch, seq: seq(1) },
                delta: { op: "upsert", item: summary },
            },
            {
                type: "sync:delta",
                cursor: { epoch: catalogEpoch, seq: seq(2) },
                delta: { op: "patch", id: summary.id, patch: { runtimeState: "streaming" } },
            },
            {
                type: "sync:delta",
                cursor: { epoch: catalogEpoch, seq: seq(3) },
                delta: { op: "remove", id: summary.id },
            },
            {
                type: "sync:replay",
                cursor: { epoch: catalogEpoch, seq: seq(4) },
                fromSeq: seq(3),
                deltas: [{ seq: seq(4), payload: { op: "remove", id: summary.id } }],
            },
            { type: "sync:resync", reason: "gap" },
        ]);

        socket.triggerMessage(new ArrayBuffer(4));
        socket.triggerMessage("{bad json");
        socket.triggerMessage(JSON.stringify({ type: "session_removed", sessionId: "../invalid" }));

        expect(received).toHaveLength(6);
        expect(protocolErrors).toHaveLength(3);

        socket.triggerClose(1006, "Lost", false);
        expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: "Lost", wasClean: false });

        // Closing after remote close is a no-op.
        handle.close(1000, "Done");
        expect(socket.closeCalls).toEqual([]);
    });

    it("closes cleanly without invoking onClose after explicit client close", () => {
        const onClose = vi.fn();
        const handle = connectWorkspaceSocket({
            url: "ws://localhost/ws/workspace",
            WebSocket: FakeWorkspaceSocket,
            handlers: {
                onMessage: () => {},
                onClose,
            },
        });

        const socket = FakeWorkspaceSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected socket instance");
        }

        handle.close(1000, "Workspace closed");
        handle.close(1000, "Workspace closed");
        socket.triggerClose(1000, "Workspace closed", true);

        expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Workspace closed" }]);
        expect(onClose).not.toHaveBeenCalled();
    });
});
